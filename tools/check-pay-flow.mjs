// ============================================================
// 支付回调与幂等门禁（A2：预支付 → 回调确认 → 幂等入账）
//
//   为什么单独起一个服务：需要 PAY_PROVIDER=wechat 的真实验签路径，
//   而主门禁服务（4300）跑的是 mock（保持「点一下即成功」的既有语义）。
//   这里用**本地生成的 RSA 密钥对**自签回调，因此不需要商户号与真实证书。
//
//   依赖：由 tools/gate-p6.mjs 起好的 MySQL / Redis 与演示数据（复用同一库）
//   用法：E2E_SCRIPT=tools/check-pay-flow.mjs node tools/gate-p6.mjs
// ============================================================
import { spawn } from "node:child_process";
import { createCipheriv, createSign, generateKeyPairSync } from "node:crypto";
import net from "node:net";
import path from "node:path";

const ROOT = process.env.GATE_ROOT || "D:/shui";
const APP = path.join(ROOT, "apps", "api-nest");
const PORT = Number(process.env.PAY_GATE_PORT || 4391);
const BASE = "http://127.0.0.1:" + PORT;
const PARENT_PHONE = "13900000301";
const PASSWORD = "a123456";
const API_V3_KEY = "0123456789abcdef0123456789abcdef";

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log("  ✓ " + name + (detail ? "  —  " + detail : ""));
  } else {
    fails.push(name + (detail ? "  —  " + detail : ""));
    console.log("  ✗ " + name + (detail ? "  —  " + detail : ""));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 本地自签密钥（等价于平台证书） ---------------- */
const keypair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
const platform = keypair(); // 用它签「微信回调」，服务端用平台公钥验签
const merchant = keypair(); // 商户私钥（服务端给渠道请求签名用）

const SERVER_ENV = {
  ...process.env,
  PORT: String(PORT),
  PAY_PROVIDER: "wechat",
  WECHAT_PAY_APP_ID: "wxdemo1234567890",
  WECHAT_PAY_MCH_ID: "1900000001",
  WECHAT_PAY_SERIAL_NO: "SERIAL0001",
  WECHAT_PAY_PRIVATE_KEY: merchant.privateKey.replace(/\n/g, "\\n"),
  WECHAT_PAY_APIV3_KEY: API_V3_KEY,
  WECHAT_PAY_PLATFORM_PUBLIC_KEY: platform.publicKey.replace(/\n/g, "\\n"),
  WECHAT_PAY_NOTIFY_URL: "https://jiajiao.example.com/api/pay/wechat/notify",
  JOBS_ENABLED: "0",
};

/* ---------------- HTTP 小工具 ---------------- */
async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, text };
}

function encryptResource(plain, nonce = "abcdef123456", aad = "transaction") {
  const c = createCipheriv("aes-256-gcm", Buffer.from(API_V3_KEY, "utf8"), Buffer.from(nonce, "utf8"));
  c.setAAD(Buffer.from(aad, "utf8"));
  const buf = Buffer.concat([c.update(JSON.stringify(plain), "utf8"), c.final(), c.getAuthTag()]);
  return { ciphertext: buf.toString("base64"), nonce, associated_data: aad };
}

function signNotification(bodyText, ts = Math.floor(Date.now() / 1000), nonce = "hdrnonce") {
  const s = createSign("RSA-SHA256");
  s.update(ts + "\n" + nonce + "\n" + bodyText + "\n", "utf8");
  s.end();
  return {
    "Wechatpay-Timestamp": String(ts),
    "Wechatpay-Nonce": nonce,
    "Wechatpay-Signature": s.sign(platform.privateKey, "base64"),
    "Wechatpay-Serial": "PLATFORM",
  };
}

async function postNotify(bodyText, headers) {
  const res = await fetch(BASE + "/api/pay/wechat/notify", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bodyText,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json };
}

function buildNotifyBody(outTradeNo, amountCents, state = "SUCCESS", txnId = "4200" + String(Date.now()).slice(-10)) {
  const plain = { out_trade_no: outTradeNo, transaction_id: txnId, amount: { total: amountCents }, trade_state: state };
  return JSON.stringify({
    id: "evt-" + Date.now(),
    event_type: "TRANSACTION." + state,
    resource: { algorithm: "AEAD_AES_256_GCM", ...encryptResource(plain) },
  });
}

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port: p }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.setTimeout(600, () => {
      s.destroy();
      res(false);
    });
  });

/* ---------------- 起一个 wechat 模式的临时服务 ---------------- */
let child = null;
async function startServer() {
  child = spawn(process.execPath, ["dist/main.js"], { cwd: APP, env: SERVER_ENV, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write("[pay-gate] " + d));
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write("[pay-gate] " + d));
  for (let i = 0; i < 80; i++) {
    if (await portOpen(PORT)) {
      try {
        const r = await api("GET", "/api/health");
        if (r.status === 200) return;
      } catch {}
    }
    await sleep(300);
  }
  throw new Error("临时服务未就绪（:" + PORT + "）");
}

function stopServer() {
  if (!child) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch {}
}

/* ---------------- 用例 ---------------- */
async function main() {
  await startServer();
  console.log("支付回调与幂等门禁（PAY_PROVIDER=wechat，自签密钥，端口 " + PORT + "）");

  const login = await api("POST", "/api/auth/login-password", { body: { phone: PARENT_PHONE, password: PASSWORD } });
  ok("家长登录成功", login.status === 200 && !!login.body?.data?.token, "HTTP " + login.status);
  const token = login.body.data.token;

  const t = await api("GET", "/api/parent/teachers/4", { token });
  const svc = t.body?.data?.services?.[0];
  ok("取到教员服务", !!svc?.id, "serviceId=" + (svc && svc.id));

  const mkOrder = async (minutes, remark) => {
    const r = await api("POST", "/api/orders/from-service", {
      token,
      body: { serviceId: svc.id, lessonTime: new Date(Date.now() + minutes * 60000).toISOString(), remark },
    });
    return r.body?.data;
  };

  /* --- 订单 1：完整入账链路 --- */
  const o1 = await mkOrder(61, "回调入账验证");
  ok("新订单处于待支付", o1?.status === "awaiting_payment", "order " + (o1 && o1.orderNo));
  const amount1 = Number(o1.amount) + Number(o1.urgent_fee || 0);
  const body1 = buildNotifyBody(o1.orderNo, amount1);

  const r1 = await postNotify(body1, {});
  ok("未签名回调被拒绝（非 2xx）", r1.status >= 400, "HTTP " + r1.status);

  // 篡改必须真的改动「验签原文」：body 末尾加一个空格，签名仍用原始 body1
  const r2 = await postNotify(body1 + " ", signNotification(body1));
  ok("正文被篡改的回调验签失败（非 2xx）", r2.status >= 400, "HTTP " + r2.status);

  const wrong = buildNotifyBody(o1.orderNo, amount1 + 100);
  const r3 = await postNotify(wrong, signNotification(wrong));
  const after3 = (await api("GET", "/api/orders/" + o1.id, { token })).body?.data;
  ok("金额不一致的回调被拒绝", r3.status >= 400, "HTTP " + r3.status);
  ok("金额不一致时订单状态未变", after3?.status === "awaiting_payment", "status=" + after3?.status);

  // 预支付：wechat 模式下必须走真实下单（本机无网络/商户号 → 报渠道错误），
  // 关键是**不能静默成功**、订单不能入账；prepay 参数形状由单元测试覆盖
  const pre = await api("POST", "/api/orders/" + o1.id + "/pay", { token, body: { openId: "openid-test" } });
  ok(
    "wechat 模式 pay 不静默成功（走真实下单分支）",
    pre.status >= 400 && pre.body?.code === "PAY_CHANNEL_ERROR",
    "HTTP " + pre.status + " " + (pre.body?.message || ""),
  );
  ok(
    "wechat 模式 pay 后订单未入账",
    (await api("GET", "/api/orders/" + o1.id, { token })).body?.data?.status === "awaiting_payment",
  );

  const r5 = await postNotify(body1, signNotification(body1));
  ok("合法回调返回 SUCCESS", r5.status === 200 && r5.body?.code === "SUCCESS", "HTTP " + r5.status + " " + JSON.stringify(r5.body));
  const after5 = (await api("GET", "/api/orders/" + o1.id, { token })).body?.data;
  ok("回调后订单转为待上课", after5?.status === "pending_class", "status=" + after5?.status);
  ok("回调后已写入分账（服务费 > 0）", Number(after5?.serviceFee) > 0, "serviceFee=" + after5?.serviceFee);

  const r6 = await postNotify(body1, signNotification(body1));
  const after6 = (await api("GET", "/api/orders/" + o1.id, { token })).body?.data;
  ok("重复回调仍返回 SUCCESS（幂等）", r6.status === 200 && r6.body?.code === "SUCCESS", "HTTP " + r6.status);
  ok(
    "重复回调未造成二次分账",
    Number(after6?.serviceFee) === Number(after5?.serviceFee) && Number(after6?.teacherIncome) === Number(after5?.teacherIncome),
    "service_fee " + after5?.serviceFee + " → " + after6?.serviceFee,
  );

  /* --- 订单 2：非成功状态 + 过期时间戳 --- */
  const o2 = await mkOrder(122, "非成功状态验证");
  const amount2 = Number(o2.amount) + Number(o2.urgent_fee || 0);
  const notpay = buildNotifyBody(o2.orderNo, amount2, "NOTPAY");
  const r7 = await postNotify(notpay, signNotification(notpay));
  const after7 = (await api("GET", "/api/orders/" + o2.id, { token })).body?.data;
  ok("NOTPAY 回调按成功应答但不动账", r7.status === 200 && after7?.status === "awaiting_payment", "status=" + after7?.status);

  const ghost = buildNotifyBody("JJ-NOT-EXIST-0001", 100);
  const r8 = await postNotify(ghost, signNotification(ghost));
  ok("未知订单号回调被拒绝", r8.status >= 400, "HTTP " + r8.status);

  const stale = buildNotifyBody(o2.orderNo, amount2);
  const r9 = await postNotify(stale, signNotification(stale, Math.floor(Date.now() / 1000) - 3600));
  ok("过期时间戳的回调被拒绝（防重放）", r9.status >= 400, "HTTP " + r9.status);

  /* --- 超时关单（A2）：管理端手动触发，与定时任务同一函数 --- */
  const adminLogin = await api("POST", "/api/auth/login-password", { body: { phone: "13900000001", password: PASSWORD } });
  const adminToken = adminLogin.body?.data?.token;
  ok("管理员登录成功", !!adminToken, "HTTP " + adminLogin.status);

  const denied = await api("POST", "/api/admin/orders/close-expired", { token, body: { olderThanMinutes: 0.01 } });
  ok("超时关单仅管理员可调用（家长 403）", denied.status === 403, "HTTP " + denied.status);

  // 先等 1.2s：确保刚建的未支付单确实「老于 0.6s 阈值」，否则测的是「不误杀」而非「到点关单」
  await sleep(1200);

  const c1 = await api("POST", "/api/admin/orders/close-expired", { token: adminToken, body: { olderThanMinutes: 0.01 } });
  ok("超时关单可执行（0.01 分钟阈值，覆盖刚建的未支付单）", c1.status === 200 && Number(c1.body?.data?.closed) >= 1, "closed=" + c1.body?.data?.closed);
  const o2After = (await api("GET", "/api/orders/" + o2.id, { token })).body?.data;
  ok("超时未支付单被关闭（cancelled）", o2After?.status === "cancelled", "status=" + o2After?.status);

  const c2 = await api("POST", "/api/admin/orders/close-expired", { token: adminToken, body: { olderThanMinutes: 0.01 } });
  ok("再次关单幂等（closed=0）", c2.status === 200 && Number(c2.body?.data?.closed) === 0, "closed=" + c2.body?.data?.closed);
  /* --- 退款走渠道（A2 第 5 步）：wechat 模式下审批必须真的调渠道，失败不得假装退款成功 --- */
  const ap = await api("POST", "/api/orders/" + o1.id + "/refund", { token, body: { reason: "课程取消，申请退款" } });
  ok("家长申请退款成功（进入 refunding）", ap.status === 200 && ap.body?.data?.status === "refunding", "status=" + ap.body?.data?.status);

  const denyApprove = await api("POST", "/api/admin/refunds/" + o1.id + "/review", { token, body: { approve: true } });
  ok("退款审批需要后台权限（家长被拒）", denyApprove.status === 403 || denyApprove.status === 401, "HTTP " + denyApprove.status);

  // 本机没有真实商户号/网络 → 渠道退款必然失败；关键是**不能把订单错误标记成已退款**
  const approve = await api("POST", "/api/admin/refunds/" + o1.id + "/review", { token: adminToken, body: { approve: true } });
  ok("渠道不可用时退款审批失败且给出明确错误码", approve.status >= 400 && approve.body?.code === "REFUND_CHANNEL_ERROR", "HTTP " + approve.status + " " + (approve.body?.code || ""));
  const afterApprove = (await api("GET", "/api/orders/" + o1.id, { token })).body?.data;
  ok("渠道失败后订单仍为 refunding", afterApprove?.status === "refunding", "status=" + afterApprove?.status);
  ok("渠道失败后未写入退款金额", Number(afterApprove?.refundAmount || 0) === 0, "refundAmount=" + afterApprove?.refundAmount);

  stopServer();
  console.log("");
  if (fails.length) {
    console.log("✗ 支付回调与幂等门禁失败 " + fails.length + " 项：");
    for (const f of fails) console.log("  - " + f);
    process.exit(1);
  }
  console.log("✓ 支付回调与幂等门禁全部通过（" + pass + " 项）");
  process.exit(0);
}

main().catch((e) => {
  console.error("✗ 支付门禁异常：" + (e?.stack || e));
  stopServer();
  process.exit(1);
});
