// ============================================================
// 电子围栏几何 + 行政区数据集门禁（P48 / P49）
//   为什么单独测：后台「画围栏 / 选行政区」全靠这几个纯函数做经纬度 ↔ 像素换算与点内判定，
//   一旦投影或判定写错，运营在地图上画的片区会和后端判定的片区对不上，
//   而这种错「看起来能用」——所以必须用可断言的数学性质把它钉住。
//   覆盖：Mercator 投影与等角性、缩放锚点、点内判定（单环/多环）、瓦片对齐、
//         离线底图完整性、行政区数据集、与后端实现的逐点一致性、页面接入。
//   用法：node tools/check-geo-fence.mjs
// ============================================================
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.GATE_ROOT || path.resolve(import.meta.dirname, "..");
const GEO_JS = path.join(ROOT, "apps/web-admin/src/geo-fence.js");
const CHINA = path.join(ROOT, "apps/web-admin/src/assets/china.geo.json");
const AREAS = path.join(ROOT, "apps/api-nest/db/admin-areas.json");
const MAP_VUE = path.join(ROOT, "apps/web-admin/src/components/GeoFenceMap.vue");
const REGIONS_VUE = path.join(ROOT, "apps/web-admin/src/views/Regions.vue");
const NEST_SVC = path.join(ROOT, "apps/api-nest/src/admin/admin-ops.service.ts");
const NEST_AREAS = path.join(ROOT, "apps/api-nest/src/common/admin-areas.ts");
const REF_ADMIN = path.join(ROOT, "server/modules/admin.js");

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
const dist = (a, b) => Math.abs(a - b);

console.log("== 1. 投影（Web Mercator，与在线瓦片同一套）==");
{
  const view = { centerLng: 120.133, centerLat: 30.262, scale: 4000 };
  const [x, y] = G.project(120.155, 30.274, view, W, H);
  const [lat, lng] = G.unproject(x, y, view, W, H);
  ok("project→unproject 互逆", dist(lat, 30.274) < 1e-9 && dist(lng, 120.155) < 1e-9, `(${lat.toFixed(6)}, ${lng.toFixed(6)})`);
  const [cx, cy] = G.project(view.centerLng, view.centerLat, view, W, H);
  ok("视图中心落在画布中心", dist(cx, W / 2) < 1e-6 && dist(cy, H / 2) < 1e-6, `${cx.toFixed(1)}, ${cy.toFixed(1)}`);
  ok("经度增大 → x 右移；纬度增大 → y 上移",
    G.project(120.16, 30.262, view, W, H)[0] > cx && G.project(120.133, 30.30, view, W, H)[1] < cy);
  // 等角性：北纬 40° 处 1 度纬度占的像素 / 1 度经度占的像素 ≈ 1/cos(40°)
  const v40 = { centerLng: 120, centerLat: 40, scale: 1000 };
  const pxLng40 = G.project(121, 40, v40, W, H)[0] - G.project(120, 40, v40, W, H)[0];
  const pxLat40 = G.project(120, 40, v40, W, H)[1] - G.project(120, 41, v40, W, H)[1];
  const ratio40 = pxLat40 / pxLng40;
  const ideal40 = 1 / Math.cos((40 * Math.PI) / 180);
  ok("Mercator 等角：40°N 纬度/经度像素比 = 1/cos(40°)",
    dist(ratio40, ideal40) < 0.01, `${ratio40.toFixed(4)} vs ${ideal40.toFixed(4)}`);
  const v0 = { centerLng: 0, centerLat: 0, scale: 1000 };
  const pxLng0 = G.project(1, 0, v0, W, H)[0] - W / 2;
  const pxLat0 = H / 2 - G.project(0, 1, v0, W, H)[1];
  ok("赤道处经纬度像素等长（等角投影的起点，Mercator 对 1° 有 ~1e-4 的三阶修正）",
    dist(pxLng0, pxLat0) / pxLng0 < 1e-3, `${pxLng0.toFixed(4)} / ${pxLat0.toFixed(4)}`);
  ok("超过 ±85.05° 的纬度被夹住（瓦片只覆盖到这里）",
    G.invMercY(G.mercY(89)) <= 85.06 && G.invMercY(G.mercY(-89)) >= -85.06);
}

console.log("\n== 2. 缩放锚点 ==");
{
  const view = { centerLng: 120.133, centerLat: 30.262, scale: 2000 };
  const [ax, ay] = [321, 204];
  const before = G.unproject(ax, ay, view, W, H);
  const zoomed = G.zoomAt(view, ax, ay, 1.6, W, H);
  const after = G.unproject(ax, ay, { ...view, ...zoomed }, W, H);
  ok("以鼠标为锚点缩放：锚点下的经纬度不漂移",
    dist(before[0], after[0]) < 1e-6 && dist(before[1], after[1]) < 1e-6,
    `Δlat=${dist(before[0], after[0]).toExponential(1)}`);
  ok("缩放有上下限", G.zoomAt({ ...view, scale: 399000 }, 0, 0, 10, W, H).scale <= 400000 &&
    G.zoomAt({ ...view, scale: 0.7 }, 0, 0, 0.1, W, H).scale >= 0.6);
}

console.log("\n== 3. 点在围栏内（单环 / 多环）==");
{
  const square = [[30.30, 120.10], [30.30, 120.20], [30.20, 120.20], [30.20, 120.10]];
  ok("内部点判为内", G.pointInPolygon(30.25, 120.15, square) === true);
  ok("外部点判为外", G.pointInPolygon(30.40, 120.15, square) === false);
  ok("顶点不足 3 个时为外（不抛异常）", G.pointInPolygon(30.25, 120.15, [[30.3, 120.1]]) === false && G.pointInPolygon(30.25, 120.15, null) === false);
  ok("单环被识别成 1 个环", G.ringsOfPolygon(square).length === 1);
  const twoRings = [square, [[31.30, 121.10], [31.30, 121.20], [31.20, 121.20], [31.20, 121.10]]];
  ok("多环被识别成 2 个环", G.ringsOfPolygon(twoRings).length === 2);
  ok("多环围栏：落在任意一环内都算命中",
    G.pointInAnyRing(30.25, 120.15, twoRings) && G.pointInAnyRing(31.25, 121.15, twoRings));
  ok("多环围栏：两环之外判为外", G.pointInAnyRing(32.0, 122.0, twoRings) === false);
  const { pointInPolygon: backend, pointInAnyRing: backendAny } = await import(
    "file://" + path.join(ROOT, "apps/api-nest/dist/common/geo.js").replace(/\\/g, "/")
  ).catch(() => ({ pointInPolygon: null, pointInAnyRing: null }));
  if (backend) {
    let mismatch = 0;
    for (let i = 0; i < 200; i++) {
      const lat = 30.15 + (i % 20) * 0.01;
      const lng = 120.05 + Math.floor(i / 20) * 0.01;
      if (backend(lat, lng, square) !== G.pointInPolygon(lat, lng, square)) mismatch++;
    }
    ok("与后端 pointInPolygon 200 个采样点结论一致", mismatch === 0, `不一致 ${mismatch} 个`);
    let mismatch2 = 0;
    for (let i = 0; i < 200; i++) {
      const lat = 30.05 + (i % 20) * 0.02;
      const lng = 119.95 + Math.floor(i / 20) * 0.02;
      if (backendAny(lat, lng, twoRings) !== G.pointInAnyRing(lat, lng, twoRings)) mismatch2++;
    }
    ok("与后端 pointInAnyRing 200 个采样点结论一致（多环）", mismatch2 === 0, `不一致 ${mismatch2} 个`);
  } else {
    ok("与后端比对（dist 未编译时跳过）", false, "跳过：先跑 tsc");
  }
}

console.log("\n== 4. 中心 / 等效半径 / 距离 ==");
{
  const square = [[30.30, 120.10], [30.30, 120.20], [30.20, 120.20], [30.20, 120.10]];
  const c = G.polygonCenter(square);
  ok("中心点 = 顶点平均", dist(c[0], 30.25) < 1e-6 && dist(c[1], 120.15) < 1e-6, `${c[0]}, ${c[1]}`);
  const r = G.polygonRadiusKm(square);
  ok("等效半径落在合理范围", r > 5 && r < 8, r + " km");
  const d2 = G.haversineKm(30.262, 120.133, 31.2304, 121.4737);
  ok("杭州→上海约 160~175km", d2 > 155 && d2 < 175, d2.toFixed(1) + " km");
  const twoRings = [square, [[31.30, 121.10], [31.30, 121.20], [31.20, 121.20], [31.20, 121.10]]];
  const c2 = G.polygonCenter(twoRings);
  ok("多环中心取最大环（不被远端小环拉偏）", dist(c2[0], 30.25) < 1e-6, `${c2[0]}, ${c2[1]}`);
}

console.log("\n== 5. fitView / 半径像素 ==");
{
  const square = [[30.30, 120.10], [30.30, 120.20], [30.20, 120.20], [30.20, 120.10]];
  const view = G.fitView(square, 800, 500, 60);
  const pts = square.map(([lat, lng]) => G.project(lng, lat, view, 800, 500));
  const inside = pts.every(([x, y]) => x >= -0.5 && x <= 800.5 && y >= -0.5 && y <= 500.5);
  ok("fitView 后所有顶点落在画布内", inside, `scale=${view.scale}`);
  const touching = pts.filter(([x]) => x < 70 || x > 730).length + pts.filter(([, y]) => y < 70 || y > 430).length;
  ok("fitView 用足了留白（至少 2 个顶点贴近边距）", touching >= 2, `贴边顶点 ${touching} 个`);
  ok("点太少时不炸", G.fitView([[30.2, 120.1]], 800, 500).scale >= 0.6 && G.fitView([], 800, 500).scale === G.DEFAULT_VIEW.scale);
  const a = G.radiusToPixels(5, 2000, 30);
  const b = G.radiusToPixels(5, 2000, 45);
  ok("半径像素随缩放线性放大", G.radiusToPixels(5, 4000, 30) > a && a > 0, a.toFixed(1) + "px");
  ok("Mercator 下半径像素与纬度无关（等角投影）", dist(a, b) < 1e-6, `${a.toFixed(2)} vs ${b.toFixed(2)}`);
}

console.log("\n== 6. 多边形规范化（单环 / 多环）==");
{
  ok("3 点合法、2 点不合法、含 NaN 不合法",
    G.isValidPolygon([[30, 120], [30, 121], [29, 121]]) === true &&
    G.isValidPolygon([[30, 120], [30, 121]]) === false &&
    G.isValidPolygon([[30, 120], [30, NaN], [29, 121]]) === false);
  const dup = G.normalizePolygon([[30, 120], [30, 120], [30, 121], [29, 121], [30, 120]]);
  ok("单环：去重并去掉闭合尾点", dup.length === 3 && dup[0][0] === 30, JSON.stringify(dup));
  const multi = G.normalizePolygon([[[30, 120], [30, 121], [29, 121]], [[31, 121], [31, 122], [30, 122]]]);
  ok("多环：保持环数组结构", Array.isArray(multi) && multi.length === 2 && Array.isArray(multi[0][0]), `${multi.length} 环`);
  const frac = G.normalizePolygon([[[30.1234567891, 120.9876543219], [30.2, 120.988], [29.9, 121]]]);
  ok("经纬度最多 6 位小数（≈0.1 米精度）", String(frac[0][0][0]).split(".")[1].length <= 6, String(frac[0][0][0]));
  // 回归：绘制中的 1~2 个点必须留住（曾经被当成「非法环」丢掉，导致怎么点都画不出线）
  ok("绘制中不足 3 点的围栏不会被规范化丢掉",
    G.normalizePolygon([[30.1, 120.1]]).length === 1 && G.normalizePolygon([[30.1, 120.1], [30.2, 120.2]]).length === 2,
    "单点仍保留：" + G.normalizePolygon([[30.1, 120.1]]).length + " 点");
  ok("不足 3 点的围栏仍然「不合法」（交给 isValidPolygon 把关）",
    G.isValidPolygon([[30.1, 120.1], [30.2, 120.2]]) === false);
}

console.log("\n== 7. 在线瓦片（XYZ 切片，与投影对齐）==");
{
  const z = 10;
  ok("scale ↔ 瓦片级别互逆", dist(G.scaleForTileZoom(z), 256 * 2 ** z / 360) < 1e-9 &&
    G.tileZoomForScale(G.scaleForTileZoom(z)) === z, `z=${z} → scale=${G.scaleForTileZoom(z).toFixed(2)}`);
  const lng = 120.155;
  const lat = 30.274;
  const [tx, ty] = G.tileXY(lng, lat, z);
  const tile = { z, x: Math.floor(tx), y: Math.floor(ty) };
  const b = G.tileBounds(tile.z, tile.x, tile.y);
  ok("瓦片四至包含该点（tileXY 与 tileBounds 一致）",
    lng >= b.west && lng <= b.east && lat <= b.north && lat >= b.south,
    `${b.west.toFixed(3)}~${b.east.toFixed(3)} / ${b.south.toFixed(3)}~${b.north.toFixed(3)}`);
  // 对齐性：瓦片矩形投影后必须是「正矩形」，且边长等于 256×缩放系数
  const view = { centerLng: lng, centerLat: lat, scale: G.scaleForTileZoom(z) };
  const [x0, y0] = G.project(b.west, b.north, view, 1000, 600);
  const [x1, y1] = G.project(b.east, b.south, view, 1000, 600);
  ok("瓦片投影后是 256×256 的正矩形（贴图不用变形）",
    dist(x1 - x0, 256) < 0.01 && dist(y1 - y0, 256) < 0.01,
    `${(x1 - x0).toFixed(2)} × ${(y1 - y0).toFixed(2)}`);
  const view2 = { centerLng: lng, centerLat: lat, scale: 1500 };
  const tiles = G.visibleTiles(view2, 1000, 600, G.tileZoomForScale(1500));
  const zz = G.tileZoomForScale(1500);
  const [cx, cy] = G.tileXY(lng, lat, zz);
  ok("visibleTiles 覆盖当前中心瓦片", tiles.some((t) => t.x === Math.floor(cx) && t.y === Math.floor(cy)), `${tiles.length} 块`);
  ok("visibleTiles 数量有界（不会把全球都拉进来）", tiles.length > 0 && tiles.length < 200, tiles.length + " 块");
}

console.log("\n== 8. 离线底图 ==");
{
  const geo = JSON.parse(readFileSync(CHINA, "utf8"));
  const names = (geo.features || []).map((f) => f.properties?.name || "");
  ok("中国地图数据随包分发且要素齐全", names.length >= 30, names.length + " 个省级区划");
  ok("含直辖市与特别行政区", ["北京", "上海", "广东", "台湾", "香港", "澳门"].every((n) => names.includes(n)));
  const pts = G.collectLngLats(geo);
  ok("坐标点数量充足", pts.length > 2000, pts.length + " 个坐标点");
  ok("全部坐标落在中国经纬度范围内", pts.every(([lng, lat]) => lng > 73 && lng < 136 && lat > 3 && lat < 54));
}

console.log("\n== 9. 行政区数据集（按行政区设置）==");
{
  ok("数据集文件存在（由 tools/build-admin-areas.mjs 生成）", existsSync(AREAS), path.relative(ROOT, AREAS));
  const areas = existsSync(AREAS) ? JSON.parse(readFileSync(AREAS, "utf8")) : [];
  const levels = {};
  for (const a of areas) levels[a.level] = (levels[a.level] || 0) + 1;
  ok("含省级 / 地级市 / 区县三级", (levels.province || 0) >= 30 && (levels.city || 0) >= 300 && (levels.district || 0) >= 5,
    JSON.stringify(levels));
  const names = new Set(areas.map((a) => a.name));
  ok("含截图示例「张北县」与演示城市「杭州市」", names.has("张北县") && names.has("杭州市"));
  const bad = areas.filter((a) => !Array.isArray(a.rings) || !a.rings.length || !Array.isArray(a.center));
  ok("每个行政区都有边界环与中心点", bad.length === 0, bad.length ? "缺失 " + bad.length : "");
  const outRange = areas.some((a) => a.rings.some((r) => r.some(([lng, lat]) => !(lng > 73 && lng < 136 && lat > 3 && lat < 54))));
  ok("边界坐标全部在中国范围内（没把经纬度写反）", !outRange);
  ok("数据体积可控（随包分发，不拖慢启动）", readFileSync(AREAS).length < 4 * 1024 * 1024,
    Math.round(readFileSync(AREAS).length / 1024) + " KB");

  // 与后端实现比对：搜索命中、围栏拼装、adcode 缺失处理
  const backendAreas = await import(
    "file://" + path.join(ROOT, "apps/api-nest/dist/common/admin-areas.js").replace(/\\/g, "/")
  ).catch(() => null);
  if (backendAreas) {
    const hit = backendAreas.searchAreas("张北", 5);
    ok("后端搜索「张北」命中张北县", hit.length > 0 && hit[0].name === "张北县", hit.map((a) => a.name).join(","));
    const hitHz = backendAreas.searchAreas("杭州", 20);
    ok("后端搜索「杭州」把杭州市排在前面", hitHz[0]?.name === "杭州市", hitHz.map((a) => a.name).join(","));
    ok("搜城市会展开已收录的下级区县（输入「杭州」能点到西湖区）",
      hitHz.some((a) => a.name === "西湖区") && hitHz.some((a) => a.name === "滨江区"), `${hitHz.length} 个候选`);
    const fence = backendAreas.fenceFromCodes(["130722"]);
    ok("按 adcode 拼出的围栏非空且中心在张北附近",
      !!fence && fence.rings.length > 0 && dist(fence.center[0], 41.15) < 0.6 && dist(fence.center[1], 114.7) < 0.6,
      fence ? `${fence.rings.length} 环 / ${fence.points} 点 / 中心 ${fence.center[0].toFixed(3)},${fence.center[1].toFixed(3)}` : "null");
    const missing = backendAreas.fenceFromCodes(["130722", "999999"]);
    ok("未收录的 adcode 被标出来（不静默吞掉）", missing && missing.missing.length === 1 && missing.missing[0] === 999999);
    const nested = backendAreas.fenceFromCodes([330100, 330106]);
    ok("同时选上级与下级时只按上级建围栏（西湖区是杭州市的子集）",
      nested && nested.codes.length === 1 && nested.codes[0] === 330100 && nested.names[0] === "杭州市",
      nested ? nested.names.join("、") : "null");
    const st = backendAreas.adminAreasStatus();
    ok("后端数据集状态与文件条数一致", st.count === areas.length, `${st.count} / ${areas.length}`);
  } else {
    ok("后端 admin-areas 比对（dist 未编译时跳过）", false, "跳过：先跑 tsc");
  }
}

console.log("\n== 10. 页面与服务端接入 ==");
{
  const mapSrc = readFileSync(MAP_VUE, "utf8");
  ok("地图组件渲染 canvas 并带 data-geo-map 标记", mapSrc.includes("<canvas") && mapSrc.includes("data-geo-map"));
  ok("支持在线瓦片底图（{z}/{x}/{y} 模板 + 子域）", mapSrc.includes("{z}") && mapSrc.includes("{x}") && mapSrc.includes("{y}") && mapSrc.includes("VITE_TILE_URL"));
  ok("瓦片不可达时自动回落离线省级底图", mapSrc.includes("china.geo.json") && mapSrc.includes("tileStat.available === false") && mapSrc.includes("drawOfflineBasemap"));
  ok("支持多环围栏绘制（ringsOfPolygon）", mapSrc.includes("ringsOfPolygon"));
  ok("支持行政区高亮（highlights 属性）", mapSrc.includes("highlights"));
  ok("支持绘制/撤销/完成/清空四个动作", ["startDraw", "undoPoint", "finishDraw", "clearFence"].every((k) => mapSrc.includes(k)));

  const viewSrc = readFileSync(REGIONS_VUE, "utf8");
  ok("片区页接入地图组件", viewSrc.includes("GeoFenceMap"));
  ok("片区页有两种设置方式（按地图 / 按行政区）", viewSrc.includes("按地图设置") && viewSrc.includes("按行政区设置"));
  ok("按行政区设置：地名输入 + 搜索按钮 + 候选勾选", viewSrc.includes("area-query") && viewSrc.includes("area-search") && viewSrc.includes("el-checkbox-group"));
  ok("按行政区设置：提交 adminCodes 给接口", /body\.adminCodes\s*=/.test(viewSrc));
  ok("片区页不再出现「JSON 文本框」式围栏输入", !/type="textarea"[\s\S]{0,200}polygon/i.test(viewSrc));

  const svcSrc = readFileSync(NEST_SVC, "utf8");
  ok("服务端 createRegion 支持 adminCodes（围栏=边界并集）", svcSrc.includes("fenceFromCodes") && svcSrc.includes("admin_codes"));
  ok("服务端列表回显行政区名（adminNames）", svcSrc.includes("adminNames"));
  const areasSrc = readFileSync(NEST_AREAS, "utf8");
  ok("服务端行政区加载器把 [lng,lat] 转成 [lat,lng]", areasSrc.includes("[lng, lat]") || areasSrc.includes("ring.map"));
  const refSrc = readFileSync(REF_ADMIN, "utf8");
  ok("参考实现同步了行政区接口与 adminCodes", refSrc.includes("/api/admin/regions/areas") && refSrc.includes("adminCodes"));
}

console.log("\n=================================================");
console.log("测试结果：通过 " + pass + " 项，失败 " + fails.length + " 项");
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  - " + f);
} else {
  console.log("电子围栏几何、瓦片对齐与行政区数据集全部通过 ✅");
}
console.log("=================================================");
process.exit(fails.length ? 1 : 0);
