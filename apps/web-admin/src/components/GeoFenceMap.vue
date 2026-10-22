<script setup>
/**
 * 片区电子围栏编辑器 / 行政区选择预览（不依赖任何地图 SDK）。
 *
 * 底图两层，自动降级：
 *   1) **在线瓦片**（默认高德栅格瓦片，可用 `VITE_TILE_URL` 换成自家/天地图源）——
 *      画布用 Web Mercator，与瓦片切片同一投影，贴图不需要逐瓦片变形；
 *   2) **离线省级底图**（`src/assets/china.geo.json`，Apache-2.0）——
 *      请求失败（无外网 / 容器里跑门禁 / 瓦片被墙）自动回落，保证页面永远不是白屏。
 *
 * 坐标系说明：国内在线底图是 GCJ-02，行政区边界数据（DataV）与手机定位
 * （uni.getLocation type=gcj02）同为 GCJ-02，三者对得上；只有离线省级底图来自
 * ECharts 的 WGS-84 数据，全国尺度上偏差 <500m，肉眼看不出，不影响围栏判定。
 *
 * 交互：
 * - 滚轮以鼠标为锚点缩放、拖拽平移、「全国 / 对准围栏」两个按钮
 * - 「按地图设置」逐点落点（双击或「完成绘制」闭合），顶点可拖动微调；也支持圆形围栏
 * - 「按行政区设置」把选中的行政区边界高亮画出来（多环），地图只读
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import chinaGeo from "../assets/china.geo.json";
import {
  DEFAULT_VIEW, collectLngLats, fitView, isValidPolygon, normalizePolygon, polygonCenter, polygonRadiusKm,
  project, radiusToPixels, ringsOfGeometry, ringsOfPolygon, scaleForTileZoom, tileBounds, tileXY,
  tileZoomForScale, unproject, visibleTiles, zoomAt,
} from "../geo-fence";

const props = defineProps({
  /** 已保存的片区（列表叠加用） */
  regions: { type: Array, default: () => [] },
  /** 编辑器状态：{ mode: 'polygon'|'circle', centerLat, centerLng, radiusKm, polygon } */
  model: { type: Object, required: true },
  /** 行政区高亮：[{ code, name, rings: [[[lat,lng],...]] }] */
  highlights: { type: Array, default: () => [] },
  /** 只读（按行政区设置时地图不可画） */
  readonly: { type: Boolean, default: false },
});
const emit = defineEmits(["update:model", "pick-region"]);

/* ---------------- 在线瓦片 ---------------- */

const TILE_URL =
  (import.meta.env && import.meta.env.VITE_TILE_URL) ||
  "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}";
const TILE_SUB = ["1", "2", "3", "4"];
const tileCache = new Map(); // key → { img, ok }
const tileStat = reactive({ ok: 0, fail: 0, available: null }); // available: null=探测中, true/false
const tilesOn = ref(true); // 用户可手动关掉在线底图

function tileUrl(z, x, y) {
  const s = TILE_SUB[Math.abs(x + y) % TILE_SUB.length];
  return TILE_URL.replace("{s}", s).replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

function tileAt(z, x, y) {
  const key = z + "/" + x + "/" + y;
  let entry = tileCache.get(key);
  if (entry) return entry;
  entry = { img: null, ok: false, pending: true };
  tileCache.set(key, entry);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    entry.img = img;
    entry.ok = true;
    entry.pending = false;
    tileStat.ok++;
    if (tileStat.available !== true && tileStat.ok >= 2) tileStat.available = true;
    schedule();
  };
  img.onerror = () => {
    entry.pending = false;
    tileStat.fail++;
    // 连续失败且一张都没成功 → 判定无外网，回落离线底图
    if (tileStat.available !== true && tileStat.fail >= 4) {
      tileStat.available = false;
      schedule();
    }
  };
  img.src = tileUrl(z, x, y);
  return entry;
}

/** 从 localStorage 记住「在线/离线底图」选择（运维在无网环境可以手动关掉） */
const TILE_PREF_KEY = "jiajiao_map_tiles";
function loadTilePref() {
  try {
    const v = localStorage.getItem(TILE_PREF_KEY);
    if (v === "off") tilesOn.value = false;
  } catch {
    /* ignore */
  }
}
function toggleTiles() {
  tilesOn.value = !tilesOn.value;
  try {
    localStorage.setItem(TILE_PREF_KEY, tilesOn.value ? "on" : "off");
  } catch {
    /* ignore */
  }
  schedule();
}

/* ---------------- 状态 ---------------- */

const wrap = ref(null);
const canvas = ref(null);
const size = reactive({ w: 0, h: 0 });
const view = ref({ ...DEFAULT_VIEW });
const drawing = ref(false);
const drag = reactive({ kind: "", startX: 0, startY: 0, viewStart: null, vertexIndex: -1, moved: false });
const hover = reactive({ lat: null, lng: null });
const provinces = chinaGeo.features || [];
let ctx = null;
let raf = 0;
let lastClick = { t: 0, x: 0, y: 0 };

const mode = computed(() => props.model?.mode || "polygon");
const polygon = computed(() => (Array.isArray(props.model?.polygon) ? props.model.polygon : []));
const rings = computed(() => ringsOfPolygon(polygon.value));
const center = computed(() => [Number(props.model?.centerLat ?? 30.262), Number(props.model?.centerLng ?? 120.133)]);
const radiusKm = computed(() => Number(props.model?.radiusKm ?? 5));
const viewState = computed(
  () => `${mode.value}|${rings.value.length}|${Number(view.value.centerLat).toFixed(4)},${Number(view.value.centerLng).toFixed(4)}|${Math.round(view.value.scale)}`,
);
const basemapLabel = computed(() => {
  if (!tilesOn.value) return "离线省级底图（手动关闭在线瓦片）";
  if (tileStat.available === false) return "离线省级底图（在线瓦片不可达）";
  if (tileStat.available === null) return "在线瓦片加载中…";
  return "在线瓦片底图";
});

/** 省级标签锚点（数据里只有 name，取最大一块环的包围盒中心） */
const PROVINCE_LABELS = provinces
  .map((f) => {
    const rs = ringsOfGeometry(f.geometry).filter((r) => r.length >= 3);
    if (!rs.length) return null;
    const ring = rs.reduce((a, b) => (b.length > a.length ? b : a), rs[0]);
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    return {
      name: f.properties?.name || "",
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    };
  })
  .filter((p) => p && p.name);

const CHINA_BOUNDS = computed(() => collectLngLats(chinaGeo).map(([lng, lat]) => [lat, lng]));

function patch(next) {
  emit("update:model", { ...props.model, ...next });
}

const parsePolygon = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
};

/* ---------------- 绘制 ---------------- */

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

function drawTiles() {
  if (!tilesOn.value || tileStat.available === false) return false;
  const z = tileZoomForScale(view.value.scale);
  const tileScale = scaleForTileZoom(z);
  const factor = view.value.scale / tileScale;
  const size0 = 256 * factor;
  let drawn = 0;
  ctx.imageSmoothingEnabled = false;
  for (const t of visibleTiles(view.value, size.w, size.h, z)) {
    const b = tileBounds(t.z, t.x, t.y);
    const [x0, y0] = project(b.west, b.north, view.value, size.w, size.h);
    const entry = tileAt(t.z, t.x, t.y);
    if (!entry.ok || !entry.img) continue;
    ctx.drawImage(entry.img, Math.round(x0), Math.round(y0), Math.ceil(x0 + size0) - Math.round(x0), Math.ceil(y0 + size0) - Math.round(y0));
    drawn++;
  }
  ctx.imageSmoothingEnabled = true;
  return drawn > 0;
}

function drawOfflineBasemap(withLabels) {
  for (const f of provinces) {
    for (const ring of ringsOfGeometry(f.geometry)) {
      if (!ring.length) continue;
      ctx.beginPath();
      ring.forEach(([lng, lat], i) => {
        const [x, y] = project(lng, lat, view.value, size.w, size.h);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = "#e9f1fb";
      ctx.fill();
      ctx.strokeStyle = "rgba(120,150,190,.6)";
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }
  if (withLabels && view.value.scale >= 6) {
    ctx.font = "10.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(90,115,150,.8)";
    ctx.textAlign = "center";
    for (const lb of PROVINCE_LABELS) {
      const [x, y] = project(lb.lng, lb.lat, view.value, size.w, size.h);
      if (x < -40 || x > size.w + 40 || y < -20 || y > size.h + 20) continue;
      ctx.fillText(lb.name, x, y);
    }
    ctx.textAlign = "left";
  }
}

function drawRingPath(ring) {
  ctx.beginPath();
  ring.forEach(([lat, lng], i) => {
    const [x, y] = project(lng, lat, view.value, size.w, size.h);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.closePath();
}

function draw() {
  if (!canvas.value || !size.w) return;
  const c = canvas.value;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) {
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
  }
  ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);
  ctx.fillStyle = "#eef3fa";
  ctx.fillRect(0, 0, size.w, size.h);

  const painted = drawTiles();
  if (!painted) drawOfflineBasemap(true);

  // 已保存片区（灰色叠加，跳过当前编辑的）
  for (const r of props.regions) {
    const poly = parsePolygon(r.polygon);
    const isCurrent = props.model?.id != null && r.id === props.model.id;
    if (isCurrent) continue;
    const rs = ringsOfPolygon(poly);
    if (isValidPolygon(poly)) {
      ctx.setLineDash([4, 3]);
      for (const ring of rs) {
        drawRingPath(ring);
        ctx.fillStyle = "rgba(120,140,170,.10)";
        ctx.fill();
        ctx.strokeStyle = "rgba(90,110,140,.55)";
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
      ctx.setLineDash([]);
      labelAt(polygonCenter(poly), r.name || String(r.id), "rgba(70,90,120,.9)");
    } else {
      const lat = Number(r.center_lat ?? r.centerLat);
      const lng = Number(r.center_lng ?? r.centerLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const [x, y] = project(lng, lat, view.value, size.w, size.h);
      const pr = radiusToPixels(Number(r.radius_km ?? r.radiusKm ?? 0), view.value.scale, lat);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(pr, 3), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(90,110,140,.55)";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
      labelAt([lat, lng], r.name || String(r.id), "rgba(70,90,120,.9)");
    }
  }

  // 选中的行政区高亮（按行政区设置）
  for (const h of props.highlights) {
    for (const ring of ringsOfPolygon(h.rings)) {
      drawRingPath(ring);
      ctx.fillStyle = "rgba(31,111,235,.22)";
      ctx.fill();
      ctx.strokeStyle = "rgba(31,111,235,.85)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    if (h.center) labelAt([h.center[0], h.center[1]], h.name, "#1f6feb");
  }

  // 当前编辑的围栏
  if (mode.value === "polygon" && rings.value.length) {
    for (const ring of rings.value) {
      drawRingPath(ring);
      ctx.fillStyle = "rgba(31,111,235,.16)";
      ctx.fill();
      ctx.strokeStyle = "#1f6feb";
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
    const last = rings.value[rings.value.length - 1];
    if (last && last.length <= 60) {
      last.forEach(([lat, lng], i) => {
        const [x, y] = project(lng, lat, view.value, size.w, size.h);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = i === 0 ? "#e67700" : "#1f6feb";
        ctx.stroke();
      });
    }
    const pts = rings.value.reduce((s, r) => s + r.length, 0);
    const label = rings.value.length > 1
      ? `当前围栏 ${rings.value.length} 环 / ${pts} 点 · 等效半径 ${polygonRadiusKm(polygon.value)}km`
      : `当前围栏 ${pts} 点${pts >= 3 ? " · 等效半径 " + polygonRadiusKm(polygon.value) + "km" : "（还需 ≥3 点）"}`;
    labelAt(polygonCenter(polygon.value), label, "#1f6feb");
  }

  // 圆形围栏
  if (mode.value === "circle") {
    const [lat, lng] = center.value;
    const [x, y] = project(lng, lat, view.value, size.w, size.h);
    const pr = radiusToPixels(radiusKm.value, view.value.scale, lat);
    ctx.beginPath();
    ctx.arc(x, y, pr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(31,111,235,.12)";
    ctx.fill();
    ctx.strokeStyle = "#1f6feb";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#1f6feb";
    ctx.fill();
    labelAt([lat, lng], "圆心 " + lat.toFixed(4) + ", " + lng.toFixed(4) + " · R " + radiusKm.value + "km", "#1f6feb");
  }

  // 橡皮筋
  if (drawing.value && rings.value.length && hover.lat != null) {
    const lastRing = rings.value[rings.value.length - 1];
    const last = lastRing[lastRing.length - 1];
    const [x1, y1] = project(last[1], last[0], view.value, size.w, size.h);
    const [x2, y2] = project(hover.lng, hover.lat, view.value, size.w, size.h);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = "rgba(31,111,235,.5)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 比例尺（Mercator：每像素 = 111.32/scale 公里，与纬度无关）
  const pxPerKm = view.value.scale / 111.32;
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  let km = candidates[0];
  for (const v of candidates) if (v * pxPerKm <= 90) km = v;
  const barPx = km * pxPerKm;
  ctx.strokeStyle = "rgba(60,80,110,.75)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(12, size.h - 14);
  ctx.lineTo(12 + barPx, size.h - 14);
  ctx.stroke();
  ctx.fillStyle = "rgba(60,80,110,.9)";
  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.fillText(km >= 1 ? km + " km" : km * 1000 + " m", 12, size.h - 20);
}

function labelAt(point, text, color) {
  if (!point) return;
  const [lat, lng] = point;
  const [x, y] = project(lng, lat, view.value, size.w, size.h);
  ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(255,255,255,.88)";
  ctx.fillRect(x - w / 2 - 4, y - 24, w + 8, 16);
  ctx.fillStyle = color;
  ctx.fillText(text, x - w / 2, y - 12);
}

/* ---------------- 交互 ---------------- */

function localPoint(e) {
  const rect = canvas.value.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function latLngAt(x, y) {
  const [lat, lng] = unproject(x, y, view.value, size.w, size.h);
  return [Number(lat.toFixed(6)), Number(lng.toFixed(6))];
}

function hitVertex(x, y) {
  if (mode.value !== "polygon") return -1;
  const lastRing = rings.value[rings.value.length - 1] || [];
  for (let i = 0; i < lastRing.length; i++) {
    const [lat, lng] = lastRing[i];
    const [px, py] = project(lng, lat, view.value, size.w, size.h);
    if (Math.hypot(px - x, py - y) <= 7) return i;
  }
  return -1;
}

function onWheel(e) {
  e.preventDefault();
  const [x, y] = localPoint(e);
  const factor = e.deltaY < 0 ? 1.25 : 0.8;
  view.value = { ...view.value, ...zoomAt(view.value, x, y, factor, size.w, size.h) };
  schedule();
}

function onDown(e) {
  if (props.readonly) return;
  if (e.button !== 0 && e.button !== 1) return;
  const [x, y] = localPoint(e);
  const vi = hitVertex(x, y);
  if (vi >= 0) {
    drag.kind = "vertex";
    drag.vertexIndex = vi;
    return;
  }
  drag.kind = "pan";
  drag.startX = x;
  drag.startY = y;
  drag.viewStart = { ...view.value };
  drag.moved = false;
}

function onMove(e) {
  const [x, y] = localPoint(e);
  const [lat, lng] = unproject(x, y, view.value, size.w, size.h);
  hover.lat = lat;
  hover.lng = lng;

  if (drag.kind === "vertex" && drag.vertexIndex >= 0) {
    const list = rings.value.slice();
    const lastIdx = list.length - 1;
    list[lastIdx] = list[lastIdx].map((p, i) => (i === drag.vertexIndex ? latLngAt(x, y) : p));
    patch({ polygon: polygon.value.length && typeof polygon.value[0][0] === "number" ? list[0] : list });
    schedule();
    return;
  }
  if (drag.kind === "pan" && drag.viewStart) {
    const dx = x - drag.startX;
    const dy = y - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.value = {
      ...view.value,
      centerLng: drag.viewStart.centerLng - dx / view.value.scale,
      centerLat: unproject(size.w / 2, size.h / 2 + dy, { ...drag.viewStart }, size.w, size.h)[0],
    };
    schedule();
    return;
  }
  if (drawing.value) schedule();
}

function onUp(e) {
  const kind = drag.kind;
  const moved = drag.moved;
  drag.kind = "";
  drag.vertexIndex = -1;
  drag.moved = false;
  if (props.readonly || !kind) return;
  if (kind !== "pan" || moved) return;

  const [x, y] = localPoint(e);
  const [lat, lng] = latLngAt(x, y);

  if (mode.value === "circle") {
    patch({ centerLat: lat, centerLng: lng });
    schedule();
    return;
  }
  drawing.value = true;
  const now = Date.now();
  if (now - lastClick.t < 350 && Math.hypot(x - lastClick.x, y - lastClick.y) < 8) {
    lastClick = { t: 0, x: 0, y: 0 };
    return;
  }
  lastClick = { t: now, x, y };
  // 正在画的是「最后一环」；多环（行政区）情形下点地图会新起一环
  const list = rings.value.slice();
  if (!list.length) list.push([]);
  list[list.length - 1] = [...list[list.length - 1], [lat, lng]];
  patch({ polygon: normalizePolygon(list.length === 1 ? list[0] : list) });
  schedule();
}

function onDoubleClick() {
  if (mode.value !== "polygon" || props.readonly) return;
  finishDraw();
}

/* ---------------- 对外动作 ---------------- */

function resetToChina() {
  view.value = fitView(CHINA_BOUNDS.value, size.w, size.h, 26);
  schedule();
}
function zoomIn() {
  view.value = { ...view.value, ...zoomAt(view.value, size.w / 2, size.h / 2, 1.4, size.w, size.h) };
  schedule();
}
function zoomOut() {
  view.value = { ...view.value, ...zoomAt(view.value, size.w / 2, size.h / 2, 0.7, size.w, size.h) };
  schedule();
}
/** 把一组点（围栏/行政区）铺满视口 */
function fitPoints(points, padding = 40) {
  view.value = fitView(points, size.w, size.h, padding);
  schedule();
}
function fitTarget() {
  const pts = props.highlights.length
    ? props.highlights.flatMap((h) => ringsOfPolygon(h.rings).flat())
    : rings.value.length >= 1 && rings.value[0].length >= 3
      ? rings.value.flat()
      : [center.value];
  fitPoints(pts, 60);
}
function startDraw() {
  drawing.value = true;
  patch({ mode: "polygon" });
  schedule();
}
function undoPoint() {
  const list = rings.value.slice();
  if (!list.length) return;
  list[list.length - 1] = list[list.length - 1].slice(0, -1);
  const kept = list.filter((r) => r.length);
  patch({ polygon: normalizePolygon(kept.length > 1 ? kept : kept[0] || []) });
  schedule();
}
function finishDraw() {
  drawing.value = false;
  const poly = normalizePolygon(polygon.value);
  const pc = polygonCenter(poly);
  patch({ mode: "polygon", polygon: poly, ...(pc ? { centerLat: pc[0], centerLng: pc[1] } : {}) });
  schedule();
}
function clearFence() {
  drawing.value = false;
  patch({ polygon: [] });
  schedule();
}
function loadRegion(r) {
  const poly = parsePolygon(r.polygon);
  drawing.value = false;
  const hasPoly = isValidPolygon(poly);
  const lat = Number(r.center_lat ?? r.centerLat ?? 30.262);
  const lng = Number(r.center_lng ?? r.centerLng ?? 120.133);
  patch({
    id: r.id,
    mode: hasPoly ? "polygon" : "circle",
    polygon: hasPoly ? normalizePolygon(poly) : [],
    centerLat: Number.isFinite(lat) ? lat : 30.262,
    centerLng: Number.isFinite(lng) ? lng : 120.133,
    radiusKm: Number(r.radius_km ?? r.radiusKm ?? 5),
  });
  fitPoints(hasPoly ? ringsOfPolygon(poly).flat() : [[lat, lng]], 70);
  emit("pick-region", r);
}

defineExpose({ resetToChina, zoomIn, zoomOut, fitTarget, fitPoints, startDraw, undoPoint, finishDraw, clearFence, loadRegion, toggleTiles });

/* ---------------- 生命周期 ---------------- */

let ro = null;
onMounted(() => {
  loadTilePref();
  ro = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    const first = !size.w;
    size.w = Math.round(box.width);
    size.h = Math.round(box.height);
    if (first) view.value = fitView(CHINA_BOUNDS.value, size.w, size.h, 26);
    schedule();
  });
  if (wrap.value) ro.observe(wrap.value);
});

onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  if (raf) cancelAnimationFrame(raf);
});

watch(() => props.model?.polygon, () => schedule(), { deep: true });
watch([mode, radiusKm, center, () => props.highlights], () => schedule(), { deep: true });
</script>

<template>
  <div ref="wrap" class="geo-wrap" data-geo-map :data-geo-state="viewState" :data-geo-basemap="basemapLabel">
    <canvas
      ref="canvas"
      class="geo-canvas"
      :style="{ cursor: readonly ? 'grab' : drag.kind === 'pan' ? 'grabbing' : drag.kind === 'vertex' ? 'move' : 'crosshair' }"
      @wheel="onWheel"
      @mousedown="onDown"
      @mousemove="onMove"
      @mouseup="onUp"
      @mouseleave="onUp"
      @dblclick="onDoubleClick"
      @contextmenu.prevent
    />
    <div class="geo-hud">
      <el-button-group size="small">
        <el-button data-act="zoom-in" title="放大" @click="zoomIn">＋</el-button>
        <el-button data-act="zoom-out" title="缩小" @click="zoomOut">－</el-button>
        <el-button data-act="china" title="回到全国视图" @click="resetToChina">全国</el-button>
        <el-button data-act="fit" title="缩放到当前围栏/已选行政区" @click="fitTarget">对准</el-button>
        <el-button data-act="tiles" :title="basemapLabel" @click="toggleTiles">{{ tilesOn ? "在线底图" : "离线底图" }}</el-button>
      </el-button-group>
      <span class="readout mono" data-geo-readout>
        {{ hover.lat != null ? hover.lat.toFixed(4) + ", " + hover.lng.toFixed(4) : "移动鼠标查看坐标" }}
      </span>
    </div>
    <div class="geo-tip">
      <template v-if="readonly">按行政区设置：地图只做预览，围栏 = 所选行政区边界的并集</template>
      <template v-else-if="mode === 'circle'">点地图设置圆心，半径用左侧输入框（km）</template>
      <template v-else-if="drawing">继续单击落点（双击闭合），顶点可拖动微调</template>
      <template v-else>点「绘制」后在地图上逐点勾出片区边界</template>
    </div>
  </div>
</template>

<style scoped>
.geo-wrap { position: relative; width: 100%; height: 520px; border: 1px solid var(--line, #e5e9f0); border-radius: 10px; overflow: hidden; background: #eef3fa; }
.geo-canvas { display: block; width: 100%; height: 100%; }
.geo-hud { position: absolute; left: 10px; top: 10px; display: flex; align-items: center; gap: 10px; background: rgba(255, 255, 255, 0.92); padding: 4px 8px; border-radius: 8px; box-shadow: 0 1px 4px rgba(20, 40, 80, 0.12); }
.geo-hud .readout { font-size: 11.5px; color: #4b5b72; }
.geo-tip { position: absolute; right: 10px; top: 10px; max-width: 300px; font-size: 11.5px; color: #4b5b72; background: rgba(255, 255, 255, 0.92); padding: 4px 8px; border-radius: 8px; }
</style>
