# 安全与权限设计说明

对应《需求说明书》7.2 安全要求、9.3 安全验收、第 2 章权限边界红线。
验证脚本：`node test/security.test.js`（42 项）、`node scripts/browser-check.mjs`（XSS 渲染实测）。

---

## 1. 身份认证

| 项 | 实现 |
| --- | --- |
| 口令存储 | `scrypt` + 16 字节随机盐，格式 `scrypt$salt$hash`，比对使用 `crypto.timingSafeEqual`（防时序侧信道） |
| 令牌 | 自签 HMAC-SHA256 Token（`header.payload.signature`），载荷含 `uid / role / exp`，有效期 7 天 |
| 签名校验 | 校验前先比对长度再用 `timingSafeEqual` 校验签名，篡改任意一段即失效 |
| 登录方式 | 手机号验证码（开发环境回传 devCode）、手机号 + 口令、微信一键登录 |
| 令牌失效 | 每次请求都用 `uid` 重新查库，账号 `status=disabled` 立即返回 403；注销账号后原令牌同样立即失效 |
| 越权拦截 | 路由层声明角色白名单 `roles`，不匹配直接 403；无令牌 / 令牌非法统一 401 |

## 2. 数据范围隔离（第 2 章红线）

| 角色 | 可访问范围 | 实现位置 |
| --- | --- | --- |
| 家长 | 仅本人地址、需求、订单、评价、钱包 | 所有查询以 `ctx.user.id` 为过滤条件 |
| 教员 | 仅本人服务、订单、收入、等级；需求限「已报名的」或「符合服务半径与科目的在招需求」 | `market.js` 的需求详情判定 |
| 业务员 | 仅本人推广绑定的客户与订单 | `orders.js` 订单详情：校验 `bindings.sales_id` |
| 区域代理 | **强制**按 `agent_profiles.region_id` 过滤，跨片区一律 403 | `agent.js` 的 `myRegion(ctx)` |
| 平台管理员 | 全量数据 | `adminOnly(ctx)` |

代理端所有查询都在 SQL 层带片区条件，不做「查全量再前端过滤」；跨区访问订单、业务员、风控事件、客诉工单、规则修改、教员审核均实测返回 403。

## 3. 注入与 XSS 防护

| 威胁 | 防护 |
| --- | --- |
| SQL 注入 | 全站使用 `db.prepare(sql).run/get/all(...)` **参数化查询**，无任何字符串拼接 SQL；注入载荷测试覆盖 5 组 × 6 个入口，无 500、无 SQL 错误泄露、表结构完好 |
| 存储型 XSS | 所有动态内容经前端 `esc()` 转义后插入 DOM；服务端**不**对内容做二次 HTML 转义（避免双重编码），转义责任明确在输出层 |
| 反射型 XSS | 前端无 `innerHTML` 直接插入未转义用户输入；URL 查询参数同样走 `esc()` |
| 点击劫持 / CSRF | 不使用 Cookie 会话（Bearer Token 放在请求头），天然无 CSRF 面；建议生产再加 `X-Frame-Options: DENY` 与 CSP（见第 7 节） |

XSS 实测（`scripts/browser-check.mjs`）：把 `<img src=x onerror=...><script>...</script>` 存入需求备注与客诉标题，
用真实浏览器加载页面后检查——脚本未执行（`window.__xss` 未赋值）、DOM 中无注入的 `<img>`/`<script>` 元素、载荷以纯文本呈现。

## 4. 敏感信息脱敏

| 字段 | 家长端 | 教员端 | 业务员端 | 代理端 | 管理后台 |
| --- | --- | --- | --- | --- | --- |
| 手机号 | 本人脱敏 | 他人脱敏 | 客户脱敏 | 脱敏 | 完整 |
| 身份证号 | 不展示 | 本人脱敏 | — | — | 审核时脱敏 |
| 详细地址 | 完整 | 订单内完整 | **脱敏** | **脱敏** | 完整 |

管理后台持有全平台数据权限（需求 2.1），因此不做脱敏；除此之外一律脱敏。

## 5. 资金安全

- 金额全链路「分」整数，杜绝浮点误差；两条分账恒等式逐单校验。
- 担保资金独立台账（`escrow_ledger`），任意时刻余额 = 已支付未结算未退款订单总额，不可挪用。
- 支付、提现、退款支持 `X-Idem-Key` 幂等；并发支付实测只写 1 条流水、1 笔入账。
- 提现/退款/奖励结算/发票受理全部需管理员复核，且写入操作日志。
- 风控 `settlement_hold=1` 可冻结单笔订单的自动放款。

## 6. 反作弊与滥用防护

| 手段 | 阈值（可配置） |
| --- | --- |
| 同设备指纹 24h 注册数 | 2 → 拦截注册 + high 级风控事件 |
| 同 IP 1h 注册数 | 20 → 拦截注册 |
| 同家长 24h 下单数 | 10 → 标记刷单 + 冻结该单结算 |
| 上门打卡距离 | 500 米 → 拦截打卡 + 风控事件 |

## 7. 安全响应头与登录防护（已实现）

### 7.1 全站响应头（静态资源与 API 均下发）

| 响应头 | 值 | 作用 |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; base-uri 'self'` | 限制资源仅来自同源，禁止插件内容、禁止被第三方页面内嵌、限制表单提交目标 |
| `X-Frame-Options` | `SAMEORIGIN` | 防点击劫持（同源 iframe 保留，供自动化兼容性检查使用） |
| `X-Content-Type-Options` | `nosniff` | 禁止浏览器 MIME 嗅探 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 跨域仅发送来源 origin，避免 URL 参数泄露 |
| `Permissions-Policy` | `geolocation=(self), camera=(), microphone=()` | 仅同源可用定位，禁用摄像头/麦克风 |

### 7.2 登录失败锁定（防暴力破解）

- 维度：**IP + 账号**，阈值 `risk.login_fail_limit`（默认 5 次）、锁定 `risk.lock_minutes`（默认 15 分钟）；
- 口令登录与验证码登录**共用同一套阈值**，连续失败达阈值 → 返回 `429 LOGIN_LOCKED`，并给出解锁剩余分钟数；
- 成功登录即清零计数；阈值与时长均在规则配置中心可调，改完立即生效；
- 仅锁定命中的那对「IP + 账号」，其他账号与 IP 不受影响；
- 计数容器带 TTL 清理与 5000 条容量上限，避免被随机手机号灌爆内存（多实例请改存 Redis 共享计数）。

### 7.2.1 客户端 IP 取值（本轮加固）

直连部署只认 TCP 源地址；**仅当 `TRUST_PROXY=1`**（前面确实有反向代理）时才采信 `X-Forwarded-For` 首段。
否则攻击者可通过每次轮换伪造 XFF 绕过「登录失败锁定」与「注册同 IP 频次限制」。

### 7.2.2 短信验证码（本轮加固）

- 验证码为**一次性**：校验通过即刻失效，失败/过期同样销毁，避免日志或共享设备泄露后被重放；
- 同一手机号 60 秒内只允许发一次（`429 SMS_TOO_FREQUENT`）；
- **`devCode` 回显默认只存在于开发/演示模式**：`NODE_ENV=production` 时不返回，也可用 `DEV_SMS=0` 显式关闭；
  生产部署请同时设置 `AUTH_SECRET`（≥32 字符），否则进程拒绝启动（`src/config.ts` 强校验）。

### 7.3 接口与运维

- `GET /api/health` 为**匿名探活**，只返回运行状态、版本、运行时长、DB/Redis 可用性与耗时（数据库不可用时 503），可用于负载均衡探活；
  用户数、订单数、担保资金总额等业务指标迁至 `GET /api/health/detail`（`@Roles("admin")`，匿名 401），异常信息只写服务端日志、不回显给调用方；
- `node scripts/healthcheck.mjs` 巡检 12 项数据不变量（担保台账、逐单分账、钱包流水、冻结池、孤儿数据、状态字段、发票唯一性等），退出码非 0 表示存在异常，可挂入每日定时任务。

---

## 8. 已知边界与生产加固建议

1. **HTTPS**：当前为明文 HTTP，生产必须置于 HTTPS 反向代理之后（令牌为 Bearer，明文传输会被截获）。
2. **令牌撤销**：Token 为无状态自签，注销/禁用依赖每请求查库校验 `status`；如需即时全量吊销，可加 Redis 黑名单。
3. **验证码**：开发环境回传 `devCode` 便于演示，生产必须移除并接入短信网关。
4. **口令策略**：当前仅校验长度 ≥ 6 位，生产建议增加复杂度要求（大小写+数字+符号）。
5. **网关层限流**：应用内已做注册频次与登录失败锁定，建议在网关再叠加每 IP 每秒请求数限制，抵御流量型攻击。
6. **数据留存**：账号注销做匿名化而非物理删除，订单与资金流水按合规审计要求保留。
7. **依赖审计**：系统零第三方依赖（仅 Node 内置模块），无 npm 供应链风险；如后续引入依赖请固定版本并定期审计。
8. **账号开通与改密**：后台开通代理 / 片区开通业务员改为**一次性随机强口令**（12 位，含大小写+数字+符号），
   响应里只回给操作者一次、站内消息不含明文；账号置 `must_change_password=1`，改密前除 `change-password/me/logout/deactivate` 外一律 403。
   种子演示账号仍统一 `a123456`（仅本地演示），生产请一并改为随机下发。
9. **（已修复）`/api/health` 指标分级**：匿名只返回可用性；用户数/订单数/担保资金总额迁至 `/api/health/detail`（仅管理员）。
10. **订单视图的财务字段**：家长可见本单的 `commissionRate/serviceFee/agentShare/platformRevenue`（需求要求抽佣透明），
    代理/业务员侧视图对地址、手机号与**经纬度（2 位小数）**脱敏；若需进一步收紧，可在 `orders.service.ts::view()` 按角色裁剪字段。
11. **多实例一致性**：验证码/登录失败计数与规则内存缓存均为单实例实现（规则内存缓存已加 300s TTL 与 Redis 对齐）；
    多实例部署请统一改存 Redis，并把 `TRUST_PROXY=1` 与可信代理层一起配置。
12. **（已修复）令牌即时吊销**：`users` 表新增 `token_version`，改密/注销自增；令牌携带 `v` 声明，
    网关每次请求比对版本号，改密后旧令牌立即 401（改密响应同时返回新令牌，避免当前会话被踢）。
    `check-privacy-auth` 覆盖「旧令牌失效 / 新令牌可用」4 条断言。

---

## 9. 云服务器主机加固（已实施，2026-10-23）

可重复执行的脚本：`bash deploy/harden-server.sh`（`--check` 只体检不改动）。
下表是**在测试服务器（Ubuntu 22.04 / 腾讯云）实际应用并验证过**的项。

| # | 措施 | 配置位置 | 为什么做 |
| --- | --- | --- | --- |
| 1 | **SSH 仅公钥**（`PasswordAuthentication no`）+ **禁 root 登录**（`PermitRootLogin no`）+ `MaxAuthTries 3` / `LoginGraceTime 20` + 关 X11/Agent/TCP 转发 + `AllowUsers ubuntu` | `/etc/ssh/sshd_config.d/99-hardening.conf`（改前备份到 `/root/sshd-backup-*`，`sshd -t` 通过才 reload） | 该机 24 小时内实测收到 **1000+ 次** SSH 爆破尝试，且原配置 `PasswordAuthentication yes` + `PermitRootLogin yes` |
| 2 | **fail2ban**（sshd jail，`mode = aggressive`，3 次失败封 4 小时） | `/etc/fail2ban/jail.local` | 密码认证关掉后攻击者在 pubkey 阶段被打断，默认过滤器抓不到，aggressive 模式把这些尝试也计入并封 IP |
| 3 | **ufw 防火墙**：默认拒绝入站，仅放 22/80/443；先把 `DEFAULT_FORWARD_POLICY` 改成 `ACCEPT` | `/etc/default/ufw` + `ufw` | 开防火墙前必须调 FORWARD，否则会打断 Docker 的容器网络 |
| 4 | **自动安全更新**（仅 security 通道，不自动重启） | `/etc/apt/apt.conf.d/{20auto-upgrades,51unattended-upgrades-hardening}` | 内核/OpenSSL 这类漏洞不能靠人工记得升级 |
| 5 | **内核网络参数**：`tcp_syncookies`、拒绝 ICMP 重定向与源路由、`log_martians`、`fs.protected_{hardlinks,symlinks}`、`kernel.sysrq=0`（**不动 `rp_filter`**，避免影响 Docker 转发） | `/etc/sysctl.d/99-hardening.conf` | 削掉常见的主机层攻击面 |
| 6 | **Docker 守护**：`live-restore`（重启守护进程不杀容器）+ `no-new-privileges`（新容器禁提权）+ 日志轮转 20m×3 | `/etc/docker/daemon.json` | 避免守护重启造成业务中断；限制日志撑爆磁盘 |
| 7 | **Nginx**：`server_tokens off`（不暴露版本）+ 认证接口按来源 IP 限速 `30r/m`、突发 10，超限 429 | `/etc/nginx/conf.d/00-hardening.conf` + 站点 conf 的 `location ~ ^/api/auth/(login|login-password|login-account|send-code|wechat)` | 挡撞库与短信轰炸；应用内已有登录锁定，这层在边缘再收一道 |

**实测验证（2026-10-23）**

- 密钥登录正常（`ssh kd211` → `KEY_OK`），密码方式被拒：`Permission denied (publickey)`，root 登录被拒
- 防火墙启用后容器仍 healthy、业务冒烟 **17/17** 通过、四入口 200；外网 3306/6379/4300 **均 closed**
- 认证限速实测：连续 20 次登录请求 → 前 5 次正常（burst），第 6 次起 **429**
- 响应头 `Server: nginx`（版本号已隐藏）
- 容器内身份 `uid=1000(node)`（非 root），三容器 `privileged=false`；`ubuntu` 用户**不在 docker 组**（只能经 sudo 用 docker）
- 脚本幂等：重复执行两次，容器 uptime 不中断、站点仍 200

### 9.1 二次加固（2026-10-26，P78）

第一轮加固后仍留了三类缺口：① 主 `sshd_config` 写着 `PermitRootLogin yes` / `PasswordAuthentication yes`，
只是被 drop-in 覆盖（一旦有人删掉 drop-in 就直接退回不安全状态）；② 爆破只封 2h，屡犯者每两小时就能重试；
③ **没有"变化检测"**——真被改了关键文件（新增账号、改 sudoers、塞 cron）没人会知道。

| # | 措施 | 配置位置 | 为什么 |
| --- | --- | --- | --- |
| 1 | **主 sshd_config 对齐**为 `PermitRootLogin no` / `PasswordAuthentication no`；drop-in 增加 `AuthenticationMethods publickey`（只认公钥）、`MaxStartups 10:30:60`（限制并发未认证连接，抗爆破占资源）、`LogLevel VERBOSE`（记录密钥指纹） | `/etc/ssh/sshd_config` + `99-hardening.conf` | 消除"两处矛盾"，让安全状态不依赖 drop-in 是否还在 |
| 2 | **fail2ban 收紧**：`bantime 24h` / `findtime 1h` / `maxretry 3`；新增 `recidive` jail（一周内再犯 3 次封一周）；`bantime.increment`（屡犯递增，最长 4 周） | `/etc/fail2ban/jail.local` | 原配置 2h/4h 太松，扫描器换窗口就能回来 |
| 3 | **内核信息/提权面**：`kptr_restrict=2`、`dmesg_restrict=1`、`yama.ptrace_scope=1`、`perf_event_paranoid=3`、`fs.suid_dumpable=0`、拒绝 ICMP 重定向/源路由、`log_martians` | `/etc/sysctl.d/99-security-extra.conf` | 限制内核地址泄露与本地调试/追踪类提权手法；**刻意不动 `rp_filter` 与 `unprivileged_bpf_disabled`**（前者断 Docker 转发，后者 22.04 默认已是 2） |
| 4 | **auditd 关键审计**（19 条规则）：`/etc/{passwd,shadow,group,gshadow}`、`sudoers*`、`sshd_config`、`~/.ssh/`、`crontab`/`cron.d`/`cron.daily`、`systemd/system`、`rc.local`、`init_module/finit_module`、`clock_settime`、`/etc/hosts` | `/etc/audit/rules.d/99-jiajiao.rules`（`augenrules --load` 生效） | 事后能回答"谁在什么时候改了提权配置"；实测 append 与 `sed -i` 换 inode 都能留痕 |
| 5 | **关键文件完整性基线 + 每日校验**：52 个关键文件的 `sha256 + 权限 + 属主` 存基线，每日 04:20（+开机 10 分钟）比对；差异写 `LAST_CHECK`（JSON）并留 `last-diff.txt`，同时尝试走 webhook 告警 | `deploy/security-integrity.sh` + `jiajiao-security-integrity.{service,timer}` | 这是**唯一能主动发现"被改过"的机制**——auditd 有日志但要人看，这个会把差异摆到 `LAST_CHECK` |
| 6 | 关掉云主机无用的本地设备服务（`ModemManager` / `upower` / `udisks2`） | systemd | 少一个进程少一份攻击面（`packagekit` 由 dbus 按需唤醒，保持原样） |

**实测验证（2026-10-26，线上机）**

- `sshd -T`：`authenticationmethods publickey`、`passwordauthentication no`、`permitrootlogin no`、`maxstartups 10:30:60`；改动后**当前 SSH 会话未断**，新连接正常
- `fail2ban-client status`：`Jail list: recidive, sshd`；sshd jail 当前封 3 个 IP
- `sysctl`：五项内核参数均为目标值
- `auditd`：active，规则 19 条；`audit.log` 已记录 1000+ 条事件，`/etc/hosts` 的 append 与 `sed -i` 均留下 `PATH name="/etc/hosts"` 记录
- **完整性校验实测**：往 `/etc/hosts` 加一行 → `--check` 输出 `⚠️ 完整性变化 1 处：/etc/hosts`、`LAST_CHECK` 变 `{"status":"changed",...,"files":["/etc/hosts"]}`、`last-diff.txt` 含新旧 sha256 → 还原后复检 `status":"ok"`、退出码 0
- 业务未受影响：`api health 200`、站点 200、三容器 healthy

**回滚方式**

| 改动 | 回滚 |
| --- | --- |
| sshd | `cp -a /root/sshd_config.bak-<日期> /etc/ssh/sshd_config` + `sshd -t` + `systemctl reload ssh` |
| fail2ban | `cp -a /root/jail.local.bak-<日期> /etc/fail2ban/jail.local` + `systemctl restart fail2ban` |
| 内核参数 | 删 `/etc/sysctl.d/99-security-extra.conf` + `sysctl --system` |
| 审计 | `rm /etc/audit/rules.d/99-jiajiao.rules` + `augenrules --load` |
| 完整性校验 | `systemctl disable --now jiajiao-security-integrity.timer`（脚本与基线可留） |
| `lighthouse` 账号 | `usermod -s /bin/bash lighthouse` 恢复 shell；sudo 需手工加回 |

> 以上全部固化在 `deploy/harden-server.sh`（第 1b / 2 / 8–11 步）与 `tools/deploy-remote.mjs`
> （部署时自动同步 `security-integrity.sh` 与 systemd unit），换机或有新服务器时重跑即复现。

### 10.5 取证级复查（2026-10-26 第二轮，结论：仍无中毒）

用户再次要求确认后做的一轮更深检查，比 §10.1 多了「二进制完整性 / 专业扫描器 / 进程内存视图 / 后门位点专查」。

| 检查面 | 方法 | 结果 |
| --- | --- | --- |
| **系统二进制是否被替换** | `debsums -c` 全量校验所有已安装 deb 的文件哈希 | **仅 3 条例外**，全在 `/usr/local/qcloud/python/…/cloudinit/`（腾讯云定制 cloud-init 的 `DataSourceTencentCloud.py` 等，厂商补丁，非 deb 管理属正常）；`coreutils`/`procps`/`iproute2`/`bash`/`systemd`/`sudo`/`openssh` 等**零 MISMATCH** |
| **专业 rootkit 扫描** | `chkrootkit`（全盘）+ `rkhunter --check --rwo`（属性库 137 文件） | **chkrootkit 44 项 `not infected`、`chkproc: nothing detected`、`chkdirs: nothing detected`、wtmp/utmp/lastlog 「nothing deleted」；rkhunter 零告警、退出码 0** |
| **进程内存视图** | 扫 `/proc/*/exe` 是否指向 `(deleted)`；`/proc/*/environ` 的 `LD_PRELOAD`；`/proc/*/maps` 里 `/tmp`、`/dev/shm`、`(deleted)` 映射 | 无进程跑在已删除二进制上；无 `/tmp`、`/dev/shm` 的可疑 so 映射；`/etc/ld.so.preload` 不存在 |
| 内核模块 | `lsmod` 105 个 + 按 `hide/root/kit/reptile/diamorphine` 等筛查 | 全是标准 Ubuntu/虚拟化/容器网络模块，无匹配 |
| SUID/SGID 全量 | `find / -perm -4000/-2000`（35 个）逐个数 dpkg 归属 | 未归属 dpkg 的均属两类正常情况：① usrmerge 后 `/usr/bin/mount` 等实际由 `mount: /bin/mount` 提供；② `/var/lib/containerd/…/snapshots/*/fs/usr/bin/*` 是**容器镜像层内**的 SUID（mysql/redis 镜像自带） |
| PAM 后门 | 扫 `/etc/pam.d` 的 `pam_exec`/`pam_python`/`pam_tty_audit`/`/tmp` 路径 | 无；模块全为标准集 |
| SSH 后门位点 | `/etc/ssh/sshrc`、`sshd -T` 的 `ForceCommand`/`AuthorizedKeysCommand`/`PermitUserEnvironment`、`authorized_keys` 的 `command=`/`from=` | 全部无/为 none；`authorized_keys` 仅纯公钥 |
| 持久化位点 | 非 dpkg 归属的 systemd unit、`/var/spool/cron/crontabs`、`atq`、`~/.ssh/rc`、xdg autostart | unit 全是 dpkg alias/腾讯云 agent/我们自己的备份与完整性 timer；crontab 只有腾讯云 stargate；`atq` 0 条 |
| 容器内部 | `docker top` 排除预期进程、容器内 `/tmp` 与 uploads、可执行文件 | 三容器只有预期进程；app 容器 `/tmp` 空、uploads 仅 1 张 PNG |
| nginx 配置 | 全量 grep `proxy_pass`/`root`/`alias`/`fastcgi`/`cgi_pass`/`rewrite` | 除本机 `127.0.0.1:4300` 外无外部反代、无 CGI、无可疑 rewrite；未加载额外模块 |
| 应用日志 | `docker logs` 24h 内 error/exception/injection/路径穿越 | 只有业务日志与 mock 短信；无异常 |
| 原始网络视图 | 直接读 `/proc/net/tcp`（绕过 `ss` 被替换的可能） | 监听仍只有 22/80/443 + `127.0.0.1:4300/34851/53` |

**唯一的「可疑发现」与其澄清**：某进程环境里有 `LD_PRELOAD=/lib64/libsgmon.so`，
对应 PID 是 `/bin/sh -c sleep 100`（云镜探针）。该 `.so` 不属于任何 deb 包，但 `strings` 里全是
`l.yd.qcloud.com`、`u.yd.qcloud.com`、`metadata.tencentyun.com`、`/usr/local/qcloud/YunJing/`、`/etc/cron.d/yunjing`
——**腾讯云云镜（主机安全）注入的监控库**，与 `YDService`/`YDEyes` 同源，非后门。

**这轮顺带处理的两件事**

- 之前 `apt-get install rkhunter` 因 `sudo` 重置环境、`postfix` 的 debconf 交互提示卡住，导致 postfix 半装包
  → 已 `dpkg --remove --force-remove-reinstreq postfix` 并 `dpkg --configure -a`，`dpkg --audit` 归零
  （**这一步很重要**：半装包会让 `unattended-upgrades` 自动安全更新整条链路失败）。
- 装上 `chkrootkit` 与 `rkhunter`（`--no-install-recommends`，不拉 postfix）供后续定期复查。

**结论的边界（诚实说明）**

- 能确定：**没有已知 rootkit、没有隐藏进程/目录、系统二进制未被替换、无持久化后门、无异常外联、无 webshell、容器干净**。
- 不能 100% 确定：**纯内存型的无文件攻击（无落盘、无持久化）**需要 EDR 或内存取证才能排除；本机没有部署 EDR，
  但这类攻击在重启后即消失，且本次已确认无任何持久化位点与异常进程，实际风险极低。
- 若仍不放心，可做的下一步是**冷启动一次**（`reboot`）：重启后内存痕迹全部清空，再跑一次
  `security-integrity.sh --check` 与 `rkhunter --check` 即为干净的基线状态。

**顺带发现的两个配置弱点（不是中毒，但建议修）**

1. **Redis 未设 `requirepass`**：`bind` 是容器网络，宿主未映射 6379（外网不可达），但 app 容器被拿下后可直连无密码 Redis 做写文件/主从复制利用。
2. **MySQL 存在 `root@%`**：官方镜像默认建 `root@'%'`，容器内网可用 root 密码直连；建议改成 `root@localhost` + 单独业务账号。
3. （环境配置）线上 `.env` 保留 `SMS_MOCK_LOG_CODE=1`，mock 短信会把验证码打进容器日志；生产接真实短信通道后应改回 `0`。

**仍需你做/注意的**

1. **只在腾讯云控制台保留必要的安全组规则**（22/80/443），主机层 ufw 已是一道，云安全组是更外一道。
2. 我给你的运维公钥在 `ubuntu` 的 `authorized_keys` 里；不再需要时删掉那一行即可（删前先确认自己有别的入口，并留一个 VNC 退路）。
3. **备份**：`npm run db:backup` 已可用，但服务器上还没排进定时任务（B3 缺口），建议挂 `cron`/`systemd timer`。
4. 生产前把演示口令 `a123456` 全部换掉（后台建号走一次性强口令，首登强制改密）。
5. 若将来多实例/加 CDN，`TRUST_PROXY` 与 `X-Forwarded-For` 可信链要一起复核（见 §8 第 11 条）。

## 10. 入侵排查记录（2026-10-26，结论：未发现入侵）

怀疑服务器被入侵时的完整排查清单与结论。每一项都在线上机（kd211 / 腾讯云 2C3.6G / Ubuntu 22.04）实跑过。

### 10.1 检查项与结果

| 检查面 | 命令要点 | 结果 |
| --- | --- | --- |
| 负载/算力异常 | `uptime`、`ps -eo pcpu,args --sort=-pcpu` | 负载 **0.08 / 0.04 / 0.07**（2 核），无高 CPU 进程；`check-new-release` 瞬时 27% 属系统定时任务 |
| 挖矿特征 | `grep -iE "xmrig\|kdevtmpfsi\|kinsing\|minerd\|stratum\|cpuminer"`；`find /tmp /dev/shm -name "*xmr*"` | 进程、文件、矿池外联**均为 0** |
| 监听端口 | `ss -tulpn` | 仅 **22/80/443** 对外；`4300` 只绑 `127.0.0.1` |
| 出站连接 | `ss -tnp state established` | 仅腾讯云内网元数据（`169.254.0.138` / `169.254.0.55`，`tat_agent` / `YDService`）+ 我的 SSH 会话，**无陌生外联** |
| 持久化 | 全用户 `crontab -l`、`/etc/cron.d`、`systemctl list-timers` | 只有腾讯云 `stargate`/`yunjing` + 我们自己的 `jiajiao-backup.timer` + `certbot`，**无可疑定时任务** |
| 启动项 | `find /etc/systemd/system -newermt`、`/etc/init.d`、`/etc/ld.so.preload` | 仅 cloud-init/腾讯云 agent/我们的备份 unit；`ld.so.preload` **不存在**（rootkit 常用位点干净） |
| 账号 | `awk -F: '$3==0'`、`passwd` 变更时间、`sudoers.d`、`authorized_keys` | UID 0 仅 `root`；`authorized_keys` 只有部署公钥；`/etc/passwd` 最近变更 = 10-23 装 Docker（`dnsmasq` 用户 + `docker` 组，auth.log 有记录） |
| 登录审计 | `last -a`、`grep "Accepted" /var/log/auth.log` | 成功登录**全部**是 `ubuntu` + **publickey** 从我的出口 IP 与控制台 `orcaterm`，无密码登录成功 |
| 暴力破解 | `grep "Failed password" \| awk '{from}' \| sort \| uniq -c` | 有攻击（单 IP 最高 470 次），**全部失败**；fail2ban 累计封 39 个 IP，当前封 3 个 |
| Web 入口 | nginx access.log 的 `.php` / `eval-stdin` / `.env` 探测、`uploads`、`/opt/jiajiao` 脚本 | **430 个 404 + 132 个 301**，无 200 命中；系统**未安装 PHP**（`dpkg -l php*` 为空），`.php` 探测客观上无法执行；`uploads` 只有 1 张 PNG |
| 容器 | `docker ps -a`、`docker images` | 只有我们的 3 容器 / 3 镜像，无陌生镜像与特权容器 |
| SSH 生效配置 | `sshd -T` | `passwordauthentication no` / `permitrootlogin no` / `maxauthtries 3` |
| 主机安全 agent | 云镜日志 `grep -iE "trojan\|malware\|webshell\|mining"` | **无木马/入侵告警**；唯一 `WRN Malware open_fail: /tmp/runc-process*` 是扫描 Docker runc 临时进程的正常噪声 |

### 10.2 排查中澄清的两个「疑似」

1. **`/tmp/nvenc_ai_sdk_install.sh` + `/tmp/gpudirect_rdma_setup.sh`** —— 名字像 GPU 挖矿木马，实际是
   **腾讯云官方镜像自带的 GPU 实例初始化脚本**：从 `metadata.tencentyun.com` 取机型，只有 `gn7vi` /
   `HCCPNV4H` 等 RDMA/GPU 规格才装 `tscsdk-center`；本机是 CPU 机型 → 脚本 `exitlog` 直接退出，无进程、无外联。
   mtime 是镜像构建时间（2023-06-27 / 2026-08-13）而非本次开机（10-22），可排除「运行期投放」。已删除。
2. **`/tmp/2af7c071b686bc94776078e2ebe35b8a`**（root 700 哈希目录）—— 空目录，创建于开机后 1 分钟，
   与 `cvm_init` 同批，属云初始化临时目录。

### 10.3 已做的处置（加固；没有恶意对象可「杀」）

| 处置 | 命令 | 回滚方式 |
| --- | --- | --- |
| 移除云镜像默认账号 `lighthouse` 的 `NOPASSWD: ALL` | 删 `/etc/sudoers` 中该行 + `visudo -c` 校验 | `cp -a /etc/sudoers.bak-2026-10-26 /etc/sudoers` |
| 锁定 `lighthouse` 登录 shell（账号保留） | `usermod -s /usr/sbin/nologin lighthouse` | `usermod -s /bin/bash lighthouse` |
| 清掉镜像残留的 GPU 初始化脚本 | `rm -f /tmp/nvenc_ai_sdk_install.sh /tmp/gpudirect_rdma_setup.sh` | 无需回滚（CPU 机型永远用不到） |
| 固化为可复现加固 | `deploy/harden-server.sh` 新增「1b) 云镜像自带账号收窄」 | — |

处置后复检：`sudo -l -U lighthouse` → **not allowed to run sudo**；`passwd -S lighthouse` → `L`（锁定）；
`api health 200`、站点 200、三容器 healthy、SSH 仍仅公钥可登。

### 10.4 遗留建议（非紧急）

1. 主 `sshd_config` 仍写 `PermitRootLogin yes` / `PasswordAuthentication yes`，被 `99-hardening.conf` 覆盖为 `no`
   ——**生效值安全**，但两处矛盾易误判；建议改为 `no`（需 `sshd -t` + reload）。
2. 若确认永不使用 `lighthouse`，可 `userdel -r lighthouse`（**未执行**，保留作云控制台 VNC 兜底）。
3. 可选装 `rkhunter` / `debsums` 做二进制完整性校验（当前未装，排查靠人工清单 + 云镜 agent）。
4. 若收到腾讯云「主机安全」告警，请把**告警条目截图/时间**给我按项复核——本次云镜日志里没有任何木马/入侵告警。
5. 主 `sshd_config` 的 `PermitRootLogin yes` / `PasswordAuthentication yes` **已在 P78 修正为 `no`**（见 §9.1），
   drop-in 仍是唯一"强制公钥"的落点，但主文件不再写反。