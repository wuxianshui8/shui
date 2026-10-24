# 交接说明（HANDOVER）

> 一页读完：这套系统怎么跑、跑到什么程度、哪些是真验证过的、哪些还是环境限制。
> 详细内容分散在各专题文档（见文末索引），本文只做「接手就能用」的最短路径。

## 1. 这是什么

滴滴式「家教上门撮合」平台，严格按两份文档实现：
《家教上门撮合平台项目开发需求说明书 V1.0》+《家教上门撮合平台 UI 界面设计说明书 V1.0》。

覆盖 **5 个角色端**：家长端、教员端、业务员端、区域代理端（移动 9:16）、平台管理后台（PC）。

仓库内并存两套实现：

| 目录 | 角色 | 技术 |
| --- | --- | --- |
| `server/` + `web/` | **参考实现**（最先交付、四套断言 383 项：e2e 255 / rules 51 / security 55 / concurrency 22） | Node 22 原生 http + SQLite + 零构建 ESM 前端 |
| `apps/api-nest/` + `apps/web-admin/` + `apps/web-mobile/` | **正式实现**（按需求书 6.1 选型） | NestJS + MySQL 8 + Redis + Vue3/Element Plus + uni-app |

## 2. 三种启动方式（任选其一）

### A. 容器（推荐，一条命令，环境隔离）

```powershell
# 前置：Docker Desktop 已安装并启动（本机已配 registry-mirrors 绕过 Docker Hub 封锁）
cd D:\shui\deploy
.\up.bat                       # 带护栏：没 docker / 没 .env / .env 仍是模板占位密钥 都会拦住并提示
```

- 首次构建约 16 分钟（三次 npm install），之后重建约 **18 秒**（`.dockerignore` 已裁剪上下文）
- 起来后：`/admin-vue/`、`/m/`、`/parent`、`/api/health`
- 想要更彻底的功能验收：`npm run verify:docker`（起服 + 灌种子 + **9 套件 282 断言**）

### B. 便携依赖（不装 Docker，双击即用）

```
双击项目根目录的 start.bat
```
自动起便携 MySQL(3307) + Redis(6380)、建库、灌演示数据、编译后端，然后常驻前台（Ctrl+C 停止）。
首次依赖下载见 `docs/MIGRATION.md §1.5`。

### C. 只跑参考实现

```
npm start                      # → http://localhost:4173
```

## 3. 演示账号（口令统一 `a123456`）

| 角色 | 手机号 | 说明 |
| --- | --- | --- |
| 平台管理员 | 13900000001 | 后台全权限 |
| 区域代理（西湖） | 13900000010 | 片区数据隔离 |
| 区域代理（滨江） | 13900000011 | 分成比例不同 |
| 业务员 | 13900000101/102 | 含日/周冠军奖 |
| 教员（Lv5 名师） | 13900000201 | 成长分 2350，抽佣 6% |
| 教员（Lv1 见习） | 13900000204 | 成长分 160，抽佣 18% |
| 家长（L3 高信用） | 13900000304 | 评价权重 1.6 |
| 家长（L0 新用户） | 13900000301 | 信用分 100 |
| 待审核教员 | 13900000212 | 用于演示后台资质审核 |

> 后台「新建代理 / 开通业务员 / 新建管理员」生成的是一次性强口令，首登强制改密（不再用统一口令）。

## 4. 验证到什么程度（全部实测，非声明）

| 层面 | 命令 | 结果 |
| --- | --- | --- |
| 参考实现 7 套件 | `npm test` / `test:rules` / `test:security` / `test:concurrency` / `bench` / `check:browser` / `healthcheck` | **383 断言**全绿（e2e 255 + rules 51 + security 55 + concurrency 22；其余三套为脚本级检查） |
| 正式实现全量门禁 | `npm run ci:full` | **30 步**（静态 16 + 业务 14），约 5 分钟 |
| 静态门禁 | `npm run ci` | **16 步**，约 40 秒（含单元测试 172 用例 + 依赖审计 + 电子围栏 72 项 + 门禁自检 10 用例） |
| 单元测试与覆盖率 | `npm run test:unit` | **172 用例**，23 个模块行覆盖 ≥ 99%（门禁阈值 90%） |
| 依赖漏洞审计 | `npm run audit:check` | 预算制 3 个 workspace：api-nest high 3（multer / body-parser / platform-express 同一条修复链，无上传中间件实际引用 → 不可达）/ web-admin 0 / web-mobile high 21（构建链，只阻断 critical） |
| 托管 Runner | push 到 `main` 自动跑 | **6 次全绿**（static 13s / integration 206~210s，484 断言/次） |
| 容器栈功能验收 | `npm run verify:docker` | **9 套件 282 断言** |
| 容器栈性能基线 | `docs/PERF.md §6` | 读接口 p95 ≤ 73.5ms、错误 0；抢单并发 成功 1 / 被拒 49 |
| 备份/恢复回环 | `npm run db:backup` / `db:restore` | 删表后恢复：orders 3、users 12、表 37，巡检 12/12；保留策略 `--keep 2` 剪枝实测正确 |
| 渠道对账 | `npm run pay:recon -- --self-test` / `--bill <csv>` | 自检 4 类差异全命中；真机账单一致→0 差异，改金额+删行→2 类差异退出码 1 |
| 混沌演练 | `npm run chaos:drill` | **21 项全绿**：MySQL 挂→health 503 且业务读 400；Redis 挂→业务读仍 200；两者恢复后 200 且可登录，app 无重启 |
| 接口/需求/UI 追溯 | `api:doc:check` / `trace:check` / `ui:check` | **143/160 路由**、需求逐条、后台 20 页 + 移动 14 页 |
| 全新克隆自包含 | `git clone` → `npm install` → `ci --static` | 全绿（clone 时 12 步；加入单元测试与依赖审计后 **14/14** 本机复跑通过） |

**迁移门禁 `gate-p9` 报「Incorrect integer value / Column cannot be null」时**：几乎都是本地参考实现的库被写脏了。
`data/app.db` 在多次 gate 串跑或中断后可能出现整行错位（例如 `audit_logs` 里出现 `orders` 的列值），
迁移写入 MySQL 严格模式就会报类型错误。修法是删掉本地库让它按 `server/core/schema.sql` 重建：

```powershell
Remove-Item data\app.db* -Force
node tools\gate-p9.mjs
```

`data/` 已在 `.gitignore`，脏库不会进仓库；该现象与代码无关（`git stash` 后同样复现）。
排障时可用 `MIGRATE_BATCH=1` 让迁移逐行写入，报错会精确到行号。

官方校验器：`actionlint 1.7.12` + `shellcheck 0.11.0`（零告警）、`compose-spec` JSON Schema（固定 commit 随仓库提交）。

## 5. 已知限制（如实记录，不是待办）

1. **Docker Hub 直连被阻断** — 已用 `registry-mirrors`（`docker.1ms.run` / `docker.m.daocloud.io`）绕过并实测生效；换到可直连网络后可在 `~/.docker/daemon.json` 删掉。
2. **`e2e` / `rules` 不在容器内跑** — 二者依赖 `send-code` 回显 `devCode`，而镜像内 `NODE_ENV=production` 永久关闭该回显（安全设计）。由 CI 主机栈覆盖。
3. **compose 里 MySQL 用 root + 空口令** — 仅为开箱验证；生产必须改（见 `docs/DEPLOY-CONTAINERS.md §3`）。
4. **单实例** — 验证码/失败计数与规则缓存为单实例实现；水平扩容前需按 `docs/SECURITY.md §8` 迁移到 Redis。

## 6. 改动后要跑什么（最小习惯）

```powershell
npm run ci               # 14 秒：改接口/文档/脚本都该先过这个
npm run api:doc          # 动了控制器 → 重新生成接口总表（否则 api:doc:check 会红）
npm run ci:full          # 动了业务逻辑/资金/权限 → 必须跑
npm run verify:docker    # 动了 Dockerfile / compose / seed → 必须跑
npm run db:backup        # 数据有变化 → 备份一份（产物在 backups/，已 gitignore）
```

**门禁的设计原则**：文档与代码同等对待——接口清单、需求追溯、UI 追溯、部署配置、镜像布局、工作流、Markdown 写法、Windows 脚本、门禁自检，全部有机器校验；门禁自检本身还会验证「门禁在非法输入下真的会失败」。

## 7. 文档索引

| 想了解 | 看这个 |
| --- | --- |
| 全貌、启动、演示账号 | `README.md`（本文的上位） |
| 接口清单（自动生成，142 路由） | `docs/API-NEST.md`；参考实现见 `docs/API.md` |
| 数据模型（37 表） | `docs/DATABASE.md` |
| 15 组业务规则与公式 | `docs/RULES.md` |
| 需求逐条追溯 / 偏离说明 | `docs/TRACEABILITY-NEST.md`（正式实现）、`docs/TRACEABILITY.md`（参考实现） |
| UI 说明书 ↔ 页面映射 | `docs/TRACEABILITY-UI-NEST.md` |
| 迁移全过程与每阶段门禁 | `docs/MIGRATION.md`（P1–P28） |
| 安全设计与加固项 | `docs/SECURITY.md` |
| 性能基线与优化记录 | `docs/PERF.md` |
| 部署（容器 / 传统） | `docs/DEPLOY-CONTAINERS.md`、`docs/DEPLOY.md` |
| 后台操作手册 | `docs/ADMIN-GUIDE.md` |
| **上线还缺什么**（外部集成/运维/质量分类待办） | `docs/GO-LIVE-CHECKLIST.md` |
