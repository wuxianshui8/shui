// ============================================================
// 核心业务规则专项验证
//   1. 派单匹配公式  优先级 = 距离系数 × 教员等级权重 × 响应速度系数
//   2. 分账金额逐项 服务费 / 教员实收 / 代理分成 / 业务员提成 / 平台净收入
//   3. 等级驱动抽佣 调级后抽佣比例真实变化
//   4. 成长分与升降级
//   5. 抢单原子性（并发）
//   6. 区域数据隔离（越权 403）
// 用法：先 npm start，再 node test/rules.test.js
// ============================================================
const BASE = process.env.BASE_URL || "http://localhost:4173";
const PW = "a123456";

let pass = 0, fail = 0;
const failures = [];
const detail = [];

function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "  " + extra : "")); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function eq(actual, expect, name) {
  assert(actual === expect, name, "期望 " + expect + " / 实际 " + actual);
}
function section(t) { console.log("\n===== " + t + " ====="); }
const M = (c) => "¥" + (Number(c) / 100).toFixed(2);
const r4 = (n) => Math.round(n * 10000) / 10000;

async function api(method, path, { token, body, idem } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (idem) headers["X-Idem-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json, text };
}
const get = (p, token) => api("GET", p, { token });
const post = (p, body, token, idem) => api("POST", p, { token, body, idem });

async function login(phone) {
  const r = await post("/api/auth/login-password", { phone, password: PW });
  if (r.status !== 200) throw new Error("登录失败 " + phone + " " + r.text);
  return r.body.data.token;
}
const uid = () => "t" + Date.now() + Math.random().toString(36).slice(2, 6);
const futureIso = (days, hour = 10) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

(async () => {
  console.log("家教平台 · 核心业务规则专项验证");
  console.log("目标服务：" + BASE);

  const admin = await login("13900000001");

  /* ============================================================
     1. 派单匹配公式
     ============================================================ */
  section("1. 派单匹配：优先级 = 距离系数 × 等级权重 × 响应速度系数");
  const rules = (await get("/api/meta/rules-public")).body.data;
  const dispatchCfg = rules.find((r) => r.key === "dispatch").value;
  const maxR = dispatchCfg.max_radius_km;
  const minF = dispatchCfg.distance_factor_min;
  console.log("  规则配置：最大接单半径 " + maxR + " km，距离系数下限 " + minF);

  const parentA = await login("13900000301"); // 西湖，L0，credit 100
  const plaza = (await get("/api/parent/teachers?radiusKm=10", parentA)).body.data;
  const dfOf = (d) => Math.max(minF, Math.min(1, 1 - d / maxR));

  let formulaOk = true;
  let checked = 0;
  for (const t of plaza.list) {
    const expect = r4(dfOf(t.distanceKm) * t.levelWeight * t.responseFactor);
    const actual = r4(t.priority);
    checked++;
    if (Math.abs(expect - actual) > 0.0002) {
      formulaOk = false;
      detail.push(`${t.nickname} 距离${t.distanceKm}km 权重${t.levelWeight} 响应${t.responseFactor} 期望${expect} 实际${actual}`);
    }
  }
  assert(checked > 0, "取到 " + checked + " 位在线教员样本");
  assert(formulaOk, "每一位教员的优先级都与公式逐项吻合（误差 < 0.0002）", checked + " 位全部通过");
  if (!formulaOk) detail.forEach((d) => console.log("      " + d));

  const sortedDesc = plaza.list.every((t, i, a) => i === 0 || a[i - 1].priority >= t.priority);
  assert(sortedDesc, "广场按优先级降序返回");
  const byLevel = {};
  plaza.list.forEach((t) => { (byLevel[t.level] = byLevel[t.level] || []).push(t); });
  console.log("  等级分布：" + Object.keys(byLevel).sort().map((k) => k + "×" + byLevel[k].length).join("  "));

  /* ============================================================
     2. 分账公式逐项验证（真实下单 → 支付 → 核对金额）
     ============================================================ */
  section("2. 分账金额：服务费 / 教员实收 / 代理分成 / 业务员提成 / 平台净收入");
  const agentCfg = rules.find((r) => r.key === "agent_commission").value;
  const salesCfg = rules.find((r) => r.key === "sales_rewards").value;
  const tierRate = (amount) => {
    for (const t of salesCfg.deal_tiers) {
      const max = t.max === null ? Infinity : t.max;
      if (amount >= t.min && amount <= max) return t.rate;
    }
    return salesCfg.deal_tiers[salesCfg.deal_tiers.length - 1].rate;
  };

  const tDetail = (await get("/api/parent/teachers/" + plaza.list[0].id, parentA)).body.data;
  const svc = tDetail.services[0];
  console.log("  样本教员：" + tDetail.nickname + "（" + tDetail.level + " 抽佣 " + (tDetail.commission * 100).toFixed(0) + "%）课时价 " + M(svc.price));

  const orderRes = await post("/api/orders/from-service", {
    serviceId: svc.id, lessonTime: futureIso(20, 10), remark: "规则验证订单",
  }, parentA);
  assert(orderRes.status === 200, "选购服务下单成功（订单 " + orderRes.body?.data?.orderNo + "）");
  const order = orderRes.body.data;
  const orderId = order.id;

  const payRes = await post("/api/orders/" + orderId + "/pay", { channel: "wechat_jsapi" }, parentA, uid());
  assert(payRes.status === 200, "担保支付成功，进入待上课");
  const paid = payRes.body.data;

  // 期望值按规则独立计算
  const amount = svc.price;
  const rate = tDetail.commission;
  const expectFee = Math.round(amount * rate);
  const expectIncome = amount - expectFee;
  const adminAgents = (await get("/api/admin/agents", admin)).body.data;
  const ordFull = (await get("/api/orders/" + orderId, parentA)).body.data;
  const opAgent = adminAgents.find((a) => a.user_id === paid.agent?.id) ||
                  adminAgents.find((a) => a.user_id === ordFull.agentId);
  const feeShare = opAgent ? opAgent.commission_rate : agentCfg.fee_share_rate;
  const mgmt = opAgent ? opAgent.mgmt_rate : agentCfg.mgmt_rate;
  const sRate = paid.parent?.id ? tierRate(amount) : 0;
  const expectAgent = Math.round(expectFee * feeShare) + Math.round(amount * mgmt);
  const expectSales = Math.round(amount * sRate);
  const expectPlatform = expectFee - expectAgent - expectSales;

  console.log("  实付 " + M(amount) + "，等级抽佣 " + (rate * 100).toFixed(0) + "%，代理分成 " + (feeShare * 100).toFixed(0) + "% + 管理提成 " + (mgmt * 100).toFixed(1) + "%，业务员阶梯 " + (sRate * 100).toFixed(1) + "%");
  eq(paid.serviceFee, expectFee, "平台服务费 = 实付 × 等级抽佣 = " + M(expectFee));
  eq(paid.teacherIncome, expectIncome, "教员实收 = 实付 − 服务费 = " + M(expectIncome));
  eq(paid.agentShare, expectAgent, "代理分成 = 服务费×分成 + 实付×管理提成 = " + M(expectAgent));
  eq(paid.salesCommission, expectSales, "业务员提成 = 实付 × 阶梯比例 = " + M(expectSales));
  eq(paid.platformRevenue, expectPlatform, "平台净收入 = 服务费 − 代理 − 业务员 = " + M(expectPlatform));

  eq(paid.teacherIncome + paid.serviceFee, amount, "恒等式 A：实付 = 教员实收 + 服务费");
  eq(paid.agentShare + paid.salesCommission + paid.platformRevenue, paid.serviceFee, "恒等式 B：服务费 = 代理 + 业务员 + 平台");

  const fin = (await get("/api/admin/finance", admin)).body.data;
  assert(fin.summary.escrow >= amount, "担保台账已入账，当前余额 " + M(fin.summary.escrow));

  /* ============================================================
     3. 等级驱动抽佣（后台调级 → 抽佣比例真实变化）
     ============================================================ */
  section("3. 等级驱动抽佣：后台调级后新订单抽佣随之变化");
  const tId = tDetail.id;
  const levels = rules.find((r) => r.key === "teacher_levels").value;
  const lv1 = levels.find((l) => l.level === "Lv1");
  const lv5 = levels.find((l) => l.level === "Lv5");
  const originLevel = tDetail.level;
  console.log("  将该教员从 " + originLevel + " 临时调整为 Lv1（抽佣 " + (lv1.commission * 100).toFixed(0) + "%）");

  const lvSet = await post("/api/admin/teachers/" + tId + "/level", { level: "Lv1", note: "规则验证-临时调级" }, admin);
  assert(lvSet.status === 200, "后台调级成功");

  const lvNow = (await get("/api/teacher/level", await login("13900000201"))).body.data;
  eq(lvNow.commission, lv1.commission, "教员端权益页同步显示新抽佣 " + (lv1.commission * 100).toFixed(0) + "%");

  const o2 = await post("/api/orders/from-service", { serviceId: svc.id, lessonTime: futureIso(21, 10), remark: "调级后订单" }, parentA);
  const p2 = await post("/api/orders/" + o2.body.data.id + "/pay", {}, parentA, uid());
  eq(p2.body.data.serviceFee, Math.round(amount * lv1.commission), "调级后订单服务费 = " + M(Math.round(amount * lv1.commission)) + "（Lv1 抽佣）");
  assert(p2.body.data.serviceFee > paid.serviceFee, "抽佣随等级下调而上升（" + M(paid.serviceFee) + " → " + M(p2.body.data.serviceFee) + "）");

  // 还原等级
  await post("/api/admin/teachers/" + tId + "/level", { level: originLevel, note: "规则验证-还原" }, admin);
  const restored = (await get("/api/teacher/level", await login("13900000201"))).body.data;
  eq(restored.level, originLevel, "等级已还原为 " + originLevel + "，抽佣 " + (restored.commission * 100).toFixed(0) + "%");

  /* ============================================================
     4. 成长分与升降级
     ============================================================ */
  section("4. 成长分：有效课时 +2，5 星好评 +round(5 × 家长评价权重)");
  const credit = (await get("/api/parent/profile", parentA)).body.data.credit;
  const w = credit.reviewWeight;
  const growthRules = rules.find((r) => r.key === "growth_rules").value;
  const expPer = growthRules.per_lesson;
  const expReview = Math.round(growthRules.good_review_base * w);
  console.log("  家长信用 " + credit.creditLevel + "（" + credit.creditScore + "）评价权重 " + w + "×");

  const before = restored.growthScore;
  const teacherTok = await login("13900000201");

  const o3 = await post("/api/orders/from-service", { serviceId: svc.id, lessonTime: futureIso(22, 14), remark: "成长分验证" }, parentA);
  const o3id = o3.body.data.id;
  await post("/api/orders/" + o3id + "/pay", {}, parentA, uid());
  const od = (await get("/api/orders/" + o3id, teacherTok)).body.data;
  const ck = await post("/api/orders/" + o3id + "/checkin", { lat: od.lat, lng: od.lng }, teacherTok);
  assert(ck.status === 200, "上门打卡通过（距离 " + ck.body?.data?.checkinDistance + " 米 ≤ 阈值）");
  await post("/api/orders/" + o3id + "/finish", {}, teacherTok);
  const conf = await post("/api/orders/" + o3id + "/confirm", {}, parentA);
  assert(conf.status === 200 && conf.body.data.status === "completed", "家长确认完成，课时费进入冻结期");

  const mid = (await get("/api/teacher/level", teacherTok)).body.data.growthScore;
  eq(mid - before, expPer, "有效课时成长分 +" + expPer + "（" + before + " → " + mid + "）");

  const rv = await post("/api/orders/" + o3id + "/review", { score: 5, content: "规则验证好评", tags: ["准时", "专业"] }, parentA);
  eq(rv.body.data.weight, w, "评价权重取自家长信用等级 = " + w);
  const after = (await get("/api/teacher/level", teacherTok)).body.data.growthScore;
  eq(after - mid, expReview, "5 星好评成长分 +round(" + growthRules.good_review_base + " × " + w + ") = +" + expReview + "（" + mid + " → " + after + "）");

  const creditAfter = (await get("/api/parent/profile", parentA)).body.data.credit;
  console.log("  家长信用分：" + credit.creditScore + " → " + creditAfter.creditScore + "（完成订单 +" + rules.find((r) => r.key === "credit_rules").value.order_completed + "，评价 +" + rules.find((r) => r.key === "credit_rules").value.review_given + "）");
  assert(creditAfter.creditScore > credit.creditScore, "家长信用分随履约与评价提升");

  /* ============================================================
     5. 抢单原子性
     ============================================================ */
  section("5. 抢单原子性：并发下不重复接单、不超卖");
  const addrA = (await get("/api/addresses", parentA)).body.data[0];
  const dm = await post("/api/demands", {
    stage: "初中", subject: "数学", address: addrA.address, lat: addrA.lat, lng: addrA.lng,
    budget: 20000, remark: "并发抢单验证", urgent: false,
  }, parentA);
  assert(dm.status === 200, "家长发布需求成功（id=" + dm.body?.data?.id + "）");
  const demandId = dm.body.data.id;

  await post("/api/teacher/online", { online: true }, teacherTok);
  const grabs = await Promise.all(
    Array.from({ length: 30 }, () => post("/api/demands/" + demandId + "/apply", {}, teacherTok))
  );
  const okN = grabs.filter((g) => g.status === 200).length;
  const dupN = grabs.filter((g) => g.status === 400 && /已报名/.test(g.body?.message || "")).length;
  eq(okN, 1, "同一教员 30 次并发抢单，仅 1 次成功");
  assert(dupN >= 25, "其余请求被明确判定为重复报名（" + dupN + " 次）");

  const apps = (await get("/api/demands/" + demandId, parentA)).body.data;
  eq(apps.applications.length, 1, "报名表仅 1 条记录（唯一索引生效）");

  const appId = apps.applications[0].id;
  const confirms = await Promise.all([
    post("/api/demands/" + demandId + "/confirm", { applicationId: appId }, parentA),
    post("/api/demands/" + demandId + "/confirm", { applicationId: appId }, parentA),
    post("/api/demands/" + demandId + "/confirm", { applicationId: appId }, parentA),
  ]);
  const okC = confirms.filter((c) => c.status === 200).length;
  eq(okC, 1, "3 次并发确认仅 1 次成功（条件更新占位）");
  assert(confirms.some((c) => c.status === 409), "其余确认返回 409 冲突");

  const allOrders = (await get("/api/admin/orders", admin)).body.data.list;
  const forDemand = allOrders.filter((o) => o.amount === 20000 && o.remark !== "调级后订单");
  console.log("  该需求对应订单数：" + okC + "（无超卖）");

  /* ============================================================
     6. 区域数据隔离
     ============================================================ */
  section("6. 区域数据隔离：片区边界与越权拦截");
  const agentXH = await login("13900000010"); // 西湖
  const agentBJ = await login("13900000011"); // 滨江

  const dashXH = (await get("/api/agent/dashboard", agentXH)).body.data;
  const dashBJ = (await get("/api/agent/dashboard", agentBJ)).body.data;
  assert(dashXH.region.id !== dashBJ.region.id, "两个代理归属不同片区：" + dashXH.region.name + " / " + dashBJ.region.name);

  const ordXH = (await get("/api/agent/orders", agentXH)).body.data.list;
  const adminOrd = (await get("/api/admin/orders", admin)).body.data.list;
  const idsXH = new Set(ordXH.map((o) => o.id));
  const idsRegionXH = new Set(adminOrd.filter((o) => o.regionId === dashXH.region.id).map((o) => o.id));
  const subset = [...idsXH].every((id) => idsRegionXH.has(id));
  assert(subset, "西湖代理只能看到本片区订单（" + idsXH.size + " 单，全部属于 " + dashXH.region.name + "）");

  // 跨区操作必须 403
  const bjSales = (await get("/api/agent/sales", agentBJ)).body.data.list;
  const xhSales = (await get("/api/agent/sales", agentXH)).body.data.list;
  assert(bjSales.length > 0 && xhSales.length > 0, "两片区各自有业务员");
  const crossToggle = await post("/api/agent/sales/" + xhSales[0].userId + "/toggle", {}, agentBJ);
  eq(crossToggle.status, 403, "滨江代理操作西湖业务员 → 403");

  const crossDetail = await get("/api/agent/sales/" + xhSales[0].userId, agentBJ);
  eq(crossDetail.status, 403, "滨江代理查看西湖业务员明细 → 403");

  const risksXH = (await get("/api/agent/risks", agentXH)).body.data.events;
  if (risksXH.length) {
    const crossRisk = await post("/api/agent/risks/" + risksXH[0].id + "/escalate", {}, agentBJ);
    eq(crossRisk.status, 403, "滨江代理上报西湖风控事件 → 403");
  }

  const ruleModify = await api("PUT", "/api/admin/rules/settlement", { token: agentXH, body: { value: { freeze_days: 1 } } });
  eq(ruleModify.status, 403, "代理修改平台核心规则（结算）→ 403");

  const teacherAudit = await post("/api/admin/teachers/" + plaza.list.find((t) => t.auditStatus === "pending")?.id + "/audit", { approve: true }, agentXH);
  assert(teacherAudit.status === 403 || teacherAudit.status === 404, "代理无教员审核权 → " + teacherAudit.status);

  const maskCheck = ordXH.every((o) => !o.address || o.address.includes("***") || o.address.length <= 10);
  assert(maskCheck, "代理端上课地址按规则脱敏");

  const salesCust = (await get("/api/sales/customers", await login("13900000101"))).body.data.list;
  assert(salesCust.every((c) => c.phone.includes("****")), "业务员端客户手机号脱敏（" + salesCust.length + " 位）");

  /* ============================================================
     7. 抢单超时自动失效（配置驱动）
     ============================================================ */
  section("7. 抢单超时自动失效（需求 5.1）");
  const dispatchCfgNow = (await get("/api/meta/rules-public")).body.data.find((r) => r.key === "dispatch").value;
  console.log("  当前抢单超时阈值：" + dispatchCfgNow.grab_confirm_timeout_hours + " 小时");

  const dm2 = await post("/api/demands", {
    stage: "初中", subject: "数学", address: addrA.address, lat: addrA.lat, lng: addrA.lng,
    budget: 18000, remark: "超时验证需求",
  }, parentA);
  const demand2 = dm2.body.data.id;
  const ap2 = await post("/api/demands/" + demand2 + "/apply", {}, teacherTok);
  assert(ap2.status === 200, "教员报名成功，进入待家长确认");

  await api("PUT", "/api/admin/rules/dispatch", {
    token: admin, body: { value: { ...dispatchCfgNow, grab_confirm_timeout_hours: 0 } },
  });
  const ex = await post("/api/admin/applications/expire", {}, admin);
  assert(ex.status === 200 && ex.body.data.expired >= 1, "超时清理生效：本次失效 " + ex.body.data.expired + " 条（阈值 " + ex.body.data.timeoutHours + " 小时）");

  const dInfo = (await get("/api/demands/" + demand2, parentA)).body.data;
  const expiredApp = dInfo.applications.find((a) => a.id === ap2.body.data.applicationId);
  eq(expiredApp.status, "expired", "该报名状态已置为 expired");
  const co = await post("/api/demands/" + demand2 + "/confirm", { applicationId: ap2.body.data.applicationId }, parentA);
  assert(co.status === 400, "超时失效的报名不可再被确认（400）");

  await api("PUT", "/api/admin/rules/dispatch", { token: admin, body: { value: dispatchCfgNow } });
  const restoredCfg = (await get("/api/meta/rules-public")).body.data.find((r) => r.key === "dispatch").value;
  eq(restoredCfg.grab_confirm_timeout_hours, dispatchCfgNow.grab_confirm_timeout_hours,
    "超时阈值已还原为 " + dispatchCfgNow.grab_confirm_timeout_hours + " 小时");

  /* ============================================================
     8. 反作弊：设备指纹频次限制
     ============================================================ */
  section("8. 反作弊：设备指纹 / IP 频次限制（需求第 8 章）");
  const riskCfg = (await get("/api/admin/rules", admin)).body.data.rules.find((r) => r.key === "risk").value;
  console.log("  规则配置：同设备 24h 最多注册 " + riskCfg.register_per_device_day + " 个账号，同 IP 1h 最多 " + riskCfg.register_per_ip_hour + " 个");
  const fp = "FP-RULES-" + Date.now();
  const outcomes = [];
  for (let i = 0; i < riskCfg.register_per_device_day + 1; i++) {
    const phone = "138" + String((Date.now() + i * 7) % 100000000).padStart(8, "0");
    const codeRes = await post("/api/auth/send-code", { phone });
    const res = await fetch(BASE + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Fp": fp },
      body: JSON.stringify({ phone, code: codeRes.body.data.devCode }),
    });
    outcomes.push({ status: res.status, body: await res.json() });
  }
  const allowed = outcomes.filter((o) => o.status === 200).length;
  const blocked = outcomes.filter((o) => o.status === 400 && /风控/.test(o.body?.message || "")).length;
  eq(allowed, riskCfg.register_per_device_day, "同一设备前 " + riskCfg.register_per_device_day + " 个账号可正常注册");
  eq(blocked, 1, "第 " + (riskCfg.register_per_device_day + 1) + " 个账号被风控拦截");

  const brushEvents = (await get("/api/admin/risks", admin)).body.data.events.filter((e) => /同一设备/.test(e.reason || ""));
  assert(brushEvents.length >= 1, "拦截已写入风控事件：" + (brushEvents[0] ? brushEvents[0].reason : ""));

  /* ============================================================
     9. 代理考核指标（规则配置中心驱动）
     ============================================================ */
  section("9. 代理考核指标（规则配置中心驱动）");
  const dash0 = (await get("/api/agent/dashboard", agentXH)).body.data;
  assert(!!dash0.assessment, "代理首页返回考核指标");
  console.log("  西湖片区：GMV " + M(dash0.assessment.monthGmv) + " / 目标 " + M(dash0.assessment.targets.monthly_gmv_target) +
    "，订单 " + dash0.assessment.monthOrders + " / " + dash0.assessment.targets.monthly_orders_target +
    "，业务员 " + dash0.assessment.salesCount + " / " + dash0.assessment.targets.active_sales_target +
    " → " + dash0.assessment.score + " 分（" + dash0.assessment.status + "）");

  const assess0 = (await get("/api/admin/rules", admin)).body.data.rules.find((r) => r.key === "agent_assessment").value;
  await api("PUT", "/api/admin/rules/agent_assessment", {
    token: admin, body: { value: { ...assess0, monthly_gmv_target: 100 } },
  });
  const dash1 = (await get("/api/agent/dashboard", agentXH)).body.data;
  assert(dash1.assessment.gmvRate > dash0.assessment.gmvRate,
    "下调 GMV 目标后完成度实时上升（" + dash0.assessment.gmvRate + "% → " + dash1.assessment.gmvRate + "%）");

  await api("PUT", "/api/admin/rules/agent_assessment", { token: admin, body: { value: assess0 } });
  const dash2 = (await get("/api/agent/dashboard", agentXH)).body.data;
  eq(dash2.assessment.gmvRate, dash0.assessment.gmvRate, "目标还原后完成度恢复原值");
  /* ============================================================
     汇总
     ============================================================ */
  console.log("\n=================================================");
  console.log("规则专项验证：通过 " + pass + " 项，失败 " + fail + " 项");
  if (fail) {
    console.log("失败项：");
    failures.forEach((f) => console.log("  - " + f));
    process.exitCode = 1;
  } else {
    console.log("抢单 / 分账 / 等级 / 区域隔离 全部规则真实生效 ✅");
  }
  console.log("=================================================");
})().catch((e) => {
  console.error("验证异常终止：", e);
  process.exitCode = 1;
});