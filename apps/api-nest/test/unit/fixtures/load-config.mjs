// 供 config.test.mjs 在独立子进程中加载 dist/config.js：
// config 在模块加载期做安全校验（生产必须配 AUTH_SECRET），只能靠独立进程验证
const { config } = await import("../../../dist/config.js");
console.log(
  JSON.stringify({
    port: config.port,
    authSecret: config.authSecret,
    tokenTtlSeconds: config.tokenTtlSeconds,
    mysql: config.mysql,
    redis: config.redis,
    webDir: config.webDir,
  })
);
