// ============================================================
// 并发验收（测试以 MySQL 为权威库，对齐 test/concurrency.test.js 的 22 项断言）
//   1. 造 100 个已审核在线教员（直连 MySQL，避免 100 次注册/审核）
//   2. 100 个教员并发抢同一需求 → 100 条报名、无重复（Redis 分布式锁 + 唯一索引）
//   3. 100 次并发确认同一报名 → 仅生成 1 笔订单（无超卖）
//   4. 同一教员 100 次并发抢单 → 仅 1 次成功
//   5. 30 次并发支付同一订单 → 仅 1 条支付流水（幂等）
//   6. 事后数据一致性（分账恒等式 / 担保台账闭合 / 无孤儿报名）
// 用法：由 tools/gate-p7.mjs 在同批次内起服务后调用
// ============================================================
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";

// mysql2 安装在 apps/api-nest（NestJS 后端依赖），用 createRequire 从其 node_modules 解析
const requireFromApi = createRequire(new URL("../apps/api-nest/package.json", import.meta.url));
const mysql = requireFromApi("mysql2/promise");

const BASE = process.env.BASE_URL || "http://localhost:4300";
const PW = "a123456";
const N_TEACHERS = 100;
const PHONE_BASE = 13900000900;
const AUTH_SECRET = process.env.AUTH_SECRET || "jiajiao-dev-secret-please-change-in-prod";

let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "  " + extra : "")); }
  else { fail++; failures.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function eq(a, e, name) { assert(a === e, name, "期望 " + e + " / 实际 " + a); }
function section(t) { console.log("\n===== " + t + " ====="); }

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3307),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "jiajiao",
  supportBigNumbers: true,
  bigNumberStrings: false,
});
const all = async (sql, p = []) => (await conn.query(sql, p))[0];
const one = async (sql, p = []) => (await all(sql, p))[0];
const exec = async (sql, p = []) => (await conn.query(sql, p))[0];
const nowIso = () => new Date().toISOString();

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

/** 与 NestJS 侧 common/token.ts 完全一致的令牌格式 */
function signToken(uid, role) {
  const b64u = (s) => Buffer.from(s).toString("base64url");
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const body = b64u(JSON.stringify({ uid: Number(uid), role, exp }));
  const sig = createHmac("sha256", AUTH_SECRET).update(head + "." + body).digest("base64url");
  return head + "." + body + "." + sig;
}

async function waitCount(sql, params, expect, tries = 40) {
  let rows = await all(sql, params);
  for (let i = 0; i < tries && rows.length !== expect; i++) {
    await new Promise((r) => setTimeout(r, 50));
    rows = await all(sql, params);
  }
  return rows.length;
}

async function login(phone) {
  const r = await post("/api/auth/login-password", { phone, password: PW });
  if (r.status !== 200) throw new Error("登录失败 " + phone + ": " + r.text);
  return r.body.data.token;
}

try {
  console.log("家教平台 · 并发验收测试（MySQL 权威库）");
  console.log("目标服务：" + BASE);

  const parentToken = await login("13900000301");
  const xh = await one("SELECT * FROM `regions` WHERE `name` LIKE ? ORDER BY `id` LIMIT 1", ["%西湖%"]);
  const regionId = Number(xh.id);

  /* ---------- 1. 造 100 个在线教员 ---------- */
  section("1. 准备 " + N_TEACHERS + " 个已审核在线教员");
  const fixtureIds = [];
  const fixtureTokens = [];
  const baseLat = 30.262;
  const baseLng = 120.133;
  for (let i = 0; i < N_TEACHERS; i++) {
    const phone = String(PHONE_BASE + i);
    const nickname = "压测教员" + String(i + 1).padStart(3, "0");
    let u = await one("SELECT * FROM `users` WHERE `phone` = ?", [phone]);
    let uid;
    if (u) {
      uid = Number(u.id);
      await exec("UPDATE `users` SET `status` = 'active', `nickname` = ? WHERE `id` = ?", [nickname, uid]);
    } else {
      const r = await exec(
        "INSERT INTO `users` (`phone`,`nickname`,`role`,`status`,`region_id`,`created_at`) VALUES (?,?,?,?,?,?)",
        [phone, nickname, "teacher", "active", regionId, nowIso()],
      );
      uid = Number(r.insertId);
    }
    const tp = await one("SELECT `user_id` FROM `teacher_profiles` WHERE `user_id` = ?", [uid]);
    if (!tp) {
      await exec(
        `INSERT INTO \`teacher_profiles\` (\`user_id\`,\`identity_type\`,\`real_name\`,\`subjects\`,\`stages\`,\`hourly_price\`,
          \`service_radius_km\`,\`base_lat\`,\`base_lng\`,\`audit_status\`,\`online\`,\`growth_score\`,\`level\`,\`rating_avg\`,\`response_factor\`,
          \`created_at\`,\`updated_at\`)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uid, "in_service", nickname, "数学", "初中,高中", 18000, 10, baseLat, baseLng, "approved", 1, 2400, "Lv5", 4.9, 1, nowIso(), nowIso()],
      );
    } else {
      await exec(
        "UPDATE `teacher_profiles` SET `audit_status` = 'approved', `online` = 1, `base_lat` = ?, `base_lng` = ?, `service_radius_km` = 10 WHERE `user_id` = ?",
        [baseLat, baseLng, uid],
      );
    }
    await exec("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [uid, nowIso()]);
    fixtureIds.push(uid);
    fixtureTokens.push(signToken(uid, "teacher"));
  }
  assert(fixtureIds.length === N_TEACHERS, "已就绪 " + N_TEACHERS + " 个可接单教员");

  /* ---------- 2. 100 人并发抢同一需求 ---------- */
  section("2. " + N_TEACHERS + " 个教员并发抢同一需求");
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
  eq(grabOk, N_TEACHERS, N_TEACHERS + " 个不同教员全部报名成功（报名制）");
  console.log("     " + N_TEACHERS + " 次并发抢单耗时 " + grabMs + "ms（Redis 分布式锁串行化临界区）");
  const lockUsed = grabs.filter((g) => g.body?.data?.lockAcquired === true).length;
  assert(lockUsed >= Math.floor(N_TEACHERS * 0.8), "临界区由 Redis 锁保护（" + lockUsed + "/" + N_TEACHERS + " 次在锁内完成）", "");

  const dInfo = (await getApi("/api/demands/" + demandId, parentToken)).body.data;
  const appRows = dInfo.applications;
  eq(appRows.length, N_TEACHERS, "报名表恰好 " + N_TEACHERS + " 条记录（服务端口径）");
  eq(await waitCount("SELECT `id` FROM `applications` WHERE `demand_id` = ?", [demandId], N_TEACHERS), N_TEACHERS, "直连 MySQL 交叉核对一致");
  const dupPairs = await all(
    "SELECT `teacher_id`, COUNT(*) AS c FROM `applications` WHERE `demand_id` = ? GROUP BY `teacher_id` HAVING c > 1",
    [demandId],
  );
  eq(dupPairs.length, 0, "不存在重复报名（唯一索引生效）");
  const priorities = appRows.map((a) => Number(a.priority));
  assert(priorities.every((p) => p > 0), "每条报名都计算了派单优先级（示例 " + priorities[0] + "）");

  /* ---------- 3. 100 次并发确认 ---------- */
  section("3. " + N_TEACHERS + " 次并发确认同一报名 → 只生成 1 笔订单");
  const appId = appRows[0].id;
  const confirms = await Promise.all(
    Array.from({ length: N_TEACHERS }, () => post("/api/demands/" + demandId + "/confirm", { applicationId: appId }, parentToken)),
  );
  const confirmOk = confirms.filter((c) => c.status === 200).length;
  const conflict = confirms.filter((c) => c.status === 409).length;
  const badStatus = confirms.filter((c) => c.status === 400).length;
  eq(confirmOk, 1, "并发确认仅 1 次成功（无超卖）");
  eq(conflict + badStatus, N_TEACHERS - 1, "其余 " + (N_TEACHERS - 1) + " 次被明确拒绝（409×" + conflict + " / 400×" + badStatus + "）");
  assert(conflict >= 1, "至少一次返回 409 冲突语义");

  const ordersOfDemand = await all("SELECT * FROM `orders` WHERE `demand_id` = ?", [demandId]);
  eq(await waitCount("SELECT `id` FROM `orders` WHERE `demand_id` = ?", [demandId], 1), 1, "该需求只生成 1 笔订单（无数据异常）");
  const orderId = Number(ordersOfDemand[0].id);
  eq(
    await waitCount("SELECT `id` FROM `applications` WHERE `demand_id` = ? AND `status` = 'pending'", [demandId], 0),
    0,
    "其余报名全部自动置为 rejected，无悬挂状态",
  );

  /* ---------- 4. 同一教员 100 次并发抢单 ---------- */
  section("4. 同一教员 " + N_TEACHERS + " 次并发抢同一需求 → 仅 1 次成功");
  const dm2 = await post("/api/demands", {
    stage: "初中", subject: "数学", address: "西湖区文三路 128 号",
    lat: baseLat, lng: baseLng, budget: 18000, remark: "重复抢单验收",
  }, parentToken);
  const demandId2 = dm2.body.data.id;
  const sameTeacher = fixtureTokens[0];
  const dupGrabs = await Promise.all(
    Array.from({ length: N_TEACHERS }, () => post("/api/demands/" + demandId2 + "/apply", {}, sameTeacher)),
  );
  eq(dupGrabs.filter((g) => g.status === 200).length, 1, "仅 1 次抢单成功");
  eq((await all("SELECT `id` FROM `applications` WHERE `demand_id` = ?", [demandId2])).length, 1, "报名表只有 1 条记录");

  /* ---------- 5. 并发支付幂等 ---------- */
  section("5. 30 次并发支付同一订单 → 仅 1 条支付流水");
  const payIdem = "concurrent-pay-" + Date.now();
  const pays = await Promise.all(
    Array.from({ length: 30 }, () => post("/api/orders/" + orderId + "/pay", {}, parentToken, payIdem)),
  );
  const payOk = pays.filter((p) => p.status === 200).length;
  eq(payOk, 30, "并发支付全部返回成功（幂等回放）");
  eq(await waitCount("SELECT `id` FROM `payments` WHERE `order_id` = ? AND `type` = 'pay'", [orderId], 1), 1, "支付流水只写入 1 条（未重复入账）");
  const escrowOfOrder = await all("SELECT `direction`,`amount` FROM `escrow_ledger` WHERE `order_id` = ? ORDER BY `id`", [orderId]);
  eq(escrowOfOrder.filter((e) => e.direction === "in").length, 1, "担保台账只有 1 笔入账（金额 ¥" + (Number(escrowOfOrder[0].amount) / 100).toFixed(2) + "）");

  /* ---------- 6. 事后一致性 ---------- */
  section("6. 事后数据一致性校验");
  const o = await one("SELECT * FROM `orders` WHERE `id` = ?", [orderId]);
  eq(Number(o.teacher_income) + Number(o.service_fee), Number(o.amount), "订单分账恒等式 ①（实付 = 教员实收 + 服务费）");
  eq(Number(o.agent_share) + Number(o.sales_commission) + Number(o.platform_revenue), Number(o.service_fee), "订单分账恒等式 ②（服务费 = 代理 + 业务员 + 平台）");

  const escrowSum = Number((await one(
    "SELECT COALESCE(SUM(CASE WHEN `direction` = 'in' THEN `amount` ELSE -`amount` END),0) AS b FROM `escrow_ledger`",
  )).b);
  const shouldHold = Number((await one(
    "SELECT COALESCE(SUM(`amount` + `urgent_fee`),0) AS s FROM `orders` WHERE `paid_at` IS NOT NULL AND `status` NOT IN ('settled','refunded','cancelled')",
  )).s);
  eq(escrowSum, shouldHold, "担保账户余额与「已支付未结算未退款」总额一致（¥" + (escrowSum / 100).toFixed(2) + "）");
  const orphan = await all("SELECT a.`id` FROM `applications` a LEFT JOIN `demands` d ON d.id = a.demand_id WHERE d.id IS NULL");
  eq(orphan.length, 0, "无孤儿报名记录");

  /* ---------- 7. 清理 ---------- */
  section("7. 清理本次测试数据");
  try {
    for (const dId of [demandId, demandId2]) {
      for (const ord of await all("SELECT `id` FROM `orders` WHERE `demand_id` = ?", [dId])) {
        await exec("DELETE FROM `wallet_txns` WHERE `order_id` = ?", [ord.id]);
        await exec("DELETE FROM `escrow_ledger` WHERE `order_id` = ?", [ord.id]);
        await exec("DELETE FROM `payments` WHERE `order_id` = ?", [ord.id]);
        await exec("DELETE FROM `risk_events` WHERE `order_id` = ?", [ord.id]);
        await exec("DELETE FROM `reviews` WHERE `order_id` = ?", [ord.id]);
        await exec("DELETE FROM `orders` WHERE `id` = ?", [ord.id]);
      }
      await exec("DELETE FROM `applications` WHERE `demand_id` = ?", [dId]);
      await exec("DELETE FROM `demands` WHERE `id` = ?", [dId]);
    }
    for (const id of fixtureIds) {
      await exec("DELETE FROM `teacher_services` WHERE `teacher_id` = ?", [id]);
      await exec("DELETE FROM `teacher_profiles` WHERE `user_id` = ?", [id]);
      await exec("DELETE FROM `wallets` WHERE `user_id` = ?", [id]);
      await exec("DELETE FROM `bindings` WHERE `user_id` = ?", [id]);
      await exec("DELETE FROM `favorites` WHERE `user_id` = ?", [id]);
      await exec("DELETE FROM `users` WHERE `id` = ?", [id]);
    }
    assert(true, "测试数据已清理（需求、报名、订单、支付流水、教员账号）");
  } catch (e) {
    console.log("  - 清理未完成：" + e.message);
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
} catch (e) {
  console.error("测试异常终止：", e?.message || e);
  process.exitCode = 1;
} finally {
  await conn.end();
}
