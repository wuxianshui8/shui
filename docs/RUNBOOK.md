# 运维手册（RUNBOOK）

> 面向「这台机器上出问题/要改东西」时照着敲。所有命令都在**测试服务器**
> （`kd211` = `ubuntu@114.132.226.138`，腾讯云 · Ubuntu 22.04.5）上实测过。
>
> 更新：2026-10-23。改动机器前先读第 4 节「变更流程与红线」。

---

## 1. 环境速查

| 项 | 值 |
| --- | --- |
| SSH | `ssh kd211`（`~/.ssh/config` 别名；`ubuntu` 用户 + 专用密钥 `~/.ssh/id_pi_deploy`；**密码与 root 登录已关闭**，`sudo` 免密） |
| 系统 | Ubuntu 22.04.5 / 2 vCPU / 3.6 G / 50 G（内核 5.15） |
| 部署目录 | `/opt/jiajiao/deploy`（`docker-compose.prod.yml` + `.env`(600)） |
| 应用镜像 | `jiajiao-app:latest`（本机 `docker save` 上传后 `docker load`，服务器上不构建） |
| 容器 | `jiajiao-app-1` / `jiajiao-mysql-1` / `jiajiao-redis-1`（全 `restart: always`） |
| 数据卷 | `jiajiao_mysql-data`、`jiajiao_app-uploads`（**重建容器不丢**） |
| 端口（对外） | 22 / 80 / 443；**3306 / 6379 / 4300 只在内网或回环**（实测外网 closed） |
| 应用监听 | `127.0.0.1:4300`（由 Nginx 反代） |
| Nginx | 站点 `/etc/nginx/sites-available/jiajiao.conf`（备份 `.bak`）；全局加固 `/etc/nginx/conf.d/00-hardening.conf` |
| 证书 | Let's Encrypt `/etc/letsencrypt/live/www.kd211.com`（`certbot.timer` 自动续期；到期 2027-01-21） |
| 日志 | `docker logs jiajiao-app-1`、`/var/log/nginx/{access,error}.log`、`journalctl -u ssh` |
| 安全组件 | ufw（放 22/80/443）、fail2ban（sshd aggressive）、unattended-upgrades、sysctl `99-hardening.conf` |

**当前测试入口（域名未备案，只能按 IP 访问）**

| 入口 | 地址 |
| --- | --- |
| PC 管理后台 | `http://114.132.226.138/admin-vue/` |
| 移动四端 H5 | `http://114.132.226.138/m/` |
| 参考实现 5 端 | `http://114.132.226.138/parent.html` 等 |
| 健康检查 | `http://114.132.226.138/api/health` |

演示账号口令均 `a123456`：管理员 `13900000001`、家长 `13900000301`、张老师 `13900000201`（用户名 `zhang`）、代理 `13900000010`、业务员 `13900000101`。

---

## 2. 日常巡检（只读，随时可跑）

```bash
# 容器是否健康
ssh kd211 "sudo -n docker ps --format '{{.Names}} {{.Status}}'"

# 应用 + DB + Redis 健康状况（db.ok / cache.ok 必须 true）
ssh kd211 "curl -s http://127.0.0.1:4300/api/health"

# 四入口（服务器本机）
ssh kd211 "for p in /api/health /admin-vue/ /m/ /parent.html; do printf '%s ' \$p; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1\$p; done"

# Nginx 最近错误
ssh kd211 "sudo -n tail -n 30 /var/log/nginx/error.log"

# SSH 攻击面（被 ban 的 IP）
ssh kd211 "sudo -n fail2ban-client status sshd"

# 磁盘 / 内存
ssh kd211 "df -h /; free -h"

# 证书到期时间
ssh kd211 "sudo -n openssl x509 -in /etc/letsencrypt/live/www.kd211.com/fullchain.pem -noout -enddate"

# 每日备份：最近一次结果 + 定时器下次触发
ssh kd211 "sudo -n cat /var/backups/jiajiao/LAST_STATUS"
ssh kd211 "sudo -n ls -lt /var/backups/jiajiao | head -3"
ssh kd211 "sudo -n systemctl list-timers jiajiao-backup.timer --no-pager"

# 备份失败的历史（journal error 级）
ssh kd211 "sudo -n journalctl -u jiajiao-backup -p err --since '-7 days' --no-pager | tail -20"
```

业务级冒烟（**会真实建单并退款**，只对测试环境跑）：

```powershell
$env:SMOKE_BASE = "http://114.132.226.138"; npm run smoke:online
```

---

## 3. 常见操作

### 3.1 发版（改代码 → 上线）

```powershell
# 本机执行；改完代码并跑过门禁后再发
$env:DEPLOY_HOST = "kd211"; $env:DEPLOY_SUDO = "1"
$env:IMAGE_TAR = "$env:PI_SCRATCH_DIR\jiajiao-app.tar"

docker save -o $env:IMAGE_TAR jiajiao-app:latest     # 旧包先留一份，这就是回滚点
npm run ci:full -- --static                          # 静态门禁 16 步
node tools/deploy-remote.mjs                         # 上传 → load → up -d --no-build → 健康检查
node tools/deploy-remote.mjs --status                # 复查
```

> `deploy-remote.mjs` 只上传 compose + schema + `.env`，不动服务器其它目录。

### 3.2 重启 / 重载

```bash
ssh kd211 "cd /opt/jiajiao/deploy && sudo -n docker compose -f docker-compose.prod.yml restart app"
ssh kd211 "sudo -n nginx -t && sudo -n systemctl reload nginx"
ssh kd211 "sudo -n systemctl restart fail2ban"
```

> `nginx reload` 是**异步**的：reload 后要 `sleep 2` 再验证，否则会读到旧 worker（本手册踩过）。

### 3.3 改 Nginx 站点配置

```bash
ssh kd211 "sudo -n cp /etc/nginx/sites-available/jiajiao.conf /etc/nginx/jiajiao.conf.bak"   # ① 备份
# ② 写新配置（用 heredoc / base64 写，别用 sed 硬改多行块）
ssh kd211 "sudo -n nginx -t"                                                                  # ③ 语法
ssh kd211 "sudo -n systemctl reload nginx"                                                    # ④ 生效
ssh kd211 "sleep 2; curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: www.kd211.com' http://127.0.0.1/api/health"  # ⑤ 验证
```

> **线上配置长什么样**：`deploy/server-state/` 是服务器上真实生效的全套配置快照（nginx / ssh / fail2ban / sysctl / docker / systemd / 备份脚本 / compose）。
> `npm run check:server-state` 可随时比对「仓库 vs 服务器」；不一致时会列出是哪几个文件。见 §4。

### 3.4 灌/重置演示数据

```bash
ssh kd211 "cd /opt/jiajiao/deploy && sudo -n docker compose -f docker-compose.prod.yml run --rm seed"
```

> **坑**：`docker compose run` 会吃掉 stdin，导致同一条脚本里后面的命令不执行 —— 手动跑没问题，写脚本时要加 `< /dev/null`。

### 3.5 取短信验证码（测试环境）

```bash
ssh kd211 "curl -s -o /dev/null -X POST http://127.0.0.1:4300/api/auth/send-code -H 'Content-Type: application/json' -d '{\"phone\":\"13900000301\"}'"
ssh kd211 "sudo -n docker logs --tail 20 jiajiao-app-1 | grep 'SMS_MOCK_LOG_CODE=1'"
```

`.env` 里 `SMS_MOCK_LOG_CODE=1` 时日志形如 `验证码=751202 手机号=139****0301 有效期=300s`；接口**永不**回显 `devCode`。生产务必改回 `0`。

### 3.6 备份（已装定时任务）

**每日 03:20 自动跑**（`jiajiao-backup.timer`，错峰 ±10 分钟，关机错过会在开机后补跑）：

| 产出 | 保留 |
| --- | --- |
| `/var/backups/jiajiao/jiajiao-<时间戳>.sql.gz`（DB，37 表） | 14 份 |
| `/var/backups/jiajiao/uploads-<时间戳>.tar.gz`（头像/证件图所在卷） | 7 份 |
| `/var/backups/jiajiao/LAST_STATUS`（最近一次结果 JSON） | 覆盖写 |

**手动跑 / 排查**

```bash
ssh kd211 "sudo -n systemctl start jiajiao-backup.service"          # 立刻跑一次
ssh kd211 "sudo -n cat /var/backups/jiajiao/LAST_STATUS"            # 最近结果
ssh kd211 "sudo -n journalctl -u jiajiao-backup -n 30 --no-pager"   # 明细
ssh kd211 "sudo -n systemctl list-timers jiajiao-backup.timer"      # 下次触发
```

脚本内建**防空校验**：gzip 完整性 + 表数量 < 30 直接判失败（不会留个空壳备份），且先写 `.tmp` 再原子改名。

**装/更新定时任务**（脚本即期望状态，幂等）

```bash
# 把 deploy/ 下的脚本和 systemd/ 目录一起传上去后：
ssh kd211 "sudo -n bash /tmp/bk/deploy/install-backup.sh"           # 装 + 立刻跑一次
ssh kd211 "sudo -n bash /tmp/bk/deploy/install-backup.sh --check"   # 只体检
```

**失败通知**：`OnFailure=jiajiao-backup-notify.service` → 写 journal（error 级）+ 可选 webhook。开启方式是在 `/opt/jiajiao/deploy/.env` 里加一行：

```bash
BACKUP_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
```

POST 的 JSON 同时带 `msgtype/text.content`（企业微信/钉钉/飞书）与顶层 `content`，用 `json.dumps` 精确转义；HTTP 状态码会打到 journal（`[backup-notify] webhook HTTP 200`）。没配 webhook 时失败只进 journal，用上面 §2 的巡检命令能看到。

**恢复**

```bash
ssh kd211 "gunzip -c /var/backups/jiajiao/jiajiao-<时间戳>.sql.gz | sudo -n docker exec -i jiajiao-mysql-1 sh -c 'mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\"'"
```

---

## 4. 变更流程与红线

### 4.1 三类改动分别怎么走（现行约定，2026-10-23 起）

| 类别 | 例子 | 在哪改 | 生效方式 |
| --- | --- | --- | --- |
| **① 运行时资料/数据** | 公告、协议文案、规则配置、片区、用户、订单 | 后台界面或 API（优先）；必须动 SQL 时先备份 | 立即生效（无需重启） |
| **② 服务器配置** | nginx、systemd、fail2ban、sshd drop-in、sysctl、docker daemon、`.env` | **可以直接在服务器上改** | `nginx -t` / `sshd -t` 校验 → reload → 验证 → **回写仓库**（见 4.2） |
| **③ 应用代码** | `apps/`、`server/`、`web/` | 只能在本地仓库改（服务器上没有源码，代码在镜像里） | 本地构建镜像 → `docker save` → 上传 → `compose up -d --no-build` |

> ③ 为什么不能直接改服务器：宿主机没有源码，改了也不生效（代码在镜像层 `/app/apps/api-nest/dist/main.js`），重启容器也没用。

### 4.2 直接在服务器上改配置后，必须回写仓库

```powershell
$env:DEPLOY_HOST = "kd211"; $env:DEPLOY_SUDO = "1"
npm run sync:server-state      # 把服务器现状抓回 deploy/server-state/ + 更新 MANIFEST
git diff deploy/server-state   # 看到"我改了什么"
git add -A; git commit -m "..."   # 提交（这是服务器改动进仓库的唯一入口）
npm run check:server-state     # 复核：仓库与服务器是否一致（不一致时列出文件）
```

抓取范围：nginx 站点与全局加固、sshd drop-in、fail2ban、sysctl、docker daemon、3 个 systemd 备份单元、2 个备份脚本、`docker-compose.prod.yml`。
**不抓 `.env`**（含 `AUTH_SECRET` / `DB_PASSWORD` / webhook），脚本里还有一道「疑似密钥就中止」的检查。

### 4.3 每次改动的固定动作

先看状态 → 改 → 语法校验（`nginx -t` / `sshd -t` / `bash -n`）→ 生效（reload / restart）→ 双层验证（服务器本机 curl + 本机公网 curl，必要时 `npm run smoke:online`）→ 回写仓库并提交 → 告知回滚办法。

备份约定：改 Nginx 前 `cp` 到 `/etc/nginx/jiajiao.conf.bak`；改 sshd 前备份 `/root/sshd-backup-<时间戳>/`。

**红线**

1. 不把密码 / 私钥 / `.env` / 证书私钥写进仓库；`.env` 权限 600，只在服务器与本机本地。
2. 动 sshd / ufw 前**必须**先确认公钥能登录；改完立刻验证，失败立即回滚（`sshd -t`、`nginx -t` 是硬门槛）。
3. 破坏性数据操作前先备份；`DROP`/`TRUNCATE` 一律先问。
4. 不在服务器上直接改代码：代码只有一条路 —— 本地改 → 门禁 → 进仓库 → 部署。
5. 通道类开关（`PAY_PROVIDER` / `SMS_PROVIDER` / `OCR_PROVIDER`）保持 `mock`，切真实通道需要凭证且需明确同意。

**已知操作坑**

- PowerShell 会把内联命令里的引号和中文打散 → 长命令写成 `.sh` 文件再 `bash -s` 管道执行。
- 仓库内中文文件**不要**用 PowerShell `Set-Content` 回写（会转码+BOM 损坏），只用编辑器/`Write`。
- `docker compose run` 吞 stdin（见 3.4）。
- `nginx reload` 异步（见 3.2）。

---

## 5. 回滚手册

| 改了什么 | 回滚命令 | 备份在哪 |
| --- | --- | --- |
| SSH 加固 | `sudo rm /etc/ssh/sshd_config.d/99-hardening.conf; sudo systemctl reload ssh`（恢复密码登录再加 `PasswordAuthentication yes`） | `/root/sshd-backup-<时间戳>/` |
| Nginx 站点 | `sudo cp /etc/nginx/jiajiao.conf.bak /etc/nginx/sites-available/jiajiao.conf; sudo nginx -t; sudo systemctl reload nginx` | `/etc/nginx/jiajiao.conf.bak` |
| 应用镜像 | 本机 `docker load -i <旧 jiajiao-app.tar>` → 上传 → `docker load` → `compose up -d --no-build` | 每次发版前保存的 `jiajiao-app.tar` |
| 防火墙 | `sudo ufw disable`（临时）或 `sudo ufw delete allow <port>` | `/etc/default/ufw`（`DEFAULT_FORWARD_POLICY` 改过） |
| Nginx 全局加固 | 备份后删 `/etc/nginx/conf.d/00-hardening.conf` 并 reload（会把版本号隐藏与认证限速一并撤掉） | 由 `deploy/harden-server.sh` 或 `tools/switch-domain.mjs` 重新生成（两者写出的文件逐字节一致） |
| fail2ban | `sudo systemctl stop fail2ban`（临时）；或删 `/etc/fail2ban/jail.local` 后重启 | `/etc/fail2ban/jail.local` |
| 内核参数 | 删 `/etc/sysctl.d/99-hardening.conf` 后 `sudo sysctl --system` | 原值未动（新增文件） |
| Docker 守护 | 删 `daemon.json` 里 `live-restore`/`no-new-privileges` 后 `sudo systemctl restart docker` | `/etc/docker/daemon.json` |
| 主机加固整体 | `deploy/harden-server.sh` 幂等，可重跑到一致状态 | 脚本本身即「期望状态」 |
| 数据 | `gunzip < xx.sql.gz \| docker exec -i jiajiao-mysql-1 mysql -uroot -p<口令>` | `/var/backups/jiajiao/` |
| 备份定时任务 | `sudo systemctl disable --now jiajiao-backup.timer`（停用）；重装用 `deploy/install-backup.sh` | `/opt/jiajiao/bin/*.sh` + `/etc/systemd/system/jiajiao-backup*` |

**证书/域名切换失败**：`node tools/switch-domain.mjs` 内部已做「失败自动回滚到 `/etc/nginx/jiajiao.conf.bak`」，重跑即可。

---

## 6. 故障排查

| 现象 | 先看 | 常见原因 / 处理 |
| --- | --- | --- |
| 页面 502 | `docker ps`、`docker logs jiajiao-app-1` | 应用没起来（`.env` 缺 `AUTH_SECRET`/`DB_PASSWORD` 会拒绝启动）→ 看日志第一屏 |
| `/api/health` 里 `db.ok=false` | `docker logs jiajiao-mysql-1` | MySQL 未 healthy（首次启动要建 37 表，约 20-40s）；或卷权限问题 |
| 图文上传失败 400「参数不合法」 | `docker logs jiajiao-app-1` 里 `EACCES` | 上传卷属主不对：`docker volume rm jiajiao_app-uploads` 后重建（会丢历史图） |
| 登录突然大批失败 | `fail2ban-client status sshd`、`/var/log/nginx/error.log` 里 `limiting requests` | 认证接口限速触发（30r/m、突发 10）→ 属预期；确认不是自家 IP 被限 |
| 域名打不开 / 302 到 webblock | 第 1 节入口说明 | **域名未 ICP 备案被拦截**，境内服务器无解；备案通过后跑 `tools/switch-domain.mjs` |
| 证书快到期且续期失败 | `sudo certbot renew --dry-run` | 域名被拦截时 HTTP-01 必然失败；备案或换域名，注意 2027-01-21 到期 |
| 磁盘满 | `df -h /`、`docker system df` | 清日志 `docker system prune`（**先确认没有要留的镜像**）、`du -sh /var/lib/docker/containers/*` |
| 自己 SSH 进不去 | 腾讯云控制台 VNC | 检查 `~/.ssh/id_pi_deploy` 是否还在、`ubuntu:~/.ssh/authorized_keys` 那一行是否被删、`ufw` 是否放 22 |
| 数据错乱/对不上账 | `npm run nest:health:mysql`（12 项不变量） | 差异项会直接打印是哪张表哪条 |

---

## 7. 待办（运维侧尚未完成）

1. ~~**备份定时任务**~~：✅ 已完成（2026-10-23，`jiajiao-backup.timer` 每日 03:20、DB 留 14 份、上传卷留 7 份、失败走 `OnFailure` + webhook）。仍缺**异地/对象存储归档**（同一台机器上，机器挂了备份也没了）。
2. **监控告警**：Prometheus/Grafana + 告警规则（错误率/延迟/担保台账不平/任务卡死）。
3. **日志集中化**：Loki/ELK + `trace_id` 串联（当前只有 `docker logs` 与 Nginx 文件）。
4. **域名备案**：备案通过后 `node tools/switch-domain.mjs` 切回 `https://www.kd211.com`。
5. **演示口令替换**：生产前把 `a123456` 全部换掉（后台建号已是一次性强口令 + 首登强制改密）。

---

## 8. 变更记录（追加）

| 日期 | 变更 | 结果 |
| --- | --- | --- |
| 2026-10-23 | 首次部署（镜像上传 + compose + seed + Nginx + Let's Encrypt） | 三容器 healthy、四入口 200、冒烟 17/17 |
| 2026-10-23 | `switch-domain.mjs` 自带认证限速与全局加固，新增 `--expand`/`--skip-certbot`；`--dry-run` 把配置写到本机临时目录 | 演练实跑：`authlimit` 命中 2 处、20 次登录第 2 次起 429、IP 四入口 200；certbot 缺 `--expand` 时正确自动回滚 |
| 2026-10-23 | 线上真实 nginx 配置快照入库 `deploy/nginx/jiajiao.conf.deployed` | 仓库可 diff / 审计；消除「服务器配置与仓库模板不一致」的盲区 |
| 2026-10-23 | 发现域名未备案被拦截（302 → webblock、HTTPS 重置） | 增加按 IP 的 80 `default_server` 测试入口 |
| 2026-10-23 | 主机加固（SSH 仅公钥/禁 root、ufw、fail2ban、自动更新、sysctl、Docker、Nginx 限速） | 密码与 root 登录被拒；限速第 6 次起 429；业务冒烟 17/17 无回归 |
| 2026-10-23 | 新增 `SMS_MOCK_LOG_CODE`（测试环境从日志取验证码） | 日志取码 → 验证码登录成功；接口仍不回显 `devCode` |
| 2026-10-23 | 每日备份定时任务（systemd timer + 保留策略 + 防空校验 + 失败 webhook） | 手动/定时均可跑；剪枝 18→14 正确；故意制造失败 → 退出码 1、`LAST_STATUS` 记原因、`OnFailure` 触发通知、webhook 收到**合法 JSON**（HTTP 200）；备份 11 KB / 37 表 + 上传卷 4 KB |
| 2026-10-24 | 上线 `0440e6a`（P64）：镜像重建 → `deploy-remote.mjs` 上传 87 MB → `compose up -d --no-build`；旧 5 端 UI 的 `web/assets/js/admin.js` 随之更新（Nest 侧 `POST /api/auth/change-password`、`DELETE /api/admin/admins/:id` 早已存在，故只换静态产物即可） | 三容器 healthy、四入口 200；线上接口验收 **26/26**（含未改密前 `MUST_CHANGE_PASSWORD`、改密后旧令牌 401、软删/硬删/重复删 404/删自己 403、列表回 `[1]`）；真实浏览器 DOM 验收：顶栏「🔑 修改口令」弹三字段、空提交被前端拦、列表「操作」列有「删除」+ 二次确认文案含软/硬删说明；业务冒烟 17/17；演示账号口令未动（残留一个**软删除**临时管理员 id=19，已匿名化且不在列表） |
| 2026-10-24 | 上线 `f5c8cd0`（P65 家长到教员处授课）：镜像重建 → `deploy-remote.mjs` 上传 87 MB → `compose up -d --no-build`；启动时 `schema-guard` 自动补两列（日志：`[schema] 老库补列 teacher_profiles.base_address` / `orders.place`） | 三容器 healthy、四入口 200、业务冒烟 **17/17**；线上接口验收 **15/15**（旧 5 端产物含「我到教员处」/后台含「授课方式」列/教员端含「授课地址」；教员存授课地址后家长详情 `acceptAtTeacherPlace=true`；`place=teacher_place` 下单地点自动变教员地址 + `placeText`；不传 `place` 仍 `home`；清空授课地址后 400 `TEACHER_ADDRESS_REQUIRED`；后台订单列表显示授课方式）；库内实测 `orders.place varchar(32) default home`、`teacher_profiles.base_address text`，存量订单全部落 `home`（分布 home 14 / teacher_place 1）；验收残留的待付款订单已用后台「关闭」清理，教员授课地址已还原为空 |
| 2026-10-24 | 上线 `e5718b1`（P66 家长到场打卡 + 双方确认）：镜像重建 → `deploy-remote.mjs` 上传 87 MB → `compose up -d --no-build`；启动时 `schema-guard` 自动补 4 列（日志：`[schema] 老库补列 orders.parent_checkin_at / _lat / _lng / _distance`） | 三容器 healthy、四入口 200、业务冒烟 **17/17**；线上接口验收 **12/12**（旧 5 端产物含「我到场了」+`geolocation`、教员端含「教学点打卡」；上门单家长打卡 400 `NOT_TEACHER_PLACE`；家长远距 400 `CHECKIN_TOO_FAR`；家长打卡后仍 `pending_class` + 视图 `bothArrived=false`；重复打卡 400；教员打卡后 `in_class` 且双方距离留痕 15m/0m；开课后打卡 400；上门单教员一次打卡即开课不回归）；验收创建的两笔订单已走完正常流程（结束授课 → 家长确认 → `completed`）避免长期挂「进行中」，教员授课地址已还原为空 |
| 2026-10-24 | 上线 `9a007e4`（P67 服务级授课形式）：镜像重建 → `deploy-remote.mjs` 上传 87 MB → `compose up -d --no-build`；启动时 `schema-guard` 自动补列 `teacher_services.places`（默认 `home`，即存量服务仍是「只上门」） | 三容器 healthy、四入口 200、业务冒烟 **17/17**；线上接口验收 **9/9**（旧 5 端教员端含两个授课形式 chip、家长预约页按服务过滤；服务列表下发 `places`+`placesText`；设为仅上门后「到教员处」下单 400 `PLACE_NOT_SUPPORTED`；设为两种后下单成功；家长侧详情同口径；仅「在教员家」时选上门被拒）；验收订单走完 finish/confirm 未留「进行中」，服务授课形式与授课地址均已还原 |
| 2026-10-24 | 上线 `93ecc3f`（P68 移动端家长 5 入口）：镜像重建 → `deploy-remote.mjs` 上传 87 MB → `compose up -d --no-build`；本次**无 schema 变更**（纯前端补入口） | 三容器 healthy、四入口 200、业务冒烟 **17/17**；线上接口验收 **16/16**（`/m/pages/parent/demands`、`/m/pages/parent/demand` 路由回落；发需求(到教员处) → 我的需求列表含 `applyCount`/`mode` → 教员报名 → 需求详情看到报名 → 确认成单 → 开票 `invoice_no` → 投诉 → SOS → 退款转 `refunding`；后台财务/退款/风控三处均能看到）；⚠️ 验收中发现「到教员处」的需求确认成单要求教员先有授课地址（`TEACHER_ADDRESS_REQUIRED`），脚本已补前置；清理：退款审核通过、投诉关闭、14 条历次验收残留风控事件全部关闭、教员授课地址还原为空（订单无 `pending_class`/`in_class` 悬挂） |
| 2026-10-24 | 上线 `79e97af`（P69 支付前端唤起）：镜像重建 → `deploy-remote.mjs` 上传 87 MB → `compose up -d --no-build`；本次**无 schema 变更**（纯前端 + 门禁/文档） | 三容器 healthy、四入口 200、业务冒烟 **17/17**；线上接口验收 **10/10**（`/m/` 入口引用支付分包 `pay.LAIbL-bP.js`，该分包含 `getBrandWCPayRequest`/`WeixinJSBridge`/`PAY_NEEDS_WECHAT`/`prepay` 且**不含** `requestPayment`；家长口令登录 → 建待支付单 → `pay` 返回**订单视图无 `mode`**（mock 通道，线上不弹收银台）→ 再次 `pay` 幂等 `paidAt` 不变）；清理：验收单（id 27）走「家长申请退款 → 管理员审核通过」转 `refunded`（退款额 20000），无 `pending_class` 悬挂 |
| 2026-10-24 | 上线 `b886b28`（P70–P74 已知清单第 3–6 项）：镜像重建 → `deploy-remote.mjs` 上传 87 MB → `compose up -d --no-build`；本次**无 schema 变更**（新增 `MetricsController`、投诉工单接口、家长领券接口与后台 21 页 UI）。同日二次上线修 `/metrics` 访问判定（Docker 端口映射下来源是 172.x 而非 127.0.0.1，改为「无 X-Forwarded-For 的内网直连」才放行，经 nginx 的外部请求仍 403） | 三容器 healthy、四入口 200、业务冒烟 **17/17**；线上接口验收 **19/19**：附近需求/后台需求池每条都带授课形式 → 后台建券(¥20/门槛¥50/发行 2) → 公开可见 → 家长领取 → 重复领 `COUPON_CLAIMED` → 用券下单 20000→18000 → Banner 带图/链接、公告带正文且公开接口可读 → 投诉工单按状态筛选(含 `openCount`) → 受理并写说明（`handle` 拒绝 `closed` 必须走 close）→ 4 个运维任务接口 200 → 外部访问 `/api/metrics` **403**；服务器侧实测 `/metrics` 内网 200（10 个指标齐全，`backup_last_success_timestamp` 读 `LAST_STATUS`）、容器内 `offsite:none`。⚠️ 发现并修：`deploy-remote.mjs` 不传 `deploy/bin/*`，`/opt/jiajiao/bin/backup-db.sh` 是旧版 → 已 `scp` + `install` 更新并实跑一次备份（21 KB / 37 表 / 14 份 DB + 6 份上传 + `offsite` 字段写入）；清理：验收券停用、Banner/公告删除、工单结案、未支付验收单以 `admin/orders/:id/close` 关闭、4 条残留 `brush` 风控事件关闭（现风控 0 / 工单 0 / 待审退款 0） |
| 2026-10-24 | 上线 `140ed30`（P75 后台可维护三份协议 + 移动端协议阅读页）：镜像重建 → `deploy-remote.mjs` 上传 87 MB → `compose up -d --no-build`；本次**无 schema 变更**（`agreements` 表早已存在，只补接口与 UI） | 三容器 healthy、四入口 200、业务冒烟 **17/17**；线上接口验收 **11/11**：后台 `GET /admin/agreements` 列出 user/privacy/refund → 改隐私政策正文后 `updated_at` 刷新 → **公开接口 `GET /public/agreements/privacy` 立刻读到新正文**（改完即生效）→ `/m/pages/agreements/index?key=privacy` 路由可直达并回落 → 正文过短 400、未知 key 404、家长角色改协议 **403** → 验收后已还原原文。⚠️ 说明：协议页是 H5 独立分包（`pages-agreements-index.*.js`），产物内容由本地 `check-mobile-spa` 断言（协议页路由回落 + 三份都能取 + 游客可读），线上脚本只验接口与路由 |
