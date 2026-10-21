// 单元测试：common/password.ts（scrypt 口令散列与校验）
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../../dist/common/password.js";

test("hashPassword：格式为 scrypt$salt$hash（16 字节盐 / 32 字节摘要）", () => {
  const h = hashPassword("a123456");
  assert.equal(h.split("$").length, 3);
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
});

test("hashPassword：明文不落库（不含原口令）", () => {
  const h = hashPassword("MySecretPass!");
  assert.ok(!h.includes("MySecretPass"), h);
});

test("hashPassword：同口令两次散列盐不同、结果不同", () => {
  const a = hashPassword("a123456");
  const b = hashPassword("a123456");
  assert.notEqual(a, b, "盐必须随机");
  assert.notEqual(a.split("$")[1], b.split("$")[1]);
  assert.notEqual(a.split("$")[2], b.split("$")[2], "盐不同则摘要不同（scrypt 的盐参与散列）");
  assert.equal(verifyPassword("a123456", a), true);
  assert.equal(verifyPassword("a123456", b), true);
});

test("verifyPassword：正确口令通过", () => {
  const h = hashPassword("a123456");
  assert.equal(verifyPassword("a123456", h), true);
});

test("verifyPassword：错误口令拒绝", () => {
  const h = hashPassword("a123456");
  assert.equal(verifyPassword("a123457", h), false);
  assert.equal(verifyPassword("", h), false);
  assert.equal(verifyPassword("A123456", h), false, "大小写敏感");
});

test("verifyPassword：跨账号散列不串号", () => {
  const h1 = hashPassword("a123456");
  const h2 = hashPassword("b123456");
  assert.equal(verifyPassword("a123456", h2), false);
  assert.equal(verifyPassword("b123456", h1), false);
});

test("verifyPassword：畸形存储值一律拒绝", () => {
  assert.equal(verifyPassword("a123456", ""), false);
  assert.equal(verifyPassword("a123456", null), false);
  assert.equal(verifyPassword("a123456", undefined), false);
  assert.equal(verifyPassword("a123456", "plaintext"), false);
  assert.equal(verifyPassword("a123456", "scrypt$onlysalt"), false);
  assert.equal(verifyPassword("a123456", "bcrypt$aa$bb"), false);
  assert.equal(verifyPassword("a123456", "scrypt$aa$zz"), false, "非法十六进制摘要");
  assert.equal(verifyPassword("a123456", "scrypt$$"), false);
});
