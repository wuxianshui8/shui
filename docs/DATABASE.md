# 数据库设计文档

- 定义文件：`server/core/schema.sql`（启动时自动建表，`CREATE TABLE IF NOT EXISTS` 可重复执行）
- 当前实现：SQLite（Node 22 内置 `node:sqlite`），文件位于 `data/app.db`（WAL 模式）
- 迁移目标：MySQL 8.0。类型映射见文末，`AUTOINCREMENT` → `AUTO_INCREMENT`、`TEXT` → `VARCHAR(64)`（主键/枚举）/`TEXT`（长文本）
- **金额单位**：全部字段为「分」的整数（`INTEGER`/`BIGINT`），禁止浮点
- **时间**：ISO-8601 字符串（UTC），比较时按字符串字典序即可（格式统一）

共 37 张表，分 9 个域。

---

## 1. 用户与基础域

### users — 统一账号表（五类角色共用）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| phone | TEXT UNIQUE | 手机号（家长/教员/业务员/代理/管理员均可用） |
| password_hash | TEXT | scrypt 加盐哈希，格式 `scrypt$salt$hash` |
| nickname / avatar | TEXT | 昵称、头像 |
| role | TEXT | `parent` / `teacher` / `sales` / `agent` / `admin` |
| status | TEXT | `active` / `disabled` |
| real_name / id_card | TEXT | 实名信息（展示时脱敏） |
| wx_openid | TEXT | 微信登录标识 |
| device_fp | TEXT | 设备指纹（反作弊，注册时的 `X-Device-Fp`） |
| reg_ip | TEXT | 注册 IP（反作弊频次限制） |
| region_id | INTEGER | 归属片区 |
| last_login_at / created_at | TEXT | |
| token_version | INT DEFAULT 0 | 令牌版本：改密 / 注销时自增，令旧令牌立即失效（NestJS 版新增） |
| must_change_password | TINYINT DEFAULT 0 | 首登强制改密：1 时除改密/me/logout/deactivate 外一律 403（NestJS 版新增） |

索引：`idx_users_role(role,status)`

### regions — 片区与电子围栏
`name, code(UNIQUE), center_lat, center_lng, radius_km, polygon(JSON [[lat,lng],...])`

### rule_configs — 规则配置中心
`key PK, grp, label, value(JSON), editable, updated_by, updated_at`

### audit_logs — 操作日志（资金/规则/权限操作必留痕）
`actor_id, actor_role, action, target, detail(JSON), ip, created_at`

### idempotency — 幂等记录
`key PK, scope, response(JSON), created_at`

### agreements / banners / announcements / coupons — 运营内容
- `agreements(key PK: user|privacy|refund, title, content)`
- `banners(title,image,link,sort,status)`
- `announcements(title,content,audience(all|parent|teacher|sales|agent),pinned,status)`
- `coupons(name,amount,threshold,total,claimed,valid_from,valid_to,status)`

---

## 2. 家长域

### parent_profiles — 家长信用档案（1:1 users）
`user_id PK, credit_score, credit_level, completed_orders, cancel_count, last_month_bonus, restricted`

### addresses — 上课地址
`user_id, label, contact, phone, region_id, address, lat, lng, is_default`

### favorites — 收藏教员
`user_id, teacher_id, created_at`，唯一索引 `(user_id,teacher_id)`

### invoices — 发票申请单（需求 4.1.6）
| 字段 | 说明 |
| --- | --- |
| invoice_no | 申请单号 `FPyyyymmddXXXXXX`（UNIQUE） |
| order_id / user_id | 关联订单与家长 |
| title_type | `personal` 个人 / `company` 企业 |
| title / tax_no / email | 发票抬头、纳税人识别号、接收邮箱 |
| amount | 开票金额（分）= 订单实付 + 加急费 |
| status | `pending` 待受理 / `issued` 已开票 / `rejected` 已驳回 |
| reject_reason / invoice_url | 驳回原因 / 电子发票地址 |
| handled_by / handled_at | 受理人与受理时间 |

索引：`idx_invoice_user(user_id,status)`；
**部分唯一索引** `uk_invoice_order(order_id) WHERE status <> 'rejected'` —— 保证同一订单同时只有一张有效申请，
驳回后可重新申请（MySQL 8 不支持部分索引，迁移时用触发器或应用层校验等价实现，本系统两处均已校验）。

### user_coupons — 已领优惠券
`user_id, coupon_id, used, order_id, claimed_at`

---

## 3. 教员的域

### teacher_profiles — 教员档案（1:1 users）
| 字段 | 说明 |
| --- | --- |
| identity_type | `student` 在校大学生 / `in_service` 在职教师 / `part_time` 社会兼职 |
| real_name, id_card, edu_cert_url, teacher_cert_url, skill_cert_url | 资质与证件 |
| intro, subjects, stages | 介绍与授课范围（逗号分隔） |
| hourly_price | 课时单价（分） |
| service_radius_km, base_lat, base_lng, cover_area | 服务半径与基点 |
| base_address | **教员授课地址**（P65）：非空表示支持「家长到教员处上课」，与 base_lat/base_lng 配对使用；留空=只支持上门 |
| schedule | JSON 可授课时间表 |
| audit_status, reject_reason | `pending` / `approved` / `rejected` |
| online | 在线接单开关 |
| growth_score, level | 成长分与等级（Lv1-Lv5） |
| rating_avg, rating_count | 加权评分均值与评价数 |
| completed_lessons | 有效课时数 |
| response_factor | 响应速度系数（派单公式用） |

索引：`idx_tp_audit(audit_status,online)`

### teacher_services — 上架的授课服务
`teacher_id, title, subjects, stages, price(分), cover_radius_km, schedule(JSON), description, status(on|off)`

### growth_logs / level_logs — 成长分与等级变更流水
`growth_logs(teacher_id, change, reason, balance_after, order_id)`
`level_logs(teacher_id, from_level, to_level, reason)`

### credit_logs — 家长信用分流水
`user_id, change, reason, balance_after, order_id`

### reviews — 评价
`order_id UNIQUE, parent_id, teacher_id, score, content, tags(JSON), weight, status(public|hidden), appeal_status, appeal_reason, appeal_result`

---

## 4. 需求与撮合域

### demands — 家长发布的家教需求
`parent_id, stage, subject, mode(home 教员上门(默认) / teacher_place 家长到教员处), address_id, address, lat, lng, region_id, times(JSON[{date,start,end}]), budget(分), remark, gender_pref, urgent, urgent_fee, status(published/paused/revoked/matched/closed), confirm_app_id, created_at, updated_at`（P65 起 `mode` 正式启用：`teacher_place` 的需求确认成单时，订单上课地点改取教员授课地址）

### applications — 教员报名（抢单）
`demand_id, teacher_id, status(pending|confirmed|rejected|cancelled), priority, distance_km`
**唯一索引 `(demand_id, teacher_id)`** —— 抢单原子性的基础

---

## 5. 订单与资金域（核心）

### orders — 订单主表
| 分组 | 字段 |
| --- | --- |
| 标识 | `id, order_no(UNIQUE)` |
| 参与方 | `parent_id, teacher_id, demand_id, service_id` |
| 内容 | `subject, stage, lesson_time, lesson_end, address, place, lat, lng, remark`——`address/lat/lng` 恒为**实际上课地点**（`place=teacher_place` 时即教员授课地址，故打卡/提醒/风控无需区分；P65） |
| 归属 | `region_id, sales_id, agent_id`（收益归属按需求地址片区） |
| 金额 | `amount(实付), urgent_fee, commission_rate, service_fee, teacher_income, agent_share, sales_commission, platform_revenue` |
| 状态 | `status`（见状态机） |
| 打卡 | `checkin_at, checkin_lat, checkin_lng, checkin_distance` |
| 履约 | `paid_at, finished_at, confirm_at, settle_at, remind_sent`（上课提醒是否已推送，保证不重复） |
| 取消 | `cancel_by, cancel_reason, penalty, refund_amount` |

索引：`idx_order_parent(parent_id,status)`、`idx_order_teacher`、`idx_order_region`

**状态枚举**：`awaiting_payment` `pending_class` `in_class` `awaiting_parent_confirm` `completed` `settled` `cancelled` `refunding` `refunded`

### payments — 支付/退款流水
`order_id, user_id, type(pay|refund), amount, channel, trade_no UNIQUE, status, idem_key UNIQUE`

### escrow_ledger — 担保资金台账（独立、不可挪用）
`order_id, direction(in|out), amount, balance(变动后余额), remark`
任意时刻 `SUM(in) − SUM(out)` = 已支付未结算未退款订单金额之和。

### wallets — 钱包
`user_id PK, balance(可用), frozen(冻结中), total_income, total_withdraw`

### wallet_txns — 钱包流水
`user_id, order_id, type(lesson_income|freeze|unfreeze|withdraw|withdraw_refund|reward|agent_share|sales_commission|compensation|pay|refund), amount, balance_after, status, remark`

### withdrawals — 提现申请
`user_id, role, amount, fee, actual, channel, account(已脱敏), status(pending|paid|rejected), reject_reason, reviewed_by, reviewed_at, idem_key UNIQUE`

---

## 6. 推广与运营分成域

### agent_profiles — 区域代理
`user_id PK, region_id, level, signed_at, deposit(保证金), status, commission_rate(服务费分成), mgmt_rate(管理提成)`

### agent_deposits — 代理保证金台账
`agent_id, direction(in 缴纳 / out 退还), amount(分), balance(变动后余额), remark, operator, created_at`
任一时刻 `agent_profiles.deposit` = 该代理最后一次 `balance`，退还不可超过当前余额。

### sales_profiles — 业务员
`user_id PK, agent_id, region_id, code(UNIQUE 编号), joined_at, status`

### bindings — 用户归属（永久绑定）
`user_id UNIQUE, sales_id, agent_id, region_id, source(scan|natural), bound_at`

### promotion_codes — 推广码
`sales_id, target(parent|teacher), token UNIQUE, scans, registrations`，唯一 `(sales_id,target)`

### rewards — 业务员奖励
`sales_id, type(register|lead|deal|daily_champ|weekly_champ|newbie_first), amount, ref_order_id, ref_user_id, status(pending|settled|cancelled), calc_note, settle_at`

---

## 7. 风控与客诉域

### complaints — 投诉/退款工单
`order_id, from_user, from_role, against_user, region_id, type(complaint|review_appeal), title, content, status(open|agent_handled|escalated|closed), handler_id, handle_note, resolved_at`

### risk_events — 风控事件
`order_id, user_id, region_id, type(fake_checkin|brush|abnormal_location|high_cancel), level(low|mid|high), reason, status(open|reviewing|closed), settlement_hold`

`settlement_hold = 1` 时结算批处理跳过该订单。

---

## 8. 消息域

### messages — 站内消息
`user_id, title, content, type(system|order|payment|risk|notice), read, link`
索引 `idx_msg_user(user_id,read)`

---

## 9. 表关系概览

```
users 1─1 parent_profiles / teacher_profiles / sales_profiles / agent_profiles / wallets
users 1─n addresses / demands / orders / messages / reviews / credit_logs
demands 1─n applications ─n─1 users(teacher)
applications ─confirm─> orders
orders 1─n payments / reviews
orders 1─1 escrow_ledger(逐笔)  orders 1─n wallet_txns
teacher_profiles 1─n teacher_services / growth_logs / level_logs
agent_profiles 1─n sales_profiles 1─n bindings ─1 users
sales_profiles 1─n promotion_codes / rewards
```

---

## 10. MySQL 8 迁移映射

| SQLite | MySQL 8 |
| --- | --- |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY` |
| `TEXT`（枚举类） | `VARCHAR(32)` + 索引 |
| `TEXT`（长文本/JSON 串） | `TEXT` 或 `JSON` |
| `REAL` | `DECIMAL(10,6)`（经纬度） |
| `INTEGER`（金额，分） | `BIGINT` |
| `PRAGMA journal_mode=WAL` | InnoDB |
| 事务 `BEGIN IMMEDIATE` | `START TRANSACTION` + `SELECT ... FOR UPDATE`（抢单建议改用 Redis 分布式锁 + 唯一索引双保险） |
| 字符串时间 | `DATETIME(3)`，比较逻辑不变 |

建议在 MySQL 上额外建立的索引：
```sql
CREATE INDEX idx_orders_paid ON orders(status, paid_at);
CREATE INDEX idx_order_settle ON orders(status, settle_at);
CREATE UNIQUE INDEX uk_wallet_txn ON wallet_txns(order_id, user_id, type);
```