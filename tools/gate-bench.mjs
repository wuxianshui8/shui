// 新后端性能基线门禁：复用 gate-p6 的起停与建库流程，只把测试脚本换成 bench-nest.mjs
// 用法：node tools/gate-bench.mjs  或  npm run nest:bench
process.env.E2E_SCRIPT = "tools/bench-nest.mjs";
process.env.E2E_SECTION = "";
await import("./gate-p6.mjs");
