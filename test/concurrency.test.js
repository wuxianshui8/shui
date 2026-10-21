// ============================================================
// 并发验收测试（需求 9.3：100 人并发抢单无超卖、无数据异常）
//   1. 造 100 个已审核在线教员（直连 DB，避免 100 次注册/审核）
//   2. 100 个教员并发抢同一需求 → 100 条报名、无重复
//   3. 100 次并发确认同一报名 → 仅生成 1 笔订单（无超卖）
//   4. 同一教员 100 次并发抢单 → 仅 1 次成功
//   5. 30 次并发支付同一订单 → 仅 1 条支付流水（幂等）
//   6. 事后数据一致性校验
// 用法：先 npm start，再 node test/concurrency.test.js
// 结束后会自动清理本次测试数据
// ============================================================
import { run, get, all } from "../server/core/db.js";
import { signToken } from "../server/core/auth.js";

const BASE = process.env.BASE_URL || "http://localhost:4173";
const PW = "a123456";
const N_TEACHERS = 100;
const PHONE_BASE = 13900000900;

let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "  " + extra : "")); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function eq(a, e, name) { assert(a === e, name, "期望 " + e + " / 实际 " + a); }
function section(t) { console.log("\n===== " + t + " ====="); }

async function api(method, path, { token, body, idem } = {}) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  if (idem) h["X-Idem-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json, text };
}
const getApi = (p, token) => api("GET", p, { token });
const post = (p, body, token, idem) => api("POST", p, { token, body, idem });
const nowIso = () => new Date().toISOString();

/** 跨进程读取 DB 时等待写入可见（WAL 下另一进程的读快照可能短暂滞后） */
async function waitCount(sql, params, expect, tries = 40) {
  let n = all(sql, ...params).length;
  for (let i = 0; i < tries && n !== expect; i++) {
    await new Promise((r) => setTimeout(r, 50));
    n = all(sql, ...params).length;
  }
  return n;
}

async function login(phone) {
  const r = await post("/api/auth/login-password", { phone, password: PW });
  if (r.status !== 200) throw new Error("登录失败 " + phone + ": " + r.text);
  return r.body.data.token;
}

(async () => {
  console.log("家教平台 · 并发验收测试（需求 9.3）");
  console.log("目标服务：" + BASE);

  const parentToken = await login("13900000301");

  /* ---------- 1. 造 100 个在线教员 ---------- */
  section("1. 准备 " + N_TEACHERS + " 个已审核在线教员");
  const fixtureIds = [];
  const fixtureTokens = [];
  const baseLat = 30.2620, baseLng = 120.1330; // 与家长上课地址一致，保证全部在服务半径内
  for (let i = 0; i < N_TEACHERS; i++) {
    const phone = String(PHONE_BASE + i);
    let u = get("SELECT * FROM users WHERE phone = ?", phone);
    let uid;
    if (u) {
      uid = u.id;
      run("UPDATE users SET status = 'active', nickname = ? WHERE id = ?", "压测教员" + String(i + 1).padStart(3, "0"), uid);
    } else {
      uid = run(
        "INSERT INTO users (phone, nickname, role, status, region_id, created_at) VALUES (?,?,?,?,?,?)",
        phone, "压测教员" + String(i + 1).padStart(3, "0"), "teacher", "active", 1, nowIso()
      ).id;
    }
    const tp = get("SELECT user_id FROM teacher_profiles WHERE user_id = ?", uid);
    if (!tp) {
      run(
        `INSERT INTO teacher_profiles (user_id, identity_type, real_name, subjects, stages, hourly_price,
          service_radius_km, base_lat, base_lng, audit_status, online, growth_score, level, rating_avg, response_factor,
          created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        uid, "part_time", "压测教员" + (i + 1), "数学,物理", "初中,高中", 15000, 5,
        Number((baseLat + (i % 7) * 0.0008).toFixed(5)), Number((baseLng + (i % 5) * 0.0008).toFixed(5)),
        "approved", 1, 500, "Lv2", 4.8, 1.0, nowIso(), nowIso()
      );
    } else {
      run("UPDATE teacher_profiles SET audit_status = 'approved', online = 1, subjects = '数学,物理' WHERE user_id = ?", uid);
    }
    run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", uid, nowIso());
    fixtureIds.push(uid);
    fixtureTokens.push(signToken(uid, "teacher"));
  }
  assert(fixtureIds.length === N_TEACHERS, "已就绪 " + N_TEACHERS + " 个可接单教员");

  /* ---------- 2. 100 人并发抢同一需求 ---------- */
  section("2. 100 个教员并发抢同一需求");
  const dm = await post("/api/demands", {
    stage: "初中", subject: "数学", address: "西湖区文三路 128 号 学军小区 3 幢 502",
    lat: baseLat, lng: baseLng, budget: 20000, remark: "并发验收需求",
  }, parentToken);
  assert(dm.status === 200, "家长发布需求（id=" + dm.body?.data?.id + "）");
  const demandId = dm.body.data.id;

  const t0 = Date.now();
  const grabs = await Promise.all(fixtureTokens.map((tk) => post("/api/demands/" + demandId + "/apply", {}, tk)));
  const grabMs = Date.now() - t0;

  const grabOk = grabs.filter((g) => g.status === 200).length;
  eq(grabOk, N_TEACHERS, "100 个不同教员全部报名成功（报名制）");
  console.log("     100 次并发抢单耗时 " + grabMs + "ms");

  // 以服务端接口为准（权威口径），并与直连 DB 交叉核对
  const dInfo = (await getApi("/api/demands/" + demandId, parentToken)).body.data;
  const appRows = dInfo.applications;
  eq(appRows.length, N_TEACHERS, "报名表恰好 " + N_TEACHERS + " 条记录（服务端口径）");
  eq(await waitCount("SELECT id FROM applications WHERE demand_id = ?", [demandId], N_TEACHERS), N_TEACHERS, "直连 DB 交叉核对一致");

  const dupPairs = all(
    "SELECT teacher_id, COUNT(*) AS c FROM applications WHERE demand_id = ? GROUP BY teacher_id HAVING c > 1",
    demandId
  );
  eq(dupPairs.length, 0, "不存在重复报名（唯一索引生效）");

  const priorities = appRows.map((a) => a.priority);
  assert(priorities.every((p) => p > 0), "每条报名都计算了派单优先级（示例 " + priorities[0] + "）");

  /* ---------- 3. 100 次并发确认同一报名 ---------- */
  section("3. 100 次并发确认同一报名 → 只生成 1 笔订单");
  const appId = appRows[0].id;
  const confirms = await Promise.all(
    Array.from({ length: N_TEACHERS }, () =>
      post("/api/demands/" + demandId + "/confirm", { applicationId: appId }, parentToken)
    )
  );
  const confirmOk = confirms.filter((c) => c.status === 200).length;
  const conflict = confirms.filter((c) => c.status === 409).length;
  const badStatus = confirms.filter((c) => c.status === 400).length;
  eq(confirmOk, 1, "并发确认仅 1 次成功（无超卖）");
  eq(conflict + badStatus, N_TEACHERS - 1, "其余 " + (N_TEACHERS - 1) + " 次被明确拒绝（409×" + conflict + " / 400×" + badStatus + "）");
  assert(conflict >= 1, "至少一次返回 409 冲突语义");

  const ordersOfDemand = all("SELECT * FROM orders WHERE demand_id = ?", demandId);
  eq(await waitCount("SELECT id FROM orders WHERE demand_id = ?", [demandId], 1), 1, "该需求只生成 1 笔订单（无数据异常）");
  const orderId = ordersOfDemand[0].id;

  eq(
    await waitCount("SELECT id FROM applications WHERE demand_id = ? AND status = 'pending'", [demandId], 0),
    0,
    "其余报名全部自动置为 rejected，无悬挂状态"
  );

  /* ---------- 4. 同一教员 100 次并发抢单 ---------- */
  section("4. 同一教员 100 次并发抢同一需求 → 仅 1 次成功");
  const dm2 = await post("/api/demands", {
    stage: "初中", subject: "数学", address: "西湖区文三路 128 号",
    lat: baseLat, lng: baseLng, budget: 18000, remark: "重复抢单验收",
  }, parentToken);
  const demandId2 = dm2.body.data.id;
  const sameTeacher = fixtureTokens[0];
  const dupGrabs = await Promise.all(
    Array.from({ length: N_TEACHERS }, () => post("/api/demands/" + demandId2 + "/apply", {}, sameTeacher))
  );
  eq(dupGrabs.filter((g) => g.status === 200).length, 1, "仅 1 次抢单成功");
  eq(all("SELECT id FROM applications WHERE demand_id = ?", demandId2).length, 1, "报名表只有 1 条记录");

  /* ---------- 5. 并发支付幂等 ---------- */
  section("5. 30 次并发支付同一订单 → 仅 1 条支付流水");
  const payIdem = "concurrent-pay-" + Date.now();
  const pays = await Promise.all(
    Array.from({ length: 30 }, () => post("/api/orders/" + orderId + "/pay", {}, parentToken, payIdem))
  );
  const payOk = pays.filter((p) => p.status === 200).length;
  eq(payOk, 30, "并发支付全部返回成功（幂等回放）");
  eq(await waitCount("SELECT id FROM payments WHERE order_id = ? AND type = 'pay'", [orderId], 1), 1, "支付流水只写入 1 条（未重复入账）");
  const escrowOfOrder = all(
    "SELECT direction, amount FROM escrow_ledger WHERE order_id = ? ORDER BY id",
    orderId
  );
  eq(escrowOfOrder.filter((e) => e.direction === "in").length, 1, "担保台账只有 1 笔入账（金额 ¥" + (escrowOfOrder[0].amount / 100).toFixed(2) + "）");

  /* ---------- 6. 数据一致性 ---------- */
  section("6. 事后数据一致性校验");
  const o = get("SELECT * FROM orders WHERE id = ?", orderId);
  eq(o.teacher_income + o.service_fee, o.amount, "订单分账恒等式 ①（实付 = 教员实收 + 服务费）");
  eq(o.agent_share + o.sales_commission + o.platform_revenue, o.service_fee, "订单分账恒等式 ②（服务费 = 代理 + 业务员 + 平台）");

  const escrowSum = get(
    "SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END),0) AS b FROM escrow_ledger"
  ).b;
  const shouldHold = get(
    "SELECT COALESCE(SUM(amount + urgent_fee),0) AS s FROM orders WHERE paid_at IS NOT NULL AND status NOT IN ('settled','refunded','cancelled')"
  ).s;
  eq(escrowSum, shouldHold, "担保账户余额与「已支付未结算未退款」总额一致（¥" + (escrowSum / 100).toFixed(2) + "）");

  const orphan = all(
    "SELECT a.id FROM applications a LEFT JOIN demands d ON d.id = a.demand_id WHERE d.id IS NULL"
  );
  eq(orphan.length, 0, "无孤儿报名记录");

  /* ---------- 清理 ---------- */
  section("7. 清理本次测试数据");
  try {
    for (const dId of [demandId, demandId2]) {
      for (const ord of all("SELECT id FROM orders WHERE demand_id = ?", dId)) {
        run("DELETE FROM wallet_txns WHERE order_id = ?", ord.id);
        run("DELETE FROM escrow_ledger WHERE order_id = ?", ord.id);
        run("DELETE FROM payments WHERE order_id = ?", ord.id);
        run("DELETE FROM risk_events WHERE order_id = ?", ord.id);
        run("DELETE FROM reviews WHERE order_id = ?", ord.id);
        run("DELETE FROM orders WHERE id = ?", ord.id);
      }
      run("DELETE FROM applications WHERE demand_id = ?", dId);
      run("DELETE FROM demands WHERE id = ?", dId);
    }
    for (const id of fixtureIds) {
      run("DELETE FROM teacher_services WHERE teacher_id = ?", id);
      run("DELETE FROM teacher_profiles WHERE user_id = ?", id);
      run("DELETE FROM wallets WHERE user_id = ?", id);
      run("DELETE FROM bindings WHERE user_id = ?", id);
      run("DELETE FROM favorites WHERE teacher_id = ?", id);
      run("DELETE FROM users WHERE id = ?", id);
    }
    assert(true, "测试数据已清理（需求、报名、订单、支付流水、教员账号）");
  } catch (e) {
    console.log("  - 清理未完成：" + e.message + "，请执行 npm run seed 还原");
  }

  console.log("\n=================================================");
  console.log("并发验收：通过 " + pass + " 项，失败 " + fail + " 项");
  if (fail) {
    console.log("失败项：");
    failures.forEach((f) => console.log("  - " + f));
    process.exitCode = 1;
  } else {
    console.log("100 人并发抢单无超卖、无重复接单、无重复入账 ✅");
  }
  console.log("=================================================");
})().catch((e) => {
  console.error("测试异常终止：", e);
  process.exitCode = 1;
});