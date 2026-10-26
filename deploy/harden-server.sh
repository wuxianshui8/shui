#!/usr/bin/env bash
# ============================================================
# 云服务器主机加固（Ubuntu 22.04，可重复执行 = 幂等）
#
#   bash deploy/harden-server.sh              # 全量应用
#   bash deploy/harden-server.sh --check      # 只体检，不改任何东西
#
# 做的事（每项都对应真实攻击面）：
#   1. SSH：只留公钥认证、禁 root 登录、限尝试次数与握手时间、关 X11/Agent 转发
#      —— 实测该机器 24h 内收到 1000+ 次 SSH 爆破尝试
#   2. fail2ban：sshd jail（aggressive 模式），挡扫描器 + 降噪
#   3. ufw：默认拒绝入站，只放 22/80/443；先把 FORWARD 改成 ACCEPT 以免打断 Docker
#   4. unattended-upgrades：自动装安全更新（不自动重启）
#   5. 内核网络参数：synccookies / 拒绝重定向与源路由 / martian 日志 / 受保护硬链
#   6. Docker 守护：live-restore + no-new-privileges + 日志轮转
#   7. Nginx：隐藏版本号 + 认证接口按 IP 限速（挡撞库与短信轰炸）
#
# ⚠️ 前置：**必须先确认公钥登录可用**（脚本会自检），否则关掉密码认证会把自己关在门外。
#    云厂商控制台 VNC 是最后退路；sshd 配置改动前会备份到 /root/sshd-backup-<时间戳>。
# ============================================================
set -euo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
say() { printf '\n=== %s ===\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
bad() { printf '  ✗ %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 或 sudo 执行"; exit 1
fi

say "0) 体检：当前状态"
sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|maxauthtries|x11forwarding|allowusers)' | sed 's/^/  /'
echo "  --- 对外监听（0.0.0.0 才是暴露）---"
ss -ltn | awk 'NR==1 || /0\.0\.0\.0|\[::\]/' | sed 's/^/  /'
echo "  --- 防火墙 ---"
ufw status | head -3 | sed 's/^/  /'
echo "  --- fail2ban ---"
systemctl is-active fail2ban 2>/dev/null | sed 's/^/  /' || echo "  未安装"

# 公钥可用性自检：有 key 才能关密码
if ! ls /home/*/.ssh/authorized_keys /root/.ssh/authorized_keys >/dev/null 2>&1; then
  bad "找不到任何 authorized_keys —— 先配好公钥登录再关密码认证"
  exit 1
fi
ok "检测到 authorized_keys（$(ls /home/*/.ssh/authorized_keys /root/.ssh/authorized_keys 2>/dev/null | tr '\n' ' '))"

if [ "$CHECK" -eq 1 ]; then
  say "--check 模式：只体检不改动"; exit 0
fi

say "1) SSH 加固"
BK="/root/sshd-backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK"
cp -a /etc/ssh/sshd_config "$BK/" ; cp -a /etc/ssh/sshd_config.d "$BK/" 2>/dev/null || true
DROPIN=/etc/ssh/sshd_config.d/99-hardening.conf
cat > "$DROPIN" <<'CONF'
# SSH 加固（deploy/harden-server.sh 写入；改完必须 sshd -t 再 reload）
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
MaxAuthTries 3
MaxSessions 5
LoginGraceTime 20
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
UseDNS no
# 允许的运维账号：按需改成自己的用户名（多个用空格分隔）
AllowUsers ubuntu
CONF
chmod 600 "$DROPIN"
if ! sshd -t; then
  bad "sshd 配置校验失败，撤销 drop-in"
  rm -f "$DROPIN"
  exit 1
fi
systemctl reload ssh 2>/dev/null || systemctl reload sshd
ok "SSH 已收紧（备份：$BK）"

# 云镜像自带账号收尾（2026-10-26 入侵排查发现）：
#   腾讯云轻量镜像会预置 `lighthouse` 账号并给 `NOPASSWD: ALL`，即使密码锁定、无 key 也属多余攻击面。
#   这里移除其 sudo 并锁 shell（账号保留，需要时 `usermod -s /bin/bash lighthouse` 可恢复）。
say "1b) 云镜像自带账号（lighthouse）收窄"
if id lighthouse >/dev/null 2>&1; then
  cp -a /etc/sudoers /etc/sudoers.bak-$(date +%F) 2>/dev/null || true
  sed -i '/^lighthouse[[:space:]]\+ALL=(ALL)[[:space:]]\+NOPASSWD:[[:space:]]*ALL$/d' /etc/sudoers
  if visudo -c >/dev/null 2>&1; then
    usermod -s /usr/sbin/nologin lighthouse 2>/dev/null || true
    ok "lighthouse：已移除 NOPASSWD sudo，shell 锁为 nologin"
  else
    bad "sudoers 语法校验失败，恢复备份"
    cp -a /etc/sudoers.bak-$(date +%F) /etc/sudoers
  fi
else
  ok "无 lighthouse 账号（非腾讯云轻量镜像）"
fi
# 镜像残留：非 GPU 机型上的 GPU 初始化脚本会自己退出，留着只是噪音
rm -f /tmp/nvenc_ai_sdk_install.sh /tmp/gpudirect_rdma_setup.sh 2>/dev/null || true

say "2) fail2ban"
export DEBIAN_FRONTEND=noninteractive
command -v fail2ban-client >/dev/null 2>&1 || apt-get install -y fail2ban >/dev/null 2>&1 </dev/null
cat > /etc/fail2ban/jail.local <<'CONF'
[DEFAULT]
backend  = auto
bantime  = 24h
findtime = 1h
maxretry = 3
ignoreip = 127.0.0.1/8 ::1
# 递增封禁：屡犯者封得更久（最长 4 周），而不是每 24h 重新给机会
bantime.increment = true
bantime.maxtime   = 4w

[sshd]
enabled  = true
mode     = aggressive
port     = 22
logpath  = /var/log/auth.log
maxretry = 3
bantime  = 24h

# 反复被 sshd jail 封住的 IP（一周内再犯 3 次）直接封一周
[recidive]
enabled  = true
logpath  = /var/log/fail2ban.log
findtime = 1w
bantime  = 1w
maxretry = 3
CONF
systemctl enable --now fail2ban >/dev/null 2>&1
fail2ban-client -t >/dev/null 2>&1 || bad "fail2ban 配置校验失败"
systemctl restart fail2ban >/dev/null 2>&1 || true
sleep 1
ok "fail2ban 运行中（$(fail2ban-client status 2>/dev/null | grep 'Jail list' | sed 's/.*Jail list:[[:space:]]*//')）"

say "3) 防火墙 ufw"
sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null 2>&1
ufw status | sed 's/^/  /'

say "4) 自动安全更新"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/51unattended-upgrades-hardening <<'CONF'
Unattended-Upgrade::Allowed-Origins { "${distro_id}:${distro_codename}-security"; };
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
CONF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "已启用（security 通道，不自动重启）"

say "5) 内核网络参数"
cat > /etc/sysctl.d/99-hardening.conf <<'CONF'
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.conf.all.log_martians = 1
kernel.sysrq = 0
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
CONF
sysctl -p /etc/sysctl.d/99-hardening.conf >/dev/null
ok "已应用（未改 rp_filter，避免影响 Docker 转发）"

say "6) Docker 守护"
if [ -f /etc/docker/daemon.json ]; then
  python3 - <<'PY'
import json
p = "/etc/docker/daemon.json"
d = json.load(open(p))
d.setdefault("log-driver", "json-file")
d.setdefault("log-opts", {"max-size": "20m", "max-file": "3"})
d["live-restore"] = True
d["no-new-privileges"] = True
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY
  systemctl reload docker 2>/dev/null || systemctl restart docker
  sleep 3
  docker ps --format '  {{.Names}}  {{.Status}}' || true
  ok "live-restore + no-new-privileges 已写入"
else
  ok "未装 Docker，跳过"
fi

say "7) Nginx（隐藏版本号 + 认证接口限速）"
if command -v nginx >/dev/null 2>&1; then
  cat > /etc/nginx/conf.d/00-hardening.conf <<'CONF'
server_tokens off;
limit_req_zone $binary_remote_addr zone=authlimit:10m rate=30r/m;
limit_req_status 429;
CONF
  CONF_FILE=/etc/nginx/sites-available/jiajiao.conf
  if [ -f "$CONF_FILE" ] && ! grep -q authlimit "$CONF_FILE"; then
    python3 - <<'PY'
import re
p = "/etc/nginx/sites-available/jiajiao.conf"
block = """
    # 认证类接口限速（挡撞库 / 短信轰炸）：30r/m，突发 10
    location ~ ^/api/auth/(login|login-password|login-account|send-code|wechat) {
        limit_req zone=authlimit burst=10 nodelay;
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
"""
src = open(p).read()
parts = re.split(r'(?m)^server \{', src)
out = []
for i, part in enumerate(parts):
    if i > 0 and "proxy_pass http://127.0.0.1:4300;" in part:
        part = part.replace("    location / {", block + "\n    location / {", 1)
    out.append(part)
open(p, "w").write("server {".join(out))
PY
  fi
  nginx -t && systemctl reload nginx
  ok "Nginx 已加固"
else
  ok "未装 Nginx，跳过"
fi

say "8) 内核安全参数（信息泄露 / 本地提权面）"
cat > /etc/sysctl.d/99-security-extra.conf <<'CONF'
# P78 加固（2026-10-26）：限制内核信息泄露与本地提权面
# 特意不动 net.ipv4.conf.*.rp_filter 与 unprivileged_bpf_disabled：前者会打断 Docker 转发，
# 后者 Ubuntu 22.04 默认已是 2，再改回 1 反而放宽。
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.yama.ptrace_scope = 1
kernel.perf_event_paranoid = 3
fs.suid_dumpable = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.conf.all.log_martians = 1
CONF
sysctl --system >/dev/null 2>&1
ok "内核参数已应用（kptr_restrict=$(sysctl -n kernel.kptr_restrict) dmesg_restrict=$(sysctl -n kernel.dmesg_restrict) ptrace_scope=$(sysctl -n kernel.yama.ptrace_scope)）"

say "9) 关掉云主机上无用的本地设备服务"
for s in ModemManager upower udisks2 packagekit; do
  if systemctl is-enabled "$s" >/dev/null 2>&1; then
    systemctl disable --now "$s" >/dev/null 2>&1 && ok "已停用 $s" || bad "停用 $s 失败"
  else
    ok "$s 本就不启用"
  fi
done

say "10) auditd 关键文件审计"
if ! command -v auditctl >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 && apt-get install -y auditd >/dev/null 2>&1 </dev/null || true
fi
if command -v auditctl >/dev/null 2>&1; then
  cat > /etc/audit/rules.d/99-jiajiao.rules <<'RULES'
## P78 安全加固：关键文件与提权路径审计（2026-10-26）
-D
-b 8192
--backlog_wait_time 60000
-f 1

# 账号与口令
-w /etc/passwd -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/gshadow -p wa -k identity
# 提权配置
-w /etc/sudoers -p wa -k privilege
-w /etc/sudoers.d/ -p wa -k privilege
# SSH 与登录凭据
-w /etc/ssh/sshd_config -p wa -k sshd
-w /root/.ssh/ -p wa -k authkeys
-w /home/ubuntu/.ssh/ -p wa -k authkeys
# 持久化
-w /etc/crontab -p wa -k cron
-w /etc/cron.d/ -p wa -k cron
-w /etc/cron.daily/ -p wa -k cron
-w /etc/systemd/system/ -p wa -k systemd
-w /etc/rc.local -p wa -k boot
# 内核模块加载
-a always,exit -F arch=b64 -S init_module -S finit_module -k module
# 时间/主机名篡改常见后门手法
-a always,exit -F arch=b64 -S clock_settime -k time
-w /etc/hosts -p wa -k hosts
-w /etc/hostname -p wa -k hosts
RULES
  sed -i 's/^max_log_file .*/max_log_file = 20/; s/^num_logs .*/num_logs = 5/; s/^max_log_file_action .*/max_log_file_action = ROTATE/' /etc/audit/auditd.conf 2>/dev/null || true
  systemctl enable auditd >/dev/null 2>&1 || true
  systemctl restart auditd >/dev/null 2>&1 || true
  sleep 1
  # auditd 只读 rules.d 里经 augenrules 合成的 audit.rules，必须显式 load 一次
  augenrules --load >/dev/null 2>&1 || true
  ok "auditd 运行中（规则 $(auditctl -l 2>/dev/null | wc -l) 条，含账号/提权/SSH/定时任务/内核模块）"
else
  bad "auditd 不可用（apt 源不可达？），跳过审计规则"
fi

say "11) 关键文件完整性基线 + 每日校验"
if [ -x /opt/jiajiao/bin/security-integrity.sh ]; then
  install -m 644 "$(dirname "$0")/systemd/jiajiao-security-integrity.service" /etc/systemd/system/ 2>/dev/null || true
  install -m 644 "$(dirname "$0")/systemd/jiajiao-security-integrity.timer" /etc/systemd/system/ 2>/dev/null || true
  systemctl daemon-reload
  if [ -f /var/lib/jiajiao-security/baseline.sha256 ]; then
    ok "已有基线（$(wc -l < /var/lib/jiajiao-security/baseline.sha256) 条），不覆盖"
  else
    /opt/jiajiao/bin/security-integrity.sh --init >/dev/null 2>&1 && ok "已生成基线（$(wc -l < /var/lib/jiajiao-security/baseline.sha256 2>/dev/null) 条）"
  fi
  systemctl enable --now jiajiao-security-integrity.timer >/dev/null 2>&1 || true
  ok "每日 04:20 校验已排程（结果写 /var/lib/jiajiao-security/LAST_CHECK）"
else
  bad "未找到 /opt/jiajiao/bin/security-integrity.sh（先跑 deploy-remote.mjs 部署）"
fi

say "完成：复查要点"
echo "  · 新开一个终端用公钥登录，确认能进（再关掉当前会话）"
echo "  · 密码登录已被拒绝：ssh -o PreferredAuthentications=password <user>@<host> → Permission denied (publickey)"
echo "  · 业务入口：http://<IP>/ ；MySQL/Redis/4300 不应对外开放"
