// ============================================================
// 生成「行政区边界」数据集（区域管理 → 按行政区设置用）
//
//   输出：apps/api-nest/db/admin-areas.json
//   结构：[{ code, name, short, level, parentCode, center:[lat,lng], rings:[[[lng,lat],...]] }]
//
//   为什么自己生成而不用在线服务：容器/门禁常常没有外网，「输入地名选行政区」
//   必须在离线环境成立，所以边界数据随包分发；只有生成这一步需要网络（或 --src 本地副本）。
//
//   数据来源：阿里云 DataV.GeoAtlas 的 areas_v3 边界（与 ECharts 地图数据同源的公开底图）。
//   生成时做三件事：
//     1) 只取 outer ring（内嵌洞在行政区边界里极少，保留会显著增大体积）；
//     2) 道格拉斯-普克简化（按级别给不同容差：省 0.02°≈2.2km、市 0.008°≈900m、区县 0.002°≈220m）；
//     3) 经纬度保留小数位（省 2 位≈1.1km，市/区县 3 位≈110m），并去掉相邻重复点。
//   体积与精度取舍：省级 3000+ 点会掉到几百点，城市边界在 10~40km 尺度上误差 <200m，
//   对「片区归属判定」这种用途足够；如果需要更高精度，调 EPS 或改用 --precise。
//
//   用法：
//     node tools/build-admin-areas.mjs                 # 联网生成（省 + 地级市 + 演示区县）
//     node tools/build-admin-areas.mjs --src D:\geo    # 用本地 {adcode}_full.json 目录
//     node tools/build-admin-areas.mjs --check         # 只校验已生成的数据（门禁用）
//     node tools/build-admin-areas.mjs --counties 130722,330100   # 追加区县级（adcode）
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.GATE_ROOT || path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "apps/api-nest/db/admin-areas.json");
const BASE = process.env.ADMIN_AREAS_URL || "https://geo.datav.aliyun.com/areas_v3/bound/";
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d = "") => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

/** 默认随包分发的「区县级」演示范围：张北县（截图示例）+ 杭州市各区县（演示城市） */
const DEFAULT_COUNTIES = ["130722", "330100"];

const EPS = { province: 0.02, city: 0.008, district: 0.002 };
const PREC = { province: 2, city: 3, district: 3 };
/** 直辖市/特别行政区/台湾只保留整体，不再收下级区县（否则光北京就多 16 个多边形） */
const WHOLE_ONLY = new Set(["110000", "120000", "310000", "500000", "710000", "810000", "820000"]);

/* ---------------- 几何：简化与清理 ---------------- */

/** 道格拉斯-普克：容差 eps（度）；闭合环按「首尾同点」处理 */
function simplify(points, eps) {
  if (points.length <= 3) return points.slice();
  const sqEps = eps * eps;
  const sqSegDist = (p, a, b) => {
    let x = a[0], y = a[1];
    let dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  };
  const ring = points.slice();
  // 闭合环：去掉末点（与首点相同）后再简化，最后补回
  const closed = ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  if (closed) ring.pop();
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = sqEps, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(ring[i], ring[first], ring[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (index > 0) { keep[index] = 1; stack.push([first, index], [index, last]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  if (closed && out.length >= 3) out.push([out[0][0], out[0][1]]);
  return out.length >= 3 ? out : points.slice();
}

/** 四舍五入到 prec 位并去掉相邻重复点 */
function tidy(ring, prec = 3) {
  const k = 10 ** prec;
  const out = [];
  for (const [lng, lat] of ring) {
    const p = [Math.round(Number(lng) * k) / k, Math.round(Number(lat) * k) / k];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  return out;
}

/** GeoJSON geometry → outer rings（[lng,lat] 顺序） */
function outerRings(geometry) {
  if (!geometry) return [];
  const raw =
    geometry.type === "Polygon" ? geometry.coordinates :
    geometry.type === "MultiPolygon" ? geometry.coordinates.map((p) => p[0]) :
    [];
  return raw.filter((r) => Array.isArray(r) && r.length >= 4);
}

/** 面积最大的环（用于判断数据是否完整 + 给中心点兜底） */
function largestRing(rings) {
  let best = null, bestLen = 0;
  for (const r of rings) if (r.length > bestLen) { bestLen = r.length; best = r; }
  return best;
}

/* ---------------- 数据获取 ---------------- */

const cache = new Map();
async function loadArea(adcode, srcDir) {
  if (cache.has(adcode)) return cache.get(adcode);
  const name = adcode + "_full.json";
  let text = null;
  if (srcDir) {
    const p = path.join(srcDir, name);
    if (!existsSync(p)) throw new Error("本地缺少 " + name + "（--src 目录里需要 {adcode}_full.json）");
    text = readFileSync(p, "utf8");
  } else {
    const res = await fetch(BASE + name, { headers: { "user-agent": "jiajiao-build-admin-areas" } });
    if (res.status !== 200) throw new Error(name + " HTTP " + res.status);
    text = await res.text();
  }
  const json = JSON.parse(text);
  cache.set(adcode, json);
  return json;
}

/** 单个 adcode 的「自身」边界（datav 的 {adcode}.json 是不带 _full 的单体文件） */
async function loadSingle(adcode, srcDir) {
  const name = adcode + ".json";
  if (srcDir) {
    const p = path.join(srcDir, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
    return loadArea(adcode, srcDir);
  }
  const res = await fetch(BASE + name);
  if (res.status !== 200) throw new Error(name + " HTTP " + res.status);
  return JSON.parse(await res.text());
}

function toEntry(props, geometry, level) {
  const rings = outerRings(geometry)
    .map((r) => tidy(simplify(r, EPS[level] ?? 0.004), PREC[level] ?? 3))
    .filter((r) => r.length >= 3);
  if (!rings.length) return null;
  const center = props.centroid || props.center || (largestRing(rings) ? largestRing(rings)[0] : null);
  if (!center) return null;
  const name = String(props.name || "").trim();
  return {
    code: Number(props.adcode),
    name,
    short: name.replace(/(省|市|自治区|自治州|地区|盟|特别行政区|区|县|旗|新区)$/u, "") || name,
    level,
    parentCode: Number(props.parent?.adcode || 0),
    center: [Number(center[1]), Number(center[0])],
    rings,
  };
}

/* ---------------- 校验（--check 与生成后自检共用） ---------------- */

export function validateAreaFile(file = OUT) {
  const rows = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  if (!Array.isArray(rows) || rows.length < 30) problems.push("条目太少：" + (Array.isArray(rows) ? rows.length : "非数组"));
  const levels = {};
  let pts = 0, bad = 0, dup = 0;
  const codes = new Set();
  for (const a of rows) {
    levels[a.level] = (levels[a.level] || 0) + 1;
    if (codes.has(a.code)) dup++;
    codes.add(a.code);
    if (!Array.isArray(a.rings) || !a.rings.length) { bad++; continue; }
    for (const ring of a.rings) {
      pts += ring.length;
      for (const [lng, lat] of ring) {
        if (!(lng > 73 && lng < 136 && lat > 3 && lat < 54)) bad++;
      }
    }
    if (!Array.isArray(a.center) || !(a.center[0] > 3 && a.center[0] < 54)) bad++;
  }
  if (bad) problems.push("越界或缺失坐标 " + bad + " 处");
  if (dup) problems.push("adcode 重复 " + dup + " 个");
  if (!levels.province) problems.push("缺少省级");
  if (!levels.city) problems.push("缺少地级市");
  if (!levels.district) problems.push("缺少区县级（演示范围）");
  return { rows: rows.length, levels, points: pts, problems, bytes: readFileSync(file).length };
}

/* ---------------- 主流程 ---------------- */

async function build() {
  const srcDir = opt("--src");
  const counties = opt("--counties", DEFAULT_COUNTIES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);

  // 1) 省级
  const country = await loadArea("100000", srcDir);
  const provinces = [];
  const cityTasks = [];
  for (const f of country.features || []) {
    const p = f.properties || {};
    const code = String(p.adcode ?? "");
    if (!/^\d{6}$/.test(code) || code === "100000") continue; // 跳过「南海诸岛」等非行政区占位
    const e = toEntry(p, f.geometry, "province");
    if (e) provinces.push(e);
    // 省的下级是地级市；直辖市/特别行政区只保留整体，不再收下级
    if (!WHOLE_ONLY.has(code)) cityTasks.push({ code });
  }
  console.log("省级：" + provinces.length + " 个");

  // 2) 地级市（逐省取 _full）
  const cities = [];
  for (const t of cityTasks) {
    let json;
    try {
      json = await loadArea(t.code, srcDir);
    } catch (e) {
      console.log("  跳过 " + t.code + "：" + e.message);
      continue;
    }
    for (const f of json.features || []) {
      const p = f.properties || {};
      const level = p.level === "district" ? "district" : "city";
      // 只收「省的直接下级」，避免把区县重复塞进来
      const e = toEntry(p, f.geometry, level);
      if (e && e.parentCode && String(e.parentCode).slice(0, 2) === t.code.slice(0, 2)) cities.push(e);
    }
    process.stdout.write(".");
  }
  console.log("\n地级市/直辖市区：" + cities.length + " 个");

  // 3) 演示区县（默认张北县 + 杭州各区县）
  const districts = [];
  for (const c of counties) {
    let json;
    try {
      json = await loadArea(c, srcDir);
    } catch {
      json = await loadSingle(c, srcDir);
    }
    for (const f of json.features || []) {
      const p = f.properties || {};
      const e = toEntry(p, f.geometry, "district");
      if (e) districts.push(e);
    }
  }
  console.log("区县级（演示范围）：" + districts.length + " 个");

  // 4) 去重 + 落盘
  const map = new Map();
  for (const a of [...provinces, ...cities, ...districts]) map.set(a.code, a);
  const rows = [...map.values()].sort((a, b) => a.code - b.code);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(rows));
  const info = validateAreaFile();
  console.log(
    "\n已写入 " + path.relative(ROOT, OUT) + "：" + info.rows + " 个行政区 / " + info.points + " 个坐标点 / " +
      Math.round(info.bytes / 1024) + " KB",
  );
  console.log("级别分布：" + JSON.stringify(info.levels));
  if (info.problems.length) {
    console.log("✗ 自检未通过：" + info.problems.join("；"));
    process.exit(1);
  }
  console.log("✓ 自检通过（坐标范围、adcode 唯一、级别齐全）");
}

if (flag("--check")) {
  const info = validateAreaFile();
  console.log("行政区数据集校验：" + info.rows + " 个 / " + info.points + " 点 / " + Math.round(info.bytes / 1024) + " KB");
  console.log("级别分布：" + JSON.stringify(info.levels));
  if (info.problems.length) {
    console.log("✗ " + info.problems.join("；"));
    process.exit(1);
  }
  console.log("✓ 通过");
} else {
  await build();
}
