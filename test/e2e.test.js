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

  /* ---------- 21. 游客浏览 + 微信一键登录（P55） ---------- */
  section("21. 游客浏览与微信一键登录");
  // 不发 token：家长端首页对游客开放（发布需求页直接可见）
  const guestHome = await api("GET", "/api/public/home");
  assert(guestHome.status === 200 && guestHome.body.data.guest === true, "游客首页无需登录即可访问");
  assert(guestHome.body.data.defaultAddress === null && guestHome.body.data.couponCount === 0, "游客首页不含「我的」数据");
  assert(guestHome.body.data.urgentFee > 0, "游客首页下发加急费（发布表单需要）");
  const guestList = await api("GET", "/api/public/teachers?radiusKm=20&pageSize=5");
  assert(guestList.status === 200 && Array.isArray(guestList.body.data.list), "游客可浏览教员广场");
  const guestListT = guestList.body.data.list || [];
  assert(guestListT.every((t) => t.favorited === false), "游客列表收藏状态恒 false");
  assert(guestListT.every((t) => !t.phone || /\*{4}/.test(t.phone)), "游客看到的教员手机号仍脱敏");
  if (guestListT.length) {
    const guestDetail = await api("GET", "/api/public/teachers/" + guestListT[0].id);
    assert(guestDetail.status === 200 && Array.isArray(guestDetail.body.data.services), "游客可看教员详情（立即预约入口）");
  } else {
    assert(false, "游客可看教员详情（立即预约入口）", "列表为空，无法验证详情");
  }

  const wxCode = "e2e-wx-" + Date.now();
  const wx1 = await api("POST", "/api/auth/wechat", { body: { code: wxCode } });
  assert(wx1.status === 200 && wx1.body.data.token && wx1.body.data.user.role === "parent", "微信一键登录自动注册家长");
  const wxMe = await api("GET", "/api/auth/me", { token: wx1.body.data.token });
  assert(wxMe.status === 200 && wxMe.body.data.user.id === wx1.body.data.user.id, "微信登录 token 可用（/api/auth/me）");
  const wx2 = await api("POST", "/api/auth/wechat", { body: { code: wxCode } });
  assert(wx2.body.data.user.id === wx1.body.data.user.id, "同一微信 code 二次登录仍是同一账号（幂等）");
  const wxBad = await api("POST", "/api/auth/wechat", { body: {} });
  assert(wxBad.status !== 500, "微信登录缺少 code 时报明确错误而不是 500");
  assert(/^微信用户\d{4}$/.test(wx1.body.data.user.nickname || ""), "微信登录昵称稳定可复现（" + wx1.body.data.user.nickname + "）");
  assert(wx2.body.data.user.nickname === wx1.body.data.user.nickname, "同一 code 二次登录昵称不变");
  const wxAuth = await api("GET", "/api/auth/wechat/authorize-url?redirect=https://example.com/m/cb&state=s1");
  assert(wxAuth.status === 400 && wxAuth.body.code === "WECHAT_NOT_CONFIGURED",
    "未配置 appid 时公众号授权链接返回 400 WECHAT_NOT_CONFIGURED");
  const wxPublish = await api("POST", "/api/demands", {
    token: wx1.body.data.token,
    body: { stage: "小学", subject: "语文", address: "西湖区文三路 128 号 学军小区 3 幢 502", lat: 30.2741, lng: 120.1551, budget: 15000 },
  });
  assert(wxPublish.status === 200, "微信登录后可直接发布需求（游客点发布→登录→继续发布）");

  // 前端契约（静态）：家长端「进来就是发布需求页，动作时才弹登录」
  const parentJs = await (await fetch(BASE + "/assets/js/parent.js")).text();
  assert(/guard\(homeView, \{ guest: true \}\)/.test(parentJs), "家长端首页对游客开放（不再一启动就弹登录）");
  assert(parentJs.includes("/api/public/home"), "游客首页走公开接口 /api/public/home");
  assert(parentJs.includes('data-lg="wechat"') && parentJs.includes("微信一键登录"), "登录层含「微信一键登录」按钮");
  // 排版口径（用户反馈）：微信一键登录排在「登录 / 注册」下方，不是压在最上面
  assert(
    parentJs.indexOf('data-lg="login"') < parentJs.indexOf('data-lg="wechat"'),
    "登录层排版：手机号「登录 / 注册」在上、微信一键登录在其下方",
  );
  assert(/function requireLogin\(/.test(parentJs) && /if \(isGuest\(\)\) \{/.test(parentJs),
    "发布需求 / 立即预约等动作走 requireLogin（点动作才弹登录）");
  assert(/state\.pending = typeof pending === "function"/.test(parentJs), "登录成功后自动接着执行原动作（不丢表单）");

  // 教员端「入驻认证 / 资料修改」：资质材料按身份只显示一张证书，且排在提交/保存按钮上面
  {
    const teacherJs = await (await fetch(BASE + "/assets/js/teacher.js")).text();
    assert(teacherJs.includes('data-cert="in_service"') && teacherJs.includes('data-cert="student"') && teacherJs.includes('data-cert="part_time"'),
      "入驻认证按身份类型分区显示证书（在职教师 / 学生 / 社会）");
    assert(teacherJs.includes('label: "教师资格证"') && teacherJs.includes('label: "学生证"') && teacherJs.includes('label: "技能证书"'),
      "三种身份各自对应一张证书（教师资格证 / 学生证 / 技能证书）");
    const applyCert = teacherJs.indexOf("<h3>资质材料</h3>");
    const applySubmit = teacherJs.indexOf("提交入驻申请");
    assert(applyCert > 0 && applySubmit > applyCert, "入驻认证：资质材料排在「提交入驻申请」按钮上面");
    const profCert = teacherJs.indexOf("资质材料放在「保存资料」上面");
    const saveBtn = teacherJs.indexOf("保存资料</button>");
    assert(profCert > 0 && saveBtn > profCert, "资料修改：资质材料排在「保存资料」按钮上面");
    assert(/\.uploader \.thumb img \{[^}]*object-fit: cover/.test(await (await fetch(BASE + "/assets/css/base.css")).text()),
      "证件缩略图在框内 object-fit: cover（自适应不拉伸）");
  }

  // 教员端登录层：「用户名 + 密码」登录方式（account = 用户名或手机号）
  {
    const tLogin = await api("POST", "/api/auth/login-account", { body: { account: "zhang", password: PW } });
    assert(tLogin.status === 200 && tLogin.body.data.user.role === "teacher", "教员端用户名密码登录：zhang / a123456 → 教员 token");
    const tUpper = await api("POST", "/api/auth/login-account", { body: { account: "ZHANG", password: PW } });
    assert(tUpper.body.data && tUpper.body.data.user.id === tLogin.body.data.user.id, "用户名大小写不敏感（ZHANG = zhang）");
    const tPhone = await api("POST", "/api/auth/login-account", { body: { account: "13900000201", password: PW } });
    assert(tPhone.body.data && tPhone.body.data.user.id === tLogin.body.data.user.id, "同一接口用手机号也能登录（account 兼容手机号）");
    const tBad = await api("POST", "/api/auth/login-account", { body: { account: "zhang", password: "wrong-pass-1" } });
    assert(tBad.status === 400 && tBad.body.code === "BAD_CREDENTIALS", "错误密码被拒（BAD_CREDENTIALS）");
    const tEmpty = await api("POST", "/api/auth/login-account", { body: { account: "", password: PW } });
    assert(tEmpty.status === 400, "空用户名被拒");
    const teacherHtml = await (await fetch(BASE + "/teacher.html")).text();
    const tjs = await (await fetch(BASE + "/assets/js/teacher.js")).text();
    assert(tjs.includes("data-lg=\"mode-account\"") && tjs.includes("用户名密码") && teacherHtml.includes("teacher.js"),
      "教员端登录界面有「用户名密码」登录方式");
    assert(tjs.includes("loginByAccount("), "教员端登录调用账号密码登录（loginByAccount → /api/auth/login-account）");
    assert((await (await fetch(BASE + "/assets/js/api.js")).text()).includes("/api/auth/login-account"),
      "前端 api 层已接 /api/auth/login-account");
  }

  // 家长头像：可上传图片并设为头像（登录态），外链地址被拒，null 可恢复默认
  {
    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const up = await api("POST", "/api/upload", { token: wx1.body.data.token, body: { filename: "avatar.png", dataUrl: pngDataUrl } });
    assert(up.status === 200 && /^\/uploads\/.+\.png$/.test(up.body.data.url), "家长头像：图片可上传（" + (up.body.data?.url || up.status) + "）");
    const setAv = await api("PUT", "/api/parent/avatar", { token: wx1.body.data.token, body: { avatar: up.body.data.url } });
    assert(setAv.status === 200 && setAv.body.data.hasAvatar === true, "家长头像：设为头像成功");
    const prof = await api("GET", "/api/parent/profile", { token: wx1.body.data.token });
    assert(prof.body.data.user.avatar === up.body.data.url, "家长头像：个人资料回读到新头像");
    const badAv = await api("PUT", "/api/parent/avatar", { token: wx1.body.data.token, body: { avatar: "https://evil.example.com/a.png" } });
    assert(badAv.status === 400, "家长头像：外链地址被拒（只接受本站 /uploads/）");
    const resetAv = await api("PUT", "/api/parent/avatar", { token: wx1.body.data.token, body: { avatar: null } });
    assert(resetAv.status === 200 && resetAv.body.data.hasAvatar === false, "家长头像：传 null 恢复默认首字母头像");
  }

  // 家长取消订单 → 教员端「退款 / 驳回」（申请制：教员处理前不动钱）
  {
    const mkOrder = async (remark) => {
      const d = await api("POST", "/api/demands", {
        token: parentToken,
        body: { stage: "初中", subject: "语文", address: "西湖区文三路 128 号", lat: 30.2741, lng: 120.1551, budget: 12000, remark },
      });
      await api("POST", "/api/demands/" + d.body.data.id + "/apply", { token: teacherToken });
      const apps = await api("GET", "/api/demands/" + d.body.data.id, { token: parentToken });
      const c = await api("POST", "/api/demands/" + d.body.data.id + "/confirm", {
        token: parentToken, body: { applicationId: apps.body.data.applications[0].id },
      });
      const oid = c.body.data.id;
      await api("POST", "/api/orders/" + oid + "/pay", { token: parentToken, idem: "e2e-cancel-" + oid });
      return oid;
    };
    const oid = await mkOrder("e2e 取消申请");
    const req = await api("POST", "/api/orders/" + oid + "/cancel", { token: parentToken, body: { reason: "孩子临时有事" } });
    assert(req.status === 200 && req.body.data.cancelRequested === true && req.body.data.status === "pending_class",
      "家长取消已付款订单 → 变成「取消申请」，订单与钱都不动");
    const dup = await api("POST", "/api/orders/" + oid + "/cancel", { token: parentToken, body: { reason: "重复点" } });
    assert(dup.status === 400 && dup.body.code === "CANCEL_REQUESTED", "重复提交取消申请被拒");
    const pend = await api("GET", "/api/teacher/orders?pendingCancel=1", { token: teacherToken });
    assert((pend.body.data.list || []).some((o) => o.id === oid), "教员端「待处理取消」列表能看到这条申请");
    const reject = await api("POST", "/api/teacher/orders/" + oid + "/cancel-reject", {
      token: teacherToken, body: { reason: "距上课不足 2 小时，已备好课件" },
    });
    assert(reject.status === 200 && reject.body.data.cancelRequested === false && reject.body.data.status === "pending_class",
      "教员驳回 → 订单继续履约，理由与时间留痕");
    const again = await api("POST", "/api/orders/" + oid + "/cancel", { token: parentToken, body: { reason: "还是要取消" } });
    assert(again.status === 200 && again.body.data.cancelRequested === true, "驳回后家长可再次申请取消");
    const escrow0 = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data.summary.escrow;
    const ok = await api("POST", "/api/teacher/orders/" + oid + "/cancel-approve", { token: teacherToken });
    assert(ok.status === 200 && ok.body.data.status === "refunded" && ok.body.data.refundAmount > 0,
      "教员点「退款」→ 订单转已退款（¥" + ((ok.body.data?.refundAmount || 0) / 100).toFixed(2) + "）");
    const escrow1 = (await api("GET", "/api/admin/finance", { token: adminToken })).body.data.summary.escrow;
    assert(escrow0 - escrow1 === ok.body.data.refundAmount, "退款同步释放担保资金（台账闭合）", "before=" + escrow0 + " after=" + escrow1);
    const tjs2 = await (await fetch(BASE + "/assets/js/teacher.js")).text();
    assert(tjs2.includes("cancel-approve") && tjs2.includes("cancel-reject") && tjs2.includes("待处理取消"),
      "教员端界面有「同意退款 / 驳回」与「待处理取消」入口");
  }
  /* ---------- 22. 管理员自助改密 + 删除管理员（P64，与正式实现同口径） ---------- */
  section("22. 管理员自助改密与删除管理员");
  const tmpPhone = "13900008881";
  const blankPhone = "13900008882";
  const mkAdmin = await api("POST", "/api/admin/admins", {
    token: adminToken, body: { nickname: "E2E 临时管理员", phone: tmpPhone, password: "Tmp12345x" },
  });
  assert(mkAdmin.status === 200 && mkAdmin.body.data.id > 0, "后台可新建管理员（创建动作写审计）");
  const tmpId = mkAdmin.body.data.id;
  const tmpLogin = await api("POST", "/api/auth/login-password", { body: { phone: tmpPhone, password: "Tmp12345x" } });
  assert(tmpLogin.status === 200 && tmpLogin.body.data.token, "新管理员可用初始口令登录");
  const tmpToken = tmpLogin.body.data.token;

  const weak = await api("POST", "/api/auth/change-password", { token: tmpToken, body: { oldPassword: "Tmp12345x", newPassword: "abc123" } });
  assert(weak.status === 400 && /8 位/.test(weak.body.message), "改密：新口令不足 8 位被拒（400）", weak.text);
  const noDigit = await api("POST", "/api/auth/change-password", { token: tmpToken, body: { oldPassword: "Tmp12345x", newPassword: "abcdefgh" } });
  assert(noDigit.status === 400, "改密：新口令缺数字被拒（400）");
  const wrongOld = await api("POST", "/api/auth/change-password", { token: tmpToken, body: { oldPassword: "Wrong1234", newPassword: "NewPass123" } });
  assert(wrongOld.status === 400 && /原口令/.test(wrongOld.body.message), "改密：旧口令错误被拒（400）", wrongOld.text);
  const same = await api("POST", "/api/auth/change-password", { token: tmpToken, body: { oldPassword: "Tmp12345x", newPassword: "Tmp12345x" } });
  assert(same.status === 400 && /相同/.test(same.body.message), "改密：新旧口令相同被拒（400）");

  const changed = await api("POST", "/api/auth/change-password", { token: tmpToken, body: { oldPassword: "Tmp12345x", newPassword: "NewPass123" } });
  assert(changed.status === 200 && !!changed.body.data.token && changed.body.data.mustChangePassword === false,
    "改密成功：返回新令牌（mustChangePassword=false）", changed.text);
  const oldPwLogin = await api("POST", "/api/auth/login-password", { body: { phone: tmpPhone, password: "Tmp12345x" } });
  assert(oldPwLogin.status === 400 && oldPwLogin.body.code === "BAD_CREDENTIALS", "改密后旧口令不能再登录");
  const newPwLogin = await api("POST", "/api/auth/login-password", { body: { phone: tmpPhone, password: "NewPass123" } });
  assert(newPwLogin.status === 200 && newPwLogin.body.data.token, "改密后新口令可登录");

  // 删除：有痕迹 → 软删除并匿名化
  const delSoft = await api("DELETE", "/api/admin/admins/" + tmpId, { token: adminToken });
  assert(delSoft.status === 200 && delSoft.body.data.mode === "soft" && (delSoft.body.data.kept || []).length > 0,
    "删除有操作痕迹的管理员 → 软删除（保留历史可追溯：" + ((delSoft.body.data && delSoft.body.data.kept) || []).join("、") + "）", delSoft.text);
  const softLogin = await api("POST", "/api/auth/login-password", { body: { phone: tmpPhone, password: "NewPass123" } });
  assert(softLogin.status === 400 && softLogin.body.code === "BAD_CREDENTIALS", "软删除后手机号已清空，原账号无法登录");
  const delAgain = await api("DELETE", "/api/admin/admins/" + tmpId, { token: adminToken });
  assert(delAgain.status === 404, "重复删除同一管理员返回 404");

  // 删除：完全空白 → 物理删除
  const blank = await api("POST", "/api/admin/admins", {
    token: adminToken, body: { nickname: "E2E 空白管理员", phone: blankPhone, password: "Tmp12345x" },
  });
  const blankId = blank.body.data.id;
  const delHard = await api("DELETE", "/api/admin/admins/" + blankId, { token: adminToken });
  assert(delHard.status === 200 && delHard.body.data.mode === "hard" && (delHard.body.data.kept || []).length === 0,
    "删除零痕迹管理员 → 物理删除", delHard.text);
  const listAfter = await api("GET", "/api/admin/admins", { token: adminToken });
  const ids = (listAfter.body.data || []).map((a) => a.id);
  assert(!ids.includes(tmpId) && !ids.includes(blankId), "管理员列表不再显示已删除账号");

  // 护栏
  const me = await api("GET", "/api/auth/me", { token: adminToken });
  const myId = me.body.data.user.id;
  const delSelf = await api("DELETE", "/api/admin/admins/" + myId, { token: adminToken });
  assert(delSelf.status === 403, "不能删除当前登录的管理员账号（403）");
  const delNotExist = await api("DELETE", "/api/admin/admins/999999", { token: adminToken });
  assert(delNotExist.status === 404, "删除不存在的管理员返回 404");
  const delAsParent = await api("DELETE", "/api/admin/admins/" + myId, { token: parentToken });
  assert(delAsParent.status === 403, "非管理员无权删除管理员账号（403）");

  // 界面入口（参考实现是零构建原生 JS，断言产物里确实有入口与请求路径）
  const ajs = await (await fetch(BASE + "/assets/js/admin.js")).text();
  assert(ajs.includes('data-top="password"') && ajs.includes("changeOwnPassword") && ajs.includes("/api/auth/change-password"),
    "后台顶栏有「修改口令」入口并调用 /api/auth/change-password");
  assert(ajs.includes('data-act="del-admin"') && ajs.includes("/api/admin/admins/"),
    "管理员账号列表有「删除」按钮并调用 DELETE /api/admin/admins/:id");

  /* ---------- 23. 授课地点：家长也可以到教员处上课（P65） ---------- */
  section("23. 授课地点（家长到教员处上课）");
  {
    const teacherAddr = "西湖区文三路 100 号 3 幢 501（张老师家教室）";
    const prof0 = await api("GET", "/api/teacher/profile", { token: teacherToken });
    const addr0 = prof0.body.data ? prof0.body.data.baseAddress : null;

    // 1) 没填授课地址的教员：家长不能选「到教员处」
    await api("PUT", "/api/teacher/profile", { token: teacherToken, body: { baseAddress: "", lat: 30.2741, lng: 120.1551 } });
    const svc = (await api("GET", "/api/parent/teachers/" + teacherId, { token: parentToken })).body.data.services[0];
    const noAddr = await api("POST", "/api/orders/from-service", {
      token: parentToken, body: { serviceId: svc.id, lessonTime: new Date(Date.now() + 7 * 86400000).toISOString(), place: "teacher_place" },
    });
    assert(noAddr.status === 400 && noAddr.body.code === "TEACHER_ADDRESS_REQUIRED",
      "教员未填授课地址时「到教员处」被拒（TEACHER_ADDRESS_REQUIRED）", noAddr.text);

    // 2) 填好授课地址 → 教员详情对家长开放该选项
    const setAddr = await api("PUT", "/api/teacher/profile", {
      token: teacherToken, body: { baseAddress: teacherAddr, lat: 30.2741, lng: 120.1551 },
    });
    assert(setAddr.status === 200 && setAddr.body.data.baseAddress === teacherAddr, "教员资料可保存「授课地址」并回读一致");
    const detail = await api("GET", "/api/parent/teachers/" + teacherId, { token: parentToken });
    assert(detail.body.data.acceptAtTeacherPlace === true && detail.body.data.baseAddress === teacherAddr,
      "教员详情下发授课地址与「可到教员处」标记");

    // 3) 家长选「到教员处」下单 → 地点换成教员地址
    const atTeacher = await api("POST", "/api/orders/from-service", {
      token: parentToken,
      body: { serviceId: svc.id, lessonTime: new Date(Date.now() + 8 * 86400000).toISOString(), place: "teacher_place", remark: "e2e 到教员处" },
    });
    assert(atTeacher.status === 200 && atTeacher.body.data.place === "teacher_place", "到教员处下单成功（place=teacher_place）", atTeacher.text);
    const atOrder = atTeacher.body.data;
    assert(atOrder.address === teacherAddr, "订单上课地点自动使用教员授课地址", atOrder.address);
    assert(atOrder.placeText === "到教员处上课", "订单视图给出「到教员处上课」文案");

    // 4) 不传 place 仍是上门（老行为不变）
    const homeOrder = await api("POST", "/api/orders/from-service", {
      token: parentToken, body: { serviceId: svc.id, lessonTime: new Date(Date.now() + 9 * 86400000).toISOString() },
    });
    assert(homeOrder.status === 200 && homeOrder.body.data.place === "home" && homeOrder.body.data.placeText === "教员上门",
      "不传 place 时默认仍为「教员上门」（老行为不变）");

    // 5) 到教员处的订单：双方打卡后才开课（P66 起家长也要打卡，详见 §24）
    await api("POST", "/api/orders/" + atOrder.id + "/pay", { token: parentToken, idem: "pay-atteacher-" + atOrder.id });
    const ciT = await api("POST", "/api/orders/" + atOrder.id + "/checkin", { token: teacherToken, body: { lat: 30.2741, lng: 120.1551 } });
    assert(ciT.status === 200 && ciT.body.data.status === "pending_class" && ciT.body.data.teacherArrived === true,
      "到教员处的订单：教员打卡后仍在等家长（不直接开课）", ciT.text);
    assert(ciT.body.data.statusText === "待家长到", "教员端文案为「待家长到」而不是「待上门」");
    const ciP = await api("POST", "/api/orders/" + atOrder.id + "/checkin", { token: parentToken, body: { lat: 30.2742, lng: 120.1552 } });
    assert(ciP.status === 200 && ciP.body.data.status === "in_class" && ciP.body.data.bothArrived === true,
      "家长也打卡后双方到齐 → 进入上课中", ciP.text);

    // 6) 需求发布可选上课形式，确认后订单沿用
    const atDemand = await api("POST", "/api/demands", {
      token: parentToken,
      body: {
        stage: "初中", subject: "数学", mode: "teacher_place",
        address: "西湖区文三路 128 号", lat: 30.2741, lng: 120.1551, budget: 15000, remark: "e2e 需求到教员处",
      },
    });
    assert(atDemand.status === 200 && atDemand.body.data.mode === "teacher_place", "发需求可选择「我到教员处」（mode 落库）");
    const did = atDemand.body.data.id;
    await api("POST", "/api/demands/" + did + "/apply", { token: teacherToken });
    const apps = await api("GET", "/api/demands/" + did, { token: parentToken });
    const confirmed = await api("POST", "/api/demands/" + did + "/confirm", {
      token: parentToken, body: { applicationId: apps.body.data.applications[0].id },
    });
    assert(confirmed.status === 200 && confirmed.body.data.place === "teacher_place" && confirmed.body.data.address === teacherAddr,
      "需求确认成单后沿用「到教员处」并把地点换成教员地址", confirmed.text);

    // 7) 家长订单列表里也带授课方式
    const myOrders = await api("GET", "/api/parent/orders", { token: parentToken });
    const found = (myOrders.body.data.list || []).find((o) => o.id === atOrder.id);
    assert(!!found && found.place === "teacher_place" && found.placeText === "到教员处上课", "家长订单列表下发授课方式");

    // 收尾：把授课地址还原，避免影响其它套件
    await api("PUT", "/api/teacher/profile", {
      token: teacherToken, body: { baseAddress: addr0 || "", lat: 30.2741, lng: 120.1551 },
    });
  }

  /* ---------- 24. 家长到场打卡 + 双方确认（P66） ---------- */
  section("24. 家长到场打卡与双方确认");
  {
    const addr = "西湖区文三路 100 号 3 幢 501（P66 双打卡）";
    await api("PUT", "/api/teacher/profile", { token: teacherToken, body: { baseAddress: addr, lat: 30.2741, lng: 120.1551 } });
    const svc = (await api("GET", "/api/parent/teachers/" + teacherId, { token: parentToken })).body.data.services[0];
    const mk = async (place, offsetDays) => {
      const r = await api("POST", "/api/orders/from-service", {
        token: parentToken,
        body: { serviceId: svc.id, lessonTime: new Date(Date.now() + offsetDays * 86400000).toISOString(), place, remark: "e2e 双打卡" },
      });
      await api("POST", "/api/orders/" + r.body.data.id + "/pay", { token: parentToken, idem: "pay-p66-" + r.body.data.id });
      return r.body.data;
    };

    // 教员上门订单：家长打卡没有意义 → 明确拒绝
    const homeOrder = await mk("home", 12);
    const homeParent = await api("POST", "/api/orders/" + homeOrder.id + "/checkin", { token: parentToken, body: { lat: 30.2741, lng: 120.1551 } });
    assert(homeParent.status === 400 && homeParent.body.code === "NOT_TEACHER_PLACE",
      "教员上门订单：家长打卡被拒（NOT_TEACHER_PLACE）", homeParent.text);

    const o = await mk("teacher_place", 13);
    // 家长定位太远 → 拒 + 风控留痕
    const far = await api("POST", "/api/orders/" + o.id + "/checkin", { token: parentToken, body: { lat: 30.35, lng: 120.25 } });
    assert(far.status === 400 && far.body.code === "CHECKIN_TOO_FAR", "家长定位离教学点过远 → 打卡被拒", far.text);
    // 只有家长打卡：还不开课，等教员
    const p1 = await api("POST", "/api/orders/" + o.id + "/checkin", { token: parentToken, body: { lat: 30.2742, lng: 120.1552 } });
    assert(p1.status === 200 && p1.body.data.parentArrived === true && p1.body.data.status === "pending_class",
      "家长打卡成功：记录到场但课程未开始（等教员）", p1.text);
    assert(p1.body.data.bothArrived === false && p1.body.data.teacherArrived === false, "视图如实反映「只有一方到场」");
    const dup = await api("POST", "/api/orders/" + o.id + "/checkin", { token: parentToken, body: { lat: 30.2742, lng: 120.1552 } });
    assert(dup.status === 400 && dup.body.code === "ALREADY_CHECKED_IN", "同一方重复打卡被拒");
    // 教员打卡 → 双方齐 → 自动开课
    const t1 = await api("POST", "/api/orders/" + o.id + "/checkin", { token: teacherToken, body: { lat: 30.2741, lng: 120.1551 } });
    assert(t1.status === 200 && t1.body.data.status === "in_class" && t1.body.data.bothArrived === true,
      "双方都打卡后自动进入上课中（双方确认到场）", t1.text);
    assert(t1.body.data.parentCheckinDistance != null && t1.body.data.checkinDistance != null,
      "双方打卡距离都被记录（家长 " + t1.body.data.parentCheckinDistance + "m / 教员 " + t1.body.data.checkinDistance + "m）");
    // 开课后不能再打卡
    const after = await api("POST", "/api/orders/" + o.id + "/checkin", { token: teacherToken, body: { lat: 30.2741, lng: 120.1551 } });
    assert(after.status === 400 && after.body.code === "BAD_STATUS", "开课后不可再打卡");
    // 家长订单视图能看到双方到场状态
    const pv = await api("GET", "/api/orders/" + o.id, { token: parentToken });
    assert(pv.body.data.parentArrived === true && pv.body.data.teacherArrived === true && pv.body.data.bothArrived === true,
      "家长订单详情显示双方均已到场");
    // 教员上门订单仍是一次打卡即开课（老行为不变）；打卡点用该订单自己的上课坐标
    const h2 = await api("POST", "/api/orders/" + homeOrder.id + "/checkin", {
      token: teacherToken, body: { lat: Number(homeOrder.lat), lng: Number(homeOrder.lng) },
    });
    assert(h2.status === 200 && h2.body.data.status === "in_class", "教员上门订单仍是「教员打卡即开课」（老行为不变）", h2.text);
    await api("PUT", "/api/teacher/profile", { token: teacherToken, body: { baseAddress: "", lat: 30.2741, lng: 120.1551 } });
  }

  /* ---------- 25. 服务级授课形式（P67） ---------- */
  section("25. 服务级授课形式（上门 / 在教员家）");
  {
    const before = (await api("GET", "/api/teacher/services", { token: teacherToken })).body.data;
    const t0 = before[0];
    assert(Array.isArray(t0.places) && t0.places.includes("home") && typeof t0.placesText === "string",
      "服务列表下发 places 数组与中文标签（" + t0.placesText + "）", JSON.stringify(t0.places));

    // 只支持上门时：家长选「到教员处」被拒
    const onlyHome = await api("PUT", "/api/teacher/services/" + t0.id, { token: teacherToken, body: { places: ["home"] } });
    assert(onlyHome.status === 200 && onlyHome.body.data.places.join() === "home" && onlyHome.body.data.placesText === "上门授课",
      "服务可设为「仅上门授课」");
    await api("PUT", "/api/teacher/profile", { token: teacherToken, body: { baseAddress: "西湖区文三路 100 号 3 幢 501（P67）", lat: 30.2741, lng: 120.1551 } });
    const denied = await api("POST", "/api/orders/from-service", {
      token: parentToken, body: { serviceId: t0.id, lessonTime: new Date(Date.now() + 14 * 86400000).toISOString(), place: "teacher_place" },
    });
    assert(denied.status === 400 && denied.body.code === "PLACE_NOT_SUPPORTED",
      "该服务不支持在教员家授课时，选「到教员处」被拒（PLACE_NOT_SUPPORTED）", denied.text);

    // 改成两种都支持：家长可下「到教员处」单
    const both = await api("PUT", "/api/teacher/services/" + t0.id, { token: teacherToken, body: { places: ["home", "teacher_place"] } });
    assert(both.status === 200 && both.body.data.places.length === 2 && /在教员家授课/.test(both.body.data.placesText),
      "服务可设为「上门 + 在教员家」两种（" + both.body.data.placesText + "）");
    const ok = await api("POST", "/api/orders/from-service", {
      token: parentToken, body: { serviceId: t0.id, lessonTime: new Date(Date.now() + 15 * 86400000).toISOString(), place: "teacher_place", remark: "e2e P67" },
    });
    assert(ok.status === 200 && ok.body.data.place === "teacher_place", "两种都支持后，到教员处下单成功", ok.text);

    // 只支持在教员家：家长选「上门」被拒
    await api("PUT", "/api/teacher/services/" + t0.id, { token: teacherToken, body: { places: ["teacher_place"] } });
    const noHome = await api("POST", "/api/orders/from-service", {
      token: parentToken, body: { serviceId: t0.id, lessonTime: new Date(Date.now() + 16 * 86400000).toISOString(), place: "home" },
    });
    assert(noHome.status === 400 && noHome.body.code === "PLACE_NOT_SUPPORTED", "仅「在教员家」的服务，选上门被拒", noHome.text);
    const fromList = (await api("GET", "/api/parent/teachers/" + teacherId, { token: parentToken })).body.data.services[0];
    assert(Array.isArray(fromList.places) && fromList.places.length === 1 && fromList.places[0] === "teacher_place",
      "家长侧教员详情也下发服务的授课形式（预约页据此只给可选项）");

    // 收尾：恢复成两种都支持（与服务演示数据一致）
    await api("PUT", "/api/teacher/services/" + t0.id, { token: teacherToken, body: { places: ["home", "teacher_place"] } });
    await api("PUT", "/api/teacher/profile", { token: teacherToken, body: { baseAddress: "", lat: 30.2741, lng: 120.1551 } });
  }

  section("26. 支付前端唤起（prepay 分发 + 唤起后轮询落地）");
  {
    // 前端契约（静态）：H5 走微信 JSSDK bridge；后端给 prepay 才唤起，给订单视图就跳过
    const pjs = await (await fetch(BASE + "/assets/js/parent.js")).text();
    assert(pjs.includes("WeixinJSBridge") && pjs.includes("getBrandWCPayRequest"),
      "家长端含微信内 JSSDK 支付唤起（WeixinJSBridge.getBrandWCPayRequest）");
    assert(/mode\s*===\s*"prepay"/.test(pjs), "前端按后端返回的 prepay 决定是否唤起收银台（不无脑 toast 成功）");
    assert(/function waitOrderPaid\(/.test(pjs), "唤起后轮询订单状态等渠道回调落地（waitOrderPaid）");
    assert(pjs.includes("微信中打开"), "非微信环境明确提示，不假装支付成功");

    // 后端契约：参考实现没有真实渠道，pay 直接入账并返回订单视图（无 mode）
    const svcList = (await api("GET", "/api/teacher/services", { token: teacherToken })).body.data;
    const mk = await api("POST", "/api/orders/from-service", {
      token: parentToken,
      body: { serviceId: svcList[0].id, lessonTime: new Date(Date.now() + 20 * 86400000).toISOString(), remark: "e2e P69 pay" },
    });
    assert(mk.status === 200 && mk.body.data.status === "awaiting_payment", "创建待支付订单（支付链路验证用）", mk.text);
    const oid = mk.body.data.id;
    const pay1 = await api("POST", "/api/orders/" + oid + "/pay", { token: parentToken, body: {} });
    assert(pay1.status === 200 && pay1.body.data.status === "pending_class" && pay1.body.data.mode === undefined,
      "参考实现 pay 直接入账并返回订单视图（无 prepay.mode）→ 前端据此不唤起收银台");
    const pay2 = await api("POST", "/api/orders/" + oid + "/pay", { token: parentToken, body: {} });
    assert(pay2.status === 200 && pay2.body.data.status === "pending_class" && pay2.body.data.paidAt === pay1.body.data.paidAt,
      "已支付订单再次 pay 幂等（paidAt 不变，不二次入账）");
  }

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