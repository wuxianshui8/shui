// 业务员推广端：推广码、业绩看板、客户管理、奖励明细（需求 4.x / 5.4）
import { Controller, Get, HttpCode, Post, Query, Req } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Roles } from "../common/access";
import { Public } from "../public.decorator";
import { ok, nowIso } from "../common/reply";
import { notFound } from "../common/errors";
import { maskPhone } from "../common/geo";
import { randomCode } from "../common/codes";
import { walletSnapshot } from "../common/ledger";
import { RuleConfigService } from "../rules/rule-config.service";

@Controller()
export class SalesController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
  ) {}

  private async salesOf(uid: number) {
    const s = (await this.ds.query("SELECT * FROM `sales_profiles` WHERE `user_id` = ? LIMIT 1", [uid]))[0];
    if (!s) throw notFound("业务员档案不存在");
    return s;
  }

  /** 推广码（家长 / 教员双通道），不存在则自动生成 */
  private async ensureCode(salesId: number, target: string) {
    let c = (await this.ds.query("SELECT * FROM `promotion_codes` WHERE `sales_id` = ? AND `target` = ? LIMIT 1", [salesId, target]))[0];
    if (!c) {
      const sp = await this.salesOf(salesId);
      await this.ds.query(
        "INSERT IGNORE INTO `promotion_codes` (`sales_id`,`target`,`token`,`scans`,`registrations`,`created_at`) VALUES (?,?,?,?,?,?)",
        [salesId, target, sp.code + target.slice(0, 1).toUpperCase() + randomCode(4), 0, 0, nowIso()],
      );
      c = (await this.ds.query("SELECT * FROM `promotion_codes` WHERE `sales_id` = ? AND `target` = ? LIMIT 1", [salesId, target]))[0];
    }
    return c;
  }

  private rangeStart(kind: string) {
    const d = new Date();
    if (kind === "today") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    if (kind === "week") {
      const day = (d.getDay() + 6) % 7;
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).toISOString();
    }
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  }

  /** 扫码（公开，无需登录） */
  @Public()
  @Post("public/promo/:token/scan")
  @HttpCode(200)
  async scan(@Req() req: any) {
    const token = req.params.token;
    const c = (await this.ds.query("SELECT * FROM `promotion_codes` WHERE `token` = ? LIMIT 1", [token]))[0];
    if (!c) throw notFound("推广码无效");
    await this.ds.query("UPDATE `promotion_codes` SET `scans` = `scans` + 1 WHERE `id` = ?", [c.id]);
    return ok({ salesId: Number(c.sales_id), target: c.target });
  }

  @Get("sales/dashboard")
  @Roles("sales")
  async dashboard(@Req() req: any) {
    const uid = Number(req.user.uid);
    const s = await this.salesOf(uid);
    const n = async (sql: string, p: any[]) => Number((await this.ds.query(sql, p))[0]?.c ?? 0);
    const sum = async (sql: string, p: any[]) => Number((await this.ds.query(sql, p))[0]?.s ?? 0);
    const statsOf = async (from: string) => {
      const registrations = await n("SELECT COUNT(*) AS c FROM `bindings` WHERE `sales_id` = ? AND `bound_at` >= ?", [uid, from]);
      const leads = Number((await this.ds.query(
        "SELECT COUNT(*) AS c FROM `bindings` b WHERE b.`sales_id` = ? AND b.`bound_at` >= ? AND EXISTS (SELECT 1 FROM `demands` d WHERE d.`parent_id` = b.`user_id`)",
        [uid, from],
      ))[0].c);
      const deals = (await this.ds.query(
        "SELECT COUNT(*) AS c, COALESCE(SUM(`amount`),0) AS gmv FROM `orders` WHERE `sales_id` = ? AND `paid_at` IS NOT NULL AND `paid_at` >= ?",
        [uid, from],
      ))[0];
      return { registrations, leads, deals: Number(deals.c), gmv: Number(deals.gmv) };
    };

    const settled = await sum("SELECT COALESCE(SUM(`amount`),0) AS s FROM `rewards` WHERE `sales_id` = ? AND `status` = 'settled'", [uid]);
    const pending = await sum("SELECT COALESCE(SUM(`amount`),0) AS s FROM `rewards` WHERE `sales_id` = ? AND `status` = 'pending'", [uid]);

    // 7 天趋势：两张表各一次 GROUP BY
    const since7 = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const gmvRows = await this.ds.query(
      "SELECT SUBSTR(`paid_at`,1,10) AS d, COALESCE(SUM(`amount`),0) AS s FROM `orders` WHERE `sales_id` = ? AND `paid_at` >= ? GROUP BY d",
      [uid, since7],
    );
    const regRows = await this.ds.query(
      "SELECT SUBSTR(`bound_at`,1,10) AS d, COUNT(*) AS c FROM `bindings` WHERE `sales_id` = ? AND `bound_at` >= ? GROUP BY d",
      [uid, since7],
    );
    const gmvMap = new Map<string, number>(gmvRows.map((r: any) => [r.d, Number(r.s)]));
    const regMap = new Map<string, number>(regRows.map((r: any) => [r.d, Number(r.c)]));
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      trend.push({ date: key, gmv: gmvMap.get(key) || 0, registrations: regMap.get(key) || 0 });
    }

    const me = (await this.ds.query("SELECT `nickname`,`phone` FROM `users` WHERE `id` = ?", [uid]))[0] || {};
    const agent = await this.ds.query(
      "SELECT ap.*, r.`name` AS regionName, u.`nickname` FROM `agent_profiles` ap LEFT JOIN `regions` r ON r.id = ap.region_id LEFT JOIN `users` u ON u.id = ap.user_id WHERE ap.`user_id` = ?",
      [s.agent_id],
    );
    return ok({
      sales: { ...s, userId: Number(s.user_id), phone: maskPhone(me.phone) },
      agent: agent.length ? { name: agent[0].nickname, regionName: agent[0].regionName } : null,
      today: await statsOf(this.rangeStart("today")),
      week: await statsOf(this.rangeStart("week")),
      month: await statsOf(this.rangeStart("month")),
      rewards: { pending, settled, wallet: await walletSnapshot(this.ds, uid) },
      trend,
      rewardRules: await this.rules.get("sales_rewards"),
      codes: [await this.ensureCode(uid, "parent"), await this.ensureCode(uid, "teacher")],
    });
  }

  @Get("sales/customers")
  @Roles("sales")
  async customers(@Req() req: any) {
    const uid = Number(req.user.uid);
    const rows = await this.ds.query(
      `SELECT b.*, u.\`nickname\`, u.\`avatar\`, u.\`role\`, u.\`phone\`, u.\`created_at\` AS regAt,
        (SELECT COUNT(*) FROM \`demands\` d WHERE d.\`parent_id\` = u.\`id\`) AS demandCount,
        (SELECT COUNT(*) FROM \`orders\` o WHERE o.\`parent_id\` = u.\`id\` AND o.\`paid_at\` IS NOT NULL) AS dealCount
       FROM \`bindings\` b JOIN \`users\` u ON u.id = b.user_id WHERE b.\`sales_id\` = ? ORDER BY b.\`id\` DESC`,
      [uid],
    );
    const list = rows.map((r: any) => {
      const dealCount = Number(r.dealCount);
      const demandCount = Number(r.demandCount);
      return {
        id: Number(r.user_id),
        nickname: r.nickname,
        avatar: r.avatar,
        role: r.role,
        phone: maskPhone(r.phone), // 禁止查看完整手机号
        source: r.source,
        boundAt: r.bound_at,
        status: dealCount > 0 ? "已成交" : demandCount > 0 ? "已发需求" : "已注册",
        demandCount,
        dealCount,
      };
    });
    return ok({
      list,
      summary: {
        total: list.length,
        registered: list.filter((x) => x.status === "已注册").length,
        demanded: list.filter((x) => x.status === "已发需求").length,
        dealt: list.filter((x) => x.status === "已成交").length,
      },
    });
  }

  @Get("sales/rewards")
  @Roles("sales")
  async rewards(@Query("type") type: string, @Req() req: any) {
    const uid = Number(req.user.uid);
    const list = type
      ? await this.ds.query(
          "SELECT r.*, o.`order_no` FROM `rewards` r LEFT JOIN `orders` o ON o.id = r.ref_order_id WHERE r.`sales_id` = ? AND r.`type` = ? ORDER BY r.`id` DESC LIMIT 200",
          [uid, type],
        )
      : await this.ds.query(
          "SELECT r.*, o.`order_no` FROM `rewards` r LEFT JOIN `orders` o ON o.id = r.ref_order_id WHERE r.`sales_id` = ? ORDER BY r.`id` DESC LIMIT 200",
          [uid],
        );
    return ok({
      list,
      byType: await this.ds.query(
        "SELECT `type`, COUNT(*) AS c, COALESCE(SUM(`amount`),0) AS total FROM `rewards` WHERE `sales_id` = ? GROUP BY `type`",
        [uid],
      ),
      types: [
        { value: "register", label: "注册奖" },
        { value: "lead", label: "留资奖" },
        { value: "deal", label: "成交提成" },
        { value: "daily_champ", label: "日冠军奖" },
        { value: "weekly_champ", label: "周冠军奖" },
        { value: "newbie_first", label: "新人首单奖" },
      ],
      rules: await this.rules.get("sales_rewards"),
      wallet: await walletSnapshot(this.ds, uid),
    });
  }

  @Get("sales/profile")
  @Roles("sales")
  async profile(@Req() req: any) {
    const uid = Number(req.user.uid);
    const s = await this.salesOf(uid);
    const me = (await this.ds.query("SELECT `nickname`,`phone` FROM `users` WHERE `id` = ?", [uid]))[0] || {};
    const region = (await this.ds.query("SELECT * FROM `regions` WHERE `id` = ?", [s.region_id]))[0];
    return ok({
      sales: { ...s, phone: maskPhone(me.phone), name: me.nickname },
      region: region ? { id: Number(region.id), name: region.name } : null,
      codes: [await this.ensureCode(uid, "parent"), await this.ensureCode(uid, "teacher")],
      wallet: await walletSnapshot(this.ds, uid),
    });
  }
}
