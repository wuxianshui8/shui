// 单元测试：common/token.ts（自签 HMAC 令牌 + token_version）
// 先设置 AUTH_SECRET 再动态导入，避免 config 读取到内置开发密钥
process.env.AUTH_SECRET = "unit-test-secret-0123456789abcdef";
process.env.NODE_ENV = "test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const { signToken, verifyToken } = await import("../../dist/common/token.js");
const { config } = await import("../../dist/config.js");

const b64u = (v) => Buffer.from(v).toString("base64url");
const SECRET = process.env.AUTH_SECRET;

const decode = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

/** 用手工构造的令牌（同名密钥签名），用于验证过期/畸形分支 */
function craft(payload, secret = SECRET) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(typeof payload === "string" ? payload : JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(head + "." + body).digest("base64url");
  return head + "." + body + "." + sig;
}

test("signToken：三段式，头部声明 HS256/JWT", () => {
  const t = signToken(4, "teacher");
  assert.equal(t.split(".").length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString("utf8")), {
    alg: "HS256",
    typ: "JWT",
  });
});

test("signToken：声明含 uid/role/v/exp，TTL 取配置", () => {
  const before = Math.floor(Date.now() / 1000);
  const p = decode(signToken(4, "teacher", 3));
  assert.equal(p.uid, 4);
  assert.equal(p.role, "teacher");
  assert.equal(p.v, 3);
  assert.ok(p.exp >= before + config.tokenTtlSeconds - 2, "exp 应为 now+TTL，实际差 " + (p.exp - before));
  assert.equal(config.tokenTtlSeconds, 7 * 24 * 3600, "7 天");
});

test("signToken：version 缺省为 0，uid 强制转数字", () => {
  assert.equal(decode(signToken(9, "parent")).v, 0);
  assert.equal(decode(signToken("7", "admin")).uid, 7);
  assert.equal(decode(signToken(7, "admin", "0")).v, 0);
});

test("verifyToken：往返一致", () => {
  assert.deepEqual(verifyToken(signToken(4, "teacher", 2)), { uid: 4, role: "teacher", v: 2 });
  assert.deepEqual(verifyToken(signToken(1, "admin")), { uid: 1, role: "admin", v: 0 });
});

test("verifyToken：改密后旧令牌因 token_version 变化被业务层拒绝（签名仍有效）", () => {
  const t = signToken(4, "teacher", 1);
  const p = verifyToken(t);
  assert.equal(p.v, 1);
  assert.notEqual(p.v, 2, "账号当前版本为 2 时应视为失效");
});

test("verifyToken：篡改载荷（提权/换用户）签名失配返回 null", () => {
  const t = signToken(101, "sales");
  const [head, , sig] = t.split(".");
  const forged = b64u(JSON.stringify({ uid: 1, role: "admin", v: 0, exp: decode(t).exp }));
  assert.equal(verifyToken(head + "." + forged + "." + sig), null);
});

test("verifyToken：篡改签名返回 null", () => {
  const t = signToken(4, "teacher");
  const parts = t.split(".");
  assert.equal(verifyToken(parts[0] + "." + parts[1] + "." + parts[2].slice(0, -2) + "AA"), null);
});

test("verifyToken：换密钥签发的令牌返回 null", () => {
  const other = craft({ uid: 1, role: "admin", v: 0, exp: Math.floor(Date.now() / 1000) + 600 }, "another-secret-value");
  assert.equal(verifyToken(other), null);
});

test("verifyToken：过期令牌返回 null", () => {
  const past = craft({ uid: 4, role: "teacher", v: 0, exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(verifyToken(past), null);
});

test("verifyToken：缺 exp 视为无效", () => {
  assert.equal(verifyToken(craft({ uid: 4, role: "teacher", v: 0 })), null);
  assert.equal(verifyToken(craft({ uid: 4, role: "teacher", v: 0, exp: 0 })), null);
});

test("verifyToken：畸形输入一律返回 null（不抛异常）", () => {
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken(null), null);
  assert.equal(verifyToken(undefined), null);
  assert.equal(verifyToken(12345), null);
  assert.equal(verifyToken("a.b"), null);
  assert.equal(verifyToken("a.b.c.d"), null);
  assert.equal(verifyToken("not-a-token"), null);
  assert.equal(verifyToken(craft("{bad json", "x")), null, "非法 JSON 载荷");
  assert.equal(verifyToken(craft("{bad json")), null, "签名正确但载荷非 JSON");
});
