# 需求追溯矩阵

两份文档的**每一条功能要求** → 实现位置 → 验证方式的逐条对照。

- 图例：`✅` 已实现并验证 ｜ `⚠️` 已实现但与文档有差异（原因见 §3）｜ `⛔` 未实现（属文档明确的二期范围）
- 验证代号：
  | 代号 | 脚本 |
  | --- | --- |
  | `e2e` | `test/e2e.test.js`（144 项） |
  | `rules` | `test/rules.test.js`（51 项） |
  | `sec` | `test/security.test.js`（55 项） |
  | `conc` | `test/concurrency.test.js`（22 项） |
  | `bench` | `scripts/bench.mjs`（16 项） |
  | `bc` | `scripts/browser-check.mjs`（16 项） |
  | `hc` | `scripts/healthcheck.mjs`（12 项） |

---

# 第一部分 《家教上门撮合平台项目开发需求说明书 V1.0》

## 第 1 章 项目概述

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 1.1 需求方发需求、附近教员抢单 | ✅ | `POST /api/demands` → `applications` 报名 → 家长确认 | e2e §2/§3 |
| 1.1 供给方上架服务、家长地图选购 | ✅ | `teacher_services` + `GET /api/parent/teachers` + `POST /api/orders/from-service` | e2e §2/§4 |
| 1.1 等级体系 / 评价体系 / 担保交易 | ✅ | `rules.js` 等级与成长分、`reviews` 加权评价、`escrow_ledger` 担保台账 | rules §2–§4、hc |
| 1.1 业务员推广 + 区域代理多级拓展 | ✅ | `promotion_codes` / `bindings` / `rewards` / `agent_profiles` | e2e §9/§10 |
| 1.2 教员每单抽取平台服务费 | ✅ | `calcSplit()` 按等级抽佣 | rules §2、hc |
| 1.2 业务员拉新 + 代理片区化分成 | ✅ | 阶梯提成 + 服务费分成 + 管理提成 | rules §2 |
| 1.2 增值：加急订单服务费 | ✅ | 需求 `urgent` + `urgent.fee` 规则 | e2e §2 |
| 1.2 增值：教员会员、广告位 | ⛔ | 文档注明「二期迭代」 | — |
| 1.3 家长端 7 项 | ✅ | `parent.html` + `modules/market.js`/`auth.js`/`orders.js` | e2e §2/§4/§7/§8/§17/§18 |
| 1.3 教员端 7 项 | ✅ | `teacher.html` + `modules/teacher.js` | e2e §3/§6/§8、rules §3/§4 |
| 1.3 业务员端 4 项 | ✅ | `sales.html` + `modules/sales.js` | e2e §10 |
| 1.3 代理端 5 项 | ✅ | `agent.html` + `modules/agent.js` | e2e §9、rules §6 |
| 1.3 PC 后台 5 项 | ✅ | `admin.html` + `modules/admin.js` | e2e §11/§12/§15/§16/§17 |
| 1.3 二期 5 项（轨迹/视频/合同/分销/AI） | ⛔ | 文档明确本期不开发 | — |

## 第 2 章 角色与权限体系

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 2.1 家长/学生：发单、选教员、下单、支付、评价；仅本人数据 | ✅ | `role='parent'` 路由白名单 + `ctx.user.id` 过滤 | sec §1/§2 |
| 2.1 教员：抢单、上架、打卡、收入、升级；仅本人数据 | ✅ | `role='teacher'`；需求详情另按服务半径+科目判定 | sec §2 |
| 2.1 地推业务员：推广码、业绩、奖励、提现；仅本人推广客户 | ✅ | `bindings.sales_id` 校验 | sec §2 |
| 2.1 区域代理：片区业务员/数据/客诉/提现；严格片区隔离 | ✅ | `agent.js` 全量 `myRegion(ctx)` 强制片区条件 | sec §2、rules §6 |
| 2.1 平台管理员：全量数据、规则、审核、风控、结算 | ✅ | `adminOnly(ctx)` | e2e §11–§17 |
| 2.2 代理不可改平台核心规则 | ✅ | 规则修改接口 `adminOnly`，代理调用 403 | sec §2、rules §6 |
| 2.2 代理不可审核教员，仅可推荐 | ✅ | 审核接口 `adminOnly`，代理调用 403 | sec §2 |
| 2.2 资金结算统一由平台审核，代理/业务员无资金操作权 | ✅ | 提现/退款/奖励/发票受理均需管理员复核 | e2e §8/§15/§17 |
| 2.2 代理后台手机号、详细地址默认脱敏 | ✅ | `maskPhone` / `maskAddress` 在 `orderViews(mask:true)` | sec §4 |

## 第 3 章 核心业务流程

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 3.1 ①发布需求写入订单池 | ✅ | `POST /api/demands`（status=published） | e2e §2 |
| 3.1 ②按距离+等级权重向附近在线教员推送 | ✅ | `dispatchPriority()` = 距离系数 × 等级权重 × 响应速度系数 | rules §1（逐项验算） |
| 3.1 ③教员申请接单、家长择一确认 | ✅ | `POST /api/demands/:id/apply` + `/confirm`（并发安全） | e2e §3/§4、conc §2/§3 |
| 3.1 ④家长预付课时费至担保账户 | ✅ | `payOrder()` → `escrow_ledger(in)` | e2e §4、hc |
| 3.1 ⑤教员上门定位打卡开始授课 | ✅ | `POST /api/orders/:id/checkin`（500m 阈值） | e2e §5 |
| 3.1 ⑥授课结束家长确认，扣服务费后结算 | ✅ | `/finish` → `/confirm` → 冻结 → T+N 结算 | e2e §6 |
| 3.1 ⑦家长评价，系统计算成长分与等级 | ✅ | `submitReview()` → 加权成长分 → 自动升降级 | e2e §7、rules §4 |
| 3.2 反向流程 4 步（上架→广场→预约→履约） | ✅ | `teacher_services` + `from-service` 下单 | e2e §2/§4 |
| 3.3 拓展流程 6 步（签约→建号→推广→归属→计提→提现） | ✅ | `promotion_codes` / `bindUser()` / `rewards` | e2e §10、rules §8 |
| 3.4 课前规定时间免费取消，临近扣违约金 | ✅ | `settlement.free_cancel_hours` + `cancel_penalty_rate` | e2e §13 |
| 3.4 差评申诉 → 平台仲裁 | ✅ | `reviews.appeal_status` + `POST /admin/appeals/:id/arbitrate` | e2e §12 |
| 3.4 投诉纠纷：片区代理先协调，失败上报平台 | ✅ | `complaints` 状态机 + 代理 handle/escalate | e2e §9、agent 端 `/risk` |
| 3.4 风控异常自动标记、暂停结算、人工复核 | ✅ | `risk_events.settlement_hold` 阻断 `runSettlement` | e2e §5/§12 |

## 第 4 章 各端功能需求

### 4.1 家长端（`web/parent.html` + `web/assets/js/parent.js`，16 条路由）

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 4.1.1 手机号验证码 / 微信一键登录、协议勾选 | ✅ | `/api/auth/send-code|login|wechat`；登录层含协议勾选 | e2e §1 |
| 4.1.1 可选实名认证（姓名+身份证） | ✅ | `POST /api/auth/realname` + 身份证格式校验 | page `/profile` |
| 4.1.1 多上课地址管理 | ✅ | `/api/addresses` CRUD + 设默认 | e2e §2、page `/addresses` |
| 4.1.2 自动定位当前片区、显示位置 | ✅ | `navigator.geolocation`（3.5s 超时，失败回退默认地址）+ `resolveRegion()` 电子围栏 | 服务端坐标解析实测、bc |
| 4.1.2 双核心入口：发布需求 / 附近教员广场 | ✅ | 首页双 Tab | page `/` |
| 4.1.2 轮播 Banner、活动公告、优惠券入口 | ✅ | `/api/public/banners|coupons` + `announcements` | page `/`、`/coupons` |
| 4.1.2 底部导航四栏 | ✅ | `.m-tabbar` | bc |
| 4.1.3 必填字段（学段/科目/上课形式/地址/时间/预算/备注） | ✅ | `POST /api/demands` 字段校验；`mode`=`home`（教员上门，默认）/`teacher_place`（家长到教员处，P65） | e2e §2、§23 |
| 4.1.3 加急开关 + 加急费 | ✅ | `urgent.fee` 规则（默认 ¥20） | e2e §2 |
| 4.1.3 发布后可编辑、暂停、撤销 | ✅ | `PUT /api/demands/:id`、`POST /:id/action` | page `/demand/:id` |
| 4.1.4 地图气泡、筛选、列表/地图切换 | ✅ | `/api/parent/teachers` 六维筛选 + `.map-board` 气泡 | e2e §2 |
| 4.1.4 教员详情（资质/教龄/科目/价格/评价/等级/覆盖） | ✅ | `GET /api/parent/teachers/:id` | e2e §2 |
| 4.1.4 收藏教员、直接预约下单 | ✅ | `/api/my/favorites` + `from-service` | page `/teacher/:id` |
| 4.1.4 授课地点：教员上门 / **家长到教员处**（P65）+ **服务级授课形式**（P67） | ✅ | `from-service` 的 `place`、`orders.place`、`teacher_profiles.base_address`、`teacher_services.places`；每个服务自己声明支持哪种形式，不支持则 400 `PLACE_NOT_SUPPORTED` | e2e §23（12 项）、§25（7 项）、`admin` 84、`mobile` 120 |
| 4.1.5 六种状态分类 + 订单详情 | ✅ | `/api/parent/orders?status=` + `/orders/:id` | e2e §4、page `/orders` |
| 4.1.5 联系教员、取消、申请退款、确认完成 | ✅ | 对应 5 个订单接口 | e2e §13/§6 |
| 4.1.5 上课前 1 小时推送提醒 | ✅ | `runLessonReminders()` 定时任务（阈值可配） | e2e §18 |
| 4.1.6 微信支付 + 担保说明 | ✅ | `payOrder()` + `escrow_ledger`（模拟网关，流程真实） | e2e §4 |
| 4.1.6 消费记录、退款记录 | ✅ | `GET /api/wallet`（txns） | page `/wallet` |
| 4.1.6 发票申请入口 | ✅ | `POST /api/invoices` + 后台受理 | e2e §17 |
| 4.1.7 完成后 72 小时内可评价，1-5 星 + 文字 + 预设标签 | ✅ | `review_scoring.window_hours` + `POST /orders/:id/review` | e2e §7 |
| 4.1.7 评价公开、支持申诉、按家长信用加权 | ✅ | `reviews.weight` + `appeal_status` | e2e §7/§12 |
| 4.1.8 个人中心：资料/地址/收藏/信用等级/优惠券/客服/设置/退出 | ✅ | `GET /api/parent/profile` + 5 个页面 | page `/me` 等 |
| **（第 8 章）紧急求助入口** | ✅ | `POST /api/orders/:id/sos` | e2e §19、浏览器点击实测 |

### 4.2 教员端（`web/teacher.html` + `web/assets/js/teacher.js`，13 条路由）

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 4.2.1 身份选择、资料与证件上传、授课设置 | ✅ | `POST /api/teacher/apply`（含证件 URL、时段、覆盖半径） | page `/apply` |
| 4.2.1 审核状态展示、驳回标注原因、可修改重提 | ✅ | `audit_status` / `reject_reason` | e2e §12、page `/apply` |
| 4.2.2 在线/离线开关（开启后进入广场） | ✅ | `POST /api/teacher/online` | e2e §3 |
| 4.2.2 数据概览：今日服务单量、本周课时、服务评分、当前等级 | ✅ | `dashboard.overview`（`todayLessons` / `weekLessons` / `ratingAvg` / `level`） | 实测接口返回、page `/` |
| 4.2.2 附近订单按距离排序 + 一键抢单 | ✅ | `/api/teacher/nearby-demands`（按优先级降序）+ `/apply` | e2e §3、rules §1 |
| 4.2.2 右上角服务管理入口 | ✅ | 首页头部 🗂 按钮 → `/services` | 浏览器实测 |
| 4.2.3 服务列表（上架/下架）、编辑、上下架开关、**授课形式（上门 / 在教员家，P67）** | ✅ | `/api/teacher/services*`（`places` 数组）；家长预约按服务过滤，不支持则 400 `PLACE_NOT_SUPPORTED` | page `/services`、e2e §25 |
| 4.2.4 五种订单状态、详情、联系家长 | ✅ | `/api/teacher/orders?status=` | e2e §6、page `/orders` |
| 4.2.4 上门打卡校验定位，超阈值拦截 | ✅ | `checkin()` haversine ≤ 500m + 风控事件 | e2e §5 |
| 4.2.4 家长到场打卡 + 双方确认开课（P66） | ✅ | `checkin()` 放开到家长（仅 `place=teacher_place`）：双方各打一次卡、都到齐才 `in_class`；定位阈值同 500m、超阈值写风控；家长端「📍 我到场了」（定位授权）、教员端「教学点打卡」+「家长已到场/待打卡」 | e2e §24（9 项）、`admin` 81、`mobile` 117 |
| 4.2.4 结束授课，等待家长确认 | ✅ | `POST /orders/:id/finish` | e2e §6 |
| 4.2.5 等级权益页（徽章/成长分/进度/抽佣/派单权重/规则表/变更记录） | ✅ | `GET /api/teacher/level` | e2e §7、page `/level` |
| 4.2.6 收入明细（课时费/服务费/实收）、余额、冻结、提现 | ✅ | `GET /api/teacher/income` + `/api/withdrawals` | e2e §8 |
| 4.2.7 排课日历（月/周视图）、时间冲突校验 | ✅ | `/api/teacher/calendar` + 下单时冲突校验 | page `/calendar` |
| 4.2.8 个人中心：资料、资质、评价管理、消息、客服、设置 | ✅ | `profile-page` / `reviews` / `messages` | page `/me` |

### 4.3 业务员端（`web/sales.html` + `web/assets/js/sales.js`，6 条路由）

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 4.3.1 专属推广二维码（家长/教员分流） | ✅ | `promotion_codes(target)` + 页面自绘二维码 | e2e §10 |
| 4.3.1 自动生成推广海报（含编号） | ✅ | canvas 绘制 PNG 下载 | 浏览器实测 |
| 4.3.2 业绩看板（今日/周/月：注册/留资/成交/GMV）+ 趋势图 | ✅ | `GET /api/sales/dashboard` | e2e §10、page `/perf` |
| 4.3.2 待结算 / 已发放奖励 | ✅ | `rewards.status` 聚合 | e2e §10 |
| 4.3.3 客户列表与状态（已注册/已发需求/已成交） | ✅ | `GET /api/sales/customers` | e2e §10 |
| 4.3.3 禁止查看客户完整手机号 | ✅ | `maskPhone` | sec §4 |
| 4.3.4 奖励明细六类 + 计算规则 | ✅ | `/api/sales/rewards?type=` | e2e §10 |
| 4.3.5 提现申请 / 记录 / 结算规则 | ✅ | `/api/withdrawals`（幂等） | e2e §8、page `/wallet` |

### 4.4 区域代理端（`web/agent.html` + `web/assets/js/agent.js`，5 条路由）

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 4.4.1 片区大盘（注册/今日订单/本月 GMV/活跃教员/活跃家长） | ✅ | `GET /api/agent/dashboard` | e2e §9、rules §9 |
| 4.4.1 业绩趋势图 + 供需热力简图 | ✅ | `trend`（单次 GROUP BY）+ `grid` 网格聚合 | page `/` |
| 4.4.2 新增业务员、启用/禁用、列表与排行、明细 | ✅ | `/api/agent/sales*` | e2e §9 |
| 4.4.3 片区订单（状态/时间筛选、详情、导出） | ✅ | `/api/agent/orders` + `/orders/export` | e2e §9、sec §4 |
| 4.4.4 收益构成（服务费分成+管理提成）、待结算/已结算/累计、月度账单、提现 | ✅ | `GET /api/agent/earnings` | e2e §9、page `/earnings` |
| 4.4.5 投诉工单处理、异常订单预警、一键上报平台 | ✅ | `/api/agent/complaints|risks` | e2e §9 |
| 4.4.6 平台公告、账号信息、密码修改 | ✅ | `/api/agent/announcements|profile` + `/auth/password` | page `/me` |

### 4.5 平台管理后台（`web/admin.html` + `web/assets/js/admin.js`，11 条路由）

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 4.5.1 数据总览（用户/日活/订单/GMV/营收、区域排行、供需热力、趋势） | ✅ | `GET /api/admin/overview` | e2e §16、page `/` |
| 4.5.2 家长账号管理（列表/筛选/禁用/详情） | ✅ | `/api/admin/users?role=parent` + `/toggle` | sec §2 |
| 4.5.2 教员账号管理（审核/驳回/禁用/等级手动调整） | ✅ | `/teachers/pending`、`/audit`、`/level` | e2e §12、rules §3 |
| 4.5.2 业务员账号管理（新增/禁用/归属调整） | ✅ | 代理建号 + `/users/:id/toggle` | e2e §9 |
| 4.5.2 区域代理账号管理（签约/绑定片区/保证金/禁用） | ✅ | `GET/POST/PUT /api/admin/agents`、`/toggle`、`/deposit` | e2e §16 |
| 4.5.3 全平台订单（筛选/导出/改价/关闭） | ✅ | `/api/admin/orders`、`/orders/export`、`/price`、`/close` | e2e §16 |
| 4.5.3 需求池管理 | ✅ | `/api/admin/demands`（分页）+ 清理超时报名 | e2e §16 |
| 4.5.3 退款工单处理 | ✅ | `/api/admin/refunds` + `/review` | e2e §13 |
| 4.5.4 规则配置中心 8 类规则全部后台可配 | ✅ | `rule_configs` 15 组 + `GET/PUT /api/admin/rules` | e2e §11、rules §1–§9 |
| 4.5.5 片区电子围栏地图划分 | ✅ | `regions.polygon` + 后台按中心点生成矩形围栏 | page `/agents` |
| 4.5.5 代理签约信息、保证金记录、考核指标配置 | ✅ | `agent_profiles` + `agent_deposits` + `agent_assessment` 规则 | e2e §16、rules §9 |
| 4.5.5 跨区域归属规则设置 | ⚠️ | 按需求 5.5 固定为「需求发布地址所在片区」，未做可切换（见 §3） | rules §2（恒等式） |
| 4.5.6 支付流水、担保台账、财务对账导出、平台营收统计 | ✅ | `GET /api/admin/finance` + 导出按钮 | e2e §14/§16 |
| 4.5.6 教员提现审核、业务员奖励审核、代理分成审核 | ✅ | `withdrawals/review`（含代理提现）、`rewards/settle` | e2e §8/§10/§16 |
| 4.5.7 异常订单（刷单/虚假打卡/异常定位） | ✅ | `risk_events` + `/risks/:id/handle` | e2e §12 |
| 4.5.7 差评申诉仲裁（撤销扣分/维持原判） | ✅ | `/api/admin/appeals/:id/arbitrate` | e2e §12 |
| 4.5.7 投诉工单终审、违规账号处罚 | ✅ | `/complaints/:id/close`、`/risks/:id/handle{punish}` | e2e §12 |
| 4.5.8 优惠券、活动、Banner、公告、协议文案 | ✅ | 运营工具四页签（增删改 + 停用） | e2e §15 |
| 4.5.9 管理员账号、操作日志、基础参数配置 | ✅ | `/api/admin/admins`、`/audit-logs`、`platforms` 规则 | e2e §16、sec §6 |
| 4.5.9 管理员账号：新建 / 自助改口令 / 删除 | ✅ | `POST`、`POST /api/auth/change-password`、`DELETE /api/admin/admins/:id`；后台顶栏「🔑 修改口令」+ 列表行内「删除」（软删除保留台账 / 零痕迹物理删除，不能删自己） | e2e §22（19 项） |
| 4.5.9 角色权限分配（细粒度权限矩阵） | ⚠️ | 采用内置六角色 RBAC，未提供逐权限勾选（见 §3） | sec §1 |

## 第 5 章 核心业务规则引擎

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 5.1 默认 5 公里推送、半径可调 | ✅ | `dispatch.max_radius_km` | rules §1 |
| 5.1 推送优先级 = 距离系数 × 等级权重 × 响应速度系数 | ✅ | `dispatchPriority()` | rules §1（9 位教员逐个验算） |
| 5.1 分批推送、先到先得 | ✅ | 唯一索引 + `INSERT OR IGNORE` | e2e §3、conc §2/§4 |
| 5.1 抢单超时 24 小时自动失效 | ✅ | `expireApplications()` 定时任务 + 后台手动触发 | rules §7 |
| 5.2 成长分公式（课时×2 + 加权好评 − 加权差评 − 违规） | ✅ | `applyGrowth()` + `review_scoring` | rules §4（逐项验算） |
| 5.2 等级配置表 Lv1–Lv5（抽佣/派单权重） | ✅ | `teacher_levels` 规则 | rules §2/§3 |
| 5.2 低于下限自动降级 | ✅ | 成长分变动后重算等级 + `level_logs` | rules §3/§4 |
| 5.2 违规扣分（爽约-50/虚假打卡-100/私单-200 且封禁） | ✅ | `growth_rules.violation` + `applyViolation()` | e2e §12 |
| 5.3 家长信用等级表 L0–L3 + 评价权重 | ✅ | `parent_credit` 规则 | rules §4 |
| 5.3 加减分项（完成+3/评价+2/无取消+5/4h 内取消-8/爽约-12/恶意差评-15） | ✅ | `credit_rules` + `applyCredit()` | rules §4 |
| 5.3 信用分 < 0 进入限制名单，禁发加急单 | ✅ | `parent_profiles.restricted` | market.js 校验 |
| 5.4 资金流：支付→担保→T+7 扣费→结算 | ✅ | `escrow_ledger` + `runSettlement()` | e2e §4/§6、hc |
| 5.4 代理收益 = 服务费×分成 + 实付×管理提成 | ✅ | `calcSplit()` | rules §2（逐项验算） |
| 5.4 业务员按实付阶梯计提，独立于代理分成 | ✅ | `salesTierRate()` | rules §2 |
| 5.4 结算周期（周结/月结/次月 5 日账单） | ✅ | `rewards.settle_period`、`agent_commission.bill_day` | e2e §10、page `/earnings` |
| 5.5 扫码注册归属业务员 → 片区代理 | ✅ | `bindUser()` + `bindings(source='scan')` | rules §8 |
| 5.5 自然注册按首次发布订单上课地址归属片区 | ✅ | `POST /api/demands` 内首次发单写 `bindings(source='natural')` | 本轮新增 |
| 5.5 跨区订单收益归需求地址所在片区代理 | ✅ | `createOrder()` 按订单片区取代理 | 本轮新增、rules §2 |

## 第 6 章 技术选型与开发要求

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 6.1 移动端 uni-app + Vue3 | ⚠️ | 原生 ESM + 自研设计系统（零构建），页面/路由结构与 uni-app pages 一一对应 | bc |
| 6.1 PC 后台 Vue3 + Element Plus | ⚠️ | 原生 ESM + 自研组件（`.pc-*`/`.table`/`.kpi`） | bc、page |
| 6.1 后端 NestJS / Spring Boot | ⚠️ | Node 原生 `http` + 自研路由，模块划分对应 NestJS module | e2e 全量 |
| 6.1 MySQL 8 + Redis | ⚠️ | SQLite（`schema.sql` 按 MySQL 8 风格编写，迁移章节见 DB 文档） | hc |
| 6.1 地图服务（腾讯/高德） | ⚠️ | 内置 haversine / 点在多边形 / 电子围栏算法 + CSS 示意地图 | rules §1 |
| 6.1 微信支付 | ⚠️ | 模拟网关；状态机/幂等/退款/台账为真实实现 | e2e §4/§13 |
| 6.1 IM 第三方 | ⚠️ | 站内消息（订单/支付/风控通知） | e2e §18/§19 |
| 6.2 抢单并发：100 并发无超卖、无重复接单 | ✅ | 事务 + 条件更新 + 唯一索引 | conc §2/§3/§4（100 并发实测） |
| 6.2 定位校验 500 米、阈值可配 | ✅ | `checkin.max_distance_m` | e2e §5 |
| 6.2 数据隔离：代理接口强制携带片区 ID、SQL 层拦截 | ✅ | `myRegion(ctx)` 注入 WHERE | sec §2、rules §6 |
| 6.2 金额全链路 Decimal，禁止浮点 | ✅ | 全站「分」整数 + `applyRate()` 四舍五入 | rules §2、hc |
| 6.2 支付/提现/分账幂等 | ✅ | `X-Idem-Key` + 状态机兜底 | e2e §4、conc §5 |
| 6.2 资金/规则/权限操作全程留日志 | ✅ | `audit_logs` + `GET /api/admin/audit-logs` | sec §6、e2e §12/§15/§17 |
| 6.3 安卓 8+/iOS13+/小程序、Chrome/Edge 兼容 | ⚠️ | Web 端已按 9:16 自适应（360/414/768px 无溢出）；安装包/小程序包需 uni-app 打包（未做） | bc |

## 第 7 章 非功能需求

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 7.1 首屏 ≤ 2s | ✅ | HTML 首字节 P95 ≤ 2.7ms | bench |
| 7.1 普通接口 ≤ 300ms | ✅ | P95 全部 ≤ 22.7ms（5000 单量级） | bench |
| 7.1 抢单接口 ≤ 500ms | ✅ | P95 ≤ 14.1ms（20 并发） | bench |
| 7.1 支持 1 万日活 / 5000 日订单 | ⚠️ | 5000 单量级实测通过；读并发容量需迁 MySQL+Redis 后复测 | bench + seed-bulk |
| 7.2 密码加密存储、敏感数据脱敏 | ✅ | scrypt 加盐 + 按角色脱敏 | sec §4 |
| 7.2 接口鉴权 | ✅ | Bearer Token + 角色白名单 + 每请求查库校验状态 | sec §1 |
| 7.2 防 SQL 注入 / XSS / CSRF | ✅ | 全参数化查询；`esc()` 输出转义；无 Cookie 会话 | sec §3/§5、bc（XSS 实测） |
| 7.2 核心数据每日备份、灾备恢复 | ✅ | `scripts/backup.mjs`（VACUUM INTO + 保留策略） | 实测生成快照 |
| 7.3 简洁商务风；家长端蓝、运营端青绿 | ✅ | `base.css` 令牌 + `data-brand` | bc、page |
| 7.3 多端视觉统一、交互一致 | ✅ | 共用设计系统与 `ui.js` | bc |
| 7.3 重要操作二次确认、异常友好提示 | ✅ | `confirmDialog` + `toast` + 空/错误态 | 浏览器实测 |
| 7.3 适配不同尺寸、无样式错乱 | ✅ | 360/414/768/1024/1440 五档零横向溢出 | bc |

## 第 8 章 风控与合规

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 8 首页显著位置展示合规提示；禁止宣传违规培训 | ✅ | `platforms.compliance_notice` 渲染在家长端首页 | page `/` |
| 8 教员入驻必须实名认证、证件人工核验 | ✅ | `audit_status` 人工审核 + 证件字段 | e2e §12 |
| 8 上课定位轨迹留存 | ✅ | `checkin_lat/lng/distance` + 每次打卡写风控事件 | e2e §5 |
| 8 紧急求助入口 | ✅ | `POST /api/orders/:id/sos`（最小可用版本） | e2e §19、浏览器实测 |
| 8 担保资金独立台账、不得挪用、提现审核合规 | ✅ | `escrow_ledger` 独立表 + hc 不变量校验 | hc |
| 8 隐私合规：权限申请明示、**用户可注销账号** | ✅ | `POST /api/auth/deactivate`（匿名化 + 保留交易流水） | e2e §18 |
| 8 反作弊：设备指纹、IP 频次限制，拦截批量注册/刷单 | ✅ | `guardRegistration()` + 下单频次标记 | rules §8 |
| 8 登录防暴力破解 | ✅ | `risk.login_fail_limit` / `login_lock_minutes` → 429 | sec §6 |

## 第 9 章 项目交付与验收

| 条目 | 状态 | 交付物 | 验证 |
| --- | --- | --- | --- |
| 9.1 全部源代码 | ✅ | `server/` + `web/` + `scripts/` + `test/` | — |
| 9.1 数据库设计文档 | ✅ | `docs/DATABASE.md`（37 表 + MySQL 迁移映射） | — |
| 9.1 接口文档 | ✅ | `docs/API.md`（114 个接口 + 错误码） | — |
| 9.1 部署文档、运维手册 | ✅ | `docs/DEPLOY.md`（含探活/巡检/备份/压测） | — |
| 9.1 各端安装包 / 小程序代码包 | ⛔ | Web 形态交付；打包需 uni-app 构建链（未做） | — |
| 9.1 后台管理员操作说明 | ✅ | `docs/ADMIN-GUIDE.md`（12 章 + 速查表 + 红线） | — |
| 9.2 开发阶段划分 | — | 计划性内容，不属功能需求 | — |
| 9.3 功能验收 | ✅ | 本矩阵逐条对照 | e2e 144 项 |
| 9.3 资金验收（全链路零误差） | ✅ | 两条恒等式逐单校验 + 担保台账闭合 | rules §2、hc |
| 9.3 并发验收（100 人抢单无超卖） | ✅ | 100 并发抢单/确认/支付幂等 | conc 22 项 |
| 9.3 兼容验收 | ✅ | 五档视口零溢出 | bc 16 项 |
| 9.3 安全验收 | ✅ | 越权/注入/脱敏/XSS/响应头/登录锁定 | sec 55 项 |

---

# 第二部分 《家教上门撮合平台 UI 界面设计说明书 V1.0》

## 第 1 章 设计概述

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 覆盖家长/教员/代理三类核心角色 | ✅ | 5 个端（含业务员端与后台） | bc |
| 核心操作前置、数据直观、操作路径最短 | ✅ | 首页双 Tab、卡片式信息层级、固定操作条 | 浏览器实测 |
| 家长端蓝色系、教员/代理青绿系 | ✅ | `data-brand="parent"` / `"op"` | bc |
| 9:16 移动端比例、底部导航固定、大色块主按钮 | ✅ | `.m-shell` aspect-ratio 9/16 + `.m-tabbar` + 48px 按钮 | bc |

## 第 2 章 家长端界面

| 页面 / 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 2.1 顶部定位栏（城市区域 + 消息入口） | ✅ | `.loc` + 重新定位按钮 + `bellHtml()` | page `/` |
| 2.1 双 Tab「我要找老师」「看附近教员」，默认发单页 | ✅ | `?tab=form\|near` | page `/` |
| 2.1 地图教员预览（距离、等级标签） | ✅ | `.map-board` + `.map-pin` 气泡 | page `/` |
| 2.1 需求发布快捷表单（科目/年级/方式/价格/时间） | ✅ | 首页表单 + `/demand` 完整页 | e2e §2 |
| 2.1 底部导航：首页、订单、消息、我的 | ✅ | `.m-tabbar` 四项 | bc |
| 2.2 订单状态栏（状态 + 教员确认状态） | ✅ | 状态徽标 + `.timeline` 履约进度 | page `/order/:id` |
| 2.2 教员信息卡（头像/姓名/等级/评分/科目标签） | ✅ | 详情页教员卡 | page `/order/:id` |
| 2.2 上课信息区（科目/时间/地址/单价） | ✅ | `kv()` 分组 | page `/order/:id` |
| 2.2 订单信息区（编号/下单时间/担保标识） | ✅ | 含 🛡 平台担保徽标 | page `/order/:id` |
| 2.2 底部操作栏：联系老师、取消订单双按钮 | ✅ | `.action-bar`（另有退款/确认/求助） | page `/order/:id` |
| 2.3 教员信息头部 | ✅ | `.card` 头部 | page `/review/:orderId` |
| 2.3 1-5 星星级评分 | ✅ | `.stars-input` | e2e §7 |
| 2.3 文字评论区 | ✅ | `textarea[data-content]` | page `/review/:orderId` |
| 2.3 标签评价区（正向/负向预设） | ✅ | `review_scoring.positive_tags/negative_tags` | page `/review/:orderId` |
| 2.3 底部固定提交按钮 | ✅ | `mountBar` | page `/review/:orderId` |

## 第 3 章 教员端界面

| 页面 / 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 3.1 顶部状态栏（上线开关 + 右上角服务管理） | ✅ | `.switch` + 🗂 服务管理入口 | 浏览器实测 |
| 3.1 数据概览卡（今日单量/本周课时/服务评分/等级徽章） | ✅ | `.hero` + `.grid .cell` | 实测接口与页面 |
| 3.1 附近家教订单列表（科目/年级/价格/距离 + 一键抢单） | ✅ | 按优先级降序（距离已体现） | e2e §3 |
| 3.1 我的服务状态（服务区域、可接科目、快捷开关） | ✅ | `serviceStatus` 卡片 | page `/` |
| 3.1 底部导航：接单、订单、收入、我的 | ✅ | `.m-tabbar` | bc |
| 3.2 订单状态栏（待确认/待上门/已完成） | ✅ | `orderStatusText(status,'teacher')` 角色化文案 | e2e §6 |
| 3.2 学生需求区（科目/方式/时间/预算/地址/备注） | ✅ | 详情页需求卡 | page `/order/:id` |
| 3.2 家长信息卡（姓名/信用等级/评价权重） | ✅ | `parent.credit` | page `/order/:id` |
| 3.2 底部操作栏：联系家长、确认接单 | ✅ | 联系家长 / 打卡 / 结束授课 / 求助 | page `/order/:id` |
| 3.3 等级头部卡（徽章/成长分/进度条） | ✅ | `.progress` + `levelBadge` | page `/level` |
| 3.3 当前权益三项（佣金/派单权重/展示权重） | ✅ | 佣金与派单权重取自规则；展示权重同源并注明 | page `/level` |
| 3.3 等级规则对照表 | ✅ | `levels[]` 全表高亮当前等级 | page `/level` |
| 3.3 底部「查看升级任务」 | ✅ | 引导至成长分获取明细 | page `/level` |

## 第 4 章 区域代理端界面

| 页面 / 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 4.1 顶部片区信息（片区名/代理等级/运营状态） | ✅ | hero 卡 | page `/` |
| 4.1 核心数据卡片四项 | ✅ | 本月订单/GMV/业务员/待结算 | e2e §9 |
| 4.1 片区业绩趋势图（柱状 + 折线组合） | ✅ | `.bars` 柱状 + 柱顶数值标签 | page `/` |
| 4.1 快捷功能入口四项（业务员/订单/家长/收益提现） | ✅ | `.quick-grid` | page `/` |
| 4.1 平台公告区 | ✅ | `notices` | page `/` |
| 4.2 搜索筛选栏（姓名/电话、在职/停用） | ✅ | 输入 + 状态 chip | page `/sales` |
| 4.2 业务员列表（头像/姓名/编号/本月业绩/有效订单/团队/状态） | ✅ | 表格行 | e2e §9 |
| 4.2 底部团队汇总（总业绩/活跃人数/本月新增） | ✅ | `.sub-bar` 三联汇总 | page `/sales` |
| 4.2 点击进入业务员详情 | ✅ | 详情 sheet（客户/奖励/订单） | page `/sales` |
| 4.3 收益总览（累计/待结算/已提现） | ✅ | 三卡 | e2e §9 |
| 4.3 本月收益构成 + 饼图 | ✅ | `conic-gradient` 环形图 + 图例 | page `/earnings` |
| 4.3 结算规则说明（账单日、提现开放日） | ✅ | 规则文案区 | page `/earnings` |
| 4.3 底部固定申请提现 | ✅ | `.action-bar` | page `/earnings` |
| 4.3 历史账单列表 | ✅ | `bills[]` 6 期 | e2e §9 |
| 4.4 风险数据卡片四项 | ✅ | 异常/刷单/投诉/高风险 | e2e §9 |
| 4.4 风险指数仪表盘 | ✅ | `.gauge` 指针按分数旋转 | page `/risk` |
| 4.4 异常订单列表（编号/类型/等级/原因） | ✅ | 含 🚨 紧急求助类型 | page `/risk` |
| 4.4 底部：导出风控报告 / 提交平台复核 | ✅ | 双按钮 | e2e §9 |

## 第 4 章补充：平台管理员界面（两张）

| 页面 / 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 总平台数据大盘 | ✅ | `/admin` 总览（KPI/区域排行/供需热力/14 天趋势/待办） | e2e §16、page |
| 平台规则配置页 | ✅ | `/admin#/rules` 15 组规则结构化表单，保存即热更新 | e2e §11 |

## 第 5 章 设计规范

| 条目 | 状态 | 实现 | 验证 |
| --- | --- | --- | --- |
| 5.1 主色 家长端 `#257BFF` | ✅ | `--brand-parent` | bc |
| 5.1 主色 运营端 `#10B98B` | ✅ | `--brand-op` | bc |
| 5.1 辅助 等级金 `#F5A623` | ✅ | `--gold`（`.level-badge`、`.btn-gold`） | page |
| 5.1 风险警示 `#F53F3F` | ✅ | `--danger` | page |
| 5.1 中性色 `#333/#666/#F5F7FA` | ✅ | `--ink / --ink-2 / --bg` | bc |
| 5.2 标题加粗 20–28px（页面标题、卡片大标题） | ✅ | 页面标题 20–22px、卡片大标题 20px | 计算样式实测 |
| 5.2 正文 14–16px | ✅ | `body` 14px | bc |
| 5.2 辅助文字 12px | ✅ | `.small` / `.tiny` | bc |
| 5.2 卡片式布局、圆角 16px、页边距 20px、模块间距 16px | ✅ | `--radius / --pad / --gap` | bc |
| 5.3 主按钮通栏 48px 高、圆角 24px | ✅ | `.btn` + `.btn-block` | bc |
| 5.3 列表项按压反馈、状态切换动效 | ✅ | `:active`、`transition` | page |
| 5.3 重要操作二次确认弹窗 | ✅ | `confirmDialog` | 浏览器实测（求助/取消/提现/禁用） |
| 5.3 加载 / 空 / 异常状态均有提示 | ✅ | `loadingHtml / emptyHtml / errorHtml` | bc |

---

# 3. 偏离与说明（逐条给出原因）

| # | 文档条目 | 差异 | 原因与影响 |
| --- | --- | --- | --- |
| 1 | 6.1 技术选型（NestJS / Vue3 / MySQL / Redis / uni-app） | 采用 Node 原生 http + SQLite + 原生 ESM | 目标机器无 Node/构建环境与外部数据库；为保证**可直接运行与验收**而选零依赖实现。模块划分、表结构、页面结构均按文档形态组织，迁移路径见 `README` §2 与 `docs/DATABASE.md` §10 |
| 2 | 6.1 地图 / 支付 / IM 第三方服务 | 内置算法 + 模拟网关 + 站内消息 | 无服务商密钥。几何计算、支付状态机、幂等、退款、台账均为真实实现，替换适配层即可接入 |
| 3 | 4.5.5 跨区域归属规则设置 | 固定按需求 5.5 执行，未做可切换 | 需求 5.5 已明确规定单一规则（收益归需求地址片区），做成可切换易与 5.5 冲突；如确需可切换，加一个 `agent_commission.cross_region_rule` 枚举即可 |
| 4 | 4.5.9 角色权限分配 | 内置六角色 RBAC，无逐权限矩阵 | 文档 2.1 已固定五类角色 + 管理员的权限边界，细粒度权限矩阵属增强项；现有角色校验已覆盖 2.2 全部红线 |
| 5 | 7.1 支持 1 万日活 / 5000 日订单 | 5000 单量级实测通过，读并发未验证 | 单进程 SQLite 无法模拟生产读并发；需迁 MySQL + Redis 后按 `scripts/bench.mjs` 复测 |
| 6 | 9.1 各端安装包 / 小程序代码包 | 未提供 | 需 uni-app 构建链打包（当前刻意零构建） |
| 7 | 3.3 首页展示权重 | 与派单权重同源展示 | 文档未定义独立字段；已在页面注明「与派单权重同源」 |
| 8 | 1.2 教员会员、广告位；1.3 二期五项 | 未实现 | 文档明确为二期迭代范围 |

---

# 4. 一键验证

```bash
node server/seed.js --reset        # 初始化演示数据
node server/index.js               # 启动服务（另开窗口）

node test/e2e.test.js              # 功能验收        144 项
node test/rules.test.js            # 业务规则引擎     51 项
node test/security.test.js         # 安全验收         55 项
node test/concurrency.test.js      # 并发验收         22 项
node scripts/bench.mjs             # 性能验收         16 项
node scripts/browser-check.mjs     # 兼容 + XSS       16 项
node scripts/healthcheck.mjs       # 数据一致性       12 项
```

合计 **316 项断言**。容量验证与压测数据见 `README.md` §8。