// 单元测试：common/ledger.ts 的纯函数部分（金额一律整数分，费率换算四舍五入）
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRate } from "../../dist/common/ledger.js";

test("applyRate：整数结果（0.06 × 10000 = 600 分）", () => {
  assert.equal(applyRate(10000, 0.06), 600);
});

test("applyRate：四舍五入到最近的整分（0.18 × 3600 = 648）", () => {
  assert.equal(applyRate(3600, 0.18), 648);
  assert.equal(applyRate(100, 0.005), 1, "0.5 分进位为 1");
  assert.equal(applyRate(100, 0.004), 0, "0.4 分舍去为 0");
  assert.equal(applyRate(333, 1 / 3), 111);
  assert.equal(applyRate(999, 0.3333), 333);
});

test("applyRate：结果始终为整数（不产生浮点尾数）", () => {
  for (const [amount, rate] of [
    [19900, 0.06],
    [16400, 0.15],
    [7777, 0.075],
    [1, 0.5],
    [12345, 0.0001],
  ]) {
    const v = applyRate(amount, rate);
    assert.ok(Number.isInteger(v), amount + "×" + rate + " = " + v);
  }
});

test("applyRate：字符串入参按数值处理（查询串场景）", () => {
  assert.equal(applyRate("1000", "0.06"), 60);
});

test("applyRate：0 费率/0 金额均为 0", () => {
  assert.equal(applyRate(10000, 0), 0);
  assert.equal(applyRate(0, 0.06), 0);
});

test("applyRate：负值保持符号（仅作数学事实，业务层已禁止负费率）", () => {
  assert.equal(applyRate(-100, 0.06), -6);
  assert.equal(applyRate(100, -0.06), -6);
});
