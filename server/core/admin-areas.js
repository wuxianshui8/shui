// 行政区边界数据集（参考实现侧）：与正式实现共用同一份
// apps/api-nest/db/admin-areas.json，由 tools/build-admin-areas.mjs 生成。
//
// 数据文件里坐标是 GeoJSON 习惯的 [lng,lat]，这里统一转成 [lat,lng]，
// 与片区多边形、pointInPolygon/pointInAnyRing 的约定保持一致。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let cache = null;
let cacheError = null;

const candidates = () => [
  join(process.cwd(), "apps", "api-nest", "db", "admin-areas.json"),
  join(process.cwd(), "db", "admin-areas.json"),
  join(process.cwd(), "..", "apps", "api-nest", "db", "admin-areas.json"),
];

export function loadAdminAreas() {
  if (cache) return cache;
  for (const p of candidates()) {
    if (!existsSync(p)) continue;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    cache = raw.map((a) => ({
      ...a,
      rings: a.rings.map((ring) => ring.map(([lng, lat]) => [Number(lat), Number(lng)])),
    }));
    cacheError = null;
    return cache;
  }
  cacheError = "未找到 apps/api-nest/db/admin-areas.json（请先运行 node tools/build-admin-areas.mjs）";
  cache = [];
  return cache;
}

export function adminAreasStatus() {
  const rows = loadAdminAreas();
  const levels = {};
  for (const a of rows) levels[a.level] = (levels[a.level] || 0) + 1;
  return { count: rows.length, levels, error: cacheError };
}

const LEVEL_ORDER = { district: 0, city: 1, province: 2 };

export function searchAreas(q, limit = 20) {
  const rows = loadAdminAreas();
  const raw = String(q || "").trim();
  if (!raw) return [];
  const key = raw.toLowerCase();
  const scored = [];
  for (const a of rows) {
    const name = a.name.toLowerCase();
    const short = (a.short || "").toLowerCase();
    let score = -1;
    if (/^\d{4,6}$/.test(key)) {
      if (String(a.code).startsWith(key)) score = 0;
    } else if (name === key) score = 0;
    else if (short === key) score = 1;
    else if (name.startsWith(key)) score = 2;
    else if (short.startsWith(key)) score = 3;
    else if (name.includes(key)) score = 4;
    else if (short.includes(key)) score = 5;
    if (score < 0) continue;
    scored.push({ a, score: score * 10 + (LEVEL_ORDER[a.level] ?? 3) });
  }
  scored.sort((x, y) => x.score - y.score || x.a.code - y.a.code);
  return scored.slice(0, Math.max(1, Math.min(50, Number(limit) || 20))).map((s) => s.a);
}

export function areasByCodes(codes) {
  const rows = loadAdminAreas();
  const want = new Set((codes || []).map((c) => Number(c)).filter((c) => Number.isFinite(c)));
  return rows.filter((a) => want.has(a.code));
}

/** 把若干行政区拼成多环围栏（点落在任一环内即属于该片区） */
export function fenceFromCodes(codes) {
  const wanted = (codes || []).map((c) => Number(c)).filter((c) => Number.isFinite(c));
  const found = areasByCodes(wanted);
  if (!found.length) return null;
  const rings = [];
  let points = 0;
  for (const a of found) {
    for (const ring of a.rings) {
      if (ring.length >= 3) {
        rings.push(ring);
        points += ring.length;
      }
    }
  }
  if (!rings.length) return null;
  const center = [
    Number((found.reduce((s, a) => s + a.center[0], 0) / found.length).toFixed(6)),
    Number((found.reduce((s, a) => s + a.center[1], 0) / found.length).toFixed(6)),
  ];
  const missing = wanted.filter((c) => !found.some((a) => a.code === c));
  return { rings, center, points, codes: found.map((a) => a.code), names: found.map((a) => a.name), missing };
}
