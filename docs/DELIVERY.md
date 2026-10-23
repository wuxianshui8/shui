# 交付说明（DELIVERY）

> 交付对象：**家教上门撮合平台**
> 交付时间：2026-10-23　交付版本：`e002f97`（master = main，CI 双绿）
> 线上环境：腾讯云 `114.132.226.138`（Ubuntu 22.04.5 / 2 vCPU / 3.6 G / 50 G）

---

## 1. 交付了什么

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| 参考实现（5 端 UI + 后端） | `server/`、`web/` | 零构建原生 ESM + SQLite，作为 UI 蓝本；7 套测试套件 |
| 正式实现后端 | `apps/api-nest/` | NestJS 10 + MySQL 8 + Redis，**160 个路由 / 18 个控制器** |
| PC 管理后台 | `apps/web-admin/` | Vue3 + Vite + Element Plus，**20 个页面**（含自助改密） |
| 移动四端 | `apps/web-mobile/` | uni-app（H5 + 微信小程序双产物），**14 个页面** |
| 容器化交付 | `deploy/` | Dockerfile + compose（本地开发版 / 服务器版）+ Nginx + 系统加固 + 备份 timer |
| 运维工具 | `tools/` | 部署、冒烟、切域名、回写服务器状态、门禁等 |
| 文档 | `docs/` | 需求/接口/数据库/迁移/追溯/安全/上线清单/容器部署/运维手册（见 §6） |
| 门禁 | `tools/ci-full.mjs` | 一键 **30 步**（静态 16 + 集成 14） |

代码库规模：**304 个受版本控制文件 / 85 次提交**，`HEAD == origin/master == origin/main`，工作区干净。

---

## 2. 现在能访问什么

### 2.1 测试入口（当前唯一可用——域名尚未 ICP 备案）

| 入口 | 地址 |
| --- | --- |
| PC 管理后台 | `http://114.132.226.138/admin-vue/` |
| 移动四端 H5 | `http://114.132.226.138/m/` |
| 参考实现 5 端 | `http://114.132.226.138/parent.html`、`teacher.html`、`sales.html`、`agent.html`、`admin.html` |
| 健康检查 | `http://114.132.226.138/api/health`（匿名只返回可用性） |

### 2.2 演示账号（口令均为 `a123456`，**仅演示**）

| 角色 | 账号 | 备注 |
| --- | --- | --- |
| 平台管理员 | `13900000001` | 后台全部权限 |
| 家长 | `13900000301` | 周女士，有默认地址 |
| 教员 | `13900000201` / 用户名 `zhang` | 张老师，Lv5/名师 |
| 教员 | `13900000205` / 用户名 `chenzihao` | 陈子豪，Lv2 |
| 区域代理 | `13900000010` | 杭州·西湖片区 |
| 业务员 | `13900000101` | 陈晨 |

取短信验证码（测试环境）：`/opt/jiajiao/deploy/.env` 里 `SMS_MOCK_LOG_CODE=1` 时，码写在容器日志里
（`docker logs --tail 20 jiajiao-app-1 | grep 验证码`）；接口**永不**回显 `devCode`。

### 2.3 域名状态（**需要你方推进**）

`www.kd211.com` 与 `kd211.com` 的 A 记录都已指向服务器，证书已签发（Let's Encrypt，至 2027-01-21），
Nginx 也已配好 `80 → 443` + HSTS —— 但**域名未 ICP 备案，被腾讯云拦截**（HTTP 302 到 `webblock`、HTTPS 握手重置）。

**备案通过后跑一条命令即可切换**（脚本已就绪并演练过）：

```powershell
$env:DEPLOY_HOST = "kd211"; $env:DEPLOY_SUDO = "1"
$env:DOMAIN = "www.kd211.com"; $env:DOMAIN_ALT = "kd211.com"
$env:LETSENCRYPT_EMAIL = "admin@kd211.com"
node tools/switch-domain.mjs
```

---

## 3. 验收证据（2026-10-23 实测，非声称）

| 检查项 | 结果 |
| --- | --- |
| 容器 | `jiajiao-app-1` / `jiajiao-mysql-1` / `jiajiao-redis-1` 全部 **healthy**，`restart: always` |
| 健康检查 | `/api/health` → `status ok`，`db.ok=true`（MySQL 8）、`cache.ok=true`（Redis） |
| 四入口 | `/api/health` `/admin-vue/` `/m/` `/parent.html` 全部 **200**（服务器本机 + 本机公网双验证） |
| 数据规模 | **37 张表**、13 用户 / 11 订单 / 3 教员档案 / 17 组规则（含冒烟产生的数据） |
| 业务链路冒烟 | `npm run smoke:online` → **17/17 通过**：游客浏览 → 家长/教员/管理员登录 → 下单 → 担保支付 → 支付幂等 → 家长申请取消（不退款）→ 教员待处理列表 → 同意退款 → 后台可查 → 越权 403 |
| 单元测试 | **173 用例 / 23 模块**，行覆盖 **99.40%**（`npm run test:unit`，覆盖率门槛默认即门禁） |
| 接口契约 | **160 路由 / 18 控制器**（`npm run api:doc:check` 保证文档与代码不漂移） |
| 前端产物契约 | 后台 **70** 项 / 移动 **109** 项 |
| 集成门禁 | `npm run ci:full` **30 步全绿**（约 5 分钟） |
| CI | GitHub Actions：`e002f97` 在 master 与 main 均 **success** |
| 安全加固 | SSH 仅公钥（`passwordauthentication no` / `permitrootlogin no`）、ufw 只放 22/80/443、fail2ban 运行中、自动安全更新 enabled；外网探测 3306/6379/4300 **均 closed** |
| 认证接口限速 | 连续 20 次登录 → 第 2 次起 **429** |
| 备份 | 每日 03:24 定时；最近一次 `status ok`；DB 14 份 / 上传卷 4 份，合计 104 KB；**失败路径已实测**（退出码 1 + `LAST_STATUS` 记原因 + `OnFailure` 触发 + webhook 收到合法 JSON） |
| 证书 | `CN=www.kd211.com`，`notAfter=Jan 21 12:28:10 2027 GMT`，`certbot renew --dry-run` 通过 |
| 磁盘 | 50 G 用 15%（6.8 G） |

---

## 4. 系统架构（一句话版）

```
浏览器 / 小程序
   ↓ HTTPS（备案后）或 按 IP:80（当前）
Nginx（宿主机）   ← 限速 / 安全头 / HSTS / 反代
   ↓ 127.0.0.1:4300
jiajiao-app（Docker，NestJS 托 API + 后台 + H5 + 参考实现）
   ↓                         ↓
MySQL 8（容器，卷持久化）    Redis 7（容器）
```

- 应用**代码在镜像里**，宿主机没有源码；发版 = 本地构建 → `docker save` → 上传 → `load` → `compose up`
- MySQL / Redis **不对公网暴露**，只在 compose 内网；应用只绑 `127.0.0.1:4300`
- 上传目录（头像/证件图）独立命名卷 `jiajiao_app-uploads`，重建容器不丢

---

## 5. 交付后你方日常怎么用

| 场景 | 命令 / 位置 |
| --- | --- |
| 改配置（nginx / systemd / fail2ban / .env） | 直接上服务器改 → 校验 → reload → `npm run sync:server-state` 回写仓库 → 提交（见 `RUNBOOK §4`） |
| 改代码 | 本地改 → `npm run ci:full` → `node tools/deploy-remote.mjs`（镜像上传，约 2 分钟） |
| 看状态 | `npm run check:server-state`（仓库 vs 服务器）、`node tools/deploy-remote.mjs --status` |
| 业务回归 | `$env:SMOKE_BASE="http://114.132.226.138"; npm run smoke:online` |
| 看日志 | `ssh kd211 "sudo docker logs --tail 100 jiajiao-app-1"`、`/var/log/nginx/error.log` |
| 备份 / 恢复 | 每日自动；手动 `systemctl start jiajiao-backup.service`；恢复命令见 `RUNBOOK §3.6` |
| 重启 | `ssh kd211 "cd /opt/jiajiao/deploy && sudo docker compose -f docker-compose.prod.yml restart app"` |

---

## 6. 文档索引

| 文档 | 内容 |
| --- | --- |
| `README.md` | 项目总览、本地启动、门禁命令 |
| `docs/RUNBOOK.md` | **运维手册**：环境速查 / 巡检 / 常见操作 / 变更流程与红线 / 回滚手册 / 故障排查 |
| `docs/GO-LIVE-CHECKLIST.md` | 上线缺口清单（A 外部集成 / B 部署运维 / C 数据工程 / D 测试质量），逐项写补齐条件 |
| `docs/DEPLOY-CONTAINERS.md` | 容器部署、云服务器实测、域名备案拦截、一键切域名 |
| `docs/SECURITY.md` | 应用安全设计 + 主机加固实测记录（§9） |
| `docs/API-NEST.md` / `docs/API.md` | 正式实现 / 参考实现的接口总表（自动生成，漂移即失败） |
| `docs/DATABASE.md` | 37 张表结构与关系 |
| `docs/MIGRATION.md` | 全部开发阶段（P1–P61）的背景、做法、门禁变化（**共 61 行，逐条可追溯**） |
| `docs/TRACEABILITY*.md` | 需求 → 接口 → 页面 → 门禁 的逐条追溯 |
| `docs/INTEGRATIONS.md` | 外部通道（短信/支付/OCR/微信登录）的现状与接线步骤 |
| `docs/HANDOVER.md` / `docs/PERF.md` | 交接要点 / 性能基线与压测 |

---

## 7. 尚未完成（如实列出，按影响排序）

### 7.1 需要你方提供凭证才能推进（功能性上线阻断）

| 通道 | 现状 | 需要你给 |
| --- | --- | --- |
| 短信（A1） | 腾讯云通道代码就绪 + 单测覆盖，mock 可跑 | `SecretId`/`SecretKey`/`SdkAppId`/已备案签名/模板 ID |
| 微信支付（A2） | 通道 + 服务端接线完成（预支付/回调幂等/退款/超时关单/对账骨架） | 商户号 8 项 + 公网 HTTPS 回调地址；**前端唤起**（`requestPayment`/`WeixinJSBridge`）待接 |
| 小程序上架（A5） | `mp-weixin` 14 页产物 + `jscode2session` 登录 | `WECHAT_APPID/SECRET`、审核发布、手机号快速验证、订阅消息模板 |
| 证件识别（A6） | 腾讯云 OCR 通道就绪 | `TENCENT_SECRET_ID/KEY` + 开通 OCR |
| 打款出款 | 后台确认（状态置 `paid`）可用，钱仍需线下转 | 代付通道资质（或明确长期线下 + SLA） |

### 7.2 工程缺口（可继续做，不阻断测试）

| 项 | 现状 |
| --- | --- |
| **域名 ICP 备案** | ❗ 唯一阻断"正式对外"的问题（见 §2.3） |
| 异地/对象存储备份 | 备份与服务器同机，机器挂了两者一起没；RPO/RTO 未定义 |
| 监控告警 | 只有 `/api/health`；无 Prometheus/Grafana/告警规则 |
| 日志集中化 | 只有 `docker logs` 与 Nginx 文件，无 Loki/ELK、无 `trace_id` 串联 |
| 多实例扩容 | 验证码/失败计数/规则缓存在进程内（单实例） |
| 灰度回滚 | 镜像无 tag 策略（当前用 `latest` + 手工留 tar） |
| 镜像 SBOM/签名 | 未做（需 `syft`/`cosign`） |
| Playwright UI 回归 | 未做（现有前端为产物级契约 70 + 109） |
| 地图合规 | 在线瓦片用无 key 公开端点，生产需换自有/天地图 + 审图号；缺地址逆地理编码 |

> 完整清单与"补齐条件"见 `docs/GO-LIVE-CHECKLIST.md`。

---

## 8. 上线前必须做的三件事

1. **完成域名 ICP 备案**（境内服务器唯一合规解），然后跑 `node tools/switch-domain.mjs` 切 HTTPS；
   注意证书 2027-01-21 到期且**备案前无法续期**。
2. **换掉演示口令**：`a123456` 只用于演示；后台建号走一次性强口令 + 首登强制改密。
3. **接真实通道**（§7.1 的短信 + 支付），并把 `.env` 里的 `SMS_MOCK_LOG_CODE` 改回 `0`。

---

## 9. 环境与访问

| 项 | 值 |
| --- | --- |
| 服务器 | `114.132.226.138`（腾讯云，Ubuntu 22.04.5） |
| SSH | `ubuntu` 用户 + **仅公钥**（密码与 root 登录已禁用），`sudo` 免密；本机别名 `kd211` |
| 部署目录 | `/opt/jiajiao/deploy`（`.env` 权限 600，**不入库**） |
| 备份目录 | `/var/backups/jiajiao` |
| 证书 | `/etc/letsencrypt/live/www.kd211.com` |
| 代码仓库 | `https://github.com/wuxianshui8/shui`（分支 `master`，同时推 `main`） |

> 安全提醒：运维公钥在 `ubuntu:~/.ssh/authorized_keys`，不需要时删除该行（删前确认有其它入口并保留腾讯云 VNC 退路）。

---

## 10. 责任边界（供验收参考）

- 本交付覆盖：需求书范围内的功能实现、双轨（参考实现 + 正式实现）、自动化门禁、容器化部署、云服务器上线与加固、运维文档与脚本。
- 不含（需你方资质/账号）：域名备案、真实短信/支付/OCR/小程序资质、对象存储、代付通道、监控与日志 SaaS 账号。
- 所有"已验证"结论均有对应命令或实测记录（见 §3）；未验证项已在 §7 明确标注。
