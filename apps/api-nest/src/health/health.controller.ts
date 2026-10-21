import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { Response } from "express";
import { REDIS } from "../redis/redis.module";
import type Redis from "ioredis";
import { Public } from "../public.decorator";
import { Roles } from "../common/access";
import { escrowBalance } from "../common/ledger";

@Controller("health")
export class HealthController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * 匿名探活：只暴露「可用性」，不暴露业务规模与资金数据。
   * 用户数 / 订单数 / 担保资金等指标见 GET /api/health/detail（仅管理员）。
   */
  @Public()
  @Get()
  async check(@Res() res: Response) {
    const started = Date.now();
    let mysqlOk = false;
    try {
      await this.ds.query("SELECT 1 AS ok");
      mysqlOk = true;
    } catch {
      // 不回显底层错误信息（可能包含主机名/库名），只落服务端日志
      console.error("[health] MySQL 探活失败");
      return res.status(503).json({ code: "UNHEALTHY", message: "MySQL 不可用", data: null });
    }
    let redisOk = false;
    try {
      redisOk = (await this.redis.ping()) === "PONG";
    } catch {
      redisOk = false;
    }
    const status = mysqlOk && redisOk ? 200 : 503;
    return res.status(status).json({
      code: 0,
      message: "ok",
      data: {
        status: mysqlOk && redisOk ? "ok" : "degraded",
        framework: "NestJS",
        version: "1.0.0",
        uptime: Math.round(process.uptime()),
        time: new Date().toISOString(),
        db: { engine: "MySQL 8", ok: mysqlOk, latencyMs: Date.now() - started },
        cache: { engine: "Redis", ok: redisOk },
      },
    });
  }

  /** 运维指标（仅管理员）：业务规模与担保资金总额 */
  @Get("detail")
  @Roles("admin")
  async detail(@Req() req: any) {
    const u = await this.ds.query("SELECT COUNT(*) AS c FROM `users`");
    const o = await this.ds.query("SELECT COUNT(*) AS c FROM `orders`");
    let redisOk = false;
    try {
      redisOk = (await this.redis.ping()) === "PONG";
    } catch {
      redisOk = false;
    }
    return {
      code: 0,
      message: "ok",
      data: {
        status: redisOk ? "ok" : "degraded",
        db: { ok: true, users: Number(u[0].c), orders: Number(o[0].c), escrow: await escrowBalance(this.ds) },
        cache: { ok: redisOk },
        requestedBy: req.user.uid,
      },
    };
  }
}
