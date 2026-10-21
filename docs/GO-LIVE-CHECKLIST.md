# 上线待办清单（GO-LIVE CHECKLIST）

> 这份清单回答一个问题：**「需求书验收」之外，真上线还缺什么**。
> 与 `docs/TRACEABILITY-NEST.md` 的「偏离与说明」互补：那里记的是「与需求书文字的差异」，
> 这里记的是「需求书没要求、但生产环境必需」的工程件。
>
> 状态口径：✅ 已具备 / 🟡 部分具备（有替代方案，但不达生产标准） / ❌ 未做。
> 每项都写明**补齐条件**，避免"知道要做什么但不知道从哪下手"。

## A. 外部集成（需求书允许模拟，上线必须接真实通道）

| # | 项 | 现状 | 补齐条件 |
| --- | --- | --- | --- |
| A1 | 短信验证码 | 🟡 **代码已就绪，待密钥**：腾讯云短信通道已实现（`src/integrations/sms/`：TC3-HMAC-SHA256 签名、SendSms 请求体、错误码分支、`SMS_PROVIDER=mock/tencent` 工厂、缺配置/占位串启动即拒绝），单测 101 项覆盖签名与错误分支；`SMS_PROVIDER=tencent` + 5 项密钥即可真实下发 | 你提供：`SecretId`/`SecretKey`/`SdkAppId`/已备案签名/模板 ID（模板变量 ${1}=验证码、${2}=分钟） |
| A2 | 支付通道 | 🟡 担保交易**真实记账**（`escrow_ledger`、分账恒等式、幂等键、退款流水），但无真实支付网关 | 接微信支付/支付宝：下单拿 `prepay_id`、异步回调**验签**、对账文件解析、退款 API；现有 `POST /orders/:id/pay` 与幂等键设计可直接挂接 |
| A3 | 地图与围栏 | 🟡 距离=Haversine、片区=多边形围栏均为真实算法；片区数据为**矩形近似**，无地图 SDK、无逆地理编码 | 接高德/腾讯地图：地址→经纬度逆解析、片区多边形改为真实行政边界；前端地图选点 |
| A4 | 文件存储 | ❌ 证书/头像走 **URL 字段**，无上传、无对象存储、无内容安全扫描 | 接 OSS/COS + 直传签名；证书图片做图片鉴黄/病毒扫描；DB 只存 key |
| A5 | 微信小程序上架 | 🟡 已产出 `mp-weixin` 工程（10 页）可直接导入开发者工具并构建 | 未做：小程序**审核发布**、`openid/unionid` 登录打通、手机号快速验证、订阅消息模板 |
| A6 | 消息推送 | 🟡 站内消息（`messages` 表 + 移动端消息中心，可标已读） | 接 APNs/FCM/微信模板消息：用户设备 token 管理、推送到达率监控 |
| A7 | 电子合同 | 🟡 `agreements` 表与接口存在 | 接 e签宝/法大大：发起签署、回调存证、PDF 归档 |
| A8 | 电子发票 | 🟡 开票申请→财务受理→回写票面地址（全流程可跑） | 接税务/电子发票平台：真实开票、红冲、票面 PDF |

## B. 部署与运维

| # | 项 | 现状 | 补齐条件 |
| --- | --- | --- | --- |
| B1 | HTTPS / 域名 / 证书 | ❌ 应用只监听 HTTP（令牌为 Bearer，明文会被截获） | 前置 Nginx/Caddy 或云 LB + ACME 自动续期；`TRUST_PROXY=1` 已在 compose 中预留（**务必只在前置代理时打开**，否则登录锁定可被伪造 XFF 绕过） |
| B2 | 多实例水平扩容 | ❌ 验证码/登录失败计数、规则配置内存缓存均为**单实例**（规则缓存有 300s TTL） | 按 `docs/SECURITY.md §8 第 11 条` 全部迁到 Redis；会话无状态（当前令牌自包含，可直接多实例）、补共享限流 |
| B3 | 备份自动化与演练 | ✅ **已完成**：`npm run db:backup`（自检「表 37 + 含 orders」）/ `db:restore`（恢复前后双重校验）+ **保留策略**（`KEEP`/`--keep`，默认留 14 份，实测剪枝正确）+ `tools/backup-schedule.ps1`（Install/Uninstall/Status/RunNow，生成固定 node/docker 路径的 `backup-run.cmd` 与 `backup.log`）+ 破坏性恢复回环实测。**仍缺**：异地/对象存储归档、RPO/RTO 定义、每月恢复演练排期 | 上传对象存储（版本化 + 生命周期）+ 写一页 RPO/RTO；⚠️ 安装计划任务需管理员会话（本机 Agent 会话 `schtasks /Create` 返回 Access is denied，该段未实测，其余链路已实测） |
| B4 | 监控与告警 | 🟡 有 `/api/health`（匿名仅可用性）与 `/api/health/detail`（管理员，含用户数/订单/担保额/DB+Redis 延迟） | 接 Prometheus 指标端点 + Grafana 面板 + 告警规则（错误率/延迟/担保台账不平/任务卡死） |
| B5 | 日志集中化 | 🟡 应用日志走 stdout（容器 `docker logs` 可看） | 接 Loki/ELK：结构化 JSON 日志、保留策略、按 `trace_id` 串联；审计日志已在库内（`audit_logs`） |
| B6 | 灰度与回滚 | ❌ 无镜像 tag 策略、无一键回滚脚本 | 镜像按 git sha 打 tag，compose 固定 tag；回滚 = 改 tag + `up -d`；DB 变更走向后兼容的两步法 |
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
| D1 | 单元测试 | ✅ **82 个用例**（`node:test`，零第三方依赖）：`common/{codes,errors,geo,paging,password,reply,token}`、`config`、`rule-engine` —— 含分账守恒 784 组组合、代理→业务员超额截断、令牌篡改/过期/换密钥、口令散列与盐、电子围栏内外点、分页上下限、生产环境缺 `AUTH_SECRET` 拒绝启动 | 服务层（orders/wallet/demands）仍依赖 DB 夹具，需先把纯计算抽成函数或引入事务夹具；当前缺口已记录在 `MIGRATION P32` |
| D2 | 覆盖率门槛 | ✅ 已接入且**默认即门禁**：`tools/gate-unit.mjs` 用 Node 原生 `--experimental-test-coverage`（未引入 c8，根目录保持零依赖），断言「失败用例=0 + 用例数≥60（防空检查）+ 每个目标模块行覆盖 ≥90% / 分支 ≥60% + 目标必须真的出现在报告里」；实测 9 个模块行覆盖 **98.51%~100%（合计 99.65%）**，已纳入 `npm run ci` 静态第 2 步与 CI `static` job | 需要更高门槛时用 `COVERAGE_MIN_LINES` / `COVERAGE_MIN_BRANCH` 调；分支覆盖率天然受防御性 `catch` 影响，规则层的 `catch` 分支暂无夹具 |
| D3 | 依赖漏洞扫描 | 🟡 **已接入 npm audit**（`npm run audit:check`，纳入 `npm run ci` 静态第 3 步）：预算制 `deploy/audit-budget.json`（block / budget / expires），实测 api-nest high 2（multer 链，无上传端点→不可达）、web-admin 0、web-mobile high 27（uni-app 构建链，只阻断 critical）；负向验证 4 类全红。**未做**：镜像 SBOM/漏洞扫描（trivy/grype 与 Docker Hub 均不可达） | 镜像源可达后加 `syft` + `trivy image` 扫描并纳入发布流程；web-mobile 待 uni-app 大版本升级后再收紧到阻断 high |
| D4 | 契约测试 / 前端 E2E | 🟡 后端 484 项集成断言 + 82 项单元断言 + 前端产物契约 38/41 + 浏览器多尺寸校验 16 项 | 补 Playwright 级 UI 流程回归（登录→下单→支付→打卡→结算） |
| D5 | 压测常态化 | 🟡 有基线（宿主机 + 容器两套），但非 CI 门禁 | 定期跑 `bench-nest` 并对比基线，超阈值告警 |
| D6 | 混沌/故障演练 | ❌ 无 | 演练 MySQL/Redis 中断、担保台账不平、定时任务重入 |

## E. 已知环境限制（非工程缺口，仅记录）

| # | 项 | 说明 |
| --- | --- | --- |
| E1 | Docker Hub 直连 | 本机被阻断，已用 `registry-mirrors` 绕过并实测生效；换网络后可删配置 |
| E2 | `e2e`(153) / `rules`(50) 不在容器内跑 | 依赖 `send-code` 回显 `devCode`，镜像内 `NODE_ENV=production` 永久关闭该回显（安全设计）；由 CI 主机栈覆盖 |
| E3 | 容器延迟高于宿主机 25%~40% | WSL2 之上的端口转发（NAT）固有开销，非应用退化（见 `docs/PERF.md §6`） |
| E4 | GitHub run 级状态偶发延迟 | job 结论为准；曾出现 job 全绿而 run 状态延迟约 40 分钟转 success |

## 优先级建议（按「上线阻断程度」排序，D1/D2 已完成）

1. ~~**D1 单元测试（资金/规则）+ D2 覆盖率**~~ —— ✅ 已完成（82 用例、9 模块行覆盖 ≥ 98.5%，纳入 `npm run ci`）。
2. **A1 短信 + A2 支付真实通道** —— 模拟实现可演示不可上线；这是当前唯一的**功能性**上线阻断项。
3. **B1 HTTPS + B3 定时备份与恢复演练** —— 上线前的最低安全与可恢复底线（备份脚本已具备，缺调度与异地留存）。
4. **D3 依赖漏洞扫描** —— 🟡 npm audit 已接入（预算制、CI 静态门禁）；镜像扫描待镜像源可达。
