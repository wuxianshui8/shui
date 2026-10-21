# UI 追溯矩阵 · 新前端（Vue3 + Element Plus / uni-app）

对应第二份文档《UI 界面设计说明书 V1.0》。参考实现（`web/*.html` + 原生 ESM）的 UI 追溯见 [`docs/TRACEABILITY.md`](TRACEABILITY.md) 第二部分；
本文件覆盖**按需求书 6.1 选型实现的新前端**：

- **PC 管理后台** `apps/web-admin/`：Vue3 + Vite + Element Plus + vue-router，**后台页面：18**
- **移动四端** `apps/web-mobile/`：uni-app（Vue3 语法），**移动端页面：9**

> 机器校验：`npm run ui:check` —— 断言本文引用的每个 `.vue` 真实存在、每个页面文件都被本文档化、
> 引用的后台路由都在 `router.js` 注册、侧栏菜单与路由自洽、声明的页面数与实际一致（漏写/写错即失败）。

## 1. 移动端（uni-app）— 对应 UI 说明书第 2–4 章

| UI 说明书条目 | 页面（pages.json 路径） | 源文件 | 关键实现 |
| --- | --- | --- | --- |
| 设计概述·九宫格卡片 / 36rpx 主字号 / `#1f6feb` 主色 | `pages/login/index` … 全部页面共用 | `App.vue`（`:root` 变量 + `.wrap/.card/.kpi/.row/.tag`） | 与后台共用一套设计 token 语义 |
| 第 2 章 家长端界面（首页/广场/订单） | `pages/parent/index` | `pages/parent/index.vue` | 片区与附近教员、订单「支付 / 确认完成 / 评价」闭环 |
| 第 2 章 发布需求表单 | `pages/parent/publish/index` | `pages/parent/publish/index.vue` | 学段/科目/地址/预算/加急，坐标取真实定位 |
| 登录与角色分流 | `pages/login/index` | `pages/login/index.vue` | 口令登录 → 按 `role` 分流；**首登强制改密表单**（`mustChangePassword`） |
| 第 3 章 教员端界面（接单/收入/等级） | `pages/teacher/index` | `pages/teacher/index.vue` | 课时看板、等级权益、附近需求抢单、「上门打卡（真实定位）/ 结束授课」 |
| 第 3 章 收入与提现 | `pages/teacher/wallet/index` | `pages/teacher/wallet/index.vue` | 余额/冻结/累计收支、提现申请（最低额与手续费规则驱动、幂等键）、提现记录与流水 |
| （UI 说明书未单列业务员端） | `pages/sales/index` | `pages/sales/index.vue` | 按同规范扩展：本月注册/成交/GMV/待结奖励、双通道推广码、客户 |
| （同上）奖励明细 | `pages/sales/rewards/index` | `pages/sales/rewards/index.vue` | 六类奖励按类型汇总与筛选、结算状态、钱包可用 |
| 第 4 章 区域代理端界面（大盘/订单） | `pages/agent/index` | `pages/agent/index.vue` | 片区 GMV/订单/业务员、考核完成度、片区订单 |
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
| 用户管理 | `/users` | `Users.vue` | 需求 4.5.2 |
| 教员审核 | `/teachers` | `Teachers.vue` | 需求 4.5.2（审核/驳回/调级） |
| 代理管理 | `/agents` | `Agents.vue` | 需求 4.5.2（签约/保证金台账/启停） |
| 管理员账号 | `/admins` | `Admins.vue` | 需求 4.5.9（一次性口令 + 首登改密 + 启停护栏） |
| 权限矩阵 | `/permissions` | `Permissions.vue` | 需求 4.5.9（4 权限点 × 5 角色，admin 列锁定） |
| 区域管理 | `/regions` | `Regions.vue` | 需求 4.5.5（片区/电子围栏） |
| 规则配置中心 | `/rules` | `Rules.vue` | 需求 4.5.4（15 组规则热更新） |
| 运营工具 | `/ops` | `Ops.vue` | 需求 4.5.8（Banner / 公告 / 优惠券） |
| 风控与仲裁 | `/risks` | `Risks.vue` | 需求 4.5.7 |
| 操作日志 | `/logs` | `Logs.vue` | 需求 4.5.9 |
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
