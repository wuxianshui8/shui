# ============================================================
# 家教上门撮合平台 · 运行镜像（NestJS API + 两套前端静态产物 + 旧 5 端 UI）
# 构建：docker compose -f deploy/docker-compose.yml build
# 说明：容器内不跑 MySQL/Redis，由 compose 里的 mysql / redis 服务提供。
# ============================================================
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 1) 后端依赖 + TypeScript 编译 ----------
FROM ${NODE_IMAGE} AS api
WORKDIR /app/apps/api-nest
COPY apps/api-nest/package.json apps/api-nest/tsconfig.json ./
RUN if [ -f apps/api-nest/package-lock.json ]; then \
      cp apps/api-nest/package-lock.json . && npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi
COPY apps/api-nest/ ./
RUN node node_modules/typescript/bin/tsc -p tsconfig.json && npm prune --omit=dev --no-audit --no-fund

# ---------- 2) PC 后台（Vue3 + Element Plus）----------
FROM ${NODE_IMAGE} AS web-admin
WORKDIR /app/apps/web-admin
COPY apps/web-admin/package.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY apps/web-admin/ ./
RUN npm run build

# ---------- 3) 移动端（uni-app → H5 产物）----------
FROM ${NODE_IMAGE} AS web-mobile
WORKDIR /app/apps/web-mobile
COPY apps/web-mobile/package.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY apps/web-mobile/ ./
RUN npm run build:h5

# ---------- 4) 运行镜像 ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4300
# 静态资源按 main.ts 的约定解析：cwd = apps/api-nest，
# 旧 5 端 UI 在 /app/web，PC 后台在 /app/apps/web-admin/dist，移动端 H5 在 /app/apps/web-mobile/dist/build/h5
WORKDIR /app/apps/api-nest
COPY --from=api /app/apps/api-nest/node_modules ./node_modules
COPY --from=api /app/apps/api-nest/dist ./dist
COPY --from=api /app/apps/api-nest/package.json ./package.json
COPY apps/api-nest/db ./db
# db/seed-min.mjs 需要参考实现的默认规则常量（../../../server/core/defaults.js）
# 该文件无任何依赖，单独拷入 /app/server/core 让 import 在镜像内可解析
COPY server/core/defaults.js /app/server/core/defaults.js
COPY --from=web-admin /app/apps/web-admin/dist /app/apps/web-admin/dist
COPY --from=web-mobile /app/apps/web-mobile/dist/build/h5 /app/apps/web-mobile/dist/build/h5
COPY web /app/web

# 上传目录必须由运行用户（node, uid 1000）拥有：
# 首次挂载命名卷时，Docker 会用镜像里该目录的属主初始化卷，否则卷是 root:root → 应用写入 EACCES。
# （P46 实测踩过：容器能起、图片上传全 400，日志是 permission denied）
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

USER node
EXPOSE 4300
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:4300/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
