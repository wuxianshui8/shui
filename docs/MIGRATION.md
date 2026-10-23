# 技术选型迁移记录（需求书 6.1）

需求书要求：**NestJS（或 Spring Boot）+ MySQL 8.0 + Redis + Vue3 + Element Plus + uni-app**。
当前仓库里同时存在两套实现，二者共用同一份 API 契约与业务规则：

| 目录 | 技术栈 | 状态 | 用途 |
| --- | --- | --- | --- |
| `server/` + `web/` | Node 原生 http + SQLite + 原生 ESM | ✅ **功能完整、316+ 项断言全绿** | 已验收的参考实现，可直接演示与试运行 |
| `apps/api-nest/` | **NestJS 10 + TypeORM + MySQL 8.4 + Redis 5** | 🚧 迁移中（P1 切面 15/15 + P2 家长端域 e2e §1–§3 20/20） | 按需求书选型的正式后端 |

迁移原则：**不降低正确性**。既有 7 个测试套件是 HTTP 契约级测试，直接可作为新后端的验收门禁
（改 `BASE_URL` 即可复用），端口逐模块迁移、逐个套件变绿，避免一次性重写带来的质量倒退。

---

## 1. 本轮已完成并验证

### 1.1 依赖落地（真实服务，非模拟）

| 组件 | 版本 | 部署方式 | 端口 |
| --- | --- | --- | --- |
| MySQL | 8.4.0 Community（官方 winx64 便携包） | `tools/setup-services.ps1` 一键下载 + `--initialize-insecure` | 3307（仅 127.0.0.1） |
| Redis | 5.0.14.1（tporadowski Windows 移植版） | 同上 | 6380 |

> 两者均为**本地开发/验收用**；生产必须使用正式 MySQL 8 主从 + Redis 集群并设置强口令。

### 1.2 MySQL 8 建库脚本

`apps/api-nest/db/schema.mysql.sql` —— 由 `server/core/schema.sql` 自动转换生成（37 张表全部建成并实测通过）：

| 转换项 | 处理方式 |
| --- | --- |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY` |
| 金额 `INTEGER` | `BIGINT`（单位：分，避免溢出） |
| `*_id` 列 | 统一 `BIGINT UNSIGNED`，保证外键类型一致 |
| `REAL` | `DOUBLE` |
| `TEXT` | 短字段 `VARCHAR(255)`、唯一键列 `VARCHAR(191)`、长文本保留 `TEXT` |
| `CREATE INDEX IF NOT EXISTS` | 内联为表级 `KEY`（MySQL 8 不支持前者） |
| 以下划线开头的保留字（`change` / `read` / `key`） | 全部标识符加反引号 |
| `invoices` 部分唯一索引 | 生成列 `active_order_id = IF(status<>'rejected', order_id, NULL)` + 唯一索引 |

实测：`information_schema.tables` 中 `jiajiao` 库 **37 张表**，`uk_invoice_active_order` 为 UNIQUE + STORED GENERATED。

### 1.3 NestJS 应用骨架（TypeScript 编译 0 错误）

```
apps/api-nest/
  db/schema.mysql.sql      MySQL 8 建库脚本（37 表）
  db/seed-min.mjs          最小种子：片区 + 管理员 + 15 组规则（复用 server/core/defaults.js）
  src/config.ts            环境变量配置（MySQL/Redis/端口/密钥）
  src/main.ts              Bootstrap：全局 /api 前缀、统一异常过滤器、安全响应头、静态托管既有 web/
  src/app.module.ts        TypeOrmModule.forRoot(MySQL) + RedisModule + RulesModule + 全局鉴权 Guard
  src/common/              token（HMAC）、password（scrypt）、errors、异常过滤器
  src/redis/               ioredis 全局 Provider
  src/rules/               规则配置服务（MySQL 权威源 + Redis 缓存）+ 规则引擎（派单/等级/信用/分账）
  src/health/              GET /api/health（MySQL + Redis 双链路探活）
  src/meta/                GET /api/meta/dictionary | rules-public
  src/auth/                POST /api/auth/login-password、GET /api/auth/me、全局 AuthGuard + @Public()
```

### 1.4 验证结果（`node tools/verify-nest.mjs`，15 项全通过）

```
[PASS] MySQL 与 Redis 已就绪            mysql=True redis=True
[PASS] MySQL 建表完整                   37 张表
[PASS] NestJS 服务已监听 :4300
[PASS] NestJS + MySQL + Redis 全通      users=1 mysql=5ms
[PASS] 字典接口                          学段 5 科目 16
[PASS] 公开规则读自 MySQL                11 组
[PASS] 规则写入 Redis 缓存               keys=15
[PASS] 错误口令被拒                      HTTP 400
[PASS] 管理员登录成功                    role=admin
[PASS] 令牌校验通过                      nickname=平台管理员 id=1
[PASS] 无令牌 401                        HTTP 401
[PASS] 篡改令牌 401                      HTTP 401
[PASS] X-Frame-Options
[PASS] CSP
```

即：**NestJS + TypeORM + MySQL 8 + Redis 全链路真实跑通**，鉴权、规则配置（含 Redis 缓存穿透到 MySQL）、
统一错误响应、安全响应头均已按既有契约实现。

### 1.5 复现命令

```powershell
# Windows PowerShell 5.1：逐行执行（5.1 不支持 `&&` 链式，那是 bash / pwsh 7+ 的语法）

# 1) 装依赖（一次性，MySQL 247MB + Redis 12MB）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\setup-services.ps1

# 2) 装 npm 依赖（一次性，222 个包）
cd apps\api-nest
npm install

# 3) 一键验证（自动起停 MySQL/Redis/NestJS，跑完自动清理）
cd ..\..
node tools\verify-nest.mjs                  # P1 切面 15 项
node tools\gate-p2.mjs                      # P2 门禁：新后端跑既有 e2e §1–§3（20 项）
```

---

## 1.6 P2：家长端域已迁移（本轮）

新增模块：

```
src/common/geo.ts             haversine / 点在多边形 / resolveRegion（电子围栏归属）
src/common/access.ts          @Roles() 角色白名单装饰器
src/common/reply.ts           ok() / nowIso()
src/common/addresses.*        地址 CRUD + 设默认（含片区解析）
src/parent/parent.*           首页聚合、教员广场、教员详情、家长档案
src/demand/demands.*          需求 CRUD / 暂停撤销 / 抢单报名 / 附近订单 / 详情数据范围
src/admin/admin.controller.ts  总览（P6 扩展）
src/agent/agent.controller.ts  片区大盘（P5 扩展，强制片区隔离）
```

门禁结果（`node tools/gate-p2.mjs`，对新后端跑既有 e2e 前 3 组）：

```
== 1. 注册登录与权限 ==          7/7   （验证码下发/登录、错误码、401、五角色、两类越权 403）
== 2. 家长端：首页/广场/发需求 == 8/8   （片区定位、附近教员、科目筛选、优先级排序、详情、地址、发布、加急费）
== 3. 教员端：抢单并发与派单 ==  5/5   （附近订单、0.15km 派单半径、20 并发仅 1 成功、重复拒绝、报名可见）
（分段模式：仅执行到第 3 组）通过 20 项，失败 0 项
```

关键实现点：

- **抢单原子性**：`INSERT IGNORE` + `applications` 唯一索引（MySQL 侧同样生效），20 并发实测仅 1 次成功；
- **电子围栏归属**：`resolveRegion()` 先点在多边形、退化为中心点+半径；
- **数据范围**：需求详情对教员做「已报名 或 半径+科目匹配」判定，其余 403；
- **所有 POST 返回 200**（Nest 默认 201，与既有契约不符，已统一 `@HttpCode(200)`）。

### 1.7 迁移过程中发现并修复的缺陷（3 个）

| # | 缺陷 | 影响 | 修复 |
| --- | --- | --- | --- |
| 1 | `server/core/schema.sql` 的 `users` 建表语句**没有 `reg_ip`** 字段（SQLite 侧一直靠 `ensureColumn()` 补列，掩盖了问题） | MySQL 建库缺列，注册/登录直接 500 | 补进建表语句并重新生成 MySQL DDL |
| 2 | mysql2 把 `BIGINT` 返回为**字符串**，导致令牌 `uid` 变字符串，`Number(parent_id) === uid` 恒假 | 家长查不到自己的需求（403） | 令牌签发/校验统一 `Number()`，并开启 `supportBigNumbers + bigNumberStrings:false` |
| 3 | Nest 的 `@Post()` 默认返回 **201** | 与既有前端/测试契约（200）不符，验收全部失败 | 全部 POST 加 `@HttpCode(200)` |

修复后：新后端 §1–§3 **20/20**；参考实现（SQLite）回归 **e2e 157/157 + rules 51/51 + healthcheck 12/12** 零影响。

### 1.8 P3：订单与资金域已迁移（本轮）

新增 / 扩展模块：

```
src/common/ledger.ts            担保台账 + 钱包：ensureWallet / walletAdd / walletFreezeIncoming /
                                walletUnfreezeIncoming / walletSettle / walletSnapshot / escrowMove / escrowBalance
src/common/audit.ts             操作留痕 audit() + 站内消息 notify()
src/order/orders.service.ts     订单全生命周期：下单 / 确认接单 / 担保支付（分账+提成）/ 打卡 / 结束 /
                                家长确认（冻结+成长分+信用分）/ T+N 结算 / 取消退款 / 评价 / 紧急求助 /
                                订单视图与数据范围 / 财务总览
src/order/orders.controller.ts  POST /orders/from-service、GET /orders/:id、
                                POST /orders/:id/{pay,checkin,finish,confirm,cancel,refund,sos,review}
src/wallet/wallet.controller.ts GET /wallet（钱包+流水+发票申请单+可开票订单）、GET /wallet/txns
src/teacher/teacher.controller.ts  GET /teacher/level（成长分/等级/抽佣/派单权重/升级进度）、GET /teacher/orders
src/agent/agent.controller.ts   新增 GET /agent/risks（片区风控事件 + 风险指数，强制片区隔离）
src/admin/admin.controller.ts   新增 GET /admin/finance、POST /admin/settlement/run、
                                GET /admin/refunds、POST /admin/refunds/:id/review（approve 必须释放担保资金）
src/demand/demands.controller.ts  新增 POST /demands/:id/confirm（原子占位，并发仅 1 次成功）
```

门禁结果（`node tools/gate-p3.mjs`，对新后端复用既有 e2e 套件跑到第 7 组）：

```
== 4. 下单支付与担保交易 ==             6/6  （确认并发安全、待付款、支付、两次幂等、重复支付拦截、后台 GMV/担保）
== 5. 上门打卡定位校验 ==               3/3  （超距 400+事件、风控事件落片区、阈值内打卡 in_class）
== 6. 结束授课→确认→冻结→结算 ==         8/8  （finish、completed+settleAt、frozen 差额=课时费、成长分、到期批处理、强结算、冻结清零）
== 7. 评价与成长分 ==                   3/3  （权重落库、重复评价 400、成长分提升）
（分段模式：仅执行到第 7 组）通过 40 项，失败 0 项
```

e2e 是串行执行且遇错中止，§13/§14 需要先通过 §8–§12（提现/代理/业务员/规则/风控，属 P4–P6），
因此本轮用定向脚本等价校验这两组断言：

```
E2E_SCRIPT=tools/check-refund.mjs node tools/gate-p3.mjs
  ✓ 分账恒等式 ① amount = teacherIncome + serviceFee（15000 = 14100 + 900）
  ✓ 分账恒等式 ② serviceFee = agentShare + salesCommission + platformRevenue（900 = 375 + 300 + 225）
  ✓ 退款审批同步释放担保资金（减少 ¥150.00）
  ✓ 退款流水已入账 payments
  P3 定向校验：通过 15 项，失败 0 项
```

关键实现点：

- **担保闭环**：支付 → `escrow_ledger` 记 `in`；结算放款 / 退款审批 → 记 `out`；`escrowMove()` 拒绝负余额（`ESCROW_NEGATIVE`），
  保证「`SUM(in)-SUM(out)` = 已支付未结算未退款订单的 `amount+urgent_fee` 之和」；
- **幂等**：`pay` 对已支付订单直接返回原订单（HTTP 200，不重复入账），`X-Idem-Key` 仍落 `payments`；
- **并发**：状态与资金变更全部在 `ds.transaction` + `SELECT ... FOR UPDATE` 内完成；
- **规则驱动**：打卡阈值、冻结天数、免费取消窗口、取消违约金比例、评价权重、成长分基数、刷单阈值均取自规则配置中心，改配置即时生效；
- **数据范围**：订单详情按角色判定（本人 / 管理员全量 / 代理限本片区 / 业务员限本人推广客户），代理与业务员查看时手机号脱敏；
- **反作弊**：同一家长 24 小时下单超阈值自动生成 `brush` 风控事件并置 `settlement_hold=1`，结算批处理会跳过被冻结订单。

本阶段未覆盖（如实记录）：提现与发票受理、上课前提醒、业务员/代理域其余接口——按计划落在 P4–P6。

### 1.9 P4：教员端 + 钱包提现 + 发票 + 定时任务（本轮）

新增 / 扩展模块：

```
src/wallet/wallet.service.ts     提现申请（最低额/手续费/幂等/账号脱敏）、提现审核（通过累计 total_withdraw，
                                 驳回原路退回）、发票申请（本人订单/状态/重复/企业税号/邮箱校验）、发票受理
src/wallet/wallet.controller.ts  新增 GET /withdrawals、POST /withdrawals、POST /invoices
src/teacher/teacher.controller.ts 教员端全域：POST /teacher/apply、GET|PUT /teacher/profile、POST /teacher/online、
                                 GET /teacher/dashboard、services CRUD+toggle+delete、GET /teacher/income、
                                 /teacher/calendar、/teacher/reviews（+ /:id/appeal）、/teacher/profile-page
src/auth/auth.service.ts         新增 deactivate()：校验未完结订单与冻结余额 → 匿名化个人信息（保留订单与资金流水）
src/auth/auth.controller.ts      新增 POST /api/auth/deactivate
src/jobs/jobs.service.ts         定时任务：T+N 结算 / 抢单超时失效 / 上课前提醒（默认 5 分钟一轮，可配置/可关闭）
src/order/orders.service.ts      新增 runLessonReminders()（remind_sent 抢占式置位，重复触发不重复推送）
src/admin/admin.controller.ts    新增 POST /withdrawals/:id/review、POST /invoices/:id/review、POST /reminders/run
```

门禁结果（`node tools/gate-p4.mjs`，对新后端复用既有 e2e 套件跑到第 8 组）：

```
== 8. 提现与财务审核 ==               3/3  （提现申请 ¥188.00 手续费 ¥1.13、平台审核打款 paid、低于最低额 400）
（分段模式：仅执行到第 8 组）通过 43 项，失败 0 项
```

定向校验（`E2E_SCRIPT=tools/check-invoice-reminder.mjs node tools/gate-p4.mjs`），等价覆盖 e2e §17/§18：

```
✓ 钱包返回可开票订单与我的申请（可开票 2 单）      ✓ 提交开票申请成功（FP…，¥200.00）
✓ 开票金额 = 订单实付（含加急费）                ✓ 同一订单重复申请被拒绝（400）
✓ 企业抬头缺税号被拒绝（400）                    ✓ 为他人订单申请开票被拒绝（403）
✓ 后台财务看到待受理发票 1 件                     ✓ 财务受理开票并回写电子发票地址
✓ 已受理的申请不可重复受理（400）                 ✓ 家长端同步显示「已开票」
✓ 已开票订单从可开票列表移除                      ✓ 驳回缺原因 400 / 驳回回写原因 / 驳回后可重申请
✓ 开课 55 分钟前触发上课提醒（1 单）              ✓ 提醒阈值取自规则配置（默认提前 60 分钟）
✓ 重复触发不重复推送                             ✓ 有未完结订单时禁止注销（4 笔）
✓ 无未完结订单的账号可自助注销                     ✓ 注销后令牌立即失效（403）
P4 定向校验：通过 23 项，失败 0 项
```

关键实现点：

- **提现资金安全**：申请时先扣可用余额并写 `wallet_txns`；驳回走 `walletAdd` 退回，通过才累计 `total_withdraw`，
  避免「已扣未打款」在报表上失真；
- **发票一单一票**：MySQL 用生成列 `active_order_id = IF(status<>'rejected', order_id, NULL)` + 唯一索引实现「部分唯一」，
  驳回后可重申请；
- **提醒幂等**：`UPDATE ... WHERE remind_sent = 0` 抢占式置位，多实例/重复触发只推一次；
- **注销合规**：注销前拦截未完结订单与冻结金额；仅匿名化身份信息，订单、资金、评价流水保留；
- **定时任务**：`JOBS_ENABLED=0` 可关闭、`JOBS_INTERVAL_MS` 可调（默认 5 分钟），单轮内某一步失败不影响其余步骤，
  且带重入保护。

本阶段未覆盖（如实记录）：业务员端、区域代理端（奖励周结 / 代理分成 / 保证金 / 片区风控 / 客诉）、后台 9 大模块其余部分、
规则配置中心写接口、Redis 分布式锁抢单——按计划落在 P5–P7。


### 1.10 P5：业务员端 + 区域代理端（本轮）

新增 / 扩展模块：

```
src/sales/sales.controller.ts    推广码（家长/教员双通道，自动生成）、业绩看板（今日/本周/本月 + 7 日趋势）、
                                 客户管理（手机号强制脱敏）、奖励明细与类型字典、业务员档案；POST /public/promo/:token/scan
src/agent/agent.controller.ts    片区大盘（GMV/订单/活跃教员与家长/7 日趋势/网格热力/考核评分/风险概览）、
                                 业务员开通与启停与详情、片区订单（地址脱敏）与 CSV 导出、收益结算（6 期账单 +
                                 服务费分成/管理提成/冠军奖构成）、客诉处理、风控事件上报（置 settlement_hold）、公告、档案
src/common/codes.ts              randomCode() / DEMO_PASSWORD（与参考实现一致）
src/admin/admin.controller.ts    新增 POST /admin/rewards/settle（周结批量结算，逐笔抢占式置位防重复入账）
db/seed-min.mjs                  补齐参考实现演示数据集：滨江代理、西湖英语教员、西湖/滨江各 1 位家长
```

门禁结果（`node tools/gate-p5.mjs`，对新后端复用既有 e2e 套件跑到第 10 组）：

```
== 9. 区域代理数据隔离与结算 ==        8/8  （片区 GMV、片区订单与地址脱敏、账号信息、公告、6 期账单、开通业务员、列表手机号脱敏）
== 10. 业务员推广端 ==                 4/4  （双通道推广码、客户手机号禁止明文、奖励明细、奖励周结 1 笔）
（分段模式：仅执行到第 10 组）通过 55 项，失败 0 项
```

另外把 `test/security.test.js` 指向新后端试跑（补齐演示账号后）：

```
===== 1. 鉴权基线：令牌校验与角色边界 =====
  ✓ 全部受保护接口在无令牌时返回 401（6/6）
  ✓ 伪造/篡改令牌被拒绝（401）
  ✓ 非法格式令牌被拒绝（401）
  ✓ 角色越权访问全部返回 403（7/7）
===== 2. 横向越权 =====  ← 卡在尚未实现的 GET /api/admin/orders（P6 项）
```

关键实现点：

- **片区强隔离**：代理端所有查询强制带 `region_id`（`myRegion()`），跨片区对象一律 403；
- **敏感信息脱敏**：代理看片区订单走带 `mask` 的订单视图（地址 8 字 + `***`、手机号 `139****0101`），
  业务员看客户列表手机号一律脱敏；
- **业务员开通**：代理创建账号即绑定 `agent_id + region_id`，初始口令与演示一致并站内通知；
- **奖励周结幂等**：`UPDATE rewards SET status='settled' WHERE id=? AND status='pending'` 抢占成功才入账钱包，
  重复点「结算」不会重复打款；
- **收益可核对**：账单按近 6 个月逐期聚合 `agent_share`，并拆出「服务费分成 / 管理提成 / 冠军奖」三项构成。

本阶段未覆盖（如实记录）：平台后台 9 大模块（订单/用户/教员审核/规则配置写接口/审计日志/风控仲裁/运营/发票/导出）
——按计划落在 P6；`security.test.js` 全量、`concurrency.test.js`、`browser-check.mjs` 分别落在 P6–P9。

### 1.11 P6：平台后台域（本轮）→ e2e 全链路打通

新增 / 扩展模块：

```
src/admin/admin-ops.service.ts     后台业务：规则读写、用户与分页、教员审核与调级、订单（列表/改价/强制关闭/CSV 导出）、
                                   区域、代理（详情/编辑/启停/保证金台账）、风控处置、差评仲裁、客诉结案、
                                   Banner·公告·优惠券全 CRUD、审计日志分页
src/admin/admin-ops.controller.ts  与 admin.controller.ts 共用 /api/admin 前缀（约 40 个路由）
src/public/public.controller.ts    GET /public/{banners,announcements,coupons}（免登录）
src/message/message.controller.ts  GET /messages、POST /messages/:id/read、/messages/read-all
src/common/paging.ts               paging() / pagedResult()（默认 300、上限 500，与参考实现一致）
db/seed-min.mjs                    补齐优惠券、协议、含未完结订单的家长（注销分支）、其余演示账号
```

门禁结果（`node tools/gate-p6.mjs`，把既有 e2e 套件**完整**跑在新后端上）：

```
== 11. 规则配置中心 ==        3/3    （15 组规则、Lv1–Lv5 抽佣、打卡阈值热更新 500→3000 并回滚）
== 12. 风控与仲裁 ==          4/4    （事件列表、关闭并解除结算冻结、差评申诉、平台仲裁撤销并回滚扣分）
== 13. 取消退款 ==            3/3    （退款中 → 审批 → 担保资金减少 ¥120.00 台账闭合）
== 14. 资金零误差 ==          3/3    （分账恒等式、担保非负、钱包与冻结池非负）
== 15. 运营工具 ==           10/10   （Banner 编辑/停用/公开接口联动/空标题 400、公告增改下线置顶删除、优惠券编辑停用/金额为 0 拒绝、三类变更均入审计日志）
== 16. 导出/代理/超时 ==     13/13   （CSV 表头与状态中文化、行数一致、代理详情考核与保证金台账、超额退还 400、分成比例越界 400、禁用后代理端 403、订单与用户与日志分页、抢单超时清理）
== 17. 发票受理 ==            9/9    （可开票列表、重复申请 400、后台受理开票、重复受理 400、已开票移出列表、操作日志）
== 18. 提醒与注销 ==         15/15   （55 分钟前提醒、阈值热更新、幂等不重推、站内消息、有未完结订单 400、管理员 403、注销后令牌失效且可重新注册）
== 19. 紧急求助 ==           10/10   （建单/防重复/风控列表 high/定位距离/通知管理员·代理·对方/非当事人 403/平台结案/日志）
== 20. 区域归属 ==           12/12   （自然注册按地址归属片区、跨区订单收益归需求地址片区代理而非家长片区）
测试结果：通过 152 项，失败 0 项 —— 全部验收用例通过 ✅
```

关键实现点：

- **规则热更新**：`PUT /admin/rules/:key` 走 `RuleConfigService.set()`，同时失效内存与 Redis 单键，
  下一次读取立即生效（打卡阈值、提醒阈值均验证过）；
- **强制关闭必须释放担保**：已支付订单被平台关闭时 `escrowMove('out')` + 退款流水，避免台账悬挂；
- **仲裁回滚**：撤销差评时按 `bad_base × 评价权重` 返还成长分，并把 `rating_count` 减 1、工单一并结案；
- **保证金台账**：`agent_profiles.deposit` 与 `agent_deposits` 逐笔对账，超额退还返回 400；
- **导出脱敏与中文化**：CSV 15 列含分账明细，状态列输出中文并加引号；
- **公开接口与后台联动**：Banner/公告/优惠券停用后立即从 `/public/*` 消失，启用后恢复。

本阶段未覆盖（如实记录）：`security.test.js` 全量（§2 需要多笔历史已支付订单，seed 未备）、
`rules.test.js` 全量、`concurrency.test.js`（Redis 分布式锁）、`browser-check.mjs` —— 按计划落在 P7–P9。
---

### 1.12 P7：并发与安全加固（本轮）

新增 / 修复：

```
src/common/lock.ts                 Redis 分布式锁：SET NX PX 抢占 + Lua 校验持有者释放；自旋等待 2s，
                                   抢不到降级执行（由 applications 唯一索引兜底，保证「不重复接单」）
src/demand/demands.service.ts      抢单临界区纳入 Redis 锁（6.2 双保险），响应附带 lockAcquired 便于观测
src/common/pipes-and-filters.ts    未预期异常（含 DB 转换/约束错误）统一折叠为 400，且不回显底层错误信息
src/auth/auth.service.ts           口令登录失败锁定（risk.login_fail_limit 规则驱动，429 + LOGIN_LOCKED，按 IP+账号）
                                   注册反作弊：同设备 24h / 同 IP 1h 频次限制，超限写 risk_events 并拒绝
src/complaint/complaint.controller.ts  POST /complaints（客诉工单，通知管理员与片区代理）
src/health/health.controller.ts    健康检查补充担保账户余额（原先为 NaN）
db/seed-min.mjs                    补齐已结算历史订单（台账闭合）、他人订单/需求、滨江业务员
tools/concurrency-mysql.mjs        MySQL 权威库版并发验收（100 并发抢单 / 并发确认 / 幂等支付 / 台账闭合）
```

门禁结果（均为本轮实跑）：

```
test/e2e.test.js       153/153   （全套 §1–§20；本轮修复后回归通过）
test/security.test.js   53/53    （越权 / 注入 / 脱敏 / XSS / 安全头 / 登录锁定 / 健康检查）
test/rules.test.js      50/50    （派单 / 分账 / 等级 / 信用 / 取消窗口 / 超时失效 / 反作弊 / 考核）
concurrency-mysql.mjs   23/23    （100 人并发抢单 100/100 入锁成功、100 次并发确认仅 1 单、
                                   同教员 100 次仅 1 成功、30 次并发支付仅 1 条流水、台账闭合）
scripts/browser-check.mjs 16/16  （5 端多尺寸无横向溢出 + XSS 载荷按文本渲染）
```

关键实现点：

- **锁不是唯一防线**：锁只负责把热点临界区串行化，正确性仍由 `applications(demand_id, teacher_id)` 唯一索引保证；
  高并发下即便抢锁超时降级，也不会重复接单；
- **失败语义可区分**：并发确认失败区分 409（已被确认）与 400（报名状态已变更 / 锁等待超时），
  与参考实现契约一致（实测 409×少量 + 400×其余 = 99）；
- **安全默认拒绝**：任何未预期异常一律 400 + 通用文案，注入载荷无法通过错误信息探测 SQL 结构；
- **锁定即时生效/即时解除**：阈值取自规则中心，改大后立即可重试、还原后立即恢复 429。

### 1.13 P9：数据迁移与双跑比对（本轮）

```
tools/migrate-sqlite.mjs     SQLite → MySQL 全表迁移：读 PRAGMA + information_schema 取列交集，
                             自动跳过生成列（invoices.active_order_id），分批 200 行 INSERT ... ON DUPLICATE KEY
tools/healthcheck-mysql.mjs  与 scripts/healthcheck.mjs 等价的 12 项一致性巡检（MySQL 语法）
tools/gate-p9.mjs            一键门禁：建库 jiajiao_migrate → 装载 DDL → 重置 SQLite 种子 → 迁移 → 巡检
```

结果：

```
37 张表 / 500 行全部迁移成功（表级异常 0）
✓ 用户数 32/32   ✓ 订单数 17/17   ✓ 钱包余额总额 142925/142925
✓ 担保台账余额 115000/115000      ✓ 平台净收入 15970/15970   ✓ 规则组数 15/15
迁移后 MySQL 一致性巡检：共 12 项，异常 0 项 ✅
```

### 1.14 前端框架重写的推进过程（已闭环，保留记录）

该阶段最初评估为「需联网安装 Vite / Vue / Element Plus / uni-app 依赖，剩余预算内难以验证，不做半成品交付」。
随后实测 npm registry 可达（vue 3.5.44），遂按原计划完成实现与验收，详见 §1.15。
两套新前端均为**真实构建产物 + 真实接口联调**，不是占位脚手架。

### 1.15 P8：前端框架迁移（本轮）

```
apps/web-admin/     Vue3 3.5 + Vite 5 + Element Plus 2.8 + vue-router 4（PC 管理后台，15 个页面）
  src/App.vue       侧栏布局 + 顶栏 + 路由视图
  src/api.js        统一客户端：Bearer 令牌、code=0 判定、401 自动回登录
  src/router.js     hash 路由 + 登录守卫
  src/views/        Login / Overview / Orders / Refunds / Finance / Withdrawals / Invoices /
                    Users / Teachers / Agents / Regions / Rules / Ops / Risks / Logs
                    （含改价、强制关闭、退款审批、提现审核、发票受理、代理保证金台账、片区新建与围栏、
                      规则热更新、运营三件套增删改启停、风控四类处置、差评仲裁）

apps/web-mobile/    uni-app（Vue3 语法）：H5 + 微信小程序双产物
  src/pages/login          手机号 + 口令登录，按 role 分流
  src/pages/parent         家长端：片区/附近教员、订单「支付 / 确认完成 / 评价」闭环
  src/pages/parent/publish 家长端发需求（学段/科目/地址/预算/加急）
  src/pages/teacher        教员端：课时收入看板、等级权益、附近需求抢单、
                           订单「上门打卡（真实定位）/ 结束授课」闭环
  src/pages/teacher/wallet 教员钱包：明细/冻结/累计收支、提现申请（最低额与手续费规则驱动、
                           幂等键 X-Idem-Key）、提现记录与钱包流水
  src/pages/sales          业务员端：本月注册/成交/GMV/待结奖励、双通道推广码、客户
  src/pages/sales/rewards  业务员奖励明细：按类型汇总与筛选、结算状态、钱包可用
  src/pages/agent          代理端：片区 GMV/订单/业务员、考核完成度、片区订单
  src/pages/agent/complaints 代理客诉工单：片区隔离列表、「已处理 / 上报平台 / 关闭」闭环

托管：apps/api-nest/src/main.ts 新增 /admin-vue/ 与 /m/ 静态托管 + SPA 路由回落
```

构建与验收（本轮实跑）：

```
apps/web-admin:  npm install（54 包）→ vite build ✓ 15 个页面分包（含 Regions）
apps/web-mobile: npm install（669 + 78 包）→ uni build ✓ H5；uni build -p mp-weixin ✓ 小程序
                 （app.json 注册 10 个页面，产出 wxml/wxss，可直接导入微信开发者工具）

tools/check-admin-spa.mjs  38/38   （入口与 assets 200、15 个页面分包、13 个模块接口、区域管理写闭环、
                                    需求池与管理员账号（P16）、Banner 启停闭环、
                                    规则热更新 500→800m 并回滚、CSV 导出、非管理员 403）
tools/check-mobile-spa.mjs 41/41   （/m/ 入口与 assets、9 条路由 history 回落、四角色登录+接口、
                                    业务员奖励明细 / 代理客诉工单 / 教员钱包提现规则断言、教员端抢单闭环、
                                    消息中心未读与已读闭环、微信小程序 app.json 与页面产物一致性）
```

关键实现点：

- **不破坏既有契约**：两套新前端全部走同一套 `/api` 契约与 `code=0` 约定，未改动任何后端接口；
- **PC 后台运维闭环**：强制关闭订单（释放担保）、改价、退款审批、提现审核（打款/驳回退回余额）、
  发票受理（开票/驳回）、规则热更新、代理分成与保证金台账、风控四类处置、差评仲裁、
  运营三件套增删改启停、审计日志分页；
- **移动端业务闭环**：家长「发需求 → 支付 → 确认完成 → 评价」、教员「抢单 → 上门打卡 → 结束授课」，
  打卡优先取 `uni.getLocation` 真实定位，失败回落上课地址附近（与 500m 阈值校验一致）；
- **多端产物**：同一份 uni-app 源码产出 H5 与微信小程序，页面清单一致；
- **零构建污染**：`apps/*/node_modules`、`apps/*/dist` 已在 `.gitignore`，产物由 NestJS 托管，单端口交付。

### 1.16 迁移完成度总览（全部阶段）

| 阶段 | 状态 | 门禁 |
| --- | --- | --- |
| P1 基础设施 / 规则引擎 / 鉴权 | ✅ | `verify-nest.mjs` 15/15 |
| P2 家长端域 | ✅ | e2e §1–§3 20/20 |
| P3 订单与资金域 | ✅ | e2e §1–§7 40/40 + `check-refund.mjs` 15/15 |
| P4 教员端 + 钱包提现 + 发票 + 提醒 + 注销 + 定时任务 | ✅ | e2e §1–§8 43/43 + `check-invoice-reminder.mjs` 23/23 |
| P5 业务员端 + 区域代理端 | ✅ | e2e §1–§10 55/55 |
| P6 平台后台域 | ✅ | e2e 全套 **153/153** |
| P7 并发与安全加固 | ✅ | `concurrency-mysql` **23/23**、`security` **53/53**、`rules` **50/50** |
| P8 前端框架迁移（Vue3 + Element Plus / uni-app） | ✅ | `check-admin-spa` **38/38**、`check-mobile-spa` **41/41** |
| P9 SQLite → MySQL 迁移与双跑 | ✅ | `gate-p9`：37 表行数一致、6 项汇总一致、迁移后巡检 **12/12** |
| P10 对抗式评审与缺陷修复（安全 + 资金并发） | ✅ | `check-money-races` **27/27**；e2e 153 / security 53 / rules 50 / concurrency 23 全绿 |
| P11 隐私与账号安全加固 | ✅ | `check-privacy-auth` **38/38**；e2e 153 / security 53 / verify-nest 15 全绿 |
| P12 性能基线与热点优化 | ✅ | `nest:bench`（500 次 × 并发 20 × 12 读接口 + 抢单写路径）→ `docs/PERF.md`；修复 2 处串行取数/N+1 |
| P13 接口清单自动生成 + 文档漂移门禁 | ✅ | `api:doc` / `api:doc:check`：删行→退出码 1、重生成→0（双向验证） |
| P14 需求追溯矩阵（新后端）+ 汇总 CI 门禁 | ✅ | `docs/TRACEABILITY-NEST.md`：接口引用全部有效、覆盖 **142/142**；`trace:check` / `ci` / `ci:quick` / `ci:full` |
| P15 容器化交付 + GitHub Actions | ⚠️ | `deploy/`（Dockerfile / compose / .env.example）+ `.github/workflows/ci.yml`（static + integration 双 job）；`deploy:check` 静态校验通过（严格 YAML），compose 结构另由**官方 compose-spec Schema** 校验（`deploy:schema`，负向验证退出码 1）；**本机无 Docker 守护进程，容器运行时未实测**；git 仓库已初始化并提交，推送需远端与凭据 |
| P18 CI 工作流证据映射 | ⚠️ | `tools/check-workflow-proof.mjs`：把 workflow 每条命令映射到本机已通过的门禁（22 条需证据 + 6 条 Runner 专属，未覆盖即失败）；官方 `actionlint v1.7.12 + shellcheck 0.11.0` 已接入 `workflow:check` 并实测无告警；**Runner 已真实执行并通过**（[run #3](https://github.com/wuxianshui8/shui/actions/runs/39588034780)，30 条命令证据映射 + 22 步 workflow） |
| P22 官方校验器接入（替代离线等价校验） | ✅ | 官方 `actionlint v1.7.12` + `shellcheck 0.11.0`（Windows 官方产物，`tools/bin/` 已 gitignore）接入 `npm run workflow:check`，对 `ci.yml` 实测**无告警**；官方 `compose-spec` JSON Schema（固定 commit `de284328`）随仓库提交，`npm run deploy:schema` 做「结构 + 本项目约定」双向校验（负向验证退出码 1）；`npm run ci:full` 全量 **24/24 步**复跑通过；**托管 Runner 已实测**（[run #3](https://github.com/wuxianshui8/shui/actions/runs/39588034780) 两 job 全绿）。仍 ⚠️：仅容器运行时未实测 |
| P23 镜像运行契约门禁（Dockerfile 宿主机等价复演） | ✅ | `tools/check-image-runtime.mjs` **32/32**（ENV/WORKDIR/7 条 COPY/USER node/EXPOSE/HEALTHCHECK/CMD）、校验 `dist` 引用的 6 个包全部在 `dependencies`（`npm prune --omit=dev` 后仍可跑）、以 `NODE_ENV=production + AUTH_SECRET + DEV_SMS=0` 真起服并验证 `/api/health`、HEALTHCHECK 原始命令 exit 0、`/admin-vue/` `/m/` `/parent` 三站点、生产验证码不回显、缺 `AUTH_SECRET` 拒绝启动；负向验证（改 `USER root`、删 db/web COPY、删 HEALTHCHECK）→ 5 项失败退出码 1。已接入 `ci:full` 与 GitHub Actions integration job |
| P24 门禁自检（meta）+ 对抗式评审修复 | ✅ | 新增 `tools/check-gates-selftest.mjs`：为 4 条门禁各备「合法/非法」夹具，断言合法→0、非法→1，**10 条用例全绿**（任一门禁失去作用立刻红）。同时按只读评审修复 9 个真缺陷：`check-compose-schema` 缺依赖由「静默 exit 0」改为**默认失败**（`--allow-skip` 显式降级）、ajv 方言探测不再写错路径；`check-docs-shell` 围栏支持缩进/`~~~`/嵌套、`\n` 规则改为逐命中判反引号区间、递归扫 `docs/**`；`check-windows-scripts` 检查 `spawnSync` 失败（原会静默报成功）、单行无换行 `.bat` 不再误报、新增 UTF-8 往返校验与 UTF-16/纯 CR 检测；`check-image-runtime` 的「验证码不回显」原来读错信封层级（`devCode` 在 `data` 下）**永不失败**，已修正并新增「仅靠 NODE_ENV=production」第二道防线用例（31→**32 项**）、子进程退出钩子清理、`dist` 缺失早退、HEALTHCHECK 兼容 exec 形式且端口替换断言恰好 1 次；`deploy/up.bat` 新增引擎/compose 探测、`--wait` 等健康、`copy` 与 `ps` 退出码判定、**模板占位密钥拦截**（原来只判 .env 是否存在，用公开占位串就能起生产），并对 docker 调用加 `call` 以免 PATH 里有 `docker.cmd` 包装器时夺走控制权。`ci:full` 22→**24 步** |
| P25 GitHub Actions 首跑修复（真实 Runner） | ✅ | 首次真实运行暴露两个只有 Runner 才有的问题：① `integration` job 里 e2e→security→rules→races 跑在同一库上，races 断言种子精确余额（¥164.00）→ 前序用例改过钱包后必然失败（本机不暴露，因每条 gate 都重建库）；② `working-directory: apps/api-nest` 下 `node ../tools/*.mjs` 实际解析为 `apps/tools/*`（少一层）。修法：新增 `tools/ci-reset.mjs`（DROP/CREATE 库 + 重放 37 表 schema + 灌种子 + 清 Redis + 重启 API，2.3s）并在 7 个依赖干净种子的用例前插入重置步骤；路径统一改 `../../tools/`。最终 [run #3](https://github.com/wuxianshui8/shui/actions/runs/39588034780) **两 job 全绿**（static 13s / integration 206s，484 项断言）。 |
| P26 容器运行时实测（Docker Desktop + WSL2） | ✅ | 环境就绪后真机跑通：`deploy/Dockerfile` + `docker-compose.yml` → mysql/redis/app 三服务 healthy（首次构建 16.2 分钟）、`docker compose run --rm seed` 灌入 12 用户/4 片区/16 组规则、`/api/health` `/admin-vue/` `/m/` `/parent` 全 200、四角色（admin/parent/teacher/agent）登录成功、容器库 37 表且 `healthcheck-mysql` **12/12**。过程中修掉两个**只在容器里暴露**的缺陷：① 运行镜像缺 `server/core/defaults.js`，`db/seed-min.mjs` 的跨目录 import 在容器内解析为 `/app/server/core/defaults.js` → `ERR_MODULE_NOT_FOUND`（补 COPY）；② `seed` 服务没传 `AUTH_SECRET`，而镜像内 `NODE_ENV=production` 会被 `config.ts` 拒绝启动（补环境变量）。两者都已加门禁：`image:runtime` 新增「seed 跨目录 import 必须在 COPY 覆盖范围内」断言（32→**33 项**，负向验证可命中）、`deploy:schema` 新增 seed 必须含 AUTH_SECRET 的约定断言（负向验证可命中）。镜像源：本机 Docker Hub 直连超时，改用 `registry-mirrors`（docker.1ms.run / docker.m.daocloud.io）拉取并重打 tag。 |
| P27 容器栈功能验收（不只是 healthy） | ✅ | 新增 `tools/verify-docker.mjs`（`npm run verify:docker`）：起服务 → 灌种子 → 逐套件跑，并在每个「依赖干净种子」的套件前重置数据（`ci-reset.mjs` 新增 `RESET_TARGET=docker`：DROP/CREATE 库 + 重放 schema + 灌种子 + 清 Redis + `docker compose restart app`）。本机实测 **9 个套件 282 断言全绿**（security 53 / races 27 / privacy 38 / permissions 17 / concurrency 23 / admin SPA 38 / mobile SPA 41 / 镜像契约 33 / 巡检 12）。过程中修掉两个**验收脚本自身**的缺陷：① 子进程用相对脚本路径 + 自定义 cwd 导致 `healthcheck-mysql` 找不到文件（与 CI 那次同类，改绝对路径）；② 宿主机本地签发的 token 与容器内 `AUTH_SECRET` 不一致 → concurrency 的 100 次报名全部 401，改为从 `deploy/.env` 读密钥注入子进程环境。另确认 `e2e`/`rules` 依赖 devCode 回显、在 `NODE_ENV=production` 镜像内不可跑（安全设计），由 CI 主机栈覆盖。 |
| P28 交付收尾加固 | ✅ | ① 新增 `.dockerignore`：构建上下文 **2050 MB → 十几 MB**（原含 `tools/` 1.75GB 与 `node_modules` 288MB），镜像重建 **16.2 分钟 → 18 秒**；② 镜像源确认**实测生效**（`docker info` 显示两个 mirror，`docker pull hello-world` 6.7s，`node`/`mysql`/`redis` 均可用原始镜像名拉取）；③ Docker Desktop `AutoStart` 置为 `true`；④ `image:runtime` 加固：起服前**端口占用预检**（避免对着旧进程做完断言假通过）、依赖扫描改为「只剔注释 + 包名白名单 + **扫到 0 个包直接判失败**」（首次加固误删字符串导致扫到 0 包却报 ✓，属空检查陷阱，已修）。 |
| P29 二次对抗式评审（验收脚本）+ 交接文档 | ✅ | 只读评审针对 `verify-docker.mjs` / `ci-reset.mjs` / `check-image-runtime.mjs` 提出 **7 条必须修 + 多条可选**，全部为真缺陷，已逐一修复并复验：**① Windows 上 `RESET_TARGET=local` 假成功**（`pkill` 不存在 → 旧进程未被杀，新进程绑不上端口，而 `waitHealth` 由**旧进程**应答 200）→ 直接拒绝并提示改用 docker/none；**② `deploy/.env` 在存在性检查之前读取**（首次运行抛 ENOENT，友好提示是死代码）→ 调整顺序；**③ AUTH_SECRET 解析不剥引号 + 优先级与 compose 相反** → 增加 `printenv` 与容器内实际值**严格比对**，不一致即中止（避免本地签 token 全 401）；**④ 首个套件跳过重置**（`mysql-data` 是持久卷，新一轮首个套件跑在上一轮脏数据上）→ 去掉特例，**每个**套件前重置；**⑤ 重置失败仍继续**导致连环误判 → 改为 fail-fast；**⑥ 先 DROP 后读 schema**（文件缺失会留下空库）→ schema 先读入内存；**⑦ 破坏窗口内 app 仍在跑**（定时任务可能写半建好的表并污染精确金额断言）→ 改为 `stop app → 重建/灌种/清缓存 → up -d --wait app`。另修：Redis 清理失败由「静默跳过」改为**失败即失败**、`compose up` 加 `--wait-timeout 180`、宿主机 `dist`/`node_modules` 前置检查、`VERBOSE=1` 失败套件全文输出、重置后 1.5s 稳定等待。`check-image-runtime` 增：`DEAD_PORT` 预检、二次起服等端口释放、COPY 解析支持 `--chown`/续行/多源、依赖扫描纳入 `db/*.mjs`、`from` 支持单引号。新增 `docs/HANDOVER.md`（一页式交接：三种启动方式、账号、验证清单、限制、改动后跑什么）与 README CI/版本徽章。**容器栈连跑 2 轮各 9 套件 282 断言全绿**；本地 `ci:full` 24/24（233s）。 |
| P30 容器栈性能基线 + 备份/恢复 | ✅ | ① **性能基线**：同一压测脚本打容器内 API（Docker Desktop 4.96 + WSL2，三容器 healthy，500 次 × 并发 20）→ 12 个读接口 **p95 ≤ 73.5ms、错误 0**、抢单写路径并发 50 次 **成功 1 / 被拒 49**；对比宿主机基线延迟高 25%~40%，归因于 Docker Desktop 在 WSL2 之上的端口转发（NAT），非应用退化，仍满足需求书「常规查询 < 200ms」。已作为 `docs/PERF.md §6` 入库。② **备份/恢复**：新增 `tools/db-backup.mjs`（`npm run db:backup`）与 `tools/db-restore.mjs`（`db:restore --yes`），自适应容器 / 本机便携 MySQL；备份后立即解压**自检「表数=37 且含 orders」**，恢复前校验表数下限、恢复后复核「表 37 + users 非空」。实测破坏性回环：备份 → 删光订单/支付/台账/评价/流水并清零钱包（orders 3→0）→ 恢复 → **orders 3、users 12、表 37**，`healthcheck-mysql` **12/12 异常 0**。产物目录 `backups/` 已 gitignore。 |
| P31 上线待办清单 + 偏离项纠偏 | ✅ | 新增 `docs/GO-LIVE-CHECKLIST.md`：把「需求书验收之外、真上线还缺什么」按 **A 外部集成（短信/支付/地图/对象存储/小程序上架/推送/电子合同/电子发票）、B 部署运维（HTTPS/多实例/备份自动化与演练/监控告警/日志集中/灰度回滚/密钥管理/镜像 SBOM）、C 数据发布（schema 版本化迁移/冷归档/渠道对账/API 版本化）、D 测试质量（单测缺失/覆盖率/依赖扫描/UI E2E/压测常态化/混沌演练）、E 环境限制** 五类逐条列出，每项标注 ✅/🟡/❌ 现状 + 补齐条件 + 三件优先事项。同时纠正 `TRACEABILITY-NEST.md` 偏离 #6（原写「未做容器化」，实际已交付并实测）——该类文档漂移靠人工发现，`trace:check` 只校验接口/脚本存在性。 |
| P32 单元测试 + 覆盖率门槛（清单 D1/D2） | ✅ | 新增 `apps/api-nest/test/unit/*.test.mjs`（9 个测试文件 + 1 个 fixtures 加载器）→ **82 个用例**，覆盖 `common/{codes,errors,geo,paging,password,reply,token}`、`config`、`rule-engine`：**分账 784 组组合**校验两条恒等式（教员实收 + 服务费 = 成交额、代理 + 业务员 + 平台 = 服务费）与「超额按代理→业务员截断、平台不为负、全整数分」；推送系数/等级映射兜底；令牌篡改、过期、换密钥、载荷非 JSON、畸形输入一律 `null`；scrypt 盐唯一、跨账号不串号、畸形存储拒绝；电子围栏内外点与坏 JSON 退化到「中心点 + 半径」；分页默认 300/上限 500/非法值收敛；生产环境缺 `AUTH_SECRET` 由**子进程**验证拒绝启动（加载期护栏）。新增 `tools/gate-unit.mjs`（`npm run test:unit`）：用 Node 原生 `--experimental-test-coverage` 解析 TAP 与覆盖率表，断言「失败用例 = 0 / 用例数 ≥ 60（**防空检查**，防测试被删后 0 用例也绿）/ 每个目标模块行 ≥ 90% 且分支 ≥ 60% / 目标必须真的出现在报告里」，**不引入 c8/vitest**（根目录保持零第三方依赖）。实测 9 个模块行覆盖 **98.51%~100%（合计 99.65%）**、分支 94.74%。**四类负向验证全部变红**：`COVERAGE_MIN_LINES=99.9` → 1、`UNIT_MIN_TESTS=999` → 1、`UNIT_TEST_GLOB` 指向空目录 → 1（并逐文件点名「未出现在覆盖率报告中」）、`COVERAGE_MIN_BRANCH=100` → 1；注入必失败用例被点名。`ci:full` 24 → **25 步**（静态 12 → 13，静态 18s），CI `static` job 自动继承。过程中修正 4 处**测试自身**的错误断言（非产品缺陷）：口令允许跨字符组重复、负页长收敛到 1 而非回默认、同口令不同盐摘要必然不同、79.9 已越过 L2 上限 → 回落最高档。仍 ⚠️：`orders/wallet/demands` 服务层依赖 DB 夹具，未纳入本轮单测 |
| P33 备份保留策略 + 定时任务脚本（B3）与依赖漏洞审计门禁（D3） | ✅ | **B3**：`tools/db-backup.mjs` 增加保留策略（`KEEP` / `--keep N`，默认 14，`0` 关闭）——按文件名时间戳倒序只留最新 N 份，且**当次产物永不参与删除**；实测连续两次 `--keep 2`：第二次输出「删除旧备份 1 份」，目录稳定收敛到 2 份，三次 `KEEP=3` 亦正确。新增 `tools/backup-schedule.ps1`（`-Action Install/Uninstall/Status/RunNow`，`schtasks` 当前用户级任务）：安装时生成 `backups\backup-run.cmd` 把 node / `DOCKER_BIN` / `KEEP` **固定进任务动作**（避免任务计划程序里 PATH 差异导致「计划跑成功其实没备份」），输出统一追加 `backups\backup.log`（`backup start` / `backup exit=<码>`），`Status` 回显任务字段与日志尾部。实测：包装器直接执行 → exit 0、日志 UTF-8 可读、保留策略生效、`Status` 对未安装判定正确、非法参数（`-Keep 0`、`-Time 3:5`）被拒。**PS 5.1 真缺陷两处已修**：① `$ErrorActionPreference="Stop"` 下 `schtasks` 的 stderr 被当终止错误 → 「未安装」分支直接崩（改经 `cmd /c … 2>&1` 取纯文本 + 只按退出码判定）；② 生成的 `.cmd` 用 ANSI 写含中文注释会被 `check-windows-scripts` 判为非法编码 → 改为 **UTF-8 无 BOM + 首部 `chcp 65001`**（cmd 逐行解析，含中文路径也安全）。⚠️ 本机 Agent 会话无权写任务计划库（`schtasks /Create` → `Access is denied`），因此「安装任务 → 由计划程序触发 → 查上次结果」这段**未实测**，已在脚本里给出管理员身份提示与替代登记方式。**D3**：新增 `tools/check-audit.mjs`（`npm run audit:check`）——`npm audit --omit=dev --json` + **预算制** `deploy/audit-budget.json`（每个 workspace 声明 `block`/`budget`/`expires`；超额即失败、到期即失败、低于预算只告警；缺配置/无 workspace/取不到 JSON 一律失败，`AUDIT_ALLOW_SKIP=1` 才显式降级）。实测：`apps/api-nest` low 1 / moderate 6 / **high 2** / critical 0（2 个 high 全在 `multer` 链，且全仓检索无 `FileInterceptor`/`@UploadedFile`/`multer`/`FormData` → 无文件上传端点，中间件不可达；官方修复只出现在 `@nestjs/platform-express` 12.x，需 Nest 10→12 大版本迁移）、`apps/web-admin` 全 0、`apps/web-mobile` moderate 8 / high 27（uni-app 构建链与构建期工具，H5 产物为静态资源）→ 该 workspace 只阻断 critical。负向验证 4 类全红：预算收紧到 `high:0`（点名 multer 的 8 条 GHSA）、到期日设为过去、配置缺失、空 workspace 列表；配置含 UTF-8 BOM 也能正常解析（Windows 编辑器常见写法）。`ci:full` 25 → **26 步**（静态 13 → 14，静态 26s） |
| P34 短信真实通道（A1，腾讯云）+ 集成端口抽象 | 🟡 代码完成、待密钥 | 新增 `apps/api-nest/src/integrations/sms/`：`sms.port.ts`（`SmsSender` 端口 + `looksPlaceholder` 占位串判定）、`sms.mock.ts`（默认兜底：验证码只写服务端日志且手机号脱敏，不联网不花钱）、`sms.tencent.ts`（**TC3-HMAC-SHA256 签名**纯函数 + `SendSms` 请求体 + `Response.Error`/`SendStatusSet[].Code` 两类错误分支）、`sms.service.ts`（`SMS_PROVIDER=mock/tencent` 工厂 + 进程内单例）。接线：`auth.service.sendCode` 改为 **先下发、后落码**（网关失败不留「可用但用户没收到」的验证码），失败统一 `SMS_SEND_FAILED` 且**不透出网关细节**；`main.ts` 启动即校验配置，真实通道配错**拒绝启动**（占位串视为未配置）。配置：`deploy/.env.example` + `docker-compose.yml` 增加 `SMS_PROVIDER` 与 5 项 `TENCENT_SMS_*`（模板变量约定 ${1}=验证码、${2}=分钟）。单测 82 → **101 用例**（覆盖签名拼装/可复现性/密钥与时间戳变化、请求体与头部契约、错误码分支、错误信息不含验证码、mock 脱敏与 outbox 上限、单例缓存与「缺密钥不静默降级」），覆盖率目标 9 → **13 个模块**（行覆盖合计 **99.78%**）。本机 `ci:full` **26/26 全绿（246s）**、`ci-full --static` **14/14（33s）**。⚠️ 未验证：真实下发需 `SecretId/SecretKey/SdkAppId/签名/模板 ID`；A2 支付仍待（微信优先） |
| P35 微信支付 v3 通道层（A2 第一步） | 🟡 通道完成、待商户号与流程接线 | 新增 `apps/api-nest/src/integrations/pay/`：`pay.port.ts`（`PayProvider` 端口：`createPrepay` / `verifyNotify` / `refund`；`unescapePem` 处理 `.env` 里 PEM 的 `\n` 转义）、`pay.mock.ts`（默认兜底，与真实成功语义对齐，供本地/自动化）、`pay.wechat.ts`（微信支付 v3：`WECHATPAY2-SHA256-RSA2048` 请求签名、JSAPI 下单 `/v3/pay/transactions/jsapi`、JSAPI `paySign`、回调验签 `timestamp\nnonce\nbody\n` + **时间戳防重放**（默认 300s）、`AEAD_AES_256_GCM` 解密（authTag 在密文尾部）、退款 `/v3/refund/domestic/refunds`）、`pay.service.ts`（`PAY_PROVIDER=mock/wechat` 工厂）。启动即校验：缺项/占位串/APIv3 非 32 字节/回调非 HTTPS 一律**拒绝启动**。配置写入 `deploy/.env.example` 与 `docker-compose.yml`（8 项 `WECHAT_PAY_*`）。**单测 18 个新用例**（用本地生成的 RSA 密钥对 + 自加密样本，**不需要商户号**）：签名↔验签往返、换密钥必须失败、Authorization 头与签名串严格比对、paySign 可验证、下单请求体/路径断言、`prepay_id` 缺失与非 2xx 报错、回调「验签通过→解密→业务字段」全链路、改包/过期时间戳/缺字段/缺 resource/非 JSON 全部拒绝、退款路径与金额、mock 与工厂「缺密钥不静默降级」。单测总数 101 → **119**，覆盖目标 13 → **17** 模块（行覆盖合计 **99.61%**，最低模块 98.51%）。仍 ⚠️ 未做：`orders.pay` 拆「预支付 → 回调确认」、`/api/pay/wechat/notify` 路由、幂等入账、超时关单、对账（步骤见 `docs/INTEGRATIONS.md §6`） |
| P36 支付预支付拆分 + 回调路由 + 幂等入账（A2 第 1–3 步） | ✅ | `orders.pay` 按 `PAY_PROVIDER` 分支：**mock 保持「点一下即成功」**（既有用例零回归）；**wechat 走「建预支付单 → `payments.status=pending`（`trade_no=PREPAY:<订单号>`）→ 返回 prepay 参数」**，渠道错误统一 `PAY_CHANNEL_ERROR` 且细节只进日志。新增 `POST /api/pay/wechat/notify`（`@Public`，**只靠验签**，取 `req.rawBody` 原文 + `wechatpay-*` 头部透传，成功只回 `{code:SUCCESS}` 不回显订单信息）。新增 `settlePayNotify`：验签 → **幂等**（已有 success 支付则不动账）→ **金额一致性**（渠道实收必须等于订单应付）→ 非成功状态忽略；`settlePaid` 抽取为 mock 与回调**共用**的结算方法（流水 → 担保入账 → 分账 → 状态推进 → 提成 → 通知 → 审计），两条路径账本一致。`main.ts` 改为 `bodyParser:false` + `useBodyParser("json", { verify })` 采集 rawBody；**不直接 import express**（它只是传递依赖，会被 `check-image-runtime` 拦下——本轮确实被拦并已修正）。新增门禁 `tools/check-pay-flow.mjs`（**17 项**，本地自签 RSA + 自加密，无需商户号）：起 `PAY_PROVIDER=wechat` 临时服务 → 未签名/篡改正文/金额不一致/未知订单/过期时间戳**全部拒绝且订单状态不变**；合法回调入账（`pending_class` + `serviceFee` 写入）；重复回调**幂等**（分账不变）；NOTPAY 按成功应答但不动账；wechat 模式下 `pay` 不静默成功。`ci:full` 26 → **27 步**，本机 27/27 全绿（441s）。⚠️ 仍缺：退款状态回写、15 分钟超时关单、渠道对账 |
| P37 超时未支付关单（A2 第 4 步） | ✅ | `PayProvider` 增加 `close(outTradeNo)`：mock 记录空操作；微信走 `POST /v3/pay/transactions/out-trade-no/{no}/close`，渠道返回 `ORDER_CLOSED`/`ORDERPAID`/`ORDER_NOT_EXIST` 视为**幂等成功**（否则定时任务会被一笔历史单反复卡住）。新增 `orders.closeExpiredUnpaid(minutes?)`：阈值取 `payment.pay_timeout_minutes`（无该规则组时默认 15 分钟；`Math.max(0.01, …)` 允许亚分钟阈值用于演练/门禁，但绝不允许 0 误杀新单）；逐单「渠道关单（失败只记日志、不阻断本地关单）→ 行锁内 `UPDATE ... WHERE status='awaiting_payment'`（按受影响行数计账）→ 预支付流水置 `closed` → 通知家长 → 审计 `order.close_expired`」。接入定时任务 `tick()`，并新增管理端手动触发 `POST /api/admin/orders/close-expired`（`@Roles("admin")`，`olderThanMinutes` 可覆盖阈值）。门禁 `check-pay-flow` 17 → **22 项**：家长调用 403、管理员执行后刚建的未支付单变 `cancelled`、二次调用 `closed=0`（幂等）；单测 119 → **122**（mock 记录关单、微信关单路径与 mchid、三类幂等错误码不抛错 + 其他错误照抛）。接口 143 → **144**；本机 `ci:full` **27/27 全绿（268s）**。累计门禁 599 → **604 项**。⚠️ 仍缺：退款渠道回写、渠道对账 |
| P38 退款走渠道并回写（A2 第 5 步） | ✅ | 新增 `orders.refundViaChannel(orderNo, refundCents, totalCents, reason)`：mock 返回合成结果（本地/自动化不联网）；真实通道用**固定退款单号 `RF+订单号`**（渠道对同一 `out_refund_no` 幂等 → 可安全重试），渠道异常统一 `REFUND_CHANNEL_ERROR`（细节只进日志）。`admin.refundReview` 重构为**先渠道后事务**（网络调用绝不包进 DB 事务）：渠道 `SUCCESS` 才把订单落 `refunded` 并写 `payments(type=refund, trade_no=渠道退款号, status=success)`；渠道返回**非 SUCCESS**（受理中）时只落一条 `pending` 退款流水 + 审计并**保持 `refunding`**，抛 `REFUND_PROCESSING` 供运维重试——绝不「假装退款成功」。门禁 `check-pay-flow` 22 → **27 项**：家长申请退款进入 `refunding`、家长审批被拒（403）、渠道不可用时审批失败且错误码为 `REFUND_CHANNEL_ERROR`、失败后订单仍 `refunding`、`refundAmount` 仍为 0。本机 `ci:full` **27/27 全绿（266s）**；累计门禁 604 → **609 项**。⚠️ 仍缺：退款结果异步回调（受理中的单靠人工重试收敛）、渠道对账（需真实商户号与公网回调） |
| P39 退款结果异步回调（A2 第 6 步） | ✅ | `PayProvider` 增加 `verifyRefundNotify(bodyText, headers)`：mock 解析形态；微信复用**同一套**验签（`WECHATPAY2-SHA256-RSA2048` + 时间戳防重放）与 `AEAD_AES_256_GCM` 解密，返回 `out_trade_no/out_refund_no/refund_id/refund_status/amount.refund`。新增 `POST /api/pay/wechat/refund-notify`（`@Public`，只靠验签；控制器抽出 `collect()` 统一取 rawBody 与 `wechatpay-*` 头部）。新增 `orders.settleRefundNotify`：`SUCCESS` → 行锁内把订单从 `refunding` 收敛为 `refunded`（幂等：已 `refunded` 直接返回）、**金额必须与 pending 退款流水一致**、有 pending 流水则改写它（避免二次出账）否则新增、担保出账 + 双方通知 + 审计；非 SUCCESS（`ABNORMAL`/`CLOSED`）→ 仅把 pending 流水置 `failed` 并通知家长人工跟进，订单保持 `refunding`。单测 122 → **125**（mock 解析/缺字段、微信验签+解密全链路、改包/未签名/异常状态、缺 resource 与非 JSON 明确报错）；门禁 `check-pay-flow` 27 → **32 项**（未签名退款回调被拒、SUCCESS 后订单转 `refunded` 且 `refundAmount` 等于实付、重复回调幂等）。接口 144 → **145**；本机 `ci:full` **27/27 全绿（269s）**；累计门禁 609 → **614 项**。⚠️ 仍缺：渠道对账（需真实商户号 + 对账单下载） |
| P40 渠道对账脚本骨架（A2 收尾） | ✅ 骨架 / 🟡 真实下载待商户号 | 新增 `tools/check-recon.mjs`（`npm run pay:recon`）：把渠道账单与 `payments` 流水逐笔比对，输出**四类差异**并给退出码（0 一致 / 1 有差异 / 2 下载未实现）——① 渠道有我方无（漏记）② 我方有渠道无（未到账/虚假）③ 金额不一致（分）④ 状态不一致。三种用法：`--self-test`（内置「4 类差异各 1 条」样本，必须全部命中，且**完全一致样本不得误报**，另校验 CSV 中文表头、元→分换算、退款类型识别；无需数据库与商户号，已进 `ci-full` 静态第 5 步）；`--bill <csv>`（按 `MYSQL_MODE=docker|host` 探测查我方流水，与账单逐笔比）；`--download`（**未实现**：需真实商户号 + APIv3 证书，明确退出码 2，不静默成功）。**防空检查**：账单 0 行或我方 0 行一律判失败。端到端实测（容器库）：灌种子 + 真实下单支付（订单 ¥200.00）→ 导出一致账单 → **差异 0、退出码 0**；再构造「改一行金额 + 删一行」账单 → **2 类差异、退出码 1**。`ci:full` 27 → **28 步**（静态 15），本机 28/28 全绿（257s）；累计门禁 614 → **621 项**。⚠️ 真实对账单下载仍需商户资质 |
| P41 混沌演练脚本（D6） | ✅ 本机实测 / 🟡 生产待预发复跑 | 新增 `tools/chaos-drill.mjs`（`npm run chaos:drill`）：分别停掉 MySQL / Redis，按「依赖语义」断言而不是一刀切报错——① **不崩溃**：app 容器 `RestartCount` 前后不变（无崩溃循环）；② **不挂死**：健康检查与业务探针都在 8s 超时内返回；③ **明确报异常**：`/api/health` 变 503；④ **依赖语义**：MySQL 挂时依赖库的业务读必须 **≥400**（不许返回空 200 假成功），Redis 挂时业务读 **仍应 200**（缓存不阻断主流程）；⑤ **真恢复**：重启依赖后 health 回 200 且管理员能登录。失败时脚本自动 `start` 两个依赖，避免把环境留在半停状态。本机容器栈实测 **21 项全绿**：MySQL 中断 → health 503（3.3s）、`/api/public/banners` 400（3.3s）、无重启；Redis 中断 → health 503（5.4s）、`/api/public/banners` 仍 200（7ms）、无重启；两者恢复后均 200 且可登录。过程中**修正一处自己的错误判据**：最初把所有探针都要求 ≥400，把 Redis 挂掉时「业务仍可用」这一**正确降级**误判为失败。未进 `ci-full`（演练会停服务，故意保持手动触发）。⚠️ 仍缺：担保台账不平、定时任务重入两类演练的脚本化；生产需在预发按同一脚本复跑 |
| P42 规则配置中心改为「表单化」编辑器（不再让运营看 JSON） | ✅ | `Rules.vue` 原先右侧是一个装 JSON 的 `textarea`，运营改规则等于手写代码（截图反馈）。本轮改为**按字段类型生成表单**：新增 `src/rule-meta.js`（字段中文名 + 金额/比例/倍数分类 + 真实小数位精度 + 保存前校验）、`components/RuleRowsTable.vue`（等级表/提成阶梯 → 可编辑表格：单元格内数字框/开关/「留空=不限制」，支持新增/删除/上移/下移）、`components/RuleValueEditor.vue`（递归渲染：数字→数字框、布尔→开关、文本→输入框、字符串数组→标签、角色数组→**勾选**而非手打角色名、对象数组→表格、嵌套对象→子表单）；原始 JSON 降级为「高级（只读）」折叠，默认收起。**修掉三处会改坏数据的真缺陷**：① `teacher_levels`/`parent_credit` 是**顶层数组**，旧组件只认对象 → 这些组直接退化成「请用 JSON 编辑」；② `el-input-number :min="0"` 会把 `credit_rules`(`-8/-12/-15`)、`growth_rules.violation`(`-50/-100/-200`) 的**负分吃掉**，改为只有金额字段限 0；③ `settlement.withdraw_fee_rate = 0.006` 若按固定 2 位小数显示/回写会被**悄悄改成 0.01**，改为按数值真实小数位计算精度；另 `deal_tiers.max = null`（无上限）不再退化成空字符串，而是显式「留空=不限制」。保存前校验（服务端无强 schema）：比例必须 0~1、金额非负、表格/标签不允许空、标签去重——错误以中文点名到字段。**浏览器实测**（容器 4300）：17 组规则全部渲染为表单、**0 组**落到「无法识别」兜底、页面无任何装 JSON 的 `textarea`；等级表 5 行表头「等级/名称/下限/上限/平台抽佣比例/派单权重」；权限组 4×5 勾选框；学段/科目 21 个标签；负分 −8/−12 正常显示且可编辑；实际改 `dispatch.push_batch` 5→7 点保存后**接口返回 7**（已还原），把提现手续费比例填 `1.5` 被拦下且库里仍是 `0.006`。⚠️ 未做：规则组的新增/删除（数据结构由代码约定）、字段级权限（整组权限沿用 `editable`） |
| P43 加急费改为家长自填数字（原来只能开开关、金额写死 ¥20） | ✅ | 现象：家长端发单页「加急需求」只有一个开关，旁边写死「加急费 ¥20.00」，家长无法自己加价。改为**可填数字**，并补齐护栏：规则 `urgent` 增加 `max_fee`（默认 20000 = ¥200），`fee` 语义定为"平台标准价 = 最低价"。后端 `demands.service.create/update` 新增 `urgentFeeOf()`：不传金额按标准价（**老行为零回归**，e2e 那条「加急费按规则配置计入 ¥2000」照旧通过）、低于最低价/高于上限**明确报中文错误**、不开加急时一律置 0；`/api/parent/home` 增加 `urgentMaxFee`/`urgentEnabled`；参考实现 `server/modules/market.js` 同步同一套逻辑。前端：`web/assets/js/parent.js` 的 `demandFormHtml` 在开关打开时才显示金额输入框（min/max 来自接口，默认标准价），`readDemandPayload` 做一次前端区间校验；`apps/web-mobile/src/pages/parent/publish/index.vue` 同样处理（开页读 `/parent/home` 拿区间、越界先 toast 拦住）。后台规则配置页自动出现「加急费标准（分）／加急费上限（分）」两个字段（P42 表单化的收益）。**老库迁移**：`db/seed-min.mjs` 用 `JSON_SET(... CAST(? AS SIGNED))` **只在缺键时补** `max_fee`（`ON DUPLICATE` 刻意不覆盖 value，避免冲掉运营改过的值）；踩坑记录：`compose run --rm seed` 默认复用旧 seed 镜像 → 补写语句没生效，必须 `--build`，已写进 `docs/DEPLOY-CONTAINERS.md`；不加 CAST 会写成 `20000.0`。**实测**：接口层 11 项全绿（自填 ¥50 落库、¥10 低于最低价 400、¥999 超上限 400、不填=¥20、不开加急=0、编辑改 ¥80、编辑越界 400、报名→确认后订单 `amount=20000 / urgentFee=8000 / 实付 ¥280`）；浏览器实测参考实现 `/parent` 开关打开才出现输入框（min 20 / max 200 / 默认 20.00）、uni-app `/m/` 显示「最低 ¥20.00，最高 ¥200.00」并成功提交 ¥45（库中 `urgent_fee=4500`）、越界 ¥500 未落库（无任何 `urgent_fee > 20000` 的记录）；后台规则页三字段带 ¥ 提示。⚠️ 未做：加急费高低不影响派单排序（仍是 `dispatch.urgent_boost` 统一加权），如要做「加价越高越靠前」需改 `rule-engine` 的排序公式并同步规则测试 |
| P44 加急费越高越靠前（派单优先级按金额插值） | ✅ | 需求：加急费既然由家长自填，就必须"加得多排得前"，否则加价没有意义。改法：`dispatch.urgent_boost` 语义定为**标准价时的系数**（默认 1.3），新增 `dispatch.urgent_boost_max` = **加急费到达 `urgent.max_fee` 时的系数**（默认 2.0），中间按 `(fee-min)/(cap-min)` 线性插值并上下收敛。实现：`RuleEngineService.urgentBoost()`（Nest）与 `server/core/rules.js` 的 `urgentBoostOf()`（参考实现）同一套公式；`dispatchPriority()` 新增可选入参 `urgentFee`，`demands.apply` / `nearbyForTeacher` 两处传 `d.urgent_fee`（家长看教员列表仍是 `urgent: false`，不受影响）。**向后兼容**：不传金额、金额为 0、老库缺 `urgent_boost_max`、上限系数 ≤ 基准系数，四种情况都回落到基准系数——改造前的行为逐字不变，`rules.test.js` 50 项与既有 e2e 断言零改动通过。老库补写：`seed-min.mjs` 的补键逻辑重构成 `ADDITIVE_RULE_KEYS` 表（urgent.max_fee + dispatch.urgent_boost_max），并改用 `JSON_SET(value, ?, JSON_EXTRACT(?, '$'))` —— 直接传数值会被驱动写成 `2.0`，`CAST AS SIGNED` 又会把 2.5 截断，用 JSON 字面量两种都保真。**实测**（容器真实接口，同一地址四条需求）：不加急 2.134 → 标准价 ¥20 = 2.7742（1.3×）→ 中间价 ¥110 = 3.5211（1.65×）→ 上限 ¥200 = 4.268（2×），严格递增且系数与公式一致；教员报名落库 `priority=4.268`。单测 125 → **128 用例**（`urgentBoost` 插值/收敛/三类回落 + 「同距离同等级加价越高优先级越高」序列断言），`e2e` 156 → **157**（同地址 ¥50 与 ¥200 的 `priority` 由接口断言大小）。**运维坑（已写进 `DEPLOY-CONTAINERS.md`）**：规则缓存 `dispatch`/`urgent` 有 5 分钟 TTL，若在应用启动后才 `seed`，新字段进不了缓存 → 表现是"改完没反应"。本轮就踩了：重启应用后仍读到旧缓存（`docker restart` 也复用了启动时快照），把规则在后台原样保存一次（或等 5 分钟）才生效——验证时务必先刷新缓存再断言。⚠️ 未做：`applications.priority` 的历史值不回溯重算（报名当时快照，符合"当时排序"语义） |
| P45 报名优先级改为「读时计算」（用户确认后的行为变更） | ✅ | 背景：P44 把加急费接进排序后，`applications.priority` 仍是**报名当时的快照**——运营一改规则、或家长改了加急费，家长在需求详情里看到的报名排序还是旧的，与教员端"附近需求"的实时排序不一致。用户确认改为读时计算。实现：Nest `demands.detail()` 抽出 `applyLivePriority()`——一次批量查申报名下教员的 `level`/`response_factor`（`IN (...)` 单条 SQL，不做 N+1），逐条用**当前** `teacher_levels` 权重、响应系数、需求此刻的 `urgent`/`urgent_fee` 重算 `priority`；同时保留 `prioritySnapshot` 原值便于对账「当时为什么排这个位置」；教员资料缺失时回落快照，不让脏数据打挂列表；排序仍是「已确认优先，其余按实时优先级降序」。参考实现 `server/modules/market.js` 的详情接口同步同语义。写入侧不变（报名时仍写一条快照，作为审计痕迹与回落值）。**实测**：`e2e` 新增 2 条断言——家长先把加急费 ¥20 的需求报满（快照 1.3×），再把需求改成 ¥200，详情里 `prioritySnapshot` 保持原值、`priority` 立刻变大（¥200 → 2×）；`e2e 157 → **159**`，容器 `e2e 159/159 全绿`。⚠️ 边界：家长端「我的需求」列表不返回报名明细，无影响；`applications.priority` 作为列仍保留（不删列，避免破坏历史数据与外部对账脚本） |
| P46 入驻认证：身份证正反面上传 + 证件识别 + 姓名校验（需求 4.2 资质核验） | ✅ 通道完成、待腾讯云密钥 | 背景：入驻页把学历/教师资格/技能证书都当成「粘贴 URL 的文本框」，身份证则只填号码——既没法上传图片，也没法核对「证件上的人」是不是本人。本轮改造：① **表结构** `teacher_profiles` 增 `id_card_front_url` / `id_card_back_url` / `id_card_name` / `id_card_verified`（SQLite 走 `ensureColumn` 自动补列，MySQL 走 schema + seed 的幂等补列）；② **上传**：新增 `POST /api/upload`（base64→落盘，**只收 PNG/JPG/WEBP、单张 ≤2MB**，文件名服务端随机生成、扩展名由 MIME 决定；读取时只允许 `/uploads/<单层文件名>`，拒绝 `..`/多层路径）；图片由 `/uploads/` 静态托管（compose 加命名卷 `app-uploads`，重建镜像不丢证件图）；**刻意不用 multer**——依赖审计里那 2 个 high 的「不可达」结论依赖「全仓无文件上传中间件」，引入 `FileInterceptor` 会推翻它；③ **识别**：`src/integrations/ocr/` 端口化（`OCR_PROVIDER=mock|tencent`），腾讯云 IDCardOCR 用 TC3 签名（纯函数）+ 响应归一化，配 tencent 缺密钥**拒绝启动**；mock 从原始文件名「姓名_18位身份证号.png」解析（只在内存映射里传，**原始文件名不进 URL**，避免把姓名与身份证号写进静态路径）；④ **校验**：`teacher.apply` 传了人像面就必须识别成功，且**姓名（归一化后）与身份证号都要与填写的一致**，否则 400 `ID_CARD_MISMATCH` / `ID_CARD_UNRECOGNIZED`，通过才写 `id_card_verified=1` 与识别姓名；新增 `POST /api/teacher/ocr-idcard` 供页面在上传后即时反馈（回显姓名 + 脱敏号码）；⑤ **界面**：入驻页 4 类证书 + 身份证正反面统一换成「上传按钮 → 缩略图 → 点击看大图 → 可删除」，人像面传完立即显示「识别到：张三 · 330106********1234（与填写一致）」或红字提示不一致；「我的资质」页与后台审核页都能看证件缩略图并显示「系统已核：人证一致」。**实测**：新增门禁 `tools/check-teacher-idcard.mjs` **20 项全绿**（非图片/超 2MB/未登录被拒、图片可访问且字节一致、目录穿越被拒、识别姓名与脱敏号码正确、姓名不一致与号码不一致均被拒、识别不出不放过、一致时通过并落库 `idCardVerified=true`、审核列表带出证件图）；单测 128 → **151 用例 / 22 模块 / 99.47%**（OCR 签名与响应解析、mock 解析、脱敏与姓名归一化、一致性判定、通道选择与异常折叠、上传校验与目录穿越）；`ci:full` 28 → **29 步**，接口 145 → **147 路由 / 18 控制器**。⚠️ 未做：真实 OCR 需 `TENCENT_SECRET_ID/KEY` 并开通 IDCardOCR（mock 走文件名解析，仅供联调与自动化）；身份证**背面**不解析有效期/签发机关；uni-app 移动端仍无入驻页（历史缺口，PC/参考实现侧已具备），如需补齐另开一步 |
| P47 移动端补「入驻认证」页（补齐 P46 的移动端缺口） | ✅ | 背景：P46 把身份证正反面上传与证件识别做在 PC/参考实现侧，uni-app 移动端**没有入驻页**——教员在手机上无法提交认证，只能等审核员线下要材料。本轮新增 `pages/teacher/apply/index`：身份类型、真实姓名/身份证号（不回显）、**身份证正反面上传（缩略图 + 点击全屏预览 + 删除）**、学历/教师资格/技能证上传（可留空）、自我介绍、擅长科目/学段（字典来自 `/api/meta/dictionary`，与运营字典联动）、课时单价、服务半径、按行编写的授课时间表（解析成 `[{day,start,end}]`）、覆盖区域；上传人像面后立刻调 `/api/teacher/ocr-idcard` 回显「识别到：姓名 · 脱敏号码（与填写一致）」，不一致时红字提示并挡住提交；提交走 `/api/teacher/apply`，服务端仍做姓名/号码一致性硬校验。**跨端取图**：H5 用 `FileReader`（`uni.chooseImage` 给的是 File），小程序没有 FileReader，用 `uni.getFileSystemManager().readFileSync(path,'base64')` 再按扩展名补 MIME——两端都走同一个 `/api/upload`（base64），没有新增上传通道。教员端首页加入口卡片，按 `auditStatus` 显示「去认证 / 审核中 / 待重新提交 / 已通过」四态与对应提示。**门禁**：`check-mobile-spa` 41 → **44 项**（小程序 `app.json` 页面清单含入驻页、`pages/teacher/apply/index.wxml` 产物存在、`/m/pages/teacher/apply/index` 路由可直达并回落 index.html、`/teacher/profile` 契约），`ui:check` 移动端 10 → **11 页**；单测 152 不变（该页无纯函数可测，行为由移动端门禁 + 证件门禁覆盖）。⚠️ mock 识别按文件名解析，手机拍照得到的文件名（如 `image.jpg`）识别不出 → 本地联调请用文件名形如「姓名_身份证号.png」的图片；生产切 `OCR_PROVIDER=tencent` 后与文件名无关 |
| P48 区域管理「中国地图化」+ 图上画电子围栏 + 教员按定位接单（需求 4.5.5 / 4.2.2） | ✅ | 背景：区域管理页原来只有一个「电子围栏（可选，JSON 顶点数组）」文本框加四个数字框——运营没法在地图上画片区，「自定义区域管理」实际不可用；教员端取附近需求用的是入驻时填的服务基点，人走到别处就接不到单。本轮三件事：① **底图随包分发**：`apps/web-admin/src/assets/china.geo.json`（34 个省级行政区 / 16173 个坐标点 / 234KB），取自 ECharts 4.9.0 `map/json/china.json`（Apache-2.0）——ECharts 的坐标是**压缩编码**（坐标是字符串 + `encodeOffsets`），用 `tools/build-china-geo.mjs` 的 `decodeRing`（`charCodeAt-64` → 折半编码还原 → 逐点累加 → `/1024`）解码成标准 GeoJSON，再按 3 位小数（≈110m）精简；**不引第三方地图库、不请求在线瓦片**——容器与门禁常在无外网环境跑，瓦片挂掉就整页空白。② **在地图上画围栏**：新增 `apps/web-admin/src/components/GeoFenceMap.vue`（canvas 画省级底图 + `ResizeObserver` 自适应 + 滚轮以鼠标为锚点缩放 + 拖拽平移 + 逐点落点/双击闭合/顶点拖动微调 + 橡皮筋 + 圆形围栏 + 比例尺 + 已有片区灰色叠加 + 省名与坐标读数）；几何全在 `apps/web-admin/src/geo-fence.js` 纯函数里：`project`/`unproject` 用**等距圆柱并横向压 cos(视图中心纬度)**（不压的话北纬 30° 画出来的围栏会被横向拉长约 15%，看起来是斜的）、`zoomAt` 两轮迭代消锚点漂移、`fitView`、`radiusToPixels`、`pointInPolygon`（与后端 `apps/api-nest/src/common/geo.ts` 同一射线法）；`Regions.vue` 重写为「左侧表单 + 右侧地图 + 列表点行载入」，围栏顶点数/中心点/等效半径随绘制实时回填，提交时 `body.polygon` 带上顶点数组。③ **定位接单**：`demands.service.ts` 抽 `originOf(tp, at)`（`current` 实时定位 / `profile` 入驻基点 / `default` 杭州兜底），`nearbyForTeacher(teacherId, at?)` 与 `apply(teacherId, demandId, at?)` 都按传入位置算距离并做服务半径过滤，响应多回 `origin{lat,lng,source}` 与 `radiusKm`（页面据此显示「按当前位置」还是「按入驻服务基点」）；参考实现 `server/modules/market.js` 同语义（nearby 读 `?lat=&lng=`、apply 读 body）；移动端教员首页开页取 `uni.getLocation`（gcj02），附近需求带 `?lat&lng`、抢单带 body 位置，另有「重新定位」按钮与状态文案，定位失败自动退回服务基点。**门禁**：新增 `tools/check-geo-fence.mjs` **32 项**（投影互逆、高纬收紧、锚点缩放不漂移、点内判定与后端 200 采样点逐点一致、中心/等效半径/距离、`fitView` 不越界且用足留白、多边形规范化、底图 34 要素与坐标范围、页面接入且「不再出现 JSON 文本框」）；`check-admin-spa` 38 → **42 项**（分包内置底图且无在线瓦片 + 地图上画的多边形写入后回读顶点数一致）；`check-mobile-spa` 44 → **47 项**（按实时定位取附近需求、定位缺失回落服务基点、小程序教员首页定位入口）；`test/e2e.test.js` §3 增 4 条，`e2e 159 → **163**`；`ci:full` 29 → **30 步**（静态 15 → 16）。**实测**：容器重建后在浏览器里驱动真实交互——地图上点 4 个顶点 → 双击闭合 → 中心点自动回填 (40.542679, 102.570474) → 保存提示「片区已创建：地图绘制验收片区（R379031），多边形围栏 4 点」→ 列表新增一行；canvas 像素采样确认北京/广州/哈尔滨落在陆地上、东海为海面背景色（投影与底图对得上）；`e2e` 163/163、后台 42/42、移动端 47/47 全绿。⚠️ 说明：后台 SPA 在 PI 预览面板里只有 65px 视口宽，宽屏视觉验收请用桌面浏览器打开 `/admin-vue/#/regions`；围栏**自交不校验**（后端射线法容忍），面积不参与判定，`polygon` 为空即按圆判定 |
| P51 代理管理补「新增代理」与「删除代理」（需求 4.5.2 / 5.3） | ✅ | 背景：代理管理页只有「详情 / 调分成 / 禁用」，**开不了新账号、也删不掉错开的账号**——区域代理只能靠 seed 里那两个演示账号，运营要开一个区就得改库。本轮补齐：① **新增**：页面右上「新增代理」弹窗（姓名 / 手机号 / 片区（下拉取 `/api/admin/regions`，含刚按行政区建的片区）/ 等级 / 服务费分成 % / 管理提成 % / 首笔保证金），提交走已有的 `POST /api/admin/agents`：服务端一次性随机口令 + `must_change_password=1`（改密前不能用），比例默认取规则 `agent_commission`，落 `users`+`agent_profiles`+`wallets` 一个事务；前端用弹窗把一次性口令大字展示出来（只显示这一次）。② **删除**：新增 `DELETE /api/admin/agents/:id`，**带业务护栏**——名下有订单分成、已绑定家长/业务员、下属有业务员、保证金余额未退、钱包余额未提现，任一命中就拒绝并**逐条中文说明**（「该代理还有业务数据（名下有 3 笔订单分成；保证金余额 500.00 元未退），请改用『禁用』而不是删除」），因为硬删会让历史订单/分账/对账失去对手方；确实空白的账号在一个事务里清掉 bindings/agent_deposits/wallets/agent_profiles/users 并写审计 `admin.agent.delete`。参考实现 `server/modules/admin.js` 同步同一套语义（`router.del`）。**门禁**：`check-admin-spa` 47 → **51 项**（新增返回一次性口令、列表可见、有业务数据的 400 + `AGENT_HAS_DATA`、空白账号删掉后列表不再有）；`e2e` 166 → **169**（同一组断言在 Nest 与参考实现各跑一遍，参考实现 173/173）；接口 148 → **149 路由**；`ci:full` 30 步全绿。**实测**：容器内浏览器点「新增代理」→ 填「验收代理·孙经理 / 13900007801 / 杭州·西湖片区」→ 创建后弹窗显示一次性口令 → 列表出现第 3 行；点该行「删除」→ 确认 → 列表回到 2 行；对「西湖代理·李经理」点删除 → 弹出「该代理还有业务数据（… 笔订单分成；保证金余额…），请改用『禁用』」 |
| P52 用户管理补「删除家长/教员」账号（需求 4.5.2 账号管理） | ✅ | 背景：用户管理页只有「禁用/启用」，**删不掉错开的账号**（手机号填错、测试号、重复注册）。本轮加 `DELETE /api/admin/users/:id` 与页面「删除」按钮，沿用代理删除那套**业务护栏**：① **只允许家长/教员**——管理员账号直接 403；代理/业务员返回 `USE_DEDICATED_PAGE` 引导到各自页面；② **逐条拦业务痕迹**——家长看「发过 N 条需求 / N 笔订单 / N 条评价 / 钱包余额未提现 / N 条资金流水 / 已有 N 条片区归属绑定」，教员看「N 条报名记录 / N 笔订单 / N 笔提现记录 / 收到 N 条评价」+ 钱包余额与资金流水；任一命中即 400 `USER_HAS_DATA`，中文列出原因并提示改用「禁用」；③ **空白账号**在一个事务里清掉个人资料与痕迹：`addresses`/`favorites`/`user_coupons`/`messages`/`bindings`/`wallets`/`wallet_txns`/`credit_logs`/`parent_profiles`/`teacher_profiles`/`teacher_services`/`growth_logs`/`level_logs` 再删 `users`（限定 `role IN ('parent','teacher')`），并写审计 `admin.user.delete`（记昵称、脱敏手机号、角色）。参考实现 `server/modules/admin.js` 同步（`router.del`）。**门禁**：`check-admin-spa` 51 → **54 项**（有业务数据的家长 400 + `USER_HAS_DATA`、代理账号引导到代理管理、新注册空白家长删掉后按手机号搜不到）；`e2e` 169 → **171**（Nest 与参考实现各跑一遍，参考实现 175/175）；接口 149 → **150 路由**；`ci:full` 30 步全绿。**实测**：容器内浏览器对有需求/订单的家长点删除 → 弹「无法删除：该账号还有业务数据（发过 N 条需求；有 N 笔订单…），请改用『禁用』而不是删除」；对空白账号删除 → 「已删除账号」，列表即刻消失 |
| P53 用户删除改为「软删除（打标记 + 匿名化）」并放开业务员（需求 4.5.2 / 第 8 章注销口径） | ✅ | 背景：P52 的删除是「没有业务痕迹才能删」，实测几乎所有真实账号都删不掉（发过需求、有归属绑定就算），运营只能禁用；同时业务员账号不在用户管理里删。本轮按「注销」的合规口径改成软删除：① **`users.deleted_at`** 新列（MySQL schema + 启动幂等补列 `ensureSchemaColumns`；SQLite 参考实现走 `ensureColumn`），用户列表默认 `deleted_at IS NULL`，`?includeDeleted=1` 才能查到；② **删除语义**：家长/教员/**业务员**都能删——完全空白的账号**物理删除**（连个人资料一起清，不留垃圾行）；有历史数据的账号走**软删除**——`status=disabled` + `deleted_at` + 匿名化（手机号/昵称→「已删除用户#id」/头像/实名/身份证/证件正反面图/求职介绍/口令/设备指纹/注册 IP 全清，`teacher_profiles` 下线、`teacher_services` 停售、未完结需求置 `revoked`、`sales_profiles` 置 disabled、删地址/收藏/消息/优惠券），**订单、资金流水、评价、提现台账原样保留**用于对账与合规追溯；③ **护栏**：有未完结订单（`awaiting_payment/pending_class/in_class/awaiting_parent_confirm/refunding`）或冻结待结算金额时拒绝（这两类删了会有人吃亏）；管理员 403；代理返回 `USE_DEDICATED_PAGE` 引导到代理管理（那里有保证金与分成台账）；④ **界面**：删除后按返回的 `mode` 分别提示——软删除弹窗列出「保留的业务台账：N 条需求、N 条归属绑定…」，硬删除直接 toast；⑤ **参考实现**同步（注意它没有 `token_version`，靠每次请求回查 `status` 让旧令牌失效）。**门禁**：`check-admin-spa` 54 → **57 项**（有历史数据的账号 `mode=soft` 且默认不列出、`includeDeleted=1` 仍可查、业务员可删、代理引导、管理员 403、空白账号 `mode=hard`）；`e2e` 171 → **173**（Nest 与参考实现各跑一遍，参考实现 177/177）；`ci:full` 30 步全绿。**实测**：浏览器删「周女士」→ 弹「已软删除：保留的业务台账：1 条需求、1 条归属绑定…历史订单/资金流水仍可对账，但已无法登录」，列表里消失；删空白账号 → 硬删除 toast |
| P54 代理删除也改「软删除（打标记 + 匿名化）」（与 P53 同一口径） | ✅ | 背景：P51 的代理删除是「有业务数据就拒绝、只能禁用」，和刚改好的用户删除不一致——运营删代理还是删不掉，且代理有保证金台账，更要保留痕迹。本轮统一：① **拒绝条件收敛到「钱和单」**——保证金余额、钱包余额、冻结待结算未结清（`AGENT_MONEY_LEFT`，逐个金额列出，提示先退还/提现/等结算），或有未完结订单（`HAS_ACTIVE_ORDER`）；② **完全空白**的代理（无订单分成/归属绑定/下属业务员/保证金台账）→ 物理删除；③ **有历史痕迹** → 软删除：`users.deleted_at` + `status=disabled` + 匿名化（手机号/昵称→「已删除代理#id」/头像/实名/身份证/口令/设备指纹/注册 IP 清空），`agent_profiles.status='disabled'`（分成比例与台账字段保留，保证金/分成仍可对账），订单分成、归属绑定、下属业务员、保证金台账**全部保留**；④ **界面**按 `mode` 分别提示（软删除弹窗列出保留台账），参考实现同步。**顺手修掉一个真 bug**：P51 在参考实现里插入 `router.del("/api/admin/agents/:id")` 时把 `GET /api/admin/agents/:id`（代理详情）吞掉了、还留了一个重复的旧 del 分支——导致参考实现「代理详情」404（e2e §16 直接崩），本轮从 git HEAD 取回详情路由并删掉重复分支，路由现为 list/create/delete/detail/update/toggle/deposit 七条无重复。**门禁**：`check-admin-spa` 57 → **58 项**（保证金未结清 400 + `AGENT_MONEY_LEFT`、有归属绑定的代理 `mode=soft`、空白代理 `mode=hard`）；`e2e` **173**（Nest 与参考实现各跑一遍，参考实现 177/177，断言改成「自建代理 + 动态手机号」，不再依赖 seed 里代理的资金状态）。**实测**：参考实现上另跑了一个脚本验证软删除——新建代理（保证金 0）→ 用初始口令登录 → 加 1 名下属业务员 → 删除返回 `{mode:"soft", kept:["1 名下属业务员"]}` |
| P55 家长端改为「游客优先浏览」+ 登录层加微信一键登录（需求 4.1.1 / 4.1.2） | ✅ 通道完成、待微信 appid | 背景：用户给了家长端截图（发布家教需求页）并要求「家长端显示这个界面，点发布需求或立即预约的时候再弹登录，登录界面再加一个微信一键登录」——原实现不登录就整屏挡住弹登录，游客看不到发布表单。本轮分两层改：① **后端补公开浏览接口**（无需登录）：`GET /api/public/home`（片区/轮播/公告/附近在线教员/加急费区间/合规提示，**不含**地址/优惠券/订单/未读/信用等「我的」数据，字段与 `/api/parent/home` 同构，前端一份渲染逻辑通吃游客与登录态）、`GET /api/public/teachers`、`GET /api/public/teachers/:id`（收藏状态恒 `false`、手机号仍脱敏）；`nearbyTeachers`/`coords` 改为 `ctx.user?.id ?? 0` 容忍游客（顺手修掉游客访问时 `Cannot read properties of null (reading 'id')` 的 500）。② **微信一键登录**：新增端口 `src/integrations/wechat/wechat.service.ts`——配了 `WECHAT_APPID` + `WECHAT_SECRET` 走 `sns/jscode2session`（小程序），`WECHAT_OAUTH=1` 切 `sns/oauth2/access_token`（公众号网页授权）；两者都没配 → **mock**（`openid = mock_wx_ + sha1(code)`，同 code 稳定映射同一账号，便于门禁断言幂等）；**只配一半 → 拒绝启动**；`POST /api/auth/wechat` 首次登录自动注册家长（`parent_profiles` + `wallets` + 邀请绑定 + 与验证码注册同一套设备/IP 反作弊阈值），返回与短信登录一致的 `{token,user}` 另加 `wechatChannel`；`main.ts` 启动自检打印「微信登录=mock/wechat」。③ **前端**：参考实现 `web/assets/js/parent.js` 的 `guard()` 支持 `guest: true`（首页/广场/教员详情/协议游客直达），`boot()` 不再一进来就 `showLogin()`；新增 `isGuest()`/`apiBase()`/`requireLogin(pending)`——点「发布需求」时先把 payload 记进 `state.pending` 再弹登录层，登录成功后 `startApp()` 自动把需求发出去（不丢表单）；「立即预约」「收藏」「我的订单」「消息」同样走 `requireLogin`；登录层顶部加「‹ 先随便看看」关闭按钮，`微信一键登录` 升为主按钮（绿色 + 分隔线）。uni-app 侧新增 `src/auth.js`（`isLogin`/`goLogin(next)`/`request`/`saveDraft`/`takeDraft`），`pages.json` 首页改为家长端，登录页加「💬 微信一键登录」（小程序 `uni.login` 取 code、H5 用一次性随机 code 走演示通道）与 `?next=` 回跳，发布页「提交时未登录 → 存草稿 → 登录 → 回来自动发布」，家长首页游客态隐藏订单区并提示「登录后可查看订单与消息」。**门禁**：`check-mobile-spa` 47 → **65 项**（H5 产物含「微信一键登录」/公开首页/草稿键、游客首页与教员详情、`/parent/orders` 仍 401、微信 code 幂等与后续发布闭环）；`e2e` 173 → **189**（参考实现 §21 新增 16 项：游客接口 + 微信幂等 + 家长端前端契约；Nest 侧仍跑 §1–§20 = 173）；接口 150 → **154 路由**；`ci:full` 30 步全绿。⚠️ 真实微信登录需在 `deploy/.env.example` 填 `WECHAT_APPID`/`WECHAT_SECRET` 并把小程序 appid 与后台对齐，mock 只用于联调 |
| P56 微信登录通道收口：昵称/头像 + 公众号授权链接（补齐 P55 的 ⚠️） | ✅ 通道完成、待微信 appid | 背景：P55 的微信登录只把 code 换成 openid，账号昵称是随机「微信用户1234」，且公众号网页授权没有入口——真实上线时用户会看到随机昵称、H5 也没法走微信授权。本轮收口：① **昵称稳定**——mock 通道按 `openid` 的 sha1 给出固定的 4 位尾号（同一 code 永远同一个昵称，门禁可断言「二次登录昵称不变」），参考实现同规则（按 openid 字符哈希）；② **公众号渠道拉资料**——`sns/oauth2/access_token` 拿到 `access_token` 后调 `sns/userinfo` 取 `nickname`/`headimgurl`（头像统一改 132 尺寸、只存 URL），`unionid` 一并落库以便跨端打通；`WECHAT_USERINFO=0` 可关掉这次额外调用；**取资料失败不影响登录**（catch 后当没有资料）；③ **授权链接接口** `GET /api/auth/wechat/authorize-url?redirect=&state=`（公开）：返回 `https://open.weixin.qq.com/connect/oauth2/authorize?...&scope=snsapi_userinfo#wechat_redirect`；未配 appid 或没开 `WECHAT_OAUTH=1` → **400 `WECHAT_NOT_CONFIGURED`**（前端据此回落演示 code 通道）；`redirect_uri` 必须命中 `WECHAT_OAUTH_REDIRECT_ALLOWLIST`（origin 精确比对，子域不放行）否则 400 `WECHAT_REDIRECT_NOT_ALLOWED`——避免这个接口变成开放重定向；④ 参考实现同步返回同一错误码 `WECHAT_NOT_CONFIGURED`（它没有 appid）。**门禁**：新增 `apps/api-nest/test/unit/wechat.test.mjs` **20 用例**（通道选择/只配一半拒绝启动/单例缓存/mock 稳定性/授权 URL 形态与 `#wechat_redirect`/白名单放行与拒绝/真实通道用假 fetch 覆盖 jscode2session、oauth2+userinfo、`WECHAT_USERINFO=0`、userinfo 抛错、错误码），`wechat.service.js` 行覆盖率 **100%**，单测 152 → **172 用例 / 22 → 23 模块**；`check-mobile-spa` 65 → **68 项**（昵称稳定、二次登录昵称不变、未配置时授权接口 400 `WECHAT_NOT_CONFIGURED`）；`e2e` 189 → **197**（参考实现同三项断言）；接口 154 → **155 路由**；`ci:full` 30 步全绿。⑤ **排版按用户反馈调整**（同批）：登录层里「💬 微信一键登录」从最上面移到「登录 / 注册」**下方**，中间加「或」分隔线（先用手机号、或直接微信），uni-app 登录页同样改为「手机号 + 口令 → 登录 / 注册 → 或 → 微信一键登录」；两侧各加一条**顺序断言**（`data-lg="login"` 出现在 `data-lg="wechat"` 之前 / `<template>` 里「登录 / 注册」出现在「微信一键登录」之前），免得以后又被挪回去；`check-mobile-spa` 68 → **70 项**、`e2e` 197 → **198**。⚠️ 真正跳微信授权页还需要：公众号后台配置「网页授权域名」= `WECHAT_OAUTH_REDIRECT_ALLOWLIST` 里的域名、H5 端等 appid 到位后接 `authorize-url` 的跳转与回跳页（本轮只做服务端契约与安全边界，前端仍是演示 code 通道） |
| P57 家长头像可上传图片、图片在头像框内自适应（需求 4.1.1 个人资料） | ✅ | 背景：家长端「我的」里头像只能用昵称首字，用户要求「家长头像可以添加图片，图片在头像框内自适应显示」。本轮：① **接口**（两侧同口径）：`PUT /api/parent/avatar` body `{avatar}`——只接受本站 `/uploads/xxx` 相对地址（正则拦外链与路径穿越，400「头像地址不合法」），传 `null`/空串恢复首字母头像；返回 `{user, hasAvatar}`；配合已有 `POST /api/upload`（base64、仅 PNG/JPG/WEBP、≤2MB）使用。② **参考实现家长端**：新增 `pickImageFile()`（`<input type=file>` + canvas **等比缩到 ≤512px** 再转 JPEG 0.9——手机原图 4–8MB 会撞 2MB 上限，头头像框最大才 68px，传原图纯属浪费）与 `changeAvatar()`（上传 → `PUT /avatar` → 同步 `session.user.avatar` → 重渲染当前页）；「我的」与「个人资料」两处头像都包成 `avatarPickHtml()`：可点击 + 右下角 📷 角标 + 文案「点击头像上传/可更换」。③ **自适应显示**：`.avatar img { width:100%; height:100%; object-fit: cover; object-position: center 30%; display:block }`——任意长宽比的图都等比铺满头像框（不拉伸、不留白边，略微偏上取景对证件照/自拍更友好）。④ **uni-app**：家长首页顶部加头像 + 📷 角标，`uni.chooseImage({sizeType:['compressed']})` → H5 FileReader / 小程序 `getFileSystemManager().readFileSync(base64)` → `POST /upload` → `PUT /parent/avatar`，成功后同步本地缓存用户；游客点头像先跳登录。自适应用**背景图**（`:style` 里 `backgroundImage: url(...)` + `background-size: cover; background-position: center`）而不是 `<image>`——实测这一版 uni-app 的 H5 端 `<image :src>` 没把动态 src 落到 DOM（渲染成空 `uni-image`，页面只剩占位底色），换背景图后 H5 与小程序都稳。**门禁**：`check-mobile-spa` 70 → **77 项**（上传 → 设为头像 → `/parent/profile` 与 `/auth/me` 回读、外链 400、null 复位、H5 产物含 `/parent/avatar`）；`e2e` 198 → **203**（参考实现同五项）；接口 155 → **156 路由**；`ci:full` 30 步全绿。⚠️ `uni.chooseImage` 无法在 PI 浏览器面板内驱动（已知限制），移动端的真实选图只在接口级与产物级验证，图片渲染用 URL 直连核对 |
| P58 教员端「资质材料」按身份分证书 + 版块上移到保存按钮之上 + 证件图框内自适应（需求 4.2 入驻核验） | ✅ | 背景：用户给了「资料修改」页截图并提了三条：① 资质材料版块要放到「保存资料」按钮**上面**；② 上传后的资料图片要在框内**自适应显示**；③ 注册（入驻认证）按身份类型只要**该身份那一张**证书——老师=身份证正反 + 教师资格证、学生=身份证正反 + 学生证、社会=身份证正反 + 技能证书（原来 5 个位置全量展示：身份证正反 + 学历 + 教师资格 + 技能，不同身份的人看着一堆与自己无关的框）。本轮：**参考实现** `web/assets/js/teacher.js`——① `applyView`（入驻认证）把身份证正反 + 证书从「基本资料」里拆出来，新增「资质材料」区块放到「提交入驻申请」按钮正上方；三张证书记录用 `data-cert="in_service|student|part_time"` 包起来，`syncCertBlocks()` 按当前身份只保留一张（身份证正反始终显示），切换身份按钮即时切换；证书标签随之语义化：在职教师→教师资格证（`teacherCertUrl`）、在校大学生→**学生证**（`eduCertUrl`）、社会兼职→技能证书（`skillCertUrl`）。② `profileView`（资料修改）把「资质材料」卡整体搬进表单、排在「保存资料」按钮上面，缩略图按身份类型过滤（身份证正反 + 本身份证书），并标注「当前身份类型：…」。③ 图片自适应沿用 `.uploader .thumb img { object-fit: cover }`（等比铺满、居中裁切，不拉伸不留白边）。**uni-app** `pages/teacher/apply/index.vue`——① 新增独立「资质材料」卡放在提交按钮上面，`certSlot` computed 按身份给一项、`certHint` 提示「当前身份 X 需要上传 Y」；② 缩略图从 `<image mode="aspectFill">` 改成 `<view :style="backgroundImage:url(...)">`（`background-size: cover; background-position: center`）——这一版 uni-app 的 H5 端 `<image :src>` 不会把动态 src 落到 DOM（上一轮家长头像已踩过同一个坑），换背景图后 H5 与小程序都能正常显示且自适应。**门禁**：`check-mobile-spa` 77 → **80 项**（H5 产物含三种证书文案 + 资质材料 + 背景图渲染）；`e2e` 203 → **208**（参考实现：身份分区标记齐全、三种证书各自对应、入驻认证与资料修改两页的资质材料都排在按钮之前、缩略图 CSS 为 `object-fit: cover`）；接口不变（156 路由）；`ci:full` 30 步全绿。⚠️ 与上轮同样的限制：`uni.chooseImage` 无法在 PI 浏览器面板里驱动，移动端「点选图片」只在接口/产物级验证；图片在框内的自适应用真实上传的 URL 直连渲染核对 |
| P59 教员端登录加「用户名 + 密码」登录方式（需求 4.2） | ✅ | 背景：用户要求「教员端登录界面再添加一个用户名和密码登录方式」——原来教员端只有「手机号 + 验证码」，外加一个写死 `a123456` 的演示密码按钮，教员没有可记的账号口令。本轮：① **数据**：`users.username` 新列（MySQL schema `VARCHAR(64) UNIQUE`、SQLite `TEXT UNIQUE`，两侧启动幂等补列 `ensureSchemaColumns` / `ensureColumn`），小写存储；种子给 12 个演示教员配用户名（`zhang`/`li`/`wangxue`/…，老库只在为空时回填，不覆盖已改过的）。② **接口**：新增 `POST /api/auth/login-account`（公开）——`account` 既可以是**用户名**也可以是**手机号**（`/^1\d{10}$/` 判定），与手机号口令登录共用同一套失败锁定（`risk.login_fail_limit`/`lock_minutes`）与 `token_version`；错误统一 **`BAD_CREDENTIALS`**「用户名或密码错误」（不区分账号不存在/口令错，防账号枚举），两侧同口径（Nest 顺手把 `login-password` 的失败码也统一成 `BAD_CREDENTIALS`）。③ **教员端界面**（参考实现 `web/assets/js/teacher.js`）：登录层顶部加「手机号验证码 / 用户名密码」分段切换（`data-lg="mode-code|mode-account"`），账号密码页是「用户名（可填手机号）+ 密码」两个输入框 + 登录按钮，切换时不丢已输入的用户名/密码并自动聚焦；演示提示改为「演示账号 13900000201 或用户名 zhang（口令 a123456）」；忘记密码文案指向片区代理重置。④ **移动端**：登录页账号框改为「手机号 / 用户名」，登录改走 `/auth/login-account`（对家长/业务员传手机号行为不变）。**门禁**：`check-mobile-spa` 80 → **87 项**（zhang 登录成功、大小写不敏感、手机号兼容、错误口令 400 `BAD_CREDENTIALS`、空账号 400、token 可用、H5 产物含账号密码登录）；`e2e` 208 → **216**（参考实现同六项 + 教员端登录界面与 api 层契约）；接口 156 → **157 路由**；`ci:full` 30 步全绿。⚠️ 目前用户名只能由种子/后续后台功能分配，**没有「教员自助设置用户名」入口**（避免与手机号唯一性、改名审核冲突），需要的话下一步加「资料修改 → 账号用户名」 |
| P60 家长取消订单 → 教员端「退款 / 驳回」（取消改申请制，需求 4.1.5 / 5.1） | ✅ | 背景：原来家长点取消就**立刻退款**（免费取消窗口内全退、否则扣 20% 违约金），教员完全不知情也没机会表达「我已经备好课、按约定能上门」；用户要求「家长取消订单，教员端添加退款和驳回功能」。本轮把取消改成**申请制**：① **数据**：`orders.cancel_requested_at` / `cancel_rejected_at` / `cancel_reject_reason` 三列（MySQL schema + 两侧启动幂等补列 `ensureSchemaColumns` / `ensureColumn`）——用「标记位」而不是新状态，免得把 8 处状态机与既有门禁全部改一遍；`orderView`/`view()` 下发 `cancelRequested / cancelRequestedAt / cancelRejectedAt / cancelRejectReason`。② **家长取消**：已付款订单（`pending_class`、`awaiting_parent_confirm`）取消 → **只提交申请**：写 `cancel_requested_at` + 原因、通知教员，**钱一分不动、订单状态不变**；重复提交 400 `CANCEL_REQUESTED`；未支付订单仍是直接 `cancelled`；课程进行中（`in_class`）仍不允许取消。③ **教员端两个动作**（`POST /api/teacher/orders/:id/cancel-approve` / `cancel-reject`，均限本单教员）：**同意退款** = 按**当前时间**重算（免费取消窗口内全额，否则扣 20% 违约金并入教员钱包补偿 + 扣家长信用分），`escrowMove` 释放担保、写 `payments.refund` 流水、订单转 `refunded`、通知家长退款金额；**驳回** = 理由必填（≥2 字，400 拦空理由），清掉申请、记 `cancel_rejected_at`/`cancel_reject_reason`，订单继续履约并通知家长（可再申请或走客服仲裁）。越权（别人的订单）403；已退款订单再点同意 → 400。④ **兜底**：定时任务每轮检查，申请超过 `settlement.cancel_auto_approve_minutes`（新增规则，默认 **120 分钟**，后台规则中心可调）未处理 → 自动按同意退款，**不会把家长的钱一直押在担保账户里**。⑤ **界面**：参考实现教员端「我的订单」新增「待处理取消」标签（`?pendingCancel=1`），卡片与详情页都直接给「同意退款 / 驳回」按钮 + 家长取消原因 + 待退金额；家长端订单详情显示「已提交取消申请（时间），等待教员确认，超时自动退款」或「教员已于 X 驳回，理由：…」；uni-app 教员首页订单行同样加两个按钮（`uni.showModal` 可编辑理由）。**顺手修掉一个真 bug**：Nest 的 `cancelOrder` 在**事务内**用 `this.get()`（连接池另一条连接）回读订单，读不到未提交的更新 → 接口返回的 `cancelRequested` 恒为 false，已改成在事务里用 `m` 回读。**门禁**：`check-mobile-spa` 87 → **101 项**（申请不退款、重复申请 400、待处理列表、驳回必填理由、驳回后可再申请、同意退款 + 担保台账闭合、二次同意 400、越权 403）；`e2e` 216 → **224**（参考实现同链路 + 教员端入口契约）；接口 157 → **159 路由**；`ci:full` 30 步全绿。规则 `cancel_auto_approve_minutes` 已加进 `ADDITIVE_RULE_KEYS`（seed 用 `JSON_SET` 只补缺失键、不覆盖运营改过的值），所以老库跑一次 `db/seed-min.mjs` 就会出现在后台规则中心；未跑时接口/定时任务按缺省 120 分钟兜底 |
| P62 管理员用户自助修改口令（含首登强制改密） | ✅ | 背景：后端早就有 `POST /api/auth/change-password`（旧口令校验 + 强度规则 + 改后 `token_version` 自增让旧令牌立即失效并返回新令牌），但**PC 后台没有任何入口**；更麻烦的是后台「管理员账号」新建的账号会带 `must_change_password=1`，而守卫对这类账号除白名单外的请求一律 403——**新管理员登录后无处可改，直接卡死**。本轮补齐：① **新页面** `views/Password.vue`（`/password`）——旧口令 / 新口令 / 确认新口令，前端先校验（≥8 位、含字母与数字、不得与原口令相同、两次一致），提交后把后端返回的新令牌写回本地并清 `mustChangePassword` 标记，随后回总览；`?force=1` 时提示「未改初始口令前其它接口都会拒绝」，且只给「退出登录」不给「返回」。② **顶栏入口** `data-test=top-password`「修改口令」。③ **首登强制**：`Login.vue` 登录响应 `user.mustChangePassword=true` 时直接送进 `/password?force=1`；`api.js` 捕获任意接口的 `MUST_CHANGE_PASSWORD` 也统一跳该页（以前会停在 403 上）。④ **后端**：`common/errors.ts` 新增 `forbiddenWithCode()`，`auth.guard.ts` 的「首次登录请先修改初始口令」从 `FORBIDDEN` 改为专用码 **`MUST_CHANGE_PASSWORD`**（仍是 403，语义不变，前端才能可靠识别）。**门禁**：`check-admin-spa` 58 → **65 项**（改密页分包存在、调用 `/auth/change-password` 且带 old/new、前端强度校验、成功后清标记、顶栏入口、登录强制跳转、`MUST_CHANGE_PASSWORD` 统一跳转）；`ui:check` 后台 19 → **20 页**（`TRACEABILITY-UI-NEST` 增行）；计数同步 README / DELIVERY / HANDOVER / GO-LIVE-D4 / DEPLOY-CONTAINERS / `ci-full` / `ci.yml` / `workflow-proof` 的 58 → 65；`TRACEABILITY-NEST §9.4` 合计按实际重算 **739**（原 667 本身与分项不符，这次一并纠正）。⚠️ 参考实现（`web/admin.html`）只有 `POST /api/auth/password` 后端路由、**仍无改密 UI**，且参考实现不做首登强制——如需两端一致我再补 |
| P61 移动端家长端补齐「立即预约 + 订单详情」（需求 4.1.4 / 4.1.5）+ 上线清单纠偏 | ✅ | 背景：PC/参考实现家长端早就能「地图找教员 → 立即预约 → 担保支付」，但 uni-app 家长端只有「首页 + 发需求」，手机上**没法直接约课**，订单也只能在首页列表里点支付按钮、没有详情页。本轮补三个页面：① **附近教员** `pages/parent/teachers`——科目/排序筛选，已登录走 `/parent/teachers`（带收藏状态）、**游客走 `/public/teachers`**（收藏恒 false、手机号脱敏），保持「游客可浏览」的一致体验；② **教员详情 + 立即预约** `pages/parent/teacher`——资料/可预约服务/学员评价；点「立即预约」出预约表单：选服务 → 选地址（**没有地址可就地新增** `POST /addresses`，解决微信新账号无地址约不了课的问题）→ 选日期与起止时间（校验不得早于当前）→ 备注 → `POST /orders/from-service` → 直接跳订单详情去支付；**游客点预约先跳登录（带 `?next=` 回跳本页）**；③ **订单详情** `pages/parent/order`——状态/订单号/金额、教员信息（可跳教员主页）、上课信息与费用明细；按状态给操作：**去支付**（带 `X-Idem-Key` 幂等）、**确认完成上课**、**去评价**（星级 + 好评标签）、**申请取消订单**（P60 的申请制，页面显示「等待教员确认」或「教员已驳回 + 理由」）；首页加「找附近教员 · 立即预约」入口、订单行可点进详情。**文档纠偏**（同批）：`docs/GO-LIVE-CHECKLIST.md` 里 A3（围栏早已是真实行政区边界，不是矩形）、A4（已有上传能力）、A5（小程序 14 页 + openid 登录已通）、D1（用例 82 → 172）、D2（模块 9 → 23）、D4（产物契约 38/41 → 58/109）六行按现状重写并加「最后核对」时间戳；`TRACEABILITY-UI-NEST` 补 3 个新页面条目，README/HANDOVER 页面数 11 → 14。**门禁**：`check-mobile-spa` 101 → **109 项**（3 个新页面的骨架/路由回落/小程序 wxml 产物 + 「立即预约」走 `/orders/from-service` + 订单详情含「申请取消/确认完成」+「等待教员确认」状态文案）；`ci:full` 30 步全绿。**顺手修掉种子脚本的幂等 bug**：`db/seed-min.mjs` 插演示服务用的是 `INSERT IGNORE`，但 `teacher_services` 没有唯一索引 → 每跑一次种子就多一条「数学 一对一上门」（本地实测跑 9 次 = 9 条重复，页面上显示「可预约服务（9）」），改成先查后插，连跑两次仍是每教员 1 条。⚠️ 预约时间用 `picker`（日期 + 起止时间），移动端选时不受面板自动化影响，但 `uni.chooseImage` 类系统弹窗仍无法在面板驱动 |
| P49 区域管理按参考图重做：**输入地名定区域**（按行政区设置）+ 在线瓦片底图（需求 4.5.5） | ✅ | 背景：用户给了参考截图（左栏「按地图设置 / 按行政区设置」两种方式 + 勾选行政区 + 提交，右侧地图高亮所选区划），并要求「输入地名来定区域」；同时确认接受在线瓦片底图。本轮据此重做：① **行政区数据集**：新增 `tools/build-admin-areas.mjs`，从阿里云 DataV `areas_v3` 边界（公开底图，与 ECharts 同源）抓省级 34 + 地级市 363 + **全国区县 2840（含县级市/旗/林区）共 3237 个行政区 / 474671 点**，用道格拉斯-普克按级别简化（省 0.02°≈2.2km、市 0.008°≈900m、区县 0.002°≈220m）后落 `apps/api-nest/db/admin-areas.json` 随包分发；支持 `--src` 离线生成、`--check` 只校验、`--counties` 追加区县——落盘用 **gzip**（裸 JSON 8.1MB → 1.9MB，解压+解析 182ms，比裸 JSON 还快），仓库与镜像只背 1.9MB；抓取走「顺序 + 300ms 节流 + 403 指数退避 + `.cache/admin-areas` 磁盘缓存」，`--download-only` 可断点续跑（新疆兵团 659xxx 无下级文件，404 直接跳过）。② **后端**：`src/common/admin-areas.ts`（懒加载 + 名称/简称/adcode 搜索排序 + `fenceFromCodes` 拼多环围栏 + 未收录 adcode 显式报错）、`GET /api/admin/regions/areas`（`?q=地名` 搜索 / `?codes=` 取边界）、`POST /api/admin/regions` 支持 `adminCodes`（围栏 = 这些边界的并集，存 `regions.polygon` 多环 + 新列 `regions.admin_codes`），片区归属判定从 `pointInPolygon` 升级为 `pointInAnyRing`（多环任一命中）；参考实现 `server/core/admin-areas.js` + `server/modules/admin.js` 同步同一套 API 与语义（老库 `ensureColumn` 自动补 `admin_codes`）。③ **地图**：`geo-fence.js` 投影从「等距圆柱 + 横向压 cos(lat)」改为 **Web Mercator**——在线瓦片就是 Mercator 切片，画布同投影才能贴得严丝合缝（门禁断言「瓦片投影后是 256×256 正矩形」），并且 Mercator 等角，围栏不会再横着变胖；新增 `tileXY`/`tileBounds`/`scaleForTileZoom`/`tileZoomForScale`/`visibleTiles`；`GeoFenceMap.vue` 加**在线瓦片层**（默认高德栅格，`VITE_TILE_URL` 可换成自家/天地图源）与**自动降级**：连续失败且一张没成功 → 回落离线省级底图并在 HUD 标注「离线省级底图（在线瓦片不可达）」，另有「在线/离线底图」开关记进 localStorage——容器/门禁没外网时页面照样不白屏。④ **页面**：`Regions.vue` 按参考图重排为「按地图设置 / 按行政区设置」两个 tab：行政区委 = 地名输入框 + 搜索 + 候选复选列表（显示级别与顶点数）+ 已选标签 + 提交；勾选即拉边界高亮（蓝色半透明，多环），并把所选边界铺满视口；列表新增「设置方式 / 围栏 N 环 / 顶点数」列。**门禁**：`check-geo-fence` 32 → **65 项**（Mercator 等角性、锚点缩放、单环/多环点内判定与后端逐点一致、瓦片四至与 256px 对齐、visibleTiles 有界、离线底图、行政区数据集 411 条/坐标范围/体积、后端搜索（含「杭州」展开到区县）与拼装、页面接入）；`check-admin-spa` 42 → **46 项**（搜「张北」命中、按 adcode 取边界、按行政区建片区后回读多环）；`e2e` 163 → **166**（后台按行政区建片区 → 新家长在该县发需求 → `/admin/demands` 里片区名对得上，验证多环归属端到端）；接口 147 → **148 路由**。**实测**：容器重建后浏览器驱动真实交互——输入「张北」→ 勾选张北县 → 地图高亮该县边界（1 环/210 点）→ 提交提示「按行政区：张北县」→ 列表出现「按行政区」行；`e2e` 166/166（Nest 与参考实现各一遍）、后台 46/46、`ci:full` 30 步全绿。⚠️ 说明：在线瓦片用的高德栅格是无 key 的公开切片端点，**生产上线请按合规要求换成自有/天地图服务并配置 `VITE_TILE_URL`（含审图号）**；国内在线底图是 GCJ-02，行政区数据与手机定位同为 GCJ-02 能对齐，唯离线省级底图是 WGS-84（全国尺度偏差 <500m） |
| P19 后台新增 3 页 UI（需求池 / 管理员账号 / 权限矩阵） | ✅ | `Demands.vue`（状态/学段/科目/片区/加急筛选 + 分页）、`Admins.vue`（新建显示一次性口令 + 启停护栏提示）、`Permissions.vue`（4 权限点 × 5 角色矩阵，admin 列锁定）；PC 后台 15 → **18 页**，`check-admin-spa` 35 → **38** |
| P21 移动端补「消息中心」页（第 10 页） | ✅ | `pages/messages/index`：未读数、单条已读、全部已读（订单/资金/风控/系统四类）；4 个角色首页均加带未读数的入口；`check-mobile-spa` 39 → **41**（新增路由回落 + `/messages` 契约） |
| P20 UI 追溯矩阵（UI 说明书 ↔ 新前端） | ✅ | `docs/TRACEABILITY-UI-NEST.md`：移动端 10 页 + 后台 18 页逐页映射到 UI 说明书章节；`npm run ui:check` 校验（缺条目 → 退出码 1，实测负向验证通过）；纳入 `npm run ci` |
| P17 细粒度权限矩阵（需求 4.5.9 角色权限分配） | ✅ | 新增规则组 `permissions`（4 个高危权限点）+ `@Perm` 装饰器 + `GET/PUT /api/admin/permissions`；`check-permissions` **17/17**（授予即时生效、撤销即失效、admin 不可移除、未知权限点被拒、审计留痕） |
| P16 补齐后台需求池与管理员账号（需求 4.5.3 / 4.5.9） | ✅ | 新增 4 条路由（接口 136→**140**）：需求池分页筛选；管理员列表 / 新建（一次性强口令 + 首登改密）/ 启停（禁止禁自己、保底一个启用、禁用即失效令牌）；`check-admin-spa` 29→**35** |

**新后端累计门禁：153 + 53 + 50 + 23 + 12 + 38 + 41 + 27 + 38 + 17 + 15(P1) + 33(镜像运行契约) + 82(单元测试) + 32(支付回调/关单/退款/退款回调) + 7(对账自检) = 621 项断言全绿；
参考实现 7 套件 329 项断言零回归。**

### 1.17 P10：对抗式评审与缺陷修复

用两个只读评审代理对 `apps/api-nest` 做敌意审查（资金事务/并发、鉴权/越权/输入），
**逐条核对源码后确认并修复 21 处真实缺陷**，全部按「最小改动 + 保持既有契约」原则处理，
并新增 `tools/check-money-races.mjs`（27 项断言）把资金类缺陷固化成回归用例：
`node tools/gate-races.mjs` / `npm run nest:gate:races`。

**资金与并发（11 项）**

| # | 缺陷 | 修复 |
| --- | --- | --- |
| 1 | `walletAdd` 读快照→算值→绝对写回，无行锁；两笔提现并发可双花（余额被扣一次、流水两条） | `ledger.ts` 增加 `lockWallet()`（`SELECT … FOR UPDATE`），五个资金原语全部改为「锁内读 + 锁内写」 |
| 2 | `escrowMove` 用无锁 `SUM()` 算 running balance，并发写同一快照值 | 用 `GET_LOCK('jiajiao:escrow')` 串行化「读合计 + 追加一行」，并在 `finally` 释放 |
| 3 | `runSettlement` 订单列表在事务外取、事务内不复查、`UPDATE status='settled'` 无守卫 → 并发/多实例双放款 | 每笔订单事务内 `FOR UPDATE` 复查 + `UPDATE … WHERE status='completed'` 条件更新 |
| 4 | `reviewWithdrawal` 状态校验在事务外，驳回分支会退回余额 → 连点/并发可造币 | 事务内 `FOR UPDATE` 复查 + 两处 `UPDATE … AND status='pending'` |
| 5 | 后台退款审批同事务外校验，既可能二次出账，也可能把家长已取消的订单复活 | 事务内加锁复查 + 状态先行条件迁移（`AND status='refunding'`） |
| 6 | 平台强制关闭「已完成」订单不冲销教员冻结额 → `frozen` 永久悬挂 | 关闭时对 `completed` 订单调用 `walletUnfreezeIncoming`，返回值新增 `unfrozen` |
| 7 | `closeOrder` 读取在事务外、UPDATE 无状态守卫 → 与结算并发出现「既结算又退款」 | 事务内 `FOR UPDATE` + `AND status = <读到的状态>` |
| 8 | `applyRefund` 无事务无守卫，可把已 `completed` 的订单改回 `refunding` | 事务内加锁 + `AND status IN ('pending_class','awaiting_parent_confirm')` |
| 9 | `checkin`/`finish` 无状态守卫，可把已退款订单「复活」 | 改为条件更新 + `affectedRows` 断言 |
| 10 | `calcSplit` 用 `Math.max(0, …)` 吞赤字，规则超额时 `service_fee ≠ agent_share + sales_commission + platform_revenue` | 按「代理 → 业务员」顺序截断到服务费内，恒等式永远成立 |
| 11 | `idem_key` 只写不读，重试会因唯一索引报 400；`confirmComplete` 允许从 `in_class` 跳过授课直接结算 | 支付/提现均加「幂等重放返回首次结果」；确认完成收紧为仅 `awaiting_parent_confirm` |

**鉴权与输入（10 项）**

| # | 缺陷 | 修复 |
| --- | --- | --- |
| 12 | `send-code` 把验证码明文回显（`devCode`），匿名者可据此接管任意账号（含管理员） | 仅在开发/演示模式回显；`NODE_ENV=production` 或 `DEV_SMS=0` 时不再返回 |
| 13 | 客户端 IP 直接采信 `X-Forwarded-For`，轮换即可绕过登录锁定与注册频次 | 新增 `clientIp()`：默认只认 TCP 源地址，`TRUST_PROXY=1` 才采信 XFF |
| 14 | 验证码登录的锁定硬编码 5 次且返回 400，风控阈值配置对它无效 | 改为读 `risk` 规则组并统一 `429 LOGIN_LOCKED` |
| 15 | 验证码校验通过后不销毁，可重放；`send-code` 无频控 | 一次性消费 + 同号 60 秒冷却（`429 SMS_TOO_FREQUENT`，演示模式豁免） |
| 16 | 验证码/失败计数为无界内存 Map，可被随机手机号灌爆 | 增加 TTL 清理与 5000 条容量上限 |
| 17 | `AUTH_SECRET` 缺失时静默使用仓库内置密钥，可自签管理员令牌 | 生产模式缺失即拒绝启动；开发模式打印安全告警 |
| 18 | 家长端教员广场回传教员**完整手机号 + 精确坐标**，可批量爬取 | 手机号改脱敏、坐标取 2 位小数（精确位置在成交后由订单详情提供） |
| 19 | 规则内存缓存命中后永不过期，多实例下热更新永久失效 | 内存条目加 300s TTL（与 Redis 对齐）并对超大缓存做清理 |
| 20 | `POST /teacher/apply` 受类级 `@Roles("teacher")` 限制，家长无法入驻；且申请即写入 `role='teacher'` | 方法级放开 `parent`；角色切换改由管理员审核通过时执行 |
| 21 | 代理/业务员列表接口 `SELECT *` 后整行回传（潜在敏感列泄露风险） | 保持白名单字段映射（已有实现），并在 `docs/SECURITY.md` 记录口径 |

**隐私与账号安全（P11 第二轮，4 项）**

| # | 缺陷 | 修复 |
| --- | --- | --- |
| 22 | 订单视图 `mask=true` 只给地址打码，却仍返回**精确经纬度** → 代理/业务员可直接定位家长门口 | `view()` 在 `mask` 时坐标取 2 位小数（约 1km），家长/教员视角保持精确（打卡依赖） |
| 23 | 教员「附近需求」下发家长**完整门牌 + 备注**，未报名者亦可批量收集住址 | 未确认前只下发街道级模糊地址（前 8 字 + `***`）与「报名确认后可见」备注；成交后由订单详情提供完整地址 |
| 24 | 匿名 `/api/health` 暴露全站用户数、订单数与**担保资金总额**，异常时还回显 MySQL 错误信息 | 匿名只返回可用性（`db.ok/cache.ok/framework/latency`）；指标迁到 `GET /api/health/detail`（`@Roles("admin")`），异常信息只落日志 |
| 25 | 缺少改密接口：所有账号（含后台新建的代理/业务员）长期共用初始口令 `a123456` | 新增 `POST /api/auth/change-password`：校验原口令 + 强度（≥8 位且含字母数字）+ 禁止与旧口令相同 + 写审计日志；`check-privacy-auth` 覆盖 7 条断言 |
| 26 | 改密后旧令牌在 7 天 TTL 内仍然有效，口令泄露场景无法下线 | `users.token_version` + 令牌 `v` 声明：网关每次请求比对版本号，改密/注销即失效；改密响应返回新令牌保证当前会话不掉线 |
| 27 | 后台开通账号使用全站统一 `a123456`，站内消息还回显明文口令 | 改为一次性 12 位随机强口令（仅响应返回一次、消息不含明文），并置 `must_change_password=1`：改密前除 `change-password/me/logout/deactivate` 外一律 403；移动端登录页内置首登改密表单 |
### 1.18 P12：性能基线与热点优化

- 新增 `tools/bench-nest.mjs` + `tools/gate-bench.mjs`（`npm run nest:bench`）：12 个读接口各 500 次 × 并发 20，
  输出 p50/p95/p99/max/QPS/错误数，并单列「同一需求 50 并发抢单」的写路径（校验成功恰好 1 次）。
- 基线结论：**读接口 p95 ≤ 42ms、错误 0**；抢单写路径因 Redis 锁自旋 p95 ≈ 700ms，属「正确性优先」的预期取舍。
- 据基线与代码走查修复 2 处工程缺陷：
  1. `parent.home` 首页聚合 10 次互不依赖的取数由**串行 await 改并发 `Promise.all`** → p95 65.9ms → **≈40ms**；
  2. `nearbyForTeacher` 循环内逐条查 `applications`（N+1）→ 改为**批量 `IN` 查询 + Map 命中**，查询数 `1+N` → **2**。
- 详细数据、口径、以及「教员广场全表扫 + 内存排序」等性能边界与后续建议见 **`docs/PERF.md`**。

### 1.19 P13：接口清单自动生成与文档漂移门禁

- `tools/gen-api-doc.mjs` 直接解析 `apps/api-nest/src/**/*.controller.ts` 的装饰器（`@Controller` / `@Get`… / `@Roles` / `@Public` / `@HttpCode`），
  生成 `docs/API-NEST.md` 的「接口总表」自动区块：**136 个路由 / 16 个控制器**，含方法、完整路径、所需角色、是否公开。
- `--check` 模式双向校验：文档与代码不一致即退出码 1 并指出**首个差异行**（实测删掉一行 → 1，重新生成 → 0）。
  这样「交付文档里的接口」不可能悄悄落后于代码，也不需要人工盘点。
- 修复了生成器的一个真实判定错误：首版把「第一个方法上的 `@Public()`」误判为**类级**注解，
  导致 `POST /api/auth/change-password` 与 `GET /api/health/detail` 被标成公开；改为「类级注解只认 `export class` 之前的位置」后，
- 本轮未改后端源码，既有断言门禁不受影响（当时为 439 项）。

### 1.20 P14：需求追溯矩阵（新后端）与汇总 CI 门禁

- 新增 **`docs/TRACEABILITY-NEST.md`**：把需求书第 4–9 章逐条映射到新后端的**真实接口**与**真实门禁**，
  并单列 6 条偏离（后台需求池独立接口未单列、管理员账号管理未提供、跨区归属固定、支付/短信/地图为模拟、多实例计数、未容器化）。
- 新增 **`tools/check-trace-nest.mjs`（`npm run trace:check`）** 做机器校验：
  - 带 HTTP 方法的接口引用必须存在于 `docs/API-NEST.md`（该文档又由 `api:doc:check` 保证与源码一致）；
  - `e2e §n` 的序号必须在 `test/e2e.test.js` 实际分段范围内（当前 §1–§20）；
  - 引用的门禁脚本文件必须存在。
  实测（P14 落地时）：148 处接口引用 / 去重 136 个接口，与当时的接口清单一一对应；
  P16/P17/P19 陆续新增后台路由后，接口总数增至 **145**，覆盖同步为 **145/145**（`npm run trace:check` 每次都会重新核对）；
  把其中一处改成不存在的 `POST /api/orders/:id/payyy` 后，校验立即报错并退出码 1。
- 新增 **`tools/ci-full.mjs`** 汇总门禁，三个档位：
  `npm run ci`（静态十五步，约 30 秒）/ `npm run ci:quick`（加 verify-nest + e2e + security + rules）/ `npm run ci:full`（全部 28 步）。
  失败即中止并打印逐项耗时汇总。实测静态档：tsc 2.1s + 接口文档 0.1s + 追溯矩阵 0.1s，3 步全绿。

## 2. 后续迁移计划（按模块推进，以既有测试套件为门禁）

---

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| **P1 ✅** | 基础设施 + 规则引擎 + 鉴权 + 健康检查 + 字典 | `verify-nest.mjs` 15/15 |
| **P2 ✅** | 家长端域：认证（验证码登录/自动注册/邀请绑定/失败锁定）、地址 CRUD、首页聚合、教员广场（电子围栏+六维筛选+派单优先级）、教员详情、需求发布/编辑/暂停撤销、抢单报名、附近订单 | `test/e2e.test.js` **§1–§3 全绿（20/20）** |
| **P3 ✅** | 订单与资金域：家长确认接单生成订单、选购服务下单、担保支付（幂等+分账）、上门打卡（500 米）、结束授课、家长确认完成（冻结+成长分+信用分）、T+N 结算放款、取消/退款、评价、紧急求助、钱包与教员等级读接口、后台财务总览与退款审批 | `test/e2e.test.js` **§1–§7 全绿（40/40）** + `check-refund.mjs` **15/15** |
| **P4 ✅** | 教员端域（入驻/上下线/接单大盘/服务管理/收入/排课/评价与申诉/个人中心）+ 钱包提现（奖惩/幂等/驳回退回）+ 发票申请与财务受理 + 上课前提醒 + 账号注销（匿名化）+ 定时任务（结算 / 抢单超时 / 提醒） | `test/e2e.test.js` **§1–§8 全绿（43/43）** + `check-invoice-reminder.mjs` **23/23** |
| **P5 ✅** | 业务员端（双通道推广码 / 业绩看板与 7 日趋势 / 客户管理手机号脱敏 / 奖励明细）+ 区域代理端（片区大盘与考核、业务员开通与启停、片区订单与 CSV 导出脱敏、收益 6 期账单与构成、客诉处理、风控上报、公告）+ 后台奖励周结 | `test/e2e.test.js` **§1–§10 全绿（55/55）** |
| **P6 ✅** | 平台后台域：规则配置中心读写与热更新、风控事件处置、差评申诉仲裁（回滚成长分）、用户与分页、教员入驻审核与调级、订单列表/筛选/改价/强制关闭（释放担保）/CSV 导出、区域管理、代理管理（详情/编辑/启停/保证金台账）、Banner·公告·优惠券全 CRUD+toggle、审计日志分页、抢单超时清理、公开运营接口、站内消息 | `test/e2e.test.js` **全套 §1–§20 全绿（153/153）** |
| **P7 ✅（本轮）** | 并发与安全加固：抢单临界区 Redis 分布式锁（SET NX PX + Lua 释放，自旋等待后由唯一索引兜底）、注册反作弊（同设备 24h / 同 IP 1h 频次限制 + 风控事件）、口令登录失败锁定（规则驱动，429 `LOGIN_LOCKED`）、异常统一折叠为 400（不泄露底层 SQL）、客诉工单接口 | `concurrency-mysql.mjs` **23/23**、`security.test.js` **53/53**、`rules.test.js` **50/50** 全绿 |
| **P8 ✅** | 前端框架迁移：PC 管理后台 = **Vue3 + Vite + Element Plus**（14 个页面）；移动四端（家长/教员/业务员/区域代理）= **uni-app**（同一份源码产出 H5 + 微信小程序）。产物由 NestJS 托管于 `/admin-vue/` 与 `/m/` | `check-admin-spa.mjs` **26/26** + `check-mobile-spa.mjs` **30/30**；既有 UI 浏览器验收 `browser-check.mjs` **16/16** |
| **P9 ✅（本轮）** | SQLite → MySQL 数据迁移脚本（37 表 / 500 行，列交集自动跳过生成列）+ 双跑比对 + MySQL 版一致性巡检 | `gate-p9.mjs`：37 表行数一致、6 项关键汇总一致、迁移后巡检 **12/12** |

验收口径不变：**7 个套件全部变绿**才算迁移完成（当前参考实现 329 项断言）。

---

## 3. 已知差异与注意点

1. **抢单并发**：SQLite 版依赖事务 + 唯一索引；MySQL 版需改为 **Redis 分布式锁（SET NX PX）+ 唯一索引双保险**（对应需求 6.2）。
   现已在 `src/redis/` 预留连接，P7 阶段落地。
2. **金额类型**：MySQL 用 `BIGINT` 存「分」，与应用层整数运算一致；`decimalNumbers: true` 已开启，避免驱动层精度损失。
3. **时间字段**：仍以字符串（ISO-8601）存储，与参考实现保持一致，便于两套实现双跑比对；如需改为 `DATETIME(3)`，在 P9 一并做。
4. **规则缓存一致性**：`RuleConfigService.set()` 会同时失效内存与 Redis 单键；`invalidate()` 支持整组失效。
   多实例部署时以 Redis 为唯一缓存源，本地内存仅作单进程加速。
5. **静态托管**：NestJS 侧已托管既有 `web/` 目录，便于在迁移期用同一套 UI 对新后端做联调（P8 前）。

---

## 4. 为什么要分阶段而不是一次性重写

参考实现有 19,969 行、329 项断言保护的业务规则（分账恒等式、区域归属、并发原子性、越权防护）。
一次性重写会在很长一段时间内失去可运行、可验证的状态。分阶段的代价是两条实现短期并存，
收益是**任何时刻都有一个能跑、能验收的系统**，且每次迁移都有客观门禁（测试套件）而不是主观判断。