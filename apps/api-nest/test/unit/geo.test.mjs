// 单元测试：common/geo.ts（距离、电子围栏、脱敏、片区判定）
// 零依赖：node:test + node:assert，直接跑编译产物 dist（避免引入 ts 运行时依赖）
import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm, pointInPolygon, maskPhone, resolveRegion } from "../../dist/common/geo.js";

const HZ = [30.2741, 120.1551]; // 杭州西湖
const SH = [31.2304, 121.4737]; // 上海人民广场

test("haversineKm：同一点距离为 0", () => {
  assert.equal(haversineKm(HZ[0], HZ[1], HZ[0], HZ[1]), 0);
  assert.equal(haversineKm(0, 0, 0, 0), 0);
});

test("haversineKm：1 个纬度约 111.19km", () => {
  const d = haversineKm(30, 120, 31, 120);
  assert.ok(Math.abs(d - 111.19) < 0.05, "实际 " + d);
});

test("haversineKm：杭州→上海约 165km（已知距离）", () => {
  const d = haversineKm(HZ[0], HZ[1], SH[0], SH[1]);
  assert.ok(d > 160 && d < 170, "实际 " + d);
});

test("haversineKm：对称性（A→B 与 B→A 相等）", () => {
  const a = haversineKm(HZ[0], HZ[1], SH[0], SH[1]);
  const b = haversineKm(SH[0], SH[1], HZ[0], HZ[1]);
  assert.ok(Math.abs(a - b) < 1e-9, a + " vs " + b);
});

test("haversineKm：对极点不产生 NaN（asin 参数被夹到 1）", () => {
  const d = haversineKm(0, 0, 0, 180);
  assert.ok(Number.isFinite(d), "非有限值 " + d);
  assert.ok(d > 20000 && d < 20020, "实际 " + d);
});

const SQUARE = [
  [30.0, 120.0],
  [30.0, 120.1],
  [30.1, 120.1],
  [30.1, 120.0],
];

test("pointInPolygon：矩形内/外判定", () => {
  assert.equal(pointInPolygon(30.05, 120.05, SQUARE), true);
  assert.equal(pointInPolygon(30.2, 120.05, SQUARE), false, "北侧在外");
  assert.equal(pointInPolygon(30.05, 120.2, SQUARE), false, "东侧在外");
  assert.equal(pointInPolygon(29.9, 120.05, SQUARE), false, "南侧在外");
});

test("pointInPolygon：退化输入返回 false", () => {
  assert.equal(pointInPolygon(30.05, 120.05, []), false);
  assert.equal(pointInPolygon(30.05, 120.05, [[30, 120], [30.1, 120.1]]), false, "两点不成面");
  assert.equal(pointInPolygon(30.05, 120.05, null), false);
});

test("pointInPolygon：三角形凹口外点不算命中", () => {
  const tri = [
    [30.0, 120.0],
    [30.4, 120.0],
    [30.0, 120.4],
  ];
  assert.equal(pointInPolygon(30.05, 120.05, tri), true);
  assert.equal(pointInPolygon(30.35, 120.35, tri), false, "斜边外侧");
});

test("maskPhone：11 位手机号中间四位脱敏", () => {
  assert.equal(maskPhone("13900000001"), "139****0001");
  assert.equal(maskPhone("13800138000"), "138****8000");
});

test("maskPhone：空值与非常规号码原样/空串", () => {
  assert.equal(maskPhone(undefined), "");
  assert.equal(maskPhone(null), "");
  assert.equal(maskPhone(""), "");
  assert.equal(maskPhone("12345"), "12345", "非 11 位不脱敏");
  assert.equal(maskPhone("+8613900000001"), "+8613900000001", "带国际码不脱敏");
});

const fakeDs = (regions) => ({ query: async () => regions });

test("resolveRegion：点在多边形内优先返回围栏片区", async () => {
  const regions = [
    { id: 1, name: "西湖", center_lat: 30.3, center_lng: 120.1, radius_km: 1, polygon: JSON.stringify(SQUARE) },
    { id: 2, name: "滨江", center_lat: 30.2, center_lng: 120.2, radius_km: 50, polygon: null },
  ];
  const r = await resolveRegion(fakeDs(regions), 30.05, 120.05);
  assert.equal(r && r.id, 1);
});

test("resolveRegion：多边形损坏时退化为中心点+半径，取最近", async () => {
  const regions = [
    { id: 1, name: "坏围栏", center_lat: 30.05, center_lng: 120.05, radius_km: 3, polygon: "{not json" },
    { id: 2, name: "较远", center_lat: 30.0, center_lng: 120.0, radius_km: 200, polygon: null },
  ];
  const r = await resolveRegion(fakeDs(regions), 30.05, 120.05);
  assert.equal(r && r.id, 1, "坏围栏退化为半径判定，且最近");
});

test("resolveRegion：全部超出半径返回 null", async () => {
  const regions = [{ id: 1, name: "西湖", center_lat: 30.3, center_lng: 120.1, radius_km: 1, polygon: null }];
  const r = await resolveRegion(fakeDs(regions), 31.2304, 121.4737);
  assert.equal(r, null);
});
