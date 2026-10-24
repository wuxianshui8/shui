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

/* ---------- 授课地点（P65）：家长也可以到教员处上课 ---------- */
{
  const tLogin = await api("POST", "/auth/login-password", { body: { phone: "13900000201", password: PW } });
  const tTok = tLogin.body.data.token;
  const svcList = await api("GET", "/teacher/services", { token: tTok });
  const svc = (svcList.body.data.list || svcList.body.data || [])[0];
  assert(!!svc, "教员有可预约服务可用于下单（" + (svc && svc.title) + "）");
  const teacherAddr = "西湖区文三路 100 号 3 幢 501（验收用教员处）";

  // 1) 没填授课地址 → 家长不能选「到教员处」
  await api("PUT", "/teacher/profile", { token: tTok, body: { baseAddress: "", lat: 30.2741, lng: 120.1551 } });
  const noAddr = await api("POST", "/orders/from-service", {
    token: parentLogin.body.data.token,
    body: { serviceId: svc.id, lessonTime: new Date(Date.now() + 6 * 86400000).toISOString(), place: "teacher_place" },
  });
  assert(noAddr.status === 400 && noAddr.body.code === "TEACHER_ADDRESS_REQUIRED",
    "教员未填授课地址时「到教员处」被拒（TEACHER_ADDRESS_REQUIRED）");

  // 2) 填好授课地址 → 教员详情可下发、家长可下单
  const setAddr = await api("PUT", "/teacher/profile", { token: tTok, body: { baseAddress: teacherAddr, lat: 30.2741, lng: 120.1551 } });
  assert(setAddr.status === 200 && setAddr.body.data.baseAddress === teacherAddr, "教员资料可保存「授课地址」");
  const at = await api("POST", "/orders/from-service", {
    token: parentLogin.body.data.token,
    body: { serviceId: svc.id, lessonTime: new Date(Date.now() + 7 * 86400000).toISOString(), place: "teacher_place", remark: "后台门禁：到教员处" },
  });
  assert(at.status === 200 && at.body.data.place === "teacher_place" && at.body.data.address === teacherAddr,
    "家长选「到教员处」下单：地点自动用教员授课地址", at.text);
  assert(at.body.data.placeText === "到教员处上课", "订单视图给出「到教员处上课」文案");

  // 3) 后台订单列表也带授课方式（订单页新增列的数据来源）
  const adminOrders = await api("GET", "/admin/orders?page=1&pageSize=20", { token });
  const hit = (adminOrders.body.data.list || []).find((o) => o.id === at.body.data.id);
  assert(!!hit && hit.placeText === "到教员处上课", "后台订单列表下发授课方式（授课方式列有数据）");

  // 4) 不传 place 仍默认上门
  const homeOrder = await api("POST", "/orders/from-service", {
    token: parentLogin.body.data.token,
    body: { serviceId: svc.id, lessonTime: new Date(Date.now() + 8 * 86400000).toISOString() },
  });
  assert(homeOrder.status === 200 && homeOrder.body.data.place === "home", "不传 place 时默认仍为「教员上门」");

  await api("POST", "/orders/" + homeOrder.body.data.id + "/pay", { token: parentLogin.body.data.token, idem: "pay-p66-home-" + homeOrder.body.data.id });
  // P66：到教员处上课 = 双方各打卡一次，都到齐才开课；教员上门订单家长不打卡
  await api("POST", "/orders/" + at.body.data.id + "/pay", { token: parentLogin.body.data.token, idem: "pay-p66-" + at.body.data.id });
  const homeDeny = await api("POST", "/orders/" + homeOrder.body.data.id + "/checkin", {
    token: parentLogin.body.data.token, body: { lat: 30.2741, lng: 120.1551 },
  });
  assert(homeDeny.status === 400 && homeDeny.body.code === "NOT_TEACHER_PLACE",
    "教员上门订单：家长打卡被拒（NOT_TEACHER_PLACE）", homeDeny.text);
  const far = await api("POST", "/orders/" + at.body.data.id + "/checkin", {
    token: parentLogin.body.data.token, body: { lat: 30.35, lng: 120.25 },
  });
  assert(far.status === 400 && far.body.code === "CHECKIN_TOO_FAR", "家长离教学点过远 → 打卡被拒", far.text);
  const pc = await api("POST", "/orders/" + at.body.data.id + "/checkin", {
    token: parentLogin.body.data.token, body: { lat: 30.2742, lng: 120.1552 },
  });
  assert(pc.status === 200 && pc.body.data.parentArrived === true && pc.body.data.status === "pending_class",
    "家长打卡记录到场，但课程要等教员也打卡（双方确认）", pc.text);
  const tc = await api("POST", "/orders/" + at.body.data.id + "/checkin", {
    token: tTok, body: { lat: 30.2741, lng: 120.1551 },
  });
  assert(tc.status === 200 && tc.body.data.status === "in_class" && tc.body.data.bothArrived === true,
    "双方都打卡后自动进入上课中", tc.text);

  // P67：服务级授课形式——服务只支持上门时不能按「到教员处」下单；支持两种时才可以
  const svcOne = await api("PUT", "/teacher/services/" + svc.id, { token: tTok, body: { places: ["home"] } });
  assert(svcOne.status === 200 && svcOne.body.data.placesText === "上门授课", "服务可设为「仅上门授课」", svcOne.text);
  const deniedP = await api("POST", "/orders/from-service", {
    token: parentLogin.body.data.token,
    body: { serviceId: svc.id, lessonTime: new Date(Date.now() + 17 * 86400000).toISOString(), place: "teacher_place" },
  });
  assert(deniedP.status === 400 && deniedP.body.code === "PLACE_NOT_SUPPORTED",
    "服务不支持在教员家授课时，选「到教员处」被拒（PLACE_NOT_SUPPORTED）", deniedP.text);
  const svcTwo = await api("PUT", "/teacher/services/" + svc.id, { token: tTok, body: { places: ["home", "teacher_place"] } });
  assert(svcTwo.status === 200 && svcTwo.body.data.places.length === 2, "服务可同时支持「上门 + 在教员家」", svcTwo.text);

  // 收尾：还原授课地址，避免影响其它门禁
  await api("PUT", "/teacher/profile", { token: tTok, body: { baseAddress: "", lat: 30.2741, lng: 120.1551 } });
}

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


  // 删除管理员：不能删自己；刚建的空白账号物理删除；删完再从列表里消失；重复删 404
  const selfDelete = await api("DELETE", "/admin/admins/" + login.body.data.user.id, { token });
  assert(selfDelete.status === 403 && /当前登录/.test(selfDelete.body?.message || ""),
    "管理员账号页：禁止删除自己（" + selfDelete.body?.message + "）");
  const delNew = await api("DELETE", "/admin/admins/" + newAdminId, { token });
  assert(delNew.status === 200 && ["hard", "soft"].includes(delNew.body.data?.mode),
    "管理员账号页：删除刚建的管理员（mode=" + delNew.body.data?.mode + "，保留 " +
      ((delNew.body.data?.kept || []).join("、") || "无历史") + "）");
  const afterAdminDel = await api("GET", "/admin/admins", { token });
  assert(!(afterAdminDel.body.data || []).some((a) => a.id === newAdminId),
    "管理员账号页：删除后不再出现在列表（软删除也隐藏）");
  const delAgain = await api("DELETE", "/admin/admins/" + newAdminId, { token });
  assert(delAgain.status === 404, "管理员账号页：重复删除返回 404（" + delAgain.status + "）");
  const admAssets = (await import("node:fs")).readdirSync(new URL("../apps/web-admin/dist/assets", import.meta.url));
  const adminsChunk = admAssets.filter((f) => f.startsWith("Admins-") && f.endsWith(".js"));
  assert(adminsChunk.length === 1, "管理员账号页分包存在（Admins-" + adminsChunk.length + "，含删除按钮）");

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


/* ---------- P70 需求池授课形式可见 ---------- */
{
  const ds = await api("GET", "/admin/demands?pageSize=50", { token });
  const list = (ds.body.data && ds.body.data.list) || [];
  assert(ds.status === 200 && list.length > 0, "需求池返回数据（P70）");
  assert(list.every((d) => d.mode === "home" || d.mode === "teacher_place"),
    "需求池每条都带授课形式 mode（教员上门 / 到教员处）", "样例：" + (list[0] && list[0].mode));
}

/* ---------- P71 优惠券：后台建券 → 家长领取 → 下单抵扣 ---------- */
{
  const created = await api("POST", "/admin/coupons", {
    token,
    body: { name: "P71 后台建券 30", amount: 3000, threshold: 10000, total: 5, status: "on" },
  });
  assert(created.status === 200 && Number(created.body.data.amount) === 3000,
    "运营工具：可新建优惠券（减免/门槛/发行量）", created.text.slice(0, 120));
  const cid = created.body.data.id;
  const listAll = await api("GET", "/admin/coupons", { token });
  assert(listAll.status === 200 && listAll.body.data.some((c) => Number(c.id) === Number(cid)),
    "新券出现在优惠券列表里");
  const edit = await api("PUT", "/admin/coupons/" + cid, { token, body: { threshold: 8000, total: 9, validTo: "2027-12-31" } });
  assert(edit.status === 200 && Number(edit.body.data.threshold) === 8000 && Number(edit.body.data.total) === 9,
    "可编辑门槛 / 发行量 / 有效期");

  const publicList = await api("GET", "/public/coupons");
  assert(publicList.status === 200 && publicList.body.data.some((c) => Number(c.id) === Number(cid)),
    "家长端「领取中心」能看到这张券（/public/coupons）");

  const parent = await api("POST", "/auth/login-password", { body: { phone: "13900000301", password: "a123456" } });
  const ptoken = parent.body.data.token;
  const claim = await api("POST", "/parent/coupons/" + cid + "/claim", { token: ptoken });
  assert(claim.status === 200 && claim.body.data.ok, "家长可领取（POST /parent/coupons/:id/claim）", claim.text.slice(0, 100));
  const mine = await api("GET", "/parent/coupons", { token: ptoken });
  assert(mine.status === 200 && mine.body.data.list.some((c) => Number(c.couponId) === Number(cid) && !c.used),
    "领取后进入「我的优惠券」且未使用");
  const again = await api("POST", "/parent/coupons/" + cid + "/claim", { token: ptoken });
  assert(again.status === 400 && again.body.code === "COUPON_CLAIMED", "同一张券不能重复领（COUPON_CLAIMED）");
  const afterClaim = await api("GET", "/admin/coupons", { token });
  const row = afterClaim.body.data.find((c) => Number(c.id) === Number(cid));
  assert(Number(row.claimed) === 1, "领取计数回写到 coupons.claimed（" + row.claimed + "）");

  const ucid = mine.body.data.list.find((c) => Number(c.couponId) === Number(cid)).id;
  const teacher = await api("POST", "/auth/login-password", { body: { phone: "13900000201", password: "a123456" } });
  const services = await api("GET", "/teacher/services?teacherId=4", { token: teacher.body.data.token });
  const svcId = services.body.data[0].id;
  const svcPrice = Number(services.body.data[0].price);
  const mk = await api("POST", "/orders/from-service", {
    token: ptoken,
    body: { serviceId: svcId, lessonTime: new Date(Date.now() + 18 * 86400000).toISOString(), couponId: ucid, remark: "P71 用券" },
  });
  assert(mk.status === 200 && Number(mk.body.data.amount) === svcPrice - 3000,
    "下单用券后应付金额按面额递减（" + svcPrice + "-3000）", "amount=" + (mk.body.data && mk.body.data.amount));
  const usedList = await api("GET", "/parent/coupons", { token: ptoken });
  assert(usedList.body.data.list.find((c) => Number(c.id) === Number(ucid)).used === true,
    "用过的券标记为已使用（并绑定 orderId）");

  const cheap = await api("POST", "/admin/coupons", {
    token, body: { name: "P71 高门槛券", amount: 5000, threshold: 100000, total: 0, status: "on" },
  });
  const c2 = await api("POST", "/parent/coupons/" + cheap.body.data.id + "/claim", { token: ptoken });
  const badUse = await api("POST", "/orders/from-service", {
    token: ptoken,
    body: { serviceId: svcId, lessonTime: new Date(Date.now() + 19 * 86400000).toISOString(), couponId: c2.body.data.userCouponId },
  });
  assert(badUse.status === 400 && /门槛/.test(badUse.body.message || ""), "未达门槛的券下单被拒（不静默放过）", badUse.text.slice(0, 100));
  await api("POST", "/admin/coupons/" + cid + "/toggle", { token });
  await api("POST", "/admin/coupons/" + cheap.body.data.id + "/toggle", { token });
}

/* ---------- P72 Banner 图/链接、公告正文、投诉工单页 ---------- */
{
  const b = await api("POST", "/admin/banners", {
    token, body: { title: "P72 Banner", image: "https://example.com/b.png", link: "/m/pages/parent/index", sort: 3 },
  });
  assert(b.status === 200 && b.body.data.image === "https://example.com/b.png" && b.body.data.link === "/m/pages/parent/index",
    "Banner 可带图片地址与跳转链接（此前只能改标题）");
  const bEdit = await api("PUT", "/admin/banners/" + b.body.data.id, { token, body: { sort: 7 } });
  assert(bEdit.status === 200 && Number(bEdit.body.data.sort) === 7, "Banner 排序可改");
  await api("DELETE", "/admin/banners/" + b.body.data.id, { token });

  /* ---------- P76 Banner 上传图片 + 轮播方式 ---------- */
  // ① 上传接口：base64 图片 → /uploads/xxx.png（后台「上传图片」按钮走的就是这条）
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+2wFQAAAAAElFTkSuQmCC";
  const up = await api("POST", "/upload", { token, body: { dataUrl: png, filename: "banner-p76.png" } });
  assert(up.status === 200 && /^\/uploads\/[\w.-]+\.png$/.test(up.body.data.url || ""),
    "Banner 图可上传并拿到站内地址（/upload → /uploads/xxx.png）", up.body?.data?.url);

  // ② 三种轮播方式都能存下来并回读
  for (const [mode, interval, autoplay] of [["slide", 5, true], ["fade", 3, true], ["none", 8, false]]) {
    const created = await api("POST", "/admin/banners", {
      token,
      body: { title: "P76 轮播 " + mode, image: up.body.data.url, link: "/m/pages/parent/index", status: "on", transition: mode, autoplay, intervalSeconds: interval },
    });
    assert(created.status === 200 && created.body.data.transition === mode &&
      Number(created.body.data.interval_seconds) === interval && Number(created.body.data.autoplay) === (autoplay ? 1 : 0),
      "轮播方式可保存：" + mode + "（间隔 " + interval + "s / 自动 " + (autoplay ? "开" : "关") + "）",
      JSON.stringify({ t: created.body.data?.transition, i: created.body.data?.interval_seconds }));
    const edited = await api("PUT", "/admin/banners/" + created.body.data.id, { token, body: { transition: "fade", intervalSeconds: 6, autoplay: true } });
    assert(edited.status === 200 && edited.body.data.transition === "fade" && Number(edited.body.data.interval_seconds) === 6,
      "轮播方式可改（切到 fade / 6s）");
    await api("DELETE", "/admin/banners/" + created.body.data.id, { token });
  }
  // ③ 非法值回落而不是报错（避免运营填错就 500）
  const fallback = await api("POST", "/admin/banners", { token, body: { title: "P76 非法值", transition: "zoom", intervalSeconds: 999 } });
  assert(fallback.status === 200 && fallback.body.data.transition === "slide" && Number(fallback.body.data.interval_seconds) === 15,
    "非法轮播值回落（zoom→slide、999s→15s）");
  await api("DELETE", "/admin/banners/" + fallback.body.data.id, { token });

  // ④ 家长首页下发的 banners 带轮播配置（移动端据此渲染）
  const homeB = await api("GET", "/public/home?lat=30.262&lng=120.133");
  const bl = (homeB.body.data && homeB.body.data.banners) || [];
  assert(homeB.status === 200 && bl.every((x) => ["slide", "fade", "none"].includes(x.transition)),
    "首页下发的 Banner 都带 transition（移动端按此选轮播方式）", "共 " + bl.length + " 张");

  const a = await api("POST", "/admin/announcements", {
    token, body: { title: "P72 公告", content: "正文内容：国庆期间客服轮班", audience: "all", status: "on" },
  });
  assert(a.status === 200 && (a.body.data.content || "").includes("国庆期间"),
    "公告可保存正文（此前 content 恒为空）");
  const aEdit = await api("PUT", "/admin/announcements/" + a.body.data.id, { token, body: { content: "正文已更新" } });
  assert(aEdit.status === 200 && aEdit.body.data.content === "正文已更新", "公告正文可编辑");
  const pubAnn = await api("GET", "/public/announcements?audience=all");
  assert(pubAnn.status === 200 && pubAnn.body.data.some((x) => x.content === "正文已更新"),
    "家长/教员端能读到公告正文");
  await api("DELETE", "/admin/announcements/" + a.body.data.id, { token });

  const parent = await api("POST", "/auth/login-password", { body: { phone: "13900000301", password: "a123456" } });
  const cp = await api("POST", "/complaints", { token: parent.body.data.token, body: { title: "P72 工单", content: "教员迟到", type: "service" } });
  assert(cp.status === 200, "家长可提交投诉（前置）");
  const list = await api("GET", "/admin/complaints?status=open", { token });
  const row = (list.body.data.list || []).find((c) => c.title === "P72 工单");
  assert(list.status === 200 && !!row && row.statusText === "待受理", "投诉工单独立列表可按状态筛选（含中文状态）");
  assert(typeof list.body.data.openCount === "number", "工单页带未结案计数（" + list.body.data.openCount + "）");
  const accept = await api("POST", "/admin/complaints/" + row.id + "/handle", { token, body: { status: "processing", note: "已联系双方" } });
  assert(accept.status === 200 && accept.body.data.status === "processing" && accept.body.data.handle_note === "已联系双方",
    "可受理工单并写入处理说明");
  const reply = await api("POST", "/admin/complaints/" + row.id + "/handle", { token, body: { status: "replied", note: "已回复家长" } });
  assert(reply.status === 200 && reply.body.data.status === "replied", "可回复工单");
  const badStatus = await api("POST", "/admin/complaints/" + row.id + "/handle", { token, body: { status: "closed" } });
  assert(badStatus.status === 400, "handle 不接受 closed（结案必须走 close，避免绕过审计）");
  const closed = await api("POST", "/admin/complaints/" + row.id + "/close", { token, body: { note: "结案" } });
  assert(closed.status === 200, "可结案（沿用既有 close 语义）");
}

/* ---------- P73 运维任务：此前只有接口没有按钮的 4 个能力 ---------- */
{
  const expire = await api("POST", "/admin/applications/expire", { token });
  assert(expire.status === 200, "运维任务：清理过期报名可用", expire.text.slice(0, 80));
  const closeExpired = await api("POST", "/admin/orders/close-expired", { token });
  assert(closeExpired.status === 200, "运维任务：关闭超时未支付订单可用");
  const reminder = await api("POST", "/admin/reminders/run", { token });
  assert(reminder.status === 200, "运维任务：手动跑上课提醒可用");
  const settle = await api("POST", "/admin/rewards/settle", { token });
  assert(settle.status === 200, "运维任务：结算业务员奖励可用");
}

/* ---------- P74 Prometheus /metrics ---------- */
{
  const m = await api("GET", "/metrics", {});
  const text = m.text || "";
  assert(m.status === 200 && text.startsWith("# HELP jiajiao_up"),
    "/api/metrics 以 Prometheus 文本格式返回（本机可抓）", String(m.status));
  for (const name of ["jiajiao_up", "jiajiao_db_up", "jiajiao_cache_up", "jiajiao_orders", "jiajiao_escrow_yuan_total",
    "jiajiao_risk_events_open", "jiajiao_complaints_open", "jiajiao_refunds_pending", "jiajiao_withdrawals_pending",
    "jiajiao_backup_last_success_timestamp"]) {
    assert(text.includes("# TYPE " + name) && new RegExp("^" + name + "[ {]", "m").test(text),
      "metrics 含指标 " + name);
  }
}

/* ---------- P75 协议文案：后台可改用户协议 / 隐私政策 / 退款规则 ---------- */
{
  const list = await api("GET", "/admin/agreements", { token });
  const keys = (list.body.data || []).map((a) => a.key);
  assert(list.status === 200 && ["user", "privacy", "refund"].every((k) => keys.includes(k)),
    "运营工具：协议页签能列出三份文案（用户协议/隐私政策/退款规则）", keys.join(","));
  const before = list.body.data.find((a) => a.key === "refund");
  assert(!!before && before.content.length > 0, "退款规则已有正文（可编辑）");

  // 修改 → 公开接口立刻能读到 → 再改回原文
  const stamp = "自动验收标记 " + Date.now();
  const saved = await api("PUT", "/admin/agreements/refund", {
    token, body: { title: before.title, content: before.content + "\n" + stamp },
  });
  assert(saved.status === 200 && saved.body.data.content.includes(stamp) && !!saved.body.data.updatedAt,
    "后台保存协议文案成功并刷新 updated_at", saved.body.data && saved.body.data.updatedAt);
  const pub = await api("GET", "/public/agreements/refund");
  assert(pub.status === 200 && pub.body.data.content.includes(stamp),
    "改完立刻生效：公开接口 /public/agreements/refund 读到新正文");
  const pubList = await api("GET", "/public/agreements");
  assert(pubList.status === 200 && (pubList.body.data || []).length >= 3 && !!pubList.body.data[0].updatedAt,
    "公开协议列表带标题与更新时间（前端「其他协议」切换用）");

  const tooShort = await api("PUT", "/admin/agreements/user", { token, body: { content: "短" } });
  assert(tooShort.status === 400, "正文过短被拒（防手滑清空）", tooShort.text.slice(0, 80));
  const noTitle = await api("PUT", "/admin/agreements/user", { token, body: { title: "  " } });
  assert(noTitle.status === 400, "标题为空被拒");
  const missing = await api("PUT", "/admin/agreements/not-exist", { token, body: { content: "随便写点内容超过十个字" } });
  assert(missing.status === 404, "不存在的协议 key 返回 404");

  const restore = await api("PUT", "/admin/agreements/refund", { token, body: { content: before.content } });
  assert(restore.status === 200 && !restore.body.data.content.includes(stamp), "验收后已还原退款规则原文");

  // 普通角色不能改
  const parent = await api("POST", "/auth/login-password", { body: { phone: "13900000301", password: "a123456" } });
  const denied = await api("PUT", "/admin/agreements/user", { token: parent.body.data.token, body: { content: "普通家长尝试改协议内容超过十个字" } });
  assert(denied.status === 403, "家长角色不能改协议（403）", String(denied.status));
}


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
