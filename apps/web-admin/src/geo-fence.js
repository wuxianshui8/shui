/**
 * 电子围栏的纯几何工具（不带任何 Vue / DOM 依赖，便于被门禁直接 import 测试）。
 *
 * 坐标约定（与后端一致）：一律用 `[lat, lng]` 表示一个点；
 * GeoJSON 里是 `[lng, lat]`，转换只在本文件内部做，对外不暴露顺序歧义。
 *
 * 投影：等距圆柱投影（x ∝ lng·cos(lat0), y ∝ -lat），lat0 = 视图中心纬度。
 * 为什么横向要乘 cos(lat0)：同样 1 度经度，在北纬 40° 的实际东西向距离只有赤道的
 * cos(40°) ≈ 0.77 倍。不压缩的话，画出来的围栏会被横向拉长一成多，看起来是「斜的」，
 * 运营就会以为围栏画歪了。lat0 在视图内是常量，所以 lng/lat ↔ 像素仍是线性、可逆的，
 * 屏幕上点哪就是哪，不需要反解。
 */

/** 世界视图：以 (centerLng, centerLat) 为屏幕中心，scale = 每度纬度对应多少像素 */
export const DEFAULT_VIEW = { centerLng: 108, centerLat: 34, scale: 5 };

const DEG = Math.PI / 180;

/** 1 度纬度 = 111.32 km（球面近似，城市尺度误差 <0.3%） */
const KM_PER_DEG_LAT = 111.32;

/** 缩放上下限：0.6 ≈ 整个中国缩成 200px；400000 ≈ 1 像素 0.3 米 */
const MIN_SCALE = 0.6;
const MAX_SCALE = 400000;

/** 纵向比例尺：每度纬度占多少像素（等距圆柱，竖直方向逐度均匀） */
export function latScale(scale) {
  return Number(scale) || 0;
}

/**
 * 横向压缩系数：同一度经度在高纬度的实际距离更短（×cos(lat)）。
 * 用视图中心纬度算一次、整个视图统一使用，保证 lng/lat ↔ 像素仍互为线性、可逆。
 */
export function lngFactor(centerLat) {
  return Math.max(0.15, Math.cos(Number(centerLat || 0) * DEG));
}

const clampScale = (s) => Math.min(Math.max(Number(s) || MIN_SCALE, MIN_SCALE), MAX_SCALE);
export { MIN_SCALE, MAX_SCALE };

/** [lng, lat] → 像素坐标 */
export function project(lng, lat, view, width, height) {
  const x = width / 2 + (Number(lng) - view.centerLng) * view.scale * lngFactor(view.centerLat);
  const y = height / 2 - (Number(lat) - view.centerLat) * view.scale;
  return [x, y];
}

/** 像素坐标 → [lat, lng] */
export function unproject(x, y, view, width, height) {
  const lng = view.centerLng + (Number(x) - width / 2) / (view.scale * lngFactor(view.centerLat));
  const lat = view.centerLat - (Number(y) - height / 2) / view.scale;
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

/** 多边形顶点平均（当作围栏中心点足够用；真正几何形心对运营没有额外价值） */
export function polygonCenter(polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return null;
  const sum = polygon.reduce((a, [lat, lng]) => [a[0] + Number(lat), a[1] + Number(lng)], [0, 0]);
  return [Number((sum[0] / polygon.length).toFixed(6)), Number((sum[1] / polygon.length).toFixed(6))];
}

/** 多边形顶点到中心的「等效半径」(km)，给圆形兜底用 */
export function polygonRadiusKm(polygon) {
  const c = polygonCenter(polygon);
  if (!c) return 0;
  let max = 0;
  for (const [lat, lng] of polygon) max = Math.max(max, haversineKm(c[0], c[1], lat, lng));
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
 * 让一组点（通常是刚画好的围栏）刚好铺满视口。
 * 返回新的 view；点不足 2 个时只居中不缩放。
 */
export function fitView(points, width, height, padding = 60) {
  const pts = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])));
  if (!pts.length || width <= 0 || height <= 0) return { ...DEFAULT_VIEW };
  const lats = pts.map((p) => Number(p[0]));
  const lngs = pts.map((p) => Number(p[1]));
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  // 单点（或一条线）时给一个下限跨度，避免放大到天文数字
  const spanLat = Math.max(1e-4, Math.max(...lats) - Math.min(...lats));
  const spanLng = Math.max(1e-4, Math.max(...lngs) - Math.min(...lngs));
  const usableW = Math.max(40, width - padding * 2);
  const usableH = Math.max(40, height - padding * 2);
  // 横向：每度经度占 scale×cos(lat) 像素；纵向：每度纬度占 scale 像素
  const scaleByLng = usableW / spanLng / lngFactor(centerLat);
  const scaleByLat = usableH / spanLat;
  const scale = Math.min(scaleByLng, scaleByLat);
  return {
    centerLng,
    centerLat,
    scale: Number(clampScale(scale).toFixed(4)),
  };
}

/** 以某个像素点为锚点缩放（滚轮缩放时鼠标下的位置保持不动） */
export function zoomAt(view, x, y, factor, width, height) {
  const before = unproject(x, y, view, width, height);
  const scale = clampScale(view.scale * factor);
  // 横向压了 cos(lat0)，而 lat0 本身会随平移变化，所以校正两轮把残差压到浮点噪声级别
  let next = { centerLng: view.centerLng, centerLat: view.centerLat, scale };
  for (let i = 0; i < 2; i++) {
    const after = unproject(x, y, next, width, height);
    next = {
      scale,
      centerLng: next.centerLng + (before[1] - after[1]),
      centerLat: next.centerLat + (before[0] - after[0]),
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
 * 横向与纵向的地面比例在这个投影下都是 KM_PER_DEG_LAT/scale（横向的 cos 已在
 * lngFactor 里互相抵消），所以圆在屏幕上画成圆，地面距离也是圆的。
 */
export function radiusToPixels(radiusKm, scale, _lat) {
  return (Number(radiusKm) / KM_PER_DEG_LAT) * Number(scale || 0);
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
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  return polygon.every(
    (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])),
  );
}

/** 规范化：保留 6 位小数（约 0.1 米精度），去掉重复的相邻点 */
export function normalizePolygon(polygon) {
  const out = [];
  for (const p of polygon || []) {
    const lat = Number(Number(p[0]).toFixed(6));
    const lng = Number(Number(p[1]).toFixed(6));
    const last = out[out.length - 1];
    if (last && last[0] === lat && last[1] === lng) continue;
    out.push([lat, lng]);
  }
  // 首尾相同则去掉尾部
  if (out.length > 1) {
    const [f0, f1] = out[0];
    const [l0, l1] = out[out.length - 1];
    if (f0 === l0 && f1 === l1) out.pop();
  }
  return out;
}
