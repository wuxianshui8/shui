// 细粒度权限矩阵门禁：复用 gate-p6 的起停与建库流程
// 用法：node tools/gate-permissions.mjs  或  npm run nest:gate:permissions
process.env.E2E_SCRIPT = "tools/check-permissions.mjs";
process.env.E2E_SECTION = "";
await import("./gate-p6.mjs");
