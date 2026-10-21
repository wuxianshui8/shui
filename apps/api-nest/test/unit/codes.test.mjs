// 单元测试：common/codes.ts（随机短码 / 一次性初始口令）
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomCode, randomPassword, DEMO_PASSWORD } from "../../dist/common/codes.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉了 I/O/0/1

test("randomCode：默认 6 位、自定义位数", () => {
  assert.equal(randomCode().length, 6);
  assert.equal(randomCode(4).length, 4);
  assert.equal(randomCode(12).length, 12);
  assert.equal(randomCode(0), "");
});

test("randomCode：只用无歧义字符集", () => {
  for (let i = 0; i < 200; i++) {
    const c = randomCode(8);
    assert.match(c, /^[A-Z2-9]+$/, c);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch), "非法字符 " + ch);
    assert.ok(!/[IO01]/.test(c), "含易混淆字符 " + c);
  }
});

test("randomCode：具备随机性（200 个样本几乎不重复）", () => {
  const set = new Set();
  for (let i = 0; i < 200; i++) set.add(randomCode(8));
  assert.ok(set.size >= 199, "重复过多：" + set.size);
});

test("DEMO_PASSWORD：与需求书演示账号一致", () => {
  assert.equal(DEMO_PASSWORD, "a123456");
});

test("randomPassword：12 位且四类字符齐全", () => {
  for (let i = 0; i < 50; i++) {
    const p = randomPassword();
    assert.equal(p.length, 12, p);
    assert.ok(/[A-Z]/.test(p), "缺大写 " + p);
    assert.ok(/[a-z]/.test(p), "缺小写 " + p);
    assert.ok(/[0-9]/.test(p), "缺数字 " + p);
    assert.ok(/[!@#$%&*]/.test(p), "缺符号 " + p);
    assert.ok(!/[IO01l]/.test(p), "含易混淆字符 " + p);
  }
});

test("randomPassword：每次不同（不返回固定串）", () => {
  const set = new Set();
  for (let i = 0; i < 50; i++) set.add(randomPassword());
  assert.equal(set.size, 50);
});
