import { Injectable, Inject } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type Redis from "ioredis";
import { bad, biz, conflict, forbidden, notFound } from "../common/errors";
import { nowIso } from "../common/reply";
import { haversineKm, resolveRegion } from "../common/geo";
import { withLock } from "../common/lock";
import { REDIS } from "../redis/redis.module";
import { RuleConfigService } from "../rules/rule-config.service";
import { RuleEngineService } from "../rules/rule-engine.service";

@Injectable()
export class DemandsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
    private readonly engine: RuleEngineService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}


  /**
   * 加急费：家长可以自己填（加价买优先推送），但必须有护栏。
   * - 规则 urgent.fee = 平台标准/最低价，不填就按它（保持「点开关即 ¥20」的老行为）
   * - 规则 urgent.max_fee = 上限（缺省回落到 10 倍标准价），防手滑输成 9999 元
   * - 非加急一律 0，不接受「不开加急却带金额」
   */
  private urgentFeeOf(cfg: any, urgent: boolean, input: any): number {
    if (!urgent) return 0;
    const base = Math.max(0, Math.round(Number(cfg?.fee) || 0));
    const capCfg = Math.round(Number(cfg?.max_fee) || 0);
    const cap = Math.max(base, capCfg > 0 ? capCfg : base * 10);
    if (input === undefined || input === null || input === "") return base;
    const n = Math.round(Number(input));
    if (!Number.isFinite(n) || n <= 0) throw bad("加急费金额不正确");
    if (n < base) throw bad(`加急费不能低于平台标准 ¥${(base / 100).toFixed(2)}`);
    if (n > cap) throw bad(`加急费最高 ¥${(cap / 100).toFixed(2)}`);
    return n;
  }

  /** 发布需求（需求 4.1.3）+ 自然注册归属片区（需求 5.5） */
  async create(parentId: number, b: any) {
    if (!b.stage) throw bad("请选择学段");
    if (!b.subject) throw bad("请选择科目");
    if (!b.address) throw bad("请填写上课地址");
    if (b.lat == null || b.lng == null) throw bad("地址需解析定位坐标");
    if (!(Number(b.budget) > 0)) throw bad("请填写预算金额");

    const pp: any = (await this.ds.query("SELECT * FROM `parent_profiles` WHERE `user_id` = ? LIMIT 1", [parentId]))[0];
    if (b.urgent && pp?.restricted) throw biz("RESTRICTED", "信用分过低，暂不可发布加急需求");

    const region = await resolveRegion(this.ds, Number(b.lat), Number(b.lng));
    if (!region) throw biz("OUT_OF_SERVICE", "该上课地址暂未开通服务片区");

    const bound = await this.ds.query("SELECT `id` FROM `bindings` WHERE `user_id` = ? LIMIT 1", [parentId]);
    if (!bound.length) {
      const ra = await this.ds.query(
        "SELECT `user_id` FROM `agent_profiles` WHERE `region_id` = ? AND `status` = 'active' ORDER BY `user_id` LIMIT 1",
        [region.id],
      );
      await this.ds.query(
        "INSERT IGNORE INTO `bindings` (`user_id`,`sales_id`,`agent_id`,`region_id`,`source`,`bound_at`) VALUES (?,?,?,?,?,?)",
        [parentId, null, ra[0]?.user_id ?? null, region.id, "natural", nowIso()],
      );
      await this.ds.query("UPDATE `users` SET `region_id` = ? WHERE `id` = ?", [region.id, parentId]);
    }

    const urgent = (await this.rules.get("urgent")) as any;
    const urgentFee = this.urgentFeeOf(urgent, !!b.urgent, b.urgentFee);
    const r = await this.ds.query(
      `INSERT INTO \`demands\` (\`parent_id\`,\`stage\`,\`subject\`,\`mode\`,\`address_id\`,\`address\`,\`lat\`,\`lng\`,\`region_id\`,\`times\`,\`budget\`,\`remark\`,\`gender_pref\`,\`urgent\`,\`urgent_fee\`,\`status\`,\`created_at\`,\`updated_at\`)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [parentId, b.stage, b.subject, "home", b.addressId ?? null, b.address, Number(b.lat), Number(b.lng), region.id,
        JSON.stringify(b.times || []), Math.round(Number(b.budget)), b.remark || "", b.genderPref || "",
        b.urgent ? 1 : 0, urgentFee, "published", nowIso(), nowIso()],
    );
    const d = (await this.ds.query("SELECT * FROM `demands` WHERE `id` = ?", [r.insertId]))[0];
    return { ...d, urgent_fee: Number(d.urgent_fee) };
  }

  async mine(parentId: number) {
    const rows = await this.ds.query(
      "SELECT d.*, (SELECT COUNT(*) FROM `applications` a WHERE a.demand_id = d.id AND a.status IN ('pending','confirmed')) AS applyCount FROM `demands` d WHERE d.parent_id = ? ORDER BY d.id DESC",
      [parentId],
    );
    return rows.map((d: any) => ({ ...d, times: d.times ? JSON.parse(d.times) : [] }));
  }

  /** 需求详情：家长本人 / 管理员 / 符合条件的教员（需求 2.1 数据范围） */
  async detail(viewer: { uid: number; role: string }, id: number) {
    const d: any = (await this.ds.query("SELECT * FROM `demands` WHERE `id` = ? LIMIT 1", [id]))[0];
    if (!d) throw notFound("需求不存在");
    const uid = Number(viewer.uid);
    let allowed = Number(d.parent_id) === uid || viewer.role === "admin";
    if (!allowed && viewer.role === "teacher") {
      const applied = await this.ds.query("SELECT `id` FROM `applications` WHERE `demand_id` = ? AND `teacher_id` = ?", [d.id, uid]);
      if (applied.length) allowed = true;
      else if (d.status === "published") {
        const tp: any = (await this.ds.query(
          "SELECT * FROM `teacher_profiles` WHERE `user_id` = ? AND `audit_status` = 'approved' LIMIT 1",
          [uid],
        ))[0];
        if (tp) {
          const dispatch = (await this.rules.get("dispatch")) as any;
          const dist = haversineKm(Number(tp.base_lat ?? 30.2741), Number(tp.base_lng ?? 120.1551), Number(d.lat), Number(d.lng));
          const inRange = dist <= (Number(tp.service_radius_km) || dispatch.max_radius_km);
          const subjectOk = !tp.subjects || String(tp.subjects).split(",").includes(d.subject);
          allowed = inRange && subjectOk;
        }
      }
    }
    if (!allowed) throw forbidden("无权查看该需求");

    const apps = await this.ds.query(
      "SELECT a.*, u.nickname, u.avatar FROM `applications` a JOIN `users` u ON u.id = a.teacher_id WHERE a.demand_id = ? ORDER BY a.status = 'confirmed' DESC, a.priority DESC",
      [d.id],
    );
    return { ...d, times: d.times ? JSON.parse(d.times) : [], applications: apps };
  }

  async update(parentId: number, id: number, b: any) {
    const d: any = (await this.ds.query("SELECT * FROM `demands` WHERE `id` = ? AND `parent_id` = ?", [id, parentId]))[0];
    if (!d) throw notFound("需求不存在");
    if (!["published", "paused"].includes(d.status)) throw biz("BAD_STATUS", "该需求已不可编辑");
    const urgent = (await this.rules.get("urgent")) as any;
    const nextUrgent = b.urgent != null ? !!b.urgent : !!d.urgent;
    let nextUrgentFee = Number(d.urgent_fee) || 0;
    if (!nextUrgent) nextUrgentFee = 0;
    else if (b.urgentFee != null) nextUrgentFee = this.urgentFeeOf(urgent, true, b.urgentFee);
    else if (!d.urgent) nextUrgentFee = this.urgentFeeOf(urgent, true, undefined);
    await this.ds.query(
      "UPDATE `demands` SET `stage`=?,`subject`=?,`address`=?,`lat`=?,`lng`=?,`times`=?,`budget`=?,`remark`=?,`urgent`=?,`urgent_fee`=?,`updated_at`=? WHERE `id` = ?",
      [b.stage ?? d.stage, b.subject ?? d.subject, b.address ?? d.address,
        b.lat != null ? Number(b.lat) : d.lat, b.lng != null ? Number(b.lng) : d.lng,
        JSON.stringify(b.times ?? (d.times ? JSON.parse(d.times) : [])),
        b.budget != null ? Math.round(Number(b.budget)) : d.budget,
        b.remark ?? d.remark,
        nextUrgent ? 1 : 0,
        nextUrgentFee,
        nowIso(), d.id],
    );
    return (await this.ds.query("SELECT * FROM `demands` WHERE `id` = ?", [d.id]))[0];
  }

  async action(parentId: number, id: number, action: string) {
    const d: any = (await this.ds.query("SELECT * FROM `demands` WHERE `id` = ? AND `parent_id` = ?", [id, parentId]))[0];
    if (!d) throw notFound("需求不存在");
    if (!["pause", "resume", "revoke"].includes(action)) throw bad("不支持的操作");
    if (action === "revoke") {
      if (d.status === "matched") throw biz("BAD_STATUS", "已确认教员的需求请走订单取消流程");
      await this.ds.query("UPDATE `demands` SET `status` = 'revoked', `updated_at` = ? WHERE `id` = ?", [nowIso(), d.id]);
      await this.ds.query("UPDATE `applications` SET `status` = 'cancelled' WHERE `demand_id` = ? AND `status` = 'pending'", [d.id]);
    } else {
      await this.ds.query("UPDATE `demands` SET `status` = ?, `updated_at` = ? WHERE `id` = ?", [action === "pause" ? "paused" : "published", nowIso(), d.id]);
    }
    return (await this.ds.query("SELECT * FROM `demands` WHERE `id` = ?", [d.id]))[0];
  }

  /** 教员抢单报名：唯一索引 + 条件插入保证不重复接单（需求 6.2） */
  async apply(teacherId: number, demandId: number) {
    const tp: any = (await this.ds.query("SELECT * FROM `teacher_profiles` WHERE `user_id` = ? LIMIT 1", [teacherId]))[0];
    if (!tp) throw notFound("请先完成入驻");
    if (tp.audit_status !== "approved") throw biz("NOT_APPROVED", "资质审核通过后才能接单");
    if (!tp.online) throw biz("OFFLINE", "请先切换到在线接单状态");
    const d: any = (await this.ds.query("SELECT * FROM `demands` WHERE `id` = ? LIMIT 1", [demandId]))[0];
    if (!d) throw notFound("需求不存在");
    if (d.status !== "published") throw biz("BAD_STATUS", "该需求已停止接单");

    const dispatch = (await this.rules.get("dispatch")) as any;
    const distance = Number(
      haversineKm(Number(tp.base_lat ?? 30.2741), Number(tp.base_lng ?? 120.1551), Number(d.lat), Number(d.lng)).toFixed(2),
    );
    if (distance > (Number(tp.service_radius_km) || dispatch.max_radius_km)) throw biz("TOO_FAR", "该需求距离超出您的服务半径");

    const levels = (await this.rules.get("teacher_levels")) as any[];
    const lv = levels.find((l) => l.level === tp.level) || levels[0];
    const priority = await this.engine.dispatchPriority({
      distanceKm: distance,
      levelWeight: lv.weight,
      responseFactor: Number(tp.response_factor),
      urgent: !!d.urgent,
    });
    // 6.2 分布式锁：同一需求的抢单临界区串行化（Redis SET NX PX），唯一索引双保险
    const { value, locked } = await withLock(this.redis, "jiajiao:lock:demand:" + d.id, async () => {
      const r = await this.ds.query(
        "INSERT IGNORE INTO `applications` (`demand_id`,`teacher_id`,`status`,`priority`,`distance_km`,`created_at`) VALUES (?,?,?,?,?,?)",
        [d.id, teacherId, "pending", priority, distance, nowIso()],
      );
      if (!r.affectedRows) throw biz("ALREADY_APPLIED", "您已报名该需求，请等待家长确认");
      return { applicationId: Number(r.insertId), priority, distanceKm: distance, status: "pending" };
    });
    return { ...value, lockAcquired: locked };
  }

  /** 教员端附近订单（按派单优先级降序，需求 4.2.2） */
  async nearbyForTeacher(teacherId: number) {
    const tp: any = (await this.ds.query("SELECT * FROM `teacher_profiles` WHERE `user_id` = ? LIMIT 1", [teacherId]))[0];
    if (!tp) throw notFound("请先完成入驻");
    if (tp.audit_status !== "approved") throw biz("NOT_APPROVED", "资质审核通过后才能接单");
    const dispatch = (await this.rules.get("dispatch")) as any;
    const levels = (await this.rules.get("teacher_levels")) as any[];
    const lv = levels.find((l) => l.level === tp.level) || levels[0];
    const lat = Number(tp.base_lat ?? 30.2741);
    const lng = Number(tp.base_lng ?? 120.1551);
    const rows = await this.ds.query("SELECT * FROM `demands` WHERE `status` = 'published'");
    // 一次性批量取该教员对这批需求的报名状态，避免循环内 N+1 查询
    const demandIds = rows.map((r: any) => Number(r.id));
    const appliedMap = new Map<number, string>();
    if (demandIds.length) {
      const apps = await this.ds.query(
        "SELECT `demand_id`,`status` FROM `applications` WHERE `teacher_id` = ? AND `demand_id` IN (" + demandIds.map(() => "?").join(",") + ")",
        [teacherId, ...demandIds],
      );
      for (const a of apps) appliedMap.set(Number(a.demand_id), String(a.status));
    }
    const list: any[] = [];
    for (const d of rows) {
      const distance = Number(haversineKm(lat, lng, Number(d.lat), Number(d.lng)).toFixed(2));
      if (distance > (Number(tp.service_radius_km) || dispatch.max_radius_km)) continue;
      if (tp.subjects && !String(tp.subjects).split(",").includes(d.subject)) continue;
      const appliedStatus = appliedMap.get(Number(d.id)) || null;
      // 只有家长已确认（confirmed）的报名才能看到完整门牌，其余仅街道级模糊地址
      const confirmed = appliedStatus === "confirmed";
      list.push({
        id: Number(d.id),
        stage: d.stage,
        subject: d.subject,
        // 隐私（需求第 2 章）：未报名/未确认前只下发街道级模糊地址与脱敏备注，
        // 完整门牌在家长确认接单生成订单后由订单详情提供
        address: confirmed ? d.address : (String(d.address || "").length > 8 ? String(d.address).slice(0, 8) + "***" : String(d.address || "")),
        lessonTimes: d.times ? JSON.parse(d.times) : [],
        budget: Number(d.budget),
        remark: confirmed ? d.remark : (d.remark ? "报名确认后可见" : ""),
        urgent: !!d.urgent,
        urgentFee: Number(d.urgent_fee),
        distanceKm: distance,
        priority: await this.engine.dispatchPriority({
          distanceKm: distance,
          levelWeight: lv.weight,
          responseFactor: Number(tp.response_factor),
          urgent: !!d.urgent,
        }),
        appliedStatus,
        createdAt: d.created_at,
      });
    }
    list.sort((a, b) => b.priority - a.priority);
    return { list, total: list.length, online: !!tp.online };
  }
}