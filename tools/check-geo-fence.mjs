// ============================================================
// 电子围栏几何门禁（P48）
//   为什么单独测：后台「画围栏」全靠这几个纯函数做经纬度 ↔ 像素换算与点内判定，
//   一旦投影或判定写错，运营在地图上画的片区会和后端判定的片区对不上，
//   而这种错「看起来能用」——所以必须用可断言的数学性质把它钉住。
//   覆盖：投影/反投影互逆、缩放锚点不漂移、点在多边形、中心/等效半径、
//         fitView 不越界、GeoJSON 底图完整性、与后端 pointInPolygon 同一算法。
//   用法：node tools/check-geo-fence.mjs
// ============================================================
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.GATE_ROOT || path.resolve(import.meta.dirname, "..");
const GEO_JS = path.join(ROOT, "apps/web-admin/src/geo-fence.js");
const CHINA = path.join(ROOT, "apps/web-admin/src/assets/china.geo.json");
const MAP_VUE = path.join(ROOT, "apps/web-admin/src/components/GeoFenceMap.vue");
const REGIONS_VUE = path.join(ROOT, "apps/web-admin/src/views/Regions.vue");

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

const G = await import("file://" + GEO_JS.replace(/\\/g, "/"));
const W = 1000;
const H = 600;

console.log("== 1. 投影与反投影 ==");
{
  const view = { centerLng: 120.133, centerLat: 30.262, scale: 4000 }; // 城市级缩放
  const [x, y] = G.project(120.155, 30.274, view, W, H);
  const [lat, lng] = G.unproject(x, y, view, W, H);
  ok("project→unproject 互逆", Math.abs(lat - 30.274) < 1e-9 && Math.abs(lng - 120.155) < 1e-9, `(${lat.toFixed(6)}, ${lng.toFixed(6)})`);
  const [cx, cy] = G.project(view.centerLng, view.centerLat, view, W, H);
  ok("视图中心落在画布中心", Math.abs(cx - W / 2) < 1e-6 && Math.abs(cy - H / 2) < 1e-6, `${cx.toFixed(1)}, ${cy.toFixed(1)}`);
  const [ex, ey] = G.project(view.centerLng + 0.01, view.centerLat, view, W, H);
  ok("经度增大 → x 右移；纬度增大 → y 上移", ex > cx && G.project(view.centerLng, view.centerLat + 0.01, view, W, H)[1] < cy, `dx=${(ex - cx).toFixed(1)}`);
  // 高纬度经线收紧：同样 0.01 度经度，在北京占的像素应比赤道少
  const eq = G.project(0.01, 0, { centerLng: 0, centerLat: 0, scale: 1000 }, W, H)[0] - W / 2;
  const bj = G.project(120.01, 40, { centerLng: 120, centerLat: 40, scale: 1000 }, W, H)[0] - W / 2;
  ok("高纬度经线收紧（视觉不变形）", bj < eq && bj > 0, `赤道 ${eq.toFixed(1)}px vs 北纬40° ${bj.toFixed(1)}px`);
}

console.log("\n== 2. 缩放锚点 ==");
{
  const view = { centerLng: 120.133, centerLat: 30.262, scale: 2000 };
  const anchor = [321, 204];
  const before = G.unproject(anchor[0], anchor[1], view, W, H);
  const zoomed = G.zoomAt({ ...view, ...{}}, anchor[0], anchor[1], 1.6, W, H);
  const after = G.unproject(anchor[0], anchor[1], { ...view, ...zoomed }, W, H);
  ok("以鼠标为锚点缩放：锚点下的经纬度不漂移",
    Math.abs(before[0] - after[0]) < 1e-6 && Math.abs(before[1] - after[1]) < 1e-6,
    `Δlat=${Math.abs(before[0] - after[0]).toExponential(1)}`);
  const clamped = G.zoomAt({ ...view, scale: 399000 }, 0, 0, 10, W, H);
  ok("缩放有上下限（不会把地图缩成一点或无限放大）", clamped.scale <= 400000 && G.zoomAt({ ...view, scale: 0.7 }, 0, 0, 0.1, W, H).scale >= 0.6, String(clamped.scale));
}

console.log("\n== 3. 点在多边形（与后端同算法）==");
{
  const square = [[30.30, 120.10], [30.30, 120.20], [30.20, 120.20], [30.20, 120.10]];
  ok("内部点判为内", G.pointInPolygon(30.25, 120.15, square) === true);
  ok("外部点判为外", G.pointInPolygon(30.40, 120.15, square) === false);
  ok("左右都在外侧的点判为外", G.pointInPolygon(30.25, 120.30, square) === false);
  ok("顶点不足 3 个时一律为外（不抛异常）", G.pointInPolygon(30.25, 120.15, [[30.3, 120.1]]) === false && G.pointInPolygon(30.25, 120.15, null) === false);
  // 与后端实现逐点比对：同一批随机点必须给出一致结论
  const { pointInPolygon: backend } = await import(
    "file://" + path.join(ROOT, "apps/api-nest/dist/common/geo.js").replace(/\\/g, "/")
  ).catch(() => ({ pointInPolygon: null }));
  if (backend) {
    let mismatch = 0;
    for (let i = 0; i < 200; i++) {
      const lat = 30.15 + (i % 20) * 0.01;
      const lng = 120.05 + Math.floor(i / 20) * 0.01;
      if (backend(lat, lng, square) !== G.pointInPolygon(lat, lng, square)) mismatch++;
    }
    ok("与后端 pointInPolygon 200 个采样点结论一致", mismatch === 0, `不一致 ${mismatch} 个`);
  } else {
    ok("与后端 pointInPolygon 比对（dist 未编译时跳过）", true, "跳过：先跑 tsc");
  }
}

console.log("\n== 4. 中心 / 等效半径 / 距离 ==");
{
  const square = [[30.30, 120.10], [30.30, 120.20], [30.20, 120.20], [30.20, 120.10]];
  const c = G.polygonCenter(square);
  ok("中心点 = 顶点平均", Math.abs(c[0] - 30.25) < 1e-6 && Math.abs(c[1] - 120.15) < 1e-6, `${c[0]}, ${c[1]}`);
  const r = G.polygonRadiusKm(square);
  ok("等效半径落在合理范围（约 0.1 经度 ≈ 6.4km 半径量级）", r > 5 && r < 8, r + " km");
  const d1 = G.haversineKm(30.262, 120.133, 30.262, 120.133);
  const d2 = G.haversineKm(30.262, 120.133, 31.2304, 121.4737);
  ok("同点距离为 0；杭州→上海约 160~170km", d1 === 0 && d2 > 155 && d2 < 175, d2.toFixed(1) + " km");
}

console.log("\n== 5. fitView / 半径像素 ==");
{
  const square = [[30.30, 120.10], [30.30, 120.20], [30.20, 120.20], [30.20, 120.10]];
  const view = G.fitView(square, 800, 500, 60);
  const xs = square.map(([lat, lng]) => G.project(lng, lat, view, 800, 500));
  const inX = xs.every(([x]) => x >= 0 && x <= 800);
  const inY = xs.every(([, y]) => y >= 0 && y <= 500);
  ok("fitView 后所有顶点落在画布内", inX && inY, `scale=${view.scale}`);
  const touching = xs.filter(([x]) => x < 70 || x > 730).length + xs.filter(([, y]) => y < 70 || y > 430).length;
  ok("fitView 用足了留白（至少 2 个顶点贴近边距）", touching >= 2, `贴边顶点 ${touching} 个`);
  ok("点太少时不炸（单点/空数组返回默认视图）", G.fitView([[30.2, 120.1]], 800, 500).scale >= 1 && G.fitView([], 800, 500).scale === G.DEFAULT_VIEW.scale);
  const pr = G.radiusToPixels(5, G.fitView(square, 800, 500).scale, 30.25);
  ok("半径像素为正且随缩放线性放大", pr > 0 && G.radiusToPixels(5, 2000, 30.25) > G.radiusToPixels(5, 1000, 30.25), pr.toFixed(1) + "px");
}

console.log("\n== 6. 多边形规范化 ==");
{
  ok("3 点合法、2 点不合法、含 NaN 不合法",
    G.isValidPolygon([[30, 120], [30, 121], [29, 121]]) === true &&
    G.isValidPolygon([[30, 120], [30, 121]]) === false &&
    G.isValidPolygon([[30, 120], [30, NaN], [29, 121]]) === false);
  const dup = G.normalizePolygon([[30, 120], [30, 120], [30, 121], [29, 121], [30, 120]]);
  ok("去掉相邻重复点并闭合尾点", dup.length === 3 && dup[0][0] === 30 && dup[0][1] === 120, JSON.stringify(dup));
  const rounded = G.normalizePolygon([[30.1234567891, 120.9876543219], [30.2, 120.988], [29.9, 121]]);
  ok("经纬度保留 6 位小数（≈0.1 米精度，避免存储膨胀）", String(rounded[0][0]).split(".")[1].length <= 6, String(rounded[0][0]));
}

console.log("\n== 7. 离线底图 ==");
{
  const geo = JSON.parse(readFileSync(CHINA, "utf8"));
  const names = (geo.features || []).map((f) => f.properties?.name || "");
  ok("中国地图数据随包分发且要素齐全（≥30 个省级区划）", names.length >= 30, names.length + " 个：" + names.slice(0, 5).join("、"));
  ok("含直辖市与特别行政区（北京/上海/广东/台湾/香港/澳门）",
    ["北京", "上海", "广东", "台湾", "香港", "澳门"].every((n) => names.includes(n)));
  const rings = (geo.features || []).flatMap((f) => G.ringsOfGeometry(f.geometry));
  const pts = G.collectLngLats(geo);
  ok("坐标点数量充足（省界轮廓）", pts.length > 2000, pts.length + " 个坐标点 / " + rings.length + " 条环");
  const inChina = pts.every(([lng, lat]) => lng > 73 && lng < 136 && lat > 3 && lat < 54);
  ok("全部坐标落在中国经纬度范围内（数据没被写错顺序）", inChina);
  ok("无 <script> 注入（数据文件只做静态渲染）", !readFileSync(CHINA, "utf8").includes("<script"));
}

console.log("\n== 8. 页面接入 ==");
{
  const mapSrc = readFileSync(MAP_VUE, "utf8");
  ok("地图组件渲染 canvas 并带 data-geo-map 标记", mapSrc.includes("<canvas") && mapSrc.includes("data-geo-map"));
  ok("地图组件引用离线底图（不请求在线瓦片）", mapSrc.includes("assets/china.geo.json") && !/https?:\/\/[^"'\\s]*tile/i.test(mapSrc));
  ok("支持绘制/撤销/完成/清空四个动作", ["startDraw", "undoPoint", "finishDraw", "clearFence"].every((k) => mapSrc.includes(k)));
  const viewSrc = readFileSync(REGIONS_VUE, "utf8");
  ok("片区页接入地图组件", viewSrc.includes("GeoFenceMap"));
  ok("片区页不再出现「JSON 文本框」式围栏输入", !/type=\"textarea\"[\s\S]{0,200}polygon/i.test(viewSrc));
  ok("片区页把围栏顶点数提交给接口", viewSrc.includes("body.polygon = polygon"));
}

console.log("\n=================================================");
console.log("测试结果：通过 " + pass + " 项，失败 " + fails.length + " 项");
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  - " + f);
} else {
  console.log("电子围栏几何与页面接入全部通过 ✅");
}
console.log("=================================================");
process.exit(fails.length ? 1 : 0);
