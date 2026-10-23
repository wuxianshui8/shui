// ============================================================
// PC 管理后台（Vue3 + Vite + Element Plus）验收
//   1. 静态产物可达：/admin-vue/ 与全部 assets 均 200 且类型正确
//   2. SPA 所有页面依赖的后台接口逐一联调（登录 → 12 个模块）
// 用法：由 tools/gate-p8.mjs 在同批次起服务后调用
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
  const res = await fetch(BASE + "/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json, text };
}


// 构建产物包含全部页面分包（本地读取 dist 校验，覆盖菜单里的 15 个页面）
{
  const { readdirSync } = await import("node:fs");
  const distAssets = readdirSync(new URL("../apps/web-admin/dist/assets", import.meta.url));
  const views = ["Login", "Overview", "Orders", "Demands", "Refunds", "Finance", "Withdrawals", "Invoices",
    "Users", "Teachers", "Agents", "Admins", "Permissions", "Regions", "Rules", "Ops", "Risks", "Logs",
    "Catalog", "Password"];
  const missing = views.filter((v) => !distAssets.some((f) => f.startsWith(v + "-")));
  assert(missing.length === 0, "构建产物含 " + views.length + " 个页面分包" + (missing.length ? "，缺失 " + missing.join(",") : ""));
  // 区域管理页的地图底图必须打进产物（离线，不请求在线瓦片）
  const { readFileSync } = await import("node:fs");
  const regionsChunk = distAssets.filter((f) => f.startsWith("Regions-") && f.endsWith(".js"));
  const chunkSrc = regionsChunk.map((f) => readFileSync(new URL("../apps/web-admin/dist/assets/" + f, import.meta.url), "utf8")).join("\n");
  assert(chunkSrc.includes("data-geo-map") && chunkSrc.includes("台湾") && chunkSrc.includes("MultiPolygon"),
    "区域管理页分包内置中国地图底图（" + Math.round(chunkSrc.length / 1024) + " KB 分包，含省级边界）");
  assert(/\{z\}.*\{x\}.*\{y\}/.test(chunkSrc) && chunkSrc.includes("autonavi"),
    "区域管理页支持在线瓦片底图（{z}/{x}/{y} 模板，默认高德，可用 VITE_TILE_URL 替换）");
  // 管理员「修改口令」功能：产物里必须有改密页与顶栏入口，且调用的是 /auth/change-password
  const pwChunk = distAssets.filter((f) => f.startsWith("Password-") && f.endsWith(".js"));
  assert(pwChunk.length === 1, "构建产物含「修改口令」页分包（Password-" + pwChunk.length + "）");
  const pwSrc = pwChunk.map((f) => readFileSync(new URL("../apps/web-admin/dist/assets/" + f, import.meta.url), "utf8")).join("\n");
  assert(pwSrc.includes("/auth/change-password") && pwSrc.includes("oldPassword") && pwSrc.includes("newPassword"),
    "改密页调用 POST /auth/change-password（带 oldPassword / newPassword）");
  assert(pwSrc.includes("至少 8 位") && pwSrc.includes("[A-Za-z]") && pwSrc.includes("[0-9]"),
    "改密页前端校验口令强度（≥8 位且含字母与数字）");
  assert(pwSrc.includes("mustChangePassword"), "改密成功后把新令牌写回本地并清掉 mustChangePassword 标记");
  const appSrc = readFileSync(new URL("../apps/web-admin/src/App.vue", import.meta.url), "utf8");
  assert(appSrc.includes("top-password") && appSrc.includes("/password"),
    "顶栏有「修改口令」入口（data-test=top-password）");
  const loginSrc = readFileSync(new URL("../apps/web-admin/src/views/Login.vue", import.meta.url), "utf8");
  assert(loginSrc.includes("mustChangePassword") && loginSrc.includes("/password?force=1"),
    "首登 mustChangePassword=true 时直接送进改密页（不再卡在 403）");
  const apiSrc = readFileSync(new URL("../apps/web-admin/src/api.js", import.meta.url), "utf8");
  assert(apiSrc.includes("MUST_CHANGE_PASSWORD") && apiSrc.includes("#/password?force=1"),
    "任何接口返回 MUST_CHANGE_PASSWORD 时前端统一跳改密页");
}
console.log("PC 管理后台验收（Vue3 + Vite + Element Plus）");
console.log("目标服务：" + BASE + "\n");

/* ---------- 1. 静态产物 ---------- */
console.log("== 1. 前端构建产物托管 ==");
const indexRes = await fetch(BASE + "/admin-vue/");
const indexHtml = await indexRes.text();
assert(indexRes.status === 200, "GET /admin-vue/ 返回 200（" + indexRes.headers.get("content-type") + "）");
assert(indexHtml.includes('id="app"'), "返回 SPA 挂载点 index.html");
assert(/assets\/index-[A-Za-z0-9_-]+\.js/.test(indexHtml), "引用了 Vite 构建产物（带 hash 的 JS）");
assert(/assets\/index-[A-Za-z0-9_-]+\.css/.test(indexHtml), "引用了 Element Plus 样式产物");

const assetPaths = [...indexHtml.matchAll(/(?:src|href)="(\/admin-vue\/assets\/[^"]+)"/g)].map((m) => m[1]);
assert(assetPaths.length >= 2, "解析到 " + assetPaths.length + " 个静态资源");
for (const p of assetPaths) {
  const r = await fetch(BASE + p);
  const ct = r.headers.get("content-type") || "";
  assert(r.status === 200 && /javascript|css/.test(ct), "静态资源可访问：" + p.replace("/admin-vue/assets/", "") + "（" + ct.split(";")[0] + "）");
}

/* ---------- 2. 页面依赖接口联调 ---------- */
console.log("\n== 2. 13 个页面依赖的后台接口 ==");
const login = await api("POST", "/auth/login-password", { body: { phone: "13900000001", password: PW } });
assert(login.status === 200 && login.body.data.user.role === "admin", "登录页：管理员登录成功");
const token = login.body.data.token;

const endpoints = [
  ["/admin/overview", "总览页"],
  ["/admin/orders?page=1&pageSize=10", "订单管理页"],
  ["/admin/refunds", "退款工单页"],
  ["/admin/finance", "财务资金页"],
  ["/admin/users?page=1&pageSize=10", "用户管理页"],
  ["/admin/teachers/pending", "教员审核页"],
  ["/admin/agents", "代理管理页"],
  ["/admin/regions", "区域管理页"],
  ["/admin/rules", "规则配置中心页"],
  ["/admin/banners", "运营工具·Banner"],
  ["/admin/announcements", "运营工具·公告"],
  ["/admin/coupons", "运营工具·优惠券"],
  ["/admin/risks", "风控与仲裁页"],
  ["/admin/audit-logs?page=1&pageSize=20", "操作日志页"],
];
for (const [path, name] of endpoints) {
  const r = await api("GET", path, { token });
  assert(r.status === 200 && r.body.code === 0, name + "：" + path + " 契约正常");
}

/* 区域管理页写操作闭环（新建片区 → 列表可见） */
const regionCreate = await api("POST", "/admin/regions", {
  token,
  body: { name: "临平片区验收", centerLat: 30.42, centerLng: 120.3, radiusKm: 6 },
});
assert(regionCreate.status === 200 && regionCreate.body.code === 0 && regionCreate.body.data.name === "临平片区验收",
  "区域管理页：新建片区成功（编码 " + (regionCreate.body.data?.code || "-") + "）");
const regionList = await api("GET", "/admin/regions", { token });
assert(regionList.status === 200 && regionList.body.data.some((r) => r.name === "临平片区验收"),
  "区域管理页：新建片区出现在片区列表（共 " + (regionList.body.data?.length || 0) + " 个片区）");

/* 地图上画的多边形围栏：写入 → 回读顶点数（页面上「顶点数」列与地图叠加都依赖它） */
const fence = [[30.45, 120.25], [30.45, 120.35], [30.38, 120.38], [30.36, 120.28]];
const polygonCreate = await api("POST", "/admin/regions", {
  token,
  body: { name: "西湖区围栏验收", centerLat: 30.4, centerLng: 120.31, radiusKm: 5.5, polygon: fence },
});
assert(polygonCreate.status === 200 && polygonCreate.body.code === 0, "区域管理页：保存地图上画的多边形围栏（4 个顶点）");
const fenceList = (await api("GET", "/admin/regions", { token })).body.data || [];
const saved = fenceList.find((r) => r.name === "西湖区围栏验收");
const savedPoly = saved ? (typeof saved.polygon === "string" ? JSON.parse(saved.polygon) : saved.polygon) : null;
assert(Array.isArray(savedPoly) && savedPoly.length === 4 && Math.abs(savedPoly[0][0] - 30.45) < 1e-6,
  "区域管理页：回读围栏顶点数与坐标一致（" + (Array.isArray(savedPoly) ? savedPoly.length : 0) + " 点）");

/* 按行政区设置：输入地名 → 选行政区 → 围栏 = 边界并集（多环） */
const areaHit = await api("GET", "/admin/regions/areas?q=" + encodeURIComponent("张北"), { token });
const areaList = areaHit.body?.data?.list || [];
assert(areaHit.status === 200 && areaList[0]?.name === "张北县",
  "区域管理页：输入地名搜到行政区（" + (areaList[0]?.name || "-") + "，数据集 " + (areaHit.body?.data?.dataset?.count || 0) + " 个）");
const areaRings = await api("GET", "/admin/regions/areas?codes=130722", { token });
const ringPts = (areaRings.body?.data?.list?.[0]?.rings || []).flat().length;
assert(areaRings.status === 200 && ringPts > 50, "区域管理页：按 adcode 取回边界（" + ringPts + " 个顶点）");
/* 全国区县覆盖：县级市与市辖区都要能搜到（地名搜索不能只认省/市） */
const countyHit = await api("GET", "/admin/regions/areas?q=" + encodeURIComponent("义乌"), { token });
const countyName = countyHit.body?.data?.list?.[0]?.name;
const districtHit = await api("GET", "/admin/regions/areas?q=" + encodeURIComponent("天河"), { token });
const districtName = districtHit.body?.data?.list?.[0]?.name;
assert(countyName === "义乌市" && districtName === "天河区",
  "区域管理页：能搜到县级市与市辖区（" + (countyName || "-") + " / " + (districtName || "-") + "）");
const byAdmin = await api("POST", "/admin/regions", {
  token,
  body: { name: "张北县片区验收", adminCodes: ["130722"] },
});
assert(byAdmin.status === 200 && (byAdmin.body.data?.adminNames || []).includes("张北县"),
  "区域管理页：按行政区建成片区（" + ((byAdmin.body.data?.adminNames || []).join("、") || "-") + "）");
const byAdminPoly = byAdmin.body.data?.polygon;
const multiRings = typeof byAdminPoly === "string" ? JSON.parse(byAdminPoly) : Array.isArray(byAdminPoly) ? byAdminPoly : [];
assert(multiRings.length >= 1 && Array.isArray(multiRings[0]) && Array.isArray(multiRings[0][0]),
  "区域管理页：围栏存成多环多边形（" + multiRings.length + " 环 / " + multiRings.flat().length + " 点）");

/* 代理管理：新增 → 列表可见 → 有业务数据的拒绝删除 → 新账号可删除 */
const agentCreate = await api("POST", "/admin/agents", {
  token,
  body: { nickname: "验收代理·孙经理", phone: "13900007801", regionId: 1, level: "A", commissionRate: 0.25, mgmtRate: 0.01, deposit: 0 },
});
assert(agentCreate.status === 200 && agentCreate.body.data?.id > 0 && !!agentCreate.body.data?.initialPassword,
  "代理管理页：新增代理返回一次性初始口令（ID " + (agentCreate.body.data?.id || "-") + "）");
const agentNewId = agentCreate.body.data?.id;
const agentList = await api("GET", "/admin/agents", { token });
assert((agentList.body.data || []).some((a) => Number(a.user_id) === Number(agentNewId)),
  "代理管理页：新增的代理出现在代理列表（" + (agentList.body.data || []).length + " 个）");
// 钱没结清的代理（seed 里保证金 50000）拒绝删除
const agentHasMoney = await api("DELETE", "/admin/agents/2", { token });
assert(agentHasMoney.status >= 400 && (agentHasMoney.body?.code === "AGENT_MONEY_LEFT" || /未结清/.test(agentHasMoney.text)),
  "代理管理页：保证金未结清的代理拒绝删除（" + agentHasMoney.status + "）");
// 造一个有「历史痕迹」但没钱没订单的代理：新建代理 → 让一个家长在该片区发需求 → 形成归属绑定
const zbRegion = (await api("GET", "/admin/regions", { token })).body.data.find((r) => r.name === "张北县片区验收");
const historyAgent = await api("POST", "/admin/agents", {
  token,
  body: { nickname: "张北代理·钱经理", phone: "13900007803", regionId: zbRegion.id, level: "A", deposit: 0 },
});
const hisParentCode = await api("POST", "/auth/send-code", { body: { phone: "13900007813" } });
const hisParent = await api("POST", "/auth/login", { body: { phone: "13900007813", code: hisParentCode.body.data.devCode } });
await api("POST", "/demands", {
  token: hisParent.body.data.token,
  body: { stage: "初中", subject: "数学", address: "张北县兴和路 7 号", lat: 41.287, lng: 114.764, budget: 12000, remark: "代理软删除用例" },
});
const softAgentDel = await api("DELETE", "/admin/agents/" + historyAgent.body.data.id, { token });
assert(softAgentDel.status === 200 && softAgentDel.body.data?.mode === "soft",
  "代理管理页：有历史数据的代理被软删除（保留 " + ((softAgentDel.body.data?.kept || []).join("、") || "-") + "）");
const agentDel = await api("DELETE", "/admin/agents/" + agentNewId, { token });
const agentAfter = (await api("GET", "/admin/agents", { token })).body.data || [];
assert(agentDel.status === 200 && agentDel.body.data?.mode === "hard" &&
  !agentAfter.some((a) => Number(a.user_id) === Number(agentNewId)),
  "代理管理页：无业务数据的代理被物理删除（剩余 " + agentAfter.length + " 个）");

/* 用户管理：删除账号（软删除 = 打标记 + 匿名化；空白账号物理删；业务员也可以删） */
// ① 造一个「有业务痕迹」的账号（发一条需求），删它应该走软删除
const hisPhone = "13900007812";
const hisCode = await api("POST", "/auth/send-code", { body: { phone: hisPhone } });
const hisLogin = await api("POST", "/auth/login", { body: { phone: hisPhone, code: hisCode.body.data.devCode } });
const hisToken = hisLogin.body.data?.token;
const hisId = hisLogin.body.data?.user?.id;
const hisDemand = await api("POST", "/demands", {
  token: hisToken,
  body: {
    stage: "初中", subject: "数学", address: "西湖区文三路 9 号（删除用例）", lat: 30.2741, lng: 120.1551, budget: 12000,
    remark: "软删除用例",
  },
});
const softDel = await api("DELETE", "/admin/users/" + hisId, { token });
assert(hisDemand.status === 200 && softDel.status === 200 && softDel.body.data?.mode === "soft",
  "用户管理页：有历史数据的账号被软删除（打标记 + 匿名化，保留 " + ((softDel.body.data?.kept || []).join("、") || "-") + "）");
const softGone = await api("GET", "/admin/users?page=1&pageSize=50&keyword=" + hisPhone, { token });
const softStill = await api("GET", "/admin/users?page=1&pageSize=300&includeDeleted=1", { token });
const stillIds = (softStill.body.data?.list || []).map((u) => Number(u.id));
assert((softGone.body.data?.list || []).length === 0 && stillIds.includes(Number(hisId)),
  "用户管理页：软删除的账号默认不列出（includeDeleted=1 仍可查，订单/需求台账保留）");
// ② 业务员也能删
const salesList = await api("GET", "/admin/users?page=1&pageSize=50&role=sales", { token });
const salesUser = (salesList.body.data?.list || [])[0];
const salesDel = await api("DELETE", "/admin/users/" + (salesUser?.id ?? 0), { token });
assert(!!salesUser && salesDel.status === 200,
  "用户管理页：业务员账号也可以删除（" + (salesUser?.nickname || "-") + " / " + (salesDel.body?.data?.mode || salesDel.status) + "）");
// ③ 代理 / 管理员不允许从用户管理删
const agentViaUser = await api("DELETE", "/admin/users/2", { token });
assert(agentViaUser.status >= 400 && (agentViaUser.body?.code === "USE_DEDICATED_PAGE" || /代理管理/.test(agentViaUser.text)),
  "用户管理页：代理账号不走这里删除（引导到代理管理）");
const adminSelf = await api("DELETE", "/admin/users/1", { token });
assert(adminSelf.status >= 400, "用户管理页：管理员账号不可删除（" + adminSelf.status + "）");
// ④ 完全空白的账号物理删除
const newPhone = "13900007811";
const newCode = await api("POST", "/auth/send-code", { body: { phone: newPhone } });
const newLogin = await api("POST", "/auth/login", { body: { phone: newPhone, code: newCode.body.data.devCode } });
const newUserId = newLogin.body.data?.user?.id;
const blankDel = await api("DELETE", "/admin/users/" + newUserId, { token });
const afterDel = await api("GET", "/admin/users?page=1&pageSize=50&keyword=" + encodeURIComponent("13900007811"), { token });
assert(blankDel.status === 200 && blankDel.body.data?.mode === "hard" && (afterDel.body.data?.list || []).length === 0,
  "用户管理页：无业务数据的新账号被物理删除");

/* 关键写操作（与页面按钮一致） */
const banner = (await api("GET", "/admin/banners", { token })).body.data[0];
const bnToggle = await api("POST", "/admin/banners/" + banner.id + "/toggle", { token });
const bnBack = await api("POST", "/admin/banners/" + banner.id + "/toggle", { token });
assert(bnToggle.body.data.status === "off" && bnBack.body.data.status === "on", "运营页：Banner 停用/启用按钮闭环");

const rule = (await api("GET", "/admin/rules", { token })).body.data.rules.find((r) => r.key === "checkin");
const before = rule.value;
const save = await api("PUT", "/admin/rules/checkin", { token, body: { value: { ...before, max_distance_m: 800 } } });
const reload = (await api("GET", "/admin/rules", { token })).body.data.rules.find((r) => r.key === "checkin");
assert(save.status === 200 && reload.value.max_distance_m === 800, "规则页：保存并即时生效（500m → 800m）");
await api("PUT", "/admin/rules/checkin", { token, body: { value: before } });

const csv = await fetch(BASE + "/api/admin/orders/export", { headers: { Authorization: "Bearer " + token } });
const csvText = await csv.text();
assert(csv.status === 200 && /text\/csv/.test(csv.headers.get("content-type")) && csvText.includes("订单号"), "订单页：CSV 导出按钮可用（" + csvText.split("\n")[0].slice(0, 24) + "…）");

/* 越权保护：普通用户不能进后台接口 */
const parentLogin = await api("POST", "/auth/login-password", { body: { phone: "13900000301", password: PW } });
const deny = await api("GET", "/admin/overview", { token: parentLogin.body.data.token });
assert(deny.status === 403, "后台接口对非管理员返回 403（" + deny.status + "）");

/* ---------- 需求池与管理员账号（需求 4.5.3 / 4.5.9） ---------- */
const demands = await api("GET", "/admin/demands?page=1&pageSize=10", { token });
assert(demands.status === 200 && Array.isArray(demands.body.data.list),
  "需求池页：/admin/demands 返回分页列表（" + (demands.body.data?.total ?? 0) + " 条）");
const demandRow = (demands.body.data?.list || []).find((d) => String(d.parentPhone || "").includes("*")) || (demands.body.data?.list || [])[0];
assert(!!demandRow && "statusText" in demandRow && "applications" in demandRow && String(demandRow.parentPhone || "").includes("*"),
  "需求池页：含状态文案/报名数，且家长手机号脱敏（" + demandRow?.parentPhone + "）");

const adminList = await api("GET", "/admin/admins", { token });
assert(adminList.status === 200 && (adminList.body.data || []).some((a) => a.status === "active"),
  "管理员账号页：/admin/admins 返回管理员列表（" + (adminList.body.data || []).length + " 个）");
const newAdmin = await api("POST", "/admin/admins", { token, body: { nickname: "验收管理员", phone: "13900007701" } });
const admPwd = newAdmin.body.data?.initialPassword;
assert(newAdmin.status === 200 && typeof admPwd === "string" && admPwd !== PW && admPwd.length >= 10,
  "管理员账号页：新建管理员返回一次性强口令（" + admPwd + "）");
const newAdminId = newAdmin.body.data?.id;
const disableNew = await api("POST", "/admin/admins/" + newAdminId + "/toggle", { token });
assert(disableNew.status === 200 && disableNew.body.data.status === "disabled", "管理员账号页：可禁用其他管理员");
const selfDisable = await api("POST", "/admin/admins/" + (login.body.data.user.id) + "/toggle", { token });
assert(selfDisable.status === 403 && /当前登录/.test(selfDisable.body?.message || ""),
  "管理员账号页：禁止禁用自己（" + selfDisable.body?.message + "）");

/* ---------- 权限矩阵页（需求 4.5.9） ---------- */
const perms = await api("GET", "/admin/permissions", { token });
assert(perms.status === 200 && (perms.body.data.keys || []).length === 4, "权限矩阵页：/admin/permissions 返回 4 个权限点");
const grant = await api("PUT", "/admin/permissions", {
  token,
  body: { matrix: { ...perms.body.data.matrix, "order.price": ["admin", "agent"] } },
});
assert(grant.status === 200 && (grant.body.data.matrix["order.price"] || []).includes("agent"),
  "权限矩阵页：保存后即时返回新矩阵（order.price 含 agent）");
const restore = await api("PUT", "/admin/permissions", { token, body: { matrix: perms.body.data.matrix } });
assert(restore.status === 200, "权限矩阵页：可恢复默认矩阵");

console.log("\n=================================================");
console.log("PC 管理后台验收：通过 " + pass + " 项，失败 " + fail + " 项");
if (fail) {
  console.log("失败项：");
  failures.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
} else {
  console.log("Vue3 + Vite + Element Plus 后台产物可托管，12 个模块接口全部打通 ✅");
}
console.log("=================================================");
