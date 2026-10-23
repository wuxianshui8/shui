// 订单生命周期（需求 5.4）：下单 → 支付 → 打卡上课 → 结束授课 → 家长确认 → 冻结 → 结算
// 同时承载：取消/退款、评价、风控校验、分账、紧急求助
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";
import { bad, biz, conflict, forbidden, notFound } from "../common/errors";
import { nowIso } from "../common/reply";
import { haversineKm } from "../common/geo";
import { audit, notify } from "../common/audit";
import { RuleConfigService } from "../rules/rule-config.service";
import { RuleEngineService } from "../rules/rule-engine.service";
import { getPayProvider } from "../integrations/pay/pay.service";
import {
  applyRate, ensureWallet, escrowBalance, escrowMove, walletAdd, walletFreezeIncoming, walletSettle,
} from "../common/ledger";

const STATUS_TEXT: Record<string, { parent: string; teacher: string }> = {
  awaiting_payment: { parent: "待付款", teacher: "待确认" },
  pending_class: { parent: "待上课", teacher: "待上门" },
  in_class: { parent: "进行中", teacher: "上课中" },
  awaiting_parent_confirm: { parent: "待确认完成", teacher: "待家长确认" },
  completed: { parent: "已完成", teacher: "已完成" },
  settled: { parent: "已完成", teacher: "已完成" },
  cancelled: { parent: "已取消", teacher: "已取消" },
  refunding: { parent: "退款中", teacher: "退款中" },
  refunded: { parent: "已退款", teacher: "已退款" },
};

function rand(n: number) {
  const A = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
const orderNo = () => "JJ" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + rand(8);
const tradeNo = (p = "WX") => p + Date.now() + rand(6);
const addDays = (iso: string, d: number) => new Date(new Date(iso).getTime() + d * 86400000).toISOString();

@Injectable()
export class OrdersService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RuleConfigService,
    private readonly engine: RuleEngineService,
  ) {}

  /* ---------------- 视图组装 ---------------- */
  async view(o: any, role: "parent" | "teacher" = "parent", mask = false) {
    if (!o) return null;
    const parent = (await this.ds.query("SELECT `id`,`nickname`,`avatar`,`phone` FROM `users` WHERE `id` = ?", [o.parent_id]))[0];
    const teacher = (await this.ds.query(
      "SELECT tp.*, u.nickname, u.avatar, u.phone FROM `teacher_profiles` tp JOIN `users` u ON u.id = tp.user_id WHERE tp.user_id = ?",
      [o.teacher_id],
    ))[0];
    const pp = (await this.ds.query("SELECT * FROM `parent_profiles` WHERE `user_id` = ?", [o.parent_id]))[0];
    const levels = (await this.rules.get("parent_credit")) as any[];
    const clv = pp ? levels.find((l) => l.level === pp.credit_level) || levels[0] : null;
    const teacherLevels = (await this.rules.get("teacher_levels")) as any[];
    const hasReview = (await this.ds.query("SELECT `id` FROM `reviews` WHERE `order_id` = ?", [o.id])).length > 0;
    const maskPhone = (p?: string) => (p ? String(p).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2") : "");
    const freeHours = Number(((await this.rules.get("settlement")) as any).free_cancel_hours ?? 4);
    return {
      id: Number(o.id),
      orderNo: o.order_no,
      subject: o.subject,
      stage: o.stage,
      lessonTime: o.lesson_time,
      lessonEnd: o.lesson_end,
      address: mask && String(o.address || "").length > 10 ? String(o.address).slice(0, 8) + "***" : o.address,
      // mask=true（代理/业务员视角）时坐标只保留 2 位小数（约 1km 精度）：否则地址虽打码、经纬度仍可精确定位到家长门口
      lat: mask ? Number(Number(o.lat).toFixed(2)) : Number(o.lat),
      lng: mask ? Number(Number(o.lng).toFixed(2)) : Number(o.lng),
      amount: Number(o.amount),
      urgentFee: Number(o.urgent_fee),
      status: o.status,
      statusText: STATUS_TEXT[o.status]?.[role] || o.status,
      commissionRate: Number(o.commission_rate),
      serviceFee: Number(o.service_fee),
      teacherIncome: Number(o.teacher_income),
      agentShare: Number(o.agent_share),
      salesCommission: Number(o.sales_commission),
      platformRevenue: Number(o.platform_revenue),
      regionId: o.region_id == null ? null : Number(o.region_id),
      salesId: o.sales_id == null ? null : Number(o.sales_id),
      agentId: o.agent_id == null ? null : Number(o.agent_id),
      paidAt: o.paid_at,
      checkinAt: o.checkin_at,
      checkinDistance: o.checkin_distance == null ? null : Number(o.checkin_distance),
      finishedAt: o.finished_at,
      confirmAt: o.confirm_at,
      settleAt: o.settle_at,
      cancelBy: o.cancel_by,
      cancelReason: o.cancel_reason,
      // 取消申请状态：cancelRequested 为真 = 家长已申请取消、等教员端「退款 / 驳回」
      cancelRequestedAt: o.cancel_requested_at || null,
      cancelRequested: !!o.cancel_requested_at,
      cancelRejectedAt: o.cancel_rejected_at || null,
      cancelRejectReason: o.cancel_reject_reason || null,
      penalty: Number(o.penalty),
      refundAmount: Number(o.refund_amount),
      remark: o.remark,
      createdAt: o.created_at,
      freeCancelHours: freeHours,
      freeCancelDeadline: o.lesson_time ? new Date(new Date(o.lesson_time).getTime() - freeHours * 3600000).toISOString() : null,
      parent: parent
        ? {
            id: Number(parent.id),
            nickname: parent.nickname,
            phone: mask ? maskPhone(parent.phone) : parent.phone,
            credit: pp
              ? {
                  creditScore: pp.credit_score,
                  creditLevel: pp.credit_level,
                  creditLevelName: clv?.name,
                  reviewWeight: clv?.weight,
                  completedOrders: pp.completed_orders,
                  cancelCount: pp.cancel_count,
                  restricted: !!pp.restricted,
                  nextLevel: levels.find((l) => l.min > pp.credit_score) || null,
                }
              : null,
          }
        : null,
      teacher: teacher
        ? {
            id: Number(teacher.user_id),
            nickname: teacher.nickname,
            avatar: teacher.avatar,
            phone: mask ? maskPhone(teacher.phone) : teacher.phone,
            level: teacher.level,
            levelName: teacherLevels.find((l) => l.level === teacher.level)?.name,
            ratingAvg: Number(Number(teacher.rating_avg).toFixed(2)),
            ratingCount: teacher.rating_count,
            subjects: (teacher.subjects || "").split(",").filter(Boolean),
            identityType: teacher.identity_type,
          }
        : null,
      hasReview,
    };
  }

  async get(orderId: number) {
    const rows = await this.ds.query("SELECT * FROM `orders` WHERE `id` = ? LIMIT 1", [orderId]);
    return rows[0] || null;
  }

  /* ---------------- 创建订单 ---------------- */
  async createOrder(m: EntityManager, p: {
    parentId: number; teacherId: number; demandId?: number; serviceId?: number;
    subject: string; stage: string; lessonTime: string; lessonEnd?: string;
    address: string; lat: number; lng: number; regionId: number; amount: number;
    urgentFee?: number; remark?: string; couponId?: number;
  }) {
    const sales = (await m.query("SELECT `sales_id`,`agent_id` FROM `bindings` WHERE `user_id` = ? LIMIT 1", [p.parentId]))[0];
    const teacherSales = (await m.query("SELECT `sales_id`,`agent_id` FROM `bindings` WHERE `user_id` = ? LIMIT 1", [p.teacherId]))[0];
    const finalRegion = p.demandId
      ? (await m.query("SELECT `region_id` FROM `demands` WHERE `id` = ?", [p.demandId]))[0]?.region_id ?? p.regionId
      : p.regionId;
    // 5.5 跨区订单：收益归需求地址所在片区代理
    const regionAgent = (await m.query(
      "SELECT `user_id` FROM `agent_profiles` WHERE `region_id` = ? AND `status` = 'active' ORDER BY `user_id` LIMIT 1",
      [finalRegion],
    ))[0];
    const agentId = regionAgent?.user_id ?? sales?.agent_id ?? teacherSales?.agent_id ?? null;

    const tp = (await m.query("SELECT `level` FROM `teacher_profiles` WHERE `user_id` = ?", [p.teacherId]))[0];
    const levels = (await this.rules.get("teacher_levels")) as any[];
    const commissionRate = (levels.find((l) => l.level === tp?.level) || levels[0]).commission;

    // 优惠券抵扣（需求 4.1：优惠券仅可用于下单）
    let finalAmount = p.amount;
    let couponNote = "";
    if (p.couponId) {
      const uc = (await m.query(
        "SELECT uc.`id`, uc.`used`, c.`amount`, c.`threshold`, c.`name` FROM `user_coupons` uc JOIN `coupons` c ON c.`id` = uc.`coupon_id` WHERE uc.`id` = ? AND uc.`user_id` = ?",
        [p.couponId, p.parentId],
      ))[0];
      if (!uc) throw bad("优惠券不可用");
      if (Number(uc.used)) throw bad("优惠券已使用");
      if (p.amount < Number(uc.threshold)) throw bad("未达到优惠券使用门槛");
      finalAmount = Math.max(0, p.amount - Number(uc.amount));
      couponNote = "使用优惠券「" + uc.name + "」立减 ¥" + (Number(uc.amount) / 100).toFixed(2);
    }

    // 反作弊：同一家长 24 小时内高频下单 → 标记刷单风险并冻结结算，等待人工复核
    const riskCfg = (await this.rules.get("risk")) as any;
    const limit = Number(riskCfg.order_per_parent_day ?? 10);
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const recent = (await m.query("SELECT COUNT(*) AS c FROM `orders` WHERE `parent_id` = ? AND `created_at` >= ?", [p.parentId, dayAgo]))[0];
    const needReview = Number(recent.c) >= limit;

    const r = await m.query(
      `INSERT INTO \`orders\` (\`order_no\`,\`parent_id\`,\`teacher_id\`,\`demand_id\`,\`service_id\`,\`subject\`,\`stage\`,\`lesson_time\`,\`lesson_end\`,
        \`address\`,\`lat\`,\`lng\`,\`region_id\`,\`sales_id\`,\`agent_id\`,\`amount\`,\`urgent_fee\`,\`status\`,\`commission_rate\`,\`remark\`,\`created_at\`,\`updated_at\`)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [orderNo(), p.parentId, p.teacherId, p.demandId ?? null, p.serviceId ?? null, p.subject, p.stage, p.lessonTime,
        p.lessonEnd ?? null, p.address, p.lat, p.lng, finalRegion, sales?.sales_id ?? null, agentId,
        finalAmount, p.urgentFee ?? 0, "awaiting_payment", commissionRate,
        couponNote || p.remark || "", nowIso(), nowIso()],
    );
    const orderId = Number(r.insertId);
    if (p.couponId) {
      await m.query("UPDATE `user_coupons` SET `used` = 1, `order_id` = ? WHERE `id` = ?", [orderId, p.couponId]);
    }
    if (needReview) {
      await m.query(
        "INSERT INTO `risk_events` (`order_id`,`user_id`,`region_id`,`type`,`level`,`reason`,`status`,`settlement_hold`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?)",
        [orderId, p.parentId, finalRegion, "brush", Number(recent.c) + 1 >= limit * 2 ? "high" : "mid",
          "同一家长 24 小时内下单 " + (Number(recent.c) + 1) + " 笔，超过阈值 " + limit + " 笔，疑似刷单",
          "open", 1, nowIso()],
      );
    }
    const order = (await m.query("SELECT * FROM `orders` WHERE `id` = ?", [orderId]))[0];
    await notify(m, p.teacherId, "收到新订单", "家长已确认您接单，订单 " + order.order_no + " 待家长支付", "order", "/order/" + order.id);
    return order;
  }

  /* ---------------- 家长确认教员 → 生成订单 ---------------- */
  async confirmDemand(parentId: number, demandId: number, applicationId: number) {
    return this.ds.transaction(async (m) => {
      const d = (await m.query("SELECT * FROM `demands` WHERE `id` = ? LIMIT 1", [demandId]))[0];
      if (!d) throw notFound("需求不存在");
      if (Number(d.parent_id) !== parentId) throw forbidden();
      const app = (await m.query("SELECT * FROM `applications` WHERE `id` = ? AND `demand_id` = ?", [applicationId, d.id]))[0];
      if (!app) throw notFound("报名记录不存在");
      if (app.status !== "pending") {
        if (d.status === "matched") throw conflict("该需求已被确认，请勿重复操作");
        throw biz("BAD_STATUS", "该教员报名状态已变更");
      }
      // 原子占位：并发下只有一次确认能成功
      const claim = await m.query(
        "UPDATE `demands` SET `status` = 'matched', `confirm_app_id` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = 'published'",
        [app.id, nowIso(), d.id],
      );
      if (!claim.affectedRows) throw conflict("该需求已被确认或已关闭");
      await m.query("UPDATE `applications` SET `status` = 'confirmed' WHERE `id` = ?", [app.id]);
      await m.query("UPDATE `applications` SET `status` = 'rejected' WHERE `demand_id` = ? AND `id` <> ? AND `status` = 'pending'", [d.id, app.id]);

      const times = d.times ? JSON.parse(d.times) : [];
      const first = times[0] || {};
      const lessonTime = first.date ? new Date(first.date + "T" + (first.start || "09:00") + ":00").toISOString() : addDays(nowIso(), 1);
      const order = await this.createOrder(m, {
        parentId, teacherId: Number(app.teacher_id), demandId: Number(d.id),
        subject: d.subject, stage: d.stage, lessonTime, lessonEnd: first.end || null,
        address: d.address, lat: Number(d.lat), lng: Number(d.lng), regionId: Number(d.region_id),
        amount: Number(d.budget), urgentFee: Number(d.urgent_fee), remark: d.remark || "",
      });
      await audit(m, { user: { uid: parentId, role: "parent" } }, "order.confirmDemand", "orders:" + order.id, { demandId: d.id, appId: app.id });
      return this.view(order, "parent");
    });
  }

  /* ---------------- 选购服务下单 ---------------- */
  async fromService(parentId: number, b: any) {
    return this.ds.transaction(async (m) => {
      const svc = (await m.query("SELECT * FROM `teacher_services` WHERE `id` = ? AND `status` = 'on' LIMIT 1", [b.serviceId]))[0];
      if (!svc) throw notFound("服务不存在或已下架");
      const tp = (await m.query("SELECT * FROM `teacher_profiles` WHERE `user_id` = ? AND `audit_status` = 'approved'", [svc.teacher_id]))[0];
      if (!tp) throw biz("BAD_STATUS", "该教员暂不可接单");
      if (!b.lessonTime) throw bad("请选择上课时间");
      const addr = b.addressId
        ? (await m.query("SELECT * FROM `addresses` WHERE `id` = ? AND `user_id` = ?", [b.addressId, parentId]))[0]
        : (await m.query("SELECT * FROM `addresses` WHERE `user_id` = ? ORDER BY `is_default` DESC, `id` DESC LIMIT 1", [parentId]))[0];
      if (!addr) throw bad("请先添加上课地址");
      // 5.1 时段冲突校验：同一教员同一时段不可重复接单
      const conflictOrder = (await m.query(
        "SELECT `id` FROM `orders` WHERE `teacher_id` = ? AND `lesson_time` = ? AND `status` IN ('pending_class','in_class','awaiting_parent_confirm','completed')",
        [svc.teacher_id, b.lessonTime],
      ))[0];
      if (conflictOrder) throw biz("TIME_CONFLICT", "该教员此时段已有课程，请另选时间");
      const order = await this.createOrder(m, {
        parentId, teacherId: Number(svc.teacher_id), serviceId: Number(svc.id),
        subject: String(svc.subjects || "").split(",")[0] || "其他",
        stage: String(svc.stages || "").split(",")[0] || "小学",
        lessonTime: b.lessonTime, lessonEnd: b.lessonEnd || null,
        address: addr.address, lat: Number(addr.lat), lng: Number(addr.lng), regionId: Number(addr.region_id),
        amount: Number(svc.price), urgentFee: 0, remark: b.remark || "", couponId: b.couponId || null,
      });
      await audit(m, { user: { uid: parentId, role: "parent" } }, "order.fromService", "orders:" + order.id, { serviceId: svc.id });
      return this.view(order, "parent");
    });
  }

  /* ---------------- 担保支付 ---------------- */
  async pay(parentId: number, orderId: number, idemKey?: string, channel = "wechat_jsapi", openId?: string) {
    const pre = await this.get(orderId);
    if (!pre) throw notFound("订单不存在");
    if (Number(pre.parent_id) !== parentId) throw forbidden();
    // 幂等：已支付直接返回，不重复入账
    if (["pending_class", "in_class", "awaiting_parent_confirm", "completed", "settled"].includes(pre.status)) {
      return this.view(pre, "parent");
    }
    if (pre.status !== "awaiting_payment") {
      throw biz("BAD_STATUS", "当前订单状态不可支付：" + (STATUS_TEXT[pre.status]?.parent || pre.status));
    }

    const provider = getPayProvider();
    if (provider.name === "mock") {
      // 本地/自动化：保持「点一下即支付成功」的既有语义（全量门禁用例依赖）
      return this.ds.transaction(async (m) => {
        const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [orderId]))[0];
        if (o.status !== "awaiting_payment") return this.view(o, "parent");
        // 幂等重放：同一 X-Idem-Key 已入账则直接返回该订单（避免重复扣款/唯一索引报 400）
        if (idemKey) {
          const replay = (await m.query("SELECT `order_id` FROM `payments` WHERE `idem_key` = ? LIMIT 1", [idemKey]))[0];
          if (replay) {
            const same = (await m.query("SELECT * FROM `orders` WHERE `id` = ?", [Number(replay.order_id)]))[0];
            if (same) return this.view(same, "parent");
          }
        }
        return this.settlePaid(m, o, {
          payerId: parentId,
          amount: Number(o.amount) + Number(o.urgent_fee),
          channel,
          tradeNo: tradeNo("WX"),
          idemKey,
        });
      });
    }

    // 真实通道：先建预支付单（payments.status=pending），入账只等渠道回调确认
    if (provider.name === "wechat" && !openId) {
      throw biz("OPENID_REQUIRED", "微信支付需要 openid（待接入微信登录后下发）");
    }
    const amount = Number(pre.amount) + Number(pre.urgent_fee);
    let prepay: any;
    try {
      prepay = await provider.createPrepay({
        outTradeNo: String(pre.orderNo),
        amountCents: amount,
        description: "家教服务 " + String(pre.orderNo),
        openId: openId || "",
        notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || "",
        attach: "order:" + pre.id,
      });
    } catch (e: any) {
      // 渠道错误细节（签名/证书/网络）只进服务端日志，不给前端，避免泄露商户配置线索
      console.error("[pay] 预支付下单失败：" + (e?.message || e));
      throw biz("PAY_CHANNEL_ERROR", "支付渠道暂时不可用，请稍后重试");
    }

    // 预支付流水：trade_no 固定为 PREPAY:<订单号>，回调成功时改写为渠道流水号
    await this.ds.query(
      "INSERT INTO `payments` (`order_id`,`user_id`,`type`,`amount`,`channel`,`trade_no`,`status`,`idem_key`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE `id` = `id`",
      [pre.id, parentId, "pay", amount, channel, "PREPAY:" + pre.orderNo, "pending", idemKey ?? null, nowIso()],
    );
    return { mode: "prepay", orderId: Number(pre.id), amount, prepayId: prepay.prepayId, params: prepay.params };
  }

  /**
   * 渠道回调确认（微信支付 v3）：验签 → 幂等 → 金额一致 → 走与 mock 相同的结算逻辑。
   * 任何校验失败都抛错，由控制器转成非 2xx，让渠道重试而不是「假装成功」。
   */
  async settlePayNotify(rawBody: string, headers: Record<string, string | undefined>) {
    const provider = getPayProvider();
    const r = await provider.verifyNotify(rawBody, headers);
    // 非成功状态（NOTPAY/CLOSED/退款等）不动账，直接忽略
    if (!r.success) return { ignored: true, tradeState: r.tradeState, outTradeNo: r.outTradeNo };

    return this.ds.transaction(async (m) => {
      const o = (await m.query("SELECT * FROM `orders` WHERE `order_no` = ? FOR UPDATE", [r.outTradeNo]))[0];
      if (!o) throw new Error("回调对应的订单不存在：" + r.outTradeNo);
      // 幂等：已有成功支付记录 → 不重复入账（渠道会重试同一笔回调）
      const paid = (await m.query("SELECT `id` FROM `payments` WHERE `order_id` = ? AND `type` = 'pay' AND `status` = 'success' LIMIT 1", [o.id]))[0];
      if (paid) return { idempotent: true, orderId: Number(o.id) };
      const expect = Number(o.amount) + Number(o.urgent_fee);
      if (Number(r.amountCents) !== expect) {
        throw new Error("回调金额与订单应付不一致：渠道 " + r.amountCents + " / 订单 " + expect);
      }
      const pending = (await m.query("SELECT * FROM `payments` WHERE `order_id` = ? AND `type` = 'pay' AND `status` = 'pending' FOR UPDATE", [o.id]))[0];
      const view = await this.settlePaid(m, o, {
        payerId: Number(o.parent_id),
        amount: expect,
        channel: pending ? String(pending.channel) : provider.name,
        tradeNo: r.transactionId || "TXN:" + r.outTradeNo,
        paymentId: pending ? Number(pending.id) : undefined,
      });
      return { settled: true, orderId: Number(o.id), order: view };
    });
  }

  /**
   * 渠道退款结果回调（A2）：把「受理中」的退款收敛成终态，不依赖人工重试。
   * - SUCCESS：订单 → `refunded`、担保出账、退款流水置 success（有 pending 流水就改写它，避免重复出账）
   * - 非 SUCCESS：仅把 pending 流水置 failed 并通知家长人工跟进，订单保持 `refunding`
   */
  async settleRefundNotify(rawBody: string, headers: Record<string, string | undefined>) {
    const provider = getPayProvider();
    const r = await provider.verifyRefundNotify(rawBody, headers);

    if (!r.success) {
      const o0 = (await this.ds.query("SELECT * FROM `orders` WHERE `order_no` = ?", [r.outTradeNo]))[0];
      if (o0) {
        await this.ds.query("UPDATE `payments` SET `status` = 'failed' WHERE `order_id` = ? AND `type` = 'refund' AND `status` = 'pending'", [o0.id]);
        await notify(this.ds, Number(o0.parent_id), "退款未成功", "订单 " + o0.order_no + " 渠道退款状态：" + r.refundStatus + "，平台将人工跟进", "payment");
        await audit(this.ds, { user: { uid: 0, role: "system" } }, "order.refund.abnormal", "orders:" + o0.id, { refundStatus: r.refundStatus, refundId: r.refundId });
      }
      return { ignored: true, refundStatus: r.refundStatus, outTradeNo: r.outTradeNo };
    }

    return this.ds.transaction(async (m) => {
      const o = (await m.query("SELECT * FROM `orders` WHERE `order_no` = ? FOR UPDATE", [r.outTradeNo]))[0];
      if (!o) throw new Error("退款回调对应的订单不存在：" + r.outTradeNo);
      // 幂等：渠道会重投同一退款回调
      if (o.status === "refunded") return { idempotent: true, orderId: Number(o.id) };
      if (o.status !== "refunding") return { ignored: true, status: o.status, orderId: Number(o.id) };

      const amount = Number(r.refundCents);
      const pending = (await m.query("SELECT * FROM `payments` WHERE `order_id` = ? AND `type` = 'refund' AND `status` = 'pending' FOR UPDATE", [o.id]))[0];
      if (pending && Number(pending.amount) !== amount) {
        throw new Error("退款金额与流水不一致：渠道 " + amount + " / 流水 " + pending.amount);
      }
      const upd = await m.query(
        "UPDATE `orders` SET `status` = 'refunded', `refund_amount` = ?, `cancel_by` = 'admin', `updated_at` = ? WHERE `id` = ? AND `status` = 'refunding'",
        [amount, nowIso(), o.id],
      );
      if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "订单状态已变更，请刷新");
      if (pending) {
        await m.query("UPDATE `payments` SET `trade_no` = ?, `status` = 'success' WHERE `id` = ? AND `status` = 'pending'", [
          r.refundId || r.outRefundNo,
          pending.id,
        ]);
      } else {
        await m.query(
          "INSERT INTO `payments` (`order_id`,`user_id`,`type`,`amount`,`channel`,`trade_no`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
          [o.id, o.parent_id, "refund", amount, provider.name, r.refundId || "REFUND:" + r.outRefundNo, "success", nowIso()],
        );
      }
      await escrowMove(m, Number(o.id), "out", amount, "渠道退款回调入账 " + o.order_no);
      await notify(m, Number(o.parent_id), "退款已到账", "订单 " + o.order_no + " 退款 ¥" + (amount / 100).toFixed(2) + " 已原路退回", "payment");
      await notify(m, Number(o.teacher_id), "订单已退款", "订单 " + o.order_no + " 平台已完成退款", "order");
      await audit(m, { user: { uid: 0, role: "system" } }, "order.refund.settled", "orders:" + o.id, {
        amount,
        refundId: r.refundId,
        refundStatus: r.refundStatus,
      });
      const fresh = (await m.query("SELECT * FROM `orders` WHERE `id` = ?", [o.id]))[0];
      return { settled: true, orderId: Number(o.id), order: this.view(fresh, "parent") };
    });
  }

  /**
   * 结算入账（mock 即时支付与真实通道回调共用，保证两条路径账本完全一致）：
   * 写支付流水 → 担保台账入账 → 分账 → 推进订单状态 → 业务员提成 → 站内通知 → 审计。
   */
  private async settlePaid(
    m: EntityManager,
    o: any,
    p: { payerId: number; amount: number; channel: string; tradeNo: string; idemKey?: string; paymentId?: number },
  ) {
    if (p.paymentId) {
      const upd = await m.query(
        "UPDATE `payments` SET `trade_no` = ?, `status` = 'success', `channel` = ? WHERE `id` = ? AND `status` = 'pending'",
        [p.tradeNo, p.channel, p.paymentId],
      );
      if (!upd.affectedRows) throw biz("PAY_CONFLICT", "支付流水状态已变更，请刷新");
    } else {
      await m.query(
        "INSERT INTO `payments` (`order_id`,`user_id`,`type`,`amount`,`channel`,`trade_no`,`status`,`idem_key`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?)",
        [o.id, p.payerId, "pay", p.amount, p.channel, p.tradeNo, "success", p.idemKey ?? null, nowIso()],
      );
    }
    await escrowMove(m, Number(o.id), "in", p.amount, "家长预付课时费 " + o.order_no);

    const ap = o.agent_id ? (await m.query("SELECT * FROM `agent_profiles` WHERE `user_id` = ? LIMIT 1", [o.agent_id]))[0] : null;
    const agentCfg = (await this.rules.get("agent_commission")) as any;
    const salesCfg = (await this.rules.get("sales_rewards")) as any;
    const tiers = (salesCfg.deal_tiers as any[]) || [];
    const tier = tiers.find((t) => Number(o.amount) >= t.min && (t.max == null || Number(o.amount) <= t.max));
    const split = await this.engine.calcSplit({
      amount: Number(o.amount),
      commissionRate: Number(o.commission_rate),
      feeShareRate: ap && ap.commission_rate != null ? Number(ap.commission_rate) : Number(agentCfg.fee_share_rate),
      mgmtRate: ap && ap.mgmt_rate != null ? Number(ap.mgmt_rate) : Number(agentCfg.mgmt_rate),
      salesRate: o.sales_id ? (tier ? Number(tier.rate) : (tiers.length ? Number(tiers[tiers.length - 1].rate) : 0)) : 0,
    });
    await m.query(
      "UPDATE `orders` SET `status` = 'pending_class', `paid_at` = ?, `service_fee` = ?, `teacher_income` = ?, `agent_share` = ?, `sales_commission` = ?, `platform_revenue` = ?, `updated_at` = ? WHERE `id` = ?",
      [nowIso(), split.serviceFee, split.teacherIncome, split.agentShare, split.salesCommission, split.platformRevenue, nowIso(), o.id],
    );
    // 业务员成交提成（pending，周结）
    if (o.sales_id && split.salesCommission > 0) {
      await m.query(
        "INSERT INTO `rewards` (`sales_id`,`type`,`amount`,`ref_order_id`,`status`,`calc_note`,`created_at`) VALUES (?,?,?,?,?,?,?)",
        [o.sales_id, "deal", split.salesCommission, o.id, "pending",
          "订单 " + o.order_no + " 成交提成 " + (Number(tier?.rate ?? 0) * 100).toFixed(1) + "% × ¥" + (Number(o.amount) / 100).toFixed(2),
          nowIso()],
      );
    }
    await notify(m, Number(o.teacher_id), "订单已支付", "订单 " + o.order_no + " 家长已完成担保支付，请按时上门", "payment", "/order/" + o.id);
    await audit(m, { user: { uid: p.payerId, role: "parent" } }, "order.pay", "orders:" + o.id, { amount: p.amount, channel: p.channel });
    const fresh = (await m.query("SELECT * FROM `orders` WHERE `id` = ?", [o.id]))[0];
    return this.view(fresh, "parent");
  }

  /**
   * 超时关单（A2）：超过 `payment.pay_timeout_minutes`（默认 15 分钟）仍未支付的订单自动关闭。
   * - 真实通道先调渠道 `close`；渠道失败**不阻断**我方关单（只记日志），否则订单会被永久卡住
   * - 幂等：只处理仍是 `awaiting_payment` 的单，按实际更新行数计数；重复调用返回 0
   */
  async closeExpiredUnpaid(olderThanMinutes?: number) {
    const cfg = (await this.rules.get("payment").catch(() => ({}))) as any;
    // 允许亚分钟阈值（演练/门禁用），但绝不允许 0 或负数把新单一刀切
    const minutes = Math.max(0.01, Number(olderThanMinutes ?? cfg?.pay_timeout_minutes ?? 15));
    const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
    const stale = await this.ds.query(
      "SELECT `id`, `order_no`, `parent_id` FROM `orders` WHERE `status` = 'awaiting_payment' AND `created_at` < ? ORDER BY `id` LIMIT 200",
      [cutoff],
    );
    if (!stale.length) return { closed: 0, timeoutMinutes: minutes };

    const provider = getPayProvider();
    let closed = 0;
    for (const o of stale) {
      if (provider.name !== "mock") {
        try {
          await provider.close(String(o.order_no));
        } catch (e: any) {
          console.error("[pay] 渠道关单失败（继续本地关单）：" + o.order_no + " " + (e?.message || e));
        }
      }
      const n = await this.ds.transaction(async (m) => {
        const upd = await m.query(
          "UPDATE `orders` SET `status` = 'cancelled', `updated_at` = ? WHERE `id` = ? AND `status` = 'awaiting_payment'",
          [nowIso(), o.id],
        );
        if (!upd.affectedRows) return 0;
        await m.query("UPDATE `payments` SET `status` = 'closed' WHERE `order_id` = ? AND `type` = 'pay' AND `status` = 'pending'", [o.id]);
        await notify(m, Number(o.parent_id), "订单已超时关闭", "订单 " + o.order_no + " 超过 " + minutes + " 分钟未支付，已自动关闭", "order", "/order/" + o.id);
        await audit(m, { user: { uid: 0, role: "system" } }, "order.close_expired", "orders:" + o.id, { minutes });
        return 1;
      });
      closed += Number(n) || 0;
    }
    return { closed, timeoutMinutes: minutes };
  }

  /* ---------------- 上门打卡（默认 500 米阈值，可配置）---------------- */
  async checkin(teacherId: number, orderId: number, lat: number, lng: number) {
    const o = await this.get(orderId);
    if (!o) throw notFound("订单不存在");
    if (Number(o.teacher_id) !== teacherId) throw forbidden();
    if (o.status !== "pending_class") throw biz("BAD_STATUS", "当前状态不可打卡（" + (STATUS_TEXT[o.status]?.teacher || o.status) + "）");
    if (lat == null || lng == null) throw bad("请开启定位后再打卡");

    const cfg = (await this.rules.get("checkin")) as any;
    const threshold = Number(cfg.max_distance_m ?? 500);
    const distance = Math.round(haversineKm(Number(lat), Number(lng), Number(o.lat), Number(o.lng)) * 1000);
    if (distance > threshold) {
      await this.ds.query(
        "INSERT INTO `risk_events` (`order_id`,`user_id`,`region_id`,`type`,`level`,`reason`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
        [o.id, teacherId, o.region_id, "abnormal_location", distance > threshold * 3 ? "high" : "mid",
          "打卡定位距离 " + distance + " 米，超出阈值 " + threshold + " 米", "open", nowIso()],
      );
      throw biz("CHECKIN_TOO_FAR", "当前位置距离上课地点 " + distance + " 米，超出 " + threshold + " 米阈值，无法打卡");
    }
    const upd = await this.ds.query(
      "UPDATE `orders` SET `status` = 'in_class', `checkin_at` = ?, `checkin_lat` = ?, `checkin_lng` = ?, `checkin_distance` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = 'pending_class'",
      [nowIso(), Number(lat), Number(lng), distance, nowIso(), o.id],
    );
    if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "订单状态已变更，无法打卡");
    await notify(this.ds, Number(o.parent_id), "教员已到达", "教员已在距上课地点 " + distance + " 米处打卡，课程开始", "order", "/order/" + o.id);
    await audit(this.ds, { user: { uid: teacherId, role: "teacher" } }, "order.checkin", "orders:" + o.id, { distance });
    return this.view(await this.get(o.id), "teacher");
  }

  async finish(teacherId: number, orderId: number) {
    const o = await this.get(orderId);
    if (!o) throw notFound("订单不存在");
    if (Number(o.teacher_id) !== teacherId) throw forbidden();
    if (o.status !== "in_class") throw biz("BAD_STATUS", "尚未开始上课，无法结束授课");
    const upd = await this.ds.query(
      "UPDATE `orders` SET `status` = 'awaiting_parent_confirm', `finished_at` = ?, `updated_at` = ? WHERE `id` = ? AND `status` = 'in_class'",
      [nowIso(), nowIso(), o.id],
    );
    if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "订单状态已变更，无法结束授课");
    await notify(this.ds, Number(o.parent_id), "待确认完成", "教员已结束授课，请确认完成以结算课时费", "order", "/order/" + o.id);
    await audit(this.ds, { user: { uid: teacherId, role: "teacher" } }, "order.finish", "orders:" + o.id);
    return this.view(await this.get(o.id), "teacher");
  }

  /* ---------------- 家长确认完成 → 冻结待结算 ---------------- */
  async confirmComplete(parentId: number, orderId: number) {
    return this.ds.transaction(async (m) => {
      const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [orderId]))[0];
      if (!o) throw notFound("订单不存在");
      if (Number(o.parent_id) !== parentId) throw forbidden();
      if (o.status !== "awaiting_parent_confirm") throw biz("BAD_STATUS", "当前状态不可确认完成");
      const settlement = (await this.rules.get("settlement")) as any;
      const freezeDays = Number(settlement.freeze_days ?? 7);
      const settleAt = addDays(nowIso(), freezeDays);
      await m.query("UPDATE `orders` SET `status` = 'completed', `confirm_at` = ?, `settle_at` = ?, `updated_at` = ? WHERE `id` = ?", [nowIso(), settleAt, nowIso(), o.id]);
      await walletFreezeIncoming(m, Number(o.teacher_id), Number(o.teacher_income), { orderId: Number(o.id), remark: "课时费待结算（" + freezeDays + " 天冻结）" });
      await m.query("UPDATE `teacher_profiles` SET `completed_lessons` = `completed_lessons` + 1, `updated_at` = ? WHERE `user_id` = ?", [nowIso(), o.teacher_id]);
      const growth = (await this.rules.get("growth_rules")) as any;
      await this.applyGrowth(m, Number(o.teacher_id), Number(growth.per_lesson ?? 2), "完成有效课时", Number(o.id));
      const credit = (await this.rules.get("credit_rules")) as any;
      await this.applyCredit(m, Number(o.parent_id), Number(credit.order_completed ?? 3), "完成订单", Number(o.id));
      await m.query("UPDATE `parent_profiles` SET `completed_orders` = `completed_orders` + 1 WHERE `user_id` = ?", [o.parent_id]);
      await notify(m, Number(o.teacher_id), "家长已确认完成", "课时费 ¥" + (Number(o.teacher_income) / 100).toFixed(2) + " 将于 " + freezeDays + " 天后结算到账", "payment", "/order/" + o.id);
      await notify(m, Number(o.parent_id), "评价提醒", "请在 72 小时内评价本次家教服务", "order", "/review/" + o.id);
      await audit(m, { user: { uid: parentId, role: "parent" } }, "order.confirmComplete", "orders:" + o.id);
      const fresh = (await m.query("SELECT * FROM `orders` WHERE `id` = ?", [o.id]))[0];
      return this.view(fresh, "parent");
    });
  }

  /* ---------------- 成长分 / 信用分（需求 5.3）---------------- */
  async applyGrowth(m: EntityManager, teacherId: number, delta: number, reason: string, orderId?: number) {
    if (!delta) return null;
    const tp = (await m.query("SELECT `growth_score`,`level` FROM `teacher_profiles` WHERE `user_id` = ?", [teacherId]))[0];
    if (!tp) return null;
    const before = Number(tp.growth_score);
    const after = Math.max(0, before + Math.round(delta));
    await m.query("UPDATE `teacher_profiles` SET `growth_score` = ?, `updated_at` = ? WHERE `user_id` = ?", [after, nowIso(), teacherId]);
    await m.query("INSERT INTO `growth_logs` (`teacher_id`,`change`,`reason`,`balance_after`,`order_id`,`created_at`) VALUES (?,?,?,?,?,?)",
      [teacherId, Math.round(delta), reason, after, orderId ?? null, nowIso()]);
    const levels = (await this.rules.get("teacher_levels")) as any[];
    const target = levels.find((l) => after >= l.min && after <= l.max) || levels[levels.length - 1];
    if (target.level !== tp.level) {
      await m.query("UPDATE `teacher_profiles` SET `level` = ? WHERE `user_id` = ?", [target.level, teacherId]);
      await m.query("INSERT INTO `level_logs` (`teacher_id`,`from_level`,`to_level`,`reason`,`created_at`) VALUES (?,?,?,?,?)",
        [teacherId, tp.level, target.level, after > before ? "成长分达标升级" : "成长分低于等级下限自动降级", nowIso()]);
    }
    return { before, after, level: target.level, changed: target.level !== tp.level };
  }

  async applyViolation(m: EntityManager, teacherId: number, type: string, orderId?: number, extraNote = "") {
    const g = (await this.rules.get("growth_rules")) as any;
    const delta = Number(g?.violation?.[type] ?? 0);
    if (!delta) return null;
    const label: Record<string, string> = { no_show: "爽约未上门", fake_checkin: "虚假打卡", private_deal: "引导私单" };
    const res = await this.applyGrowth(m, teacherId, delta, (label[type] || type) + "扣分" + (extraNote ? "：" + extraNote : ""), orderId);
    if (type === "private_deal" && g.private_deal_ban) {
      await m.query("UPDATE `users` SET `status` = 'disabled' WHERE `id` = ?", [teacherId]);
    }
    return res;
  }

  async applyCredit(m: EntityManager, parentId: number, delta: number, reason: string, orderId?: number) {
    if (!delta) return null;
    const pp = (await m.query("SELECT `credit_score` FROM `parent_profiles` WHERE `user_id` = ?", [parentId]))[0];
    if (!pp) return null;
    const after = Math.max(0, Number(pp.credit_score) + Math.round(delta));
    const levels = (await this.rules.get("parent_credit")) as any[];
    const lv = levels.find((l) => after >= l.min && after <= l.max) || levels[0];
    const restrict = Number(((await this.rules.get("credit_rules")) as any).restrict_below ?? 0);
    await m.query("UPDATE `parent_profiles` SET `credit_score` = ?, `credit_level` = ?, `restricted` = ? WHERE `user_id` = ?",
      [after, lv.level, after <= restrict ? 1 : 0, parentId]);
    await m.query("INSERT INTO `credit_logs` (`user_id`,`change`,`reason`,`balance_after`,`order_id`,`created_at`) VALUES (?,?,?,?,?,?)",
      [parentId, Math.round(delta), reason, after, orderId ?? null, nowIso()]);
    return { before: Number(pp.credit_score), after, level: lv.level, weight: lv.weight };
  }

  /* ---------------- T+N 结算 ---------------- */
  async runSettlement(force = false) {
    const due = force
      ? await this.ds.query("SELECT `id` FROM `orders` WHERE `status` = 'completed'")
      : await this.ds.query("SELECT `id` FROM `orders` WHERE `status` = 'completed' AND `settle_at` IS NOT NULL AND `settle_at` <= ?", [nowIso()]);
    let count = 0;
    for (const row of due) {
      // 每笔订单在事务内重新加锁复查：多实例或「定时任务 + 后台手动触发」并发时只放款一次
      const settled = await this.ds.transaction(async (m) => {
        const order = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [Number(row.id)]))[0];
        if (!order || order.status !== "completed") return false;
        if (!force && (!order.settle_at || String(order.settle_at) > nowIso())) return false;
        // 风控冻结中的订单暂不放款
        const hold = await m.query("SELECT `id` FROM `risk_events` WHERE `order_id` = ? AND `settlement_hold` = 1 AND `status` <> 'closed'", [order.id]);
        if (hold.length) return false;
        await escrowMove(m, Number(order.id), "out", Number(order.amount) + Number(order.urgent_fee), "订单结算放款 " + order.order_no);
        await walletSettle(m, Number(order.teacher_id), Number(order.teacher_income), {
          orderId: Number(order.id),
          remark: "订单 " + order.order_no + " 课时费结算（已扣平台服务费 ¥" + (Number(order.service_fee) / 100).toFixed(2) + "）",
        });
        if (order.agent_id && Number(order.agent_share) > 0) {
          await walletAdd(m, Number(order.agent_id), Number(order.agent_share), {
            orderId: Number(order.id), type: "agent_share",
            remark: "片区分成 ¥" + (Number(order.agent_share) / 100).toFixed(2) + "（订单 " + order.order_no + "）",
          });
        }
        const upd = await m.query("UPDATE `orders` SET `status` = 'settled', `updated_at` = ? WHERE `id` = ? AND `status` = 'completed'", [nowIso(), order.id]);
        if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "订单已被其他进程结算");
        await notify(m, Number(order.teacher_id), "课时费已到账", "订单 " + order.order_no + " 课时费 ¥" + (Number(order.teacher_income) / 100).toFixed(2) + " 已结算至余额", "payment", "/wallet");
        return true;
      });
      if (settled) count++;
    }
    return count;
  }

  /* ---------------- 取消 / 退款 ---------------- */
  async cancelOrder(userId: number, role: string, orderId: number, reason = "") {
    return this.ds.transaction(async (m) => {
      const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [orderId]))[0];
      if (!o) throw notFound("订单不存在");
      const isParent = Number(o.parent_id) === userId;
      const isTeacher = Number(o.teacher_id) === userId;
      if (!isParent && !isTeacher && role !== "admin") throw forbidden();
      if (["completed", "settled", "cancelled", "refunded"].includes(o.status)) throw biz("BAD_STATUS", "当前订单状态不可取消");

      const settlement = (await this.rules.get("settlement")) as any;
      const credit = (await this.rules.get("credit_rules")) as any;
      let refund = 0;
      let penalty = 0;

      if (o.status === "awaiting_payment") {
        await m.query("UPDATE `orders` SET `status` = 'cancelled', `cancel_by` = ?, `cancel_reason` = ?, `updated_at` = ? WHERE `id` = ?", [role, reason, nowIso(), o.id]);
      } else if (isParent && o.status !== "in_class") {
        // 家长取消已付款订单 → 变成「取消申请」，由教员在教员端选「退款」或「驳回」；
        // 钱一分不动，等教员处理（超时未处理由定时任务自动按同意退款，不会把家长卡住）。
        if (o.cancel_requested_at) throw biz("CANCEL_REQUESTED", "已提交取消申请，正在等教员确认，请勿重复提交");
        await m.query("UPDATE `orders` SET `cancel_requested_at` = ?, `cancel_reason` = ?, `cancel_reject_reason` = NULL, `updated_at` = ? WHERE `id` = ?",
          [nowIso(), reason, nowIso(), o.id]);
        await notify(m, Number(o.teacher_id), "家长申请取消订单",
          "订单 " + o.order_no + " 家长申请取消" + (reason ? "。原因：" + reason : "") + "，请在「待处理」里选择退款或驳回",
          "order", "/order/" + o.id);
        await audit(m, { user: { uid: userId, role } }, "order.cancelRequest", "orders:" + o.id, { reason });
        return this.view((await m.query("SELECT * FROM `orders` WHERE `id` = ? LIMIT 1", [o.id]))[0], "parent");
      } else {
        const paid = Number(o.amount) + Number(o.urgent_fee);
        if (isParent) {
          if (o.status === "in_class") throw biz("BAD_STATUS", "课程进行中，请通过客服发起纠纷处理");
          const freeHours = Number(settlement.free_cancel_hours ?? 4);
          const deadline = new Date(new Date(o.lesson_time).getTime() - freeHours * 3600000).getTime();
          if (Date.now() <= deadline) {
            refund = paid;
          } else {
            penalty = applyRate(paid, Number(settlement.cancel_penalty_rate ?? 0.2));
            refund = paid - penalty;
            await this.applyCredit(m, Number(o.parent_id), Number(credit.cancel_within_4h ?? -8), "课前 " + freeHours + " 小时内取消订单", Number(o.id));
            await m.query("UPDATE `parent_profiles` SET `cancel_count` = `cancel_count` + 1 WHERE `user_id` = ?", [o.parent_id]);
          }
        } else if (isTeacher) {
          refund = paid;
          await this.applyViolation(m, Number(o.teacher_id), "no_show", Number(o.id), "教员取消已确认订单");
        } else {
          refund = paid;
        }
        await escrowMove(m, Number(o.id), "out", refund, "订单退款 " + o.order_no);
        if (penalty > 0) {
          await walletAdd(m, Number(o.teacher_id), penalty, { orderId: Number(o.id), type: "compensation", remark: "家长临时取消违约金补偿（订单 " + o.order_no + "）" });
        }
        await m.query("INSERT INTO `payments` (`order_id`,`user_id`,`type`,`amount`,`channel`,`trade_no`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
          [o.id, o.parent_id, "refund", refund, "wechat_jsapi", tradeNo("RF"), "success", nowIso()]);
        await m.query("UPDATE `orders` SET `status` = 'refunded', `cancel_by` = ?, `cancel_reason` = ?, `penalty` = ?, `refund_amount` = ?, `updated_at` = ? WHERE `id` = ?",
          [role, reason, penalty, refund, nowIso(), o.id]);
      }
      await notify(m, isParent ? Number(o.teacher_id) : Number(o.parent_id), "订单已取消",
        "订单 " + o.order_no + " 已取消" + (refund > 0 ? "，退款 ¥" + (refund / 100).toFixed(2) : "") + (reason ? "。原因：" + reason : ""),
        "order", "/order/" + o.id);
      await audit(m, { user: { uid: userId, role } }, "order.cancel", "orders:" + o.id, { refund, penalty, reason });
      return this.view((await m.query("SELECT * FROM `orders` WHERE `id` = ? LIMIT 1", [o.id]))[0], role === "teacher" ? "teacher" : "parent");
    });
  }

  /**
   * 教员端「退款」：同意家长的取消申请 —— 按当前时间重算退款（免费取消窗口内全额，否则扣违约金给教员），
   * 释放担保、写退款流水、订单转 refunded，并通知家长。
   * 只有「有取消申请 + 订单属于该教员 + 状态还是可取消」才放行，重复点击会 400。
   */
  async approveCancelRequest(teacherId: number, orderId: number, actorRole = "teacher") {
    return this.ds.transaction(async (m) => {
      const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [orderId]))[0];
      if (!o) throw notFound("订单不存在");
      if (Number(o.teacher_id) !== teacherId && actorRole !== "admin") throw forbidden("只能处理自己订单的取消申请");
      if (!o.cancel_requested_at) throw biz("NO_CANCEL_REQUEST", "该订单没有待处理的取消申请");
      if (["completed", "settled", "cancelled", "refunded"].includes(o.status)) throw biz("BAD_STATUS", "当前订单状态不可退款");

      const settlement = (await this.rules.get("settlement")) as any;
      const credit = (await this.rules.get("credit_rules")) as any;
      const paid = Number(o.amount) + Number(o.urgent_fee);
      const freeHours = Number(settlement.free_cancel_hours ?? 4);
      const deadline = new Date(new Date(o.lesson_time).getTime() - freeHours * 3600000).getTime();
      let refund = paid;
      let penalty = 0;
      if (Date.now() > deadline) {
        penalty = applyRate(paid, Number(settlement.cancel_penalty_rate ?? 0.2));
        refund = paid - penalty;
        await this.applyCredit(m, Number(o.parent_id), Number(credit.cancel_within_4h ?? -8), "课前 " + freeHours + " 小时内取消订单", Number(o.id));
        await m.query("UPDATE `parent_profiles` SET `cancel_count` = `cancel_count` + 1 WHERE `user_id` = ?", [o.parent_id]);
      }
      await escrowMove(m, Number(o.id), "out", refund, "订单退款 " + o.order_no);
      if (penalty > 0) {
        await walletAdd(m, Number(o.teacher_id), penalty, { orderId: Number(o.id), type: "compensation", remark: "家长临时取消违约金补偿（订单 " + o.order_no + "）" });
      }
      await m.query("INSERT INTO `payments` (`order_id`,`user_id`,`type`,`amount`,`channel`,`trade_no`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?)",
        [o.id, o.parent_id, "refund", refund, "wechat_jsapi", tradeNo("RF"), "success", nowIso()]);
      await m.query(
        "UPDATE `orders` SET `status` = 'refunded', `cancel_by` = 'parent', `penalty` = ?, `refund_amount` = ?, `cancel_requested_at` = NULL, `updated_at` = ? WHERE `id` = ?",
        [penalty, refund, nowIso(), o.id],
      );
      await notify(m, Number(o.parent_id), "取消申请已同意，退款已原路退回",
        "订单 " + o.order_no + " 教员已同意取消，退款 ¥" + (refund / 100).toFixed(2) + (penalty > 0 ? "（扣除违约金 ¥" + (penalty / 100).toFixed(2) + "）" : "（全额）"),
        "payment", "/order/" + o.id);
      await audit(m, { user: { uid: teacherId, role: actorRole } }, "order.cancelApprove", "orders:" + o.id, { refund, penalty });
      return this.view((await m.query("SELECT * FROM `orders` WHERE `id` = ? LIMIT 1", [o.id]))[0], "teacher");
    });
  }

  /**
   * 教员端「驳回」：不同意取消 —— 订单保持原状态，只清掉申请并记录驳回理由，
   * 家长端会看到「教员已驳回 + 理由」，可以再申请或走客服。
   */
  async rejectCancelRequest(teacherId: number, orderId: number, reason: string, actorRole = "teacher") {
    const why = String(reason || "").trim();
    if (why.length < 2) throw bad("请填写驳回理由（至少 2 个字）");
    return this.ds.transaction(async (m) => {
      const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [orderId]))[0];
      if (!o) throw notFound("订单不存在");
      if (Number(o.teacher_id) !== teacherId && actorRole !== "admin") throw forbidden("只能处理自己订单的取消申请");
      if (!o.cancel_requested_at) throw biz("NO_CANCEL_REQUEST", "该订单没有待处理的取消申请");
      if (["completed", "settled", "cancelled", "refunded"].includes(o.status)) throw biz("BAD_STATUS", "当前订单状态不可驳回取消");
      await m.query(
        "UPDATE `orders` SET `cancel_requested_at` = NULL, `cancel_rejected_at` = ?, `cancel_reject_reason` = ?, `updated_at` = ? WHERE `id` = ?",
        [nowIso(), why, nowIso(), o.id],
      );
      await notify(m, Number(o.parent_id), "教员驳回了你的取消申请",
        "订单 " + o.order_no + " 教员不同意取消，理由：" + why + "。如仍有异议可联系客服申请仲裁",
        "order", "/order/" + o.id);
      await audit(m, { user: { uid: teacherId, role: actorRole } }, "order.cancelReject", "orders:" + o.id, { reason: why });
      return this.view((await m.query("SELECT * FROM `orders` WHERE `id` = ? LIMIT 1", [o.id]))[0], "teacher");
    });
  }

  /**
   * 定时任务：取消申请超时自动同意（规则 `settlement.cancel_auto_approve_minutes`，默认 120 分钟）。
   * 为什么必须有：教员不处理时家长的钱不能一直押在担保账户里。
   */
  async autoApproveCancelRequests() {
    const settlement = (await this.rules.get("settlement")) as any;
    const mins = Math.max(1, Number(settlement.cancel_auto_approve_minutes ?? 120));
    const cutoff = new Date(Date.now() - mins * 60000).toISOString();
    const rows = await this.ds.query(
      "SELECT `id`, `teacher_id` FROM `orders` WHERE `cancel_requested_at` IS NOT NULL AND `cancel_requested_at` <= ? AND `status` IN ('pending_class','awaiting_parent_confirm') LIMIT 50",
      [cutoff],
    );
    let done = 0;
    for (const r of rows) {
      try {
        await this.approveCancelRequest(Number(r.teacher_id), Number(r.id), "system");
        done++;
      } catch {
        /* 单个失败不影响其它订单；下一轮会再试 */
      }
    }
    return { approved: done, scanned: rows.length, minutes: mins };
  }

  /**
   * 渠道退款（A2）：把「平台批准退款」接到真实渠道。
   * - mock 通道返回合成结果（本地/自动化不联网）
   * - 真实通道用固定 `out_refund_no = RF + 订单号`，渠道对同一退款单号幂等，便于安全重试
   * - 返回值里的 status 决定我方是否落 `refunded`：只有 SUCCESS 才算钱真的回去了
   */
  async refundViaChannel(orderNo: string, refundCents: number, totalCents: number, reason: string) {
    const provider = getPayProvider();
    if (provider.name === "mock") {
      return { refundId: "mock_refund_" + orderNo, status: "SUCCESS", channel: "wechat_jsapi" };
    }
    try {
      const r = await provider.refund({
        outTradeNo: String(orderNo),
        outRefundNo: "RF" + String(orderNo),
        refundCents: Number(refundCents),
        totalCents: Number(totalCents),
        reason: String(reason || "平台批准退款").slice(0, 80),
      });
      return { refundId: r.refundId || "REFUND:" + orderNo, status: r.status || "PROCESSING", channel: provider.name };
    } catch (e: any) {
      // 渠道错误细节只进日志，前端只看到「稍后重试」，避免泄露商户配置
      console.error("[pay] 渠道退款失败：" + String(orderNo) + " " + (e?.message || e));
      throw biz("REFUND_CHANNEL_ERROR", "退款渠道暂时不可用，订单保持退款中，请稍后重试");
    }
  }

  async applyRefund(parentId: number, orderId: number, reason: string) {
    if (!reason) throw bad("请填写退款原因");
    const id = await this.ds.transaction(async (m) => {
      const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? FOR UPDATE", [orderId]))[0];
      if (!o) throw notFound("订单不存在");
      if (Number(o.parent_id) !== parentId) throw forbidden();
      if (!["pending_class", "awaiting_parent_confirm"].includes(o.status)) throw biz("BAD_STATUS", "当前状态不支持申请退款");
      // 条件更新兜底：避免与「家长确认完成」并发时把已 completed 的订单改回 refunding
      const upd = await m.query(
        "UPDATE `orders` SET `status` = 'refunding', `cancel_reason` = ?, `updated_at` = ? WHERE `id` = ? AND `status` IN ('pending_class','awaiting_parent_confirm')",
        [reason, nowIso(), o.id],
      );
      if (!Number(upd?.affectedRows ?? 1)) throw biz("BAD_STATUS", "当前状态不支持申请退款");
      await m.query(
        "INSERT INTO `complaints` (`order_id`,`from_user`,`from_role`,`against_user`,`region_id`,`type`,`title`,`content`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [o.id, parentId, "parent", o.teacher_id, o.region_id, "complaint", "退款申请：订单 " + o.order_no, reason, "open", nowIso()],
      );
      await audit(m, { user: { uid: parentId, role: "parent" } }, "order.refundApply", "orders:" + o.id, { reason });
      return Number(o.id);
    });
    return this.view(await this.get(id), "parent");
  }

  /* ---------------- 紧急求助（需求第 8 章 上门安全）---------------- */
  async raiseSos(userId: number, role: string, orderId: number, b: any = {}) {
    const o = await this.get(orderId);
    if (!o) throw notFound("订单不存在");
    const isParent = Number(o.parent_id) === userId;
    const isTeacher = Number(o.teacher_id) === userId;
    if (!isParent && !isTeacher) throw forbidden("仅订单双方可发起紧急求助");
    if (["cancelled", "refunded"].includes(o.status)) throw biz("BAD_STATUS", "该订单已结束，如需帮助请通过客服工单");

    // 同一订单 10 分钟内不重复建单，避免误触刷屏
    const recent = (await this.ds.query(
      "SELECT `id`,`created_at` FROM `risk_events` WHERE `order_id` = ? AND `type` = 'sos' ORDER BY `id` DESC LIMIT 1", [o.id],
    ))[0];
    if (recent && Date.now() - new Date(recent.created_at).getTime() < 10 * 60000) {
      return { sosId: Number(recent.id), duplicated: true, notified: 0 };
    }
    const { lat = null, lng = null, note = "" } = b || {};
    const distance = lat != null && lng != null
      ? Math.round(haversineKm(Number(lat), Number(lng), Number(o.lat), Number(o.lng)) * 1000)
      : null;
    const where = lat != null ? "（求助定位距上课地址 " + distance + " 米）" : "";
    const reason = (isParent ? "家长" : "教员") + "在订单 " + o.order_no + " 发起紧急求助" + where + (note ? "：" + note : "");

    return this.ds.transaction(async (m) => {
      const r = await m.query(
        "INSERT INTO `risk_events` (`order_id`,`user_id`,`region_id`,`type`,`level`,`reason`,`status`,`settlement_hold`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?)",
        [o.id, userId, o.region_id, "sos", "high", reason, "open", 0, nowIso()],
      );
      let notified = 0;
      for (const a of await m.query("SELECT `id` FROM `users` WHERE `role` = 'admin'")) {
        await notify(m, Number(a.id), "🚨 紧急求助", reason + "。请立即联系当事人核实处置。", "risk", "/admin#/risk");
        notified++;
      }
      if (o.agent_id) {
        await notify(m, Number(o.agent_id), "🚨 片区紧急求助", reason + "。请立即联系当事人核实处置。", "risk", "/agent#/risk");
        notified++;
      }
      await notify(m, isParent ? Number(o.teacher_id) : Number(o.parent_id), "订单内已发起紧急求助",
        "该订单已提交紧急求助，平台客服将尽快介入。如为误触可忽略。", "risk", "/order/" + o.id);
      notified++;
      await audit(m, { user: { uid: userId, role } }, "order.sos", "orders:" + o.id, { role, distance, note });
      return { sosId: Number(r.insertId), duplicated: false, notified, distance, level: "high" };
    });
  }

  /* ---------------- 评价 ---------------- */
  async submitReview(parentId: number, orderId: number, b: any) {
    return this.ds.transaction(async (m) => {
      const o = (await m.query("SELECT * FROM `orders` WHERE `id` = ? LIMIT 1", [orderId]))[0];
      if (!o) throw notFound("订单不存在");
      if (Number(o.parent_id) !== parentId) throw forbidden();
      if (!["completed", "settled"].includes(o.status)) throw biz("BAD_STATUS", "订单完成后才可评价");
      if ((await m.query("SELECT `id` FROM `reviews` WHERE `order_id` = ?", [o.id])).length) throw biz("ALREADY_REVIEWED", "该订单已评价");
      const score = Number(b.score);
      if (!(score >= 1 && score <= 5)) throw bad("评分需为 1-5 星");

      const cfg = (await this.rules.get("review_scoring")) as any;
      const windowHours = Number(cfg.window_hours ?? 72);
      const base = o.finished_at || o.confirm_at || o.updated_at;
      if (base && Date.now() - new Date(base).getTime() > windowHours * 3600000) {
        throw biz("REVIEW_EXPIRED", "评价时效已过（" + windowHours + " 小时）");
      }

      const pp = (await m.query("SELECT `credit_level` FROM `parent_profiles` WHERE `user_id` = ?", [parentId]))[0];
      const levels = (await this.rules.get("parent_credit")) as any[];
      const weight = Number((levels.find((l) => l.level === (pp?.credit_level || "L0")) || levels[0]).weight);

      const r = await m.query(
        "INSERT INTO `reviews` (`order_id`,`parent_id`,`teacher_id`,`score`,`content`,`tags`,`weight`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?)",
        [o.id, parentId, o.teacher_id, score, b.content || "", JSON.stringify(b.tags || []), weight, "public", nowIso()],
      );
      // 教员成长分：好评 +base×权重，差评 -base×权重
      let delta = 0;
      if (score >= Number(cfg.good_threshold ?? 4)) delta = Math.round(Number(cfg.good_base ?? 5) * weight);
      else if (score <= Number(cfg.bad_threshold ?? 2)) delta = -Math.round(Number(cfg.bad_base ?? 5) * weight);
      if (delta !== 0) {
        await this.applyGrowth(m, Number(o.teacher_id), delta,
          (delta > 0 ? "收到" + score + "星好评" : "收到" + score + "星差评") + "（家长权重 " + weight + "）", Number(o.id));
      }
      // 重新计算评分均值（按评价权重加权）
      const rows = await m.query("SELECT `score`,`weight` FROM `reviews` WHERE `teacher_id` = ? AND `status` = 'public'", [o.teacher_id]);
      const totalW = rows.reduce((a: number, x: any) => a + Number(x.weight), 0) || 1;
      const avg = rows.reduce((a: number, x: any) => a + Number(x.score) * Number(x.weight), 0) / totalW;
      await m.query("UPDATE `teacher_profiles` SET `rating_avg` = ?, `rating_count` = ?, `updated_at` = ? WHERE `user_id` = ?",
        [Number(avg.toFixed(2)), rows.length, nowIso(), o.teacher_id]);
      const credit = (await this.rules.get("credit_rules")) as any;
      await this.applyCredit(m, parentId, Number(credit.review_given ?? 2), "主动评价", Number(o.id));
      await notify(m, Number(o.teacher_id), "收到新评价", score + " 星评价：" + (b.content || "无文字内容"), "order", "/teacher/reviews");
      await audit(m, { user: { uid: parentId, role: "parent" } }, "review.create", "reviews:" + r.insertId, { score, weight });
      const fresh = (await m.query("SELECT * FROM `reviews` WHERE `id` = ?", [r.insertId]))[0];
      return { ...fresh, id: Number(fresh.id), tags: fresh.tags ? JSON.parse(fresh.tags) : [] };
    });
  }

  /* ---------------- 列表 ---------------- */
  async listBy(userId: number, side: "parent" | "teacher", status?: string) {
    const col = side === "parent" ? "parent_id" : "teacher_id";
    const groups: Record<string, string> = {
      awaiting: "('awaiting_payment')",
      pending: "('pending_class','in_class','awaiting_parent_confirm')",
      completed: "('completed','settled')",
      cancelled: "('cancelled','refunding','refunded')",
    };
    let where = "`" + col + "` = ?";
    const params: any[] = [userId];
    if (status && groups[status]) where += " AND `status` IN " + groups[status];
    else if (status) { where += " AND `status` = ?"; params.push(status); }
    const rows = await this.ds.query("SELECT * FROM `orders` WHERE " + where + " ORDER BY `id` DESC", params);
    const list = [];
    for (const o of rows) list.push(await this.view(o, side));
    return { list, total: list.length };
  }

  /** 订单详情：含支付/退款流水，按角色限定数据范围（需求 2.2） */
  async detail(user: any, orderId: number) {
    const o = await this.get(orderId);
    if (!o) throw notFound("订单不存在");
    const uid = Number(user.uid);
    let allowed = Number(o.parent_id) === uid || Number(o.teacher_id) === uid || user.role === "admin";
    if (!allowed && user.role === "agent") {
      const ap = (await this.ds.query("SELECT `region_id` FROM `agent_profiles` WHERE `user_id` = ?", [uid]))[0];
      allowed = !!ap && Number(ap.region_id) === Number(o.region_id);
    }
    if (!allowed && user.role === "sales") {
      const bound = (await this.ds.query("SELECT `id` FROM `bindings` WHERE `user_id` = ? AND `sales_id` = ?", [o.parent_id, uid]))[0];
      allowed = !!bound || Number(o.sales_id) === uid;
    }
    if (!allowed) throw forbidden("无权查看该订单");
    const v: any = await this.view(o, user.role === "teacher" ? "teacher" : "parent", user.role === "agent" || user.role === "sales");
    v.refundRecords = await this.ds.query("SELECT * FROM `payments` WHERE `order_id` = ? AND `type` = 'refund'", [o.id]);
    v.payments = await this.ds.query("SELECT * FROM `payments` WHERE `order_id` = ? ORDER BY `id`", [o.id]);
    v.escrowBalance = await escrowBalance(this.ds);
    return v;
  }

  /* ---------------- 财务总览（后台，需求 5.4 可对账）---------------- */
  async financeSummary() {
    const q = async (sql: string, p: any[] = []) => Number((await this.ds.query(sql, p))[0]?.s ?? 0);
    const totalGmv = await q("SELECT COALESCE(SUM(`amount`),0) AS s FROM `orders` WHERE `paid_at` IS NOT NULL");
    const serviceFee = await q("SELECT COALESCE(SUM(`service_fee`),0) AS s FROM `orders` WHERE `status` IN ('completed','settled')");
    const agentShare = await q("SELECT COALESCE(SUM(`agent_share`),0) AS s FROM `orders` WHERE `status` IN ('completed','settled')");
    const salesCommission = await q("SELECT COALESCE(SUM(`sales_commission`),0) AS s FROM `orders` WHERE `status` IN ('completed','settled')");
    const revenue = await q("SELECT COALESCE(SUM(`platform_revenue`),0) AS s FROM `orders` WHERE `status` IN ('completed','settled')");
    const pendingSettle = await q("SELECT COALESCE(SUM(`teacher_income`),0) AS s FROM `orders` WHERE `status` = 'completed'");
    return {
      summary: {
        totalGmv, serviceFee, agentShare, salesCommission, revenue,
        escrow: await escrowBalance(this.ds), pendingSettle,
        totalWallet: await q("SELECT COALESCE(SUM(`balance`),0) AS s FROM `wallets`"),
        totalFrozen: await q("SELECT COALESCE(SUM(`frozen`),0) AS s FROM `wallets`"),
        withdrawPending: await q("SELECT COALESCE(SUM(`amount`),0) AS s FROM `withdrawals` WHERE `status` = 'pending'"),
        invoicePending: Number((await this.ds.query("SELECT COUNT(*) AS c FROM `invoices` WHERE `status` = 'pending'"))[0]?.c ?? 0),
        invoiceIssued: Number((await this.ds.query("SELECT COUNT(*) AS c FROM `invoices` WHERE `status` = 'issued'"))[0]?.c ?? 0),
      },
      withdrawals: await this.ds.query(
        "SELECT w.*, u.`nickname`, u.`role` FROM `withdrawals` w JOIN `users` u ON u.id = w.user_id ORDER BY w.`status` = 'pending' DESC, w.`id` DESC LIMIT 100",
      ),
      rewards: await this.ds.query("SELECT r.*, u.`nickname` FROM `rewards` r JOIN `users` u ON u.id = r.sales_id ORDER BY r.`status` = 'pending' DESC, r.`id` DESC LIMIT 100"),
      invoices: await this.ds.query(
        `SELECT i.*, u.\`nickname\`, u.\`phone\`, o.\`order_no\`, o.\`subject\`, o.\`stage\` FROM \`invoices\` i
         LEFT JOIN \`users\` u ON u.id = i.user_id LEFT JOIN \`orders\` o ON o.id = i.order_id
         ORDER BY i.\`status\` = 'pending' DESC, i.\`id\` DESC LIMIT 100`,
      ),
      escrowLedger: await this.ds.query("SELECT * FROM `escrow_ledger` ORDER BY `id` DESC LIMIT 60"),
      payments: await this.ds.query("SELECT p.*, o.`order_no` FROM `payments` p LEFT JOIN `orders` o ON o.id = p.order_id ORDER BY p.`id` DESC LIMIT 60"),
      reconciliation: { gmvFormula: totalGmv, splitFormula: serviceFee, platformRevenue: revenue, agentShare, salesCommission },
    };
  }

  /* ---------------- 上课前提醒（需求 4.1.5：开课前 1 小时推送）---------------- */
  async runLessonReminders() {
    const cfg = (await this.rules.get("notify")) as any;
    if (cfg?.enabled === false) return 0;
    const minutes = Number(cfg?.lesson_remind_minutes ?? 60);
    const now = new Date();
    const horizon = new Date(now.getTime() + minutes * 60000).toISOString();
    const due = await this.ds.query(
      "SELECT * FROM `orders` WHERE `status` = 'pending_class' AND `remind_sent` = 0 AND `lesson_time` > ? AND `lesson_time` <= ?",
      [now.toISOString(), horizon],
    );
    let n = 0;
    for (const o of due) {
      // 抢占式置位：多实例 / 重复触发下只推送一次
      const r = await this.ds.query("UPDATE `orders` SET `remind_sent` = 1 WHERE `id` = ? AND `remind_sent` = 0", [o.id]);
      if (!r.affectedRows) continue;
      n++;
      const when = new Date(o.lesson_time).toLocaleString("zh-CN", { hour12: false });
      await notify(this.ds, Number(o.parent_id), "上课提醒",
        "您预约的课程将在 " + minutes + " 分钟后开始（" + o.subject + " · " + o.stage + "，" + when + "），地址：" + o.address,
        "order", "/order/" + o.id);
      await notify(this.ds, Number(o.teacher_id), "上课提醒",
        "您有一节课将在 " + minutes + " 分钟后开始（" + o.subject + " · " + o.stage + "，" + when + "），请提前出发并在到达后完成定位打卡",
        "order", "/order/" + o.id);
    }
    return n;
  }
}
