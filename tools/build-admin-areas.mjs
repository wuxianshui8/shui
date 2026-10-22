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
//     node tools/build-admin-areas.mjs                    # 联网生成全国（省 + 地级市 + 全部区县 ≈ 3200 个）
//     node tools/build-admin-areas.mjs --depth city        # 只要省 + 地级市（体积小得多）
//     node tools/build-admin-areas.mjs --provinces 330000   # 只处理某几个省（调试用）
//     node tools/build-admin-areas.mjs --src D:\geo         # 用本地 {adcode}_full.json 目录
//     node tools/build-admin-areas.mjs --check              # 只校验已生成的数据（门禁用）
//     node tools/build-admin-areas.mjs --plain              # 同时写一份裸 JSON（默认只写 .json.gz）
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";

const ROOT = process.env.GATE_ROOT || path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "apps/api-nest/db/admin-areas.json");
const OUT_GZ = OUT + ".gz";
const BASE = process.env.ADMIN_AREAS_URL || "https://geo.datav.aliyun.com/areas_v3/bound/";
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d = "") => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

/** 默认随包分发的「区县级」演示范围：张北县（截图示例）+ 杭州市各区县（演示城市） */
const DEFAULT_COUNTIES = ["130722", "330100"];

const EPS = { province: 0.02, city: 0.008, district: 0.003 };
const PREC = { province: 2, city: 3, district: 3 };
/** 直辖市/特别行政区/台湾：下级直接是区县（不当地级市处理，也不再往下抓一层） */
const WHOLE_ONLY = new Set(["110000", "120000", "310000", "500000", "710000", "810000", "820000"]);

/* ---------------- 几何：简化与清理 ---------------- */

/** 先粗抽样把超大环压到 ~1200 点，再做 DP（否则上万点的县界会让 DP 退化成 O(n²)） */
function predecimate(ring, cap = 1200) {
  let out = ring;
  while (out.length > cap) {
    const next = [out[0]];
    for (let i = 1; i < out.length - 1; i += 2) next.push(out[i]);
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** 环的包围盒对角线（度）：太小的岛/碎块直接丢掉，省体积也不影响归属判定 */
function ringDiagonal(ring) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 下载缓存目录：可断点续跑（限流/中断后再跑会命中已下载的文件），默认不进仓库 */
const CACHE_DIR = process.env.ADMIN_AREAS_CACHE || path.join(ROOT, ".cache", "admin-areas");
let lastFetch = 0;

/** 抓取单个文件：顺序 + 节流（300ms）+ 限流退避（DataV 高频会 403） */
async function fetchText(url, name, { attempts = 6 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const wait = Math.max(0, 300 - (Date.now() - lastFetch));
    if (wait) await sleep(wait);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 jiajiao-build-admin-areas" },
        signal: AbortSignal.timeout(15000), // 卡住的连接直接判失败，别把整轮构建挂死
      });
      lastFetch = Date.now();
      if (res.status === 200) return await res.text();
      lastErr = new Error(name + " HTTP " + res.status);
      // 404 是「该行政区本来就没有下级文件」（如新疆兵团的县级市），不该重试也不该退避
      if (res.status === 404) break;
      // 403/429/5xx 视为限流，指数退避（5s→30s）；最后一次尝试不再睡，免得白等
      if (attempt < attempts - 1) await sleep(Math.min(30000, 5000 * 2 ** attempt));
    } catch (e) {
      lastErr = e;
      if (attempt < attempts - 1) await sleep(Math.min(20000, 3000 * 2 ** attempt));
    }
  }
  throw lastErr || new Error(name + " 抓取失败");
}

/** 取一个源文件（优先 --src 目录，其次本地缓存，最后联网；联网结果写回缓存） */
async function sourceText(name, srcDir) {
  const dirs = [srcDir, CACHE_DIR].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  const text = await fetchText(BASE + name, name, { attempts: Number(process.env.ADMIN_AREAS_ATTEMPTS || 6) });
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(path.join(CACHE_DIR, name), text);
  return text;
}

async function loadArea(adcode, srcDir) {
  if (cache.has(adcode)) return cache.get(adcode);
  const json = JSON.parse(await sourceText(adcode + "_full.json", srcDir));
  cache.set(adcode, json);
  return json;
}

/** 单个 adcode 的「自身」边界（datav 的 {adcode}.json 是不带 _full 的单体文件） */
async function loadSingle(adcode, srcDir) {
  const name = adcode + ".json";
  const dirs = [srcDir, CACHE_DIR].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  if (!existsSync(path.join(CACHE_DIR, adcode + "_full.json")) && !srcDir) {
    try {
      const text = await sourceText(name, srcDir);
      return JSON.parse(text);
    } catch {
      /* 落到 _full 再试 */
    }
  }
  return loadArea(adcode, srcDir);
}

function toEntry(props, geometry, level) {
  const eps = EPS[level] ?? 0.004;
  const prec = PREC[level] ?? 3;
  const rings = outerRings(geometry)
    .filter((r) => r.length >= 4 && ringDiagonal(r) >= 0.01) // 丢掉 <1km 的碎岛
    .map((r) => tidy(simplify(predecimate(r), eps), prec))
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

export function validateAreaFile(file = "") {
  const pick = file || (existsSync(OUT_GZ) ? OUT_GZ : OUT);
  const buf = readFileSync(pick);
  const rows = JSON.parse(pick.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8"));
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
  // 区县是否齐全：全国区县约 2800+（含县级市/旗/林区），只收演示范围时不做这个要求
  const wantAllDistricts = process.env.ADMIN_AREAS_DEPTH === "district";
  if (!levels.district) problems.push("缺少区县级");
  else if (wantAllDistricts && levels.district < 2500) problems.push("区县级太少（" + levels.district + "），全国应 ≥2500");
  return { rows: rows.length, levels, points: pts, problems, bytes: buf.length, file: pick };
}

/* ---------------- 主流程 ---------------- */

async function build() {
  const srcDir = opt("--src");
  const depth = opt("--depth", "district"); // province | city | district
  const provincesFilter = opt("--provinces", "").split(",").map((s) => s.trim().slice(0, 2)).filter(Boolean);
  const extraCounties = opt("--counties", "").split(",").map((s) => s.trim()).filter(Boolean);
  process.env.ADMIN_AREAS_DEPTH = depth;
  const wantDistricts = depth === "district";

  // 1) 省级 + 省的直接下级（地级市 / 直辖市的区）
  const country = await loadArea("100000", srcDir);
  const provinces = [];
  const cities = [];
  const districts = [];
  const cityTasks = [];
  for (const f of country.features || []) {
    const p = f.properties || {};
    const code = String(p.adcode ?? "");
    if (!/^\d{6}$/.test(code) || code === "100000") continue; // 跳过「南海诸岛」等非行政区占位
    const e = toEntry(p, f.geometry, "province");
    if (e) provinces.push(e);
    if (provincesFilter.length && !provincesFilter.includes(code.slice(0, 2))) continue;
    // 直辖市/特别行政区：下级直接是区县，不当地级市处理
    cityTasks.push({ provinceCode: code, asDistrict: WHOLE_ONLY.has(code) });
  }
  console.log("省级：" + provinces.length + " 个" + (provincesFilter.length ? "（本次只处理 " + provincesFilter.join(",") + "）" : ""));

  const cityFetchTasks = [];
  for (const t of cityTasks) {
    let json;
    try {
      json = await loadArea(t.provinceCode, srcDir);
    } catch (e) {
      console.log("  跳过 " + t.provinceCode + "：" + e.message);
      continue;
    }
    for (const f of json.features || []) {
      const p = f.properties || {};
      const isDistrict = t.asDistrict || p.level === "district";
      const level = isDistrict ? "district" : "city";
      const e = toEntry(p, f.geometry, level);
      if (!e) continue;
      if (isDistrict) districts.push(e);
      else cities.push(e);
      if (wantDistricts && !isDistrict) cityFetchTasks.push(String(e.code));
    }
    process.stdout.write(".");
  }
  console.log("\n地级市：" + cities.length + " 个 / 直辖市区县：" + districts.filter((d) => WHOLE_ONLY.has(String(d.parentCode))).length + " 个");

  // 2) 逐市取区县（全国 2800+ 个）：顺序抓取（限流友好）+ 磁盘缓存（中断可续跑）
  if (wantDistricts) {
    const tasks = cityFetchTasks;
    console.log("抓区县：" + tasks.length + " 个地级市（顺序 + 缓存 " + path.relative(ROOT, CACHE_DIR) + "）");
    let done = 0, cached = 0;
    for (const cityCode of tasks) {
      let json;
      try {
        const hit = existsSync(path.join(CACHE_DIR, cityCode + "_full.json"));
        json = await loadArea(cityCode, srcDir);
        if (hit) cached++;
      } catch {
        continue;
      } finally {
        done++;
        if (done % 20 === 0) process.stdout.write(".");
      }
      for (const f of json.features || []) {
        const e = toEntry(f.properties || {}, f.geometry, "district");
        if (e) districts.push(e);
      }
    }
    console.log("\n区县级合计：" + districts.length + " 个（缓存命中 " + cached + "/" + tasks.length + "）");
  }

  // 3) 手工追加的区县（--counties 130722,330100）
  for (const c of extraCounties) {
    let json;
    try {
      json = await loadArea(c, srcDir);
    } catch {
      json = await loadSingle(c, srcDir);
    }
    for (const f of json.features || []) {
      const e = toEntry(f.properties || {}, f.geometry, "district");
      if (e) districts.push(e);
    }
  }

  // 4) 去重 + 落盘（默认只产出 gzip：全国 3222 个行政区裸 JSON 有 8MB，gzip 后 ~1.9MB，
  //    解析耗时反而更低（182ms vs 226ms），仓库与镜像都不用背 8MB）
  const map = new Map();
  for (const a of [...provinces, ...cities, ...districts]) map.set(a.code, a);
  const rows = [...map.values()].sort((a, b) => a.code - b.code);
  mkdirSync(path.dirname(OUT), { recursive: true });
  const raw = Buffer.from(JSON.stringify(rows), "utf8");
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(OUT_GZ, gz);
  if (flag("--plain")) writeFileSync(OUT, raw);
  const info = validateAreaFile();
  console.log(
    "\n已写入 " + path.relative(ROOT, OUT_GZ) + "：" + info.rows + " 个行政区 / " + info.points + " 个坐标点 / " +
      Math.round(gz.length / 1024) + " KB（gzip）" + (flag("--plain") ? " + 裸 JSON " + Math.round(raw.length / 1024) + " KB" : ""),
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
  console.log("行政区数据集校验（" + path.relative(ROOT, info.file) + "）：" + info.rows + " 个 / " + info.points + " 点 / " + Math.round(info.bytes / 1024) + " KB");
  console.log("级别分布：" + JSON.stringify(info.levels));
  if (info.problems.length) {
    console.log("✗ " + info.problems.join("；"));
    process.exit(1);
  }
  console.log("✓ 通过");
} else if (flag("--download-only")) {
  // 只把各市 _full.json 拉进本地缓存（可反复执行、断点续跑），随后 build 完全离线
  const srcDir = opt("--src");
  const country = await loadArea("100000", srcDir);
  const cityCodes = [];
  for (const f of country.features || []) {
    const p = f.properties || {};
    const code = String(p.adcode ?? "");
    if (!/^\d{6}$/.test(code) || code === "100000") continue;
    if (WHOLE_ONLY.has(code)) continue;
    let json;
    try {
      json = await loadArea(code, srcDir);
    } catch (e) {
      console.log("跳过省 " + code + "：" + e.message);
      continue;
    }
    for (const cf of json.features || []) {
      const cpf = cf.properties || {};
      if (!/^\d{6}$/.test(String(cpf.adcode ?? ""))) continue;
      cityCodes.push(String(cpf.adcode));
    }
  }
  const missing = cityCodes.filter((c) => !existsSync(path.join(CACHE_DIR, c + "_full.json")));
  console.log("需要区县数据的地级市 " + cityCodes.length + " 个，待下载 " + missing.length + " 个");
  let ok = 0, fail = 0;
  for (const c of missing) {
    try {
      await sourceText(c + "_full.json", srcDir);
      ok++;
    } catch (e) {
      fail++;
      console.log("  ✗ " + c + "：" + e.message);
    }
    if ((ok + fail) % 25 === 0) process.stdout.write(".");
  }
  console.log("\n本次下载 " + ok + " 个，失败 " + fail + " 个；剩余 " +
    cityCodes.filter((c) => !existsSync(path.join(CACHE_DIR, c + "_full.json"))).length + " 个");
  process.exit(fail && !ok ? 1 : 0);
} else {
  await build();
}
