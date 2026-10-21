# 外部集成契约（短信 / 支付 / 打款）

> 用途：A1（短信）、A2（支付）落地前的**接口契约与凭证清单**。当前系统账本正确、资金链路未接真实通道，
> 本文写清「现状卡在哪里」「需要你提供什么」「我会怎么接」「怎么验收」。
> 清单项编号对应 `docs/GO-LIVE-CHECKLIST.md` 的 A 段。

## 1. 现状（精确到代码位置）

| 环节 | 现状 | 位置 | 缺口 |
| --- | --- | --- | --- |
| 短信验证码 | 内存 `Map` 生成 6 位码，`DEV_SMS!==0 && NODE_ENV!=production` 时随响应回显 `devCode`；没有调用任何短信网关 | `apps/api-nest/src/auth/auth.service.ts:42`（`sendCode`）、`:54`（存码）、`:57`（回显） | 无真实下发；多实例下验证码不共享（内存 Map） |
| 支付（家长付款） | `POST /api/orders/:id/pay` **直接**把 `payments` 写成 `status=success`，`trade_no` 本地生成（`tradeNo("WX")`），随即担保入账 | `apps/api-nest/src/order/orders.service.ts:279`（`pay()`）、`:305`（插 `payments`） | 没有预支付单、没有支付回调、没有验签，等于是「点一下就算付了」 |
| 退款 | 走内部账本（`refund_amount` / 担保台账出账），无渠道退款调用 | `apps/api-nest/src/order/orders.service.ts`（退款分支）、`admin-ops.service.ts`（审批） | 真实退款需渠道 API + 异步结果回调 |
| 提现（出款） | 后台审批通过即把 `withdrawals.status` 置 `paid` 并累计 `total_withdraw` | `apps/api-nest/src/wallet/wallet.service.ts:72`（`reviewWithdrawal`）、`:79` | **没有真实打款**；这是「账上钱出去了、银行卡没到账」的风险点 |

结论：账本与分账是正确的（582 项门禁覆盖恒等式与并发），但**资金进出口都没有真实通道**，上线前必须补齐 A1+A2，
且 A2 要覆盖「收款 + 退款 + 打款」三段。

## 2. 需要你提供的东西（给我即可，我写进 `.env`，不入库）

### 2.1 短信（A1）——任选一家

| 项目 | 阿里云短信 | 腾讯云短信 |
| --- | --- | --- |
| 凭证 | `AccessKeyId` / `AccessKeySecret` | `SecretId` / `SecretKey` / `SdkAppId` |
| 签名 | 已备案的短信签名（如「XX家教」） | 同左 |
| 模板 | 验证码模板 `SMS_xxx`，变量名（如 `${code}`） | 模板 ID（如 `1234567`） |
| 限制 | 是否需要把测试手机号加入白名单 | 同左 |

另需确认：单号 60s 间隔、单号日上限（我方默认 60s；日上限需你定策略）、验证码有效期（我方默认 5 分钟）。

### 2.2 支付（A2 收款 + 退款）——推荐单一渠道先跑通

| 项目 | 微信支付（JSAPI/小程序） | 支付宝（手机网站 / APP） |
| --- | --- | --- |
| 商户 | `AppID`、`MchID`、APIv3 密钥、商户证书序列号、`apiclient_key.pem` | `AppID`、应用私钥、支付宝公钥、网关地址 |
| 回调 | **公网 HTTPS** 回调域名（必须能从互联网访问） | 同左（`notify_url`） |
| 资质 | 商户号已开通对应支付产品 | 应用已签约「手机网站支付」 |

> 回调域名是硬门槛：本机 `127.0.0.1:4300` 收不到回调。联调期用内网穿透（frp / ngrok / cloudflared）拿到
> 一个 HTTPS 域名即可，生产必须换成已备案域名（与 B1 HTTPS 同一件事）。

### 2.3 打款（A2 出款，提现用）

- 微信「商家转账到零钱」或支付宝「转账到支付宝账户」：需单独开通 + 实名/资质；
- 若暂时不开通，可先保持「线下打款 + 后台手工置 paid」，但**必须在 UI 与审计里标注「线下出款」**，
  并把 `withdrawals.status` 的 `paid` 语义改成 `paid_offline`，避免对账时把「未到账」当成「已到账」。

## 3. 我准备怎么接（拿到凭证之前的可做部分）

1. `src/integrations/sms/sms.port.ts`：`sendCode(phone, code, ttlSec)`，实现 `mock | aliyun | tencent`，
   由 `SMS_PROVIDER` 选择；`mock` 保持现有行为（日志 + `DEV_SMS` 回显），**582 项门禁零回归**。
2. `src/integrations/pay/pay.port.ts`：
   - `createPrepay(order)` → 返回渠道支付参数（前端唤起用）
   - `verifyNotify(raw, headers)` → 验签 + 解析（金额、商户单号、渠道单号、状态）
   - `refund(paymentId, amount, reason)` / `transfer(withdrawal)` → 退款与打款
   同样由 `PAY_PROVIDER` 选实现；`mock` 走「立即成功」，与现有 `pay()` 语义一致。
3. `orders.pay` 拆成两段：**创建预支付单（写 `payments.status=pending` 拿渠道单号）→ 回调确认（幂等键 + 行锁 + 校验金额/单号一致）**。
   回调必须是幂等的：同一 `trade_no` 重复回调只入账一次（`payments.trade_no` 唯一索引 + `FOR UPDATE`）。
4. 对账：`tools/check-recon.mjs` 拉渠道对账单，比对「我方 payments / 担保台账」与「渠道流水」，差异即失败。
5. `tools/check-integrations.mjs` 门禁：
   - `SMS_PROVIDER`/`PAY_PROVIDER` 非 `mock` 时，必需的环境变量缺一即**失败**（不允许悄悄退回 mock）；
   - 用本地假网关（`--mock-server`）验证：验签失败拒绝、金额不一致拒绝、重复回调只入账一次、乱序回调不回退状态。

## 4. 验收标准（接完怎么算过）

- 短信：真实手机号收到验证码；错误码/超频/欠费分支有明确错误；验证码 5 分钟过期、用后即失效（现有用例保留）。
- 支付：真实小额付款 → 回调入账 → 担保台账 +`amount`、钱包/订单状态正确；**重复回调不重复入账**；
  金额被篡改 → 拒绝并告警；支付超时（15 分钟）自动关单。
- 退款：渠道退款成功 → 我方 `refunded` 与渠道状态一致；渠道失败 → 订单保持 `refund_failed` 可重试。
- 打款：小额提现真实到账；失败可重试；`total_withdraw` 与渠道流水一致。
- 对账：连续 24h 的渠道流水与我方 `payments`/`withdrawals` 逐笔匹配，差异 0。
- 门禁：`npm run ci:full` 26 步 + 新增集成契约门禁全绿；`docs/GO-LIVE-CHECKLIST.md` A1/A2 改 ✅。

## 5. 风险与前置

- 商户资质与开通周期不由代码决定，可能阻塞工期；
- 回调依赖公网 HTTPS（B1），B1 未完成时只能用穿透域名联调，**不可直接上生产**；
- 凭证必须走环境变量或密钥管理（B7），**不得写入仓库**；`.env` 已在 `.gitignore`；
- 日志里不得出现完整手机号/证件号（现有 `maskPhone` 已覆盖接口返回，短信网关日志需另行脱敏）。
