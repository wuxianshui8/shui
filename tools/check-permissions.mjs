// ============================================================
// 细粒度权限矩阵验收（需求 4.5.9「角色权限分配」）
//   1. 默认矩阵：4 个权限点仅 admin
//   2. 未授权角色访问高危写接口 → 403（由权限矩阵拦截，不是角色不匹配）
//   3. 授予后同一调用不再 403（进入业务校验），撤销后恢复 403
//   4. 防自锁：任何权限点都不能移除 admin；未知权限点被拒
//   5. 矩阵持久化 + 写审计日志
// 用法：node tools/gate-permissions.mjs
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4300";
const PW = "a123456";
let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "  " + extra : "")); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
async function api(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + "/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json };
}
const login = async (phone) => (await api("POST", "/auth/login-password", { body: { phone, password: PW } })).body.data.token;
const KEYS = ["order.price", "order.close", "refund.review", "withdraw.review"];
const onlyAdmin = () => Object.fromEntries(KEYS.map((k) => [k, ["admin"]]));

console.log("细粒度权限矩阵验收");
console.log("目标服务：" + BASE + "\n");

const admin = await login("13900000001");
const agent = await login("13900000010");
const sales = await login("13900000101");
assert(!!admin && !!agent && !!sales, "管理员 / 代理 / 业务员 登录成功");

console.log("\n== 1. 默认矩阵 ==");
const init = await api("GET", "/admin/permissions", { token: admin });
assert(init.status === 200 && (init.body.data.keys || []).length === KEYS.length, "权限点共 " + (init.body.data?.keys || []).length + " 个");
assert(KEYS.every((k) => JSON.stringify((init.body.data.matrix || {})[k]) === JSON.stringify(["admin"])), "默认每个权限点仅 admin");

console.log("\n== 2. 未授权角色被权限矩阵拦截 ==");
const agentCloseDenied = await api("POST", "/admin/orders/999999/close", { token: agent, body: { reason: "权限验收" } });
assert(agentCloseDenied.status === 403 && /权限/.test(agentCloseDenied.body?.message || ""),
  "代理调「强制关闭」被权限矩阵拒绝（" + agentCloseDenied.body?.message + "）");
const salesWithdrawDenied = await api("POST", "/admin/withdrawals/999999/review", { token: sales, body: { approve: false } });
assert(salesWithdrawDenied.status === 403, "业务员调「提现审核」被拒绝（" + salesWithdrawDenied.status + "）");
const parentLogin = await api("POST", "/auth/login-password", { body: { phone: "13900000301", password: PW } });
const parentDenied = await api("POST", "/admin/orders/999999/price", { token: parentLogin.body.data.token, body: { amount: 100 } });
assert(parentDenied.status === 403, "家长调「改价」被拒绝（角色白名单拦截，" + parentDenied.status + "）");

console.log("\n== 3. 授予后进入业务校验（不再 403） ==");
const grantAgent = await api("PUT", "/admin/permissions", {
  token: admin,
  body: { matrix: { ...onlyAdmin(), "order.close": ["admin", "agent"] } },
});
assert(grantAgent.status === 200 && (grantAgent.body.data.matrix["order.close"] || []).includes("agent"), "授予代理「强制关闭」权限");
const agentCloseAllowed = await api("POST", "/admin/orders/999999/close", { token: agent, body: { reason: "权限验收" } });
assert(agentCloseAllowed.status !== 403, "授予后代理调用进入业务校验（" + agentCloseAllowed.status + " " + (agentCloseAllowed.body?.message || "") + "）");

const grantSales = await api("PUT", "/admin/permissions", {
  token: admin,
  body: { matrix: { ...onlyAdmin(), "order.close": ["admin", "agent"], "withdraw.review": ["admin", "sales"] } },
});
assert(grantSales.status === 200, "授予业务员「提现审核」权限");
const salesWithdrawAllowed = await api("POST", "/admin/withdrawals/999999/review", { token: sales, body: { approve: false } });
assert(salesWithdrawAllowed.status !== 403, "授予后业务员调用进入业务校验（" + salesWithdrawAllowed.status + "）");

console.log("\n== 4. 防自锁与非法输入 ==");
const lockout = await api("PUT", "/admin/permissions", { token: admin, body: { matrix: { ...onlyAdmin(), "order.close": ["agent"] } } });
assert(lockout.status === 403 && /admin/.test(lockout.body?.message || ""), "移除 admin 被拒（" + lockout.body?.message + "）");
const unknownKey = await api("PUT", "/admin/permissions", { token: admin, body: { matrix: { ...onlyAdmin(), "order.delete": ["admin"] } } });
assert(unknownKey.status === 400 && /未知权限点/.test(unknownKey.body?.message || ""), "未知权限点被拒（" + unknownKey.body?.message + "）");
const afterDenied = await api("GET", "/admin/permissions", { token: admin });
assert((afterDenied.body.data.matrix["order.close"] || []).includes("agent"), "被拒的写入未污染现有矩阵");

console.log("\n== 5. 撤销后恢复拦截 ==");
const revoke = await api("PUT", "/admin/permissions", { token: admin, body: { matrix: onlyAdmin() } });
assert(revoke.status === 200, "恢复默认矩阵");
const agentAgain = await api("POST", "/admin/orders/999999/close", { token: agent, body: { reason: "撤销后" } });
assert(agentAgain.status === 403, "撤销后代理再次被拒（" + agentAgain.status + "）");
const adminStillWorks = await api("POST", "/admin/orders/999999/close", { token: admin, body: { reason: "管理员自检" } });
assert(adminStillWorks.status !== 403, "管理员始终保留权限（" + adminStillWorks.status + "）");

console.log("\n== 6. 审计日志 ==");
const logs = await api("GET", "/admin/audit-logs?page=1&pageSize=20", { token: admin });
assert((logs.body.data.list || []).some((r) => String(r.action || "").includes("permissions.update")), "权限矩阵变更写入操作日志");

console.log("\n=================================================");
console.log("细粒度权限矩阵：通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) {
  console.log("失败项：");
  failures.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
} else {
  console.log("权限点可配置、授予即时生效、撤销立即失效、admin 不可被锁死 ✅");
}
console.log("=================================================");
