// ============================================================
// Prometheus 抓取端点（P74）：GET /api/metrics
//
// 为什么不引 prom-client：本项目「零第三方依赖」是刻意选择（见 docs/DELIVERY.md），
// Prometheus 文本格式（text/plain; version=0.0.4）本身很简单，手写反而少一层升级负担。
//
// 暴露口径（全部来自库内真实统计，不做缓存，抓取频率通常 15–60s）：
//   jiajiao_up                     1/0        进程存活
//   jiajiao_db_up / cache_up       1/0        MySQL / Redis 可用性
//   jiajiao_uptime_seconds                    进程运行秒数
//   jiajiao_orders{status="..."}              各状态订单数
//   jiajiao_escrow_yuan_total                 担保台账余额（元，保留 2 位）
//   jiajiao_risk_events_open                  未关闭风控事件
//   jiajiao_complaints_open                   未结案投诉
//   jiajiao_refunds_pending                   待审退款订单
//   jiajiao_withdrawals_pending               待审提现
//   jiajiao_backup_last_success_timestamp     备份最近成功时间（读 LAST_STATUS，读不到则为 0）
//
// 访问控制：默认只允许本机（127.0.0.1/::1）抓取——生产上由宿主机 cron 或 Prometheus 直连 127.0.0.1:4300，
// 走 nginx 进来的外部请求 req.ip 是真实客户端地址，会被 403。若要跨机抓取，配 METRICS_TOKEN 后带
// `?token=xxx` 或 `Authorization: Bearer xxx`。
// ============================================================
import { Controller, Get, Query, Req, Inject, Header } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { readFileSync } from "node:fs";
import { Public } from "../public.decorator";
import { REDIS } from "../redis/redis.module";
import type Redis from "ioredis";
import { config } from "../config";
import { forbidden, unauthorized } from "../common/errors";
import { escrowBalance } from "../common/ledger";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

@Controller()
export class MetricsController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metrics(@Req() req: any, @Query("token") token?: string) {
    // 访问控制：本机直连 / 配了 METRICS_TOKEN 且令牌匹配
    const ip = String(req.ip || req.socket?.remoteAddress || "");
    const authed = config.metricsToken
      ? token === config.metricsToken ||
        String(req.headers?.authorization || "") === "Bearer " + config.metricsToken
      : false;
    if (!LOOPBACK.has(ip) && !authed) {
      if (config.metricsToken && !authed) throw unauthorized("metrics 需要令牌");
      throw forbidden("/api/metrics 只允许本机抓取（跨机请配置 METRICS_TOKEN）");
    }

    const lines: string[] = [];
    const push = (name: string, help: string, type: "counter" | "gauge", samples: string[]) => {
      lines.push("# HELP " + name + " " + help);
      lines.push("# TYPE " + name + " " + type);
      lines.push(...samples);
    };
    const num = async (sql: string, p: any[] = []) => {
      try {
        const r = await this.ds.query(sql, p);
        return Number((r && r[0] && (r[0].c ?? r[0].v ?? Object.values(r[0])[0])) || 0);
      } catch {
        return 0;
      }
    };

    let dbUp = 1;
    try {
      await this.ds.query("SELECT 1");
    } catch {
      dbUp = 0;
    }
    let cacheUp = 1;
    try {
      cacheUp = (await this.redis.ping()) === "PONG" ? 1 : 0;
    } catch {
      cacheUp = 0;
    }

    push("jiajiao_up", "进程存活", "gauge", ["jiajiao_up 1"]);
    push("jiajiao_uptime_seconds", "进程运行秒数", "gauge", [
      "jiajiao_uptime_seconds " + Math.round(process.uptime()),
    ]);
    push("jiajiao_db_up", "MySQL 可用性（1=可用）", "gauge", ["jiajiao_db_up " + dbUp]);
    push("jiajiao_cache_up", "Redis 可用性（1=可用）", "gauge", ["jiajiao_cache_up " + cacheUp]);

    if (dbUp) {
      const rows = await this.ds
        .query("SELECT `status`, COUNT(*) AS c FROM `orders` GROUP BY `status`")
        .catch(() => [] as any[]);
      push(
        "jiajiao_orders",
        "按状态分组的订单数",
        "gauge",
        rows.map((r: any) => 'jiajiao_orders{status="' + r.status + '"} ' + Number(r.c)),
      );
      const escrow = await escrowBalance(this.ds as any);
      // 担保台账口径：入账未出账 = 仍在托管中的钱（与 /admin/finance 的 summary.escrow 同源）
      push("jiajiao_escrow_yuan_total", "担保托管余额（元）", "gauge", [
        "jiajiao_escrow_yuan_total " + (Number(escrow) / 100).toFixed(2),
      ]);
      push("jiajiao_risk_events_open", "未关闭风控事件数", "gauge", [
        "jiajiao_risk_events_open " + (await num("SELECT COUNT(*) AS c FROM `risk_events` WHERE `status` <> 'closed'")),
      ]);
      push("jiajiao_complaints_open", "未结案投诉数", "gauge", [
        "jiajiao_complaints_open " + (await num("SELECT COUNT(*) AS c FROM `complaints` WHERE `status` <> 'closed'")),
      ]);
      push("jiajiao_refunds_pending", "待审退款订单数", "gauge", [
        "jiajiao_refunds_pending " + (await num("SELECT COUNT(*) AS c FROM `orders` WHERE `status` = 'refunding'")),
      ]);
      push("jiajiao_withdrawals_pending", "待审提现数", "gauge", [
        "jiajiao_withdrawals_pending " + (await num("SELECT COUNT(*) AS c FROM `withdrawals` WHERE `status` = 'pending'")),
      ]);
    }

    // 备份时间戳：读宿主机写的 LAST_STATUS（容器内挂载 /var/backups/jiajiao 时不配就是 0）
    let backupTs = 0;
    try {
      const raw = JSON.parse(readFileSync(process.env.BACKUP_STATUS_FILE || "/backup-status/LAST_STATUS", "utf8"));
      if (raw && raw.status === "ok" && raw.at) backupTs = Math.floor(new Date(raw.at).getTime() / 1000) || 0;
    } catch {
      backupTs = 0;
    }
    push("jiajiao_backup_last_success_timestamp", "最近一次备份成功时间（Unix 秒，0=未知）", "gauge", [
      "jiajiao_backup_last_success_timestamp " + backupTs,
    ]);

    return lines.join("\n") + "\n";
  }
}
