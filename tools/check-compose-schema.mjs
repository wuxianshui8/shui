// ============================================================
// compose 官方 Schema 校验（deploy/docker-compose.yml ↔ compose-spec）
//
//   背景：本机没有 Docker 守护进程（BIOS 关闭 VT-x），`docker compose config`
//   无法执行。这里改用 compose 官方发布的 JSON Schema 做等价的结构校验：
//     schema 来源：https://github.com/compose-spec/compose-spec
//     固定提交：de28432802a367d650bd4ad6748b19491b6cf986
//     本地副本：deploy/compose-spec.schema.json（随仓库提交，离线可用）
//   ⚠️ 该检查覆盖「配置结构是否合法」，不覆盖「容器能否真正起来」。
//
// 依赖（根目录保持零第三方依赖，故按需注入）：
//   YAML_LIB=<yaml 模块路径或包名>   —— 解析 compose 文件
//   AJV_LIB=<ajv 模块路径或包名>     —— JSON Schema 校验器
// 用法：
//   node tools/check-compose-schema.mjs
//   node tools/check-compose-schema.mjs --require   # 缺依赖即失败（强校验）
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMPOSE = process.env.COMPOSE_FILE
  ? path.resolve(process.env.COMPOSE_FILE)
  : path.join(ROOT, "deploy", "docker-compose.yml");
const SCHEMA = process.env.SCHEMA_FILE
  ? path.resolve(process.env.SCHEMA_FILE)
  : path.join(ROOT, "deploy", "compose-spec.schema.json");
const REQUIRE = process.argv.includes("--require");
const MAX_SHOW = 12;

/** 环境变量指定的是路径就转成 file:// URL，否则当作包名 */
function spec(target) {
  if (!target) return null;
  return /[\\/]/.test(target) || /\.(mjs|cjs|js|json)$/i.test(target)
    ? pathToFileURL(path.resolve(target)).href
    : target;
}

/** 按「首选候选 → 环境变量指定 → 包名」的顺序探测，返回第一个可加载的模块 */
async function load(envKey, pkg, what, preferred = []) {
  const custom = process.env[envKey];
  const listed = [
    ...preferred.filter(Boolean).map((p) => ({ c: spec(p), how: p })),
    ...(custom ? [{ c: spec(custom), how: `${envKey}=${custom}` }] : []),
    { c: pkg, how: pkg },
  ];
  const fails = [];
  for (const { c, how } of listed) {
    try {
      return { mod: await import(c), how };
    } catch (e) {
      fails.push(`${c}: ${e.message.split("\n")[0]}`);
    }
  }
  if (REQUIRE) {
    console.error(`✗ 缺少${what}（${pkg}）。设置 ${envKey} 指向该依赖，或先安装：${pkg}`);
    for (const f of fails) console.error("   " + f);
    process.exit(1);
  }
  console.log(`⚠️ 跳过：缺少${what}（${pkg}），未做官方 Schema 校验`);
  for (const f of fails) console.log("   " + f);
  console.log(`   开启方式：设置 ${envKey}=<该依赖的路径或包名>；强校验加 --require`);
  process.exit(0);
}

const yamlMod = await load("YAML_LIB", "yaml", " YAML 解析库");
// compose-spec 是 draft 2020-12，ajv 核心不含该方言，优先用 ajv/dist/2020
const ajvPreferred = [process.env.AJV_LIB?.replace(/ajv\.js$/, "2020.js"), "ajv/dist/2020"].filter(Boolean);
const ajvMod = await load("AJV_LIB", "ajv", " JSON Schema 校验器", ajvPreferred);
const YAML = yamlMod.mod.default || yamlMod.mod;
const AjvMod = ajvMod.mod.default || ajvMod.mod;
const Ajv = AjvMod.Ajv || AjvMod;

if (!fs.existsSync(COMPOSE)) {
  console.error(`✗ 找不到 ${COMPOSE}`);
  process.exit(1);
}
if (!fs.existsSync(SCHEMA)) {
  console.error(`✗ 找不到官方 schema 副本 ${SCHEMA}`);
  console.error("  重新获取：见 deploy/compose-spec.schema.json 文件头的 $comment");
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
const text = fs.readFileSync(COMPOSE, "utf8");
const doc = YAML.parse(text);

console.log("compose 官方 Schema 校验（docker compose config 的等价替代）");
console.log(`  · compose 文件：deploy/docker-compose.yml`);
console.log(`  · 官方 schema ：compose-spec @ ${schema.$comment?.match(/[0-9a-f]{40}/)?.[0] ?? "(见文件头)"}`);
console.log(`  · YAML 解析   ：${yamlMod.how}；Schema 校验：${ajvMod.how}`);

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
let validate;
try {
  validate = ajv.compile(schema);
} catch (e) {
  console.error(`✗ 官方 schema 本身编译失败：${e.message}`);
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

// 结构合法之外，再核对本项目关心的关键约定（与 check-deploy.mjs 互补）
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
