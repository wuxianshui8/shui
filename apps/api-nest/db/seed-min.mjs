// 为 MySQL 版后端准备最小可用数据：片区、管理员、15 组规则配置
import mysql from "mysql2/promise";
import { DEFAULT_RULES, DEMO_PASSWORD } from "../../../server/core/defaults.js";
import { hashPassword } from "../dist/common/password.js";
import { config } from "../dist/config.js";

const conn = await mysql.createConnection({
  host: config.mysql.host, port: config.mysql.port,
  user: config.mysql.username, password: config.mysql.password,
  database: config.mysql.database, charset: "utf8mb4",
});
const now = new Date().toISOString();

// 片区（电子围栏用矩形近似）
const REGIONS = [
  { name: "杭州·西湖片区", code: "HZ-XH", lat: 30.259, lng: 120.13, r: 5.5 },
  { name: "杭州·滨江片区", code: "HZ-BJ", lat: 30.2084, lng: 120.2115, r: 5.5 },
  { name: "杭州·拱墅片区", code: "HZ-GS", lat: 30.319, lng: 120.142, r: 5.5 },
  { name: "杭州·余杭片区", code: "HZ-YH", lat: 30.418, lng: 120.0, r: 6.5 },
];
for (const r of REGIONS) {
  const poly = [
    [r.lat + 0.045, r.lng - 0.05], [r.lat + 0.045, r.lng + 0.05],
    [r.lat - 0.045, r.lng + 0.05], [r.lat - 0.045, r.lng - 0.05],
  ];
  await conn.execute(
    "INSERT INTO `regions` (`name`,`code`,`center_lat`,`center_lng`,`radius_km`,`polygon`,`created_at`) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE `name`=VALUES(`name`)",
    [r.name, r.code, r.lat, r.lng, r.r, JSON.stringify(poly), now],
  );
}

// 管理员
const [adminRows] = await conn.execute("SELECT `id` FROM `users` WHERE `phone` = ?", ["13900000001"]);
let adminId;
if (!adminRows.length) {
  const [ins] = await conn.execute(
    "INSERT INTO `users` (`phone`,`password_hash`,`nickname`,`role`,`status`,`created_at`) VALUES (?,?,?,?,?,?)",
    ["13900000001", hashPassword(DEMO_PASSWORD), "平台管理员", "admin", "active", now],
  );
  adminId = ins.insertId;
} else {
  adminId = adminRows[0].id;
}

// 规则配置 15 组
let ruleCount = 0;
for (const [key, def] of Object.entries(DEFAULT_RULES)) {
  await conn.execute(
    "INSERT INTO `rule_configs` (`key`,`grp`,`label`,`value`,`editable`,`updated_at`) VALUES (?,?,?,?,1,?) " +
      "ON DUPLICATE KEY UPDATE `grp`=VALUES(`grp`), `label`=VALUES(`label`)",
    [key, def.grp, def.label, JSON.stringify(def.value), now],
  );
  ruleCount++;
}

// 规则组的「新增字段」补齐（value 列在 ON DUPLICATE 时刻意不覆盖，避免冲掉运营改过的值）：
// 老库缺这些后来新增的键时补默认值，不动运营已配好的其它字段。
// 用 JSON_EXTRACT(?, '$') 把默认值当 JSON 字面量写进去：直接传数值会被驱动当 double（20000.0），
// 而 CAST(... AS SIGNED) 又会把 2.5 这种小数截断——这样写整数/小数都保真。
const ADDITIVE_RULE_KEYS = [
  // 家长自填加急费的上限（P43）
  ["urgent", "max_fee", DEFAULT_RULES.urgent.value.max_fee],
  // 加急费到达上限时的放大系数（P44：加价越高越靠前）
  ["dispatch", "urgent_boost_max", DEFAULT_RULES.dispatch.value.urgent_boost_max],
  // 家长取消申请超时自动同意的分钟数（P60：教员不处理也不能把钱一直押着）
  ["settlement", "cancel_auto_approve_minutes", DEFAULT_RULES.settlement.value.cancel_auto_approve_minutes],
];
for (const [ruleKey, field, def] of ADDITIVE_RULE_KEYS) {
  await conn.execute(
    "UPDATE `rule_configs` SET `value` = JSON_SET(`value`, ?, JSON_EXTRACT(?, '$')) " +
      "WHERE `key` = ? AND JSON_EXTRACT(`value`, ?) IS NULL",
    ["$." + field, JSON.stringify(def), ruleKey, "$." + field],
  );
}

// 细粒度权限矩阵（仅 NestJS 版，需求 4.5.9「角色权限分配」）：
// 权限点 → 允许调用的角色；admin 必须始终在列表内（后台保存时会强制校验，防自锁）
const PERMISSIONS_DEFAULT = {
  "order.price": ["admin"],
  "order.close": ["admin"],
  "refund.review": ["admin"],
  "withdraw.review": ["admin"],
};
await conn.execute(
  "INSERT INTO `rule_configs` (`key`,`grp`,`label`,`value`,`editable`,`updated_at`) VALUES (?,?,?,?,1,?) " +
    "ON DUPLICATE KEY UPDATE `grp`=VALUES(`grp`), `label`=VALUES(`label`)",
  ["permissions", "permissions", "细粒度权限矩阵（权限点 → 角色）", JSON.stringify(PERMISSIONS_DEFAULT), now],
);
ruleCount++;

const [[u]] = await conn.query("SELECT COUNT(*) AS c FROM `users`");
const [[rg]] = await conn.query("SELECT COUNT(*) AS c FROM `regions`");
const [[rc]] = await conn.query("SELECT COUNT(*) AS c FROM `rule_configs`");
console.log(`MySQL 种子完成：用户 ${u.c}，片区 ${rg.c}，规则 ${rc.c} 组（本次写入 ${ruleCount} 组），管理员 id=${adminId}`);

// ---------------- 演示角色数据（供 e2e §1–§3 使用）----------------
const PW = hashPassword(DEMO_PASSWORD);
async function upsertUser(phone, nickname, role, extra = {}) {
  const exist = await conn.execute("SELECT `id` FROM `users` WHERE `phone` = ?", [phone]);
  if (exist[0].length) {
    // 老库补用户名（教员端「用户名 + 密码」登录用），只在为空时写，不覆盖已改过的
    if (extra.username) {
      await conn.execute("UPDATE `users` SET `username` = ? WHERE `phone` = ? AND (`username` IS NULL OR `username` = '')", [
        extra.username,
        phone,
      ]);
    }
    return exist[0][0].id;
  }
  const [r] = await conn.execute(
    "INSERT INTO `users` (`phone`,`username`,`password_hash`,`nickname`,`role`,`status`,`region_id`,`real_name`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?)",
    [phone, extra.username ?? null, PW, nickname, role, "active", extra.regionId ?? null, extra.realName ?? null, now],
  );
  return r.insertId;
}

const [regionRows] = await conn.query("SELECT * FROM `regions` ORDER BY `id`");
const xh = regionRows.find((r) => /西湖/.test(r.name)) ?? regionRows[0];
const bj = regionRows.find((r) => /滨江/.test(r.name)) ?? regionRows[0];

// 区域代理（西湖）
const agentId = await upsertUser("13900000010", "西湖代理·李经理", "agent", { regionId: xh.id });
await conn.execute(
  "INSERT IGNORE INTO `agent_profiles` (`user_id`,`region_id`,`level`,`signed_at`,`deposit`,`status`,`commission_rate`,`mgmt_rate`) VALUES (?,?,?,?,?,?,?,?)",
  [agentId, xh.id, "A", now, 5000000, "active", 0.25, 0.01],
);
await conn.execute("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [agentId, now]);

// 业务员
const salesId = await upsertUser("13900000101", "业务员·陈晨", "sales", { regionId: xh.id });
await conn.execute(
  "INSERT IGNORE INTO `sales_profiles` (`user_id`,`agent_id`,`region_id`,`code`,`joined_at`,`status`) VALUES (?,?,?,?,?,?)",
  [salesId, agentId, xh.id, "BD1001", now, "active"],
);
await conn.execute("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [salesId, now]);
for (const target of ["parent", "teacher"]) {
  await conn.execute(
    "INSERT IGNORE INTO `promotion_codes` (`sales_id`,`target`,`token`,`scans`,`registrations`,`created_at`) VALUES (?,?,?,?,?,?)",
    [salesId, target, "BD1001" + target.slice(0, 1).toUpperCase() + "XY", 10, 0, now],
  );
}

// 教员（西湖 数学/物理 Lv5 在线；滨江 数学 Lv2）
async function upsertTeacher(phone, name, subjects, growth, level, lat, lng, regionId, price, username = null) {
  const uid = await upsertUser(phone, name, "teacher", { regionId, realName: name, username });
  await conn.execute(
    `INSERT IGNORE INTO \`teacher_profiles\` (\`user_id\`,\`identity_type\`,\`real_name\`,\`subjects\`,\`stages\`,\`hourly_price\`,
      \`service_radius_km\`,\`base_lat\`,\`base_lng\`,\`audit_status\`,\`online\`,\`growth_score\`,\`level\`,\`rating_avg\`,\`rating_count\`,
      \`completed_lessons\`,\`response_factor\`,\`created_at\`,\`updated_at\`)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uid, "in_service", name, subjects, "初中,高中", price, 5, lat, lng, "approved", 1, growth, level, 4.8, 3, 30, 1.0, now, now],
  );
  await conn.execute("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [uid, now]);
  await conn.execute(
    "INSERT IGNORE INTO `teacher_services` (`teacher_id`,`title`,`subjects`,`stages`,`price`,`cover_radius_km`,`description`,`status`,`created_at`,`updated_at`) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [uid, subjects.split(",")[0] + " 一对一上门", subjects, "初中,高中", price, 5, "演示服务", "on", now, now],
  );
  return uid;
}
const teacherZhang = await upsertTeacher("13900000201", "张老师", "数学,物理", 2350, "Lv5", 30.261, 120.132, xh.id, 20000, "zhang");
const teacherChen = await upsertTeacher("13900000205", "陈子豪", "数学", 340, "Lv2", 30.21, 120.21, bj.id, 10000, "chenzihao");

// 家长（西湖）：档案 + 钱包 + 地址 + 归属
const parentId = await upsertUser("13900000301", "家长·周女士", "parent", { regionId: xh.id, realName: "周女士" });
await conn.execute(
  "INSERT IGNORE INTO `parent_profiles` (`user_id`,`credit_score`,`credit_level`,`completed_orders`) VALUES (?,?,?,?)",
  [parentId, 115, "L1", 2],
);
await conn.execute("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [parentId, now]);
const [addrRows] = await conn.execute("SELECT `id` FROM `addresses` WHERE `user_id` = ?", [parentId]);
if (!addrRows.length) {
  await conn.execute(
    "INSERT INTO `addresses` (`user_id`,`label`,`contact`,`phone`,`region_id`,`address`,`lat`,`lng`,`is_default`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [parentId, "家", "周女士", "13900000301", xh.id, "西湖区文三路 128 号 学军小区 3 幢 502", 30.262, 120.133, 1, now],
  );
}
await conn.execute(
  "INSERT IGNORE INTO `bindings` (`user_id`,`sales_id`,`agent_id`,`region_id`,`source`,`bound_at`) VALUES (?,?,?,?,?,?)",
  [parentId, salesId, agentId, xh.id, "scan", now],
);


// ---------------- 补齐参考实现演示数据集（供 security.test.js 复用）----------------
// 滨江代理
const agentBj = await upsertUser("13900000011", "滨江代理·王经理", "agent", { regionId: bj.id });
await conn.execute(
  "INSERT IGNORE INTO `agent_profiles` (`user_id`,`region_id`,`level`,`signed_at`,`deposit`,`status`,`commission_rate`,`mgmt_rate`) VALUES (?,?,?,?,?,?,?,?)",
  [agentBj, bj.id, "A", now, 5000000, "active", 0.25, 0.01],
);
await conn.execute("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [agentBj, now]);

// 教员：西湖 英语 Lv3
const teacherLi = await upsertTeacher("13900000202", "李思远", "英语", 1200, "Lv3", 30.266, 120.14, xh.id, 18000);

// 家长（西湖 / 滨江）与地址
async function upsertParent(phone, name, region, address, lat, lng, creditScore, creditLevel) {
  const uid = await upsertUser(phone, name, "parent", { regionId: region.id, realName: name });
  await conn.execute(
    "INSERT IGNORE INTO `parent_profiles` (`user_id`,`credit_score`,`credit_level`,`completed_orders`) VALUES (?,?,?,?)",
    [uid, creditScore, creditLevel, 0],
  );
  await conn.execute("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [uid, now]);
  const [rows] = await conn.execute("SELECT `id` FROM `addresses` WHERE `user_id` = ?", [uid]);
  if (!rows.length) {
    await conn.execute(
      "INSERT INTO `addresses` (`user_id`,`label`,`contact`,`phone`,`region_id`,`address`,`lat`,`lng`,`is_default`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [uid, "家", name, phone, region.id, address, lat, lng, 1, now],
    );
  }
  return uid;
}
const parentQian = await upsertParent("13900000302", "家长·钱女士", xh, "西湖区教工路 88 号 求是小区 2 幢 301", 30.268, 120.136, 100, "L0");
const parentWu = await upsertParent("13900000304", "家长·吴先生", bj, "滨江区江南大道 588 号 星耀城 1 幢 1802", 30.208, 120.211, 105, "L0");
// 首页内容
const [bannerCnt] = await conn.query("SELECT COUNT(*) AS c FROM `banners`");
if (!Number(bannerCnt[0].c)) {
  await conn.execute("INSERT INTO `banners` (`title`,`image`,`link`,`sort`,`status`,`created_at`) VALUES (?,?,?,?,?,?)", ["新用户首单立减 30 元", "", "/parent", 1, "on", now]);
  await conn.execute("INSERT INTO `banners` (`title`,`image`,`link`,`sort`,`status`,`created_at`) VALUES (?,?,?,?,?,?)", ["名师一对一 · 免费试听 30 分钟", "", "/parent#/plaza", 2, "on", now]);
}
const [noticeCnt] = await conn.query("SELECT COUNT(*) AS c FROM `announcements`");
if (!Number(noticeCnt[0].c)) {
  await conn.execute("INSERT INTO `announcements` (`title`,`content`,`audience`,`pinned`,`status`,`created_at`) VALUES (?,?,?,?,?,?)", ["关于规范上门家教服务的公告", "平台仅提供家教信息撮合服务。", "all", 1, "on", now]);
}

// 历史演示订单：一笔已结算（用于财务/越权/账单类用例，且台账闭合）
const [settledCnt] = await conn.execute("SELECT `id` FROM `orders` WHERE `order_no` = 'JJDEMO0002'");
if (!settledCnt.length) {
  const t3 = new Date(Date.now() - 3 * 86400000).toISOString();
  const t2 = new Date(Date.now() - 2 * 86400000).toISOString();
  await conn.execute(
    "INSERT INTO `orders` (`order_no`,`parent_id`,`teacher_id`,`subject`,`stage`,`lesson_time`,`address`,`lat`,`lng`,`region_id`,`amount`,`urgent_fee`,`status`,`commission_rate`,`service_fee`,`teacher_income`,`agent_share`,`sales_commission`,`platform_revenue`,`paid_at`,`checkin_at`,`checkin_distance`,`finished_at`,`confirm_at`,`settle_at`,`created_at`,`updated_at`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ["JJDEMO0002", parentQian, teacherZhang, "数学", "初中", t3, "西湖区教工路 88 号 求是小区 2 幢 301",
      30.268, 120.136, xh.id, 20000, 0, "settled", 0.18, 3600, 16400, 1100, 0, 2500,
      t3, t3, 80, t3, t3, t2, t3, t2],
  );
  await conn.execute(
    "INSERT INTO `payments` (`order_id`,`user_id`,`type`,`amount`,`channel`,`trade_no`,`status`,`created_at`) VALUES ((SELECT `id` FROM `orders` WHERE `order_no` = 'JJDEMO0002'),?,?,?,?,?,?,?)",
    [parentQian, "pay", 20000, "wechat_jsapi", "WXDEMO0002", "success", t3],
  );
  // 担保台账：入账 20000 → 结算放款 20000，净额为 0
  await conn.execute(
    "INSERT INTO `escrow_ledger` (`order_id`,`direction`,`amount`,`balance`,`remark`,`created_at`) VALUES ((SELECT `id` FROM `orders` WHERE `order_no` = 'JJDEMO0002'),?,?,?,?,?)",
    ["in", 20000, 20000, "家长预付课时费 JJDEMO0002", t3],
  );
  await conn.execute(
    "INSERT INTO `escrow_ledger` (`order_id`,`direction`,`amount`,`balance`,`remark`,`created_at`) VALUES ((SELECT `id` FROM `orders` WHERE `order_no` = 'JJDEMO0002'),?,?,?,?,?)",
    ["out", 20000, 0, "订单结算放款 JJDEMO0002", t2],
  );
  await conn.execute(
    "UPDATE `wallets` SET `balance` = `balance` + 16400, `total_income` = `total_income` + 16400, `updated_at` = ? WHERE `user_id` = ?",
    [t2, teacherZhang],
  );
  await conn.execute(
    "UPDATE `wallets` SET `balance` = `balance` + 1100, `total_income` = `total_income` + 1100, `updated_at` = ? WHERE `user_id` = ?",
    [t2, agentId],
  );
}

// 优惠券（运营工具演示数据）
const [couponCnt] = await conn.query("SELECT COUNT(*) AS c FROM `coupons`");

// 有未完结订单的家长（供账号注销用例验证「不可注销」分支）
const parentBusy = await upsertParent("13900000306", "家长·王先生", bj, "滨江区长河路 351 号 天寓小区 4 幢 1102", 30.212, 120.208, 100, "L0");

// 滨江片区业务员（rules.test 的「两片区各自有业务员」与代理隔离用例）
const salesBj = await upsertUser("13900000102", "业务员·周涛", "sales", { regionId: bj.id });
await conn.execute(
  "INSERT IGNORE INTO `sales_profiles` (`user_id`,`agent_id`,`region_id`,`code`,`joined_at`,`status`) VALUES (?,?,?,?,?,?)",
  [salesBj, agentBj, bj.id, "BD2001", now, "active"],
);
await conn.execute("INSERT IGNORE INTO `wallets` (`user_id`,`updated_at`) VALUES (?,?)", [salesBj, now]);

// 另一位家长的进行中订单（滨江）+ 一位家长的在招需求（供横向越权用例）
const [cnc] = await conn.execute("SELECT `id` FROM `orders` WHERE `order_no` = 'JJDEMO0003'");
if (!cnc.length) {
  await conn.execute(
    "INSERT INTO `orders` (`order_no`,`parent_id`,`teacher_id`,`subject`,`stage`,`lesson_time`,`address`,`lat`,`lng`,`region_id`,`amount`,`urgent_fee`,`status`,`commission_rate`,`created_at`,`updated_at`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ["JJDEMO0003", parentWu, teacherChen, "数学", "初中", "2027-02-10T10:00:00.000Z", "滨江区江南大道 588 号 星耀城 1 幢 1802",
      30.208, 120.211, bj.id, 12000, 0, "awaiting_payment", 0.12, now, now],
  );
}
const [dmdCnt] = await conn.execute("SELECT `id` FROM `demands` WHERE `parent_id` = ?", [parentQian]);
if (!dmdCnt.length) {
  await conn.execute(
    `INSERT INTO \`demands\` (\`parent_id\`,\`stage\`,\`subject\`,\`mode\`,\`address\`,\`lat\`,\`lng\`,\`region_id\`,\`times\`,\`budget\`,\`remark\`,\`urgent\`,\`urgent_fee\`,\`status\`,\`created_at\`,\`updated_at\`)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [parentQian, "初中", "数学", "home", "西湖区教工路 88 号 求是小区 2 幢 301", 30.268, 120.136, xh.id,
      "[]", 15000, "演示需求（求是小区）", 0, 0, "published", now, now],
  );
}
await conn.execute(
  `INSERT IGNORE INTO \`orders\` (\`order_no\`,\`parent_id\`,\`teacher_id\`,\`subject\`,\`stage\`,\`lesson_time\`,\`address\`,\`lat\`,\`lng\`,
    \`region_id\`,\`amount\`,\`urgent_fee\`,\`status\`,\`commission_rate\`,\`created_at\`,\`updated_at\`)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ["JJDEMO0001", parentBusy, teacherChen, "数学", "初中", "2027-01-05T10:00:00.000Z", "滨江区长河路 351 号 天寓小区 4 幢 1102",
    30.212, 120.208, bj.id, 10000, 0, "awaiting_payment", 0.12, now, now],
);
if (!Number(couponCnt[0].c)) {
  await conn.execute(
    "INSERT INTO `coupons` (`name`,`amount`,`threshold`,`total`,`claimed`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?)",
    ["新人首单立减 30 元", 3000, 0, 500, 0, "on", now],
  );
  await conn.execute(
    "INSERT INTO `coupons` (`name`,`amount`,`threshold`,`total`,`claimed`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?)",
    ["满 200 减 30", 3000, 20000, 300, 0, "on", now],
  );
}

// 协议（第 8 章合规）
const [agreeCnt] = await conn.query("SELECT COUNT(*) AS c FROM `agreements`");
if (!Number(agreeCnt[0].c)) {
  for (const [key, title] of [["user", "用户服务协议"], ["privacy", "隐私政策"], ["refund", "退款规则"]]) {
    await conn.execute(
      "INSERT INTO `agreements` (`key`,`title`,`content`,`updated_at`) VALUES (?,?,?,?)",
      [key, title, title + "：平台仅提供家教信息撮合服务，具体以正式文本为准。", now],
    );
  }
}
const [[u2]] = await conn.query("SELECT COUNT(*) AS c FROM `users`");
console.log(`角色数据就绪：用户 ${u2.c}，教员(张/陈)=${teacherZhang}/${teacherChen}，家长=${parentId}，业务员=${salesId}，代理=${agentId}`);
await conn.end();