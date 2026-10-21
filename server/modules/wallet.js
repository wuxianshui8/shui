// 钱包与提现（教员 / 业务员 / 代理 共用）
import { all, get, run, tx } from "../core/db.js";
import { Err, ok } from "../core/http.js";
import { invoiceNo, nowIso } from "../core/ids.js";
import { audit, notify } from "../core/audit.js";
import { rule } from "../core/config.js";
import { applyRate } from "../core/money.js";
import { walletAdd, walletSnapshot } from "../core/ledger.js";
import { maskPhone } from "../core/geo.js";

export function register(router) {
  router.get("/api/wallet", (ctx) => {
    ok(ctx.res, {
      wallet: walletSnapshot(ctx.user.id),
      rule: rule("settlement"),
      txns: all(
        "SELECT t.*, o.order_no FROM wallet_txns t LEFT JOIN orders o ON o.id = t.order_id WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 50",
        ctx.user.id
      ),
      // 发票：我的申请单 + 可开票订单（需求 4.1.6）
      invoices: all(
        `SELECT i.*, o.order_no, o.subject, o.stage FROM invoices i
         LEFT JOIN orders o ON o.id = i.order_id
         WHERE i.user_id = ? ORDER BY i.id DESC LIMIT 50`,
        ctx.user.id
      ),
      invoiceable: all(
        `SELECT o.id, o.order_no, o.subject, o.stage, o.lesson_time, o.status,
                (o.amount + o.urgent_fee) AS payable, o.paid_at
         FROM orders o
         WHERE o.parent_id = ? AND o.paid_at IS NOT NULL
           AND o.status NOT IN ('refunded', 'refunding', 'cancelled', 'awaiting_payment')
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id AND i.status <> 'rejected')
         ORDER BY o.id DESC LIMIT 50`,
        ctx.user.id
      ),
    });
  });

  /* ---------------- 发票申请（需求 4.1.6）---------------- */
  router.post("/api/invoices", (ctx) => {
    const orderId = Number(ctx.body.orderId);
    if (!orderId) throw Err.bad("请选择需要开票的订单");
    const order = get("SELECT * FROM orders WHERE id = ?", orderId);
    if (!order) throw Err.notFound("订单不存在");
    if (order.parent_id !== ctx.user.id) throw Err.forbidden("只能为本人订单申请开票");
    if (!order.paid_at) throw Err.biz("NOT_PAID", "该订单尚未支付，无法开票");
    if (["cancelled", "refunded", "refunding", "awaiting_payment"].includes(order.status)) {
      throw Err.biz("NOT_INVOICEABLE", "该订单状态不支持开票");
    }
    const exist = get("SELECT * FROM invoices WHERE order_id = ? AND status <> 'rejected'", order.id);
    if (exist) throw Err.biz("ALREADY_INVOICED", "该订单已提交过开票申请（" + exist.invoice_no + "），请勿重复提交");

    const titleType = ctx.body.titleType === "company" ? "company" : "personal";
    const title = String(ctx.body.title || "").trim();
    if (!title) throw Err.bad("请填写发票抬头");
    const taxNo = String(ctx.body.taxNo || "").trim();
    if (titleType === "company" && !/^[0-9A-Z]{15,20}$/.test(taxNo)) {
      throw Err.bad("企业抬头需填写 15-20 位纳税人识别号");
    }
    const email = String(ctx.body.email || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Err.bad("邮箱格式不正确");

    const amount = order.amount + order.urgent_fee;
    const r = run(
      `INSERT INTO invoices (invoice_no, order_id, user_id, title_type, title, tax_no, email, amount, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      invoiceNo(), order.id, ctx.user.id, titleType, title, titleType === "company" ? taxNo : null,
      email || null, amount, "pending", nowIso()
    );
    const admins = all("SELECT id FROM users WHERE role = 'admin'");
    for (const a of admins) {
      notify(a.id, "收到发票申请", "订单 " + order.order_no + " 申请开票 ¥" + (amount / 100).toFixed(2) + "（" + title + "）", "payment");
    }
    audit(ctx, "invoice.apply", "invoices:" + r.id, { orderId: order.id, amount });
    ok(ctx.res, get("SELECT * FROM invoices WHERE id = ?", r.id));
  }, { roles: ["parent"] });

  router.get("/api/wallet/txns", (ctx) => {
    const type = ctx.query.type;
    const list = type
      ? all("SELECT * FROM wallet_txns WHERE user_id = ? AND type = ? ORDER BY id DESC LIMIT 200", ctx.user.id, type)
      : all("SELECT * FROM wallet_txns WHERE user_id = ? ORDER BY id DESC LIMIT 200", ctx.user.id);
    ok(ctx.res, list);
  });

  router.get("/api/withdrawals", (ctx) => {
    ok(ctx.res, {
      list: all("SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50", ctx.user.id),
      wallet: walletSnapshot(ctx.user.id),
      rule: rule("settlement"),
    });
  });

  // 提现申请（幂等）
  router.post("/api/withdrawals", (ctx) => {
    const cfg = rule("settlement");
    const amount = Math.round(Number(ctx.body.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw Err.bad("请输入提现金额");
    if (amount < cfg.min_withdraw) throw Err.biz("BELOW_MIN", "最低提现金额 ¥" + (cfg.min_withdraw / 100).toFixed(2));
    const w = walletSnapshot(ctx.user.id);
    if (amount > w.balance) throw Err.biz("INSUFFICIENT_BALANCE", "可提现余额不足");
    if (!ctx.body.account) throw Err.bad("请填写收款账号");

    const fee = applyRate(amount, cfg.withdraw_fee_rate);
    const actual = amount - fee;

    return tx(() => {
      const r = run(
        "INSERT INTO withdrawals (user_id, role, amount, fee, actual, channel, account, status, idem_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ctx.user.id, ctx.user.role, amount, fee, actual,
        ctx.body.channel || "wechat", maskPhone(ctx.body.account), "pending",
        ctx.req.headers["x-idem-key"] || null, nowIso()
      );
      walletAdd(ctx.user.id, -amount, {
        type: "withdraw",
        remark: "提现申请 ¥" + (amount / 100).toFixed(2) + "（手续费 ¥" + (fee / 100).toFixed(2) + "）",
      });
      notify(ctx.user.id, "提现申请已提交", "提现 ¥" + (actual / 100).toFixed(2) + " 待平台审核打款", "payment", "/wallet");
      audit(ctx, "withdraw.apply", "withdrawals:" + r.id, { amount, fee });
      return ok(ctx.res, get("SELECT * FROM withdrawals WHERE id = ?", r.id));
    });
  }, { idem: true, roles: ["teacher", "sales", "agent"] });
}