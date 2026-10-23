// 认证 / 字典 / 公告 / 地址 / 消息 / 优惠券 / 协议
import { all, get, run, tx } from "../core/db.js";
import { ApiError, Err, ok } from "../core/http.js";
import { genSmsCode, hashPassword, loadUser, publicUser, signToken, verifyPassword } from "../core/auth.js";
import { nowIso } from "../core/ids.js";
import { audit, notify } from "../core/audit.js";
import { listRules } from "../core/config.js";
import { rule } from "../core/config.js";
import { resolveRegion } from "../core/rules.js";
import { maskPhone } from "../core/geo.js";

const smsCodes = new Map();

/* ---------------- 登录失败锁定（需求 7.2 防暴力破解）---------------- */
const loginFails = new Map(); // key(ip:phone) -> { count, until }

function loginGuard(ctx, phone) {
  const cfg = rule("risk") || {};
  const limit = cfg.login_fail_limit ?? 5;
  const lockMin = cfg.login_lock_minutes ?? 15;
  const key = (ctx.ip || "-") + ":" + String(phone || "-");
  const rec = loginFails.get(key);
  if (rec && rec.count >= limit && rec.until > Date.now()) {
    const mins = Math.max(1, Math.ceil((rec.until - Date.now()) / 60000));
    throw new ApiError("LOGIN_LOCKED", "登录失败次数过多，请 " + mins + " 分钟后再试", 429);
  }
  return { key, limit, lockMin };
}

function loginFail(guard) {
  if (!guard) return;
  const rec = loginFails.get(guard.key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= guard.limit) rec.until = Date.now() + guard.lockMin * 60000;
  loginFails.set(guard.key, rec);
  if (loginFails.size > 5000) {
    const now = Date.now();
    for (const [k, v] of loginFails) if (v.until && v.until < now) loginFails.delete(k);
  }
}

function loginPass(guard) {
  if (guard) loginFails.delete(guard.key);
}

export const DICTIONARY = {
  stages: ["小学", "初中", "高中", "成人", "兴趣类"],
  subjects: ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理", "美术", "钢琴", "吉他", "小提琴", "编程", "书法", "围棋"],
  identityTypes: [
    { value: "student", label: "在校大学生" },
    { value: "in_service", label: "在职教师" },
    { value: "part_time", label: "社会兼职教员" },
  ],
  orderStatus: [
    { value: "awaiting_payment", label: "待付款" },
    { value: "pending_class", label: "待上课" },
    { value: "in_class", label: "进行中" },
    { value: "awaiting_parent_confirm", label: "待确认完成" },
    { value: "completed", label: "已完成" },
    { value: "settled", label: "已结算" },
    { value: "cancelled", label: "已取消" },
    { value: "refunding", label: "退款中" },
    { value: "refunded", label: "已退款" },
  ],
  rewardTypes: [
    { value: "register", label: "注册奖" },
    { value: "lead", label: "留资奖" },
    { value: "deal", label: "成交提成" },
    { value: "daily_champ", label: "日冠军奖" },
    { value: "weekly_champ", label: "周冠军奖" },
    { value: "newbie_first", label: "新人首单奖" },
  ],
};

/**
 * 反作弊：设备指纹 / IP 频次限制，拦截批量注册（需求第 8 章）
 * 命中阈值时写入风控事件并拒绝本次注册
 */
function guardRegistration(ctx) {
  const cfg = rule("risk");
  const deviceFp = (ctx.body && ctx.body.deviceFp) || ctx.req.headers["x-device-fp"] || null;
  const now = Date.now();
  const since24 = new Date(now - 86400000).toISOString();
  const sinceHour = new Date(now - 3600000).toISOString();

  if (deviceFp) {
    const used = get("SELECT COUNT(*) AS c FROM users WHERE device_fp = ? AND created_at >= ?", deviceFp, since24).c;
    const limit = cfg.register_per_device_day ?? 2;
    if (used >= limit) {
      run(
        "INSERT INTO risk_events (order_id, user_id, region_id, type, level, reason, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
        null, null, null, "brush", "high",
        "同一设备（" + String(deviceFp).slice(0, 10) + "）24 小时内已注册 " + used + " 个账号，本次注册被拦截",
        "open", nowIso()
      );
      throw Err.biz("FREQUENT_REGISTER", "该设备注册过于频繁，已被风控拦截，请联系平台客服");
    }
  }

  const ipUsed = get("SELECT COUNT(*) AS c FROM users WHERE reg_ip = ? AND created_at >= ?", ctx.ip || "", sinceHour).c;
  const ipLimit = cfg.register_per_ip_hour ?? 20;
  if (ipUsed >= ipLimit) {
    run(
      "INSERT INTO risk_events (order_id, user_id, region_id, type, level, reason, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
      null, null, null, "brush", "high",
      "同一 IP（" + (ctx.ip || "-") + "）1 小时内已注册 " + ipUsed + " 个账号，本次注册被拦截",
      "open", nowIso()
    );
    throw Err.biz("FREQUENT_REGISTER", "当前网络注册过于频繁，请稍后再试");
  }
  return { deviceFp, ip: ctx.ip || "" };
}

function bindUser(userId, inviteToken) {
  if (!inviteToken) return null;
  const pc = get("SELECT * FROM promotion_codes WHERE token = ?", inviteToken);
  if (!pc) return null;
  const sales = get("SELECT * FROM sales_profiles WHERE user_id = ?", pc.sales_id);
  if (!sales || sales.status !== "active") return null;
  const exist = get("SELECT * FROM bindings WHERE user_id = ?", userId);
  if (exist) return exist;
  run(
    "INSERT INTO bindings (user_id, sales_id, agent_id, region_id, source, bound_at) VALUES (?,?,?,?,?,?)",
    userId,
    sales.user_id,
    sales.agent_id,
    sales.region_id,
    "scan",
    nowIso()
  );
  run("UPDATE promotion_codes SET registrations = registrations + 1 WHERE id = ?", pc.id);
  run("UPDATE users SET region_id = ? WHERE id = ? AND region_id IS NULL", sales.region_id, userId);
  const cfg = rule("sales_rewards");
  run(
    "INSERT INTO rewards (sales_id, type, amount, ref_user_id, status, calc_note, created_at) VALUES (?,?,?,?,?,?,?)",
    sales.user_id,
    "register",
    cfg.register,
    userId,
    "pending",
    "扫码新注册奖励 ¥" + (cfg.register / 100).toFixed(2),
    nowIso()
  );
  return get("SELECT * FROM bindings WHERE user_id = ?", userId);
}

export function findRegionFor(lat, lng) {
  return resolveRegion(lat, lng);
}

export function register(router) {
  /* ---------------- 认证 ---------------- */
  router.post("/api/auth/send-code", (ctx) => {
    const phone = String(ctx.body.phone || "").trim();
    if (!/^1\d{10}$/.test(phone)) throw Err.bad("请输入正确的手机号");
    const code = genSmsCode();
    smsCodes.set(phone, { code, exp: Date.now() + 5 * 60 * 1000 });
    ok(ctx.res, { phone: maskPhone(phone), devCode: code, ttl: 300 });
  }, { auth: false });

  router.post("/api/auth/login", (ctx) => {
    const phone = String(ctx.body.phone || "").trim();
    const code = String(ctx.body.code || "").trim();
    if (!/^1\d{10}$/.test(phone)) throw Err.bad("请输入正确的手机号");
    const guard = loginGuard(ctx, phone);
    const rec = smsCodes.get(phone);
    if (!rec || rec.code !== code) {
      loginFail(guard);
      throw Err.biz("BAD_CODE", "验证码错误或已过期");
    }
    if (rec.exp < Date.now()) throw Err.biz("CODE_EXPIRED", "验证码已过期");
    smsCodes.delete(phone);
    loginPass(guard);

    let user = get("SELECT * FROM users WHERE phone = ?", phone);
    if (!user) {
      const guard = guardRegistration(ctx);
      const region = resolveRegion(30.2741, 120.1551);
      const r = run(
        "INSERT INTO users (phone, nickname, role, status, region_id, device_fp, reg_ip, created_at) VALUES (?,?,?,?,?,?,?,?)",
        phone,
        "用户" + phone.slice(-4),
        "parent",
        "active",
        region?.id ?? null,
        guard.deviceFp,
        guard.ip,
        nowIso()
      );
      run("INSERT OR IGNORE INTO parent_profiles (user_id, credit_score, credit_level) VALUES (?,100,'L0')", r.id);
      run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", r.id, nowIso());
      user = get("SELECT * FROM users WHERE id = ?", r.id);
    }
    if (user.status === "disabled") throw Err.forbidden("账号已被禁用");
    run("UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), user.id);
    bindUser(user.id, ctx.body.inviteToken);
    audit({ ...ctx, user: publicUser(user) }, "auth.login", "users:" + user.id);
    ok(ctx.res, { token: signToken(user.id, user.role), user: publicUser(loadUser(user.id)) });
  }, { auth: false });

  // 账号密码登录（教员端「用户名 + 密码」）：account 既可以是用户名，也可以是手机号
  // 用户名小写比对；错误提示统一「用户名或密码错误」，不区分账号不存在与口令错（防枚举）
  router.post("/api/auth/login-account", (ctx) => {
    const account = String(ctx.body.account || ctx.body.username || "").trim();
    if (!account) throw Err.bad("请输入用户名或手机号");
    const password = String(ctx.body.password || "");
    const key = account.toLowerCase();
    const guard = loginGuard(ctx, key);
    const user = /^1\d{10}$/.test(account)
      ? get("SELECT * FROM users WHERE phone = ?", account)
      : get("SELECT * FROM users WHERE username = ?", key);
    if (!user || !verifyPassword(password, user.password_hash)) {
      loginFail(guard);
      throw Err.biz("BAD_CREDENTIALS", "用户名或密码错误");
    }
    loginPass(guard);
    if (user.status === "disabled") throw Err.forbidden("账号已被禁用");
    run("UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), user.id);
    audit({ ...ctx, user: publicUser(user) }, "auth.loginAccount", "users:" + user.id);
    ok(ctx.res, { token: signToken(user.id, user.role), user: publicUser(user) });
  }, { auth: false });

  router.post("/api/auth/login-password", (ctx) => {
    const phone = String(ctx.body.phone || "").trim();
    const password = String(ctx.body.password || "");
    const guard = loginGuard(ctx, phone);
    const user = get("SELECT * FROM users WHERE phone = ?", phone);
    if (!user || !verifyPassword(password, user.password_hash)) {
      loginFail(guard);
      throw Err.biz("BAD_CREDENTIALS", "手机号或密码错误");
    }
    loginPass(guard);
    if (user.status === "disabled") throw Err.forbidden("账号已被禁用");
    run("UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), user.id);
    audit({ ...ctx, user: publicUser(user) }, "auth.loginPassword", "users:" + user.id);
    ok(ctx.res, { token: signToken(user.id, user.role), user: publicUser(user) });
  }, { auth: false });

  // 微信登录：演示实现把 code 直接当 openid（真实实现在 Nest 侧走 jscode2session / oauth2）
  // 昵称由 openid 稳定推导，保证「同一 code 二次登录昵称不变」（Nest 侧 mock 同规则）
  const wxNickname = (openid) => {
    let h = 0;
    for (const ch of String(openid)) h = (h * 31 + ch.codePointAt(0)) % 9000;
    return "微信用户" + (h + 1000);
  };

  // 公众号网页授权链接：参考实现没有 appid/secret，统一回「未开通」，与 Nest 侧同一错误码
  router.get("/api/auth/wechat/authorize-url", () => {
    throw Err.biz("WECHAT_NOT_CONFIGURED", "参考实现未接入微信通道，公众号授权请用正式实现（NestJS）");
  }, { auth: false });

  router.post("/api/auth/wechat", (ctx) => {
    const openid = String(ctx.body.code || "demo-openid");
    let user = get("SELECT * FROM users WHERE wx_openid = ?", openid);
    if (!user) {
      const guard = guardRegistration(ctx);
      const region = resolveRegion(30.2741, 120.1551);
      const r = run(
        "INSERT INTO users (wx_openid, nickname, role, status, region_id, device_fp, reg_ip, created_at) VALUES (?,?,?,?,?,?,?,?)",
        openid,
        wxNickname(openid),
        "parent",
        "active",
        region?.id ?? null,
        guard.deviceFp,
        guard.ip,
        nowIso()
      );
      run("INSERT OR IGNORE INTO parent_profiles (user_id, credit_score, credit_level) VALUES (?,100,'L0')", r.id);
      run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", r.id, nowIso());
      user = get("SELECT * FROM users WHERE id = ?", r.id);
    }
    bindUser(user.id, ctx.body.inviteToken);
    ok(ctx.res, { token: signToken(user.id, user.role), user: publicUser(user) });
  }, { auth: false });

  router.get("/api/auth/me", (ctx) => {
    const u = loadUser(ctx.user.id);
    const extra = {};
    if (u.role === "parent") {
      extra.credit = get("SELECT credit_score, credit_level FROM parent_profiles WHERE user_id = ?", u.id);
    }
    if (u.role === "teacher") {
      extra.teacher = get("SELECT audit_status, level, growth_score, online FROM teacher_profiles WHERE user_id = ?", u.id);
    }
    ok(ctx.res, { user: publicUser(u), ...extra });
  });

  router.post("/api/auth/logout", (ctx) => ok(ctx.res, { ok: true }));

  router.post("/api/auth/realname", (ctx) => {
    const { realName, idCard } = ctx.body;
    if (!realName || !idCard) throw Err.bad("请填写姓名与身份证号");
    if (!/^\d{17}[\dXx]$/.test(String(idCard))) throw Err.bad("身份证号格式不正确");
    run("UPDATE users SET real_name = ?, id_card = ? WHERE id = ?", realName, idCard, ctx.user.id);
    audit(ctx, "user.realname", "users:" + ctx.user.id);
    ok(ctx.res, { realName, verified: true });
  });

  router.post("/api/auth/password", (ctx) => {
    const { password } = ctx.body;
    if (!password || String(password).length < 6) throw Err.bad("密码至少 6 位");
    run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), ctx.user.id);
    audit(ctx, "user.changePassword", "users:" + ctx.user.id);
    ok(ctx.res, { ok: true });
  });

  /* ---------------- 账号注销（需求第 8 章：用户可注销账号）---------------- */
  router.post("/api/auth/deactivate", (ctx) => {
    const u = loadUser(ctx.user.id);
    if (!u) throw Err.unauthorized();
    if (u.role === "admin") throw Err.forbidden("管理员账号不可自助注销");

    const active = get(
      `SELECT COUNT(*) AS c FROM orders
       WHERE (parent_id = ? OR teacher_id = ?)
         AND status IN ('awaiting_payment','pending_class','in_class','awaiting_parent_confirm','refunding')`,
      u.id, u.id
    ).c;
    if (active > 0) {
      throw Err.biz("HAS_ACTIVE_ORDER", "您还有 " + active + " 笔订单未完结，请完结或取消后再注销账号");
    }
    const w = get("SELECT frozen FROM wallets WHERE user_id = ?", u.id);
    if (w && w.frozen > 0) {
      throw Err.biz("HAS_FROZEN", "账户还有 ¥" + (w.frozen / 100).toFixed(2) + " 冻结金额待结算，暂不可注销");
    }

    return tx(() => {
      // 匿名化：清除个人身份信息，保留订单与资金流水用于合规审计
      run(
        `UPDATE users SET status = 'disabled', phone = NULL, wx_openid = NULL, nickname = '已注销用户',
           avatar = NULL, real_name = NULL, id_card = NULL, device_fp = NULL, reg_ip = NULL
         WHERE id = ?`,
        u.id
      );
      run("DELETE FROM addresses WHERE user_id = ?", u.id);
      run("UPDATE teacher_profiles SET online = 0 WHERE user_id = ?", u.id);
      run("UPDATE teacher_services SET status = 'off' WHERE teacher_id = ?", u.id);
      run("UPDATE demands SET status = 'revoked' WHERE parent_id = ? AND status IN ('published','paused')", u.id);
      run("UPDATE sales_profiles SET status = 'disabled' WHERE user_id = ?", u.id);
      run("UPDATE agent_profiles SET status = 'disabled' WHERE user_id = ?", u.id);
      run("DELETE FROM favorites WHERE user_id = ?", u.id);
      audit(ctx, "user.deactivate", "users:" + u.id, { role: u.role });
      return ok(ctx.res, { ok: true, message: "账号已注销，个人身份信息已清除，订单与资金流水按合规要求留存" });
    });
  });

  /* ---------------- 公共字典 / 规则展示 ---------------- */
  router.get("/api/meta/dictionary", (ctx) => {
    // 学段 / 科目以规则组 catalog 为准（后台「运营工具 → 学段 / 科目」维护），无该组时回落内置默认
    let catalog = null;
    try {
      catalog = get("SELECT `value` FROM rule_configs WHERE `key` = 'catalog'");
      catalog = catalog ? JSON.parse(catalog.value) : null;
    } catch {
      catalog = null;
    }
    const pick = (v, fallback) => (Array.isArray(v) && v.length ? v.map(String).filter(Boolean) : fallback);
    ok(ctx.res, {
      ...DICTIONARY,
      stages: pick(catalog && catalog.stages, DICTIONARY.stages),
      subjects: pick(catalog && catalog.subjects, DICTIONARY.subjects),
    });
  }, { auth: false });

  router.get("/api/meta/rules-public", (ctx) => {
    const rules = listRules().filter((r) =>
      ["teacher_levels", "parent_credit", "credit_rules", "growth_rules", "review_scoring", "settlement", "agent_commission", "sales_rewards", "platforms", "dispatch", "checkin"].includes(r.key)
    );
    ok(ctx.res, rules);
  }, { auth: false });

  router.get("/api/public/agreements/:key", (ctx) => {
    const a = get("SELECT * FROM agreements WHERE key = ?", ctx.params.key);
    if (!a) throw Err.notFound("协议不存在");
    ok(ctx.res, a);
  }, { auth: false });

  router.get("/api/public/banners", (ctx) => {
    ok(ctx.res, all("SELECT * FROM banners WHERE status = 'on' ORDER BY sort ASC"));
  }, { auth: false });

  router.get("/api/public/announcements", (ctx) => {
    ok(
      ctx.res,
      all(
        "SELECT * FROM announcements WHERE status = 'on' AND (audience = 'all' OR audience = ?) ORDER BY pinned DESC, created_at DESC LIMIT 20",
        ctx.query.audience || "all"
      )
    );
  }, { auth: false });

  router.get("/api/public/coupons", (ctx) => {
    ok(ctx.res, all("SELECT * FROM coupons WHERE status = 'on' ORDER BY amount DESC"));
  }, { auth: false });

  router.post("/api/coupons/:id/claim", (ctx) => {
    const c = get("SELECT * FROM coupons WHERE id = ? AND status = 'on'", ctx.params.id);
    if (!c) throw Err.notFound("优惠券不存在");
    if (c.total > 0 && c.claimed >= c.total) throw Err.biz("COUPON_EMPTY", "优惠券已被领完");
    const exist = get("SELECT id FROM user_coupons WHERE user_id = ? AND coupon_id = ?", ctx.user.id, c.id);
    if (exist) throw Err.biz("COUPON_CLAIMED", "您已领取该优惠券");
    run("INSERT INTO user_coupons (user_id, coupon_id, claimed_at) VALUES (?,?,?)", ctx.user.id, c.id, nowIso());
    run("UPDATE coupons SET claimed = claimed + 1 WHERE id = ?", c.id);
    ok(ctx.res, { ok: true });
  });

  router.get("/api/my/coupons", (ctx) => {
    ok(
      ctx.res,
      all(
        "SELECT uc.id, uc.used, uc.order_id, uc.claimed_at, c.name, c.amount, c.threshold, c.valid_from, c.valid_to FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.user_id = ? ORDER BY uc.id DESC",
        ctx.user.id
      )
    );
  });

  /* ---------------- 地址管理 ---------------- */
  router.get("/api/addresses", (ctx) => {
    ok(ctx.res, all("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC", ctx.user.id));
  });

  router.post("/api/addresses", (ctx) => {
    const b = ctx.body;
    if (!b.address || !b.contact) throw Err.bad("请填写联系人与详细地址");
    if (b.lat == null || b.lng == null) throw Err.bad("地址需解析定位坐标");
    const region = resolveRegion(Number(b.lat), Number(b.lng));
    const count = get("SELECT COUNT(*) AS c FROM addresses WHERE user_id = ?", ctx.user.id).c;
    const r = run(
      "INSERT INTO addresses (user_id, label, contact, phone, region_id, address, lat, lng, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ctx.user.id,
      b.label || "家",
      b.contact,
      b.phone || ctx.user.phone || "",
      region?.id ?? null,
      b.address,
      Number(b.lat),
      Number(b.lng),
      count === 0 || b.isDefault ? 1 : 0,
      nowIso()
    );
    if (count === 0 || b.isDefault) {
      run("UPDATE addresses SET is_default = 0 WHERE user_id = ? AND id <> ?", ctx.user.id, r.id);
    }
    ok(ctx.res, get("SELECT * FROM addresses WHERE id = ?", r.id));
  });

  router.put("/api/addresses/:id", (ctx) => {
    const a = get("SELECT * FROM addresses WHERE id = ? AND user_id = ?", ctx.params.id, ctx.user.id);
    if (!a) throw Err.notFound("地址不存在");
    const b = ctx.body;
    run(
      "UPDATE addresses SET label = ?, contact = ?, phone = ?, address = ?, lat = ?, lng = ? WHERE id = ?",
      b.label ?? a.label,
      b.contact ?? a.contact,
      b.phone ?? a.phone,
      b.address ?? a.address,
      b.lat != null ? Number(b.lat) : a.lat,
      b.lng != null ? Number(b.lng) : a.lng,
      a.id
    );
    ok(ctx.res, get("SELECT * FROM addresses WHERE id = ?", a.id));
  });

  router.del("/api/addresses/:id", (ctx) => {
    const a = get("SELECT * FROM addresses WHERE id = ? AND user_id = ?", ctx.params.id, ctx.user.id);
    if (!a) throw Err.notFound("地址不存在");
    run("DELETE FROM addresses WHERE id = ?", a.id);
    ok(ctx.res, { ok: true });
  });

  router.post("/api/addresses/:id/default", (ctx) => {
    const a = get("SELECT * FROM addresses WHERE id = ? AND user_id = ?", ctx.params.id, ctx.user.id);
    if (!a) throw Err.notFound("地址不存在");
    run("UPDATE addresses SET is_default = 0 WHERE user_id = ?", ctx.user.id);
    run("UPDATE addresses SET is_default = 1 WHERE id = ?", a.id);
    ok(ctx.res, { ok: true });
  });

  /* ---------------- 消息中心 ---------------- */
  router.get("/api/messages", (ctx) => {
    const list = all("SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", ctx.user.id);
    const unread = get("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND read = 0", ctx.user.id).c;
    ok(ctx.res, { list, unread });
  });

  router.post("/api/messages/:id/read", (ctx) => {
    run("UPDATE messages SET read = 1 WHERE id = ? AND user_id = ?", ctx.params.id, ctx.user.id);
    ok(ctx.res, { ok: true });
  });

  router.post("/api/messages/read-all", (ctx) => {
    run("UPDATE messages SET read = 1 WHERE user_id = ?", ctx.user.id);
    ok(ctx.res, { ok: true });
  });

  /* ---------------- 收藏 ---------------- */
  router.get("/api/my/favorites", (ctx) => {
    ok(
      ctx.res,
      all(
        "SELECT f.id, f.teacher_id, f.created_at FROM favorites f WHERE f.user_id = ? ORDER BY f.id DESC",
        ctx.user.id
      )
    );
  });

  router.post("/api/my/favorites/:teacherId", (ctx) => {
    const t = get("SELECT user_id FROM teacher_profiles WHERE user_id = ?", ctx.params.teacherId);
    if (!t) throw Err.notFound("教员不存在");
    const exist = get("SELECT id FROM favorites WHERE user_id = ? AND teacher_id = ?", ctx.user.id, t.user_id);
    if (exist) {
      run("DELETE FROM favorites WHERE id = ?", exist.id);
      return ok(ctx.res, { favorited: false });
    }
    run("INSERT INTO favorites (user_id, teacher_id, created_at) VALUES (?,?,?)", ctx.user.id, t.user_id, nowIso());
    ok(ctx.res, { favorited: true });
  });

  /* ---------------- 客诉 ---------------- */
  router.post("/api/complaints", (ctx) => {
    const { orderId, title, content, againstUser } = ctx.body;
    if (!title) throw Err.bad("请填写问题标题");
    const order = orderId ? get("SELECT * FROM orders WHERE id = ?", orderId) : null;
    const r = run(
      "INSERT INTO complaints (order_id, from_user, from_role, against_user, region_id, type, title, content, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      order?.id ?? null,
      ctx.user.id,
      ctx.user.role,
      againstUser ?? (ctx.user.role === "parent" ? order?.teacher_id : order?.parent_id) ?? null,
      order?.region_id ?? ctx.user.region_id ?? null,
      "complaint",
      title,
      content || "",
      "open",
      nowIso()
    );
    audit(ctx, "complaint.create", "complaints:" + r.id);
    ok(ctx.res, { id: r.id });
  });

  router.get("/api/my/complaints", (ctx) => {
    ok(ctx.res, all("SELECT * FROM complaints WHERE from_user = ? ORDER BY id DESC", ctx.user.id));
  });

  /* ---------------- 文件上传（base64 落盘）---------------- */
  /* ---------------- 文件上传（base64 落盘，仅图片、限 2MB）---------------- */
  router.post("/api/upload", async (ctx) => {
    const { filename, dataUrl } = ctx.body;
    if (!dataUrl || !String(dataUrl).startsWith("data:")) throw Err.bad("文件格式不正确");
    const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
    if (!m) throw Err.bad("文件格式不正确");
    const mime = m[1].toLowerCase();
    const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp" };
    const ext = EXT[mime];
    if (!ext) throw Err.bad("只支持 PNG / JPG / WEBP 图片");
    const buf = Buffer.from(m[2].replace(/\s/g, ""), "base64");
    if (!buf.length) throw Err.bad("图片内容为空");
    if (buf.length > 2 * 1024 * 1024) throw Err.biz("FILE_TOO_LARGE", "图片不能超过 2MB，请压缩后重试");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "data", "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10) + "." + ext;
    fs.writeFileSync(path.join(dir, name), buf);
    // filename 原样回传：证件识别 mock 需要它解析「姓名_身份证号」，真实通道则忽略
    ok(ctx.res, { url: "/uploads/" + name, filename: filename || name, size: buf.length });
  });
}