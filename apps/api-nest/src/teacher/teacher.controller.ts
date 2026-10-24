import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Roles } from "../common/access";
import { ok, nowIso } from "../common/reply";
import { bad, biz, notFound } from "../common/errors";
import { audit } from "../common/audit";
import { walletSnapshot } from "../common/ledger";
import { resolveRegion } from "../common/geo";
import { RuleConfigService } from "../rules/rule-config.service";
import { OrdersService } from "../order/orders.service";
import { UploadsService } from "../upload/uploads.service";
import { checkIdCardMatch, maskIdCard } from "../integrations/ocr/ocr.port";
import { recognizeIdCardFront } from "../integrations/ocr/ocr.service";
/** 教员端：入驻、接单大盘、服务管理、订单、等级权益、收入、排课、评价、个人中心 */
@Controller("teacher")
@Roles("teacher")
export class TeacherController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
    private readonly orders: OrdersService,
    private readonly uploads: UploadsService,
  ) {}

  private async rawProfile(uid: number) {
    return (await this.ds.query("SELECT * FROM `teacher_profiles` WHERE `user_id` = ? LIMIT 1", [uid]))[0] || null;
  }

  private async requireProfile(uid: number) {
    const tp = await this.rawProfile(uid);
    if (!tp) throw biz("NOT_APPLIED", "请先提交入驻资料");
    return tp;
  }

  /** 私有档案视图（含证件与排课，仅本人可见） */
  private async privateView(uid: number) {
    const tp = await this.rawProfile(uid);
    if (!tp) return null;
    const u = (await this.ds.query("SELECT `id`,`nickname`,`avatar`,`phone` FROM `users` WHERE `id` = ?", [uid]))[0] || {};
    const levels = (await this.rules.get("teacher_levels")) as any[];
    const lv = levels.find((l) => l.level === tp.level) || levels[0];
    return {
      id: Number(uid),
      nickname: u.nickname,
      avatar: u.avatar,
      phone: u.phone,
      realName: tp.real_name,
      idCard: tp.id_card ? String(tp.id_card).replace(/^(.{4}).*(.{4})$/, "$1**********$2") : null,
      identityType: tp.identity_type,
      intro: tp.intro,
      subjects: (tp.subjects || "").split(",").filter(Boolean),
      stages: (tp.stages || "").split(",").filter(Boolean),
      price: Number(tp.hourly_price),
      serviceRadiusKm: Number(tp.service_radius_km),
      baseLat: Number(tp.base_lat),
      baseLng: Number(tp.base_lng),
      coverArea: tp.cover_area,
      // 授课地址（P65）：非空表示支持「家长到教员处上课」
      baseAddress: String(tp.base_address || "").trim() || null,
      schedule: tp.schedule ? JSON.parse(tp.schedule) : [],
      eduCertUrl: tp.edu_cert_url,
      teacherCertUrl: tp.teacher_cert_url,
      skillCertUrl: tp.skill_cert_url,
      idCardFrontUrl: tp.id_card_front_url || null,
      idCardBackUrl: tp.id_card_back_url || null,
      // 识别出的证件姓名与校验标记：审核员据此判断「人证一致」是否已由系统核过
      idCardName: tp.id_card_name || null,
      idCardVerified: Number(tp.id_card_verified || 0) === 1,
      level: tp.level,
      levelName: lv?.name,
      growthScore: Number(tp.growth_score),
      commission: lv?.commission,
      levelWeight: lv?.weight,
      ratingAvg: Number(Number(tp.rating_avg).toFixed(2)),
      ratingCount: Number(tp.rating_count),
      completedLessons: Number(tp.completed_lessons),
      online: !!tp.online,
      auditStatus: tp.audit_status,
      rejectReason: tp.reject_reason,
      responseFactor: Number(tp.response_factor),
      createdAt: tp.created_at,
    };
  }

  /* ---------------- 入驻 ---------------- */
  @Post("apply")
  @HttpCode(200)
  @Roles("parent", "teacher") // 家长也可提交入驻申请；角色在管理员审核通过后才切换为 teacher
  async apply(@Body() b: any, @Req() req: any) {
    const uid = Number(req.user.uid);
    if (!b.realName || !b.idCard) throw bad("请填写真实姓名与身份证号");
    if (!/^\d{17}[\dXx]$/.test(String(b.idCard))) throw bad("身份证号格式不正确");
    if (!b.subjects || !String(b.subjects).length) throw bad("请选择擅长科目");
    if (!(Number(b.hourlyPrice) > 0)) throw bad("请填写课时单价");
    const exist = await this.rawProfile(uid);
    if (exist && exist.audit_status === "approved") throw biz("ALREADY_APPROVED", "您已通过资质审核");
    if (exist && exist.audit_status === "pending") throw biz("IN_REVIEW", "资料审核中，请耐心等待");

    // 身份证正反面：传了正面就一定要能识别出来，且姓名/号码必须与填写的一致
    const front = String(b.idCardFrontUrl || "").trim();
    const back = String(b.idCardBackUrl || "").trim();
    let idCardName: string | null = null;
    let idCardVerified = 0;
    if (front) {
      const { buffer, filename } = this.uploads.readByUrl(front);
      const ocr = await recognizeIdCardFront(buffer, { filename });
      if (!ocr.ok) {
        throw biz("ID_CARD_UNRECOGNIZED", "证件照片未能识别，请上传清晰、无反光的身份证人像面");
      }
      const match = checkIdCardMatch(ocr, { realName: String(b.realName).trim(), idCard: String(b.idCard).trim() });
      if (!match.ok) throw biz("ID_CARD_MISMATCH", match.reason || "证件信息与填写内容不一致");
      idCardName = String(ocr.name);
      idCardVerified = 1;
    }

    const lat = b.lat != null ? Number(b.lat) : 30.2741;
    const lng = b.lng != null ? Number(b.lng) : 120.1551;
    const region = await resolveRegion(this.ds, lat, lng);
    const args = [
      b.identityType || "student", b.realName, b.idCard, b.eduCertUrl || null, b.teacherCertUrl || null,
      b.skillCertUrl || null, b.intro || "", b.subjects, b.stages || "", Math.round(Number(b.hourlyPrice)),
      Number(b.serviceRadiusKm || 5), lat, lng, JSON.stringify(b.schedule || []), b.coverArea || "",
      // 授课地址（P65）：留空表示只支持上门
      String(b.baseAddress || "").trim() || null,
      front || null, back || null, idCardName, idCardVerified,
    ];
    await this.ds.transaction(async (m) => {
      if (exist) {
        await m.query(
          `UPDATE \`teacher_profiles\` SET \`identity_type\` = ?, \`real_name\` = ?, \`id_card\` = ?, \`edu_cert_url\` = ?,
             \`teacher_cert_url\` = ?, \`skill_cert_url\` = ?, \`intro\` = ?, \`subjects\` = ?, \`stages\` = ?, \`hourly_price\` = ?,
             \`service_radius_km\` = ?, \`base_lat\` = ?, \`base_lng\` = ?, \`schedule\` = ?, \`cover_area\` = ?,
             \`base_address\` = ?,
             \`id_card_front_url\` = ?, \`id_card_back_url\` = ?, \`id_card_name\` = ?, \`id_card_verified\` = ?,
             \`audit_status\` = 'pending', \`reject_reason\` = NULL, \`updated_at\` = ? WHERE \`user_id\` = ?`,
          [...args, nowIso(), uid],
        );
      } else {
        await m.query(
          `INSERT INTO \`teacher_profiles\` (\`user_id\`,\`identity_type\`,\`real_name\`,\`id_card\`,\`edu_cert_url\`,\`teacher_cert_url\`,
             \`skill_cert_url\`,\`intro\`,\`subjects\`,\`stages\`,\`hourly_price\`,\`service_radius_km\`,\`base_lat\`,\`base_lng\`,
             \`schedule\`,\`cover_area\`,\`base_address\`,\`id_card_front_url\`,\`id_card_back_url\`,\`id_card_name\`,\`id_card_verified\`,
             \`audit_status\`,\`created_at\`,\`updated_at\`)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
          [uid, ...args, nowIso(), nowIso()],
        );
      }
      // 入驻申请只写资料，不改 role：角色切换由管理员审核通过时执行（admin-ops.auditTeacher），
      // 否则任何人提交假资料就能立刻获得教员端权限
      await m.query("UPDATE `users` SET `real_name` = ?, `id_card` = ?, `region_id` = ? WHERE `id` = ?",
        [b.realName, b.idCard, region?.id ?? null, uid]);
      await m.query("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [uid, nowIso()]);
      await audit(m, req, "teacher.apply", "users:" + uid);
    });
    return ok({ auditStatus: "pending", idCardVerified: idCardVerified === 1 });
  }

  /**
   * 身份证识别预览：页面上传完人像面后可先调它拿识别结果，避免填完一大张表单才被打回。
   * 只回显姓名与脱敏号码 + 与当前填写的比对结论，不回显底层通道错误。
   */
  @Post("ocr-idcard")
  @HttpCode(200)
  @Roles("teacher", "parent")
  async ocrIdCard(@Body() b: any) {
    const url = String(b?.url || "").trim();
    if (!url) throw bad("请先上传身份证人像面");
    const { buffer, filename } = this.uploads.readByUrl(url);
    const ocr = await recognizeIdCardFront(buffer, { filename });
    if (!ocr.ok) {
      return ok({ recognized: false, message: "证件照片未能识别，请上传清晰、无反光的身份证人像面" });
    }
    const match = checkIdCardMatch(ocr, { realName: b?.realName, idCard: b?.idCard });
    return ok({
      recognized: true,
      name: ocr.name,
      idCardMasked: maskIdCard(ocr.idCard),
      provider: ocr.provider,
      match: { ok: match.ok, nameMatched: match.nameMatched, idCardMatched: match.idCardMatched },
      message: match.ok ? "证件信息与填写内容一致" : match.reason,
    });
  }

  @Get("profile")
  @Roles("teacher", "parent")
  async profileView(@Req() req: any) {
    const uid = Number(req.user.uid);
    const tp = await this.rawProfile(uid);
    if (!tp) return ok({ applied: false });
    return ok({ applied: true, profile: await this.privateView(uid) });
  }

  @Put("profile")
  async updateProfile(@Body() b: any, @Req() req: any) {
    const uid = Number(req.user.uid);
    const tp = await this.requireProfile(uid);
    await this.ds.query(
      `UPDATE \`teacher_profiles\` SET \`intro\` = ?, \`subjects\` = ?, \`stages\` = ?, \`hourly_price\` = ?,
         \`service_radius_km\` = ?, \`base_lat\` = ?, \`base_lng\` = ?, \`schedule\` = ?, \`cover_area\` = ?,
         \`base_address\` = ?, \`updated_at\` = ? WHERE \`user_id\` = ?`,
      [
        b.intro ?? tp.intro, b.subjects ?? tp.subjects, b.stages ?? tp.stages,
        b.hourlyPrice != null ? Math.round(Number(b.hourlyPrice)) : Number(tp.hourly_price),
        b.serviceRadiusKm != null ? Number(b.serviceRadiusKm) : Number(tp.service_radius_km),
        b.lat != null ? Number(b.lat) : Number(tp.base_lat),
        b.lng != null ? Number(b.lng) : Number(tp.base_lng),
        JSON.stringify(b.schedule ?? (tp.schedule ? JSON.parse(tp.schedule) : [])),
        b.coverArea ?? tp.cover_area,
        // 授课地址（P65）：传空串表示关闭「到教员处上课」
        b.baseAddress !== undefined ? (String(b.baseAddress || "").trim() || null) : (tp.base_address ?? null),
        nowIso(), uid,
      ],
    );
    await audit(this.ds, req, "teacher.updateProfile", "users:" + uid);
    return ok(await this.privateView(uid));
  }

  @Post("online")
  @HttpCode(200)
  async online(@Body() body: any, @Req() req: any) {
    const uid = Number(req.user.uid);
    const tp = await this.requireProfile(uid);
    if (tp.audit_status !== "approved") throw biz("NOT_APPROVED", "资质审核通过后才能上线接单");
    const online = body?.online ? 1 : 0;
    await this.ds.query("UPDATE `teacher_profiles` SET `online` = ?, `updated_at` = ? WHERE `user_id` = ?", [online, nowIso(), uid]);
    await audit(this.ds, req, "teacher.online", "users:" + uid, { online });
    return ok({ online: !!online });
  }

  /* ---------------- 接单大盘 ---------------- */
  @Get("dashboard")
  async dashboard(@Req() req: any) {
    const uid = Number(req.user.uid);
    const tp = await this.requireProfile(uid);
    const today = new Date().toISOString().slice(0, 10);
    const c = async (sql: string, p: any[]) => Number((await this.ds.query(sql, p))[0]?.c ?? 0);
    const s = async (sql: string, p: any[]) => Number((await this.ds.query(sql, p))[0]?.s ?? 0);

    const todayLessons = await c(
      "SELECT COUNT(*) AS c FROM `orders` WHERE `teacher_id` = ? AND `lesson_time` LIKE ? AND `status` IN ('pending_class','in_class','awaiting_parent_confirm','completed','settled')",
      [uid, today + "%"],
    );
    const todayIncome = await s(
      "SELECT COALESCE(SUM(`teacher_income`),0) AS s FROM `orders` WHERE `teacher_id` = ? AND `updated_at` LIKE ? AND `status` IN ('completed','settled')",
      [uid, today + "%"],
    );
    // 本周课时（周一起算），对应 UI 说明书 3.1「数据概览卡：本周课时」
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    weekStart.setHours(0, 0, 0, 0);
    const weekLessons = await c(
      "SELECT COUNT(*) AS c FROM `orders` WHERE `teacher_id` = ? AND `lesson_time` >= ? AND `status` IN ('pending_class','in_class','awaiting_parent_confirm','completed','settled')",
      [uid, weekStart.toISOString()],
    );
    const levels = (await this.rules.get("teacher_levels")) as any[];
    const idx = levels.findIndex((l) => l.level === tp.level);
    const lv = levels[idx] || levels[0];
    const nextLevel = levels[idx + 1] || null;
    return ok({
      online: !!tp.online,
      auditStatus: tp.audit_status,
      overview: {
        todayLessons,
        weekLessons,
        todayIncome,
        ratingAvg: Number(Number(tp.rating_avg).toFixed(2)),
        ratingCount: Number(tp.rating_count),
        level: tp.level,
        levelName: lv?.name,
        growthScore: Number(tp.growth_score),
        commission: lv?.commission,
        levelWeight: lv?.weight,
        completedLessons: Number(tp.completed_lessons),
      },
      nextLevel: nextLevel ? { level: nextLevel.level, name: nextLevel.name, need: Math.max(0, Number(nextLevel.min) - Number(tp.growth_score)) } : null,
      serviceStatus: {
        subjects: (tp.subjects || "").split(",").filter(Boolean),
        radiusKm: Number(tp.service_radius_km),
        coverArea: tp.cover_area,
        price: Number(tp.hourly_price),
      },
      pendingCount: await c(
        "SELECT COUNT(*) AS c FROM `orders` WHERE `teacher_id` = ? AND `status` IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm')",
        [uid],
      ),
      wallet: await walletSnapshot(this.ds, uid),
      notices: await this.ds.query(
        "SELECT * FROM `announcements` WHERE `status` = 'on' AND (`audience` = 'all' OR `audience` = 'teacher') ORDER BY `pinned` DESC, `created_at` DESC LIMIT 2",
      ),
    });
  }

  /* ---------------- 我的服务 ---------------- */
  @Get("services")
  async services(@Req() req: any) {
    return ok(await this.ds.query(
      "SELECT * FROM `teacher_services` WHERE `teacher_id` = ? ORDER BY `status` = 'on' DESC, `id` DESC", [Number(req.user.uid)],
    ));
  }

  @Post("services")
  @HttpCode(200)
  async createService(@Body() b: any, @Req() req: any) {
    const uid = Number(req.user.uid);
    if (!b?.title) throw bad("请填写服务标题");
    if (!(Number(b?.price) > 0)) throw bad("请填写课时价格");
    const r = await this.ds.query(
      "INSERT INTO `teacher_services` (`teacher_id`,`title`,`subjects`,`stages`,`price`,`cover_radius_km`,`schedule`,`description`,`status`,`created_at`,`updated_at`) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [uid, b.title, b.subjects || "", b.stages || "", Math.round(Number(b.price)), Number(b.coverRadiusKm || 5),
        JSON.stringify(b.schedule || []), b.description || "", "on", nowIso(), nowIso()],
    );
    await audit(this.ds, req, "teacher.service.create", "services:" + r.insertId);
    return ok((await this.ds.query("SELECT * FROM `teacher_services` WHERE `id` = ?", [r.insertId]))[0]);
  }

  private async ownService(uid: number, id: number) {
    const s = (await this.ds.query("SELECT * FROM `teacher_services` WHERE `id` = ? AND `teacher_id` = ?", [id, uid]))[0];
    if (!s) throw notFound("服务不存在");
    return s;
  }

  @Put("services/:id")
  async updateService(@Param("id") id: string, @Body() b: any, @Req() req: any) {
    const s = await this.ownService(Number(req.user.uid), Number(id));
    await this.ds.query(
      "UPDATE `teacher_services` SET `title` = ?, `subjects` = ?, `stages` = ?, `price` = ?, `cover_radius_km` = ?, `description` = ?, `status` = ?, `updated_at` = ? WHERE `id` = ?",
      [b.title ?? s.title, b.subjects ?? s.subjects, b.stages ?? s.stages,
        b.price != null ? Math.round(Number(b.price)) : Number(s.price),
        b.coverRadiusKm != null ? Number(b.coverRadiusKm) : Number(s.cover_radius_km),
        b.description ?? s.description, b.status ?? s.status, nowIso(), s.id],
    );
    return ok((await this.ds.query("SELECT * FROM `teacher_services` WHERE `id` = ?", [s.id]))[0]);
  }

  @Post("services/:id/toggle")
  @HttpCode(200)
  async toggleService(@Param("id") id: string, @Req() req: any) {
    const s = await this.ownService(Number(req.user.uid), Number(id));
    const next = s.status === "on" ? "off" : "on";
    await this.ds.query("UPDATE `teacher_services` SET `status` = ?, `updated_at` = ? WHERE `id` = ?", [next, nowIso(), s.id]);
    await audit(this.ds, req, "teacher.service.toggle", "services:" + s.id, { status: next });
    return ok({ status: next });
  }

  @Delete("services/:id")
  async removeService(@Param("id") id: string, @Req() req: any) {
    const s = await this.ownService(Number(req.user.uid), Number(id));
    await this.ds.query("DELETE FROM `teacher_services` WHERE `id` = ?", [s.id]);
    return ok({ ok: true });
  }

  /* ---------------- 订单 / 等级 / 收入 ---------------- */
  @Get("orders")
  async ordersList(@Query("status") status: string, @Query("pendingCancel") pendingCancel: string, @Req() req: any) {
    const list = await this.orders.listBy(Number(req.user.uid), "teacher", status);
    // pendingCancel=1：只要「家长申请取消、等教员处理」的订单（教员端「待处理」用）
    if (pendingCancel === "1") {
      const rows = (list && list.list ? list.list : []).filter((o: any) => o.cancelRequested);
      return ok({ list: rows, total: rows.length, pendingCancel: true });
    }
    return ok(list);
  }

  /** 教员端「退款」：同意家长的取消申请（按规则重算退款额并释放担保） */
  @Post("orders/:id/cancel-approve")
  @HttpCode(200)
  async approveCancel(@Param("id") id: string, @Req() req: any) {
    return ok(await this.orders.approveCancelRequest(Number(req.user.uid), Number(id)));
  }

  /** 教员端「驳回」：不同意取消（订单回到原状态，理由回给家长） */
  @Post("orders/:id/cancel-reject")
  @HttpCode(200)
  async rejectCancel(@Param("id") id: string, @Body() body: { reason?: string }, @Req() req: any) {
    return ok(await this.orders.rejectCancelRequest(Number(req.user.uid), Number(id), String(body?.reason || "")));
  }

  /** 等级权益（需求 5.3）：成长分 → 等级 → 抽佣与派单权重 */
  @Get("level")
  async level(@Req() req: any) {
    const uid = Number(req.user.uid);
    const tp = await this.requireProfile(uid);
    const levels = (await this.rules.get("teacher_levels")) as any[];
    const idx = levels.findIndex((l) => l.level === tp.level);
    const cur = levels[idx] || levels[0];
    const next = levels[idx + 1] || null;
    const score = Number(tp.growth_score);
    return ok({
      level: cur.level,
      levelName: cur.name,
      growthScore: score,
      commission: cur.commission,
      levelWeight: cur.weight,
      nextLevel: next ? { level: next.level, name: next.name, min: next.min, need: Math.max(0, Number(next.min) - score) } : null,
      progress: next ? Math.min(100, Math.round(((score - Number(cur.min)) / (Number(next.min) - Number(cur.min))) * 100)) : 100,
      levels,
      growthRules: await this.rules.get("growth_rules"),
      logs: await this.ds.query("SELECT * FROM `growth_logs` WHERE `teacher_id` = ? ORDER BY `id` DESC LIMIT 30", [uid]),
      levelLogs: await this.ds.query("SELECT * FROM `level_logs` WHERE `teacher_id` = ? ORDER BY `id` DESC LIMIT 20", [uid]),
      ratingAvg: Number(Number(tp.rating_avg).toFixed(2)),
      ratingCount: Number(tp.rating_count),
      completedLessons: Number(tp.completed_lessons),
    });
  }

  @Get("income")
  async income(@Req() req: any) {
    const uid = Number(req.user.uid);
    const month = new Date().toISOString().slice(0, 7);
    const n = async (sql: string, p: any[]) => Number((await this.ds.query(sql, p))[0]?.s ?? 0);
    return ok({
      wallet: await walletSnapshot(this.ds, uid),
      monthIncome: await n("SELECT COALESCE(SUM(`teacher_income`),0) AS s FROM `orders` WHERE `teacher_id` = ? AND `status` IN ('completed','settled') AND `updated_at` LIKE ?", [uid, month + "%"]),
      totalServiceFee: await n("SELECT COALESCE(SUM(`service_fee`),0) AS s FROM `orders` WHERE `teacher_id` = ? AND `status` IN ('completed','settled')", [uid]),
      frozenOrders: await this.ds.query("SELECT `order_no`,`teacher_income`,`settle_at` FROM `orders` WHERE `teacher_id` = ? AND `status` = 'completed'", [uid]),
      txns: await this.ds.query(
        "SELECT t.*, o.`order_no` FROM `wallet_txns` t LEFT JOIN `orders` o ON o.id = t.order_id WHERE t.`user_id` = ? ORDER BY t.`id` DESC LIMIT 100",
        [uid],
      ),
      rule: await this.rules.get("settlement"),
      level: (await this.privateView(uid)),
    });
  }

  /* ---------------- 排课日历 ---------------- */
  @Get("calendar")
  async calendar(@Query("month") month: string, @Req() req: any) {
    const uid = Number(req.user.uid);
    const m = month || new Date().toISOString().slice(0, 7);
    const tp = await this.requireProfile(uid);
    return ok({
      month: m,
      lessons: await this.ds.query(
        `SELECT \`id\`,\`order_no\`,\`subject\`,\`stage\`,\`lesson_time\`,\`address\`,\`status\` FROM \`orders\`
         WHERE \`teacher_id\` = ? AND \`lesson_time\` LIKE ? AND \`status\` IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm','completed','settled')
         ORDER BY \`lesson_time\``,
        [uid, m + "%"],
      ),
      schedule: tp.schedule ? JSON.parse(tp.schedule) : [],
    });
  }

  /* ---------------- 评价管理 ---------------- */
  @Get("reviews")
  async reviews(@Req() req: any) {
    const uid = Number(req.user.uid);
    const tp = await this.requireProfile(uid);
    const list = (await this.ds.query(
      "SELECT r.*, u.`nickname` AS `parentName`, o.`order_no` FROM `reviews` r JOIN `users` u ON u.id = r.parent_id LEFT JOIN `orders` o ON o.id = r.order_id WHERE r.`teacher_id` = ? ORDER BY r.`id` DESC",
      [uid],
    )).map((r: any) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
    const publicReviews = await this.ds.query(
      "SELECT r.`id`, r.`score`, r.`content`, r.`tags`, r.`weight`, r.`created_at`, u.`nickname` AS `parentName`, u.`avatar` AS `parentAvatar` FROM `reviews` r JOIN `users` u ON u.id = r.parent_id WHERE r.`teacher_id` = ? AND r.`status` = 'public' ORDER BY r.`created_at` DESC LIMIT 10",
      [uid],
    );
    return ok({
      list,
      ratingAvg: Number(Number(tp.rating_avg).toFixed(2)),
      ratingCount: Number(tp.rating_count),
      publicReviews: publicReviews.map((r: any) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] })),
    });
  }

  /** 差评申诉 */
  @Post("reviews/:id/appeal")
  @HttpCode(200)
  async appeal(@Param("id") id: string, @Body() b: any, @Req() req: any) {
    const uid = Number(req.user.uid);
    const r = (await this.ds.query("SELECT * FROM `reviews` WHERE `id` = ? AND `teacher_id` = ?", [Number(id), uid]))[0];
    if (!r) throw notFound("评价不存在");
    if (r.appeal_status !== "none") throw biz("APPEALED", "该评价已提交申诉");
    if (!b?.reason) throw bad("请填写申诉理由");
    await this.ds.transaction(async (m) => {
      await m.query("UPDATE `reviews` SET `appeal_status` = 'pending', `appeal_reason` = ? WHERE `id` = ?", [b.reason, r.id]);
      const order = (await m.query("SELECT `region_id` FROM `orders` WHERE `id` = ?", [r.order_id]))[0];
      await m.query(
        "INSERT INTO `complaints` (`order_id`,`from_user`,`from_role`,`against_user`,`region_id`,`type`,`title`,`content`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [r.order_id, uid, "teacher", r.parent_id, order?.region_id ?? null, "review_appeal", "差评申诉：评价 #" + r.id, b.reason, "open", nowIso()],
      );
      await audit(m, req, "review.appeal", "reviews:" + r.id);
    });
    return ok({ ok: true });
  }

  /* ---------------- 个人中心 ---------------- */
  @Get("profile-page")
  async profilePage(@Req() req: any) {
    const uid = Number(req.user.uid);
    const tp = await this.requireProfile(uid);
    const c = async (sql: string, p: any[]) => Number((await this.ds.query(sql, p))[0]?.c ?? 0);
    return ok({
      profile: await this.privateView(uid),
      wallet: await walletSnapshot(this.ds, uid),
      stats: {
        orders: await c("SELECT COUNT(*) AS c FROM `orders` WHERE `teacher_id` = ?", [uid]),
        services: await c("SELECT COUNT(*) AS c FROM `teacher_services` WHERE `teacher_id` = ?", [uid]),
        reviews: Number(tp.rating_count),
      },
      auditStatus: tp.audit_status,
      rejectReason: tp.reject_reason,
    });
  }
}
