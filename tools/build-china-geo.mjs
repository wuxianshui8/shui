// ============================================================
// 生成离线中国底图（apps/web-admin/src/assets/china.geo.json）
//
// 为什么要这个脚本：ECharts 4.x 的 map/json/china.json 用的是「压缩编码」格式
// （坐标是字符串 + encodeOffsets），不能直接当 GeoJSON 渲染，也不便于校验。
// 这里把它解码成标准 [lng,lat] 数字坐标，并按 3 位小数取整（≈110 米）压体积。
//
// 数据来源：https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/china.json
// 许可：Apache-2.0（ECharts 的 map 数据随包分发）
//
// 用法：
//   node tools/build-china-geo.mjs                 # 用内置的下载地址重新生成
//   node tools/build-china-geo.mjs --src <file>    # 用本地已有的 echarts china.json 生成
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.GATE_ROOT || path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "apps/web-admin/src/assets/china.geo.json");
const DEFAULT_SRC_URL = "https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/china.json";

/** ECharts 压缩坐标解码（官方实现的最小移植） */
function decodeRing(encoded, offset) {
  const out = [];
  let prevX = offset[0];
  let prevY = offset[1];
  for (let i = 0; i < encoded.length; i += 2) {
    let x = encoded.charCodeAt(i) - 64;
    let y = encoded.charCodeAt(i + 1) - 64;
    // 折半编码：最低位是符号位
    x = (x >> 1) ^ -(x & 1);
    y = (y >> 1) ^ -(y & 1);
    x += prevX;
    y += prevY;
    prevX = x;
    prevY = y;
    // 2 位小数 ≈ 1.1 公里：只作国界/省界底图，精度足够且体积减半
    out.push([Number((x / 1024).toFixed(2)), Number((y / 1024).toFixed(2))]);
  }
  return out;
}

function decodeGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const { type } = geometry;
  if (type === "Polygon") {
    // coordinates: [ring…]，每个元素是字符串或字符串数组；encodeOffsets 与之对齐
    const offsets = geometry.encodeOffsets || [];
    const rings = geometry.coordinates.map((ring, i) =>
      typeof ring === "string" ? decodeRing(ring, offsets[i] || [0, 0]) : ring,
    );
    return { type: "Polygon", coordinates: rings };
  }
  if (type === "MultiPolygon") {
    const offsets = geometry.encodeOffsets || [];
    const polys = geometry.coordinates.map((poly, i) =>
      poly.map((ring, j) =>
        typeof ring === "string" ? decodeRing(ring, (offsets[i] && offsets[i][j]) || [0, 0]) : ring,
      ),
    );
    return { type: "MultiPolygon", coordinates: polys };
  }
  return { type, coordinates: geometry.coordinates };
}

async function loadSource() {
  const idx = process.argv.indexOf("--src");
  if (idx > 0 && process.argv[idx + 1]) {
    return JSON.parse(readFileSync(path.resolve(process.argv[idx + 1]), "utf8"));
  }
  const url = process.env.CHINA_GEO_URL || DEFAULT_SRC_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error("下载底图失败：" + res.status + " " + url);
  return await res.json();
}

const src = await loadSource();
const features = [];
for (const f of src.features || []) {
  const geometry = decodeGeometry(f.geometry);
  if (!geometry) continue;
  features.push({
    type: "Feature",
    properties: { name: f.properties?.name || "" },
    geometry,
  });
}

// 完整性自检：坐标必须是有限数字且在国境范围内（lat/lng 写反会立刻被抓到）
let points = 0;
const flat = [];
for (const f of features) {
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const p of ring) {
        if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
          throw new Error(`坐标不合法：${f.properties.name} → ${JSON.stringify(p)}`);
        }
        if (!(p[0] > 73 && p[0] < 136 && p[1] > 3 && p[1] < 54)) {
          throw new Error(`坐标越界（疑似 lat/lng 写反）：${f.properties.name} → ${JSON.stringify(p)}`);
        }
        flat.push(p);
        points++;
      }
    }
  }
}

const out = JSON.stringify({ type: "FeatureCollection", features });
writeFileSync(OUT, out);
console.log(`✓ 已生成 ${path.relative(ROOT, OUT)}`);
console.log(`  要素 ${features.length} 个 / 坐标点 ${points} 个 / ${(out.length / 1024).toFixed(0)} KB`);
console.log(`  经度 ${Math.min(...flat.map((p) => p[0]))} ~ ${Math.max(...flat.map((p) => p[0]))}，纬度 ${Math.min(...flat.map((p) => p[1]))} ~ ${Math.max(...flat.map((p) => p[1]))}`);
