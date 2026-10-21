// 资金并发对抗门禁：复用 gate-p6 的起停与建库流程，只把测试脚本换成 check-money-races.mjs
// 用法：node tools/gate-races.mjs  或  npm run nest:gate:races
process.env.E2E_SCRIPT = "tools/check-money-races.mjs";
process.env.E2E_SECTION = "";
await import("./gate-p6.mjs");
