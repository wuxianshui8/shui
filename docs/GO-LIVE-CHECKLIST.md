# 上线待办清单（GO-LIVE CHECKLIST）

> 这份清单回答一个问题：**「需求书验收」之外，真上线还缺什么**。
> 与 `docs/TRACEABILITY-NEST.md` 的「偏离与说明」互补：那里记的是「与需求书文字的差异」，
> 这里记的是「需求书没要求、但生产环境必需」的工程件。
>
> 状态口径：✅ 已具备 / 🟡 部分具备（有替代方案，但不达生产标准） / ❌ 未做。
> 最后核对：2026-10-23，P61 合入（`bf9c25b` 家长端 3 页 + 文档纠偏，`9b3fbc1` 种子幂等修复；此后仅本文档头部微调）。
> 每项都写明**补齐条件**，避免"知道要做什么但不知道从哪下手"。

## A. 外部集成（需求书允许模拟，上线必须接真实通道）

| # | 项 | 现状 | 补齐条件 |
| --- | --- | --- | --- |
| A1 | 短信验证码 | 🟡 **代码已就绪，待密钥**：腾讯云短信通道已实现（`src/integrations/sms/`：TC3-HMAC-SHA256 签名、SendSms 请求体、错误码分支、`SMS_PROVIDER=mock/tencent` 工厂、缺配置/占位串启动即拒绝），单测 101 项覆盖签名与错误分支；`SMS_PROVIDER=tencent` + 5 项密钥即可真实下发 | 你提供：`SecretId`/`SecretKey`/`SdkAppId`/已备案签名/模板 ID（模板变量 ${1}=验证码、${2}=分钟） |
| A2 | 支付通道 | 🟡 **通道层、服务端接线与前端唤起都已完成，待商户号**：`src/integrations/pay/` 含 `PayProvider` 端口、mock、微信支付 v3（JSAPI 下单、`WECHATPAY2-SHA256-RSA2048` 请求签名、回调验签 + 时间戳防重放、`AEAD_AES_256_GCM` 解密、退款），单测用本地生成的 RSA 密钥对与自加密验证签名/验签/解密链路（**无需商户号**）；启动即校验 `PAY_PROVIDER` 配置。**流程已接线**：`orders.pay` 拆「建预支付单（`payments.status=pending`、`trade_no=PREPAY:<单号>`）→ 渠道回调确认」，`POST /api/pay/wechat/notify` 与 `/refund-notify` 用 `rawBody` + `wechatpay-*` 头验签解密后幂等入账（重复投递识别、金额/单号一致性校验、校验失败回非 2xx 让渠道重试），外加超时关单、渠道退款、对账骨架（`npm run pay:recon`，`--download` 尚未实现、明确退出码 2） | 你提供：`AppID`/`MchID`/证书序列号/商户私钥/APIv3 密钥/平台证书公钥/公网 HTTPS 回调地址。我方仍缺：① **openid 来源**——真实通道要求 `openId`（缺则 `OPENID_REQUIRED`），后端已在微信登录时把 `users.wx_openid` 落库可直接兜底，前端尚未显式传；② 对账单下载（需商户 APIv3 证书）与逐笔核对（C3）。**前端唤起已接（P69）**：`apps/web-mobile/src/pay.js`（统一收口：mock 返回订单视图→跳过唤起；真实通道 `prepay`→小程序 `uni.requestPayment`／微信内 H5 `WeixinJSBridge.getBrandWCPayRequest`；唤起后 `waitPaid` 轮询订单落地；非微信 H5 明确提示「请在微信中打开」不假装支持）与参考实现 `web/assets/js/parent.js`（`wxH5Pay`/`waitOrderPaid`）同构，微信外 H5（MWEB/h5_url）后端仍未实现 |
| A3 | 地图与围栏 | 🟡 **围栏已换真实行政区边界**：`tools/build-admin-areas.mjs` 从阿里云 DataV `areas_v3` 生成 3237 个行政区（省 34 / 市 363 / 区县 2840，47 万点，gzip 1.9MB 随包），片区可直接「按地名设置」（勾选行政区 → 多环围栏）；距离为 Haversine，点在多边形为真实判定；`Regions.vue` 带在线瓦片底图（失败自动回落离线省界） | 仍缺：**地址 → 经纬度逆地理编码**（现有「手填地址」按片区默认坐标落库，精度到片区不到门牌）、地图 SDK 选点/拖拽纠偏、在线瓦片换自有或天地图并带审图号 |
| A4 | 文件存储 | 🟡 **上传能力已具备**：`POST /api/upload`（base64、仅 PNG/JPG/WEBP、≤2MB，落盘 `data/uploads`，返回 `/uploads/xxx`）+ 家长头像（`PUT /api/parent/avatar`）+ 教员身份证正反面/证书（`/api/teacher/apply`），前端上传后框内自适应显示 | 仍缺：对象存储（OSS/COS）直传签名与 CDN、图片鉴黄/病毒扫描、DB 只存 key、多实例共享卷或桶 |
| A5 | 微信小程序上架 | 🟡 **工程与登录链路已就绪**：`mp-weixin` 产出 **16 页**（家长 7 + 教员 3 + 业务员 2 + 代理 2 + 登录 + 消息）可直接导入开发者工具；`POST /api/auth/wechat` 走 `jscode2session`（`WECHAT_APPID/SECRET` 未配时 mock），首次登录自动注册家长 | 未做：小程序**审核发布**、手机号快速验证组件、订阅消息模板、真实 appid 与前端 `manifest` 对齐（另见 `docs/INTEGRATIONS.md`） |
| A6 | 消息推送 | 🟡 站内消息（`messages` 表 + 移动端消息中心，可标已读） | 接 APNs/FCM/微信模板消息：用户设备 token 管理、推送到达率监控 |
| A7 | 电子合同 | 🟡 `agreements` 表与接口存在 | 接 e签宝/法大大：发起签署、回调存证、PDF 归档 |
| A8 | 电子发票 | 🟡 开票申请→财务受理→回写票面地址（全流程可跑） | 接税务/电子发票平台：真实开票、红冲、票面 PDF |

## B. 部署与运维

| # | 项 | 现状 | 补齐条件 |
| --- | --- | --- | --- |
| B1 | HTTPS / 域名 / 证书 | ❌ 应用只监听 HTTP（令牌为 Bearer，明文会被截获） | 前置 Nginx/Caddy 或云 LB + ACME 自动续期；`TRUST_PROXY=1` 已在 compose 中预留（**务必只在前置代理时打开**，否则登录锁定可被伪造 XFF 绕过） |
| B2 | 多实例水平扩容 | ❌ 验证码/登录失败计数、规则配置内存缓存均为**单实例**（规则缓存有 300s TTL） | 按 `docs/SECURITY.md §8 第 11 条` 全部迁到 Redis；会话无状态（当前令牌自包含，可直接多实例）、补共享限流 |
| B3 | 备份自动化与演练 | ✅ **已完成（2026-10-23 起每日自动跑）**：服务器上装了 `jiajiao-backup.timer`（每日 03:20，错峰 ±10 分钟，关机错过开机补跑）→ `backup-db.sh` 容器内 `mysqldump` + 上传卷打包，**防空校验**（gzip 完整性 + 表数 <30 判失败）+ 原子改名，保留 DB 14 份 / 上传 7 份；失败由 `OnFailure=jiajiao-backup-notify.service` 写 journal（error）并可选 POST `BACKUP_WEBHOOK_URL`。本地另有 `npm run db:backup`/`db:restore`（恢复前后双重校验）与保留策略实测。实测：剪枝 18→14 正确、故意造失败 → 退出码 1 + `LAST_STATUS` 记原因 + webhook 收到合法 JSON（HTTP 200）。**仍缺**：异地/对象存储归档（本机备份跟着机器一起没）、RPO/RTO 定义、每月恢复演练排期；`schtasks` 安装段本机权限不足未实测（服务器侧改用 systemd timer，已实测） | 备份推到对象存储（版本化 + 生命周期）+ 写一页 RPO/RTO；每月做一次真实恢复演练 |
| B4 | 监控与告警 | 🟡 有 `/api/health`（匿名仅可用性）与 `/api/health/detail`（管理员，含用户数/订单/担保额/DB+Redis 延迟） | 接 Prometheus 指标端点 + Grafana 面板 + 告警规则（错误率/延迟/担保台账不平/任务卡死） |
| B5 | 日志集中化 | 🟡 应用日志走 stdout（容器 `docker logs` 可看） | 接 Loki/ELK：结构化 JSON 日志、保留策略、按 `trace_id` 串联；审计日志已在库内（`audit_logs`） |
| B6 | 灰度与回滚 | ✅ **已完成（2026-10-26，P81）**：镜像按 git 短 sha 打**不可变 tag**，compose 用 `image: jiajiao-app:${APP_IMAGE_TAG:-latest}`；发布脚本写 `.env` 的 `APP_IMAGE_TAG` + 记 `releases.log` 台账；`/opt/jiajiao/bin/rollback.sh` 支持 `--list / --previous / <tag> / --prune`，切完轮询 `/api/health`，**不健康自动退回原版本**；发版健康 20 分钟不过也自动回滚；只保留最近 3 个发布镜像。**红线**：DB 变更必须向后兼容（先加列后删列） | 仍缺**真正的灰度**（按比例/按用户分流）——当前是「整体切换 + 秒级回滚」 |
| B7 | 密钥管理 | 🟡 `AUTH_SECRET` 由 `deploy/.env` 注入（`${AUTH_SECRET:?...}` 强制必填，`up.bat` 还会拦占位符） | 接 Vault/KMS 或云密钥托管；轮换流程（`token_version` 机制已可让旧令牌立即失效） |
| B8 | 镜像瘦身 / SBOM / 签名 | ❌ 三份前端依赖各自 `npm install`，镜像偏大；无 SBOM、无签名 | 改 pnpm workspace + 预构建产物挂载；`syft` 生成 SBOM、`cosign` 签名 |

## C. 数据与发布工程

| # | 项 | 现状 | 补齐条件 |
| --- | --- | --- | --- |
| C1 | Schema 版本化迁移 | 🟡 有 `db/schema.mysql.sql`（37 表全量）+ 一次性 `migrate-sqlite.mjs` | 引入 Flyway/Knex migrations：增量脚本 + 版本表 + 回滚脚本；容器启动前执行 |
| C2 | 冷数据归档 | ❌ 订单/日志无归档策略 | 按年归档到历史表/对象存储；后台查询默认走热表 |
| C3 | 财务对账 | 🟡 库内恒等式巡检 12 项（`healthcheck-mysql`）全绿 | 与支付渠道对账单逐笔核对（依赖 A2）、差异告警 |
| C4 | API 版本化 | ❌ 全部挂在 `/api/*`，无 `/api/v1` | 加版本前缀 + 弃用策略（现有 `gen-api-doc` 可自动追踪） |

## D. 测试与质量

| # | 项 | 现状 | 补齐条件 |
| --- | --- | --- | --- |
| D1 | 单元测试 | ✅ **172 个用例 / 23 个模块**（`node:test`，零第三方依赖）：`common/*`、`config`、`rule-engine`、`integrations/{sms,pay,ocr,wechat}` —— 含分账守恒、令牌篡改、口令散列、围栏内外点、微信通道（jscode2session/userinfo/授权 URL/白名单）、OCR 解析与腾讯云签名 | 服务层（orders/wallet/demands）仍依赖 DB 夹具，需先抽纯函数或引入事务夹具（见 `MIGRATION P32`） |
| D2 | 覆盖率门槛 | ✅ 已接入且**默认即门禁**：`tools/gate-unit.mjs`（Node 原生 `--experimental-test-coverage`）断言「失败用例=0 + 用例数≥60 + 每个目标模块行覆盖 ≥90% / 分支 ≥60% + 目标必须出现在报告里」；实测 **23 个模块行覆盖 99.4%（wechat/ocr/pay 等关键模块 100%）**，纳入 `npm run ci` 第 2 步与 CI `static` job | 需要更高门槛时用 `COVERAGE_MIN_LINES` / `COVERAGE_MIN_BRANCH` 调 |
| D3 | 依赖漏洞扫描 | 🟡 **已接入 npm audit**（`npm run audit:check`，纳入 `npm run ci` 静态第 3 步）：预算制 `deploy/audit-budget.json`（block / budget / expires），实测（2026-10-24）api-nest high 3（multer / body-parser / platform-express 同一条修复链，无上传中间件实际引用→不可达）、web-admin 0、web-mobile high 21（uni-app 构建链，只阻断 critical）；负向验证 4 类全红。**未做**：镜像 SBOM/漏洞扫描（trivy/grype 与 Docker Hub 均不可达） | 镜像源可达后加 `syft` + `trivy image` 扫描并纳入发布流程；web-mobile 待 uni-app 大版本升级后再收紧到阻断 high |
| D4 | 契约测试 / 前端 E2E | 🟡 后端：e2e **290 项**（参考实现）+ Nest 侧 §1–§20 173 项、security 53、rules 50、races 27、privacy 38、permissions 17、concurrency 23、巡检 12；前端产物契约：后台 **143** + 移动 **164**；另有 `ci:full` 32 步一键跑（P73 把此前只在本地跑的退款 / 发票提醒 / 支付回调 / 证件识别 4 个门禁并入 CI） | 补 Playwright 级 UI 流程回归（登录→找教员→立即预约→支付→打卡→结算） |
| D5 | 压测常态化 | 🟡 有基线（宿主机 + 容器两套），但非 CI 门禁 | 定期跑 `bench-nest` 并对比基线，超阈值告警 |
| D6 | 混沌/故障演练 | 🟡 **已有脚本并实测**：`npm run chaos:drill`（`tools/chaos-drill.mjs`）分别停 MySQL / Redis，断言「不崩溃（容器 RestartCount 不变）+ 快失败（不挂死）+ 明确报异常（health 503）+ 恢复后可用（health 200 且能登录）」，本机容器栈 **21 项全绿**；实测语义差异成立：**MySQL 挂 → 依赖读接口必须失败（400/503，不返回假成功）**、**Redis 挂 → 业务读仍 200（缓存不阻断主流程）** | 生产前在**预发环境**按同一脚本再跑一次（含真实流量与监控告警联动）；担保台账不平、定时任务重入两类演练尚未脚本化 |

## E. 已知环境限制（非工程缺口，仅记录）

| # | 项 | 说明 |
| --- | --- | --- |
| E1 | Docker Hub 直连 | 本机被阻断，已用 `registry-mirrors` 绕过并实测生效；换网络后可删配置 |
| E2 | `e2e`(153) / `rules`(50) 不在容器内跑 | 依赖 `send-code` 回显 `devCode`，镜像内 `NODE_ENV=production` 永久关闭该回显（安全设计）；由 CI 主机栈覆盖 |
| E3 | 容器延迟高于宿主机 25%~40% | WSL2 之上的端口转发（NAT）固有开销，非应用退化（见 `docs/PERF.md §6`） |
| E4 | GitHub run 级状态偶发延迟 | job 结论为准；曾出现 job 全绿而 run 状态延迟约 40 分钟转 success |

## 优先级建议（按「上线阻断程度」排序，D1/D2 已完成）

1. ~~**D1 单元测试（资金/规则）+ D2 覆盖率**~~ —— ✅ 已完成（172 用例 / 23 模块，行覆盖 99.4%，纳入 `npm run ci`）。
2. **A1 短信 + A2 支付真实通道** —— 模拟实现可演示不可上线，是当前唯一的**功能性**上线阻断项。A2 的服务端接线与前端唤起（`pay.js` / `parent.js`）都已完成，实际只剩「你给商户号凭证」一件事；A1 只剩 5 项短信密钥。
3. **B1 HTTPS + B3 定时备份与恢复演练** —— 上线前的最低安全与可恢复底线（备份脚本已具备，缺调度与异地留存）。
4. **D3 依赖漏洞扫描** —— 🟡 npm audit 已接入（预算制、CI 静态门禁）；镜像扫描待镜像源可达。
