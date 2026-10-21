# 容器化部署（Docker Compose）

> 交付说明：本仓库提供 **MySQL 8 + Redis 7 + 应用镜像** 的 compose 编排与构建文件。
> **本机连容器运行时都不具备**：`docker` 不在 PATH、无 Docker Desktop，且 BIOS 关闭 VT-x
> （`VirtualizationFirmwareEnabled=False`）、Hyper-V / VirtualMachinePlatform / WSL / Containers 组件全 `Disabled`
> —— dockerd 起不来。因此下面这些文件只做过**静态与契约级校验**（`deploy:check`、`deploy:schema`、`image:check`、
> `image:runtime` 生产模式真起服 31 项），**容器本身未在本机启动过**。首次在具备 Docker 的机器上执行时，请按第 5 节自检。

## 1. 文件

| 文件 | 作用 |
| --- | --- |
| `deploy/Dockerfile` | 多阶段构建：① 后端 `npm install` + `tsc` + `prune --omit=dev`；② PC 后台 `vite build`；③ 移动端 `uni build`（H5）；④ 运行镜像（非 root `USER node`，`HEALTHCHECK` 打 `/api/health`） |
| `deploy/docker-compose.yml` | `mysql`（首启自动执行 37 表建表脚本）/ `redis` / `app`（依赖两者 `service_healthy`）/ `seed`（一次性演示数据，`profiles: ["seed"]`） |
| `deploy/.env.example` | 必填 `AUTH_SECRET`、`TRUST_PROXY`、`JOBS_ENABLED` |

镜像内部路径与 `apps/api-nest/src/main.ts` 的静态托管约定一一对应（`WORKDIR=/app/apps/api-nest`）：

```
/app/web                          → 旧 5 端 UI（/parent /teacher /sales /agent /admin）
/app/apps/web-admin/dist          → PC 后台（/admin-vue/）
/app/apps/web-mobile/dist/build/h5→ 移动四端（/m/）
/app/apps/api-nest/dist           → NestJS 编译产物（node dist/main.js）
```

## 2. 首次部署

```bash
cd deploy
cp .env.example .env
# 生成强随机密钥并填入 .env（必须 >= 32 字符，否则应用拒绝启动）
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

docker compose up -d --build          # 首次会构建镜像（三份 npm install，约 5–10 分钟）
docker compose run --rm seed          # 灌演示数据（12 用户 / 4 教员 / 3 业务员 / 2 代理 / 演示订单）
docker compose ps                     # 三个服务应为 healthy
```

**一键脚本（推荐 Windows）**：`deploy\up.bat` —— 自带护栏（未装 docker 时提示先开 VT-x / 装 Docker Desktop；
`.env` 不存在时自动从模板生成并提示填 `AUTH_SECRET`），随后依次执行 `up -d --build` → `run --rm seed` → `ps`。
实测：本机（无 docker）运行该脚本会在第 1 道护栏退出（退出码 1），不产生任何副作用文件。

> **Windows 用户注意**：`&&` 是 bash / PowerShell 7+（`pwsh`）的语法，**Windows PowerShell 5.1 会直接抛解析错误**
> （`标记"&&"不是此版本中的有效语句分隔符` / `InvalidEndOfLine`），命令根本不会执行；另外 `curl` 在 5.1 里是
> `Invoke-WebRequest` 的别名，带 `-fsS` 也会报参数错误。逐行执行即可，等价命令：

```powershell
cd D:\shui\deploy
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # 输出填入 .env 的 AUTH_SECRET
docker compose up -d --build
docker compose run --rm seed
docker compose ps
```

访问：

| 入口 | 地址 |
| --- | --- |
| PC 管理后台 | http://localhost:4300/admin-vue/ |
| 移动四端（H5） | http://localhost:4300/m/ |
| 旧 5 端 UI | http://localhost:4300/parent |
| 健康检查 | http://localhost:4300/api/health（匿名仅可用性；指标见 `/api/health/detail`，需管理员） |

演示账号口令均为 `a123456`（**仅演示**；生产请用后台「新建代理 / 开通业务员」生成一次性口令，首登强制改密）。

## 3. 生产要点

1. **必填 `AUTH_SECRET`**：compose 使用 `${AUTH_SECRET:?…}` 语法，未设置时 compose 直接报错退出；应用侧在 `NODE_ENV=production` 下同样拒绝以默认密钥启动。
2. **`DEV_SMS=0`**：生产不回显短信验证码（本地演示才需要）。
3. **`TRUST_PROXY=1`**：仅当确实前置了 Nginx / 云负载均衡时开启，否则登录锁定与注册频次限制可被伪造 `X-Forwarded-For` 绕过。
4. **数据库凭据**：compose 里为便于开箱验证使用 `root` + 空口令，**生产必须改**（`MYSQL_PASSWORD` + 相应应用环境变量），并把 3307/6380 端口映射去掉，只暴露应用端口。
5. **TLS**：应用只监听 HTTP，生产必须置于 HTTPS 反向代理之后（令牌为 Bearer）。
6. **迁移已有数据**：容器首次启动只建表；如要把 SQLite 参考实现的数据导入，在宿主机执行 `npm run nest:migrate`（读取 `data/app.db`，写入目标 MySQL）。

## 4. 反向代理示例（可选）

```nginx
server {
  listen 443 ssl http2;
  server_name example.com;
  # ssl_certificate ... ;
  client_max_body_size 10m;

  location / {
    proxy_pass http://127.0.0.1:4300;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # 需配合 TRUST_PROXY=1
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## 5. 部署自检清单（在具备 Docker 的机器上执行）

两种写法都给出：上面是 bash / zsh / PowerShell 7+（`pwsh`）；下面是 **Windows PowerShell 5.1** 的等价命令（逐行执行）。

```bash
# ── bash / zsh / PowerShell 7+ ──
docker compose ps                              # 三服务 healthy
curl -fsS http://localhost:4300/api/health     # {"code":0,...,"data":{"status":"ok",...}}
docker compose logs app | tail -40             # 无 "生产环境必须配置 AUTH_SECRET"
docker compose run --rm seed
curl -fsS -X POST http://localhost:4300/api/auth/login-password \
  -H 'Content-Type: application/json' -d '{"phone":"13900000001","password":"a123456"}'   # code=0
BASE_URL=http://localhost:4300 node tools/check-privacy-auth.mjs   # 隐私与账号安全 38 项
npm run nest:health:mysql                      # 12 项一致性巡检（在容器库上跑）
```

```powershell
# ── Windows PowerShell 5.1（本机默认 shell）──
#   注意：5.1 不支持 && 链式（那是 bash / pwsh 7+ 的语法），curl 是 Invoke-WebRequest 别名，
#   带 -fsS 会报参数错误 —— 这里统一写 curl.exe，且逐行执行。
docker compose ps
curl.exe -fsS http://localhost:4300/api/health
docker compose logs app --tail 40
docker compose run --rm seed
curl.exe -fsS -X POST http://localhost:4300/api/auth/login-password `
  -H "Content-Type: application/json" -d '{"phone":"13900000001","password":"a123456"}'
$env:BASE_URL = "http://localhost:4300"
node tools\check-privacy-auth.mjs               # 隐私与账号安全 38 项
npm run nest:health:mysql                       # 12 项一致性巡检
```

## 6. 已知限制（如实记录）

| # | 限制 | 说明 |
| --- | --- | --- |
| 1 | **容器运行时未实测** | 本机 `VirtualizationFirmwareEnabled=False`（BIOS 关闭 VT-x）+ Hyper-V/WSL/Containers 组件全 `Disabled`、`HvHost` Stopped → dockerd 起不来（已提权确认）。已用不依赖守护进程的方式验证：`npm run deploy:check`（compose/Dockerfile/workflow 一致性）、`npm run deploy:schema`（官方 compose-spec Schema）、`npm run image:check`（运行阶段 COPY 布局 vs `main.ts` 约定）、`npm run image:runtime`（**生产模式真起服 31 项**：HEALTHCHECK 原始命令、三个静态站点、验证码不回显、缺密钥拒绝启动）；镜像 tag 联网校验仍被网络阻断 |
| 2 | 基础镜像 tag 联网校验被阻断 | `auth.docker.io` / `registry-1.docker.io` 在本机超时；在有外网的机器上执行 `node tools/check-image.mjs --online` 会逐个校验 `node:22-bookworm-slim` / `mysql:8.0` / `redis:7-alpine` 是否可拉取 |
| 3 | 官方 actionlint：**已解决**；compose 官方二进制：**未取到** | 官方 `actionlint v1.7.12 + shellcheck 0.11.0` 已装入 `tools/bin/`（`download.docker.com`、`github.com` 可达），`npm run workflow:check` 会自动优先调用官方 actionlint，实测**无告警**。`docker compose` 官方二进制（33MB）在本机 ~14KB/s 带宽下多次续传残缺 → 改用**官方 compose-spec JSON Schema** 校验：`npm run deploy:schema`（schema 固定 commit `de28432` 随仓库提交于 `deploy/compose-spec.schema.json`，结构 + 本项目约定双向校验，负向验证退出码 1） |
| 4 | 镜像体积偏大 | 三份前端依赖各自 `npm install`；如需优化可改为 pnpm workspace 或预构建产物挂载 |
| 5 | 未包含微信小程序构建 | compose 只产出 H5；小程序需本地 `npm run web:mobile:build:mp` 后用微信开发者工具上传 |
| 6 | 无内置 HTTPS / 证书管理 | 需外部反向代理或云 LB |
| 7 | 单实例 | 验证码/失败计数与规则内存缓存为单实例实现；水平扩容前需按 `docs/SECURITY.md` §8 第 11 条迁移到 Redis |

## 7. 交付前已执行的验证（本机实跑）

```bash
npm run deploy:check     # compose/Dockerfile/workflow 的路径、端口、脚本、安全开关一致（严格 YAML 解析）
npm run deploy:schema    # 官方 compose-spec Schema 校验（需 YAML_LIB/AJV_LIB 注入依赖，见脚本头部注释）
npm run image:check      # 运行阶段 COPY 结果覆盖 main.ts 需要的 6 个目录 + WORKDIR/USER/HEALTHCHECK/CMD
npm run image:runtime    # Dockerfile 运行阶段 + 生产模式真起服（NODE_ENV=production）+ HEALTHCHECK 原始命令 → 31 项
npm run workflow:check   # 官方 actionlint + shellcheck（已装于 tools/bin/；未装则退回离线规则）
npm run workflow:proof   # 每条 run 命令 ↔ 本机已通过的门禁（23 需证据 + 6 Runner 专属）
npm run ci:full          # 全量 21 步门禁（静态 9 + verify/e2e/security/rules/并发/资金/隐私/权限/两套前端/镜像运行契约/迁移巡检）
```

`deploy/` 与 `.github/` 的**内容**已被上述前六项覆盖（`workflow:check` 由官方 actionlint 主导，`deploy:schema` 由官方 compose-spec Schema 主导，`image:runtime` 把运行阶段在生产模式下真起服跑一遍）；剩下真正未做的只有「在有 Docker 的机器上 `docker compose up -d --build`」与「推送后 Actions 首跑」。
