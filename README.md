# 家教上门撮合平台

滴滴式「家教上门撮合」全栈系统，严格依据两份文档实现：

- 《家教上门撮合平台项目开发需求说明书 V1.0》（业务逻辑 / 功能明细 / 规则引擎 / 技术要求 / 验收标准）
- 《家教上门撮合平台 UI 界面设计说明书 V1.0》（五端界面结构 / 色彩与布局规范 / 交互规范）

覆盖 **5 个角色端**：家长端、教员端、业务员端、区域代理端（移动端 9:16）、平台管理后台（PC）。

---

> **想看"两份文档的每一条要求是否都实现了"** → 直接看 [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md)：
> 逐条列出需求说明书（第 1–9 章）与 UI 说明书（第 1–5 章）的每个功能点，标注实现位置、验证脚本，
> 并单独列出 8 条偏离项与原因。

> ⚠️ **页面打不开？** 本仓库按需求书 6.1 的正式实现是 **NestJS + MySQL + Redis + Vue3/uni-app**，需要先启动后端。
> 双击项目根目录的 **`start.bat`**（首次会自动建库、灌演示数据、编译后端，约 20 秒），
> 窗口保持打开，然后访问：
>
> | 入口 | 地址 |
> | --- | --- |
> | PC 管理后台（Vue3 + Element Plus） | http://localhost:4300/admin-vue/ |
> | 移动四端（uni-app H5，家长/教员/业务员/代理） | http://localhost:4300/m/ |
> | 旧 5 端 UI（参考实现蓝本，同一后端） | http://localhost:4300/parent · /teacher · /sales · /agent · /admin |
> | 接口健康检查 | http://localhost:4300/api/health |
>
> 演示账号口令均为 `a123456`：管理员 `13900000001`、西湖代理 `13900000010`、业务员 `13900000101`、
> 教员 `13900000201`、家长 `13900000301`。停止服务：在该窗口按 `Ctrl+C` 或直接关闭窗口。
>
> 手动启动等价命令：`tools\node\node.exe tools\run.mjs`（前台常驻）；
> `npm run serve:detach` 为后台守护版，`npm run serve:status` 查看状态，
> `npm run serve:stop` 停止。

---

## 1. 快速开始

系统**零第三方依赖**，不需要 `npm install`，也不需要 MySQL/Redis 等外部服务。

```bash
# 环境要求：Node.js >= 22.5（内置 node:sqlite）
node --version        # 需 >= v22.5.0

# 1) 生成演示数据（会重建数据库）
node server/seed.js --reset

# 2) 启动服务
node server/index.js
#    或者 npm start
```

打开 <http://localhost:4173> 即为系统入口导航页，可进入五个端。

```bash
# 3) 跑端到端验收测试（需先启动服务）
node test/e2e.test.js     # 或 npm test
```

### 演示账号（口令统一 `a123456`）

| 角色 | 手机号 | 说明 |
| --- | --- | --- |
| 平台管理员 | 13900000001 | PC 管理后台全部权限 |
| 区域代理（西湖） | 13900000010 | 片区内数据隔离 |
| 区域代理（滨江） | 13900000011 | 分成比例与西湖不同 |
| 业务员 | 13900000101 | 团队业绩冠军，含日/周冠军奖 |
| 教员（Lv5 名师） | 13900000201 | 成长分 2350，抽佣 6% |
| 教员（Lv1 见习） | 13900000204 | 成长分 160，抽佣 18% |
| 家长（L3 高信用） | 13900000304 | 评价权重 1.6 |
| 家长（L0 新用户） | 13900000301 | 信用分 100，评价权重 0.6 |
| 待审核教员 | 13900000212 | 用于演示后台资质审核 |

家长端 / 教员端也支持「手机号 + 验证码」登录（开发环境接口直接回传验证码）。

---

## 2. 技术栈与选型说明

| 层 | 本项目实现 | 需求书要求 | 说明 |
| --- | --- | --- | --- |
| 后端服务 | Node.js 22 原生 `http` + 自研轻量路由 | NestJS（推荐）或 Spring Boot | 本机无 Node/构建环境，为保证**可直接运行与验收**，用零依赖原生实现；模块按 `modules/*` 划分、`core/*` 提供横切能力，与 NestJS 的 module/provider 结构一一对应，迁移时逐个 module 搬即可 |
| 数据库 | SQLite（`node:sqlite` 内置模块） | MySQL 8.0 + Redis | 表结构按 MySQL 8 语法风格编写（`server/core/schema.sql`），全部使用 `INTEGER/TEXT/REAL`，迁移 MySQL 只需替换连接层；Redis 的用途（缓存/分布式锁/排行榜）在单进程下用「内存缓存 + SQLite 事务 + 唯一索引」等价实现 |
| 移动端 | 原生 ES Module + 自研设计系统（9:16） | uni-app + Vue3 + Vite | 零构建产物，浏览器直接打开即可验证 UI；页面结构（`.m-shell` + 哈希路由 + 每端独立 `*.js`）与 uni-app 的 pages 目录一一对应，可直接作为小程序/APP 的 UI 规范与逻辑蓝本 |
| PC 后台 | 原生 ES Module + 表格/表单组件 | Vue3 + Element Plus | 同上 |
| 地图 | 内置坐标系与距离/围栏算法 + CSS 示意地图 | 腾讯/高德地图 | 所有几何计算（Haversine、点在多边形、片区归属、500m 打卡阈值）为真实实现，接入地图 SDK 时只替换渲染层 |
| 支付 | 模拟微信支付网关（担保交易台账真实记账） | 微信支付商户版 | 下单/回调/退款/幂等的流程与状态机为真实实现，替换 `payOrder` 内的下单调用即可对接真实商户 |
| IM | 站内消息（订单/支付/风控通知） | 融云 / 环信 | 预留 `messages` 表与通知函数 |


### 2.1 已交付的「需求书技术选型」版本（NestJS + MySQL + Redis + Vue3/uni-app）

除参考实现外，仓库内另有**按需求书 6.1 选型完成的正式实现**，与参考实现共存、共享同一套 HTTP 契约：

| 层 | 目录 | 技术栈 | 单端口访问 |
| --- | --- | --- | --- |
| 后端 API | `apps/api-nest/` | NestJS 10 + TypeScript + TypeORM(原生 SQL) + MySQL 8 + Redis | `http://localhost:4300/api/*` |
| PC 管理后台 | `apps/web-admin/` | Vue3 + Vite + Element Plus + vue-router（18 个页面，含需求池/管理员账号/权限矩阵/区域管理） | `http://localhost:4300/admin-vue/` |
| 移动四端 | `apps/web-mobile/` | uni-app（Vue3 语法；同一份源码产出 H5 + 微信小程序，9 个页面：家长/教员+钱包提现/业务员+奖励明细/代理+客诉） | `http://localhost:4300/m/` |
| 既有 5 端 UI | `web/` | 零构建原生 ESM（参考实现，作为 UI 蓝本保留） | `http://localhost:4300/parent` 等 |

一键门禁（自动起停 MySQL 3307 / Redis 6380 / NestJS 4300）：

```bash
npm run nest:gate:p6        # 既有 e2e 全套 §1–§20 → 153/153
npm run nest:gate:p7        # 并发验收（100 并发抢单/幂等支付/台账闭合）→ 23/23
npm run nest:gate:races     # 资金并发对抗回归（行锁/状态守卫/分账恒等式/幂等重放）→ 27/27
npm run nest:gate:privacy   # 隐私与账号安全（地址·坐标脱敏 / health 分级 / 改密与令牌失效）→ 38/38
npm run nest:gate:permissions # 细粒度权限矩阵（授予/撤销即时生效、admin 不可被移除）→ 17/17
npm run nest:bench          # 性能基线（12 个读接口 + 抢单写路径，输出 p50/p95/p99/QPS）→ docs/PERF.md
npm run nest:gate:p9        # SQLite → MySQL 迁移 + 迁移后一致性巡检 → 37 表一致 / 12/12
npm run web:admin:check     # PC 后台（Vue3+Element Plus，18 页）→ 38/38
npm run web:mobile:check    # 移动四端+消息中心（uni-app H5 + 小程序，10 页）→ 41/41
```

前端构建（需联网安装依赖，产物被 `.gitignore` 忽略）：

> 以下命令在 bash / zsh / PowerShell 7+ 里可加 `&&` 串起来；**Windows PowerShell 5.1 不支持 `&&`，请逐行执行**。

```bash
npm run web:admin:install
npm run web:admin:build                                  # → apps/web-admin/dist
npm run web:mobile:install
npm run web:mobile:build                                 # → apps/web-mobile/dist/build/h5
npm run web:mobile:build:mp                              # → apps/web-mobile/dist/build/mp-weixin（可导入微信开发者工具）
```

接口文档、追溯矩阵与汇总门禁：
```bash
npm run api:doc        # 从控制器源码生成 docs/API-NEST.md 的接口总表（142 路由 / 16 控制器）
npm run api:doc:check  # 文档与代码是否一致（退出码 1 = 已过期）
npm run trace:check    # 追溯矩阵引用的接口/脚本是否真实存在（142/142 覆盖）
npm run ui:check       # UI 说明书 ↔ 新前端页面/路由/菜单是否一致（后台 18 页 + 移动 10 页）
npm run docs:check     # 文档 shell 写法（围栏成对、PS 块禁 && 与裸 curl、Windows 文档 && 必须有 PS 提示）
npm run windows:check  # Windows 脚本（批处理 CRLF/无 BOM/含中文必 chcp 65001；.ps1 含中文必 BOM、禁 &&、PS 5.1 语法解析）
npm run ci             # 静态门禁：tsc + 接口 + 追溯 + Windows 脚本 + 文档写法（约 7 秒）
npm run ci:quick       # 加跑 verify-nest + e2e + security + rules（约 8 分钟）
npm run ci:full        # 全部 24 步门禁（约 4 分钟 = 静态 12 步 + 业务 12 步）
```

## 4. 容器化部署与 CI

**容器化（Docker Compose）**：`deploy/Dockerfile` + `deploy/docker-compose.yml`（MySQL 8 / Redis 7 / 应用镜像），
一键起服与自检清单见 [`docs/DEPLOY-CONTAINERS.md`](docs/DEPLOY-CONTAINERS.md)。
> 注意：**本机没有 Docker 守护进程**（BIOS 关闭 VT-x → WSL2 / Hyper-V 不可用），容器运行时未在本机实测。
> 已完成的等价校验：`npm run deploy:check`（严格 YAML + 路径/端口/安全开关一致性）、
> `npm run deploy:schema`（**官方 compose-spec JSON Schema**，固定 commit 随仓库提交，负向验证退出码 1）、
> `npm run image:check`（镜像运行阶段 COPY 布局 vs `main.ts` 静态托管约定）、
> `npm run image:runtime`（**Dockerfile 运行阶段 + 生产模式真起服**：`NODE_ENV=production` 下验证 /api/health、HEALTHCHECK 原始命令、三个静态站点、验证码不回显（含仅靠 NODE_ENV 的第二道防线）、缺 `AUTH_SECRET` 拒绝启动，共 32 项）。

**CI（GitHub Actions）**：`.github/workflows/ci.yml`
- `static` job：`node tools/ci-full.mjs --static`（tsc / 接口文档漂移 / 追溯矩阵 / UI 追溯 / 部署配置 / 镜像布局 / 官方 actionlint 与证据映射）
- `integration` job：GitHub 服务容器起 MySQL 8 + Redis 7 → 建表灌数据 → 起 NestJS → 跑
  e2e 153 / security 53 / rules 50 / races 27 / privacy 38 / concurrency 23 / 巡检 12 → 再构建两套前端并校验 38 + 41；细粒度权限矩阵 17；镜像运行契约 32
- 触发：push 到 main/master、PR、手动 `workflow_dispatch`
- workflow 本身由**官方 `actionlint v1.7.12` + `shellcheck 0.11.0`** 校验（零告警）；本机另用 `npm run ci:full` 跑完整 24 步作为 Runner 命令的等价证据

启用方式（需仓库远端与推送凭据）：
```powershell
node tools/check-deploy.mjs                 # 本地先过静态校验（已入库，随 ci 一起跑）
git remote add origin https://github.com/<owner>/<repo>.git

# 推荐：一条命令完成「推送 + 等 Actions 跑完 + 打印失败 job 日志」
$env:GH_TOKEN = "<你的 classic PAT>"        # 必须同时具备 repo + workflow 两个 scope
npm run git:push
```

> **⚠️ PAT 必须带 `workflow` scope**：GitHub 不允许用缺该 scope 的 token 通过 HTTPS 推送
> `.github/workflows/*`（会报 `refusing to allow a Personal Access Token to create or update workflow`）。
> token 只从环境变量读取，脚本会把它作为单次 HTTP 头使用，**不会写进 `.git/config`**；
> 若远端 URL 里已经带了凭据，脚本会自动改成干净地址。
>
> 手动等价写法（同样不落盘）：`git -c http.https://github.com/.extraheader="AUTHORIZATION: basic <base64(x-access-token:PAT)>" push -u origin main`

> 迁移全过程、逐阶段门禁与偏离记录见 `docs/MIGRATION.md`；
> 新后端接口清单见 [`docs/API-NEST.md`](docs/API-NEST.md)；需求逐条追溯见 [`docs/TRACEABILITY-NEST.md`](docs/TRACEABILITY-NEST.md)；
> 性能基线见 [`docs/PERF.md`](docs/PERF.md)。
---

## 3. 目录结构

```
server/
  index.js              服务入口：静态资源 + API 路由 + 定时结算
  seed.js               演示数据（用真实业务函数生成，保证账目自洽）
  core/
    schema.sql          全部数据表（42 张，MySQL 8 兼容风格）
    db.js               SQLite 封装 + 事务
    http.js             统一响应 / 错误模型 / 请求体解析
    router.js           路由 + 鉴权 + 角色白名单 + 幂等
    auth.js             scrypt 口令、HMAC Token、验证码
    config.js           规则配置中心读写（带缓存）
    defaults.js         13 组规则默认值
    rules.js            ★ 业务规则引擎（派单/等级/信用/分佣/取消）
    ledger.js           担保账户台账 + 钱包冻结/解冻/结算
    present.js          视图组装 + 按角色脱敏
    geo.js              距离/电子围栏/手机号与地址脱敏
    idempotency.js      资金接口幂等
    audit.js            操作留痕 + 站内通知
    ids.js              订单号/流水号/时间工具
  modules/
    auth.js             认证、字典、地址、消息、优惠券、收藏、客诉、上传
    market.js           家长端：首页、教员广场、需求发布、抢单、确认下单
    orders.js           ★ 订单生命周期：支付→打卡→授课→确认→冻结→结算→退款→评价
    teacher.js          教员端：入驻、接单、服务、订单、等级权益、收入、日历
    wallet.js           钱包与提现（三端共用）
    sales.js            业务员端：推广码、业绩、客户、奖励
    agent.js            区域代理端：片区大盘、业务员、订单、收益、风控、客诉
    admin.js            管理后台：总览、用户、订单、规则、代理、财务、风控、运营
web/
  index.html            系统入口导航
  parent.html / teacher.html / sales.html / agent.html / admin.html
  assets/css/base.css   ★ 设计系统（严格按 UI 说明书第 5 章）
  assets/js/api.js      API 客户端（鉴权/错误/幂等键）
  assets/js/ui.js       转义、金额、toast、弹层、哈希路由
  assets/js/*.js        各端页面逻辑
docs/
  API.md                接口文档
  DATABASE.md           数据库设计文档
  RULES.md              业务规则引擎说明（含计算示例）
  DEPLOY.md             部署与运维手册
  ADMIN-GUIDE.md        后台管理员操作说明（需求 9.1 交付物）
  SECURITY.md           安全与权限设计说明（需求 7.2 / 9.3 安全验收）
  TRACEABILITY.md       ★ 需求追溯矩阵（两份文档逐条 → 实现 → 验证）
  MIGRATION.md          技术选型迁移记录（NestJS + MySQL 8 + Redis 进展与计划）
apps/
  api-nest/             NestJS 10 + TypeORM + MySQL 8.4 + Redis 5（迁移中，15 项切面验证通过）
tools/
  setup-services.ps1    一次性安装本地 MySQL 8.4 + Redis 5（便携版）
  verify-nest.mjs       NestJS 后端联调验证（自动起停依赖，15 项断言）
  verify-nest.ps1       同上（PowerShell 版，需在独立终端运行）
scripts/
  backup.mjs            数据备份脚本（VACUUM INTO 热备 + 上传文件 + 保留策略）
  bench.mjs             性能验收脚本（接口 P50/P95 与需求 7.1 阈值对比）
  browser-check.mjs     浏览器验收（多尺寸横向溢出 + XSS 渲染实测）
  healthcheck.mjs       数据一致性巡检（12 项资金与状态不变量，可挂定时任务）
  seed-bulk.mjs         大数据量压测数据集（默认 2000 家长 / 200 教员 / 5000 订单）
test/
  e2e.test.js           端到端验收测试（156 项）
  rules.test.js         核心业务规则专项验证（51 项）
  security.test.js      安全验收（越权 / 注入 / 脱敏 / XSS / 响应头 / 登录锁定，55 项）
  concurrency.test.js   并发验收（100 并发抢单与幂等，22 项，自动清理测试数据）
```

---

## 4. 功能实现对照（需求书第 4 章）

### 4.1 家长端
| 需求 | 实现 |
| --- | --- |
| 手机号验证码 / 微信一键登录、协议、实名、多地址 | `POST /api/auth/send-code|login|wechat|realname`，`/api/addresses` CRUD |
| 首页定位片区、双入口、Banner/公告/优惠券、底部四导航 | `GET /api/parent/home` |
| 需求发布（学段/科目/仅上门/地址/多时段/预算/特殊要求/加急） | `POST /api/demands`，加急费读规则配置 |
| 需求可编辑 / 暂停 / 撤销 | `PUT /api/demands/:id`、`POST /api/demands/:id/action` |
| 教员广场地图+列表、六维筛选 | `GET /api/parent/teachers`（科目/价格/等级/距离/性别/排序/在线） |
| 教员详情、收藏、直接预约下单 | `GET /api/parent/teachers/:id`、`/api/my/favorites`、`POST /api/orders/from-service` |
| 订单六状态、详单、联系/取消/退款/确认完成 | `GET /api/parent/orders`、`POST /api/orders/:id/{pay,cancel,refund,confirm}` |
| **紧急求助入口（上门安全）** | 家长 / 教员在订单页一键求助 → `POST /api/orders/:id/sos` 生成 high 级风控工单，通知全体管理员 + 片区代理 + 订单另一方，含求助定位距离；同单 10 分钟内防重复 |
| 上课前 1 小时推送提醒 | `runLessonReminders()` 定时任务（阈值规则 `notify.lesson_remind_minutes`），家长与教员双端站内通知，`remind_sent` 保证不重复 |
| 微信支付、担保说明、消费/退款记录、**发票申请入口** | `payOrder` + `escrow_ledger`；`GET /api/wallet`（含可开票订单与申请单）+ `POST /api/invoices` |
| 72 小时评价、1-5 星、预设标签、权重 | `POST /api/orders/:id/review`，权重取家长信用等级 |
| 个人中心：信用等级、信用分、规则说明、优惠券、客服、退出 | `GET /api/parent/profile` |

### 4.2 教员端
| 需求 | 实现 |
| --- | --- |
| 入驻：身份选择、证件、授课设置、审核状态/驳回原因 | `POST /api/teacher/apply`、`GET /api/teacher/profile` |
| 在线/离线开关、数据概览、附近订单、一键抢单 | `POST /api/teacher/online`、`GET /api/teacher/dashboard`、`GET /api/teacher/nearby-demands`、`POST /api/demands/:id/apply` |
| 我的服务：上架/下架/编辑 | `/api/teacher/services*` |
| 订单五状态、上门打卡（定位校验）、结束授课 | `GET /api/teacher/orders`、`POST /api/orders/:id/{checkin,finish}` |
| 等级权益页：成长分、进度、抽佣、派单权重、规则表、变更记录 | `GET /api/teacher/level` |
| 收入：课时费/服务费/实收、可提现、冻结 7 天、提现审核 | `GET /api/teacher/income`、`/api/withdrawals` |
| 排课日历（月/周视图）、时间冲突校验 | `GET /api/teacher/calendar`、下单时冲突校验 |
| 个人中心：资料、资质、评价管理、申诉 | `PUT /api/teacher/profile`、`POST /api/teacher/reviews/:id/appeal` |

### 4.3 业务员端
推广二维码（家长/教员分流）、推广海报、业绩看板（日/周/月：注册/留资/成交/GMV）、客户管理（状态 + 手机号脱敏）、奖励明细（注册奖/留资奖/成交提成/日冠军/周冠军/新人首单）、提现申请与记录 —— 全部实现于 `server/modules/sales.js` + `web/sales.html`。

### 4.4 区域代理端
片区大盘（总注册/今日订单/本月 GMV/活跃教员/活跃家长/供需热力简图/趋势）、业务员管理（新增/启用禁用/排行/明细）、片区订单（筛选/脱敏/导出 CSV）、收益结算（服务费分成+管理提成、待结算/已结算/累计、月度账单、提现）、客诉与风控（工单处理、异常预警、一键上报）、公告与设置 —— 全部实现于 `server/modules/agent.js` + `web/agent.html`。

### 4.5 平台管理后台
数据总览、用户管理（含教员审核/等级调整）、订单与需求管理（筛选/**导出 CSV（含分账明细）**/改价/关闭/需求池超时报名清理）、**规则配置中心（15 组全部可改，热生效）**、区域与代理管理（电子围栏/签约/**编辑**/**启用禁用**/**保证金台账**/**考核完成度**）、财务资金（担保台账/提现审核/奖励结算/对账）、风控与审核（异常订单/差评仲裁/投诉终审/违规处罚）、运营工具（Banner/公告/优惠券**编辑与停用**、协议文案）、系统设置（管理员/操作日志） —— 全部实现于 `server/modules/admin.js` + `web/admin.js`。

---

## 5. 关键实现说明

### 5.1 抢单并发安全（需求 6.2）
- `applications` 表对 `(demand_id, teacher_id)` 建唯一索引，抢单用 `INSERT OR IGNORE`，`changes === 0` 即判定重复接单。
- 家长确认用条件更新占位：`UPDATE demands SET status='matched' WHERE id=? AND status='published'`，只有一次能成功，失败返回 `409 CONFLICT`。
- 全程包在 `BEGIN IMMEDIATE` 事务中，等价于 Redis 分布式锁的原子语义。
- 验收：同一教员 20 次并发抢单 → 成功 1 次；家长 2 次并发确认 → 成功 1 次（`test/e2e.test.js` 已断言）。

### 5.2 金额零误差（需求 6.2）
- 全链路金额一律为「分」的 `INTEGER`，`applyRate()` 用 `Math.round` 收敛，杜绝浮点。
- 两条恒等式由测试逐单校验：
  - `订单实付 = 教员实收 + 平台服务费`
  - `平台服务费 = 代理分成 + 业务员提成 + 平台净收入`
- 担保账户台账 `escrow_ledger` 逐笔记录方向与余额，任意时刻 `SUM(in) - SUM(out)` 必等于「已支付但未结算/未退款」的订单金额之和。

### 5.3 定位校验（需求 6.2）
`haversineKm()` 计算打卡点与上课地址直线距离，超过规则配置 `checkin.max_distance_m`（默认 500 米）直接拦截，并自动写入 `risk_events` 风控事件。

### 5.4 数据隔离（需求 6.2 / 2.2）
代理端所有接口先取 `agent_profiles.region_id` 作为强制过滤条件（`myRegion(ctx)`），越权访问返回 403；手机号、身份证、详细地址按角色脱敏（`geo.js` 的 `maskPhone/maskIdCard/maskAddress`）。

### 5.5 幂等（需求 6.2）
支付、提现接口接受 `X-Idem-Key`（前端 `idemKey()` 生成），命中重复键直接回放上次响应；即使不带幂等键，订单状态机本身也保证重复支付不会二次入账。

### 5.6 定时任务（需求 5.1 / 4.1.5）
服务启动后每分钟执行一次批处理（`server/index.js`）：

| 任务 | 逻辑 | 手动触发 |
| --- | --- | --- |
| T+N 结算放款 | `status='completed'` 且 `settle_at <= now` 的订单解冻入账，跳过被风控冻结结算的订单 | `POST /api/admin/settlement/run`（可带 `force`） |
| 抢单超时失效 | 报名超过 `dispatch.grab_confirm_timeout_hours` 仍未确认 → 置为 `expired` 并通知双方 | `POST /api/admin/applications/expire` |
| 上课前提醒 | 距开课不足 `notify.lesson_remind_minutes`（默认 60）且未提醒的待上课订单，向家长与教员推送站内提醒，`remind_sent` 防重复 | `POST /api/admin/reminders/run` |

### 5.7 反作弊（需求第 8 章）
设备指纹（`X-Device-Fp`）+ 注册 IP 双维度频次限制拦截批量注册；同一家长 24 小时高频下单自动标记刷单并冻结该单结算。阈值全部在规则配置中心 `risk` 组可调，命中即写 `risk_events` 并在后台「风控与审核」可见。

### 5.8 数据备份（需求 7.2）
`node scripts/backup.mjs` 使用 `VACUUM INTO` 在线生成一致性快照，连同 `data/uploads/` 落到 `data/backups/<时间戳>/`，并按保留份数清理旧备份。

### 5.9 生产就绪加固（需求 7.2）
- **安全响应头**：全站下发 CSP、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`。
- **登录失败锁定**：按「IP + 账号」连续失败达阈值（默认 5 次）锁定 15 分钟，返回 `429 LOGIN_LOCKED`，阈值由规则配置中心驱动。
- **健康检查**：`GET /api/health` 返回版本、运行时长与数据库连通性（异常时 503），可接负载均衡探活。
- **数据一致性巡检**：`node scripts/healthcheck.mjs` 校验 12 项不变量（担保台账、逐单分账、钱包流水、冻结池、孤儿数据、状态一致性等），异常时退出码非 0。

### 5.10 隐私合规：账号注销（需求第 8 章）
`POST /api/auth/deactivate` 做匿名化处理而非物理删除：清除手机号、微信 openid、姓名、身份证、设备指纹、注册 IP 与地址，
撤销在招需求、下架服务、禁用业务员/代理档案，**保留订单与资金流水用于合规审计**。
账号进入 `disabled` 后原令牌立即失效；有未完结订单或冻结资金时拒绝注销并给出明确原因。

### 5.11 规则可配置（需求 4.5.4）
15 组规则存于 `rule_configs`，`setRule()` 后立即失效缓存，所有计算函数（抽佣、派单权重、成长分、信用分、阶梯提成、冻结天数、打卡阈值）实时读新值，无需重启。

---

## 6. 验收对照（需求书第 9 章）

| 验收项 | 结果 |
| --- | --- |
| 功能验收 | 5 端功能全部实现，`test/e2e.test.js` 156 项断言通过；逐条对照见 `docs/TRACEABILITY.md` |
| 资金验收 | 下单→支付→分账→冻结→结算→提现全链路跑通，两条恒等式零误差 |
| 并发验收 | 20 并发抢单仅 1 成功、2 并发确认仅 1 成功，无重复接单 |
| 兼容验收 | 移动端 9:16 自适应 + PC 后台响应式栅格，Chrome/Edge 正常 |
| 安全验收 | `test/security.test.js` 55 项：鉴权基线、IDOR 横向越权、SQL 注入、字段脱敏、XSS 载荷入库、安全响应头（CSP/X-Frame-Options 等）、登录失败锁定；`scripts/browser-check.mjs` 真实浏览器验证 XSS 未被执行。详见 `docs/SECURITY.md` |
| 并发验收 | `test/concurrency.test.js` 22 项：100 个教员并发抢单（229ms）、100 次并发确认仅 1 笔订单、30 次并发支付仅 1 条流水、事后账目一致性 |
| 兼容验收 | `scripts/browser-check.mjs`：4 个移动端页面 × 360/414/768px、后台 × 1024/1440px 横向溢出均为 0 |
| 性能验收 | `node scripts/bench.mjs` 16 项指标全部达标（本机 localhost 基线，见 §7 说明） |

运行 `node test/e2e.test.js` 可复现全部结论。

核心业务规则另有专项验证脚本 `node test/rules.test.js`（51 项断言），逐项演示：

| 规则 | 验证方式 |
| --- | --- |
| 派单匹配公式 | 逐个教员核对 `优先级 = 距离系数 × 等级权重 × 响应速度系数`，误差 < 0.0002；并校验广场按优先级降序 |
| 分账金额 | 真实下单 → 支付，逐项核对服务费 / 教员实收 / 代理分成 / 业务员提成 / 平台净收入，并校验两条恒等式 |
| 等级驱动抽佣 | 后台把教员从 Lv5 调到 Lv1，新订单服务费由 6% 变 18%（¥12.00 → ¥36.00），再还原 |
| 成长分 | 有效课时 +2、5 星好评 +round(5 × 家长评价权重)，实际成长分变化与公式完全一致；家长信用分同步上升 |
| 抢单原子性 | 同一教员 30 次并发抢单仅 1 次成功、29 次判重复；报名表仅 1 条；3 次并发确认仅 1 次成功，其余返回 409 |
| 区域数据隔离 | 西湖代理只能看到本片区订单；跨区操作业务员/风控事件、修改平台规则、审核教员均返回 403；手机号与地址脱敏 |
| 抢单超时失效 | 把 `grab_confirm_timeout_hours` 调为 0 后触发清理，报名置为 `expired` 且不可再被确认；阈值可还原 |
| 反作弊频次限制 | 同一设备指纹连续注册：前 2 个放行、第 3 个被拦截，并写入 high 级风控事件 |
| 代理考核指标 | 下调 GMV 目标后代理首页完成度实时上升，还原后回落（配置驱动） |
| 发票申请与受理 | 家长逐单申请开票（重复申请、企业缺税号、他人订单均被拒）→ 后台开票回写电子发票地址 / 驳回回写原因 → 家长端状态同步、被驳回后可重新申请 |

---

## 7. 说明与边界

- **本次不开发（需求书明确二期）**：实时轨迹追踪、在线视频授课、电子合同、多级分销、AI 智能匹配。上门安全章节的「紧急求助入口」已按**最小可用版本提前实现**（一键求助 + 风控工单 + 多方告警 + 定位距离留痕）；完整的轨迹留存与外部应急联动仍属二期。
- 支付为**模拟网关**（`payments.trade_no` 由系统自生成），流程、幂等、退款、担保台账均为真实实现；对接真实微信支付只需替换 `modules/orders.js` 的 `payOrder()` 下单调用与回调验签。
- 优惠券已实现领取与展示，下单时可抵扣（`couponId` 在创建订单时直接减免，保证台账闭合）。
- 短信验证码在开发环境通过接口返回 `devCode` 便于演示，生产环境应接入短信网关并移除该字段。
- 单进程 SQLite 适合初期 1 万日活以内的验收与试运行；上量时按第 2 节说明迁移 MySQL + Redis（`schema.sql` 已按 MySQL 8 风格编写）。

---

## 8. 容量验证（需求 7.1）

`scripts/seed-bulk.mjs` 可生成 5000 单 / 2000 家长的压测数据集（订单全为已结算终态，并同步写入支付流水、
担保台账入出账与钱包流水，生成后 `scripts/healthcheck.mjs` 全部不变量仍通过）。

实测（本机 localhost，5000 订单 / 2232 用户 / 212 教员）：

| 接口 | 空演示库 | 5000 单（优化前） | 5000 单（优化后） |
| --- | --- | --- | --- |
| 后台订单列表（300 条） | 4.4 ms | 54.7 ms | **20.6 ms** |
| 后台数据总览（14 天趋势） | 1.9 ms | 17.2 ms | **10.5 ms** |
| 家长端首页聚合 | 2.1 ms | 12.2 ms | **4.6 ms** |
| 教员广场（10km 筛选） | 2.2 ms | 17.5 ms | **4.3 ms** |
| 业务员看板 | 1.9 ms | 5.0 ms | **2.9 ms** |
| 20 并发 × 5 轮 派单接口 | 14.4 ms (p95) | — | **14.1 ms (p95)** |

优化的三类热点（均为 N+1 / 循环查询）：

1. **订单列表**：`orderView` 原来每单 6 次查询（用户、教员档案、家长信用、评价存在性），300 单即 1800 次；
   改为 `orderViews()` 批量预取后固定 4 次查询，与列表长度无关。
2. **教员广场**：原来每位教员 3 次查询（教员卡 + 用户 + 收藏），改为复用 JOIN 结果并一次取回收藏集合。
3. **趋势图**：后台 14 天 / 代理与业务员 7 天原来逐日查询，改为单次 `GROUP BY substr(date)`。

> 结论：5000 日订单量级下全部指标仍在需求阈值内（普通接口 ≤300ms、抢单 ≤500ms）。
> 但这是**单机 SQLite + 单进程**的结果，1 万日活对应的读并发压力仍需按第 2 节迁移 MySQL + Redis 后复测；
> 前端列表已支持分页，不会因数据增长而退化为一次性全量返回。