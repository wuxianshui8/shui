# 新后端接口清单（NestJS + MySQL 8 + Redis）

本文件是 **`apps/api-nest` 正式实现**的接口清单。正文自动区块由 `tools/gen-api-doc.mjs` 从控制器源码提取，
因此**不会与代码脱节**；参考实现（`server/` + SQLite）的接口说明见 [`docs/API.md`](API.md)。

```bash
npm run api:doc          # 接口有变更后刷新本文件
npm run api:doc:check    # 只校验文档是否过期（退出码 1 = 过期，可挂 CI）
```

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `http://localhost:4300/api`（生产走同域反向代理） |
| 鉴权 | `Authorization: Bearer <token>`；令牌声明 `{ uid, role, v, exp }`，`v` 为账号 `token_version`，改密/注销后旧令牌立即失效 |
| 响应包封 | `{ code: 0, message: "ok", data: ... }`；业务错误返回 `code: "BIZ_CODE"` + `message` |
| 状态码 | 成功统一 **200**（含 POST）；参数/业务错误 **400**、未登录 **401**、越权 **403**、未找到 **404**、频控与锁定 **429** |
| 时间 | ISO-8601 字符串 |
| 金额 | 整数「分」（`BIGINT`） |
| 分页 | `?page=1&pageSize=20`，响应 `{ list, total, page, pageSize, pages }`；`pageSize` 上限 500 |
| 幂等 | 支付 `POST /orders/:id/pay`、提现 `POST /withdrawals` 支持 `X-Idem-Key`：同键重复请求返回首次结果 |
| 首登改密 | 后台开通的账号 `must_change_password=1`，改密前除 `change-password / me / logout / deactivate` 外一律 403 |

## 2. 角色

`parent` 家长 ｜ `teacher` 教员 ｜ `sales` 业务员 ｜ `agent` 区域代理 ｜ `admin` 平台管理员。
路由级角色以装饰器为准；标注「登录用户」的接口按 `req.user.uid` 只读写本人数据，
代理/业务员相关接口在服务层再按 `region_id`、`bindings` 做片区与客户归属隔离。

## 3. 质量门禁（与本清单对应的验证）

| 门禁 | 覆盖 |
| --- | --- |
| `npm run nest:gate:p6` | e2e 全套 §1–§20，153 项断言 |
| `npm run nest:gate:p7` | 并发验收 23 项 |
| `npm run nest:gate:races` | 资金并发对抗 27 项（行锁/状态守卫/分账恒等式/幂等重放） |
| `npm run nest:gate:privacy` | 隐私与账号安全 38 项（地址·坐标脱敏 / health 分级 / 改密与令牌失效） |
| `npm run nest:bench` | 性能基线，见 [`docs/PERF.md`](PERF.md) |

## 4. 接口总表（自动生成）

<!-- BEGIN:AUTO-GEN -->
<!-- 本区块由 tools/gen-api-doc.mjs 自动生成，请勿手工编辑；改接口后执行 npm run api:doc -->

总计 **159** 个路由，分布在 **18** 个控制器。

| 控制器 | 路由数 |
| --- | --- |
| `admin/admin-ops.controller.ts` | 50 |
| `teacher/teacher.controller.ts` | 20 |
| `agent/agent.controller.ts` | 14 |
| `order/orders.controller.ts` | 10 |
| `admin/admin.controller.ts` | 9 |
| `auth/auth.controller.ts` | 9 |
| `demand/demands.controller.ts` | 8 |
| `parent/parent.controller.ts` | 6 |
| `public/public.controller.ts` | 6 |
| `common/addresses.controller.ts` | 5 |
| `wallet/wallet.controller.ts` | 5 |
| `sales/sales.controller.ts` | 5 |
| `message/message.controller.ts` | 3 |
| `complaint/complaint.controller.ts` | 2 |
| `health/health.controller.ts` | 2 |
| `meta/meta.controller.ts` | 2 |
| `pay/pay-notify.controller.ts` | 2 |
| `upload/uploads.controller.ts` | 1 |

### `admin/admin-ops.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/admins` | admin |  |
| POST | `/api/admin/admins` | admin | 200 |
| POST | `/api/admin/admins/:id/toggle` | admin | 200 |
| GET | `/api/admin/agents` | admin |  |
| POST | `/api/admin/agents` | admin | 200 |
| DELETE | `/api/admin/agents/:id` | admin |  |
| GET | `/api/admin/agents/:id` | admin |  |
| PUT | `/api/admin/agents/:id` | admin |  |
| POST | `/api/admin/agents/:id/deposit` | admin | 200 |
| POST | `/api/admin/agents/:id/toggle` | admin | 200 |
| GET | `/api/admin/announcements` | admin |  |
| POST | `/api/admin/announcements` | admin | 200 |
| DELETE | `/api/admin/announcements/:id` | admin |  |
| PUT | `/api/admin/announcements/:id` | admin |  |
| POST | `/api/admin/announcements/:id/pin` | admin | 200 |
| POST | `/api/admin/announcements/:id/toggle` | admin | 200 |
| POST | `/api/admin/appeals/:id/arbitrate` | admin | 200 |
| POST | `/api/admin/applications/expire` | admin | 200 |
| GET | `/api/admin/audit-logs` | admin |  |
| GET | `/api/admin/banners` | admin |  |
| POST | `/api/admin/banners` | admin | 200 |
| DELETE | `/api/admin/banners/:id` | admin |  |
| PUT | `/api/admin/banners/:id` | admin |  |
| POST | `/api/admin/banners/:id/toggle` | admin | 200 |
| POST | `/api/admin/complaints/:id/close` | admin | 200 |
| GET | `/api/admin/coupons` | admin |  |
| POST | `/api/admin/coupons` | admin | 200 |
| PUT | `/api/admin/coupons/:id` | admin |  |
| POST | `/api/admin/coupons/:id/toggle` | admin | 200 |
| GET | `/api/admin/demands` | admin |  |
| GET | `/api/admin/orders` | admin |  |
| POST | `/api/admin/orders/:id/close` | admin / agent | 200 |
| POST | `/api/admin/orders/:id/price` | admin / agent | 200 |
| POST | `/api/admin/orders/close-expired` | admin | 200 |
| GET | `/api/admin/orders/export` | admin |  |
| GET | `/api/admin/permissions` | admin |  |
| PUT | `/api/admin/permissions` | admin |  |
| GET | `/api/admin/regions` | admin |  |
| POST | `/api/admin/regions` | admin | 200 |
| GET | `/api/admin/regions/areas` | admin |  |
| GET | `/api/admin/risks` | admin |  |
| POST | `/api/admin/risks/:id/handle` | admin | 200 |
| GET | `/api/admin/rules` | admin |  |
| PUT | `/api/admin/rules/:key` | admin |  |
| POST | `/api/admin/teachers/:id/audit` | admin | 200 |
| POST | `/api/admin/teachers/:id/level` | admin | 200 |
| GET | `/api/admin/teachers/pending` | admin |  |
| GET | `/api/admin/users` | admin |  |
| DELETE | `/api/admin/users/:id` | admin |  |
| POST | `/api/admin/users/:id/toggle` | admin | 200 |

### `admin/admin.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/finance` | admin |  |
| POST | `/api/admin/invoices/:id/review` | admin | 200 |
| GET | `/api/admin/overview` | admin |  |
| GET | `/api/admin/refunds` | admin |  |
| POST | `/api/admin/refunds/:id/review` | admin / agent | 200 |
| POST | `/api/admin/reminders/run` | admin | 200 |
| POST | `/api/admin/rewards/settle` | admin | 200 |
| POST | `/api/admin/settlement/run` | admin | 200 |
| POST | `/api/admin/withdrawals/:id/review` | admin / agent / sales | 200 |

### `agent/agent.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/agent/announcements` | agent |  |
| GET | `/api/agent/complaints` | agent |  |
| POST | `/api/agent/complaints/:id/handle` | agent | 200 |
| GET | `/api/agent/dashboard` | agent |  |
| GET | `/api/agent/earnings` | agent |  |
| GET | `/api/agent/orders` | agent |  |
| GET | `/api/agent/orders/export` | agent |  |
| GET | `/api/agent/profile` | agent |  |
| GET | `/api/agent/risks` | agent |  |
| POST | `/api/agent/risks/:id/escalate` | agent | 200 |
| GET | `/api/agent/sales` | agent |  |
| POST | `/api/agent/sales` | agent | 200 |
| GET | `/api/agent/sales/:id` | agent |  |
| POST | `/api/agent/sales/:id/toggle` | agent | 200 |

### `auth/auth.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/auth/change-password` | 登录用户 | 200 |
| POST | `/api/auth/deactivate` | 登录用户 | 200 |
| POST | `/api/auth/login` | 公开 | 无需令牌，200 |
| POST | `/api/auth/login-account` | 公开 | 无需令牌，200 |
| POST | `/api/auth/login-password` | 公开 | 无需令牌，200 |
| GET | `/api/auth/me` | 登录用户 |  |
| POST | `/api/auth/send-code` | 公开 | 无需令牌，200 |
| POST | `/api/auth/wechat` | 公开 | 无需令牌，200 |
| GET | `/api/auth/wechat/authorize-url` | 公开 | 无需令牌 |

### `common/addresses.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/addresses` | 登录用户 |  |
| POST | `/api/addresses` | 登录用户 | 200 |
| DELETE | `/api/addresses/:id` | 登录用户 |  |
| PUT | `/api/addresses/:id` | 登录用户 |  |
| POST | `/api/addresses/:id/default` | 登录用户 | 200 |

### `complaint/complaint.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/complaints` | 登录用户 | 200 |
| GET | `/api/complaints/mine` | 登录用户 |  |

### `demand/demands.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/demands` | parent | 200 |
| GET | `/api/demands/:id` | 登录用户 |  |
| PUT | `/api/demands/:id` | parent |  |
| POST | `/api/demands/:id/action` | parent | 200 |
| POST | `/api/demands/:id/apply` | teacher | 200 |
| POST | `/api/demands/:id/confirm` | parent | 200 |
| GET | `/api/demands/mine` | parent |  |
| GET | `/api/teacher/nearby-demands` | teacher |  |

### `health/health.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 无需令牌 |
| GET | `/api/health/detail` | admin |  |

### `message/message.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/messages` | 登录用户 |  |
| POST | `/api/messages/:id/read` | 登录用户 | 200 |
| POST | `/api/messages/read-all` | 登录用户 | 200 |

### `meta/meta.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/meta/dictionary` | 公开 | 无需令牌 |
| GET | `/api/meta/rules-public` | 登录用户 |  |

### `order/orders.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/orders/:id` | 登录用户 |  |
| POST | `/api/orders/:id/cancel` | 登录用户 | 200 |
| POST | `/api/orders/:id/checkin` | teacher | 200 |
| POST | `/api/orders/:id/confirm` | parent | 200 |
| POST | `/api/orders/:id/finish` | teacher | 200 |
| POST | `/api/orders/:id/pay` | parent | 200 |
| POST | `/api/orders/:id/refund` | parent | 200 |
| POST | `/api/orders/:id/review` | parent | 200 |
| POST | `/api/orders/:id/sos` | 登录用户 | 200 |
| POST | `/api/orders/from-service` | parent | 200 |

### `parent/parent.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| PUT | `/api/parent/avatar` | parent |  |
| GET | `/api/parent/home` | parent |  |
| GET | `/api/parent/orders` | parent |  |
| GET | `/api/parent/profile` | parent |  |
| GET | `/api/parent/teachers` | parent |  |
| GET | `/api/parent/teachers/:id` | parent |  |

### `pay/pay-notify.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/pay/wechat/notify` | 公开 | 无需令牌，200 |
| POST | `/api/pay/wechat/refund-notify` | 公开 | 无需令牌，200 |

### `public/public.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/public/announcements` | 公开 | 无需令牌 |
| GET | `/api/public/banners` | 公开 | 无需令牌 |
| GET | `/api/public/coupons` | 公开 | 无需令牌 |
| GET | `/api/public/home` | 公开 | 无需令牌 |
| GET | `/api/public/teachers` | 公开 | 无需令牌 |
| GET | `/api/public/teachers/:id` | 公开 | 无需令牌 |

### `sales/sales.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/public/promo/:token/scan` | 公开 | 无需令牌，200 |
| GET | `/api/sales/customers` | sales |  |
| GET | `/api/sales/dashboard` | sales |  |
| GET | `/api/sales/profile` | sales |  |
| GET | `/api/sales/rewards` | sales |  |

### `teacher/teacher.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/teacher/apply` | parent / teacher | 200 |
| GET | `/api/teacher/calendar` | teacher |  |
| GET | `/api/teacher/dashboard` | teacher |  |
| GET | `/api/teacher/income` | teacher |  |
| GET | `/api/teacher/level` | teacher |  |
| POST | `/api/teacher/ocr-idcard` | teacher / parent | 200 |
| POST | `/api/teacher/online` | teacher | 200 |
| GET | `/api/teacher/orders` | teacher |  |
| POST | `/api/teacher/orders/:id/cancel-approve` | teacher | 200 |
| POST | `/api/teacher/orders/:id/cancel-reject` | teacher | 200 |
| GET | `/api/teacher/profile` | teacher / parent |  |
| PUT | `/api/teacher/profile` | teacher |  |
| GET | `/api/teacher/profile-page` | teacher |  |
| GET | `/api/teacher/reviews` | teacher |  |
| POST | `/api/teacher/reviews/:id/appeal` | teacher | 200 |
| GET | `/api/teacher/services` | teacher |  |
| POST | `/api/teacher/services` | teacher | 200 |
| DELETE | `/api/teacher/services/:id` | teacher |  |
| PUT | `/api/teacher/services/:id` | teacher |  |
| POST | `/api/teacher/services/:id/toggle` | teacher | 200 |

### `upload/uploads.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/upload` | 登录用户 | 200 |

### `wallet/wallet.controller.ts`

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/invoices` | parent | 200 |
| GET | `/api/wallet` | 登录用户 |  |
| GET | `/api/wallet/txns` | 登录用户 |  |
| GET | `/api/withdrawals` | 登录用户 |  |
| POST | `/api/withdrawals` | teacher / sales / agent | 200 |

<!-- END:AUTO-GEN -->
