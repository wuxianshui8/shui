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

### 3.6 备份数据库

```bash
# 方式 A（服务器上、不依赖仓库）：容器内 mysqldump
ssh kd211 "mkdir -p /var/backups/jiajiao && sudo -n docker exec jiajiao-mysql-1 sh -c 'mysqldump -uroot -p\"\$MYSQL_ROOT_PASSWORD\" --single-transaction --databases jiajiao' | gzip > /var/backups/jiajiao/jiajiao-\$(date +%Y%m%d-%H%M%S).sql.gz"

# 方式 B（有仓库时）：MYSQL_MODE=docker OUT_DIR=/var/backups/jiajiao node tools/db-backup.mjs --keep 14
```

> ⚠️ 目前**尚未**把备份排进定时任务（B3 缺口）。要恢复：`gunzip < 备份.sql.gz | docker exec -i jiajiao-mysql-1 mysql -uroot -p<口令>`。

---

## 4. 变更流程与红线

**流程**：先看状态 → 改（本地仓库用编辑器改代码；服务器配置用脚本写文件）→ 语法校验 → 生效 → 双层验证（本机 + 公网）→ 沉淀成 `deploy/*.sh` 并提交 → 告知回滚办法。

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
| fail2ban | `sudo systemctl stop fail2ban`（临时）；或删 `/etc/fail2ban/jail.local` 后重启 | `/etc/fail2ban/jail.local` |
| 内核参数 | 删 `/etc/sysctl.d/99-hardening.conf` 后 `sudo sysctl --system` | 原值未动（新增文件） |
| Docker 守护 | 删 `daemon.json` 里 `live-restore`/`no-new-privileges` 后 `sudo systemctl restart docker` | `/etc/docker/daemon.json` |
| 主机加固整体 | `deploy/harden-server.sh` 幂等，可重跑到一致状态 | 脚本本身即「期望状态」 |
| 数据 | `gunzip < xx.sql.gz \| docker exec -i jiajiao-mysql-1 mysql -uroot -p<口令>` | `/var/backups/jiajiao/` |

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

1. **备份定时任务**：每日 `mysqldump` + 保留 14 份 + 异地/对象存储归档（B3 缺口）。
2. **监控告警**：Prometheus/Grafana + 告警规则（错误率/延迟/担保台账不平/任务卡死）。
3. **日志集中化**：Loki/ELK + `trace_id` 串联（当前只有 `docker logs` 与 Nginx 文件）。
4. **域名备案**：备案通过后 `node tools/switch-domain.mjs` 切回 `https://www.kd211.com`。
5. **演示口令替换**：生产前把 `a123456` 全部换掉（后台建号已是一次性强口令 + 首登强制改密）。

---

## 8. 变更记录（追加）

| 日期 | 变更 | 结果 |
| --- | --- | --- |
| 2026-10-23 | 首次部署（镜像上传 + compose + seed + Nginx + Let's Encrypt） | 三容器 healthy、四入口 200、冒烟 17/17 |
| 2026-10-23 | 发现域名未备案被拦截（302 → webblock、HTTPS 重置） | 增加按 IP 的 80 `default_server` 测试入口 |
| 2026-10-23 | 主机加固（SSH 仅公钥/禁 root、ufw、fail2ban、自动更新、sysctl、Docker、Nginx 限速） | 密码与 root 登录被拒；限速第 6 次起 429；业务冒烟 17/17 无回归 |
| 2026-10-23 | 新增 `SMS_MOCK_LOG_CODE`（测试环境从日志取验证码） | 日志取码 → 验证码登录成功；接口仍不回显 `devCode` |
