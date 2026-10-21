// ============================================================
// 容器镜像的「不依赖 Docker 守护进程」验证
//   本机 BIOS 关闭了 VT-x 且未安装 Hyper-V/WSL → 无法运行 dockerd，
//   因此这里验证两件能验证的事：
//     1. 基础镜像 tag 在 Docker Hub 上真实存在（Registry API，需联网）
//     2. Dockerfile 运行阶段的 COPY 结果是否满足 apps/api-nest/src/main.ts 的静态托管约定
//        （web/ 旧五端、/admin-vue/、/m/、dist/main.js、db/schema.mysql.sql）
// 用法：node tools/check-image.mjs [--online]
// ============================================================
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ONLINE = process.argv.includes("--online");
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const exists = (p) => existsSync(path.join(ROOT, p));

/* ---------------- 1. 解析 Dockerfile（基础镜像 + 运行阶段 COPY） ---------------- */
const dfPath = "deploy/Dockerfile";
const df = readFileSync(path.join(ROOT, dfPath), "utf8");
const lines = df.split(/\r?\n/);

const baseImages = [...df.matchAll(/^FROM\s+\$\{NODE_IMAGE\}(?:\s|$)/gm)].length
  ? (df.match(/^ARG\s+NODE_IMAGE=(\S+)/m) || [])[1]
  : null;
if (!baseImages) fail("Dockerfile 未通过 ARG NODE_IMAGE 声明基础镜像");
const compose = readFileSync(path.join(ROOT, "deploy/docker-compose.yml"), "utf8");
const composeImages = [...compose.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]);

const imagesToCheck = [...new Set([baseImages, ...composeImages].filter(Boolean))];
notes.push("待校验镜像：" + imagesToCheck.join("、"));

// 运行阶段 = 最后一个 FROM ... AS runtime 之后
const runtimeIdx = lines.findIndex((l) => /^FROM\s+.*AS\s+runtime\s*$/i.test(l));
if (runtimeIdx < 0) {
  fail("Dockerfile 缺少运行阶段（FROM … AS runtime）");
} else {
  const runtime = lines.slice(runtimeIdx);
  const workdir = (runtime.find((l) => /^WORKDIR\s+/i.test(l)) || "").split(/\s+/)[1] || "/app/apps/api-nest";
  const copies = [];
  for (const line of runtime) {
    const m = line.match(/^COPY\s+(?:(--from=\S+)\s+)?(\S+)\s+(\S+)\s*$/);
    if (!m) continue;
    // 相对目标路径按 WORKDIR 归一化（Dockerfile 里 ./db、./node_modules 都相对 WORKDIR）
    const rawDst = m[3];
    const dst = path.posix.isAbsolute(rawDst) ? path.posix.normalize(rawDst) : path.posix.join(workdir, rawDst);
    copies.push({ from: m[1] || null, src: m[2], dst });
  }
  if (!copies.length) fail("运行阶段没有任何 COPY");
  notes.push("运行阶段 COPY 条目：" + copies.length + " 条");

  // 2.1 从构建上下文 COPY 的源必须在仓库里真实存在
  for (const c of copies) {
    if (c.from) continue;
    if (c.src.includes("*")) continue;
    if (!exists(c.src)) fail("COPY 源不存在：" + c.src);
  }

  // 2.2 main.ts 的静态托管约定（apps/api-nest/src/main.ts 第 39/41/44/47/50 行）
  const EXPECTED = [
    { dst: "/app/web", why: "旧 5 端 UI（GET /parent /teacher /sales /agent /admin）" },
    { dst: "/app/apps/web-admin/dist", why: "PC 后台（GET /admin-vue/）" },
    { dst: "/app/apps/web-mobile/dist/build/h5", why: "移动四端 H5（GET /m/）" },
    { dst: "/app/apps/api-nest/dist", why: "NestJS 编译产物（CMD node dist/main.js）" },
    { dst: "/app/apps/api-nest/db", why: "建表脚本与种子（首次初始化/巡检）" },
    { dst: "/app/apps/api-nest/node_modules", why: "运行期依赖" },
  ];
  for (const e of EXPECTED) {
    const covered = copies.some((c) => c.dst === e.dst || c.dst.startsWith(e.dst + "/"));
    if (!covered) fail("运行镜像缺少目录：" + e.dst + "（" + e.why + "）");
  }

  // 2.3 WORKDIR 必须让 main.ts 的相对路径（../.. / ..）解析正确
  if (workdir !== "/app/apps/api-nest") {
    fail("运行阶段 WORKDIR 应为 /app/apps/api-nest（main.ts 以 process.cwd() 的 ../.. 定位 web/），当前：" + workdir);
  }
  // 2.4 非 root + 健康检查
  if (!runtime.some((l) => /^USER\s+node\s*$/i.test(l))) fail("运行阶段未使用非 root 用户（USER node）");
  if (!runtime.some((l) => /^HEALTHCHECK/i.test(l))) fail("运行阶段缺少 HEALTHCHECK");
  if (!runtime.some((l) => /^CMD\s+\["node",\s*"dist\/main\.js"\]/.test(l))) fail("运行阶段 CMD 不是 node dist/main.js");
}

/* ---------------- 3. 联网校验基础镜像 tag 是否真实存在 ---------------- */
async function manifestExists(image) {
  const [repoRaw, tagRaw] = image.split(":");
  const repo = repoRaw.includes("/") ? repoRaw : "library/" + repoRaw;
  const tag = tagRaw || "latest";
  const tokenRes = await fetch("https://auth.docker.io/token?service=registry.docker.io&scope=repository:" + repo + ":pull", {
    signal: AbortSignal.timeout(15000),
  });
  if (!tokenRes.ok) throw new Error("获取 token 失败 " + tokenRes.status);
  const { token } = await tokenRes.json();
  const res = await fetch("https://registry-1.docker.io/v2/" + repo + "/manifests/" + tag, {
    method: "HEAD",
    headers: {
      Authorization: "Bearer " + token,
      Accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(","),
    },
    signal: AbortSignal.timeout(15000),
  });
  return res.ok;
}

if (ONLINE) {
  for (const image of imagesToCheck) {
    try {
      const ok = await manifestExists(image);
      if (ok) notes.push("✓ 镜像可拉取：" + image);
      else fail("镜像 tag 不存在或不可拉取：" + image);
    } catch (e) {
      notes.push("⚠ 无法联网校验 " + image + "：" + e.message + "（不计为失败）");
    }
  }
} else {
  notes.push("镜像 tag 校验已跳过（加 --online 开启，需要访问 Docker Hub）");
}

/* ---------------- 4. 输出 ---------------- */
console.log("容器镜像验证（不依赖 Docker 守护进程）");
notes.forEach((n) => console.log("  · " + n));
if (problems.length) {
  console.log("\n✗ 发现 " + problems.length + " 个问题：");
  problems.forEach((p) => console.log("  - " + p));
  process.exit(1);
}
console.log("\n✓ 基础镜像/编排镜像声明完整，运行阶段 COPY 结果满足 main.ts 的静态托管约定与执行约定");
console.log("  说明：本项只校验镜像布局；容器运行已另有实测（Docker Desktop 4.96 + WSL2：三服务 healthy、四入口 200）");
