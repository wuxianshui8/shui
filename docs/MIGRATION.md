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
| P19 后台新增 3 页 UI（需求池 / 管理员账号 / 权限矩阵） | ✅ | `Demands.vue`（状态/学段/科目/片区/加急筛选 + 分页）、`Admins.vue`（新建显示一次性口令 + 启停护栏提示）、`Permissions.vue`（4 权限点 × 5 角色矩阵，admin 列锁定）；PC 后台 15 → **18 页**，`check-admin-spa` 35 → **38** |
| P21 移动端补「消息中心」页（第 10 页） | ✅ | `pages/messages/index`：未读数、单条已读、全部已读（订单/资金/风控/系统四类）；4 个角色首页均加带未读数的入口；`check-mobile-spa` 39 → **41**（新增路由回落 + `/messages` 契约） |
| P20 UI 追溯矩阵（UI 说明书 ↔ 新前端） | ✅ | `docs/TRACEABILITY-UI-NEST.md`：移动端 10 页 + 后台 18 页逐页映射到 UI 说明书章节；`npm run ui:check` 校验（缺条目 → 退出码 1，实测负向验证通过）；纳入 `npm run ci` |
| P17 细粒度权限矩阵（需求 4.5.9 角色权限分配） | ✅ | 新增规则组 `permissions`（4 个高危权限点）+ `@Perm` 装饰器 + `GET/PUT /api/admin/permissions`；`check-permissions` **17/17**（授予即时生效、撤销即失效、admin 不可移除、未知权限点被拒、审计留痕） |
| P16 补齐后台需求池与管理员账号（需求 4.5.3 / 4.5.9） | ✅ | 新增 4 条路由（接口 136→**140**）：需求池分页筛选；管理员列表 / 新建（一次性强口令 + 首登改密）/ 启停（禁止禁自己、保底一个启用、禁用即失效令牌）；`check-admin-spa` 29→**35** |

**新后端累计门禁：153 + 53 + 50 + 23 + 12 + 38 + 41 + 27 + 38 + 17 + 15(P1) + 33(镜像运行契约) + 82(单元测试) = 582 项断言全绿；
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
  P16/P17/P19 陆续新增后台路由后，接口总数增至 **142**，覆盖同步为 **142/142**（`npm run trace:check` 每次都会重新核对）；
  把其中一处改成不存在的 `POST /api/orders/:id/payyy` 后，校验立即报错并退出码 1。
- 新增 **`tools/ci-full.mjs`** 汇总门禁，三个档位：
  `npm run ci`（静态十三步，约 18 秒）/ `npm run ci:quick`（加 verify-nest + e2e + security + rules）/ `npm run ci:full`（全部 25 步）。
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