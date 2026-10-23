# 需求追溯矩阵 · 新后端（NestJS + MySQL 8 + Redis + Vue3/uni-app）

本文件回答一个问题：**《需求说明书 V1.0》里每一条要求，在 `apps/api-nest` 这套正式实现里由什么代码承载、被哪条门禁证明。**

- 参考实现（`server/` + SQLite + 原生 ESM 前端）的追溯见 [`docs/TRACEABILITY.md`](TRACEABILITY.md)；两套实现共用同一套 `/api` 契约。
- 本文件引用的每个 `方法 /api/路径` 都会被 `tools/check-trace-nest.mjs` 与控制器源码比对，**引用了不存在的接口会直接报错**；
  引用的脚本文件缺失同样报错。校验命令：`npm run trace:check`。
- 接口总表（自动生成、148 路由 / 18 控制器）见 [`docs/API-NEST.md`](API-NEST.md)；性能基线见 [`docs/PERF.md`](PERF.md)。
- 门禁简称：`e2e §n` = `test/e2e.test.js` 第 n 段；`rules` = `test/rules.test.js`；`sec` = `test/security.test.js`；
  `conc` = `tools/concurrency-mysql.mjs`；`races` = `tools/check-money-races.mjs`；`priv` = `tools/check-privacy-auth.mjs`；
  `hc` = `tools/healthcheck-mysql.mjs`；`admin` = `tools/check-admin-spa.mjs`；`mobile` = `tools/check-mobile-spa.mjs`。

## 第 4 章 各端功能需求

### 4.1 家长端

| 条目 | 实现（NestJS） | 验证 |
| --- | --- | --- |
| 4.1.1 手机号验证码登录、自动注册为家长、失败锁定、登录态查询 | `POST /api/auth/send-code`、`POST /api/auth/login`、`POST /api/auth/login-password`、`POST /api/auth/login-account`（用户名或手机号 + 密码，教员端用）、`POST /api/auth/wechat`、`GET /api/auth/wechat/authorize-url`（公众号授权链接，白名单校验）、`GET /api/auth/me` | e2e §1、e2e §21（微信幂等 + 用户名登录）、sec、priv、mobile |
| 4.1.1 多上课地址管理（增删改、设默认） | `GET /api/addresses`、`POST /api/addresses`、`PUT /api/addresses/:id`、`DELETE /api/addresses/:id`、`POST /api/addresses/:id/default` | e2e §2、sec（越权校验） |
| 4.1.1 家长头像（上传图片、框内自适应显示、恢复默认） | `POST /api/upload`、`PUT /api/parent/avatar`、`GET /api/parent/profile` | e2e §21（上传→设置→回读→外链拒绝→复位）、mobile |
| 4.1.2 自动定位片区 + 首页聚合（片区/横幅/公告/附近教员/优惠券/信用分） | `GET /api/parent/home`、`GET /api/public/home`（游客版同构首页）、`POST /api/public/promo/:token/scan` | e2e §2、e2e §21（游客浏览）、`rules`（围栏判定）、mobile |
| 4.1.4 附近教员广场（电子围栏 + 六维筛选 + 派单权重排序）、教员详情、直接预约下单 | `GET /api/parent/teachers`、`GET /api/parent/teachers/:id`、`GET /api/public/teachers`、`GET /api/public/teachers/:id`（游客版，收藏恒 false）、`POST /api/orders/from-service` | e2e §2、e2e §21、`rules`（优先级逐位验算）、mobile |
| 4.1.2 运营位：Banner / 公告 / 优惠券 | `GET /api/public/banners`、`GET /api/public/announcements`、`GET /api/public/coupons` | e2e §15 |
| 4.1.3 发布需求（学段/科目/地址/时间/预算/加急）与编辑、暂停、撤销、确认接单 | `POST /api/demands`、`PUT /api/demands/:id`、`POST /api/demands/:id/action`、`GET /api/demands/mine`、`GET /api/demands/:id`、`POST /api/demands/:id/confirm` | e2e §2、e2e §4 |

| 4.1.5 订单分类与详情、取消、确认完成、申请退款 | `GET /api/parent/orders`、`GET /api/orders/:id`、`POST /api/orders/:id/cancel`（已付款单转「取消申请」）、`POST /api/orders/:id/confirm`、`POST /api/orders/:id/refund` | e2e §4/§6/§13、e2e §21（取消申请） |
| 4.1.5 家长取消 → 教员端「退款 / 驳回」（取消申请制 + 超时自动退款） | `GET /api/teacher/orders`（`?pendingCancel=1` 只看待处理取消）、`POST /api/teacher/orders/:id/cancel-approve`、`POST /api/teacher/orders/:id/cancel-reject` | e2e §21、mobile（8 项：申请不退款/重复 400/驳回必填理由/再申请/同意退款/台账闭合/二次同意 400/越权 403） |
| 4.1.5 上课前 1 小时提醒 | 定时任务 `runLessonReminders()`，阈值 `notify.lesson_remind_minutes`；后台手动触发 `POST /api/admin/reminders/run` | e2e §18 |
| 4.1.6 担保支付（幂等）、消费/退款记录 | `POST /api/orders/:id/pay`、`GET /api/wallet`、`GET /api/wallet/txns` | e2e §4、`races`（幂等重放）、e2e §14 |
| 4.1.6 发票申请 | `POST /api/invoices`（仅本人订单、唯一约束） | e2e §17、`hc`（发票唯一性） |
| 4.1.7 评价（72h 窗口、1–5 星、信用加权） | `POST /api/orders/:id/review` | e2e §7、`rules`（加权与窗口） |
| 4.1.8 个人中心、站内消息（移动端「消息中心」页：未读数 / 单条已读 / 全部已读） | `GET /api/parent/profile`、`GET /api/messages`、`POST /api/messages/:id/read`、`POST /api/messages/read-all` | e2e §16、`priv`（消息只限本人）、`mobile`（页路由与接口） |
| （第 8 章）紧急求助 | `POST /api/orders/:id/sos` | e2e §19 |

### 4.2 教员端

| 条目 | 实现（NestJS） | 验证 |
| --- | --- | --- |
| 4.2.1 入驻申请（资料/证件/时段/覆盖半径）与审核状态 | `POST /api/teacher/apply`（`@Roles("parent","teacher")`，审核通过才切 `role=teacher`）、`GET /api/teacher/profile`、`PUT /api/teacher/profile` | e2e §12、`priv` |
| 4.2.2 在线/离线开关 | `POST /api/teacher/online` | e2e §3 |
| 4.2.2 接单大盘（今日单量/课时/评分/等级） | `GET /api/teacher/dashboard` | e2e §3、`nest:bench` |
| 4.2.2 附近需求（派单优先级降序）+ 一键抢单 | `GET /api/teacher/nearby-demands`（可带 `?lat=&lng=` 实时定位）、`POST /api/demands/:id/apply`（body 带当前位置） | e2e §3（含定位接单 4 条：`origin.source=current`/回落 `profile`/半径外不出现/远处抢单 `TOO_FAR`）、e2e §14、`conc`（100 并发无重复接单）、`rules` §派单、`mobile`（含 `?lat&lng` 契约） |
| 4.2.3 服务管理（上下架/编辑/删除） | `GET|POST /api/teacher/services`、`PUT|DELETE /api/teacher/services/:id`、`POST /api/teacher/services/:id/toggle` | e2e §6、`mobile` |
| 4.2.4 订单列表与详情、上门打卡（500m）、结束授课 | `GET /api/teacher/orders`、`POST /api/orders/:id/checkin`、`POST /api/orders/:id/finish` | e2e §5（超距拦截 + 风控事件）、e2e §6 |
| 4.2.5 等级权益（成长分/等级/抽佣/派单权重/变更记录） | `GET /api/teacher/level` | e2e §7、`rules` §等级 |
| 4.2.6 收入明细、钱包、冻结、提现（幂等、最低额与手续费规则） | `GET /api/teacher/income`、`GET /api/wallet`、`GET /api/withdrawals`、`POST /api/withdrawals` | e2e §8、`races`（双花/重复驳回）、`priv`（提现规则） |
| 4.2.7 排课日历与时间冲突校验 | `GET /api/teacher/calendar`（下单时校验同教员同时间冲突） | e2e §6、`mobile` |
| 4.2.8 个人中心、评价管理与申诉 | `GET /api/teacher/profile-page`、`GET /api/teacher/reviews`、`POST /api/teacher/reviews/:id/appeal` | e2e §12（申诉→仲裁） |

### 4.3 业务员端

| 条目 | 实现（NestJS） | 验证 |
| --- | --- | --- |
| 4.3.1 双通道推广码 + 扫码归属 | `GET /api/sales/dashboard`（`codes`）、`POST /api/public/promo/:token/scan` | e2e §10、e2e §20 |
| 4.3.2 业绩看板（今日/周/月、7 日趋势）与奖励待结、个人档案 | `GET /api/sales/dashboard`、`GET /api/sales/profile` | e2e §10、`admin`（业务员看板接口） |
| 4.3.3 客户列表（手机号脱敏） | `GET /api/sales/customers` | e2e §10、`sec` §4 |
| 4.3.4 奖励明细六类与计算规则 | `GET /api/sales/rewards`（含 `byType`、`rules`） | e2e §10、`mobile` |
| 4.3.5 提现申请/记录 | `POST /api/withdrawals`、`GET /api/withdrawals` | e2e §8、`races` |

### 4.4 区域代理端

| 条目 | 实现（NestJS） | 验证 |
| --- | --- | --- |
| 4.4.1 片区大盘（GMV/订单/活跃教员/家长/趋势/热力） | `GET /api/agent/dashboard` | e2e §9、`rules`（区域隔离） |
| 4.4.2 业务员开通/启停/列表/详情（新账号一次性口令 + 首登改密） | `GET /api/agent/sales`、`POST /api/agent/sales`、`GET /api/agent/sales/:id`、`POST /api/agent/sales/:id/toggle` | e2e §9、`priv` |
| 4.4.3 片区订单与 CSV 导出（脱敏） | `GET /api/agent/orders`、`GET /api/agent/orders/export` | e2e §9、e2e §16、`sec` |
| 4.4.4 收益构成与月度账单 | `GET /api/agent/earnings` | e2e §9、`rules`（分成公式） |
| 4.4.5 客诉处理、风控上报 | `GET /api/agent/complaints`、`POST /api/agent/complaints/:id/handle`、`GET /api/agent/risks`、`POST /api/agent/risks/:id/escalate` | e2e §9、`mobile` |
| 4.4.6 片区公告、账号信息、改密 | `GET /api/agent/announcements`、`GET /api/agent/profile`、`POST /api/auth/change-password` | `admin`、`priv`（改密与令牌失效） |

### 4.5 平台管理后台

| 条目 | 实现（NestJS） | 验证 |
| --- | --- | --- |
| 4.5.1 数据总览 | `GET /api/admin/overview` | e2e §16、`admin` |
| 4.5.2 用户管理（列表/筛选/禁用/**删除账号（软删除 + 匿名化）**） | `GET /api/admin/users`（`?includeDeleted=1` 可查已删除）、`POST /api/admin/users/:id/toggle`、`DELETE /api/admin/users/:id` | e2e §3/§16、`admin`（家长/教员/业务员可删；有历史数据→打 `deleted_at` 标记并清手机号/昵称/实名/身份证/证件图/口令，订单与资金台账保留；完全空白→物理删；有未完结订单/冻结金额→拒绝；管理员与代理各走各的）、`sec` |
| 4.5.2 教员审核、驳回、手动调级 | `GET /api/admin/teachers/pending`、`POST /api/admin/teachers/:id/audit`、`POST /api/admin/teachers/:id/level` | e2e §12、`admin` |
| 4.5.2 代理管理（新增/编辑/启停/**删除（软删除 + 匿名化）**/保证金台账） | `GET|POST /api/admin/agents`、`GET|PUT|DELETE /api/admin/agents/:id`、`POST /api/admin/agents/:id/toggle`、`POST /api/admin/agents/:id/deposit` | e2e §3/§16、`admin`（新增返回一次性口令；保证金/钱包余额/冻结未结清 → `AGENT_MONEY_LEFT` 拒绝；有历史痕迹 → `mode=soft` 打标记+匿名化并保留订单分成/归属绑定/下属/保证金台账；完全空白 → `mode=hard`） |
| 4.5.3 全平台订单（筛选/导出/改价/强制关闭释放担保） | `GET /api/admin/orders`、`GET /api/admin/orders/export`、`POST /api/admin/orders/:id/price`、`POST /api/admin/orders/:id/close` | e2e §16、`races`（关闭已完成订单冲销冻结） |
| 4.5.3 退款工单处理 | `GET /api/admin/refunds`、`POST /api/admin/refunds/:id/review` | e2e §13、`races`（并发审批只出账一次） |
| 4.5.3 抢单超时清理 | 定时任务 `expireApplications()` + `POST /api/admin/applications/expire` | e2e §16 |
| 4.5.3 需求池列表（状态/科目/学段/片区/加急筛选、报名数、家长手机号脱敏）+ 后台「需求池」页 | `GET /api/admin/demands` | `admin`（2 条断言 + 页面分包） |
| 4.5.4 规则配置中心（15 组，热更新即时生效） | `GET /api/admin/rules`、`PUT /api/admin/rules/:key` | e2e §11、`rules`（50 项） |
| 4.5.5 片区与电子围栏（后台在中国地图上直接画 / 按行政区选） | `GET /api/admin/regions`、`GET /api/admin/regions/areas`（`?q=地名` 搜索 / `?codes=adcode` 取边界）、`POST /api/admin/regions`（`polygon` 顶点数组 或 `adminCodes` 行政区列表） | `admin`（新建片区 + 多边形写入后回读顶点数 + 按行政区建片区回读多环 + 县级市/市辖区搜索）、`geo`（`tools/check-geo-fence.mjs` 72 项：Mercator 投影/缩放锚点/点内判定单环多环/瓦片对齐/底图与行政区数据集（3237 个行政区，含全国 2840 个区县）/页面接入） |
| 4.5.6 财务：担保台账、支付流水、分账、对账 | `GET /api/admin/finance` | e2e §14、`hc`（12 项不变量） |
| 4.5.6 提现审核、奖励周结、发票受理 | `POST /api/admin/withdrawals/:id/review`、`POST /api/admin/rewards/settle`、`POST /api/admin/invoices/:id/review` | e2e §8/§10/§17、`races` |
| 4.5.6 T+N 结算 | 定时任务 `runSettlement()` + `POST /api/admin/settlement/run` | e2e §6、`races`（并发只放款一次） |
| 4.5.7 风控事件处置、差评仲裁、客诉终审（家长/教员发起工单） | `GET /api/admin/risks`、`POST /api/admin/risks/:id/handle`、`POST /api/admin/appeals/:id/arbitrate`、`POST /api/admin/complaints/:id/close`、`POST /api/complaints`、`GET /api/complaints/mine` | e2e §12、`admin` |
| 4.5.8 运营工具（Banner/公告/优惠券增删改启停） | `GET|POST /api/admin/banners`、`PUT|DELETE /api/admin/banners/:id`、`POST /api/admin/banners/:id/toggle`、`GET|POST /api/admin/announcements`、`PUT|DELETE /api/admin/announcements/:id`、`POST /api/admin/announcements/:id/toggle`、`POST /api/admin/announcements/:id/pin`、`GET|POST /api/admin/coupons`、`PUT /api/admin/coupons/:id`、`POST /api/admin/coupons/:id/toggle` | e2e §15、`admin` |
| 4.5.9 管理员账号管理（列表/新建/启停，一次性口令 + 首登改密 + 禁用即失效令牌） | `GET /api/admin/admins`、`POST /api/admin/admins`、`POST /api/admin/admins/:id/toggle` | `admin`（4 条断言） |
| 4.5.9 细粒度权限矩阵（4 个高危权限点可按角色授予，admin 不可被移除）+ 后台「权限矩阵」页 | `GET /api/admin/permissions`、`PUT /api/admin/permissions` | `permissions`（17）+ `admin`（3） |
| 4.5.9 操作日志与基础参数 | `GET /api/admin/audit-logs`、`GET /api/meta/dictionary`、`GET /api/meta/rules-public` | e2e §16、`sec` |
| 4.5.9 运维指标（用户数/订单数/担保资金） | `GET /api/health/detail`（仅 admin）、`GET /api/health`（匿名仅可用性） | `priv`（信息分级） |

## 第 5 章 核心业务规则引擎

| 条目 | 实现（NestJS） | 验证 |
| --- | --- | --- |
| 5.1 5 公里推送半径可调 | 规则 `dispatch.max_radius_km` | `rules` |
| 5.1 推送优先级 = 距离系数 × 等级权重 × 响应速度 × 加急加成 | `RuleEngineService.dispatchPriority()` | `rules`（9 位教员逐个验算）、e2e §3 |
| 5.1 先到先得（并发安全） | Redis 锁 + `applications(demand_id, teacher_id)` 唯一索引 | `conc`（100 并发仅 1 成功）、`races` |
| 5.1 抢单超时 24h 失效 | 定时任务 `expireApplications()` | e2e §16 |
| 5.2 成长分、等级、降级、违规扣分 | `applyGrowth()` / `applyViolation()` + 规则 `growth_rules`、`teacher_levels` | e2e §7/§12、`rules` |
| 5.3 家长信用等级、加减分、限制名单 | `applyCredit()` + 规则 `parent_credit`、`credit_rules` | e2e §7/§13、`rules` |
| 5.4 支付→担保→T+N 结算 | `escrowMove()` / `walletSettle()` / `walletFreezeIncoming()` | e2e §4/§6、`hc`、`races` |
| 5.4 分账：教师实收 / 代理分成 / 业务员提成 / 平台净收入 | `RuleEngineService.calcSplit()`（超额截断保证恒等式） | `rules`、`races`（恒等式①②）、`hc`（逐单不守恒=0） |
| 5.4 提现手续费与最低额、取消违约金 | 规则 `settlement` | e2e §8、e2e §13、`priv` |
| 5.5 扫码注册归属业务员与片区 | `bindings(source='scan')`、`POST /api/public/promo/:token/scan` | e2e §20 |
| 5.5 自然注册/跨区订单的片区归属 | `resolveRegion()` + 订单按需求发布地片区归属 | e2e §20 |

## 第 6 章 技术选型与开发要求

| 条目 | 实现 | 验证 |
| --- | --- | --- |
| 6.1 后端 NestJS | `apps/api-nest/`（45 个 TS 文件、模块化 controller/service、全局 Guard/Filter） | `verify-nest` 15 项、`tsc` 0 错误 |
| 6.1 数据库 MySQL 8 | `db/schema.mysql.sql`（37 表）+ 原生参数化 SQL（`DataSource.query`） | `nest:gate:p9`（37 表行数一致、6 项汇总一致）、`hc` |
| 6.1 缓存 Redis | 规则读缓存（TTL 300s）、抢单分布式锁、担保台账命名锁 | `verify-nest`（cache.ok）、`conc` |
| 6.1 PC 后台 Vue3 + Element Plus | `apps/web-admin/`（20 页，含需求池/管理员账号/权限矩阵/区域管理地图/自助改密） | `admin` 65 项 |
| 6.1 移动端 uni-app | `apps/web-mobile/`（14 页，H5 + 微信小程序双产物，含入驻认证、定位接单、附近教员/立即预约/订单详情） | `mobile` 109 项 |
| 6.2 并发一致性 | 行锁 `FOR UPDATE` + 条件更新 + 唯一索引 + 幂等键 | `conc` 23 项、`races` 27 项 |

## 第 7 章 非功能需求

| 条目 | 实现 | 验证 |
| --- | --- | --- |
| 7.1 交互性能（常规查询 < 200ms） | 连接池 40、规则缓存、首页并发取数、附近需求批量查询 | `nest:bench`（读接口 p95 ≤ 42ms）→ `docs/PERF.md` |
| 7.2 安全：越权、注入、脱敏 | 全局 Guard + 服务层 owner/region 校验、全参数化 SQL、`maskPhone` | `sec` 53 项、`priv` 38 项 |
| 7.2 令牌与会话安全 | HMAC 令牌 + `token_version`（改密即失效）、首登强制改密 | `priv`（旧令牌 401 / 首登 403） |
| 7.3 可用性与可观测 | `GET /api/health`（匿名探活）、`GET /api/health/detail`（admin）、操作日志 | `verify-nest`、`priv`、e2e §16 |
| 7.4 数据一致性 | 担保台账、钱包流水、冻结池、孤儿数据等 12 项巡检 | `hc` 12 项（全 0 异常） |

## 第 8 章 风控与合规

| 条目 | 实现 | 验证 |
| --- | --- | --- |
| 8.1 注册反作弊（同设备 24h / 同 IP 1h） | `assertRegisterAllowed()` + `risk_events` | e2e §1、e2e §19、`sec` |
| 8.1 登录暴力破解防护 | `risk.login_fail_limit` 驱动，`429 LOGIN_LOCKED`，验证码一次性 | `sec`、`priv` |
| 8.2 异常定位与虚假打卡 | 打卡 haversine 校验 + `abnormal_location` 风控事件 | e2e §5 |
| 8.2 差评申诉与违规处罚 | `POST /api/teacher/reviews/:id/appeal` → `POST /api/admin/appeals/:id/arbitrate`（回滚成长分） | e2e §12 |
| 8.3 上门安全（紧急求助） | `POST /api/orders/:id/sos`（10 分钟内去重，通知平台与片区） | e2e §19 |
| 8.4 隐私最小化 | 广场手机号脱敏 + 坐标 2 位小数、附近需求街道级模糊地址、代理/业务员视图脱敏 | `priv`、`sec` |
| 8.5 账号注销（匿名化保留流水） | `POST /api/auth/deactivate`（有在途订单/冻结资金时拒绝） | e2e §18 |

## 第 9 章 项目交付与验收

| 条目 | 交付物 | 验证 |
| --- | --- | --- |
| 9.1 可运行系统 | `start.bat` → MySQL 3307 + Redis 6380 + NestJS 4300（自动建库、灌数据、编译） | 六端 200 实测（README 顶部） |
| 9.2 接口文档 | `docs/API-NEST.md`（自动生成 148 路由 / 18 控制器）+ `docs/API.md`（参考实现） | `npm run api:doc:check` |
| 9.3 追溯与偏离 | 本文件 + `docs/TRACEABILITY.md` + `docs/MIGRATION.md` | `npm run trace:check` |
| 9.4 测试门禁 | e2e 173 + sec 53 + rules 50 + conc 23 + races 27 + priv 38 + perm 17 + admin 65 + mobile 109 + 支付 32 + 镜像运行契约 33 + 证件识别 20 + 围栏 72 + verify 15 + hc 12 = **739** | `npm run ci` / `npm run ci:full` |
| 9.5 性能报告 | `docs/PERF.md`（两轮实测 + 优化记录 + 性能边界） | `npm run nest:bench` |

## 偏离与说明（逐条给出原因）

| # | 偏离 | 原因与现状 |
| --- | --- | --- |
| 1 | **（已补齐）** 后台需求池独立列表接口 | P16 新增 `GET /api/admin/demands`（分页 + 状态/科目/学段/片区/加急筛选，含报名数与待处理报名数，家长手机号脱敏），`check-admin-spa` 覆盖 2 条断言 |
| 2 | **（已补齐）** 管理员账号管理仅内置单账号 | P16 新增 `GET /api/admin/admins`、`POST /api/admin/admins`（一次性强口令 + 首登强制改密）、`POST /api/admin/admins/:id/toggle`（禁止禁用自己、必须保留至少一个启用管理员、禁用即自增 `token_version` 使旧令牌失效）；`check-admin-spa` 覆盖 4 条断言。细粒度权限矩阵已由 P17 补齐（4 个高危权限点：改价 / 强制关闭 / 退款审批 / 提现审核，可按角色授予，admin 不可移除） |
| 3 | 跨区订单收益归属固定为「**需求发布地址所在片区**」 | 需求 5.5 有明文，故未做成可切换；`e2e §20` 做了跨区断言（西湖家长在滨江发单 → 滨江代理计提） |
| 4 | 微信支付 / 短信 / 地图 SDK 为**模拟实现** | 与参考实现一致：支付走担保台账真实记账、验证码本地生成（生产需接真实通道并把 `devCode` 关闭）、距离与围栏为真实 Haversine/多边形算法 |
| 5 | 并发计数与规则内存缓存为**单实例实现** | 规则缓存已加 300s TTL（与 Redis 对齐）；多实例需将验证码/失败计数迁到 Redis，见 `docs/SECURITY.md` §8 第 11 条 |
| 6 | **（已补齐）** 容器化交付 | 环境就绪后已交付并实测：`deploy/Dockerfile`（多阶段、`USER node`、`HEALTHCHECK`）+ `docker-compose.yml`（mysql/redis/app/seed）+ `.dockerignore`；三服务 healthy、四入口 200、四角色登录、容器库 37 表、**容器栈 9 套件 282 断言**全绿，另附 `verify:docker` 与备份/恢复脚本。生产仍建议前置 Nginx + HTTPS（见 `docs/DEPLOY-CONTAINERS.md`） |

## 校验

```bash
npm run trace:check    # 本文件引用的接口/脚本是否真实存在（漂移即报错）
npm run api:doc:check  # 接口总表是否与控制器源码一致
npm run ci             # 静态门禁：tsc + api:doc:check + trace:check
npm run ci:full        # 追加：verify-nest / e2e / security / rules / concurrency / races / privacy / admin / mobile
```
