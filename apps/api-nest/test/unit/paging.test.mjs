// 单元测试：common/paging.ts（统一分页语义：默认 300 / 上限 500）
import { test } from "node:test";
import assert from "node:assert/strict";
import { paging, pagedResult } from "../../dist/common/paging.js";

test("paging：缺省参数使用 300 页长", () => {
  assert.deepEqual(paging(), { page: 1, pageSize: 300, offset: 0 });
  assert.deepEqual(paging({}), { page: 1, pageSize: 300, offset: 0 });
  assert.deepEqual(paging(null), { page: 1, pageSize: 300, offset: 0 });
});

test("paging：正常翻页 offset 计算", () => {
  assert.deepEqual(paging({ page: "3", pageSize: "20" }), { page: 3, pageSize: 20, offset: 40 });
  assert.deepEqual(paging({ page: 2, pageSize: 1 }), { page: 2, pageSize: 1, offset: 1 });
});

test("paging：非法页号收敛到 1", () => {
  assert.equal(paging({ page: 0 }).page, 1);
  assert.equal(paging({ page: -5 }).page, 1);
  assert.equal(paging({ page: "abc" }).page, 1);
  assert.equal(paging({ page: null }).page, 1);
});

test("paging：页长上限 500，下限 1，非法值回默认", () => {
  assert.equal(paging({ pageSize: 9999 }).pageSize, 500);
  assert.equal(paging({ pageSize: 0 }).pageSize, 300, "0 视为未传");
  assert.equal(paging({ pageSize: -10 }).pageSize, 1, "负数收敛到 1（0 才回默认值）");
  assert.equal(paging({ pageSize: "abc" }).pageSize, 300);
  assert.equal(paging({ pageSize: 1 }).pageSize, 1);
});

test("paging：可覆盖默认值与上限", () => {
  const pg = paging({}, { defaultSize: 20, maxSize: 50 });
  assert.deepEqual(pg, { page: 1, pageSize: 20, offset: 0 });
  assert.equal(paging({ pageSize: 80 }, { maxSize: 50 }).pageSize, 50);
});

test("pagedResult：页数向上取整且至少 1 页", () => {
  const r = pagedResult([1, 2], 300, { page: 1, pageSize: 50 });
  assert.deepEqual(r, { list: [1, 2], total: 300, page: 1, pageSize: 50, pages: 6 });
  assert.equal(pagedResult([], 0, { page: 1, pageSize: 20 }).pages, 1);
  assert.equal(pagedResult([], 301, { page: 2, pageSize: 100 }).pages, 4);
});
