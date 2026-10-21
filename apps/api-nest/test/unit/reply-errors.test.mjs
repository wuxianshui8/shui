// 单元测试：common/reply.ts（统一成功信封）+ common/errors.ts（统一异常与状态码）
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpStatus } from "@nestjs/common";
import { ok, nowIso } from "../../dist/common/reply.js";
import { bad, unauthorized, forbidden, notFound, biz, conflict, tooMany } from "../../dist/common/errors.js";

test("ok：默认 data 为 null，code=0", () => {
  assert.deepEqual(ok(), { code: 0, message: "ok", data: null });
});

test("ok：透传任意 data（对象/数组/0/空串都要保留）", () => {
  assert.deepEqual(ok({ a: 1 }), { code: 0, message: "ok", data: { a: 1 } });
  assert.deepEqual(ok([]).data, []);
  assert.equal(ok(0).data, 0);
  assert.equal(ok("").data, "");
  assert.equal(ok(false).data, false);
});

test("nowIso：ISO-8601 且可解析为当前时间", () => {
  const s = nowIso();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(s) - Date.now()) < 5000);
});

const cases = [
  ["bad", bad, HttpStatus.BAD_REQUEST, "BAD_REQUEST"],
  ["unauthorized", unauthorized, HttpStatus.UNAUTHORIZED, "UNAUTHORIZED"],
  ["forbidden", forbidden, HttpStatus.FORBIDDEN, "FORBIDDEN"],
  ["notFound", notFound, HttpStatus.NOT_FOUND, "NOT_FOUND"],
  ["conflict", conflict, HttpStatus.CONFLICT || 409, "CONFLICT"],
  ["tooMany", tooMany, HttpStatus.TOO_MANY_REQUESTS, "TOO_MANY_REQUESTS"],
];

for (const [name, fn, status, code] of cases) {
  test("errors." + name + "：HTTP " + status + " + 错误码 " + code, () => {
    const e = fn === tooMany ? fn(code, "测试限流") : fn();
    assert.equal(e.getStatus(), status);
    const body = e.getResponse();
    assert.equal(body.code, code);
    assert.equal(typeof body.message, "string");
    assert.ok(body.message.length > 0);
  });
}

test("errors：默认中文提示语", () => {
  assert.equal(bad().getResponse().message, "参数错误");
  assert.equal(unauthorized().getResponse().message, "请先登录");
  assert.equal(forbidden().getResponse().message, "无权访问该资源");
  assert.equal(notFound().getResponse().message, "资源不存在");
  assert.equal(conflict().getResponse().message, "操作冲突，请刷新后重试");
});

test("errors：可覆盖提示语", () => {
  assert.equal(bad("金额必须大于 0").getResponse().message, "金额必须大于 0");
  assert.equal(notFound("订单不存在").getResponse().message, "订单不存在");
});

test("errors.biz：业务错误码自定义且为 400", () => {
  const e = biz("ORDER_STATE_INVALID", "订单状态不允许该操作");
  assert.equal(e.getStatus(), HttpStatus.BAD_REQUEST);
  assert.deepEqual(e.getResponse(), { code: "ORDER_STATE_INVALID", message: "订单状态不允许该操作" });
});

test("errors.tooMany：限流错误码 429", () => {
  const e = tooMany("SMS_TOO_FREQUENT", "发送过于频繁");
  assert.equal(e.getStatus(), 429);
  assert.deepEqual(e.getResponse(), { code: "SMS_TOO_FREQUENT", message: "发送过于频繁" });
});
