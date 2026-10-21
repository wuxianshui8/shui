// 隐私与账号安全门禁：复用 gate-p6 的起停与建库流程，只把测试脚本换成 check-privacy-auth.mjs
// 用法：node tools/gate-privacy.mjs  或  npm run nest:gate:privacy
process.env.E2E_SCRIPT = "tools/check-privacy-auth.mjs";
process.env.E2E_SECTION = "";
await import("./gate-p6.mjs");
