// 定时任务：T+N 结算放款 / 抢单超时失效 / 上课前提醒（需求 4.1.5、5.1、5.4）
// 默认 5 分钟一轮（JOBS_INTERVAL_MS 可调），JOBS_ENABLED=0 可关闭
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { notify } from "../common/audit";
import { RuleConfigService } from "../rules/rule-config.service";
import { OrdersService } from "../order/orders.service";

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Jobs");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly orders: OrdersService,
    private readonly rules: RuleConfigService,
  ) {}

  onModuleInit() {
    if (process.env.JOBS_ENABLED === "0") {
      this.logger.log("定时任务已关闭（JOBS_ENABLED=0）");
      return;
    }
    const interval = Number(process.env.JOBS_INTERVAL_MS || 5 * 60 * 1000);
    this.timer = setInterval(() => void this.tick(), interval);
    // 不阻塞进程退出
    this.timer.unref?.();
    this.logger.log("定时任务已启动，间隔 " + interval + " ms");
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 一轮任务；任何一步失败都不影响其余步骤 */
  async tick() {
    if (this.running) return; // 上一轮未结束则跳过，避免重入
    this.running = true;
    try {
      await this.safely("settlement", async () => {
        const n = await this.orders.runSettlement();
        if (n) this.logger.log("结算放款 " + n + " 笔");
      });
      await this.safely("expireApplications", async () => {
        const n = await this.expireApplications();
        if (n) this.logger.log("超时报名失效 " + n + " 条");
      });
      await this.safely("lessonReminders", async () => {
        const n = await this.orders.runLessonReminders();
        if (n) this.logger.log("上课提醒已推送 " + n + " 单");
      });
    } finally {
      this.running = false;
    }
  }

  private async safely(name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err: any) {
      this.logger.error("[" + name + "] " + (err?.message || err));
    }
  }

  /** 抢单超时失效（5.1）：超过 grab_confirm_timeout_hours 未确认的报名自动失效 */
  async expireApplications() {
    const cfg = (await this.rules.get("dispatch")) as any;
    const hours = Number(cfg?.grab_confirm_timeout_hours ?? 24);
    const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
    const stale = await this.ds.query(
      `SELECT a.\`id\`, a.\`demand_id\`, a.\`teacher_id\`, d.\`parent_id\`, d.\`subject\`, d.\`stage\`
       FROM \`applications\` a JOIN \`demands\` d ON d.id = a.demand_id
       WHERE a.\`status\` = 'pending' AND a.\`created_at\` <= ?`,
      [cutoff],
    );
    let n = 0;
    for (const a of stale) {
      // 抢占式更新：并发/重复触发下只处理一次
      const r = await this.ds.query("UPDATE `applications` SET `status` = 'expired' WHERE `id` = ? AND `status` = 'pending'", [a.id]);
      if (!r.affectedRows) continue;
      n++;
      await notify(this.ds, Number(a.parent_id), "教员报名已超时失效",
        "需求「" + a.subject + " · " + a.stage + "」有 1 条教员报名超过 " + hours + " 小时未确认，已自动失效",
        "order", "/demand/" + a.demand_id);
      await notify(this.ds, Number(a.teacher_id), "报名已超时失效",
        "您对需求「" + a.subject + " · " + a.stage + "」的报名因家长超时未确认而失效", "order");
    }
    return n;
  }
}
