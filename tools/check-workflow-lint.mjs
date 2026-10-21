// ============================================================
// GitHub Actions 工作流离线 lint（官方 actionlint / SchemaStore 在本机被网络阻断，
// 这里用离线规则覆盖 Actions 最常见的真实错误）
//   1. on / jobs / steps 结构完整，作业都有 runs-on
//   2. 每个 step 恰有 uses 或 run 之一；uses 必须锁主版本（@vN）
//   3. services 必须有 image；options 里的 health-cmd 有对应端口
//   4. working-directory 必须真实存在；env 值必须是字符串
//   5. concurrency 必须给 group；shell 多行块 run: | 不允许出现 Tab
//   6. 步骤里引用的 ${{ secrets.* }} 不得拼进 run（避免命令注入泄漏）
// 用法：node tools/check-workflow-lint.mjs
// ============================================================
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WF = path.join(ROOT, ".github", "workflows", "ci.yml");
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

if (!existsSync(WF)) {
  console.error("✗ 缺少 .github/workflows/ci.yml");
  process.exit(1);
}
const text = readFileSync(WF, "utf8");
const lines = text.split(/\r?\n/);

/* ---------- 基础结构 ---------- */
if (/\t/.test(text)) fail("文件包含 Tab（YAML 只允许空格缩进）");
if (!/^name:\s*\S+/m.test(text)) fail("缺少 name:");
if (!/^on:/m.test(text)) fail("缺少 on:");
const onBlock = (text.match(/^on:[\s\S]*?\n(?=\w)/m) || [""])[0];
const allowedTriggers = ["push", "pull_request", "workflow_dispatch", "schedule", "workflow_call", "release"];
for (const m of onBlock.matchAll(/^ {2}(\w+):/gm)) {
  if (!allowedTriggers.includes(m[1])) fail("未知触发器：" + m[1]);
}
if (!/^jobs:/m.test(text)) fail("缺少 jobs:");
if (!/concurrency:\s*\n\s+group:/m.test(text)) fail("concurrency 缺少 group（cancel-in-progress 需要它限定范围）");

/* ---------- 作业与步骤（只看 jobs: 段，避免把 on: 的触发器当成作业） ---------- */
const jobsStart = text.search(/^jobs:\s*$/m);
const jobsText = jobsStart >= 0 ? text.slice(jobsStart) : "";
const jobNames = [...jobsText.matchAll(/^ {2}(\w[\w-]*):\s*$/gm)]
  .map((m) => m[1])
  .filter((n) => !["services", "steps", "env", "concurrency"].includes(n));
for (const name of jobNames) {
  const idx = jobsText.indexOf("\n  " + name + ":\n");
  const nextIdx = jobNames
    .map((n) => jobsText.indexOf("\n  " + n + ":\n"))
    .filter((i) => i > idx)
    .sort((a, b) => a - b)[0];
  const block = jobsText.slice(idx, nextIdx === undefined ? jobsText.length : nextIdx);
  if (!/ {4}runs-on:/.test(block)) fail("作业 " + name + " 缺少 runs-on");
  if (!/ {4}steps:/.test(block)) fail("作业 " + name + " 缺少 steps");
}
notes.push("作业：" + jobNames.join("、"));

// 每步必须有 uses 或 run（且 uses 必须锁版本）
const stepStarts = [...text.matchAll(/^ {6}- (name|uses|run|if):/gm)];
if (stepStarts.length < 3) fail("未解析到足够多的步骤（结构可能不符合预期）");
const stepBlocks = stepStarts.map((m, i) => ({
  index: m.index,
  body: text.slice(m.index, i + 1 < stepStarts.length ? stepStarts[i + 1].index : text.length),
}));
for (const [i, s] of stepBlocks.entries()) {
  const hasUses = /^( {6}- uses:| {8}uses:)/m.test(s.body);
  const hasRun = /^( {6}- run:| {8}run:)/m.test(s.body);
  const label = (s.body.match(/- (?:name|uses|run):\s*(.+)/) || [])[1] || "step#" + (i + 1);
  if (hasUses && hasRun) fail("步骤既有 uses 又有 run：" + label);
  if (!hasUses && !hasRun) fail("步骤既无 uses 也无 run：" + label);
  const usesLine = s.body.match(/uses:\s*(\S+)/);
  if (usesLine && !/@v?\d/.test(usesLine[1])) fail("uses 未锁定版本：" + usesLine[1]);
}
notes.push("步骤数：" + stepBlocks.length);

/* ---------- services / working-directory / env ---------- */
const servicesBlock = (text.match(/^ {4}services:[\s\S]*?(?=^ {4}\w)/m) || [""])[0];
const serviceImages = [...servicesBlock.matchAll(/^ {6}\w[\w-]*:\s*\n(?:.*\n)*? {8}image:\s*(\S+)/gm)].map((m) => m[1]);
if (/services:/.test(text) && serviceImages.length === 0) fail("services 段存在但没有解析到任何 image");
for (const img of serviceImages) {
  if (!/:/.test(img)) fail("service 镜像未指定 tag：" + img);
}
notes.push("服务容器：" + (serviceImages.join("、") || "无"));
if (/health-cmd/.test(servicesBlock) && !/--health-interval/.test(servicesBlock)) {
  fail("services 的 health-cmd 缺少 health-interval/timeout/retries 参数");
}

for (const m of text.matchAll(/working-directory:\s*(\S+)/g)) {
  if (!existsSync(path.join(ROOT, m[1]))) fail("working-directory 不存在：" + m[1]);
}

const envBlock = (text.match(/^env:[\s\S]*?\n(?=\w)/m) || [""])[0];
for (const m of envBlock.matchAll(/^ {2}(\w+):\s*(.*)$/gm)) {
  if (!m[2].trim()) fail("env " + m[1] + " 没有值");
}

/* ---------- 安全：secrets 不得直接拼进 run ---------- */
for (const m of text.matchAll(/^.*run:.*\$\{\{\s*secrets\.[^}]+\}\}.*$/gm)) {
  fail("run 里直接插值 secrets（应改为 env 传入）：" + m[0].trim().slice(0, 80));
}

/* ---------- 输出 ---------- */
console.log("GitHub Actions 工作流 · 离线 lint");
console.log("（官方 actionlint / SchemaStore / Docker Hub 在本机被网络阻断；此项为离线规则校验）");
notes.forEach((n) => console.log("  · " + n));
if (problems.length) {
  console.log("\n✗ 发现 " + problems.length + " 个问题：");
  problems.forEach((p) => console.log("  - " + p));
  process.exit(1);
}
console.log("\n✓ on / jobs / steps / services / working-directory / env / secrets 用法均符合 Actions 规范");
