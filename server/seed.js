// 演示数据种子：使用真实业务函数写入，保证订单/资金/台账自洽
import fs from "node:fs";
import path from "node:path";
import { db, get, run, migrate, DATA_DIR, DB_FILE } from "./core/db.js";
import { ensureDefaults } from "./core/config.js";
import { hashPassword } from "./core/auth.js";
import { nowIso, addDaysIso } from "./core/ids.js";
import { DEMO_PASSWORD } from "./core/defaults.js";
import { levelByScore } from "./core/rules.js";
import { createOrder, payOrder, checkin, finish, confirmComplete, cancelOrder, runSettlement, submitReview } from "./modules/orders.js";

const RESET = process.argv.includes("--reset");
if (RESET) {
  // 连接已打开，直接删除全部表（避免文件锁）
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  db.exec("PRAGMA foreign_keys = OFF");
  for (const t of tables) db.exec('DROP TABLE IF EXISTS "' + t + '"');
  db.exec("PRAGMA foreign_keys = ON");
  console.log("已清空旧数据表 " + tables.length + " 张");
}
migrate();
ensureDefaults();

if (get("SELECT COUNT(*) AS c FROM users").c > 0 && !RESET) {
  console.log("数据库已有数据，跳过种子（使用 npm run seed 强制重建）");
  process.exit(0);
}

const PW = hashPassword(DEMO_PASSWORD);
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();

function mkUser({ phone, nickname, role, regionId = null, realName = null, idCard = null, username = null }) {
  const r = run(
    "INSERT INTO users (phone, username, password_hash, nickname, role, status, real_name, id_card, region_id, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    phone, username, PW, nickname, role, "active", realName, idCard, regionId, ago(40), ago(0)
  );
  run("INSERT OR IGNORE INTO wallets (user_id, updated_at) VALUES (?,?)", r.id, nowIso());
  return r.id;
}

/* ---------------- 片区（电子围栏） ---------------- */
const REGION_DEFS = [
  { name: "杭州·西湖片区", code: "HZ-XH", lat: 30.2590, lng: 120.1300, r: 5.5 },
  { name: "杭州·滨江片区", code: "HZ-BJ", lat: 30.2084, lng: 120.2115, r: 5.5 },
  { name: "杭州·拱墅片区", code: "HZ-GS", lat: 30.3190, lng: 120.1420, r: 5.5 },
  { name: "杭州·余杭片区", code: "HZ-YH", lat: 30.4180, lng: 120.0000, r: 6.5 },
];
const regionIds = REGION_DEFS.map((d) => {
  const poly = [
    [d.lat + 0.045, d.lng - 0.05],
    [d.lat + 0.045, d.lng + 0.05],
    [d.lat - 0.045, d.lng + 0.05],
    [d.lat - 0.045, d.lng - 0.05],
  ];
  return run(
    "INSERT INTO regions (name, code, center_lat, center_lng, radius_km, polygon, created_at) VALUES (?,?,?,?,?,?,?)",
    d.name, d.code, d.lat, d.lng, d.r, JSON.stringify(poly), nowIso()
  ).id;
});

/* ---------------- 管理员 ---------------- */
mkUser({ phone: "13900000001", nickname: "平台管理员", role: "admin" });

/* ---------------- 区域代理 ---------------- */
function mkAgent({ phone, nickname, regionId, level, deposit, commissionRate, mgmtRate, agentName }) {
  const uid = mkUser({ phone, nickname, role: "agent", regionId });
  run(
    "INSERT INTO agent_profiles (user_id, region_id, level, signed_at, deposit, status, commission_rate, mgmt_rate) VALUES (?,?,?,?,?,?,?,?)",
    uid, regionId, level, ago(60), deposit, "active", commissionRate, mgmtRate
  );
  return uid;
}
const agent1 = mkAgent({ phone: "13900000010", nickname: "西湖代理·李经理", regionId: regionIds[0], level: "A", deposit: 5000000, commissionRate: 0.25, mgmtRate: 0.01 });
const agent2 = mkAgent({ phone: "13900000011", nickname: "滨江代理·王经理", regionId: regionIds[1], level: "B", deposit: 3000000, commissionRate: 0.22, mgmtRate: 0.008 });
const agent3 = mkAgent({ phone: "13900000012", nickname: "拱墅代理·赵经理", regionId: regionIds[2], level: "A", deposit: 5000000, commissionRate: 0.25, mgmtRate: 0.01 });
const agents = [agent1, agent2, agent3];

/* ---------------- 业务员 ---------------- */
const SALES_DEFS = [
  { phone: "13900000101", name: "业务员·陈晨", agent: agent1, region: regionIds[0] },
  { phone: "13900000102", name: "业务员·林小雨", agent: agent1, region: regionIds[0] },
  { phone: "13900000103", name: "业务员·赵鹏", agent: agent1, region: regionIds[0] },
  { phone: "13900000104", name: "业务员·孙悦", agent: agent2, region: regionIds[1] },
  { phone: "13900000105", name: "业务员·周航", agent: agent2, region: regionIds[1] },
  { phone: "13900000106", name: "业务员·吴敏", agent: agent3, region: regionIds[2] },
];
const salesIds = SALES_DEFS.map((s, i) => {
  const uid = mkUser({ phone: s.phone, nickname: s.name, role: "sales", regionId: s.region });
  run("INSERT INTO sales_profiles (user_id, agent_id, region_id, code, joined_at, status) VALUES (?,?,?,?,?,?)",
    uid, s.agent, s.region, "BD" + String(1001 + i), ago(35 - i), "active");
  for (const target of ["parent", "teacher"]) {
    run("INSERT INTO promotion_codes (sales_id, target, token, scans, registrations, created_at) VALUES (?,?,?,?,?,?)",
      uid, target, "BD" + String(1001 + i) + target.slice(0, 1).toUpperCase() + "XY", Math.floor(Math.random() * 60) + 10, 0, ago(30));
  }
  return uid;
});

/* ---------------- 教员 ---------------- */
// 教员端「用户名 + 密码」登录用的用户名（小写，唯一）；留空的账号只能用手机号登录
const TEACHER_USERNAMES = {
  "13900000201": "zhang",
  "13900000202": "li",
  "13900000203": "wangxue",
  "13900000204": "liuchang",
  "13900000205": "chenzihao",
  "13900000206": "zhaomin",
  "13900000207": "sunhaoran",
  "13900000208": "zhouya",
  "13900000209": "wujiahao",
  "13900000210": "zhengxiao",
  "13900000211": "huanglei",
  "13900000212": "linjing",
};
const TEACHER_DEFS = [
  { name: "张老师", phone: "13900000201", identity: "in_service", subjects: "数学,物理", stages: "初中,高中", price: 20000, growth: 2350, region: 0, lat: 30.2610, lng: 120.1320 },
  { name: "李思远", phone: "13900000202", identity: "student", subjects: "英语", stages: "小学,初中", price: 12000, growth: 720, region: 0, lat: 30.2540, lng: 120.1260 },
  { name: "王雪", phone: "13900000203", identity: "in_service", subjects: "语文", stages: "小学,初中", price: 15000, growth: 1280, region: 0, lat: 30.2650, lng: 120.1380 },
  { name: "刘畅", phone: "13900000204", identity: "part_time", subjects: "钢琴,吉他", stages: "兴趣类", price: 22000, growth: 160, region: 0, lat: 30.2500, lng: 120.1200 },
  { name: "陈子豪", phone: "13900000205", identity: "student", subjects: "数学", stages: "小学,初中", price: 10000, growth: 340, region: 1, lat: 30.2100, lng: 120.2100 },
  { name: "赵敏", phone: "13900000206", identity: "in_service", subjects: "英语,化学", stages: "高中", price: 26000, growth: 1860, region: 1, lat: 30.2050, lng: 120.2180 },
  { name: "孙浩然", phone: "13900000207", identity: "student", subjects: "物理,数学", stages: "高中", price: 18000, growth: 980, region: 1, lat: 30.2130, lng: 120.2050 },
  { name: "周雅", phone: "13900000208", identity: "in_service", subjects: "美术,书法", stages: "兴趣类,小学", price: 16000, growth: 640, region: 2, lat: 30.3200, lng: 120.1400 },
  { name: "吴嘉豪", phone: "13900000209", identity: "part_time", subjects: "编程", stages: "初中,高中", price: 24000, growth: 1520, region: 2, lat: 30.3170, lng: 120.1470 },
  { name: "郑晓", phone: "13900000210", identity: "student", subjects: "语文,英语", stages: "小学", price: 9000, growth: 80, region: 2, lat: 30.3230, lng: 120.1350 },
  { name: "黄磊", phone: "13900000211", identity: "in_service", subjects: "数学,英语", stages: "初中,高中", price: 21000, growth: 2100, region: 3, lat: 30.4200, lng: 120.0030 },
  { name: "林静", phone: "13900000212", identity: "student", subjects: "英语", stages: "小学,初中", price: 11000, growth: 420, region: 3, lat: 30.4150, lng: 119.9960 },
];
const teacherIds = TEACHER_DEFS.map((t, i) => {
  const uid = mkUser({ phone: t.phone, nickname: t.name, role: "teacher", regionId: regionIds[t.region], realName: t.name, idCard: "33010619950101" + String(1000 + i), username: TEACHER_USERNAMES[t.phone] });
  const lv = levelByScore(t.growth);
  const audit = i === TEACHER_DEFS.length - 1 ? "pending" : "approved";
  run(
    `INSERT INTO teacher_profiles (user_id, identity_type, real_name, id_card, edu_cert_url, teacher_cert_url, skill_cert_url,
      intro, subjects, stages, hourly_price, service_radius_km, base_lat, base_lng, schedule, cover_area, audit_status,
      online, growth_score, level, rating_avg, rating_count, completed_lessons, response_factor, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid, t.identity, t.name, "33010619950101" + String(1000 + i),
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", t.identity === "in_service" ? "cert" : null, null,
    t.name + "，" + (t.identity === "in_service" ? "在职教师" : t.identity === "student" ? "重点高校在读" : "社会兼职教员") + "，擅长" + t.subjects + "，教龄 " + (2 + (i % 6)) + " 年。",
    t.subjects, t.stages, t.price, 5, t.lat, t.lng,
    JSON.stringify([
      { day: 1, slots: ["09:00-11:00", "14:00-16:00"] },
      { day: 3, slots: ["18:00-20:00"] },
      { day: 6, slots: ["09:00-12:00", "15:00-18:00"] },
    ]),
    REGION_DEFS[t.region].name.replace("杭州·", ""),
    audit, audit === "approved" ? 1 : 0, t.growth, lv.level,
    Number((4.3 + (i % 7) * 0.1).toFixed(2)), 8 + (i % 12), Math.floor(t.growth / 6), Number((0.9 + (i % 5) * 0.06).toFixed(2)),
    ago(38 - i), nowIso()
  );
  // P67：每隔一位教员的服务同时支持「上门授课 + 在教员家授课」，其余只上门——用来演示服务级开关
  const svcPlaces = i % 2 === 0 ? "home,teacher_place" : "home";
  run("INSERT INTO teacher_services (teacher_id, title, subjects, stages, price, cover_radius_km, schedule, description, places, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    uid, t.subjects.split(",")[0] + " 一对一辅导", t.subjects, t.stages, t.price, 5,
    JSON.stringify([{ day: 6, slots: ["09:00-11:00"] }]), "针对孩子基础定制提分计划，含课后作业批改与月度测评反馈。",
    svcPlaces, "on", ago(30), nowIso());
  if (audit === "approved") {
    run("INSERT INTO growth_logs (teacher_id, change, reason, balance_after, created_at) VALUES (?,?,?,?,?)", uid, t.growth, "历史累计成长分", t.growth, ago(20));
  }
  return uid;
});

/* ---------------- 家长 ---------------- */
const PARENT_DEFS = [
  { name: "家长·周女士", phone: "13900000301", region: 0, lat: 30.2620, lng: 120.1330, addr: "西湖区文三路 128 号 学军小区 3 幢 502" },
  { name: "家长·钱先生", phone: "13900000302", region: 0, lat: 30.2565, lng: 120.1275, addr: "西湖区古翠路 66 号 阳光公寓 1 幢 801" },
  { name: "家长·孙女士", phone: "13900000303", region: 0, lat: 30.2680, lng: 120.1400, addr: "西湖区文一西路 218 号 嘉绿苑 5 幢 302" },
  { name: "家长·吴先生", phone: "13900000304", region: 1, lat: 30.2090, lng: 120.2130, addr: "滨江区江南大道 88 号 星光国际 2 幢 1501" },
  { name: "家长·郑女士", phone: "13900000305", region: 1, lat: 30.2060, lng: 120.2160, addr: "滨江区滨盛路 1509 号 钱江湾 6 幢 601" },
  { name: "家长·王先生", phone: "13900000306", region: 1, lat: 30.2120, lng: 120.2080, addr: "滨江区长河路 351 号 天寓小区 4 幢 1102" },
  { name: "家长·冯女士", phone: "13900000307", region: 2, lat: 30.3180, lng: 120.1420, addr: "拱墅区莫干山路 100 号 运河人家 8 幢 401" },
  { name: "家长·陈先生", phone: "13900000308", region: 2, lat: 30.3210, lng: 120.1380, addr: "拱墅区上塘路 200 号 金麟府 12 幢 903" },
  { name: "家长·许女士", phone: "13900000309", region: 3, lat: 30.4190, lng: 120.0020, addr: "余杭区良渚文化村 春漫里 7 幢 202" },
  { name: "家长·何先生", phone: "13900000310", region: 3, lat: 30.4170, lng: 119.9980, addr: "余杭区文一西路 998 号 万科良渚 3 幢 501" },
];
const parentIds = PARENT_DEFS.map((p, i) => {
  const uid = mkUser({ phone: p.phone, nickname: p.name, role: "parent", regionId: regionIds[p.region], realName: p.name });
  const credit = [100, 180, 300, 480, 120, 260, 60, 330, 150, 420][i];
  const lv = credit >= 451 ? "L3" : credit >= 251 ? "L2" : credit >= 101 ? "L1" : "L0";
  run("INSERT INTO parent_profiles (user_id, credit_score, credit_level, completed_orders, cancel_count) VALUES (?,?,?,?,?)",
    uid, credit, lv, Math.floor(credit / 40), i % 3 === 0 ? 1 : 0);
  run("INSERT INTO addresses (user_id, label, contact, phone, region_id, address, lat, lng, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    uid, "家", p.name.replace("家长·", ""), p.phone, regionIds[p.region], p.addr, p.lat, p.lng, 1, ago(30));
  // 用户归属：半数来自业务员推广，半数自然注册
  const salesIdx = i % salesIds.length;
  if (i % 2 === 0) {
    const sp = get("SELECT * FROM sales_profiles WHERE user_id = ?", salesIds[salesIdx]);
    run("INSERT INTO bindings (user_id, sales_id, agent_id, region_id, source, bound_at) VALUES (?,?,?,?,?,?)",
      uid, salesIds[salesIdx], sp.agent_id, sp.region_id, "scan", ago(26 - i));
  } else {
    run("INSERT INTO bindings (user_id, sales_id, agent_id, region_id, source, bound_at) VALUES (?,?,?,?,?,?)",
      uid, null, agents[p.region] ?? null, regionIds[p.region], "natural", ago(24 - i));
  }
  return uid;
});

/* ---------------- 需求（待抢单） ---------------- */
const DEMAND_DEFS = [
  { p: 0, stage: "初中", subject: "数学", budget: 20000, urgent: 1, remark: "孩子初二，函数较弱，希望周末两天各 2 小时", region: 0, lat: 30.2620, lng: 120.1330, addr: PARENT_DEFS[0].addr },
  { p: 2, stage: "小学", subject: "英语", budget: 12000, urgent: 0, remark: "四年级，需要自然拼读与口语练习", region: 0, lat: 30.2680, lng: 120.1400, addr: PARENT_DEFS[2].addr },
  { p: 4, stage: "高中", subject: "化学", budget: 26000, urgent: 0, remark: "高三冲刺，重点有机化学", region: 1, lat: 30.2060, lng: 120.2160, addr: PARENT_DEFS[4].addr },
  { p: 6, stage: "兴趣类", subject: "钢琴", budget: 22000, urgent: 1, remark: "孩子 8 岁，零基础，家里有钢琴", region: 2, lat: 30.3180, lng: 120.1420, addr: PARENT_DEFS[6].addr },
  { p: 8, stage: "初中", subject: "英语", budget: 15000, urgent: 0, remark: "希望女老师，耐心一点", region: 3, lat: 30.4190, lng: 120.0020, addr: PARENT_DEFS[8].addr, gender: "女" },
  { p: 1, stage: "小学", subject: "数学", budget: 10000, urgent: 0, remark: "三年级，需培养习惯", region: 0, lat: 30.2565, lng: 120.1275, addr: PARENT_DEFS[1].addr },
  { p: 7, stage: "高中", subject: "物理", budget: 18000, urgent: 0, remark: "高二，力学基础薄弱", region: 2, lat: 30.3210, lng: 120.1380, addr: PARENT_DEFS[7].addr },
];
const demandIds = DEMAND_DEFS.map((d) => {
  const times = [
    { date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), start: "09:00", end: "11:00" },
    { date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), start: "09:00", end: "11:00" },
  ];
  return run(
    `INSERT INTO demands (parent_id, stage, subject, mode, address, lat, lng, region_id, times, budget, remark, gender_pref,
      urgent, urgent_fee, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    parentIds[d.p], d.stage, d.subject, "home", d.addr, d.lat, d.lng, regionIds[d.region], JSON.stringify(times),
    d.budget, d.remark, d.gender || "", d.urgent, d.urgent ? 2000 : 0, "published", ago(1), ago(1)
  ).id;
});

/* ---------------- 订单（走真实业务流） ---------------- */
const fakeCtx = (uid, role) => ({ user: { id: uid, role }, body: {}, req: { headers: {} }, ip: "127.0.0.1" });
const nextLesson = (days = 3) => new Date(Date.now() + days * 86400000).toISOString();

const ORDER_PLAN = [
  { p: 0, t: 0, subject: "数学", stage: "初中", amount: 20000, flow: "settled", days: 12 },
  { p: 1, t: 1, subject: "英语", stage: "小学", amount: 12000, flow: "settled", days: 10 },
  { p: 2, t: 2, subject: "语文", stage: "初中", amount: 15000, flow: "settled", days: 8 },
  { p: 3, t: 5, subject: "英语", stage: "高中", amount: 26000, flow: "settled", days: 14 },
  { p: 4, t: 6, subject: "物理", stage: "高中", amount: 18000, flow: "settled", days: 9 },
  { p: 6, t: 7, subject: "美术", stage: "兴趣类", amount: 16000, flow: "settled", days: 11 },
  { p: 7, t: 8, subject: "编程", stage: "初中", amount: 24000, flow: "settled", days: 7 },
  { p: 8, t: 10, subject: "数学", stage: "初中", amount: 21000, flow: "settled", days: 6 },
  { p: 9, t: 3, subject: "钢琴", stage: "兴趣类", amount: 22000, flow: "completed", days: 3 },
  { p: 0, t: 2, subject: "语文", stage: "小学", amount: 15000, flow: "completed", days: 4 },
  { p: 1, t: 4, subject: "数学", stage: "小学", amount: 10000, flow: "awaiting_parent_confirm", days: 1 },
  { p: 3, t: 5, subject: "化学", stage: "高中", amount: 26000, flow: "in_class", days: 0 },
  { p: 5, t: 6, subject: "物理", stage: "高中", amount: 18000, flow: "pending_class", days: 2 },
  { p: 6, t: 8, subject: "编程", stage: "高中", amount: 24000, flow: "pending_class", days: 3 },
  { p: 7, t: 7, subject: "书法", stage: "小学", amount: 16000, flow: "awaiting_payment", days: 4 },
  { p: 8, t: 11, subject: "英语", stage: "初中", amount: 11000, flow: "awaiting_payment", days: 5 },
  { p: 2, t: 0, subject: "物理", stage: "高中", amount: 20000, flow: "refunded", days: 2 },
];

const createdOrders = [];
for (const plan of ORDER_PLAN) {
  const parentId = parentIds[plan.p];
  const teacherId = teacherIds[plan.t];
  const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", teacherId);
  const flow = plan.flow;

  const order = createOrder({
    parentId, teacherId,
    subject: plan.subject, stage: plan.stage,
    lessonTime: nextLesson(plan.days),
    address: PARENT_DEFS[plan.p].addr,
    lat: PARENT_DEFS[plan.p].lat, lng: PARENT_DEFS[plan.p].lng,
    regionId: regionIds[PARENT_DEFS[plan.p].region],
    amount: plan.amount,
  });
  createdOrders.push(order.id);

  if (flow === "awaiting_payment") continue;

  payOrder(fakeCtx(parentId, "parent"), order.id);

  if (flow === "pending_class") continue;

  if (flow === "refunded") {
    // 走真实取消退款流程，保证担保台账闭合
    cancelOrder(fakeCtx(parentId, "parent"), order.id, "家长行程变动，课前 4 小时以上取消");
    run("UPDATE orders SET created_at = ?, paid_at = ?, updated_at = ? WHERE id = ?", ago(2), ago(2), ago(2), order.id);
    continue;
  }

  const fresh = get("SELECT * FROM orders WHERE id = ?", order.id);
  checkin(fakeCtx(teacherId, "teacher"), order.id, fresh.lat, fresh.lng);
  if (flow === "in_class") continue;

  finish(fakeCtx(teacherId, "teacher"), order.id);
  if (flow === "awaiting_parent_confirm") continue;

  confirmComplete(fakeCtx(parentId, "parent"), order.id);

  // 评价
  const score = [5, 5, 4, 5, 4, 5, 3, 5, 4, 5][createdOrders.length % 10];
  const tags = score >= 4 ? ["准时", "耐心", "专业"] : ["讲解清晰"];
  try {
    submitReview(fakeCtx(parentId, "parent"), order.id, {
      score, tags,
      content: score >= 4 ? "老师很负责，孩子反馈讲得清楚，作业也有批改。" : "整体还行，希望节奏再快一点。",
    });
  } catch (e) { /* 忽略 */ }

  // 时间回拨，使历史订单看起来更真实
  const d = plan.flow === "settled" ? 15 : 6;
  run("UPDATE orders SET created_at = ?, paid_at = ?, checkin_at = ?, finished_at = ?, confirm_at = ?, updated_at = ?, lesson_time = ?, settle_at = ? WHERE id = ?",
    ago(d), ago(d), ago(d - 0.1), ago(d - 0.2), ago(d - 0.3), ago(d - 0.3),
    ago(d - 1), flow === "settled" ? ago(d - 7) : addDaysIso(nowIso(), 7), order.id);
}

// 触发结算放款
const settledCount = runSettlement();

/* ---------------- 抢单报名 ---------------- */
for (let i = 0; i < 3; i++) {
  const d = get("SELECT * FROM demands WHERE id = ?", demandIds[i]);
  const candidates = [0, 2, 4, 6].map((k) => teacherIds[k]);
  for (const t of candidates.slice(0, 2)) {
    const tp = get("SELECT * FROM teacher_profiles WHERE user_id = ?", t);
    if (!tp.subjects.includes(d.subject)) continue;
    run("INSERT OR IGNORE INTO applications (demand_id, teacher_id, status, priority, distance_km, created_at) VALUES (?,?,?,?,?,?)",
      d.id, t, "pending", Number((0.6 + Math.random() * 0.8).toFixed(3)), Number((0.8 + Math.random() * 2).toFixed(2)), ago(0.5));
  }
}

/* ---------------- 业务员奖励 ---------------- */
const rewardCfg = { register: 1000, lead: 500 };
salesIds.forEach((sid, i) => {
  const bound = all0(sid);
  for (const b of bound) {
    run("INSERT INTO rewards (sales_id, type, amount, ref_user_id, status, calc_note, settle_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
      sid, "register", 1000, b, "settled", "扫码新注册奖励 ¥10.00", ago(20), ago(21));
  }
  if (i % 2 === 0) {
    run("INSERT INTO rewards (sales_id, type, amount, ref_user_id, status, calc_note, created_at) VALUES (?,?,?,?,?,?,?)",
      sid, "lead", 500, parentIds[i], "pending", "有效留资奖励 ¥5.00", ago(3));
  }
  if (i === 0) {
    run("INSERT INTO rewards (sales_id, type, amount, ref_user_id, status, calc_note, settle_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
      sid, "daily_champ", 5000, null, "settled", "日冠军奖 ¥50.00", ago(5), ago(6));
    run("INSERT INTO rewards (sales_id, type, amount, ref_user_id, status, calc_note, settle_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
      sid, "weekly_champ", 20000, null, "settled", "周冠军奖 ¥200.00", ago(4), ago(8));
  }
});
function all0(sid) {
  return db.prepare("SELECT user_id FROM bindings WHERE sales_id = ?").all(sid).map((r) => r.user_id);
}

/* ---------------- 客诉 / 风控 ---------------- */
const sampleOrder = get("SELECT * FROM orders WHERE status IN ('completed','settled') ORDER BY id DESC LIMIT 1");
if (sampleOrder) {
  run("INSERT INTO complaints (order_id, from_user, from_role, against_user, region_id, type, title, content, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    sampleOrder.id, sampleOrder.parent_id, "parent", sampleOrder.teacher_id, sampleOrder.region_id, "complaint",
    "上课时间迟到 20 分钟", "老师第一次上门迟到，希望平台协调补偿。", "open", ago(1));
  run("INSERT INTO risk_events (order_id, user_id, region_id, type, level, reason, status, settlement_hold, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    sampleOrder.id, sampleOrder.teacher_id, sampleOrder.region_id, "abnormal_location", "mid",
    "打卡定位距离 820 米，超出阈值 500 米", "open", 1, ago(1));
}
if (sampleOrder) {
  run("INSERT INTO risk_events (order_id, user_id, region_id, type, level, reason, status, settlement_hold, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    null, parentIds[3], regionIds[1], "brush", "high", "同一设备 24 小时内注册 4 个账号并下单", "open", 0, ago(2));
  run("INSERT INTO risk_events (order_id, user_id, region_id, type, level, reason, status, settlement_hold, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    sampleOrder.id, sampleOrder.teacher_id, regionIds[0], "fake_checkin", "high", "连续 3 单打卡坐标与上课地址相差 > 2 公里", "reviewing", 1, ago(3));
}

/* ---------------- 提现申请 ---------------- */
const tWithWallet = teacherIds.find((t) => {
  const w = get("SELECT balance FROM wallets WHERE user_id = ?", t);
  return w && w.balance >= 20000;
});
if (tWithWallet) {
  run("INSERT INTO withdrawals (user_id, role, amount, fee, actual, channel, account, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    tWithWallet, "teacher", 20000, 120, 19880, "wechat", "139****0201", "pending", ago(1));
}
const sWithWallet = salesIds[0];
run("INSERT INTO rewards (sales_id, type, amount, ref_user_id, status, calc_note, settle_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
  sWithWallet, "register", 1000, parentIds[0], "settled", "扫码新注册奖励 ¥10.00", ago(10), ago(11));

/* ---------------- 运营内容 ---------------- */
for (const b of [
  { title: "新用户首单立减 30 元", image: "", link: "/parent", sort: 1 },
  { title: "名师一对一 · 免费试听 30 分钟", image: "", link: "/parent#/plaza", sort: 2 },
  { title: "邀请好友下单，双方各得 20 元券", image: "", link: "/parent", sort: 3 },
]) {
  run("INSERT INTO banners (title, image, link, sort, status, created_at) VALUES (?,?,?,?,?,?)", b.title, b.image, b.link, b.sort, "on", nowIso());
}

for (const a of [
  { title: "平台资质审核时间调整通知", content: "自本周起，教员资质人工核验时效由 48 小时缩短至 24 小时。", audience: "all", pinned: 1 },
  { title: "关于规范上门家教服务的公告", content: "平台仅提供家教信息撮合服务，请勿在平台外私下交易，以免造成资金损失。", audience: "all", pinned: 1 },
  { title: "教员端等级权益更新说明", content: "Lv4 及以上教员派单权重提升，抽佣比例下调。", audience: "teacher", pinned: 0 },
  { title: "片区季度考核提醒", content: "请各片区代理商于月底前完成业务员考核数据确认。", audience: "agent", pinned: 0 },
]) {
  run("INSERT INTO announcements (title, content, audience, pinned, status, created_at) VALUES (?,?,?,?,?,?)",
    a.title, a.content, a.audience, a.pinned, "on", ago(2));
}

for (const c of [
  { name: "新用户首单立减 30 元", amount: 3000, threshold: 10000, total: 500 },
  { name: "满 200 减 20", amount: 2000, threshold: 20000, total: 1000 },
  { name: "满 500 减 60", amount: 6000, threshold: 50000, total: 300 },
]) {
  run("INSERT INTO coupons (name, amount, threshold, total, claimed, valid_from, valid_to, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    c.name, c.amount, c.threshold, c.total, 0, ago(10), addDaysIso(nowIso(), 30), "on", nowIso());
}

for (const a of [
  { key: "user", title: "用户协议", content: "本平台为家教信息撮合服务提供方，为家长与教员提供需求发布、撮合、担保交易与评价等服务。用户应保证所提交信息真实有效。" },
  { key: "privacy", title: "隐私政策", content: "我们仅在必要范围内收集手机号、地址、定位等信息，并严格按照《个人信息保护法》要求处理，用户可随时申请注销账号。" },
  { key: "refund", title: "退费规则", content: "上课前 4 小时以上取消可全额退款；4 小时内取消收取 20% 违约金；课程已开始不支持直接退款，可发起客诉由平台仲裁。" },
]) {
  run("INSERT INTO agreements (key, title, content, updated_at) VALUES (?,?,?,?)", a.key, a.title, a.content, nowIso());
}

/* ---------------- 消息 ---------------- */
run("INSERT INTO messages (user_id, title, content, type, read, created_at) VALUES (?,?,?,?,?,?)",
  parentIds[0], "欢迎加入家教撮合平台", "完善地址信息可更快匹配到附近教员", "system", 0, nowIso());

console.log("种子数据生成完成");
console.log("---------------------------------------------");
console.log("平台管理后台  13900000001 / " + DEMO_PASSWORD);
console.log("区域代理(西湖) 13900000010 / " + DEMO_PASSWORD);
console.log("区域代理(滨江) 13900000011 / " + DEMO_PASSWORD);
console.log("业务员        13900000101 / " + DEMO_PASSWORD);
console.log("教员(名师)    13900000201 / " + DEMO_PASSWORD);
console.log("教员(见习)    13900000204 / " + DEMO_PASSWORD);
console.log("家长          13900000301 / " + DEMO_PASSWORD);
console.log("待审核教员    13900000212 / " + DEMO_PASSWORD);
console.log("---------------------------------------------");
console.log("订单 " + createdOrders.length + " 笔，已结算 " + settledCount + " 笔");