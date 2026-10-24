# UI 追溯矩阵 · 新前端（Vue3 + Element Plus / uni-app）

对应第二份文档《UI 界面设计说明书 V1.0》。参考实现（`web/*.html` + 原生 ESM）的 UI 追溯见 [`docs/TRACEABILITY.md`](TRACEABILITY.md) 第二部分；
本文件覆盖**按需求书 6.1 选型实现的新前端**：

- **PC 管理后台** `apps/web-admin/`：Vue3 + Vite + Element Plus + vue-router，**后台页面：20**
- **移动四端** `apps/web-mobile/`：uni-app（Vue3 语法），**移动端页面：14**（家长 5 页含「附近教员 / 教员详情·立即预约 / 订单详情」，另教员 3 页含入驻认证、业务员 2 页、代理 2 页、登录与消息各 1 页）

> 机器校验：`npm run ui:check` —— 断言本文引用的每个 `.vue` 真实存在、每个页面文件都被本文档化、
> 引用的后台路由都在 `router.js` 注册、侧栏菜单与路由自洽、声明的页面数与实际一致（漏写/写错即失败）。

## 1. 移动端（uni-app）— 对应 UI 说明书第 2–4 章

| UI 说明书条目 | 页面（pages.json 路径） | 源文件 | 关键实现 |
| --- | --- | --- | --- |
| 设计概述·九宫格卡片 / 36rpx 主字号 / `#1f6feb` 主色 | `pages/login/index` … 全部页面共用 | `App.vue`（`:root` 变量 + `.wrap/.card/.kpi/.row/.tag`） | 与后台共用一套设计 token 语义 |
| 第 2 章 家长端界面（首页/广场/订单） | `pages/parent/index` | `pages/parent/index.vue` | **游客可先浏览**：未登录也能看到片区/附近在线教员/加急费与「发布家教需求」入口（走游客版首页接口 `public/home`），订单与消息区块提示「登录后可查看」；登录后同一页面换成个人首页（订单支付/确认完成/评价）；**顶部家长头像可点选图片上传（`uni.chooseImage` → 上传接口 → `PUT /parent/avatar`），`background-size: cover` 让任意长宽比的图在头像框内自适应铺满** |
| 第 2 章 附近教员（广场） | `pages/parent/teachers` | `pages/parent/teachers/index.vue` | 科目/排序筛选；已登录走家长接口 `parent/teachers`（带收藏状态）、游客走公开接口 `public/teachers`（收藏恒 false、手机号脱敏）；点卡片进教员详情 |
| 第 2 章 教员详情 + 立即预约 | `pages/parent/teacher` | `pages/parent/teacher/index.vue` | 教员资料/可预约服务/学员评价；**「立即预约」** → 选服务 + 选地址（没有地址可就地新增 `POST /addresses`）+ 选日期与起止时间 + 备注 → `POST /orders/from-service` → 直接进订单详情去支付；游客点预约先跳登录再回跳本页 |
| 第 2 章 订单详情 | `pages/parent/order` | `pages/parent/order/index.vue` | 状态/订单号/金额、教员信息（可跳教员主页）、上课信息与费用明细；按状态给操作：**去支付**（担保交易，幂等键）/ **确认完成上课** / **去评价**（星级+标签）/ **申请取消订单**（走取消申请制，显示「等待教员确认」或「教员已驳回+理由」） |
| 第 2 章 发布需求表单 | `pages/parent/publish/index` | `pages/parent/publish/index.vue` | 学段/科目/地址/预算/坐标取真实定位；**加急费可自填**（区间取平台 `urgent.fee`~`urgent.max_fee`，开开关才出现输入框）；**游客填完点「发布需求」才跳登录**，草稿落 `pendingDemand`，登录回来后自动提交 |
| 登录与角色分流 | `pages/login/index` | `pages/login/index.vue` | **微信一键登录主按钮**（小程序 `uni.login` 取 code / H5 走演示 code → `POST /api/auth/wechat`，首次自动注册家长）+ 口令登录 → 按 `role` 分流；支持 `?next=` 回跳到刚才的页面；**首登强制改密表单**（`mustChangePassword`） |
| 第 3 章 教员端界面（接单/收入/等级） | `pages/teacher/index` | `pages/teacher/index.vue` | 课时看板、等级权益、附近需求抢单、「上门打卡（真实定位）/ 结束授课」 |
| 第 3 章 收入与提现 | `pages/teacher/wallet/index` | `pages/teacher/wallet/index.vue` | 余额/冻结/累计收支、提现申请（最低额与手续费规则驱动、幂等键）、提现记录与流水 |
| 第 3 章 入驻认证（资质材料） | `pages/teacher/apply/index` | `pages/teacher/apply/index.vue` | 身份类型、真实姓名/身份证号、**「资质材料」卡排在提交按钮之上**：身份证正反面必传；第三张按身份只显示一张——在职教师→教师资格证、在校大学生→学生证、社会兼职→技能证书（`certSlot` + `certHint`）；上传后图片用背景图 `background-size: cover` 在框内自适应（`<image :src>` 在本版 H5 不落 DOM）；人像面即调 `/api/teacher/ocr-idcard` 回显「识别到：姓名 · 脱敏号码」与是否一致；提交走 `/api/teacher/apply`（姓名/号码与证件不一致会被服务端拒） |
| 第 2 章 授课地点（教员上门 / 家长到教员处） | `pages/parent/teacher`、`pages/parent/publish`、`pages/parent/order`、`pages/teacher/apply` | `pages/parent/teacher/index.vue`、`pages/parent/publish/index.vue`、`pages/parent/order/index.vue`、`pages/teacher/apply/index.vue` | **P65**：教员在入驻/资料里填「授课地址」后，家长预约页出现「🏠 教员上门 / 📍 我到教员处」两个选项（选后者隐藏家长地址选择、显示教员地址），发布需求也能选上课形式；订单详情显示「授课方式」与「教员授课地址」；下单带 `place`，到教员处时后端自动把订单地点换成教员授课地址，无需家长地址 |
| （UI 说明书未单列业务员端） | `pages/sales/index` | `pages/sales/index.vue` | 按同规范扩展：本月注册/成交/GMV/待结奖励、双通道推广码、客户 |
| （同上）奖励明细 | `pages/sales/rewards/index` | `pages/sales/rewards/index.vue` | 六类奖励按类型汇总与筛选、结算状态、钱包可用 |
| 第 4 章 区域代理端界面（大盘/订单） | `pages/agent/index` | `pages/agent/index.vue` | 片区 GMV/订单/业务员、考核完成度、片区订单 |
| （全角色共用）站内消息中心 | `pages/messages/index` | `pages/messages/index.vue` | 未读数、单条已读、全部已读；订单/资金/风控/系统四类通知，仅本人可见 |
| 第 4 章客诉处理 | `pages/agent/complaints/index` | `pages/agent/complaints/index.vue` | 片区隔离工单、「已处理 / 上报平台 / 关闭」闭环 |

## 2. PC 管理后台（Vue3 + Element Plus）— 对应 UI 说明书第 4 章补充

UI 说明书「第 4 章补充：平台管理员界面（两张）」只画了**数据总览**与**订单管理**两张核心页；
其余页面按第 5 章设计规范（侧栏 + 卡片 + 表格 + 主色 `#1f6feb`）扩展实现，逐页如下：

| 侧栏菜单 | 路由 | 页面文件 | 依据 |
| --- | --- | --- | --- |
| 总览 | `/overview` | `Overview.vue` | UI 说明书第 4 章补充·数据总览（KPI + 趋势 + 待办） |
| 订单管理 | `/orders` | `Orders.vue` | UI 说明书第 4 章补充·订单管理（筛选/改价/强制关闭/CSV 导出） |
| 需求池 | `/demands` | `Demands.vue` | 需求 4.5.3 派生（状态/学段/科目/片区/加急筛选 + 分页） |
| 退款工单 | `/refunds` | `Refunds.vue` | 需求 4.5.3 |
| 财务资金 | `/finance` | `Finance.vue` | 需求 4.5.6（担保台账/分账/对账） |
| 提现审核 | `/withdrawals` | `Withdrawals.vue` | 需求 4.5.6 |
| 发票受理 | `/invoices` | `Invoices.vue` | 需求 4.1.6 / 4.5.6 |
| 用户管理 | `/users` | `Users.vue` | 需求 4.5.2（列表/筛选/禁用/**删除账号：软删除 + 匿名化**）：家长/教员/业务员可删——有历史数据的账号打 `deleted_at` 标记并清掉手机号/昵称/实名/身份证/证件图/口令，订单与资金台账保留；完全空白的账号物理删除；有未完结订单或冻结金额时拒绝；代理引导到「代理管理」 |
| 教员审核 | `/teachers` | `Teachers.vue` | 需求 4.5.2（审核/驳回/调级） |
| 代理管理 | `/agents` | `Agents.vue` | 需求 4.5.2（签约/**新增代理**/**删除代理（软删除 + 匿名化）**/保证金台账/启停）：顶部「新增代理」弹窗（姓名/手机号/片区/等级/分成/首笔保证金，服务端回一次性初始口令）；操作列「删除」——有历史数据的代理打删除标记并清掉手机号/昵称/实名/口令，订单分成、归属绑定、下属业务员、保证金台账保留；完全空白的物理删除；保证金/钱包余额/冻结未结清或有未完结订单时拒绝 |
| 管理员账号 | `/admins` | `Admins.vue` | 需求 4.5.9（一次性口令 + 首登改密 + 启停护栏 + **删除账号**：有审批/审计痕迹走软删除并匿名化、空白账号物理删除，不能删自己、至少留一个启用管理员） |
| 权限矩阵 | `/permissions` | `Permissions.vue` | 需求 4.5.9（4 权限点 × 5 角色，admin 列锁定） |
| 区域管理 | `/regions` | `Regions.vue` + `apps/web-admin/src/components/GeoFenceMap.vue` | 需求 4.5.5（片区/电子围栏）：**两种设置方式**——「按地图设置」在中国地图上直接画多边形/圆（顶点可拖动微调）；「按行政区设置」输入地名 → 勾选候选行政区 → 围栏即所选边界的并集（多环），地图蓝色高亮预览。底图两层自动降级：在线瓦片（默认高德，`VITE_TILE_URL` 可替换）不可达时回落离线省级底图（`apps/web-admin/src/assets/china.geo.json`，34 个省级区划，随包分发）。几何换算抽在 `apps/web-admin/src/geo-fence.js`（Web Mercator + 瓦片坐标，纯函数，被 `tools/check-geo-fence.mjs` 直接 import 断言） |
| 规则配置中心 | `/rules` | `Rules.vue` + `apps/web-admin/src/components/RuleValueEditor.vue` + `apps/web-admin/src/components/RuleRowsTable.vue` | 需求 4.5.4（17 组规则热更新）：**按字段类型生成表单**（数字框 / 开关 / 标签 / 角色勾选 / 可编辑表格 / 嵌套对象），字段中文名与单位（¥、%、×）来自 `rule-meta.js`；原始 JSON 仅作「高级」只读折叠展示，不提供文本框给运营 |
| 运营工具 | `/ops` | `Ops.vue` | 需求 4.5.8（Banner / 公告 / 优惠券） |
| 学段 / 科目（运营工具类目） | `/catalog` | `Catalog.vue` | 需求 4.1（发单必填字段的选项维护）：字典落 `rule_configs.catalog`，保存即时生效，前端读 `/api/meta/dictionary` |
| 风控与仲裁 | `/risks` | `Risks.vue` | 需求 4.5.7 |
| 操作日志 | `/logs` | `Logs.vue` | 需求 4.5.9 |
| 登录账号自助改密 | `/password` | `Password.vue` | 需求 4.5.1（账号安全）：顶栏「修改口令」入口；旧口令校验 + 口令强度（≥8 位且含字母与数字、不得与原口令相同、两次输入一致）；调 `POST /auth/change-password`，后端 `token_version` 自增使旧令牌立即失效并把新令牌写回本地；**首登强制**：后台开通的账号 `mustChangePassword=true` 时登录后直接进本页，任何接口返回 `MUST_CHANGE_PASSWORD` 也会被统一送到这里（此前缺页面会卡在 403） |
| 登录页（无侧栏） | `/login` | `Login.vue` | 需求 2.x 后台鉴权 |

布局与交互：`App.vue` 提供侧栏 + 顶栏 + `<router-view>`，`api.js` 统一 Bearer 令牌与 `code=0` 判定、401 自动回登录，
路由守卫（`router.js`）拦截未登录访问；表格/表单/弹窗统一用 Element Plus 组件，样式 token 在 `styles.css`。

## 3. 第 5 章 设计规范落点

| 规范项 | 实现 |
| --- | --- |
| 主色 / 辅助色 | `#1f6feb`（主操作、选中态）；成功/警告/危险沿用 Element Plus 语义色 |
| 字号层级 | 后台 12/13/14/16/24px；移动端以 `rpx` 为单位（26/28/32rpx） |
| 间距与卡片 | 后台 `.card` 圆角 8px + 阴影；移动端 `.card` 圆角 24rpx |
| 列表与空态 | 表格空态、`<view v-if="!list.length" class="muted">` 占位文案 |
| 危险操作二次确认 | 删除/禁用/强制关闭/权限变更均走 `ElMessageBox.confirm` |
| 反馈 | 成功 `ElMessage.success` / 失败 `ElMessage.error`（后端 `message` 直出）；移动端 `uni.showToast` |

## 4. 与参考实现的 UI 差异（如实记录）

1. **业务员端**：UI 说明书第 2–4 章只覆盖家长/教员/代理，业务员端在参考实现与新版中都是**按同规范扩展**（非说明书页面）。
2. **后台 16 页**（除总览、订单管理）为说明书未画的具体页面，样式与交互遵循第 5 章规范，未逐像素还原。
3. **旧 5 端 UI**（`web/*.html`）仍保留在同一后端上（`/parent` 等路径），其 UI 追溯见 `docs/TRACEABILITY.md` 第二部分。
