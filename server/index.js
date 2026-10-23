// 家教上门撮合平台 —— 服务入口
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./core/db.js";
import { ensureDefaults } from "./core/config.js";
import { Router } from "./core/router.js";
import { fail, sendJson } from "./core/http.js";
import { get } from "./core/db.js";
import { escrowBalance } from "./core/ledger.js";
import { runSettlement, runLessonReminders, autoApproveCancelRequests } from "./modules/orders.js";
import { expireApplications } from "./modules/market.js";
import * as authModule from "./modules/auth.js";
import * as marketModule from "./modules/market.js";
import * as teacherModule from "./modules/teacher.js";
import * as orderModule from "./modules/orders.js";
import * as walletModule from "./modules/wallet.js";
import * as salesModule from "./modules/sales.js";
import * as agentModule from "./modules/agent.js";
import * as adminModule from "./modules/admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const UPLOAD_DIR = path.join(ROOT, "data", "uploads");
const PORT = Number(process.env.PORT || 4173);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

migrate();
ensureDefaults();
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const router = new Router();
for (const mod of [authModule, marketModule, teacherModule, orderModule, walletModule, salesModule, agentModule, adminModule]) {
  mod.register(router);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".csv": "text/csv; charset=utf-8",
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  // 友好路由：/parent → /parent.html
  if (!path.extname(rel)) rel = rel.replace(/\/$/, "") + ".html";
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403); res.end("Forbidden"); return true;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveUploads(req, res, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/uploads\/?/, ""));
  const file = path.join(UPLOAD_DIR, rel);
  if (!file.startsWith(UPLOAD_DIR) || !fs.existsSync(file)) {
    res.writeHead(404); res.end("Not Found"); return true;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}

// 安全响应头：防点击劫持、限制资源来源、控制 Referer 泄露
// frame-ancestors / X-Frame-Options 用 self（同源 iframe 用于自动化兼容性检查）
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
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; "),
};

function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.hasHeader(k)) res.setHeader(k, v);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  applySecurityHeaders(res);
  try {
    if (url.pathname.startsWith("/uploads/")) {
      if (serveUploads(req, res, url.pathname)) return;
    }
    if (url.pathname === "/api/health") {
      const started = Date.now();
      try {
        const users = get("SELECT COUNT(*) AS c FROM users").c;
        const orders = get("SELECT COUNT(*) AS c FROM orders").c;
        const escrow = escrowBalance();
        sendJson(res, 200, {
          code: 0,
          message: "ok",
          data: {
            status: "ok",
            version: pkg.version,
            uptime: Math.round(process.uptime()),
            time: new Date().toISOString(),
            db: { ok: true, users, orders, escrow, latencyMs: Date.now() - started },
          },
        });
      } catch (err) {
        sendJson(res, 503, { code: "UNHEALTHY", message: "数据库不可用：" + err.message, data: null });
      }
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const handled = await router.handle(req, res, url);
      if (!handled) sendJson(res, 404, { code: "NOT_FOUND", message: "接口不存在", data: null });
      return;
    }
    if (serveStatic(req, res, url.pathname)) return;
    if (serveStatic(req, res, "/index.html")) return;
    sendJson(res, 404, { code: "NOT_FOUND", message: "页面不存在", data: null });
  } catch (err) {
    fail(res, err);
  }
});

// 定时任务（每分钟）：T+N 结算放款 + 抢单超时失效 + 上课前提醒
setInterval(() => {
  try {
    const n = runSettlement();
    if (n) console.log("[settlement] 结算订单 " + n + " 笔");
  } catch (err) {
    console.error("[settlement-error]", err.message);
  }
  try {
    const e = expireApplications();
    if (e) console.log("[applications] 超时报名失效 " + e + " 条");
  } catch (err) {
    console.error("[expire-error]", err.message);
  }
  try {
    const r = runLessonReminders();
    if (r) console.log("[reminder] 上课提醒已推送 " + r + " 单");
  } catch (err) {
    console.error("[reminder-error]", err.message);
  }
  try {
    // 家长取消申请超时未被教员处理 → 自动按同意退款（钱不能一直押在担保账户里）
    const c = autoApproveCancelRequests();
    if (c.approved) console.log("[cancel-request] 取消申请超时自动同意 " + c.approved + " 单（阈值 " + c.minutes + " 分钟）");
  } catch (err) {
    console.error("[cancel-request-error]", err.message);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log("家教撮合平台已启动  http://localhost:" + PORT);
  console.log("入口导航            http://localhost:" + PORT + "/");
});