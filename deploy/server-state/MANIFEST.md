# 服务器配置现状（自动生成，勿手改）

- 抓取时间：2026-10-23T16:01:43.277Z
- 来源主机：`kd211`
- 生成工具：`node tools/pull-server-state.mjs`（`npm run sync:server-state`）
- 用途：把「直接在服务器上改过的配置」回写进仓库，便于 diff / 回滚 / 审计
- **不包含** `deploy/.env` 等任何密钥文件

| 服务器路径 | 仓库内文件 | sha256(16) |
| --- | --- | --- |
| `/etc/nginx/sites-available/jiajiao.conf` | `nginx/jiajiao.conf` | `c22b5ddddbc76670` |
| `/etc/nginx/conf.d/00-hardening.conf` | `nginx/00-hardening.conf` | `c318ba06ed786eef` |
| `/etc/ssh/sshd_config.d/99-hardening.conf` | `ssh/99-hardening.conf` | `b6f6bb1c11d9bb33` |
| `/etc/fail2ban/jail.local` | `fail2ban/jail.local` | `1845e40aaa5130f0` |
| `/etc/sysctl.d/99-hardening.conf` | `sysctl/99-hardening.conf` | `53e2dd8d1ee033cb` |
| `/etc/docker/daemon.json` | `docker/daemon.json` | `140853826a6e0994` |
| `/etc/systemd/system/jiajiao-backup.service` | `systemd/jiajiao-backup.service` | `580cfadbcb8952b9` |
| `/etc/systemd/system/jiajiao-backup.timer` | `systemd/jiajiao-backup.timer` | `7417db0173ba7573` |
| `/etc/systemd/system/jiajiao-backup-notify.service` | `systemd/jiajiao-backup-notify.service` | `1c03f7ef7d5cb51c` |
| `/opt/jiajiao/bin/backup-db.sh` | `bin/backup-db.sh` | `c44492d05a6232b7` |
| `/opt/jiajiao/bin/backup-notify.sh` | `bin/backup-notify.sh` | `2712bf9296d9ecfb` |
| `/opt/jiajiao/deploy/docker-compose.prod.yml` | `compose/docker-compose.prod.yml` | `0fb19549adbd4df2` |

改了服务器上的配置后：跑一次 `npm run sync:server-state` → `git diff` 看变化 → 提交。
