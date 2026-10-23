-- ============================================================
-- 家教上门撮合平台  数据库结构 (SQLite 3 / MySQL 8 兼容设计)
-- 金额单位：全部为「分」(INTEGER)，全链路禁止浮点运算
-- 时间单位：ISO-8601 字符串 (UTC)
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------- 用户与账号 ----------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT UNIQUE,
  username      TEXT UNIQUE,                          -- 教员端「用户名 + 密码」登录（可空，小写）
  password_hash TEXT,
  nickname      TEXT NOT NULL,
  avatar        TEXT,
  role          TEXT NOT NULL,                        -- parent | teacher | sales | agent | admin
  status        TEXT NOT NULL DEFAULT 'active',       -- active | disabled
  real_name     TEXT,
  id_card       TEXT,
  wx_openid     TEXT,
  device_fp     TEXT,
  reg_ip        TEXT,                                 -- 注册 IP（反作弊频次限制）
  region_id     INTEGER,                              -- 归属片区
  last_login_at TEXT,
  deleted_at    TEXT,                                 -- 软删除标记（非空=已删除并匿名化，业务台账保留）
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, status);

-- ---------------- 片区（电子围栏）----------------
CREATE TABLE IF NOT EXISTS regions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  center_lat  REAL NOT NULL,
  center_lng  REAL NOT NULL,
  radius_km   REAL NOT NULL DEFAULT 6,
  polygon     TEXT,                                   -- JSON [[lat,lng],...] 电子围栏（多环：[[[lat,lng],...],...]）
  admin_codes TEXT,                                   -- JSON 数组：按行政区设置的 adcode
  created_at  TEXT NOT NULL
);

-- ---------------- 家长端 ----------------
CREATE TABLE IF NOT EXISTS addresses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  label       TEXT NOT NULL,                          -- 家 / 辅导班 / 公司
  contact     TEXT NOT NULL,
  phone       TEXT NOT NULL,
  region_id   INTEGER,
  address     TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addr_user ON addresses(user_id);

CREATE TABLE IF NOT EXISTS parent_profiles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  credit_score  INTEGER NOT NULL DEFAULT 100,
  credit_level  TEXT NOT NULL DEFAULT 'L0',
  completed_orders INTEGER NOT NULL DEFAULT 0,
  cancel_count  INTEGER NOT NULL DEFAULT 0,
  last_month_bonus TEXT,                              -- 上次发放「无取消记录」加分的月份
  restricted    INTEGER NOT NULL DEFAULT 0
);

-- ---------------- 教员端 ----------------
CREATE TABLE IF NOT EXISTS teacher_profiles (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id),
  identity_type   TEXT NOT NULL,                      -- student | in_service | part_time
  real_name       TEXT,
  id_card         TEXT,
  edu_cert_url    TEXT,
  teacher_cert_url TEXT,
  skill_cert_url  TEXT,
  id_card_front_url TEXT,                             -- 身份证正面（人像面）图片地址
  id_card_back_url  TEXT,                             -- 身份证反面（国徽面）图片地址
  id_card_name    TEXT,                               -- 证件识别出的姓名（须与 real_name 一致）
  id_card_verified INTEGER NOT NULL DEFAULT 0,        -- 1 = 识别结果已与填写信息核对一致
  intro           TEXT,
  subjects        TEXT,                               -- 逗号分隔
  stages          TEXT,                               -- 逗号分隔
  hourly_price    INTEGER NOT NULL DEFAULT 0,         -- 分
  service_radius_km REAL NOT NULL DEFAULT 5,
  base_lat        REAL,
  base_lng        REAL,
  schedule        TEXT,                               -- JSON 可授课时间表
  cover_area      TEXT,                               -- 上门覆盖区域描述
  audit_status    TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  reject_reason   TEXT,
  online          INTEGER NOT NULL DEFAULT 0,
  growth_score    INTEGER NOT NULL DEFAULT 0,
  level           TEXT NOT NULL DEFAULT 'Lv1',
  rating_avg      REAL NOT NULL DEFAULT 0,
  rating_count    INTEGER NOT NULL DEFAULT 0,
  completed_lessons INTEGER NOT NULL DEFAULT 0,
  response_factor REAL NOT NULL DEFAULT 1.0,          -- 响应速度系数
  frozen          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tp_audit ON teacher_profiles(audit_status, online);

CREATE TABLE IF NOT EXISTS teacher_services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  subjects      TEXT NOT NULL,
  stages        TEXT NOT NULL,
  price         INTEGER NOT NULL,                     -- 分 / 课时
  cover_radius_km REAL NOT NULL DEFAULT 5,
  schedule      TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'on',           -- on | off
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_svc_teacher ON teacher_services(teacher_id, status);

-- ---------------- 需求与报名 ----------------
CREATE TABLE IF NOT EXISTS demands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER NOT NULL REFERENCES users(id),
  stage       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'home',           -- 仅上门
  address_id  INTEGER,
  address     TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  region_id   INTEGER NOT NULL,
  times       TEXT,                                   -- JSON [{date,start,end}]
  budget      INTEGER NOT NULL,                        -- 分 / 课时
  remark      TEXT,
  gender_pref TEXT,
  urgent      INTEGER NOT NULL DEFAULT 0,
  urgent_fee  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'published',      -- published | paused | revoked | matched | closed
  confirm_app_id INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_demand_status ON demands(status, region_id);

CREATE TABLE IF NOT EXISTS applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  demand_id   INTEGER NOT NULL REFERENCES demands(id),
  teacher_id  INTEGER NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending',        -- pending | confirmed | rejected | cancelled
  priority    REAL NOT NULL DEFAULT 0,
  distance_km REAL,
  created_at  TEXT NOT NULL,
  UNIQUE (demand_id, teacher_id)                      -- 防重复抢单
);
CREATE INDEX IF NOT EXISTS idx_app_demand ON applications(demand_id, status);

-- ---------------- 订单 ----------------
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no      TEXT NOT NULL UNIQUE,
  parent_id     INTEGER NOT NULL REFERENCES users(id),
  teacher_id    INTEGER NOT NULL REFERENCES users(id),
  demand_id     INTEGER,
  service_id    INTEGER,
  subject       TEXT NOT NULL,
  stage         TEXT NOT NULL,
  lesson_time   TEXT NOT NULL,
  lesson_end    TEXT,
  address       TEXT NOT NULL,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  region_id     INTEGER NOT NULL,
  sales_id      INTEGER,
  agent_id      INTEGER,
  amount        INTEGER NOT NULL,                     -- 家长实付（分）
  urgent_fee    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,                        -- awaiting_payment | pending_class | in_class
                                                      -- | awaiting_parent_confirm | completed | settled
                                                      -- | cancelled | refunding | refunded
  commission_rate REAL NOT NULL DEFAULT 0.18,
  service_fee   INTEGER NOT NULL DEFAULT 0,
  teacher_income INTEGER NOT NULL DEFAULT 0,
  agent_share   INTEGER NOT NULL DEFAULT 0,
  sales_commission INTEGER NOT NULL DEFAULT 0,
  platform_revenue INTEGER NOT NULL DEFAULT 0,
  paid_at       TEXT,
  checkin_at    TEXT,
  checkin_lat   REAL,
  checkin_lng   REAL,
  checkin_distance INTEGER,
  finished_at   TEXT,
  confirm_at    TEXT,
  settle_at     TEXT,
  remind_sent   INTEGER NOT NULL DEFAULT 0,           -- 上课前提醒是否已发送
  cancel_by     TEXT,
  cancel_reason TEXT,
  cancel_requested_at TEXT,                       -- 家长申请取消的时间（教员同意/驳回后清空）
  cancel_rejected_at  TEXT,                       -- 教员最近一次驳回取消的时间
  cancel_reject_reason TEXT,                      -- 教员驳回理由（回给家长）
  penalty       INTEGER NOT NULL DEFAULT 0,
  refund_amount INTEGER NOT NULL DEFAULT 0,
  remark        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_parent ON orders(parent_id, status);
CREATE INDEX IF NOT EXISTS idx_order_teacher ON orders(teacher_id, status);
CREATE INDEX IF NOT EXISTS idx_order_region ON orders(region_id, status);

-- ---------------- 支付 / 担保台账 ----------------
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER,
  user_id       INTEGER NOT NULL,
  type          TEXT NOT NULL,                        -- pay | refund
  amount        INTEGER NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'wechat',       -- wechat_jsapi | wechat_app
  trade_no      TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'success',
  idem_key      TEXT UNIQUE,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escrow_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER,
  direction   TEXT NOT NULL,                          -- in | out
  amount      INTEGER NOT NULL,
  balance     INTEGER NOT NULL,                       -- 台账变动后余额
  remark      TEXT,
  created_at  TEXT NOT NULL
);

-- ---------------- 钱包 / 流水 ----------------
CREATE TABLE IF NOT EXISTS wallets (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  balance     INTEGER NOT NULL DEFAULT 0,             -- 可用余额（分）
  frozen      INTEGER NOT NULL DEFAULT 0,             -- 冻结中（分）
  total_income INTEGER NOT NULL DEFAULT 0,
  total_withdraw INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  order_id    INTEGER,
  type        TEXT NOT NULL,                          -- lesson_income | freeze | unfreeze | withdraw
                                                      -- | withdraw_refund | reward | agent_share
                                                      -- | sales_commission | pay | refund
  amount      INTEGER NOT NULL,
  balance_after INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'done',
  remark      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_user ON wallet_txns(user_id, created_at);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  role          TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  fee           INTEGER NOT NULL DEFAULT 0,
  actual        INTEGER NOT NULL DEFAULT 0,
  channel       TEXT NOT NULL,                        -- bank | wechat
  account       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected | paid
  reject_reason TEXT,
  reviewed_by   INTEGER,
  reviewed_at   TEXT,
  idem_key      TEXT UNIQUE,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id, status);

-- ---------------- 评价 / 成长 / 信用 ----------------
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  parent_id   INTEGER NOT NULL,
  teacher_id  INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  content     TEXT,
  tags        TEXT,                                   -- JSON 数组
  weight      REAL NOT NULL DEFAULT 1.0,
  status      TEXT NOT NULL DEFAULT 'public',         -- public | hidden
  appeal_status TEXT NOT NULL DEFAULT 'none',         -- none | pending | accepted | rejected
  appeal_reason TEXT,
  appeal_result TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_teacher ON reviews(teacher_id, status);

CREATE TABLE IF NOT EXISTS growth_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id  INTEGER NOT NULL,
  change      INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  balance_after INTEGER NOT NULL,
  order_id    INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  change      INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  balance_after INTEGER NOT NULL,
  order_id    INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS level_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id  INTEGER NOT NULL,
  from_level  TEXT NOT NULL,
  to_level    TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL
);

-- ---------------- 推广体系 ----------------
CREATE TABLE IF NOT EXISTS sales_profiles (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  agent_id    INTEGER NOT NULL,
  region_id   INTEGER NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  joined_at   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'          -- active | disabled
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  region_id     INTEGER NOT NULL,
  level         TEXT NOT NULL DEFAULT 'A',
  signed_at     TEXT NOT NULL,
  deposit       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  commission_rate REAL NOT NULL DEFAULT 0.25,         -- 服务费分成比例
  mgmt_rate     REAL NOT NULL DEFAULT 0.01            -- 管理提成比例（按实付）
);

CREATE TABLE IF NOT EXISTS bindings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL UNIQUE,
  sales_id    INTEGER,
  agent_id    INTEGER,
  region_id   INTEGER,
  source      TEXT NOT NULL,                          -- scan | natural
  bound_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotion_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_id    INTEGER NOT NULL,
  target      TEXT NOT NULL,                          -- parent | teacher
  token       TEXT NOT NULL UNIQUE,
  scans       INTEGER NOT NULL DEFAULT 0,
  registrations INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (sales_id, target)
);

CREATE TABLE IF NOT EXISTS rewards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_id    INTEGER NOT NULL,
  type        TEXT NOT NULL,                          -- register | lead | deal | daily_champ
                                                      -- | weekly_champ | newbie_first
  amount      INTEGER NOT NULL,
  ref_order_id INTEGER,
  ref_user_id INTEGER,
  status      TEXT NOT NULL DEFAULT 'pending',        -- pending | settled | cancelled
  calc_note   TEXT,
  settle_at   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reward_sales ON rewards(sales_id, status);

-- ---------------- 客诉 / 风控 ----------------
CREATE TABLE IF NOT EXISTS complaints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER,
  from_user   INTEGER NOT NULL,
  from_role   TEXT NOT NULL,
  against_user INTEGER,
  region_id   INTEGER,
  type        TEXT NOT NULL,                          -- complaint | review_appeal
  title       TEXT NOT NULL,
  content     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',           -- open | agent_handled | escalated | closed
  handler_id  INTEGER,
  handle_note TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS risk_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER,
  user_id     INTEGER,
  region_id   INTEGER,
  type        TEXT NOT NULL,                          -- fake_checkin | brush | abnormal_location | high_cancel
  level       TEXT NOT NULL DEFAULT 'mid',            -- low | mid | high
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',           -- open | reviewing | closed
  settlement_hold INTEGER NOT NULL DEFAULT 0,
  handled_by  INTEGER,
  created_at  TEXT NOT NULL
);

-- ---------------- 平台运营 ----------------
CREATE TABLE IF NOT EXISTS rule_configs (
  key         TEXT PRIMARY KEY,
  grp         TEXT NOT NULL,
  label       TEXT NOT NULL,
  value       TEXT NOT NULL,                          -- JSON
  editable    INTEGER NOT NULL DEFAULT 1,
  updated_by  INTEGER,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS banners (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL,
  image     TEXT,
  link      TEXT,
  sort      INTEGER NOT NULL DEFAULT 0,
  status    TEXT NOT NULL DEFAULT 'on',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL,
  content   TEXT,
  audience  TEXT NOT NULL DEFAULT 'all',              -- all | parent | teacher | sales | agent
  pinned    INTEGER NOT NULL DEFAULT 0,
  status    TEXT NOT NULL DEFAULT 'on',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coupons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  amount    INTEGER NOT NULL,                          -- 减免金额（分）
  threshold INTEGER NOT NULL DEFAULT 0,                -- 满减门槛（分）
  total     INTEGER NOT NULL DEFAULT 0,
  claimed   INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to  TEXT,
  status    TEXT NOT NULL DEFAULT 'on',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_coupons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  coupon_id INTEGER NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  order_id  INTEGER,
  claimed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  title     TEXT NOT NULL,
  content   TEXT,
  type      TEXT NOT NULL DEFAULT 'system',           -- system | order | payment | risk | notice
  read      INTEGER NOT NULL DEFAULT 0,
  link      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, read);

CREATE TABLE IF NOT EXISTS agreements (
  key       TEXT PRIMARY KEY,                         -- user | privacy | refund
  title     TEXT NOT NULL,
  content   TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id  INTEGER,
  actor_role TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  detail    TEXT,
  ip        TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency (
  key       TEXT PRIMARY KEY,
  scope     TEXT NOT NULL,
  response  TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  teacher_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, teacher_id)
);
-- ---------------- 代理保证金台账 ----------------
CREATE TABLE IF NOT EXISTS agent_deposits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   INTEGER NOT NULL,
  direction  TEXT NOT NULL,                           -- in 缴纳 | out 退还
  amount     INTEGER NOT NULL,
  balance    INTEGER NOT NULL DEFAULT 0,
  remark     TEXT,
  operator   INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deposit_agent ON agent_deposits(agent_id, created_at);
-- ---------------- 发票申请单（需求 4.1.6 发票申请入口）----------------
CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no    TEXT NOT NULL UNIQUE,                 -- 申请单号 FPyyyymmddXXXXXX
  order_id      INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  title_type    TEXT NOT NULL DEFAULT 'personal',     -- personal 个人 | company 企业
  title         TEXT NOT NULL,                        -- 发票抬头
  tax_no        TEXT,                                 -- 企业税号
  email         TEXT,                                 -- 接收邮箱
  amount        INTEGER NOT NULL,                     -- 开票金额（分）
  status        TEXT NOT NULL DEFAULT 'pending',      -- pending 待受理 | issued 已开票 | rejected 已驳回
  reject_reason TEXT,
  invoice_url   TEXT,                                 -- 电子发票文件地址
  handled_by    INTEGER,
  handled_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_user ON invoices(user_id, status);
-- 同一订单只允许存在一张有效申请（驳回后可重新申请）
CREATE UNIQUE INDEX IF NOT EXISTS uk_invoice_order ON invoices(order_id) WHERE status <> 'rejected';
