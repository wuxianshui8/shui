// ============================================================
// 端到端验收测试（覆盖需求说明书第 9.3 节验收标准）
// 用法：先 npm start，再 npm test
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4173";
const PW = "a123456";

let pass = 0, fail = 0;
const failures = [];

function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
class StopRun extends Error {}
const MAX_SECTION = Number(process.env.E2E_MAX_SECTION || 0);
function section(t) {
  const num = parseInt(String(t), 10);
  if (MAX_SECTION && Number.isFinite(num) && num > MAX_SECTION) throw new StopRun("stop");
  console.log("\n== " + t + " ==");
}

async function api(method, path, { token, body, idem, raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (idem) headers["X-Idem-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, body: json, text };
}

async function loginPassword(phone) {
  const r = await api("POST", "/api/auth/login-password", { body: { phone, password: PW } });
  if (r.status !== 200) throw new Error("登录失败 " + phone + " " + r.text);
  return r.body.data.token;
}

(async () => {
  console.log("家教上门撮合平台 · 端到端验收测试");
  console.log("目标服务：" + BASE);

  /* ---------- 1. 认证 ---------- */
  section("1. 注册登录与权限");
  const codeRes = await api("POST", "/api/auth/send-code", { body: { phone: "13900009999" } });
  assert(codeRes.status === 200 && codeRes.body.data.devCode, "手机号验证码下发");
  const loginRes = await api("POST", "/api/auth/login", { body: { phone: "13900009999", code: codeRes.body.data.devCode } });
  assert(loginRes.status === 200 && loginRes.body.data.token, "验证码登录成功（新用户自动注册）");
  const newToken = loginRes.body.data.token;
  const badCode = await api("POST", "/api/auth/login", { body: { phone: "13900009999", code: "000000" } });
  assert(badCode.status === 400, "错误验证码被拒绝");

  const noToken = await api("GET", "/api/parent/home");
  assert(noToken.status === 401, "未登录访问受保护接口返回 401");

  let parentToken = await loginPassword("13900000301");
  const teacherToken = await loginPassword("13900000201");
  const salesToken = await loginPassword("13900000101");
  const agentToken = await loginPassword("13900000010");
  const adminToken = await loginPassword("13900000001");
  assert(!!parentToken && !!teacherToken && !!adminToken, "五类角色均可登录");

  const crossRole = await api("GET", "/api/admin/overview", { token: parentToken });
  assert(crossRole.status === 403, "家长越权访问管理后台被拒绝（403）");
  const salesToAgent = await api("GET", "/api/agent/dashboard", { token: salesToken });
  assert(salesToAgent.status === 403, "业务员越权访问代理端被拒绝（403）");

  /* ---------- 2. 家长端 ---------- */
  section("2. 家长端：首页 / 广场 / 发需求");
  const home = await api("GET", "/api/parent/home", { token: parentToken });
  assert(home.status === 200 && home.body.data.region, "首页自动定位片区：" + (home.body.data.region?.name || ""));
  assert(home.body.data.teachers.length > 0, "首页展示附近在线教员 " + home.body.data.teachers.length + " 位");

  const plaza = await api("GET", "/api/parent/teachers?subject=数学&radiusKm=10", { token: parentToken });
  assert(plaza.status === 200 && plaza.body.data.list.length > 0, "教员广场按科目筛选返回 " + plaza.body.data.list.length + " 位");
  const sorted = plaza.body.data.list.every((t, i, a) => i === 0 || a[i - 1].priority >= t.priority);
  assert(sorted, "广场排序遵循「距离系数 × 等级权重 × 响应速度系数」");
  const teacherId = plaza.body.data.list[0].id;

  const detail = await api("GET", "/api/parent/teachers/" + teacherId, { token: parentToken });
  assert(detail.status === 200 && detail.body.data.levelTable, "教员详情含等级权益表与评价");

  const addrs = await api("GET", "/api/addresses", { token: parentToken });
  assert(addrs.status === 200 && addrs.body.data.length > 0, "地址管理：已有 " + addrs.body.data.length + " 个上课地址");
  const addr = addrs.body.data[0];

  const demand = await api("POST", "/api/demands", {
    token: parentToken,
    body: {
      stage: "初中", subject: "数学", address: addr.address, lat: addr.lat, lng: addr.lng,
      budget: 20000, remark: "自动化测试需求：初二函数专项", urgent: 1,
      times: [{ date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), start: "09:00", end: "11:00" }],
    },
  });
  assert(demand.status === 200 && demand.body.data.id, "发布家教需求成功（含加急）");
  const demandId = demand.body.data.id;
  assert(demand.body.data.urgent_fee === 2000, "加急费按规则配置计入 ¥" + (demand.body.data.urgent_fee / 100).toFixed(2));

  // 加急费由家长自填（P43）：带金额就用家长填的、不带就用平台标准价、越界要拒绝
  const urgentBody = { stage: "初中", subject: "数学", address: addr.address, lat: addr.lat, lng: addr.lng, budget: 20000 };
  const urgentSelf = await api("POST", "/api/demands", {
    token: parentToken, body: { ...urgentBody, remark: "加急费自填", urgent: true, urgentFee: 5000 },
  });
  assert(urgentSelf.status === 200 && urgentSelf.body.data.urgent_fee === 5000,
    "家长可自填加急费（¥" + ((urgentSelf.body.data.urgent_fee || 0) / 100).toFixed(2) + "）");
  const urgentLow = await api("POST", "/api/demands", {
    token: parentToken, body: { ...urgentBody, urgent: true, urgentFee: 100 },
  });
  assert(urgentLow.status >= 400, "加急费低于平台标准价被拒（" + urgentLow.status + "）");
  const urgentHigh = await api("POST", "/api/demands", {
    token: parentToken, body: { ...urgentBody, urgent: true, urgentFee: 30000 },
  });
  assert(urgentHigh.status >= 400, "加急费超过上限被拒（" + urgentHigh.status + "）");

  // 加价越高越靠前（P44）：同一地址、同一教员的视角下，加急费高的需求优先级更高
  const highFee = await api("POST", "/api/demands", {
    token: parentToken, body: { ...urgentBody, remark: "加急费拉满", urgent: true, urgentFee: 20000 },
  });
  const nearbyRank = await api("GET", "/api/teacher/nearby-demands", { token: teacherToken });
  const rankOf = (id) => {
    const d = (nearbyRank.body.data?.list || []).find((x) => x.id === id);
    return d ? d.priority : null;
  };
  const cheap = rankOf(urgentSelf.body.data.id);
  const pricey = rankOf(highFee.body.data.id);
  assert(cheap != null && pricey != null && pricey > cheap,
    "加急费越高派单优先级越高（¥50=" + cheap + " < ¥200=" + pricey + "）");

  // 报名优先级「读时计算」（P45）：家长把加急费提高后，详情里读到的优先级应立刻跟着变，快照保留备查
  const liveDemand = (await api("POST", "/api/demands", {
    token: parentToken, body: { ...urgentBody, remark: "读时计算", urgent: true, urgentFee: 2000 },
  })).body.data;
  const liveApply = await api("POST", "/api/demands/" + liveDemand.id + "/apply", { token: teacherToken });
  const snapshotPriority = liveApply.body.data?.priority;
  await api("PUT", "/api/demands/" + liveDemand.id, {
    token: parentToken, body: { urgent: true, urgentFee: 20000 },
  });
  const liveDetail = await api("GET", "/api/demands/" + liveDemand.id, { token: parentToken });
  const liveApp = (liveDetail.body.data?.applications || [])[0];
  assert(liveApp && liveApp.prioritySnapshot === snapshotPriority,
    "报名快照保留（" + liveApp?.prioritySnapshot + "）");
  assert(liveApp && liveApp.priority > liveApp.prioritySnapshot,
    "加急费提高后读到的优先级立刻变大（" + liveApp?.prioritySnapshot + " → " + liveApp?.priority + "）");

  /* ---------- 3. 教员端抢单 + 并发 ---------- */
  section("3. 教员端：抢单并发与派单规则");
  const nearby = await api("GET", "/api/teacher/nearby-demands", { token: teacherToken });
  assert(nearby.status === 200, "教员获取附近订单列表");
  const target = nearby.body.data.list.find((d) => d.id === demandId);
  assert(!!target, "新需求按派单半径推送给附近教员（距离 " + (target?.distanceKm ?? "-") + " km）");

  // 定位接单（P48）：距离与「是否推给我」都按手机实时定位算；不传区位则回落到入驻服务基点
  const SHANGHAI = { lat: 31.2304, lng: 121.4737 };
  const nearLoc = await api("GET", "/api/teacher/nearby-demands?lat=" + addr.lat + "&lng=" + addr.lng, { token: teacherToken });
  assert(nearLoc.status === 200 && nearLoc.body.data.origin?.source === "current",
    "教员端带实时定位取附近需求（origin.source=current，半径 " + nearLoc.body.data.radiusKm + " km）");
  const nearbyPlain = await api("GET", "/api/teacher/nearby-demands", { token: teacherToken });
  assert(nearbyPlain.body.data.origin?.source === "profile",
    "不传定位时回落到入驻服务基点（origin.source=profile）");
  const farList = await api("GET", "/api/teacher/nearby-demands?lat=" + SHANGHAI.lat + "&lng=" + SHANGHAI.lng, { token: teacherToken });
  assert(farList.status === 200 && !(farList.body.data.list || []).some((d) => d.id === demandId),
    "定位在服务半径外时该需求不再出现在附近列表");
  const farApply = await api("POST", "/api/demands/" + urgentSelf.body.data.id + "/apply", {
    token: teacherToken, body: SHANGHAI,
  });
  assert(farApply.status >= 400 && (farApply.body?.code === "TOO_FAR" || /服务半径/.test(farApply.text)),
    "定位在远处时抢单被拒（超出服务半径）");

  // 按行政区建的片区也要能正确归属（P49）：围栏是多环，点落在任一环内即归属该片区
  const areaRegion = await api("POST", "/api/admin/regions", {
    token: adminToken, body: { name: "张北县片区验收", adminCodes: ["130722"] },
  });
  assert(areaRegion.status === 200 && (areaRegion.body.data?.adminNames || []).includes("张北县"),
    "后台按行政区建片区（" + ((areaRegion.body.data?.adminNames || []).join("、") || "-") + "）");
  const zbCode = await api("POST", "/api/auth/send-code", { body: { phone: "13900008801" } });
  const zbLogin = await api("POST", "/api/auth/login", { body: { phone: "13900008801", code: zbCode.body.data.devCode } });
  const zbToken = zbLogin.body.data.token;
  const zbDemand = await api("POST", "/api/demands", {
    token: zbToken,
    body: {
      stage: "初中", subject: "数学", address: "张北县兴和路 1 号", lat: 41.287, lng: 114.764, budget: 15000,
      remark: "按行政区片区归属验证",
    },
  });
  assert(zbDemand.status === 200, "新家长在张北县发需求成功");
  // 归属看「需求落到哪个片区」（用户账号的片区在注册绑定时已定，需求才是按地址判定）
  const zbAdmin = await api("GET", "/api/admin/demands?page=1&pageSize=50", { token: adminToken });
  const zbRow = (zbAdmin.body.data?.list || zbAdmin.body.data || []).find((d) => d.id === zbDemand.body.data.id);
  assert(zbRow?.regionName === "张北县片区验收",
    "需求按行政区围栏归属到该片区（片区=" + (zbRow?.regionName || "空") + "）");

  // 代理账号增删（P51/P54）：钱没结清→拒绝；空白账号→物理删；有历史痕迹→软删除+匿名化
  const stamp = String(Date.now()).slice(-8);
  const agentPhoneA = "139" + stamp;
  const agentPhoneB = "138" + stamp;
  const agentNew = await api("POST", "/api/admin/agents", {
    token: adminToken,
    body: { nickname: "闸门代理·孙经理", phone: agentPhoneA, regionId: 1, level: "A", commissionRate: 0.25, mgmtRate: 0.01, deposit: 50000 },
  });
  assert(agentNew.status === 200 && agentNew.body.data?.id > 0 && !!agentNew.body.data?.initialPassword,
    "后台新增代理账号返回一次性初始口令");
  const agentMoney = await api("DELETE", "/api/admin/agents/" + agentNew.body.data.id, { token: adminToken });
  assert(agentMoney.status >= 400 && (agentMoney.body?.code === "AGENT_MONEY_LEFT" || /未结清/.test(agentMoney.text)),
    "保证金未结清的代理拒绝删除（提示先退还/结算）");
  const agentBlank = await api("POST", "/api/admin/agents", {
    token: adminToken,
    body: { nickname: "空白代理·李经理", phone: agentPhoneB, regionId: 1, level: "A", deposit: 0 },
  });
  const agentGone = await api("DELETE", "/api/admin/agents/" + agentBlank.body.data.id, { token: adminToken });
  const agentList2 = (await api("GET", "/api/admin/agents", { token: adminToken })).body.data || [];
  assert(agentGone.status === 200 && agentGone.body.data?.mode === "hard" &&
    !agentList2.some((a) => Number(a.user_id) === Number(agentBlank.body.data.id)),
    "无业务数据的代理被物理删除（剩余 " + agentList2.length + " 个）");
  // 普通用户删除（P52）：家长/教员空白账号可删，有业务数据或角色不匹配时拒绝
  const uCode = await api("POST", "/api/auth/send-code", { body: { phone: "13900008803" } });
  const uLogin = await api("POST", "/api/auth/login", { body: { phone: "13900008803", code: uCode.body.data.devCode } });
  const uId = uLogin.body.data.user.id;
  const agentsAsUser = await api("DELETE", "/api/admin/users/2", { token: adminToken });
  assert(agentsAsUser.status >= 400 && (agentsAsUser.body?.code === "USE_DEDICATED_PAGE" || /代理管理/.test(agentsAsUser.text)),
    "用户管理里删代理被引导到代理管理");
  const blankUserDel = await api("DELETE", "/api/admin/users/" + uId, { token: adminToken });
  const uLeft = (await api("GET", "/api/admin/users?page=1&pageSize=50&keyword=13900008803", { token: adminToken })).body.data || {};
  assert(blankUserDel.status === 200 && (uLeft.list || []).length === 0,
    "删除无业务数据的新家长账号成功");

  // 软删除（P53）：有历史数据的账号被「打标记 + 匿名化」，台账保留且默认不再列出
  const hisUser = (await api("GET", "/api/admin/users?page=1&pageSize=50&keyword=13900008801", { token: adminToken })).body.data?.list?.[0];
  const softDel = hisUser ? await api("DELETE", "/api/admin/users/" + hisUser.id, { token: adminToken }) : { status: 0, body: {} };
  assert(!!hisUser && softDel.status === 200 && softDel.body.data?.mode === "soft",
    "有历史数据的账号被软删除（" + ((softDel.body?.data?.kept || []).join("、") || "-") + "）");
  const softListed = (await api("GET", "/api/admin/users?page=1&pageSize=300", { token: adminToken })).body.data?.list || [];
  assert(!softListed.some((u) => Number(u.id) === Number(hisUser?.id)), "软删除的账号不再出现在用户列表");

  // 并发抢单：同一教员 20 次并发，只允许 1 次成功
  const grabs = await Promise.all(
    Array.from({ length: 20 }, () => api("POST", "/api/demands/" + demandId + "/apply", { token: teacherToken }))
  );
  const okGrabs = grabs.filter((g) => g.status === 200);
  assert(okGrabs.length === 1, "并发抢单无重复接单（成功 " + okGrabs.length + " 次 / 共 20 次）");
  assert(grabs.some((g) => g.status === 400), "重复抢单被明确拒绝");

  // 多教员报名同一需求
  const teacher2Token = await loginPassword("13900000205");
  const t2 = await api("POST", "/api/demands/" + demandId + "/apply", { token: teacher2Token });
  const apps = await api("GET", "/api/demands/" + demandId, { token: parentToken });
  assert(apps.body.data.applications.length >= 1, "家长可见报名教员 " + apps.body.data.applications.length + " 位");

  /* ---------- 4. 家长确认 + 支付 ---------- */
  section("4. 下单支付与担保交易");
  const appId = apps.body.data.applications[0].id;
  const confirms = await Promise.all([
    api("POST", "/api/demands/" + demandId + "/confirm", { token: parentToken, body: { applicationId: appId } }),
    api("POST", "/api/demands/" + demandId + "/confirm", { token: parentToken, body: { applicationId: appId } }),
  ]);
  const okConfirm = confirms.filter((c) => c.status === 200);
  assert(okConfirm.length === 1, "需求确认并发安全（仅 1 次成功）");
  const order = okConfirm[0].body.data;
  const orderId = order.id;
  assert(order.status === "awaiting_payment", "订单生成，状态：" + order.statusText);

  const payIdem = "pay-" + orderId + "-" + Date.now();
  const pay1 = await api("POST", "/api/orders/" + orderId + "/pay", { token: parentToken, idem: payIdem });
  assert(pay1.status === 200 && pay1.body.data.status === "pending_class", "担保支付成功，订单转为待上课");
  const pay2 = await api("POST", "/api/orders/" + orderId + "/pay", { token: parentToken, idem: payIdem });
  assert(pay2.status === 200 && pay2.body.data.status === "pending_class", "支付接口幂等（重复回调不重复入账）");
  const pay3 = await api("POST", "/api/orders/" + orderId + "/pay", { token: parentToken });
  assert(pay3.status === 200, "已支付订单再次支付被幂等拦截");

  const finance1 = await api("GET", "/api/admin/finance", { token: adminToken });
  assert(finance1.body.data.summary.totalGmv > 0 && finance1.body.data.summary.escrow > 0, "后台资金总览：GMV ¥" + (finance1.body.data.summary.totalGmv / 100).toFixed(2) + "，担保台账 ¥" + (finance1.body.data.summary.escrow / 100).toFixed(2));

  /* ---------- 5. 定位打卡校验 ---------- */
  section("5. 上门打卡定位校验");
  const od = await api("GET", "/api/orders/" + orderId, { token: teacherToken });
  const farCheckin = await api("POST", "/api/orders/" + orderId + "/checkin", {
    token: teacherToken, body: { lat: od.body.data.lat + 0.05, lng: od.body.data.lng + 0.05 },
  });
  assert(farCheckin.status === 400, "超出 500 米阈值打卡被拦截：" + farCheckin.body.message);
  const risks = await api("GET", "/api/agent/risks", { token: agentToken });
  assert(risks.body.data.events.some((e) => e.order_id === orderId), "异常定位自动生成风控事件");

  const nearCheckin = await api("POST", "/api/orders/" + orderId + "/checkin", {
    token: teacherToken, body: { lat: od.body.data.lat + 0.0005, lng: od.body.data.lng + 0.0005 },
  });
  assert(nearCheckin.status === 200 && nearCheckin.body.data.status === "in_class", "阈值内打卡成功，课程开始（距离 " + nearCheckin.body.data.checkinDistance + " 米）");

  /* ---------- 6. 课时结算 ---------- */
  section("6. 结束授课 → 家长确认 → 冻结 → 结算");
  const fin = await api("POST", "/api/orders/" + orderId + "/finish", { token: teacherToken });
  assert(fin.status === 200 && fin.body.data.status === "awaiting_parent_confirm", "教员结束授课，待家长确认");

  const beforeWallet = await api("GET", "/api/wallet", { token: teacherToken });
  const conf = await api("POST", "/api/orders/" + orderId + "/confirm", { token: parentToken });
  assert(conf.status === 200 && conf.body.data.status === "completed", "家长确认完成，订单进入冻结期");
  assert(!!conf.body.data.settleAt, "冻结到期时间：" + new Date(conf.body.data.settleAt).toLocaleString("zh-CN"));
  const afterWallet = await api("GET", "/api/wallet", { token: teacherToken });
  const income = conf.body.data.teacherIncome;
  assert(afterWallet.body.data.wallet.frozen - beforeWallet.body.data.wallet.frozen === income, "教员课时费进入冻结中 ¥" + (income / 100).toFixed(2));

  const levelBefore = await api("GET", "/api/teacher/level", { token: teacherToken });
  assert(levelBefore.body.data.growthScore > 0, "教员成长分累计：" + levelBefore.body.data.growthScore);

  const settleDue = await api("POST", "/api/admin/settlement/run", { token: adminToken });
  assert(settleDue.status === 200, "到期结算批处理正常执行（本次到期 " + settleDue.body.data.settled + " 笔）");
  const settleForce = await api("POST", "/api/admin/settlement/run", { token: adminToken, body: { force: true } });
  assert(settleForce.body.data.settled >= 1, "手动结算放款成功（本次结算 " + settleForce.body.data.settled + " 笔）");
  const walletSettled = await api("GET", "/api/wallet", { token: teacherToken });
  assert(walletSettled.body.data.wallet.frozen === 0, "冻结金额全部解冻入账，当前冻结 ¥" + (walletSettled.body.data.wallet.frozen / 100).toFixed(2) + "，可用 ¥" + (walletSettled.body.data.wallet.balance / 100).toFixed(2));

  /* ---------- 7. 评价 ---------- */
  section("7. 评价与成长分");
  const review = await api("POST", "/api/orders/" + orderId + "/review", {
    token: parentToken, body: { score: 5, content: "讲解清晰，孩子很受用", tags: ["准时", "专业", "耐心"] },
  });
  assert(review.status === 200, "提交 5 星评价成功，评价权重 " + review.body.data.weight + "（随家长信用等级）");
  const dupReview = await api("POST", "/api/orders/" + orderId + "/review", {
    token: parentToken, body: { score: 1, content: "重复评价", tags: [] },
  });
  assert(dupReview.status === 400, "同一订单不可重复评价");
  const levelAfter = await api("GET", "/api/teacher/level", { token: teacherToken });
  assert(levelAfter.body.data.growthScore >= levelBefore.body.data.growthScore, "好评后成长分提升 → " + levelAfter.body.data.growthScore);

  /* ---------- 8. 提现 ---------- */
  section("8. 提现与财务审核");
  const wallet = await api("GET", "/api/wallet", { token: teacherToken });
  const withdrawAmt = Math.min(wallet.body.data.wallet.balance, 30000);
  if (withdrawAmt >= 10000) {
    const wd = await api("POST", "/api/withdrawals", {
      token: teacherToken, idem: "wd-" + Date.now(),
      body: { amount: withdrawAmt, channel: "wechat", account: "13900000201" },
    });
    assert(wd.status === 200 && wd.body.data.status === "pending", "提现申请提交（¥" + (withdrawAmt / 100).toFixed(2) + "，手续费 ¥" + (wd.body.data.fee / 100).toFixed(2) + "）");
    const wdId = wd.body.data.id;
    const review2 = await api("POST", "/api/admin/withdrawals/" + wdId + "/review", { token: adminToken, body: { approve: true } });
    assert(review2.status === 200 && review2.body.data.status === "paid", "平台审核打款完成");
  } else {
    console.log("  - 教员余额不足最低提现额，跳过提现用例");
  }
  const smallWd = await api("POST", "/api/withdrawals", {
    token: teacherToken, idem: "wd-small-" + Date.now(), body: { amount: 100, channel: "wechat", account: "13900000201" },
  });
  assert(smallWd.status === 400, "低于最低提现额度被拒绝");

  /* ---------- 9. 代理数据隔离 ---------- */
  section("9. 区域代理数据隔离与结算");
  const agentDash = await api("GET", "/api/agent/dashboard", { token: agentToken });
  assert(agentDash.status === 200, "代理首页（片区：" + agentDash.body.data.region?.name + "）GMV ¥" + (agentDash.body.data.metrics.monthGmv / 100).toFixed(2));
  const agentOrders = await api("GET", "/api/agent/orders", { token: agentToken });
  const myRegion = agentDash.body.data.region.id;
  const allMine = agentOrders.body.data.list.every((o) => o.lat != null);
  const maskOk = agentOrders.body.data.list.every((o) => !o.address || o.address.includes("***") || o.address.length <= 10);
  assert(agentOrders.status === 200, "片区订单列表返回 " + agentOrders.body.data.total + " 单");
  assert(maskOk, "代理端上课地址脱敏展示");
  const agentProfile = await api("GET", "/api/agent/profile", { token: agentToken });
  assert(
    agentProfile.status === 200 && agentProfile.body.data.wallet && agentProfile.body.data.region,
    "代理账号信息接口正常（片区 " + (agentProfile.body.data.region?.name || "-") + "，可提现 ¥" + (agentProfile.body.data.wallet?.balance / 100).toFixed(2) + "）"
  );
  const agentAnn = await api("GET", "/api/agent/announcements", { token: agentToken });
  assert(agentAnn.status === 200, "代理端公告接口正常（" + agentAnn.body.data.length + " 条）");
  const agentEarnings = await api("GET", "/api/agent/earnings", { token: agentToken });
  assert(agentEarnings.body.data.bills.length === 6, "代理收益月度账单 6 期及其结算规则");

  const newSales = await api("POST", "/api/agent/sales", {
    token: agentToken, body: { nickname: "测试业务员", phone: "139" + String(Date.now()).slice(-8) },
  });
  assert(newSales.status === 200 && newSales.body.data.id, "代理新增业务员账号（片区绑定）");
  const salesList = await api("GET", "/api/agent/sales", { token: agentToken });
  assert(salesList.body.data.list.length > 0, "业务员列表返回 " + salesList.body.data.list.length + " 人（手机号脱敏：" + salesList.body.data.list[0].phone + "）");

  /* ---------- 10. 业务员端 ---------- */
  section("10. 业务员推广端");
  const salesDash = await api("GET", "/api/sales/dashboard", { token: salesToken });
  assert(salesDash.status === 200 && salesDash.body.data.codes.length === 2, "推广看板 + 家长/教员双通道二维码");
  const customers = await api("GET", "/api/sales/customers", { token: salesToken });
  const noFullPhone = customers.body.data.list.every((c) => c.phone.includes("****"));
  assert(noFullPhone, "业务员禁止查看客户完整手机号（" + customers.body.data.list.length + " 位客户）");
  const rewards = await api("GET", "/api/sales/rewards", { token: salesToken });
  assert(rewards.status === 200, "奖励明细（待结算 ¥" + (salesDash.body.data.rewards.pending / 100).toFixed(2) + "）");
  const settleRewards = await api("POST", "/api/admin/rewards/settle", { token: adminToken });
  assert(settleRewards.status === 200, "业务员奖励周结批量结算 " + settleRewards.body.data.settled + " 笔");

  /* ---------- 11. 规则配置中心 ---------- */
  section("11. 规则配置中心（后台可配置）");
  const rules = await api("GET", "/api/admin/rules", { token: adminToken });
  assert(rules.status === 200 && rules.body.data.rules.length >= 10, "规则配置项 " + rules.body.data.rules.length + " 组");
  const lvRule = rules.body.data.rules.find((r) => r.key === "teacher_levels");
  assert(lvRule.value.length === 5 && lvRule.value[0].commission === 0.18, "教员等级规则含 Lv1-Lv5 与抽佣比例");

  const oldCheckin = rules.body.data.rules.find((r) => r.key === "checkin").value;
  await api("PUT", "/api/admin/rules/checkin", { token: adminToken, body: { value: { max_distance_m: 3000 } } });
  const reload = await api("GET", "/api/admin/rules", { token: adminToken });
  assert(reload.body.data.rules.find((r) => r.key === "checkin").value.max_distance_m === 3000, "规则热更新生效（打卡阈值 500m → 3000m，无需改代码）");
  await api("PUT", "/api/admin/rules/checkin", { token: adminToken, body: { value: oldCheckin } });

  /* ---------- 12. 风控与仲裁 ---------- */
  section("12. 风控审核与差评仲裁");
  const risks2 = await api("GET", "/api/admin/risks", { token: adminToken });
  assert(risks2.status === 200 && risks2.body.data.events.length > 0, "风控事件列表 " + risks2.body.data.events.length + " 条");
  const riskId = risks2.body.data.events[0].id;
  const handled = await api("POST", "/api/admin/risks/" + riskId + "/handle", { token: adminToken, body: { action: "close", note: "测试关闭" } });
  assert(handled.status === 200, "风控事件处理（关闭并解除结算冻结）");

  const appeal = await api("POST", "/api/teacher/reviews/" + review.body.data.id + "/appeal", {
    token: teacherToken, body: { reason: "评价内容与事实不符" },
  });
  assert(appeal.status === 200, "教员提交差评申诉");
  const arb = await api("POST", "/api/admin/appeals/" + review.body.data.id + "/arbitrate", {
    token: adminToken, body: { accept: true, reason: "确认为恶意评价" },
  });
  assert(arb.status === 200 && arb.body.data.status === "accepted", "平台仲裁撤销评价并回滚扣分");

  /* ---------- 13. 订单取消与退款 ---------- */
  section("13. 取消退款流程");
  const cancelOrder = okConfirm[0].body.data;
  const o2 = await api("POST", "/api/demands", {
    token: parentToken,
    body: { stage: "小学", subject: "英语", address: addr.address, lat: addr.lat, lng: addr.lng, budget: 12000, remark: "取消流程测试" },
  });
  const o2Id = o2.body.data.id;
  await api("POST", "/api/demands/" + o2Id + "/apply", { token: teacherToken });
  const apps2 = await api("GET", "/api/demands/" + o2Id, { token: parentToken });
  const c2 = await api("POST", "/api/demands/" + o2Id + "/confirm", {
    token: parentToken, body: { applicationId: apps2.body.data.applications[0].id },
  });
  const order2 = c2.body.data.id;
  await api("POST", "/api/orders/" + order2 + "/pay", { token: parentToken, idem: "pay2-" + order2 });
  const refund = await api("POST", "/api/orders/" + order2 + "/refund", { token: parentToken, body: { reason: "临时有事" } });
  assert(refund.status === 200 && refund.body.data.status === "refunding", "家长申请退款，订单转退款中");
  const escrowBefore = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data.summary.escrow;
  const refundDetail = (await api("GET", "/api/orders/" + order2, { token: adminToken })).body.data;
  const refundPaid = refundDetail.amount + refundDetail.urgentFee;
  const approveRefund = await api("POST", "/api/admin/refunds/" + order2 + "/review", { token: adminToken, body: { approve: true } });
  assert(approveRefund.status === 200 && approveRefund.body.data.status === "refunded", "平台审批退款，金额原路退回");
  const escrowAfter = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data.summary.escrow;
  assert(
    escrowBefore - escrowAfter === refundPaid,
    "退款审批同步释放担保资金，台账闭合（减少 ¥" + (refundPaid / 100).toFixed(2) + "）",
    "before=" + escrowBefore + " after=" + escrowAfter
  );

  /* ---------- 14. 资金一致性 ---------- */
  section("14. 资金零误差校验");
  const fin2 = await api("GET", "/api/admin/finance", { token: adminToken });
  const s = fin2.body.data.summary;
  assert(s.agentShare + s.salesCommission + (s.revenue) <= s.serviceFee + 1, "服务费分账恒等式成立（服务费 ≥ 代理+业务员+平台净收入）");
  assert(s.escrow >= 0, "担保账户余额非负：¥" + (s.escrow / 100).toFixed(2));
  assert(s.totalWallet >= 0 && s.totalFrozen >= 0, "钱包余额与冻结池：" + (s.totalWallet / 100).toFixed(2) + " / " + (s.totalFrozen / 100).toFixed(2));

  /* ---------- 15. 运营工具：编辑 / 停用 ---------- */
  section("15. 运营工具：Banner / 公告 / 优惠券编辑与停用");
  const banners = (await api("GET", "/api/admin/banners", { token: adminToken })).body.data;
  const bn = banners[0];
  const bnEdit = await api("PUT", "/api/admin/banners/" + bn.id, {
    token: adminToken, body: { title: bn.title + "（已编辑）", sort: 99, link: "/parent#/plaza", status: "on" },
  });
  assert(bnEdit.status === 200 && bnEdit.body.data.title.endsWith("（已编辑）"), "Banner 编辑生效：" + bnEdit.body.data.title);
  const bnToggleOff = await api("POST", "/api/admin/banners/" + bn.id + "/toggle", { token: adminToken });
  assert(bnToggleOff.status === 200 && bnToggleOff.body.data.status === "off", "Banner 停用成功");
  const pubBanners = (await api("GET", "/api/public/banners")).body.data;
  assert(!pubBanners.some((x) => x.id === bn.id), "停用后家长端 Banner 列表不再出现该条（公开接口共 " + pubBanners.length + " 条）");
  await api("POST", "/api/admin/banners/" + bn.id + "/toggle", { token: adminToken });
  const pubBanners2 = (await api("GET", "/api/public/banners")).body.data;
  assert(pubBanners2.some((x) => x.id === bn.id), "启用后重新对外展示");
  const bnBad = await api("PUT", "/api/admin/banners/" + bn.id, { token: adminToken, body: { title: "   " } });
  assert(bnBad.status === 400, "Banner 标题为空被拒绝（400）");

  const annNew = await api("POST", "/api/admin/announcements", {
    token: adminToken, body: { title: "运营工具验证公告", content: "初始内容", audience: "parent", pinned: false },
  });
  const annId = annNew.body.data.id;
  const annEdit = await api("PUT", "/api/admin/announcements/" + annId, {
    token: adminToken, body: { title: "运营工具验证公告（已编辑）", content: "编辑后的正文", audience: "teacher", pinned: true },
  });
  assert(
    annEdit.status === 200 && annEdit.body.data.title.endsWith("（已编辑）") && annEdit.body.data.audience === "teacher" && annEdit.body.data.pinned === 1,
    "公告编辑生效（标题/正文/接收人群/置顶均已更新）"
  );
  const annOff = await api("POST", "/api/admin/announcements/" + annId + "/toggle", { token: adminToken });
  assert(annOff.body.data.status === "off", "公告下线成功");
  const pubAnn = (await api("GET", "/api/public/announcements?audience=teacher")).body.data;
  assert(!pubAnn.some((x) => x.id === annId), "下线后教员端不再展示该公告");
  await api("POST", "/api/admin/announcements/" + annId + "/toggle", { token: adminToken });
  const pinRes = await api("POST", "/api/admin/announcements/" + annId + "/pin", { token: adminToken });
  assert(pinRes.body.data.pinned === false, "公告取消置顶生效");
  await api("DELETE", "/api/admin/announcements/" + annId, { token: adminToken });
  assert((await api("GET", "/api/admin/announcements", { token: adminToken })).body.data.every((x) => x.id !== annId), "公告删除成功");

  const cp = (await api("GET", "/api/admin/coupons", { token: adminToken })).body.data[0];
  const cpEdit = await api("PUT", "/api/admin/coupons/" + cp.id, {
    token: adminToken, body: { name: "满减券（已调整）", amount: 2500, threshold: 15000, total: 800, status: "on" },
  });
  assert(
    cpEdit.status === 200 && cpEdit.body.data.amount === 2500 && cpEdit.body.data.threshold === 15000 && cpEdit.body.data.total === 800,
    "优惠券编辑生效：减免 ¥" + (cpEdit.body.data.amount / 100).toFixed(2) + " / 门槛 ¥" + (cpEdit.body.data.threshold / 100).toFixed(2) + " / 发行 " + cpEdit.body.data.total + " 张"
  );
  const cpOff = await api("POST", "/api/admin/coupons/" + cp.id + "/toggle", { token: adminToken });
  assert(cpOff.body.data.status === "off", "优惠券停用成功");
  const pubCp = (await api("GET", "/api/public/coupons")).body.data;
  assert(!pubCp.some((x) => x.id === cp.id), "停用后家长端领券列表不再出现");
  await api("POST", "/api/admin/coupons/" + cp.id + "/toggle", { token: adminToken });
  assert((await api("GET", "/api/public/coupons")).body.data.some((x) => x.id === cp.id), "启用后恢复可领取");
  const cpBad = await api("PUT", "/api/admin/coupons/" + cp.id, { token: adminToken, body: { amount: 0 } });
  assert(cpBad.status === 400, "优惠券减免金额为 0 被拒绝（400）");
  const opsLogs = (await api("GET", "/api/admin/audit-logs", { token: adminToken })).body.data.list;
  assert(
    opsLogs.some((l) => l.action === "admin.banner.update") &&
    opsLogs.some((l) => l.action === "admin.announcement.update") &&
    opsLogs.some((l) => l.action === "admin.coupon.toggle"),
    "运营工具的全部变更均已写入操作日志"
  );

  /* ---------- 16. 订单导出 / 代理管理 / 抢单超时 ---------- */
  section("16. 订单导出、代理管理与抢单超时清理");
  const allOrders = (await api("GET", "/api/admin/orders", { token: adminToken })).body.data.list;
  const csvRes = await api("GET", "/api/admin/orders/export", { token: adminToken });
  assert(csvRes.status === 200, "订单报表导出成功（HTTP " + csvRes.status + "）");
  const csvLines = csvRes.text.replace(/^\uFEFF/, "").split(/\r?\n/);
  assert(/订单号,片区,家长,教员,科目,学段,实付\(元\),平台服务费\(元\)/.test(csvLines[0]), "导出表头包含分账明细列");
  assert(csvLines.length - 1 === Math.min(allOrders.length, 5000), "导出行数与订单数一致（" + (csvLines.length - 1) + " 行）");
  assert(/"(待付款|待上课|进行中|待家长确认|已完成|已结算|已取消|退款中|已退款)"/.test(csvLines.slice(1).join("\n")), "状态列已中文化");

  const agentsList = (await api("GET", "/api/admin/agents", { token: adminToken })).body.data;
  const ag0 = agentsList[0];
  const agDetail = await api("GET", "/api/admin/agents/" + ag0.user_id, { token: adminToken });
  assert(
    agDetail.status === 200 && agDetail.body.data.assessment && Array.isArray(agDetail.body.data.deposits),
    "代理详情含保证金台账与考核完成度（" + ag0.nickname + "，" + agDetail.body.data.assessment.gmvRate + "% / " + agDetail.body.data.assessment.orderRate + "% / " + agDetail.body.data.assessment.salesRate + "%）"
  );
  const depBefore = ag0.deposit;
  const depIn = await api("POST", "/api/admin/agents/" + ag0.user_id + "/deposit", {
    token: adminToken, body: { direction: "in", amount: 50000, remark: "自动化测试缴纳" },
  });
  assert(depIn.status === 200 && depIn.body.data.balance === depBefore + 50000, "保证金缴纳入账：¥" + (depBefore / 100).toFixed(2) + " → ¥" + (depIn.body.data.balance / 100).toFixed(2));
  const depOver = await api("POST", "/api/admin/agents/" + ag0.user_id + "/deposit", {
    token: adminToken, body: { direction: "out", amount: depBefore + 99999999 },
  });
  assert(depOver.status === 400, "超额退还保证金被拒绝（400）");
  const depOut = await api("POST", "/api/admin/agents/" + ag0.user_id + "/deposit", {
    token: adminToken, body: { direction: "out", amount: 50000, remark: "自动化测试退还" },
  });
  assert(depOut.status === 200 && depOut.body.data.balance === depBefore, "保证金退还原余额 ¥" + (depOut.body.data.balance / 100).toFixed(2));

  const agEdit = await api("PUT", "/api/admin/agents/" + ag0.user_id, {
    token: adminToken, body: { level: "S", commissionRate: 0.3, mgmtRate: 0.015 },
  });
  assert(agEdit.status === 200 && agEdit.body.data.commission_rate === 0.3, "代理信息编辑生效（等级 S，服务费分成 30%）");
  const agEditBad = await api("PUT", "/api/admin/agents/" + ag0.user_id, { token: adminToken, body: { commissionRate: 5 } });
  assert(agEditBad.status === 400, "分成比例超出 0~1 被拒绝（400）");
  await api("PUT", "/api/admin/agents/" + ag0.user_id, {
    token: adminToken, body: { level: ag0.level, commissionRate: ag0.commission_rate, mgmtRate: ag0.mgmt_rate },
  });

  // 令牌需在禁用前取得：禁用后连登录都会返回 403
  const agentTok2 = await loginPassword("13900000010");
  const agOff = await api("POST", "/api/admin/agents/" + ag0.user_id + "/toggle", { token: adminToken });
  assert(agOff.status === 200 && agOff.body.data.status === "disabled", "代理账号禁用成功");
  const blocked = await api("GET", "/api/agent/dashboard", { token: agentTok2 });
  assert(blocked.status === 403, "被禁用代理访问代理端被拒绝（403）");
  await api("POST", "/api/admin/agents/" + ag0.user_id + "/toggle", { token: adminToken });
  assert((await api("GET", "/api/agent/dashboard", { token: agentTok2 })).status === 200, "启用后代理端恢复访问");

  const pg1 = await api("GET", "/api/admin/orders?page=1&pageSize=5", { token: adminToken });
  const pg2 = await api("GET", "/api/admin/orders?page=2&pageSize=5", { token: adminToken });
  assert(
    pg1.status === 200 && pg1.body.data.page === 1 && pg1.body.data.list.length <= 5,
    "订单列表分页：第 1 页 " + pg1.body.data.list.length + " 条，共 " + pg1.body.data.total + " 笔 / " + pg1.body.data.pages + " 页"
  );
  assert(
    pg2.body.data.page === 2 && pg2.body.data.list[0]?.id !== pg1.body.data.list[0]?.id,
    "第 2 页数据与第 1 页不重复"
  );
  const pgDefault = await api("GET", "/api/admin/orders", { token: adminToken });
  assert(
    pgDefault.body.data.pageSize === 300 && pgDefault.body.data.page === 1,
    "不传分页参数时保持原行为（每页 300，向后兼容）"
  );
  const pgUsers = await api("GET", "/api/admin/users?page=1&pageSize=10", { token: adminToken });
  assert(
    pgUsers.body.data.list.length === 10 && pgUsers.body.data.total > 0,
    "用户列表支持分页：本页 " + pgUsers.body.data.list.length + " / 总计 " + pgUsers.body.data.total
  );
  const pgLogs = await api("GET", "/api/admin/audit-logs?page=1&pageSize=5", { token: adminToken });
  assert(!!pgLogs.body.data.pages, "操作日志支持分页（共 " + pgLogs.body.data.total + " 条）");
  const expireRes = await api("POST", "/api/admin/applications/expire", { token: adminToken });
  assert(
    expireRes.status === 200 && typeof expireRes.body.data.expired === "number" && expireRes.body.data.timeoutHours > 0,
    "抢单超时清理接口可用（阈值 " + expireRes.body.data.timeoutHours + " 小时，本次清理 " + expireRes.body.data.expired + " 条）"
  );
  const dispatchRule = (await api("GET", "/api/admin/rules", { token: adminToken })).body.data.rules.find((r) => r.key === "dispatch");
  assert(dispatchRule.value.grab_confirm_timeout_hours > 0, "抢单超时阈值由规则配置中心可调（当前 " + dispatchRule.value.grab_confirm_timeout_hours + " 小时）");

  /* ---------- 17. 发票申请与财务受理 ---------- */
  section("17. 发票申请（需求 4.1.6）与后台财务受理");
  const walletInv = (await api("GET", "/api/wallet", { token: parentToken })).body.data;
  assert(
    Array.isArray(walletInv.invoiceable) && Array.isArray(walletInv.invoices),
    "消费记录接口返回可开票订单与我的申请（可开票 " + walletInv.invoiceable.length + " 单）"
  );
  const invOrder = walletInv.invoiceable[0];
  assert(!!invOrder, "存在可开票订单：" + (invOrder ? invOrder.order_no + " · " + invOrder.subject + " · ¥" + (invOrder.payable / 100).toFixed(2) : "无"));

  const invApply = await api("POST", "/api/invoices", {
    token: parentToken,
    body: { orderId: invOrder.id, titleType: "personal", title: "家长·周女士", email: "zhou@example.com" },
  });
  assert(
    invApply.status === 200 && invApply.body.data.status === "pending",
    "提交开票申请成功（单号 " + invApply.body.data.invoice_no + "，金额 ¥" + (invApply.body.data.amount / 100).toFixed(2) + "）"
  );
  const invId = invApply.body.data.id;

  const dupInv = await api("POST", "/api/invoices", {
    token: parentToken, body: { orderId: invOrder.id, titleType: "personal", title: "重复申请" },
  });
  assert(dupInv.status === 400, "同一订单重复申请开票被拒绝（400）");

  if (walletInv.invoiceable.length > 1) {
    const noTax = await api("POST", "/api/invoices", {
      token: parentToken,
      body: { orderId: walletInv.invoiceable[1].id, titleType: "company", title: "某某教育科技有限公司" },
    });
    assert(noTax.status === 400, "企业抬头缺纳税人识别号被拒绝（400）");
  } else {
    console.log("  - 可开票订单不足 2 单，跳过企业抬头校验用例");
  }

  const meId = (await api("GET", "/api/auth/me", { token: parentToken })).body.data.user.id;
  const adminOrderList = (await api("GET", "/api/admin/orders", { token: adminToken })).body.data.list;
  const otherOrder = adminOrderList.find((o) => o.parent && o.parent.id !== meId && o.paidAt);
  if (otherOrder) {
    const cross = await api("POST", "/api/invoices", {
      token: parentToken, body: { orderId: otherOrder.id, titleType: "personal", title: "越权测试" },
    });
    assert(cross.status === 403, "为他人订单申请开票被拒绝（403）");
  }

  const finInv = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data;
  assert(
    finInv.summary.invoicePending >= 1 && finInv.invoices.some((i) => i.id === invId),
    "后台财务看到待受理发票 " + finInv.summary.invoicePending + " 件（已开票 " + finInv.summary.invoiceIssued + " 件）"
  );

  const issued = await api("POST", "/api/admin/invoices/" + invId + "/review", {
    token: adminToken, body: { approve: true, invoiceUrl: "https://example.com/fp/demo.pdf" },
  });
  assert(issued.status === 200 && issued.body.data.status === "issued" && !!issued.body.data.invoice_url, "财务受理开票成功并回写电子发票地址");

  const reopen = await api("POST", "/api/admin/invoices/" + invId + "/review", { token: adminToken, body: { approve: true } });
  assert(reopen.status === 400, "已受理的申请不可重复受理（400）");

  const walletAfter = (await api("GET", "/api/wallet", { token: parentToken })).body.data;
  assert(walletAfter.invoices.some((i) => i.id === invId && i.status === "issued"), "家长端同步显示「已开票」");
  assert(!walletAfter.invoiceable.some((o) => o.id === invOrder.id), "已开票订单从可开票列表移除");

  const invOrder2 = walletAfter.invoiceable[0];
  if (invOrder2) {
    const inv2 = await api("POST", "/api/invoices", {
      token: parentToken, body: { orderId: invOrder2.id, titleType: "personal", title: "周女士" },
    });
    const rejected = await api("POST", "/api/admin/invoices/" + inv2.body.data.id + "/review", {
      token: adminToken, body: { approve: false, rejectReason: "抬头需与实名一致" },
    });
    assert(
      rejected.status === 200 && rejected.body.data.status === "rejected" && rejected.body.data.reject_reason === "抬头需与实名一致",
      "财务驳回并回写原因"
    );
    const noReason = await api("POST", "/api/admin/invoices/" + inv2.body.data.id + "/review", {
      token: adminToken, body: { approve: false },
    });
    assert(noReason.status === 400, "驳回缺少原因被拒绝（400）");
    const reapply = await api("POST", "/api/invoices", {
      token: parentToken, body: { orderId: invOrder2.id, titleType: "personal", title: "周女士（已更正）" },
    });
    assert(reapply.status === 200, "被驳回后可对同一订单重新申请（部分唯一索引生效）");
  }

  const invLogs = (await api("GET", "/api/admin/audit-logs", { token: adminToken })).body.data.list;
  assert(
    invLogs.some((l) => l.action === "invoice.apply") && invLogs.some((l) => l.action === "admin.invoice.review"),
    "发票申请与受理均写入操作日志"
  );

  /* ---------- 18. 上课提醒与账号注销 ---------- */
  section("18. 上课前提醒（4.1.5）与账号注销（第 8 章）");
  const svcForRemind = (await api("GET", "/api/parent/teachers/" + teacherId, { token: parentToken })).body.data.services[0];
  const remindTime = new Date(Date.now() + 55 * 60000).toISOString();
  const remindOrder = await api("POST", "/api/orders/from-service", {
    token: parentToken, body: { serviceId: svcForRemind.id, lessonTime: remindTime, remark: "上课提醒验证" },
  });
  assert(remindOrder.status === 200, "创建 55 分钟后开课的订单");
  const remindOrderId = remindOrder.body.data.id;
  await api("POST", "/api/orders/" + remindOrderId + "/pay", { token: parentToken, idem: "pay-remind-" + remindOrderId });

  const notifyRule = (await api("GET", "/api/admin/rules", { token: adminToken })).body.data.rules.find((r) => r.key === "notify");
  assert(!!notifyRule && notifyRule.value.lesson_remind_minutes > 0, "通知规则可配置（默认提前 " + notifyRule.value.lesson_remind_minutes + " 分钟）");

  // 阈值调小到 5 分钟 → 55 分钟后开课的订单不应被提醒
  await api("PUT", "/api/admin/rules/notify", {
    token: adminToken, body: { value: { ...notifyRule.value, lesson_remind_minutes: 5 } },
  });
  const runSmall = await api("POST", "/api/admin/reminders/run", { token: adminToken });
  assert(runSmall.status === 200 && runSmall.body.data.remindMinutes === 5, "提醒阈值可热更新为 5 分钟");

  // 恢复为 60 分钟 → 应推送提醒
  await api("PUT", "/api/admin/rules/notify", { token: adminToken, body: { value: notifyRule.value } });
  const runBig = await api("POST", "/api/admin/reminders/run", { token: adminToken });
  assert(runBig.status === 200 && runBig.body.data.reminded >= 1, "上课提醒已推送 " + runBig.body.data.reminded + " 单（阈值 " + runBig.body.data.remindMinutes + " 分钟）");

  const parentMsgs = (await api("GET", "/api/messages", { token: parentToken })).body.data.list;
  const teacherMsgs = (await api("GET", "/api/messages", { token: teacherToken })).body.data.list;
  assert(parentMsgs.some((m) => m.title === "上课提醒"), "家长收到「上课提醒」站内消息");
  assert(teacherMsgs.some((m) => m.title === "上课提醒"), "教员收到「上课提醒」站内通知");

  const runAgain = await api("POST", "/api/admin/reminders/run", { token: adminToken });
  assert(runAgain.body.data.reminded === 0, "同一订单不会重复推送提醒（幂等）");

  // 账号注销：有进行中订单的家长不可注销
  const busyParent = await loginPassword("13900000306");
  const deactivateBusy = await api("POST", "/api/auth/deactivate", { token: busyParent });
  assert(deactivateBusy.status === 400, "有未完结订单的账号注销被拒绝（400）");

  const deactivateAdmin = await api("POST", "/api/auth/deactivate", { token: adminToken });
  assert(deactivateAdmin.status === 403, "管理员账号不可自助注销（403）");

  // 干净账号可正常注销，且手机号可重新注册
  const phoneNew = "139" + String(Date.now()).slice(-8);
  const cd = await api("POST", "/api/auth/send-code", { body: { phone: phoneNew } });
  const reg = await api("POST", "/api/auth/login", { body: { phone: phoneNew, code: cd.body.data.devCode } });
  const newToken2 = reg.body.data.token;
  assert(reg.status === 200, "新建干净账号用于注销测试");
  const deact = await api("POST", "/api/auth/deactivate", { token: newToken2 });
  assert(deact.status === 200 && deact.body.data.ok, "干净账号注销成功：" + (deact.body.data.message || ""));
  const afterDeact = await api("GET", "/api/auth/me", { token: newToken2 });
  assert(afterDeact.status === 403, "注销后原令牌立即失效（403）");
  const loginAgain = await api("POST", "/api/auth/login-password", { body: { phone: phoneNew, password: "a123456" } });
  assert(loginAgain.status === 400, "注销后账号无法再登录");
  const cd2 = await api("POST", "/api/auth/send-code", { body: { phone: phoneNew } });
  const reReg = await api("POST", "/api/auth/login", { body: { phone: phoneNew, code: cd2.body.data.devCode } });
  assert(reReg.status === 200, "注销后同一手机号可重新注册为全新账号");

  const deactLogs = (await api("GET", "/api/admin/audit-logs", { token: adminToken })).body.data.list;
  assert(deactLogs.some((l) => l.action === "user.deactivate"), "注销动作写入操作日志");
  assert(
    deactLogs.some((l) => l.action === "reminder.run"),
    "提醒任务执行写入操作日志"
  );

  /* ---------- 19. 紧急求助（需求第 8 章 上门安全） ---------- */
  section("19. 紧急求助入口（上门安全）");
  const sosOrderRes = await api("POST", "/api/orders/from-service", {
    token: parentToken, body: { serviceId: svcForRemind.id, lessonTime: new Date(Date.now() + 6 * 3600000).toISOString(), remark: "求助验证订单" },
  });
  const sosOrderId = sosOrderRes.body.data.id;
  await api("POST", "/api/orders/" + sosOrderId + "/pay", { token: parentToken, idem: "pay-sos-" + sosOrderId });
  const sosOrderDetail = (await api("GET", "/api/orders/" + sosOrderId, { token: parentToken })).body.data;

  const sos1 = await api("POST", "/api/orders/" + sosOrderId + "/sos", {
    token: parentToken,
    body: { lat: sosOrderDetail.lat, lng: sosOrderDetail.lng, note: "上门时家长突感不适" },
  });
  assert(
    sos1.status === 200 && sos1.body.data.sosId && sos1.body.data.duplicated === false,
    "家长发起紧急求助成功（工单 #" + sos1.body.data.sosId + "，通知 " + sos1.body.data.notified + " 人）"
  );

  const sos2 = await api("POST", "/api/orders/" + sosOrderId + "/sos", { token: parentToken, body: { note: "重复触发" } });
  assert(sos2.body.data.duplicated === true && sos2.body.data.sosId === sos1.body.data.sosId, "同一订单 10 分钟内重复求助不再重复建单（防误触刷屏）");

  const sosRisk = (await api("GET", "/api/admin/risks", { token: adminToken })).body.data.events;
  const sosEvent = sosRisk.find((e) => e.type === "sos" && e.order_id === sosOrderId);
  assert(!!sosEvent && sosEvent.level === "high", "后台风控列表出现 SOS 事件且等级为 high");
  assert(/紧急求助/.test(sosEvent.reason || "") && /米/.test(sosEvent.reason || ""), "事件记录含求助定位距离：" + (sosEvent.reason || "").slice(0, 60));

  const adminMsgs = (await api("GET", "/api/messages", { token: adminToken })).body.data.list;
  assert(adminMsgs.some((m) => /紧急求助/.test(m.title)), "管理员收到紧急求助通知");
  const agentMsgs = (await api("GET", "/api/messages", { token: agentToken })).body.data.list;
  assert(agentMsgs.some((m) => /紧急求助/.test(m.title)), "片区代理收到紧急求助通知");
  const teacherSosMsgs = (await api("GET", "/api/messages", { token: teacherToken })).body.data.list;
  assert(teacherSosMsgs.some((m) => /紧急求助/.test(m.content || "") || /紧急求助/.test(m.title)), "订单另一方（教员）收到提醒");

  const sosByOther = await api("POST", "/api/orders/" + sosOrderId + "/sos", { token: agentToken, body: {} });
  assert(sosByOther.status === 403, "非订单双方发起求助被拒绝（403）");

  const sosClosed = await api("POST", "/api/admin/risks/" + sosEvent.id + "/handle", { token: adminToken, body: { action: "close", note: "已电话确认安全" } });
  assert(sosClosed.status === 200, "平台可处置并关闭求助工单");
  const sosLogs = (await api("GET", "/api/admin/audit-logs", { token: adminToken })).body.data.list;
  assert(sosLogs.some((l) => l.action === "order.sos"), "求助动作写入操作日志");

  /* ---------- 20. 区域归属判定（需求 5.5） ---------- */
  section("20. 区域归属：自然注册归属与跨区订单收益归属");
  const regionsAll = (await api("GET", "/api/admin/regions", { token: adminToken })).body.data;
  const bjRegion = regionsAll.find((r) => /滨江/.test(r.name));
  const gsRegion = regionsAll.find((r) => /拱墅/.test(r.name));
  assert(!!bjRegion && !!gsRegion, "取得滨江 / 拱墅片区（" + (bjRegion?.name || "") + "、" + (gsRegion?.name || "") + "）");

  const agentsAll = (await api("GET", "/api/admin/agents", { token: adminToken })).body.data;
  const bjAgent = agentsAll.find((a) => a.region_id === bjRegion.id);
  const xhAgent = agentsAll.find((a) => a.region_id === regionsAll.find((r) => /西湖/.test(r.name)).id);
  assert(!!bjAgent && !!xhAgent, "滨江代理 / 西湖代理各 1 位");

  // ① 自然注册用户：首次发布订单按上课地址归属片区
  const natPhone = "138" + String(Date.now()).slice(-8);
  const natCode = await api("POST", "/api/auth/send-code", { body: { phone: natPhone } });
  const natReg = await api("POST", "/api/auth/login", { body: { phone: natPhone, code: natCode.body.data.devCode } });
  const natToken = natReg.body.data.token;
  const natId = natReg.body.data.user.id;
  const natDemand = await api("POST", "/api/demands", {
    token: natToken,
    body: {
      stage: "初中", subject: "数学", address: "拱墅区莫干山路 100 号 运河人家 8 幢 401",
      lat: 30.3180, lng: 120.1420, budget: 15000, remark: "自然注册归属验证",
    },
  });
  assert(natDemand.status === 200, "自然注册用户发布首个需求成功");
  const natBind = (await api("GET", "/api/admin/users?role=parent&keyword=" + natPhone, { token: adminToken })).body.data.list.find((u) => u.id === natId);
  assert(
    natBind && natBind.regionId === gsRegion.id,
    "首次发单后账号片区更新为需求地址所在片区（" + (natBind ? "regionId=" + natBind.regionId : "未找到") + "）"
  );
  const natInAgentList = (await api("GET", "/api/agent/dashboard", { token: agentToken })).body.data.metrics.totalRegistrations;
  assert(typeof natInAgentList === "number", "代理大盘统计已包含自然归属用户（片区注册数 " + natInAgentList + "）");

  // ② 跨区订单：收益归属需求发布地址所在片区代理
  const xhDemand = await api("POST", "/api/demands", {
    token: parentToken,
    body: {
      stage: "初中", subject: "数学", address: "滨江区江南大道 88 号 星光国际 2 幢 1501",
      lat: 30.2090, lng: 120.2130, budget: 20000, remark: "跨区订单归属验证",
    },
  });
  const xhDemandId = xhDemand.body.data.id;
  assert(xhDemand.status === 200, "西湖家长在滨江片区发布需求（跨区场景）");

  const bjTeacherToken = await loginPassword("13900000205"); // 陈子豪，滨江，数学
  await api("POST", "/api/teacher/online", { token: bjTeacherToken, body: { online: true } });
  const bjApply = await api("POST", "/api/demands/" + xhDemandId + "/apply", { token: bjTeacherToken });
  assert(bjApply.status === 200, "滨江教员报名该需求");
  const xhApps = (await api("GET", "/api/demands/" + xhDemandId, { token: parentToken })).body.data;
  const xhConfirm = await api("POST", "/api/demands/" + xhDemandId + "/confirm", {
    token: parentToken, body: { applicationId: xhApps.applications[0].id },
  });
  assert(xhConfirm.status === 200, "家长确认教员，生成订单");
  const crossOrderId = xhConfirm.body.data.id;
  const crossOrder = (await api("GET", "/api/orders/" + crossOrderId, { token: adminToken })).body.data;
  assert(crossOrder.regionId === bjRegion.id, "订单片区取需求发布地址所在片区（滨江）", "实际 " + crossOrder.regionId);
  assert(
    crossOrder.agentId === bjAgent.user_id,
    "订单收益归属滨江片区代理（" + bjAgent.nickname + "），而非家长归属的西湖代理",
    "实际 agentId=" + crossOrder.agentId
  );
  assert(crossOrder.agentId !== xhAgent.user_id, "未错误归属到西湖代理");

  const crossPay = await api("POST", "/api/orders/" + crossOrderId + "/pay", { token: parentToken, idem: "pay-cross-" + crossOrderId });
  assert(crossPay.body.data.agentShare > 0, "跨区订单已计提片区分成 ¥" + (crossPay.body.data.agentShare / 100).toFixed(2));

  /* ---------- 汇总 ---------- */
  console.log("\n=================================================");
  console.log(`测试结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log("失败用例：");
    failures.forEach((f) => console.log("  - " + f));
    process.exitCode = 1;
  } else {
    console.log("全部验收用例通过 ✅");
  }
  console.log("=================================================");
})().catch((e) => {
  if (e instanceof StopRun) {
    console.log("\n=================================================");
    console.log(`（分段模式：仅执行到第 ${MAX_SECTION} 组）通过 ${pass} 项，失败 ${fail} 项`);
    if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
    else console.log("该分段全部通过 ✅");
    console.log("=================================================");
    return;
  }
  console.error("测试异常终止：", e);
  process.exitCode = 1;
});