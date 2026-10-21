// 业务员推广端：推广码、业绩看板、客户管理、奖励明细、提现
import { all, get, run } from "../core/db.js";
import { Err, ok } from "../core/http.js";
import { nowIso, randomCode } from "../core/ids.js";
import { audit } from "../core/audit.js";
import { rule } from "../core/config.js";
import { maskPhone } from "../core/geo.js";
import { walletSnapshot } from "../core/ledger.js";

function salesOf(userId) {
  const s = get("SELECT * FROM sales_profiles WHERE user_id = ?", userId);
  if (!s) throw Err.notFound("业务员档案不存在");
  return s;
}

function ensureCode(salesId, target) {
  let c = get("SELECT * FROM promotion_codes WHERE sales_id = ? AND target = ?", salesId, target);
  if (!c) {
    const sp = salesOf(salesId);
    run(
      "INSERT INTO promotion_codes (sales_id, target, token, scans, registrations, created_at) VALUES (?,?,?,?,?,?)",
      salesId, target, sp.code + target.slice(0, 1).toUpperCase() + randomCode(4), 0, 0, nowIso()
    );
    c = get("SELECT * FROM promotion_codes WHERE sales_id = ? AND target = ?", salesId, target);
  }
  return c;
}

function rangeStart(kind) {
  const d = new Date();
  if (kind === "today") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  if (kind === "week") {
    const day = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).toISOString();
  }
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

export function register(router) {
  // 扫码（公开）
  router.post("/api/public/promo/:token/scan", (ctx) => {
    const c = get("SELECT * FROM promotion_codes WHERE token = ?", ctx.params.token);
    if (!c) throw Err.notFound("推广码无效");
    run("UPDATE promotion_codes SET scans = scans + 1 WHERE id = ?", c.id);
    ok(ctx.res, { salesId: c.sales_id, target: c.target });
  }, { auth: false });

  router.get("/api/sales/dashboard", (ctx) => {
    const s = salesOf(ctx.user.id);
    const statsOf = (from) => {
      const reg = get("SELECT COUNT(*) AS c FROM bindings WHERE sales_id = ? AND bound_at >= ?", ctx.user.id, from).c;
      const lead = get(
        "SELECT COUNT(*) AS c FROM bindings b WHERE b.sales_id = ? AND b.bound_at >= ? AND EXISTS (SELECT 1 FROM demands d WHERE d.parent_id = b.user_id)",
        ctx.user.id, from
      ).c;
      const deals = get(
        "SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS gmv FROM orders WHERE sales_id = ? AND paid_at IS NOT NULL AND paid_at >= ?",
        ctx.user.id, from
      );
      return { registrations: reg, leads: lead, deals: deals.c, gmv: deals.gmv };
    };
    const settled = get("SELECT COALESCE(SUM(amount),0) AS s FROM rewards WHERE sales_id = ? AND status = 'settled'", ctx.user.id).s;
    const pending = get("SELECT COALESCE(SUM(amount),0) AS s FROM rewards WHERE sales_id = ? AND status = 'pending'", ctx.user.id).s;

    // 7 天趋势：两张表各一次 GROUP BY
    const since7 = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const gmvRows = all(
      "SELECT substr(paid_at,1,10) AS d, COALESCE(SUM(amount),0) AS s FROM orders WHERE sales_id = ? AND paid_at >= ? GROUP BY d",
      ctx.user.id, since7
    );
    const regRows = all(
      "SELECT substr(bound_at,1,10) AS d, COUNT(*) AS c FROM bindings WHERE sales_id = ? AND bound_at >= ? GROUP BY d",
      ctx.user.id, since7
    );
    const gmvMap = new Map(gmvRows.map((r) => [r.d, r.s]));
    const regMap = new Map(regRows.map((r) => [r.d, r.c]));
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      trend.push({ date: key, gmv: gmvMap.get(key) || 0, registrations: regMap.get(key) || 0 });
    }

    const agent = get("SELECT ap.*, r.name AS regionName FROM agent_profiles ap LEFT JOIN regions r ON r.id = ap.region_id WHERE ap.user_id = ?", s.agent_id);
    ok(ctx.res, {
      sales: { ...s, phone: maskPhone(ctx.user.phone) },
      agent: agent ? { name: get("SELECT nickname FROM users WHERE id = ?", s.agent_id)?.nickname, regionName: agent.regionName } : null,
      today: statsOf(rangeStart("today")),
      week: statsOf(rangeStart("week")),
      month: statsOf(rangeStart("month")),
      rewards: { pending, settled, wallet: walletSnapshot(ctx.user.id) },
      trend,
      rewardRules: rule("sales_rewards"),
      codes: [ensureCode(ctx.user.id, "parent"), ensureCode(ctx.user.id, "teacher")],
    });
  }, { roles: ["sales"] });

  router.get("/api/sales/customers", (ctx) => {
    const rows = all(
      `SELECT b.*, u.nickname, u.avatar, u.role, u.phone, u.created_at AS regAt,
        (SELECT COUNT(*) FROM demands d WHERE d.parent_id = u.id) AS demandCount,
        (SELECT COUNT(*) FROM orders o WHERE o.parent_id = u.id AND o.paid_at IS NOT NULL) AS dealCount
       FROM bindings b JOIN users u ON u.id = b.user_id WHERE b.sales_id = ? ORDER BY b.id DESC`,
      ctx.user.id
    );
    const list = rows.map((r) => ({
      id: r.user_id,
      nickname: r.nickname,
      avatar: r.avatar,
      role: r.role,
      phone: maskPhone(r.phone),          // 禁止查看完整手机号
      source: r.source,
      boundAt: r.bound_at,
      status: r.dealCount > 0 ? "已成交" : r.demandCount > 0 ? "已发需求" : "已注册",
      demandCount: r.demandCount,
      dealCount: r.dealCount,
    }));
    const summary = {
      total: list.length,
      registered: list.filter((x) => x.status === "已注册").length,
      demanded: list.filter((x) => x.status === "已发需求").length,
      dealt: list.filter((x) => x.status === "已成交").length,
    };
    ok(ctx.res, { list, summary });
  }, { roles: ["sales"] });

  router.get("/api/sales/rewards", (ctx) => {
    const type = ctx.query.type;
    const list = type
      ? all("SELECT r.*, o.order_no FROM rewards r LEFT JOIN orders o ON o.id = r.ref_order_id WHERE r.sales_id = ? AND r.type = ? ORDER BY r.id DESC LIMIT 200", ctx.user.id, type)
      : all("SELECT r.*, o.order_no FROM rewards r LEFT JOIN orders o ON o.id = r.ref_order_id WHERE r.sales_id = ? ORDER BY r.id DESC LIMIT 200", ctx.user.id);
    const byType = all("SELECT type, COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM rewards WHERE sales_id = ? GROUP BY type", ctx.user.id);
    ok(ctx.res, {
      list,
      byType,
      types: [
        { value: "register", label: "注册奖" },
        { value: "lead", label: "留资奖" },
        { value: "deal", label: "成交提成" },
        { value: "daily_champ", label: "日冠军奖" },
        { value: "weekly_champ", label: "周冠军奖" },
        { value: "newbie_first", label: "新人首单奖" },
      ],
      rules: rule("sales_rewards"),
      wallet: walletSnapshot(ctx.user.id),
    });
  }, { roles: ["sales"] });

  router.get("/api/sales/profile", (ctx) => {
    const s = salesOf(ctx.user.id);
    const region = get("SELECT * FROM regions WHERE id = ?", s.region_id);
    ok(ctx.res, {
      sales: { ...s, phone: maskPhone(ctx.user.phone), name: ctx.user.nickname },
      region: region ? { id: region.id, name: region.name } : null,
      codes: [ensureCode(ctx.user.id, "parent"), ensureCode(ctx.user.id, "teacher")],
      wallet: walletSnapshot(ctx.user.id),
    });
  }, { roles: ["sales"] });
}