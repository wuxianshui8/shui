// ============================================================
// compose 官方 Schema 校验（deploy/docker-compose.yml ↔ compose-spec）
//
//   背景：本机没有 Docker 守护进程（BIOS 关闭 VT-x），`docker compose config`
//   无法执行，故用 compose 官方 JSON Schema 做等价结构校验：
//     来源：https://github.com/compose-spec/compose-spec
//     固定提交：de28432802a367d650bd4ad6748b19491b6cf986
//     本地副本：deploy/compose-spec.schema.json（随仓库提交，离线可用）
//   ⚠️ 覆盖「配置结构是否合法」，不覆盖「容器能否真正起来」。
//
//   依赖（根目录保持零第三方依赖，按需注入）：
//     YAML_LIB=<yaml 路径或包名>   AJV_LIB=<ajv 路径或包名（draft 2020-12）>
//   缺依赖时【默认失败】（否则门禁等于不存在）；确需降级时显式加 --allow-skip。
//
// 用法：
//   node tools/check-compose-schema.mjs               # 严格：缺依赖即失败
//   node tools/check-compose-schema.mjs --allow-skip  # 降级：缺依赖时打印跳过并退出 0
//   COMPOSE_FILE / SCHEMA_FILE 可覆盖文件路径（负向验证用）
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOW_SKIP = process.argv.includes("--allow-skip");
const MAX_SHOW = 12;

/** 相对路径按仓库根解析，避免受 cwd 影响 */
function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}
const COMPOSE = process.env.COMPOSE_FILE
  ? resolveFromRoot(process.env.COMPOSE_FILE)
  : path.join(ROOT, "deploy", "docker-compose.yml");
const SCHEMA = process.env.SCHEMA_FILE
  ? resolveFromRoot(process.env.SCHEMA_FILE)
  : path.join(ROOT, "deploy", "compose-spec.schema.json");

/** 环境变量值是已存在的路径就转 file:// URL，否则当包名/子路径交给解析器 */
function spec(target) {
  if (!target) return null;
  const asPath = path.isAbsolute(target) ? target : path.join(ROOT, target);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return pathToFileURL(asPath).href;
  return target;
}

/** 按候选顺序探测依赖；支持「包名 / 子路径 / 文件路径」三种写法 */
async function load(envKey, pkg, what, preferred = []) {
  const custom = process.env[envKey];
  const listed = [
    ...preferred.map((p) => ({ c: spec(p), how: p })),
    ...(custom ? [{ c: spec(custom), how: `${envKey}=${custom}` }] : []),
    { c: pkg, how: pkg },
  ].filter((x) => x.c);
  const fails = [];
  for (const { c, how } of listed) {
    try {
      return { mod: await import(c), how };
    } catch (e) {
      fails.push(`${c}: ${e.message.split("\n")[0]}`);
    }
  }
  if (ALLOW_SKIP) {
    console.log(`⚠️ 跳过：缺少${what}（${pkg}），本次未做官方 Schema 校验`);
    for (const f of fails) console.log("   " + f);
    console.log(`   开启方式：设置 ${envKey}=<该依赖的路径或包名>`);
    process.exit(0);
  }
  console.error(`✗ 缺少${what}（${pkg}）：官方 Schema 校验无法执行`);
  for (const f of fails) console.error("   " + f);
  console.error(`   装依赖后设置 ${envKey} 指向它；若确实要跳过，请显式加 --allow-skip`);
  process.exit(1);
}

if (!fs.existsSync(COMPOSE)) {
  console.error(`✗ 找不到 compose 文件：${COMPOSE}`);
  process.exit(1);
}
if (!fs.existsSync(SCHEMA)) {
  console.error(`✗ 找不到官方 schema 副本：${SCHEMA}`);
  process.exit(1);
}

const yamlMod = await load("YAML_LIB", "yaml", " YAML 解析库");
// compose-spec 是 draft 2020-12；ajv 核心（dist/ajv.js）不含该方言。
// 只在「派生出的 2020.js 真实存在」时才把它当候选，否则会把路径写错导致方言退回 draft-07。
const ajvPreferred = [];
if (process.env.AJV_LIB) {
  const derived = process.env.AJV_LIB.replace(/ajv\.js$/, "2020.js");
  const derivedPath = path.isAbsolute(derived) ? derived : path.join(ROOT, derived);
  if (derived !== process.env.AJV_LIB && fs.existsSync(derivedPath)) ajvPreferred.push(derived);
}
ajvPreferred.push("ajv/dist/2020");
const ajvMod = await load("AJV_LIB", "ajv", " JSON Schema 校验器（draft 2020-12）", ajvPreferred);

const YAML = yamlMod.mod.default || yamlMod.mod;
const AjvMod = ajvMod.mod.default || ajvMod.mod;
const Ajv = AjvMod.Ajv || AjvMod;

let schema;
let doc;
try {
  schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
} catch (e) {
  console.error(`✗ 官方 schema 副本不是合法 JSON：${e.message}`);
  process.exit(1);
}
try {
  const text = fs.readFileSync(COMPOSE, "utf8");
  doc = YAML.parse(text);
} catch (e) {
  console.error(`✗ compose 文件 YAML 解析失败：${e.message}`);
  process.exit(1);
}

console.log("compose 官方 Schema 校验（docker compose config 的等价替代）");
console.log(`  · compose 文件：${path.relative(ROOT, COMPOSE) || COMPOSE}`);
console.log(`  · 官方 schema ：compose-spec @ ${schema.$comment?.match(/[0-9a-f]{40}/)?.[0] ?? "(见文件头)"}`);
console.log(`  · YAML 解析   ：${yamlMod.how}`);
console.log(`  · Schema 校验 ：${ajvMod.how}`);

let validate;
try {
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  validate = ajv.compile(schema);
} catch (e) {
  console.error(`✗ 官方 schema 编译失败：${e.message}`);
  console.error("   若提示 unknown schema/dialect，说明 ajv 版本不是 draft 2020-12（需 ajv/dist/2020）");
  process.exit(1);
}

const ok = validate(doc);
const services = Object.keys(doc?.services ?? {});
console.log(`  · 服务         ：${services.join("、")}（${services.length} 个）`);

if (!ok) {
  const errs = validate.errors ?? [];
  console.error(`\n✗ 不符合 compose-spec：${errs.length} 处问题`);
  for (const e of errs.slice(0, MAX_SHOW)) {
    console.error(`   ${e.instancePath || "/"} ${e.message}${e.params?.allowedValues ? "（允许：" + e.params.allowedValues.join("、") + "）" : ""}`);
  }
  if (errs.length > MAX_SHOW) console.error(`   …… 其余 ${errs.length - MAX_SHOW} 处省略`);
  process.exit(1);
}

/* ---------- 结构合格之外，再核对本项目约定（与 check-deploy.mjs 互补）---------- */
const problems = [];
if (doc?.name !== "jiajiao") problems.push(`顶层 name 应为 jiajiao，实际 ${JSON.stringify(doc?.name)}`);
for (const name of ["mysql", "redis", "app"]) {
  if (!doc?.services?.[name]) problems.push(`缺少服务 ${name}`);
}
if (doc?.services?.app?.build?.dockerfile !== "deploy/Dockerfile") problems.push("app.build.dockerfile 应为 deploy/Dockerfile");
if (!doc?.services?.seed?.profiles?.includes("seed")) problems.push("seed 服务应使用 profiles: [seed]（不随 up 常起）");
const appEnv = doc?.services?.app?.environment ?? {};
for (const key of ["AUTH_SECRET", "NODE_ENV", "MYSQL_HOST", "REDIS_HOST", "DEV_SMS"]) {
  if (!(key in appEnv)) problems.push(`app.environment 缺少 ${key}`);
}
if (!/\$\{AUTH_SECRET:\?/.test(String(appEnv.AUTH_SECRET ?? ""))) problems.push("AUTH_SECRET 应使用 ${AUTH_SECRET:?...} 强制必填");

if (problems.length) {
  console.error(`\n✗ 结构合法但不符合本项目约定：${problems.length} 处`);
  for (const p of problems) console.error("   " + p);
  process.exit(1);
}

console.log("\n✓ 符合 compose 官方 Schema（结构与本项目约定均通过）");
console.log("  说明：仍无法验证的是「容器真正起来」——需要 Docker 守护进程（本机 BIOS 关闭 VT-x）");
