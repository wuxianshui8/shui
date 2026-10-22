import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 行政区边界数据集（区域管理「按行政区设置」用）。
 *
 * 数据文件 `db/admin-areas.json` 由 `tools/build-admin-areas.mjs` 生成：
 * 省 + 地级市全量，另加少量区县（张北县、杭州各区县）作为演示范围。
 * 为什么随包分发：容器/门禁常常没有外网，「输入地名 → 选行政区 → 画围栏」必须离线成立。
 *
 * 坐标顺序：数据文件里是 GeoJSON 习惯的 `[lng, lat]`；
 * **对外的接口一律转成 `[lat, lng]`**，与片区多边形、半径判定保持同一约定。
 */

export interface AdminArea {
  code: number;
  name: string;
  short: string;
  level: "province" | "city" | "district";
  parentCode: number;
  center: [number, number]; // [lat, lng]
  rings: number[][][]; // [[ [lng,lat], ... ], ...]（与数据文件一致）
}

let cache: AdminArea[] | null = null;
let cacheError: string | null = null;

function candidates(): string[] {
  const out: string[] = [];
  const cwd = process.cwd();
  out.push(join(cwd, "db", "admin-areas.json"));
  out.push(join(cwd, "..", "..", "apps", "api-nest", "db", "admin-areas.json"));
  // dist/common/admin-areas.js → ../../db/admin-areas.json
  out.push(join(__dirname, "..", "..", "db", "admin-areas.json"));
  return out;
}

export function loadAdminAreas(): AdminArea[] {
  if (cache) return cache;
  for (const p of candidates()) {
    if (!existsSync(p)) continue;
    const raw = JSON.parse(readFileSync(p, "utf8")) as AdminArea[];
    cache = raw.map((a) => ({
      ...a,
      // 数据文件是 [lng,lat]，这里顺手换成 [lat,lng] 存一份，省得每次转换
      rings: a.rings.map((ring) => ring.map(([lng, lat]) => [Number(lat), Number(lng)])),
    }));
    cacheError = null;
    return cache;
  }
  cacheError = "未找到 db/admin-areas.json（请先运行 node tools/build-admin-areas.mjs）";
  cache = [];
  return cache;
}

export function adminAreasStatus() {
  const rows = loadAdminAreas();
  const levels: Record<string, number> = {};
  for (const a of rows) levels[a.level] = (levels[a.level] || 0) + 1;
  return { count: rows.length, levels, error: cacheError };
}

const LEVEL_ORDER: Record<string, number> = { district: 0, city: 1, province: 2 };

/**
 * 地名搜索：支持名称/简称包含匹配，也支持直接粘 adcode。
 * 排序让「完全同名」和「更细的级别」排前面（搜「杭州」先给杭州市）。
 */
export function searchAreas(q: string, limit = 20): AdminArea[] {
  const rows = loadAdminAreas();
  const raw = String(q || "").trim();
  if (!raw) return [];
  const key = raw.toLowerCase();
  const scored: { a: AdminArea; score: number }[] = [];
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

/** 按 adcode 批量取（含边界环），用于「勾选后在地图上高亮」 */
export function areasByCodes(codes: (number | string)[]): AdminArea[] {
  const rows = loadAdminAreas();
  const want = new Set(codes.map((c) => Number(c)).filter((c) => Number.isFinite(c)));
  return rows.filter((a) => want.has(a.code));
}

export interface AreaFence {
  rings: number[][][]; // [[ [lat,lng], ... ]]
  center: [number, number];
  points: number;
  codes: number[];
  names: string[];
  missing: number[];
}

/**
 * 把若干个行政区拼成一个围栏（多环）。
 * 语义：点落在**任一**环内即属于该片区（`pointInAnyRing`）。
 */
export function fenceFromCodes(codes: (number | string)[]): AreaFence | null {
  const wanted = codes.map((c) => Number(c)).filter((c) => Number.isFinite(c));
  const found = areasByCodes(wanted);
  if (!found.length) return null;
  const rings: number[][][] = [];
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
  const center: [number, number] = [
    Number((found.reduce((s, a) => s + a.center[0], 0) / found.length).toFixed(6)),
    Number((found.reduce((s, a) => s + a.center[1], 0) / found.length).toFixed(6)),
  ];
  const missing = wanted.filter((c) => !found.some((a) => a.code === c));
  return { rings, center, points, codes: found.map((a) => a.code), names: found.map((a) => a.name), missing };
}
