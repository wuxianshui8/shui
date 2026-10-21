// ============================================================
// 隐私与账号安全回归（本轮评审后新增修复项的固化用例）
//   1. 订单视图：代理/业务员视角坐标模糊到 2 位小数，家长/教员仍是精确坐标
//   2. 教师「附近需求」：未确认前只下发街道级模糊地址与脱敏备注
//   3. 家长确认报名后，教员在订单详情拿到完整门牌
//   4. 修改口令：原口令校验 / 强度校验 / 改后旧口令失效、新口令可登录
//   5. /api/health 匿名不含用户数·订单数·担保资金；/api/health/detail 仅管理员
// 用法：node tools/gate-privacy.mjs（由 gate-p6 起停服务）
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4300";
const PW = "a123456";
let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓ " + name + (extra ? "  " + extra : ""));
  } else {
    fail++;
    failures.push(name);
    console.log("  ✗ " + name + (extra ? "  → " + extra : ""));
  }
}
async function api(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, body: json, text };
}
const login = async (phone, password = PW) =>
  api("POST", "/auth/login-password", { body: { phone, password } });
const decimals = (n) => (String(n).split(".")[1] || "").length;

console.log("隐私与账号安全回归");
console.log("目标服务：" + BASE + "\n");

const admin = (await login("13900000001")).body.data.token;
const parent = (await login("13900000301")).body.data.token;
const teacher = (await login("13900000201")).body.data.token;
const agent = (await login("13900000010")).body.data.token;
assert(!!admin && !!parent && !!teacher && !!agent, "管理员 / 家长 / 教员 / 代理 登录成功");

/* ---------------- 准备一笔订单（含完整门牌） ---------------- */
const FULL_ADDR = "西湖区文三路 128 号 3 幢 501 室";
console.log("\n== 1. 教员「附近需求」地址脱敏 ==");
const demand = await api("POST", "/demands", {
  token: parent,
  body: { stage: "初中", subject: "数学", address: FULL_ADDR, lat: 30.262, lng: 120.133, budget: 16000, remark: "家长备注：门禁密码 8888" },
});
const demandId = demand.body.data.id;
const nearby = await api("GET", "/teacher/nearby-demands", { token: teacher });
const target = (nearby.body.data.list || []).find((d) => d.id === demandId);
assert(!!target, "新需求出现在教员附近列表（距离 " + target?.distanceKm + " km）");
assert(!!target && !String(target.address).includes("501"), "未报名时不下发门牌号（" + target?.address + "）");
assert(!!target && String(target.address).includes("***"), "未报名时地址为模糊形式（" + target?.address + "）");
assert(!!target && String(target.remark) === "报名确认后可见", "未报名时需求备注被隐藏（" + target?.remark + "）");

/* ---------------- 报名 → 家长确认 → 订单 ---------------- */
const apply = await api("POST", "/demands/" + demandId + "/apply", { token: teacher });
const confirm = await api("POST", "/demands/" + demandId + "/confirm", {
  token: parent,
  body: { applicationId: apply.body.data.applicationId },
});
const orderId = confirm.body.data.id;
assert(!!orderId, "家长确认报名后生成订单 #" + orderId);

const teacherOrder = (await api("GET", "/orders/" + orderId, { token: teacher })).body.data;
assert(String(teacherOrder.address).includes("501"), "成交后教员可见完整门牌（" + teacherOrder.address + "）");
assert(decimals(teacherOrder.lat) > 2, "教员视角坐标为精确值（" + teacherOrder.lat + "）");

console.log("\n== 2. 订单视图坐标脱敏 ==");
await api("POST", "/orders/" + orderId + "/pay", { token: parent });
const agentOrders = (await api("GET", "/agent/orders", { token: agent })).body.data;
const list = agentOrders.list || agentOrders.rows || agentOrders;
const agentView = (Array.isArray(list) ? list : []).find((o) => Number(o.id) === Number(orderId));
assert(!!agentView, "代理端订单列表包含该订单");
assert(!!agentView && decimals(agentView.lat) <= 2 && decimals(agentView.lng) <= 2,
  "代理视角坐标模糊到 2 位小数（" + agentView?.lat + ", " + agentView?.lng + "）");
const parentView = (await api("GET", "/orders/" + orderId, { token: parent })).body.data;
assert(decimals(parentView.lat) > 2, "家长视角仍为精确坐标（" + parentView.lat + "）");

/* ---------------- 3. 健康检查信息分级 ---------------- */
console.log("\n== 3. /api/health 信息分级 ==");
const health = await fetch(BASE + "/api/health").then((r) => r.json());
assert(health.data.db.ok === true && health.data.cache.ok === true, "匿名探活可用（MySQL + Redis）");
assert(health.data.db.users === undefined, "匿名响应不含用户数");
assert(health.data.db.escrow === undefined, "匿名响应不含担保资金总额");
const detailAnon = await api("GET", "/health/detail");
assert(detailAnon.status === 401 || detailAnon.status === 403, "匿名访问 /health/detail 被拒绝（" + detailAnon.status + "）");
const detailAdmin = await api("GET", "/health/detail", { token: admin });
assert(detailAdmin.status === 200 && Number(detailAdmin.body.data.db.users) > 0 && typeof detailAdmin.body.data.db.escrow === "number",
  "管理员可读运维指标（用户 " + detailAdmin.body.data?.db?.users + " / 订单 " + detailAdmin.body.data?.db?.orders + "）");

/* ---------------- 4. 修改口令 ---------------- */
console.log("\n== 4. 修改口令 ==");
const T_PHONE = "13900000202"; // 李思远（英语 / Lv3），本轮门禁内改密，数据库每次重建
const tTok = (await login(T_PHONE)).body.data.token;
const wrongOld = await api("POST", "/auth/change-password", { token: tTok, body: { oldPassword: "wrong-old", newPassword: "Strong123" } });
assert(wrongOld.status === 400 && /原口令/.test(wrongOld.body?.message || ""), "原口令错误被拒（" + wrongOld.body?.message + "）");
const weak = await api("POST", "/auth/change-password", { token: tTok, body: { oldPassword: PW, newPassword: "abc12" } });
assert(weak.status === 400 && /8 位/.test(weak.body?.message || ""), "弱口令被拒（" + weak.body?.message + "）");
const noDigit = await api("POST", "/auth/change-password", { token: tTok, body: { oldPassword: PW, newPassword: "abcdefghi" } });
assert(noDigit.status === 400 && /字母与数字/.test(noDigit.body?.message || ""), "纯字母口令被拒（" + noDigit.body?.message + "）");
const okChange = await api("POST", "/auth/change-password", { token: tTok, body: { oldPassword: PW, newPassword: "Strong123" } });
assert(okChange.status === 200 && okChange.body.code === 0, "合规新口令修改成功");
const oldLogin = await login(T_PHONE, PW);
assert(oldLogin.status === 400, "旧口令已失效（" + oldLogin.status + "）");
const newLogin = await login(T_PHONE, "Strong123");
assert(newLogin.status === 200 && newLogin.body.code === 0, "新口令可正常登录");
const audit = await api("GET", "/admin/audit-logs?page=1&pageSize=20", { token: admin });
const auditHit = (audit.body.data.list || []).some((r) => String(r.action || "").includes("changePassword"));
assert(auditHit, "改密动作写入操作日志");

/* ---------------- 5. 改密后旧令牌立即失效 ---------------- */
console.log("\n== 5. 改密后旧令牌失效（token_version） ==");
const staleMe = await api("GET", "/auth/me", { token: tTok });
assert(staleMe.status === 401, "改密前签发的旧令牌已失效（" + staleMe.status + "）");
const freshTok = newLogin.body.data.token;
const freshMe = await api("GET", "/auth/me", { token: freshTok });
assert(freshMe.status === 200 && freshMe.body.code === 0, "重新登录后的新令牌可用");
const newTokenFromChange = (await api("POST", "/auth/change-password", {
  token: freshTok,
  body: { oldPassword: "Strong123", newPassword: "Strong456" },
})).body.data;
assert(!!newTokenFromChange?.token, "改密响应直接返回新令牌（避免用户被动掉线）");
const afterChangeMe = await api("GET", "/auth/me", { token: newTokenFromChange.token });
assert(afterChangeMe.status === 200, "改密返回的新令牌可继续使用");
const usedToken = await api("GET", "/auth/me", { token: freshTok });
assert(usedToken.status === 401, "上一次的令牌在本次改密后失效");

/* ---------------- 6. 后台开通账号：一次性口令 + 首登强制改密 ---------------- */
console.log("\n== 6. 后台开通账号：一次性口令 + 首登强制改密 ==");
const newAgentPhone = "13900008801";
const created = await api("POST", "/admin/agents", {
  token: admin,
  body: { nickname: "验收新代理", phone: newAgentPhone, regionId: 1, deposit: 200000 },
});
const initialPassword = created.body.data?.initialPassword;
assert(created.status === 200 && typeof initialPassword === "string", "管理员开通代理成功（id " + created.body.data?.id + "）");
assert(initialPassword !== PW && initialPassword.length >= 10, "初始口令为一次性强口令而非全站统一 " + PW + "（" + initialPassword + "）");
const agentLogin = await login(newAgentPhone, initialPassword);
assert(agentLogin.status === 200 && agentLogin.body.data.user.mustChangePassword === true, "新账号登录后返回 mustChangePassword=true");
const newAgentTok = agentLogin.body.data.token;
const blocked = await api("GET", "/agent/dashboard", { token: newAgentTok });
assert(blocked.status === 403 && /修改初始口令/.test(blocked.body?.message || ""), "改密前访问业务接口被拒（" + blocked.status + " " + blocked.body?.message + "）");
const agentChange = await api("POST", "/auth/change-password", {
  token: newAgentTok,
  body: { oldPassword: initialPassword, newPassword: "Agent2024x" },
});
assert(agentChange.status === 200 && !!agentChange.body.data?.token, "首登改密成功并返回新令牌");
const agentDash = await api("GET", "/agent/dashboard", { token: agentChange.body.data.token });
assert(agentDash.status === 200 && agentDash.body.code === 0, "改密后业务接口恢复可用");
const oldPwdLogin = await login(newAgentPhone, initialPassword);
assert(oldPwdLogin.status === 400, "一次性初始口令改密后不可再用（" + oldPwdLogin.status + "）");

/* 代理开通业务员：同样一次性口令 + 首登强制改密 */
const newSalesPhone = "13900008802";
const createdSales = await api("POST", "/agent/sales", {
  token: agentChange.body.data.token,
  body: { nickname: "验收新业务员", phone: newSalesPhone },
});
const salesPwd = createdSales.body.data?.initialPassword;
assert(createdSales.status === 200 && typeof salesPwd === "string" && salesPwd !== PW, "代理开通业务员返回一次性口令（" + salesPwd + "）");
const salesLogin = await login(newSalesPhone, salesPwd);
assert(salesLogin.status === 200 && salesLogin.body.data.user.mustChangePassword === true, "新业务员首登需强制改密");
const salesBlocked = await api("GET", "/sales/dashboard", { token: salesLogin.body.data.token });
assert(salesBlocked.status === 403, "改密前业务员接口被拒（" + salesBlocked.status + "）");

console.log("\n=================================================");
console.log("隐私与账号安全：通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) {
  console.log("失败项：");
  failures.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
} else {
  console.log("地址/坐标脱敏、健康检查分级、改密链路全部符合预期 ✅");
}
console.log("=================================================");
