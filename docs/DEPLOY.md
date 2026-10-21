# 部署与运维手册

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | **>= 22.5.0**（使用内置 `node:sqlite`；`22.5` 起可用，`22.14` 已验证） |
| 操作系统 | Windows 10/11、macOS、Linux 均可 |
| 端口 | 默认 `4173`，可通过 `PORT` 环境变量覆盖 |
| 依赖 | **无**（不需要 npm install，无外部数据库/中间件） |

如果机器上没有 Node，可下载官方便携包（免安装）后把 `node.exe` 所在目录加入 PATH，或用 nvm 安装。

## 2. 首次部署

```bash
# 1) 放置代码
cd /path/to/shui

# 2) 生成演示数据（可选，正式环境可跳过并从空库开始）
node server/seed.js --reset

# 3) 启动
PORT=4173 node server/index.js
```

Windows PowerShell：
```powershell
$env:PORT = 4173
node server/index.js
```

## 3. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4173` | HTTP 端口 |
| `AUTH_SECRET` | 内置开发密钥 | **生产必须修改**，用于 Token HMAC 签名 |
| `DATA_DIR` | `<项目>/data` | 数据目录（含 `app.db` 与 `uploads/`） |
| `DB_FILE` | `<DATA_DIR>/app.db` | SQLite 文件路径 |

```bash
AUTH_SECRET="换成 32 位以上随机串" PORT=8080 node server/index.js
```

## 4. 目录与数据

```
data/
  app.db          业务库（含 -wal / -shm）
  uploads/        证件与图片上传
```

### 备份（需求 7.2：核心数据每日备份）

```bash
node scripts/backup.mjs        # 默认保留最近 7 份
node scripts/backup.mjs 30     # 保留最近 30 份
```

脚本使用 `VACUUM INTO` 生成一致性快照（可在线执行，等价热备），一并复制 `data/uploads/`，
产物落在 `data/backups/<YYYYMMDD-HHMMSS>/`，并按保留份数自动清理旧备份。

定时任务示例（Linux crontab，每日 03:00）：
```
0 3 * * * cd /opt/jiajiao && /usr/bin/node scripts/backup.mjs 30 >> /var/log/jiajiao-backup.log 2>&1
```

恢复：停止服务 → 把备份目录内的 `app.db` 与 `uploads/` 覆盖回 `data/` → 启动。

也可以直接复制整个 `data/` 目录（需停机）。

## 5. 常驻运行

### Linux（systemd）
```ini
[Unit]
Description=Jiajiao Match Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/jiajiao
Environment=PORT=4173
Environment=AUTH_SECRET=请替换
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

### Windows（后台常驻）
```powershell
# 用任务计划程序注册开机自启，命令为：
node D:\shui\server\index.js
# 起始目录：D:\shui
```

### 反向代理（Nginx）
```nginx
location / {
  proxy_pass http://127.0.0.1:4173;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  client_max_body_size 10m;   # 证件上传
}
```

## 6. 定时任务

服务内置 `setInterval`（每分钟）执行 **T+N 结算批处理**：把 `status='completed'` 且 `settle_at <= now` 的订单解冻放款。

- 手动触发：管理后台「财务 → 手动触发结算」或 `POST /api/admin/settlement/run`（可带 `{force:true}` 忽略到期时间，用于试运行）；
- 业务员奖励周结：管理后台「财务 → 批量结算」或 `POST /api/admin/rewards/settle`；
- 多实例部署时，应把这两个任务改为外部调度（如 cron + 单实例执行），避免并发重复放款（`wallets` 与 `orders.status` 的原子更新可兜底）。

## 7. 健康检查与巡检

### 7.1 探活接口

```bash
curl http://127.0.0.1:4173/api/health
# 期望：{"code":0,"message":"ok","data":{"status":"ok","version":"1.0.0","uptime":123,
#        "db":{"ok":true,"users":32,"orders":17,"escrow":115000,"latencyMs":1}}}
```

数据库不可用时返回 **503**，可直接接入负载均衡探活与监控告警（建议间隔 30s）。

### 7.2 容量压测（可选）

```bash
node scripts/seed-bulk.mjs 2000 200 5000   # 家长 / 教员 / 订单
node scripts/bench.mjs                     # 同上阈值，观察大数据量下的表现
node scripts/healthcheck.mjs               # 确认大数据集账目仍自洽
node server/seed.js --reset                # 压测完还原干净演示库
```

实测数据与优化说明见 `README.md` §8。压测数据集生成约 1.3s，包含支付流水、担保台账入出账与钱包流水，
因此 `healthcheck` 的 12 项不变量在压测库上同样成立。

### 7.3 数据一致性巡检

```bash
node scripts/healthcheck.mjs     # 退出码 0=全部通过，1=存在异常
```

巡检 12 项不变量：担保台账与在途订单一致、逐单分账两条恒等式、钱包余额与流水末笔一致、冻结池与待结算订单一致、
余额非负、无孤儿关联数据、已匹配需求有确认报名与订单、报名无重复、同一订单仅 1 张有效发票、订单状态与时间字段一致、
终结订单在台账有出账、关键状态取值合法。

建议每日 04:00 巡检（Linux crontab）：
```
0 4 * * * cd /opt/jiajiao && /usr/bin/node scripts/healthcheck.mjs >> /var/log/jiajiao-check.log 2>&1
```
Windows 可用任务计划程序同上方式注册。

监控建议：
| 指标 | 获取方式 |
| --- | --- |
| 担保在账余额 | `GET /api/admin/finance` → `summary.escrow` |
| 待办积压 | `GET /api/admin/overview` → `pending` |
| 风控未闭环 | `GET /api/admin/risks` 计数 |
| 资金是否平账 | 用 `test/e2e.test.js` 第 14 节同款断言，或读 `/api/admin/finance` 的 `reconciliation` |

## 8. 验收与自检

```bash
node test/e2e.test.js        # 端到端验收：20 组、156 项断言
node test/rules.test.js      # 核心业务规则专项：9 组、51 项断言
node test/security.test.js   # 安全验收：鉴权 / 越权 / 注入 / 脱敏 / XSS / 响应头 / 登录锁定，55 项
node test/concurrency.test.js # 并发验收：100 并发抢单与幂等，22 项（会自动清理测试数据）
node scripts/bench.mjs       # 性能验收：16 项响应时间指标 vs 需求 7.1 阈值
node scripts/seed-bulk.mjs   # 可选：生成大数据集后再跑 bench，验证容量表现
node scripts/browser-check.mjs # 浏览器验收：多尺寸横向溢出 + XSS 渲染实测（需本机有 Edge/Chrome）
```

`e2e.test.js` 覆盖：认证与越权、广场与派单排序、需求发布、并发抢单、并发确认、担保支付与幂等、打卡定位拦截与风控、确认完成与冻结、T+N 结算、评价与成长分、提现与审核、代理数据隔离与脱敏、业务员推广与奖励、规则热更新、风控审核与差评仲裁、退款流程、资金恒等式、运营工具（Banner / 公告 / 优惠券）编辑与停用。

`rules.test.js` 覆盖：派单优先级公式逐项验算、分账五个金额项逐项验算与两条恒等式、后台调级后抽佣真实变化、成长分与信用分按公式变化、30 并发抢单与并发确认的原子性、区域数据隔离与越权 403、抢单超时自动失效、设备指纹反作弊拦截、代理考核指标配置驱动。

`bench.mjs` 输出每个被测接口 / 页面的 avg、P50、P95、max 与阈值对照，并给出 PASS/FAIL：

| 被测对象 | 阈值 |
| --- | --- |
| 普通接口（首页聚合、广场、看板、后台列表等） | P95 ≤ 300ms |
| 抢单相关接口（派单计算、抢单提交、20 并发压测） | P95 ≤ 500ms |
| 页面 HTML 首字节 | P95 ≤ 2000ms |

> 注意：默认基线是**本机 localhost + 演示数据集**，用于验证实现没有明显性能缺陷，
> 不等价于需求 7.1 的「1 万日活 / 5000 日订单」容量承诺；后者需在生产规格机器 + 真实数据量下另行压测。

`security.test.js` 会写入含 XSS 载荷的需求与客诉用于验证，`browser-check.mjs` 也会写一条载荷需求；
两者跑完建议执行 `node server/seed.js --reset` 还原演示库（`concurrency.test.js` 会自动清理自己造的数据）。

## 9. 需求对照

两份文档的逐条对照见 `docs/TRACEABILITY.md`（需求说明书第 1–9 章 + UI 说明书第 1–5 章，
含 8 条偏离项说明）。

## 10. 面向非技术人员的操作手册

管理后台各模块的日常操作步骤见 `docs/ADMIN-GUIDE.md`（需求 9.1 交付物：后台管理员操作说明），
包含教员审核、退款处理、提现打款、发票受理、规则调整、风控处置、差评仲裁等高频场景速查表与操作红线。

## 11. 上线前检查清单

- [ ] 修改 `AUTH_SECRET`
- [ ] 修改 `server/seed.js` 中的演示账号或从空库启动
- [ ] 移除或关闭验证码接口回传的 `devCode`（`server/modules/auth.js`）
- [ ] 配置真实微信支付商户与回调验签（`modules/orders.js` 的 `payOrder`）
- [ ] 接入腾讯/高德地图 SDK，统一坐标系（当前内置 WGS84 近似计算）
- [ ] 接入短信网关、IM 服务
- [ ] 配置 HTTPS 与反向代理、开启每日备份与每日巡检
- [ ] 接入 `/api/health` 探活与告警
- [ ] 按需求 8 章在首页显著位置展示合规提示（`rule_configs.platforms.compliance_notice` 已提供文案）