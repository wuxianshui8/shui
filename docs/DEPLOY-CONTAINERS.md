# 容器化部署（Docker Compose）

> 交付说明：本仓库提供 **MySQL 8 + Redis 7 + 应用镜像** 的 compose 编排与构建文件。
> **本机没有 Docker 守护进程**（`HypervisorPresent=False`，WSL2 不可用，Docker Desktop 无法启动），
> 因此下面这些文件只做过**静态一致性校验**（`npm run deploy:check`，含严格 YAML 解析），
> 容器运行时行为**未在本机实测**。首次在具备 Docker 的机器上执行时，请按第 5 节自检。

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

```bash
docker compose ps                              # 三服务 healthy
curl -fsS http://localhost:4300/api/health     # {"code":0,...,"status":"ok"}
docker compose logs app | tail -40             # 无 "生产环境必须配置 AUTH_SECRET"
docker compose run --rm seed && curl -fsS -X POST http://localhost:4300/api/auth/login-password \
  -H 'Content-Type: application/json' -d '{"phone":"13900000001","password":"a123456"}'   # code=0
npm run nest:health:mysql                      # 12 项一致性巡检（在容器库上跑）
BASE_URL=http://localhost:4300 node tools/check-privacy-auth.mjs   # 隐私与账号安全 38 项
```

## 6. 已知限制（如实记录）

| # | 限制 | 说明 |
| --- | --- | --- |
| 1 | 容器运行时未实测 | 本机无 Docker 守护进程；仅做了静态校验（`npm run deploy:check`） |
| 2 | 镜像体积偏大 | 三份前端依赖各自 `npm install`；如需优化可改为 pnpm workspace 或预构建产物挂载 |
| 3 | 未包含微信小程序构建 | compose 只产出 H5；小程序需本地 `npm run web:mobile:build:mp` 后用微信开发者工具上传 |
| 4 | 无内置 HTTPS / 证书管理 | 需外部反向代理或云 LB |
| 5 | 单实例 | 验证码/失败计数与规则内存缓存为单实例实现；水平扩容前需按 `docs/SECURITY.md` §8 第 11 条迁移到 Redis |
