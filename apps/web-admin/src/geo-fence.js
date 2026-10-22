/**
 * 电子围栏与地图投影的纯几何工具（不依赖 Vue / DOM，便于被门禁直接 import 测试）。
 *
 * 坐标约定（与后端一致）：一律用 `[lat, lng]` 表示一个点；
 * GeoJSON / 瓦片相关函数用 `[lng, lat]`（与 GeoJSON 规范一致），转换只在本文件内部做。
 *
 * 投影：Web Mercator（球面墨卡托，与高德/美团/OSM 的在线瓦片同一套）。
 * 为什么必须是 Mercator 而不是「等距圆柱」：
 *   - 在线瓦片是 Mercator 切片，画布用同一投影才能把瓦片贴得严丝合缝（不需要逐瓦片变形）；
 *   - Mercator 是等角投影，小范围里东西向与南北向比例一致，围栏画出来不会「横着变胖」；
 *   - 代价是高纬面积放大，但围栏判定用经纬度算（`pointInPolygon` / haversine），与显示无关。
 *
 * 比例尺 `scale` 的定义：**每 1 度经度对应多少像素**（横向严格线性，纵向按 Mercator 拉伸）。
 */

/** 世界视图：以 (centerLng, centerLat) 为屏幕中心，scale = 每度经度对应多少像素 */
export const DEFAULT_VIEW = { centerLng: 108, centerLat: 34, scale: 6 };

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
/** Mercator 有效纬度（瓦片只覆盖 ±85.0511°） */
export const MAX_LAT = 85.05112878;
/** 1 度纬度 = 111.32 km（球面近似，城市尺度误差 <0.3%） */
const KM_PER_DEG_LAT = 111.32;
const MIN_SCALE = 0.6;
const MAX_SCALE = 400000;

const clampScale = (s) => Math.min(Math.max(Number(s) || MIN_SCALE, MIN_SCALE), MAX_SCALE);
const clampLat = (lat) => Math.min(MAX_LAT, Math.max(-MAX_LAT, Number(lat) || 0));
export { MIN_SCALE, MAX_SCALE };

/** 纬度 → Mercator 纵坐标（单位：度，与经度同一量纲，便于和 scale 直接相乘） */
export function mercY(lat) {
  const l = clampLat(lat) * DEG;
  return Math.log(Math.tan(Math.PI / 4 + l / 2)) * RAD;
}

/** Mercator 纵坐标（度）→ 纬度 */
export function invMercY(y) {
  return (Math.atan(Math.exp(Number(y) * DEG)) - Math.PI / 4) * 2 * RAD;
}

/** 纵向比例尺：每度「Mercator 纵坐标」占多少像素（横向同值） */
export function latScale(scale) {
  return Number(scale) || 0;
}

/**
 * 地面距离系数：同样 1 度经度，在地面只有赤道的 cos(lat) 倍长。
 * 只用于「比例尺/公里换算」这类地面量，**不参与投影**（Mercator 已自带等角特性）。
 */
export function lngFactor(lat) {
  return Math.max(0.15, Math.cos(clampLat(lat) * DEG));
}

/** [lng, lat] → 像素坐标 */
export function project(lng, lat, view, width, height) {
  const x = width / 2 + (Number(lng) - view.centerLng) * view.scale;
  const y = height / 2 - (mercY(lat) - mercY(view.centerLat)) * view.scale;
  return [x, y];
}

/** 像素坐标 → [lat, lng] */
export function unproject(x, y, view, width, height) {
  const lng = view.centerLng + (Number(x) - width / 2) / view.scale;
  const lat = invMercY(mercY(view.centerLat) + (height / 2 - Number(y)) / view.scale);
  return [lat, lng];
}

/** 射线法：点是否在多边形内（与后端 common/geo.ts 的 pointInPolygon 同一算法） */
export function pointInPolygon(lat, lng, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 围栏可能是「单环」[[lat,lng],...] 或「多环」（按行政区拼出来）[[[lat,lng],...],...]。
 * 这里统一成环数组，后续绘制与判定都只处理环数组。
 */
export function ringsOfPolygon(polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return [];
  const first = polygon[0];
  if (!Array.isArray(first) || !first.length) return [];
  // 单环：第一个元素是 [lat,lng]（两个数字）
  if (typeof first[0] === "number") return [polygon];
  return polygon.filter((r) => Array.isArray(r) && r.length >= 1);
}

/** 点是否落在任一环内（多环围栏 = 多个行政区/多个地块的并集） */
export function pointInAnyRing(lat, lng, polygon) {
  for (const ring of ringsOfPolygon(polygon)) if (pointInPolygon(lat, lng, ring)) return true;
  return false;
}

/** 顶点平均（当作围栏中心点足够用；真正几何形心对运营没有额外价值） */
export function polygonCenter(polygon) {
  const rings = ringsOfPolygon(polygon);
  if (!rings.length) return null;
  // 取点数最多（≈面积最大）的那一环算中心，避免多环时被小岛拉偏
  const ring = rings.reduce((a, b) => (b.length > a.length ? b : a), rings[0]);
  const sum = ring.reduce((a, [lat, lng]) => [a[0] + Number(lat), a[1] + Number(lng)], [0, 0]);
  return [Number((sum[0] / ring.length).toFixed(6)), Number((sum[1] / ring.length).toFixed(6))];
}

/** 多边形顶点到中心的「等效半径」(km)，给圆形兜底用 */
export function polygonRadiusKm(polygon) {
  const c = polygonCenter(polygon);
  if (!c) return 0;
  let max = 0;
  for (const ring of ringsOfPolygon(polygon)) {
    for (const [lat, lng] of ring) max = Math.max(max, haversineKm(c[0], c[1], lat, lng));
  }
  return Number(max.toFixed(2));
}

/** 两个经纬度之间的距离（km），与后端 haversineKm 同一公式 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const dLat = (Number(lat2) - Number(lat1)) * DEG;
  const dLng = (Number(lng2) - Number(lng1)) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(Number(lat1) * DEG) * Math.cos(Number(lat2) * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 让一组点（通常是刚画好的围栏 / 选中的行政区）刚好铺满视口。
 * 返回新的 view；点不足 2 个时只居中不缩放。
 */
export function fitView(points, width, height, padding = 60) {
  const pts = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])));
  if (!pts.length || width <= 0 || height <= 0) return { ...DEFAULT_VIEW };
  const lats = pts.map((p) => Number(p[0]));
  const lngs = pts.map((p) => Number(p[1]));
  const mercs = lats.map(mercY);
  const centerLat = invMercY((Math.min(...mercs) + Math.max(...mercs)) / 2);
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  // 单点（或一条线）时给一个下限跨度，避免放大到天文数字
  const spanLng = Math.max(1e-4, Math.max(...lngs) - Math.min(...lngs));
  const spanMerc = Math.max(1e-4, Math.max(...mercs) - Math.min(...mercs));
  const usableW = Math.max(40, width - padding * 2);
  const usableH = Math.max(40, height - padding * 2);
  const scale = Math.min(usableW / spanLng, usableH / spanMerc);
  return { centerLng, centerLat, scale: Number(clampScale(scale).toFixed(4)) };
}

/** 以某个像素点为锚点缩放（滚轮缩放时鼠标下的位置保持不动） */
export function zoomAt(view, x, y, factor, width, height) {
  const before = unproject(x, y, view, width, height);
  const scale = clampScale(view.scale * factor);
  // 横向线性可一次解出；纵向经 Mercator，反解也要走一次逆变换（下面统一写成两轮收敛）
  let next = { centerLng: view.centerLng, centerLat: view.centerLat, scale };
  for (let i = 0; i < 2; i++) {
    const after = unproject(x, y, next, width, height);
    next = {
      scale,
      centerLng: next.centerLng + (before[1] - after[1]),
      centerLat: invMercY(mercY(next.centerLat) + (mercY(before[0]) - mercY(after[0]))),
    };
  }
  return {
    scale,
    centerLng: Number(next.centerLng.toFixed(6)),
    centerLat: Number(next.centerLat.toFixed(6)),
  };
}

/**
 * 圆心 + 半径(km) → 屏幕半径像素。
 * Mercator 在中心纬度处的局部比例：1 度经度 = KM_PER_DEG_LAT×cos(lat) 公里、占 scale 像素，
 * 所以每像素 = KM_PER_DEG_LAT/scale 公里，与圆心纬度无关（等角投影的好处）。
 */
export function radiusToPixels(radiusKm, scale, _lat) {
  return (Number(radiusKm) / KM_PER_DEG_LAT) * Number(scale || 0);
}

/* ---------------- 在线瓦片（XYZ 切片） ---------------- */

/** 让 scale 与某个整数瓦片级别最接近（瓦片 256px 覆盖 360°：scale = 256×2^z/360） */
export function tileZoomForScale(scale, min = 3, max = 18) {
  const z = Math.round(Math.log2((Number(scale) * 360) / 256));
  return Math.min(max, Math.max(min, z));
}

/** 某个瓦片级别对应的 scale（每度经度像素数） */
export function scaleForTileZoom(z) {
  return (256 * 2 ** Number(z)) / 360;
}

/** [lng,lat] → 该级别下的浮点瓦片坐标 */
export function tileXY(lng, lat, z) {
  const n = 2 ** Number(z);
  const x = ((Number(lng) + 180) / 360) * n;
  const y = ((1 - mercY(lat) / 180) / 2) * n;
  return [x, y];
}

/** 瓦片 (z,x,y) → 四至（度） */
export function tileBounds(z, x, y) {
  const n = 2 ** Number(z);
  return {
    west: (Number(x) / n) * 360 - 180,
    east: ((Number(x) + 1) / n) * 360 - 180,
    north: invMercY(180 * (1 - (2 * Number(y)) / n)),
    south: invMercY(180 * (1 - (2 * (Number(y) + 1)) / n)),
  };
}

/** 当前视图需要哪些瓦片（含 1 圈冗余，避免拖拽时露白） */
export function visibleTiles(view, width, height, z) {
  const factor = view.scale / scaleForTileZoom(z); // 每块瓦片在屏幕上的像素 = 256 × factor
  const [x0, y0] = tileXY(view.centerLng, view.centerLat, z);
  const halfW = width / (512 * factor);
  const halfH = height / (512 * factor);
  const n = 2 ** z;
  const out = [];
  for (let x = Math.floor(x0 - halfW) - 1; x <= Math.ceil(x0 + halfW) + 1; x++) {
    for (let y = Math.floor(y0 - halfH) - 1; y <= Math.ceil(y0 + halfH) + 1; y++) {
      if (y < 0 || y >= n) continue;
      out.push({ z, x: ((x % n) + n) % n, y });
    }
  }
  return out;
}

// ---- GeoJSON 预投影：把省界一次性投成像素路径，避免每帧重复算经纬度 ----

/** 把 GeoJSON LineString/Polygon 的坐标展开成若干条 [lng,lat] 环 */
export function ringsOfGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

/** 取一个 FeatureCollection 的全部经纬度点（用于初始 fit） */
export function collectLngLats(geoJson) {
  const out = [];
  for (const f of (geoJson && geoJson.features) || []) {
    for (const ring of ringsOfGeometry(f.geometry)) {
      for (const [lng, lat] of ring) out.push([lng, lat]);
    }
  }
  return out;
}

/** 多边形是否合法（≥3 点、数值有效、不自交不校验——运营画的自交围栏由后端按射线法容忍） */
export function isValidPolygon(polygon) {
  const rings = ringsOfPolygon(polygon);
  if (!rings.length) return false;
  return rings.every(
    (ring) =>
      ring.length >= 3 &&
      ring.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))),
  );
}

/** 规范化：保留 6 位小数（约 0.1 米精度），去掉重复的相邻点与闭合尾点 */
export function normalizeRing(ring) {
  const out = [];
  for (const p of ring || []) {
    const lat = Number(Number(p[0]).toFixed(6));
    const lng = Number(Number(p[1]).toFixed(6));
    const last = out[out.length - 1];
    if (last && last[0] === lat && last[1] === lng) continue;
    out.push([lat, lng]);
  }
  if (out.length > 1) {
    const [f0, f1] = out[0];
    const [l0, l1] = out[out.length - 1];
    if (f0 === l0 && f1 === l1) out.pop();
  }
  return out;
}

/** 规范化多边形：单环就返回单环数组，多环返回环数组（保持输入形状） */
export function normalizePolygon(polygon) {
  // 注意：这里只「规整数据」，**不做合法性过滤**——绘制过程中只有 1~2 个点时也必须留住，
  // 否则每落一个点就被当成非法环丢掉，用户会发现「怎么点都画不出线」。合法性交给 isValidPolygon。
  const rings = ringsOfPolygon(polygon).map(normalizeRing).filter((r) => r.length > 0);
  if (!rings.length) return [];
  const single = Array.isArray(polygon) && polygon.length && typeof polygon[0][0] === "number";
  return single ? rings[0] : rings;
}
