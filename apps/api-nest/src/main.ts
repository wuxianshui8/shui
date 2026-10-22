import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./common/pipes-and-filters";
import { config } from "./config";
import { createSmsSender } from "./integrations/sms/sms.service";
import { createPayProvider } from "./integrations/pay/pay.service";

const SECURITY_HEADERS = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data: blob: https:",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; "),
};

async function bootstrap() {
  // 启动即校验外部集成配置：真实通道配错就别启动，不要等第一条验证码/第一笔支付才炸
  try {
    const sms = createSmsSender();
    if (sms.name === "mock") {
      console.warn("[集成] 短信通道=mock（验证码只写服务端日志；上线必须配置 SMS_PROVIDER=tencent 及密钥）");
    } else {
      console.log("[集成] 短信通道=" + sms.name);
    }
  } catch (e: any) {
    console.error("[集成] 短信配置无效，拒绝启动：" + (e?.message || e));
    process.exit(1);
  }
  try {
    const pay = createPayProvider();
    if (pay.name === "mock") {
      console.warn("[集成] 支付通道=mock（不产生真实收款；上线必须配置 PAY_PROVIDER=wechat 及商户证书/密钥）");
    } else {
      console.log("[集成] 支付通道=" + pay.name);
    }
  } catch (e: any) {
    console.error("[集成] 支付配置无效，拒绝启动：" + (e?.message || e));
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["error", "warn", "log"] });
  app.setGlobalPrefix("api", { exclude: [] });
  app.useGlobalFilters(new ApiExceptionFilter());

  // 安全响应头（与既有实现一致）
  app.use((_req: any, res: any, next: any) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    next();
  });

  // 静态托管既有前端产物（web/），便于用同一套 UI 对新后端做联调
  app.useStaticAssets(join(process.cwd(), "..", "..", config.webDir), { index: false });
  // 静态托管 Vue3 + Element Plus 的 PC 管理后台（apps/web-admin/dist，需求 6.1）
  app.useStaticAssets(join(process.cwd(), "..", "web-admin", "dist"), { prefix: "/admin-vue/", index: false });
  // 静态托管 uni-app H5 移动端（apps/web-mobile/dist/build/h5，需求 6.1）
  const h5Dir = join(process.cwd(), "..", "web-mobile", "dist", "build", "h5");
  app.useStaticAssets(h5Dir, { prefix: "/m/", index: false });
  app.use((req: any, res: any, next: any) => {
    // 两个 SPA（hash / history 路由）都回落到各自的 index.html
    if (req.method === "GET" && (req.path === "/admin-vue" || req.path === "/admin-vue/")) {
      return res.sendFile(join(process.cwd(), "..", "web-admin", "dist", "index.html"), (err: any) => (err ? next() : undefined));
    }
    if (req.method === "GET" && (req.path === "/m" || req.path === "/m/" || (req.path.startsWith("/m/") && !req.path.includes(".")))) {
      return res.sendFile(join(h5Dir, "index.html"), (err: any) => (err ? next() : undefined));
    }
    if (req.method === "GET" && !req.path.startsWith("/api") && !req.path.includes(".")) {
      const name = req.path === "/" ? "/index.html" : req.path + ".html";
      return res.sendFile(join(process.cwd(), "..", "..", config.webDir, name), (err: any) => (err ? next() : undefined));
    }
    next();
  });

  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`NestJS API 已启动 http://localhost:${config.port}  (MySQL ${config.mysql.host}:${config.mysql.port}, Redis ${config.redis.host}:${config.redis.port})`);
}

bootstrap();