<script setup>
/**
 * 片区电子围栏编辑器（离线可用，不依赖任何地图瓦片服务）。
 *
 * 底图：随包分发的 34 个省级行政区 GeoJSON（`src/assets/china.geo.json`，取自
 * ECharts 4.9.0 的 map/json/china.json，Apache-2.0，已解码成标准 GeoJSON 并精简到 3 位小数）。
 * 为什么不用在线瓦片：容器与门禁常在无外网环境跑，瓦片挂掉就整页空白；
 * 而且围栏业务只需要「经纬度 ↔ 像素」的准确映射，不需要街道底图。
 *
 * 交互：
 * - 滚轮缩放（以鼠标位置为锚点）、按住拖拽平移、双击空白处放大
 * - 「绘制多边形」后逐点单击落点，双击或点「完成绘制」闭合；顶点可拖动微调
 * - 「圆形围栏」模式下直接在地图上点圆心，半径用左侧输入框（km）
 * - 已有片区以灰色叠加显示，点列表行可载入继续编辑
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import chinaGeo from "../assets/china.geo.json";
import {
  DEFAULT_VIEW, collectLngLats, fitView, isValidPolygon, lngFactor, normalizePolygon,
  polygonCenter, polygonRadiusKm, project, radiusToPixels, ringsOfGeometry, unproject, zoomAt,
} from "../geo-fence";

const props = defineProps({
  /** 已保存的片区：{ id, name, center_lat, center_lng, radius_km, polygon } */
  regions: { type: Array, default: () => [] },
  /** 双向绑定：{ id, mode, centerLat, centerLng, radiusKm, polygon } */
  model: { type: Object, required: true },
  readonly: { type: Boolean, default: false },
});
const emit = defineEmits(["update:model", "pick-region"]);

const wrap = ref(null);
const canvas = ref(null);
const size = reactive({ w: 0, h: 0 });
const view = ref({ ...DEFAULT_VIEW });
const drawing = ref(false); // 处于「逐点落点」状态
const drag = reactive({ kind: "", startX: 0, startY: 0, viewStart: null, vertexIndex: -1, moved: false });
const hover = reactive({ lat: null, lng: null });
const provinces = chinaGeo.features || [];
/** 省级标签锚点：数据里只有 name，取最大一块环的包围盒中心当标注位置 */
const PROVINCE_LABELS = provinces
  .map((f) => {
    const rings = ringsOfGeometry(f.geometry).filter((r) => r.length >= 3);
    if (!rings.length) return null;
    const ring = rings.reduce((a, b) => (b.length > a.length ? b : a), rings[0]);
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    return {
      name: f.properties?.name || "",
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    };
  })
  .filter((p) => p && p.name);
let ctx = null;
let raf = 0;
let lastClick = { t: 0, x: 0, y: 0 };

const mode = computed(() => props.model?.mode || "polygon");
const polygon = computed(() => (Array.isArray(props.model?.polygon) ? props.model.polygon : []));
const center = computed(() => [Number(props.model?.centerLat ?? 30.262), Number(props.model?.centerLng ?? 120.133)]);
const radiusKm = computed(() => Number(props.model?.radiusKm ?? 5));
const viewState = computed(
  () => `${mode.value}|${polygon.value.length}|${Number(view.value.centerLat).toFixed(4)},${Number(view.value.centerLng).toFixed(4)}|${Math.round(view.value.scale)}`,
);

/** 中国范围（用于「回到全国」按钮与初始 fit） */
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

  // 背景（海面/画布）
  ctx.fillStyle = "#f3f7fd";
  ctx.fillRect(0, 0, size.w, size.h);

  // 省界：填充国家版图 + 描边省界
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
  // 省名（缩得太小就不画，避免糊成一团）
  if (view.value.scale >= 6) {
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

  // 已有片区（灰色叠加，不算当前编辑的这个）
  for (const r of props.regions) {
    const poly = parsePolygon(r.polygon);
    const isCurrent = props.model?.id != null && r.id === props.model.id;
    if (isCurrent) continue;
    if (isValidPolygon(poly)) {
      drawPolygon(poly, { stroke: "rgba(90,110,140,.55)", fill: "rgba(120,140,170,.10)", dash: [4, 3] });
      labelAt(polygonCenter(poly), r.name || String(r.id), "rgba(70,90,120,.85)");
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
      labelAt([lat, lng], r.name || String(r.id), "rgba(70,90,120,.85)");
    }
  }

  // 当前编辑的围栏
  if (mode.value === "polygon" && polygon.value.length) {
    drawPolygon(polygon.value, { stroke: "#1f6feb", fill: "rgba(31,111,235,.14)", dash: [] });
    polygon.value.forEach(([lat, lng], i) => {
      const [x, y] = project(lng, lat, view.value, size.w, size.h);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = i === 0 ? "#e67700" : "#1f6feb";
      ctx.stroke();
    });
    const pc = polygonCenter(polygon.value);
    const label =
      "当前围栏 " + polygon.value.length + " 点" + (polygon.value.length >= 3 ? " · 等效半径 " + polygonRadiusKm(polygon.value) + "km" : "（还需 ≥3 点）");
    labelAt(pc, label, "#1f6feb");
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

  // 绘制中的橡皮筋
  if (drawing.value && polygon.value.length && hover.lat != null) {
    const last = polygon.value[polygon.value.length - 1];
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

  // 比例尺：横向与纵向的地面比例都是 111.32/scale（横向的 cos 与 lngFactor 互相抵消）
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

function drawPolygon(poly, style) {
  ctx.beginPath();
  poly.forEach(([lat, lng], i) => {
    const [x, y] = project(lng, lat, view.value, size.w, size.h);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 1.8;
  ctx.setLineDash(style.dash || []);
  ctx.stroke();
  ctx.setLineDash([]);
}

function labelAt(point, text, color) {
  if (!point) return;
  const [lat, lng] = point;
  const [x, y] = project(lng, lat, view.value, size.w, size.h);
  ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(255,255,255,.86)";
  ctx.fillRect(x - w / 2 - 4, y - 24, w + 8, 16);
  ctx.fillStyle = color;
  ctx.fillText(text, x - w / 2, y - 12);
}

/* ---------------- 交互 ---------------- */

function localPoint(e) {
  const rect = canvas.value.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

/** 屏幕坐标 → 规范化后的 [lat, lng]（6 位小数） */
function latLngAt(x, y) {
  const [lat, lng] = unproject(x, y, view.value, size.w, size.h);
  return [Number(lat.toFixed(6)), Number(lng.toFixed(6))];
}

function hitVertex(x, y) {
  if (mode.value !== "polygon") return -1;
  for (let i = 0; i < polygon.value.length; i++) {
    const [lat, lng] = polygon.value[i];
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
    const next = polygon.value.map((p, i) => (i === drag.vertexIndex ? latLngAt(x, y) : p));
    patch({ polygon: next });
    schedule();
    return;
  }
  if (drag.kind === "pan" && drag.viewStart) {
    const dx = x - drag.startX;
    const dy = y - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    const factor = lngFactor(drag.viewStart.centerLat);
    view.value = {
      ...view.value,
      centerLng: drag.viewStart.centerLng - dx / (view.value.scale * factor),
      centerLat: drag.viewStart.centerLat + dy / view.value.scale,
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
  // 拖动过（平移/挪顶点）就只是拖动，不当成落点
  if (kind !== "pan" || moved) return;

  const [x, y] = localPoint(e);
  const [lat, lng] = latLngAt(x, y);

  if (mode.value === "circle") {
    patch({ centerLat: lat, centerLng: lng });
    schedule();
    return;
  }
  if (!drawing.value) {
    // 未进入绘制状态时的单击：第一次点击自动进入绘制，手感更顺
    drawing.value = true;
  }
  // 双击会先触发两次 click，第二次是重复点，丢掉（否则闭合时多两个几乎重合的顶点）
  const now = Date.now();
  if (now - lastClick.t < 350 && Math.hypot(x - lastClick.x, y - lastClick.y) < 8) {
    lastClick = { t: 0, x: 0, y: 0 };
    return;
  }
  lastClick = { t: now, x, y };
  const next = [...polygon.value, [lat, lng]];
  patch({ polygon: normalizePolygon(next) });
  schedule();
}

function onDoubleClick() {
  if (mode.value !== "polygon" || props.readonly) return;
  finishDraw();
}

function finishDraw() {
  drawing.value = false;
  const poly = normalizePolygon(polygon.value);
  const pc = polygonCenter(poly);
  patch({ mode: "polygon", polygon: poly, ...(pc ? { centerLat: pc[0], centerLng: pc[1] } : {}) });
  schedule();
}

/* ---------------- 对外动作（由父组件按钮调用） ---------------- */

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
/** 缩放到当前围栏（没有多边形就对准圆心） */
function fitPolygon() {
  const pts = mode.value === "polygon" && polygon.value.length >= 3 ? polygon.value : [];
  view.value = pts.length ? fitView(pts, size.w, size.h, 70) : fitView([center.value], size.w, size.h, 70);
  schedule();
}
/** 缩放到已有片区的合集（列表为空则回到全国） */
function fitRegions() {
  const pts = props.regions.flatMap((r) => {
    const poly = parsePolygon(r.polygon);
    if (isValidPolygon(poly)) return poly;
    const lat = Number(r.center_lat ?? r.centerLat);
    const lng = Number(r.center_lng ?? r.centerLng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [[lat, lng]] : [];
  });
  view.value = pts.length ? fitView(pts, size.w, size.h, 70) : fitView(CHINA_BOUNDS.value, size.w, size.h, 26);
  schedule();
}
function startDraw() {
  drawing.value = true;
  patch({ mode: "polygon" });
  schedule();
}
function undoPoint() {
  if (!polygon.value.length) return;
  patch({ polygon: polygon.value.slice(0, -1) });
  schedule();
}
function clearFence() {
  drawing.value = false;
  patch({ polygon: [] });
  schedule();
}
/** 载入某个已保存片区到编辑器 */
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
  const pts = hasPoly ? normalizePolygon(poly) : [[lat, lng]];
  view.value = fitView(pts, size.w, size.h, 70);
  schedule();
  emit("pick-region", r);
}

defineExpose({ resetToChina, zoomIn, zoomOut, fitPolygon, fitRegions, startDraw, undoPoint, finishDraw, clearFence, loadRegion });

/* ---------------- 生命周期 ---------------- */

let ro = null;
onMounted(() => {
  ro = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    const first = !size.w;
    size.w = Math.round(box.width);
    size.h = Math.round(box.height);
    // 有了尺寸才能算 fit；首帧固定「全国视图」，用户一眼看到中国地图
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
watch([mode, radiusKm, center], () => schedule(), { deep: true });
</script>

<template>
  <div ref="wrap" class="geo-wrap" data-geo-map :data-geo-state="viewState">
    <canvas
      ref="canvas"
      class="geo-canvas"
      :style="{ cursor: drag.kind === 'pan' ? 'grabbing' : drag.kind === 'vertex' ? 'move' : 'crosshair' }"
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
        <el-button data-act="fit" title="缩放到当前围栏" @click="fitPolygon">对准围栏</el-button>
      </el-button-group>
      <span class="readout mono" data-geo-readout>
        {{ hover.lat != null ? hover.lat.toFixed(4) + ", " + hover.lng.toFixed(4) : "移动鼠标查看坐标" }}
        · 1°≈{{ Math.round(view.scale) }}px
      </span>
    </div>
    <div class="geo-tip">
      <template v-if="readonly">只读：审核/查看模式</template>
      <template v-else-if="mode === 'circle'">点地图设置圆心，半径用左侧输入框（km）</template>
      <template v-else-if="drawing">继续单击落点（双击闭合），顶点可拖动微调</template>
      <template v-else>点「绘制多边形」后在地图上逐点勾出片区边界</template>
    </div>
  </div>
</template>

<style scoped>
.geo-wrap { position: relative; width: 100%; height: 460px; border: 1px solid var(--line, #e5e9f0); border-radius: 10px; overflow: hidden; background: #f3f7fd; }
.geo-canvas { display: block; width: 100%; height: 100%; }
.geo-hud { position: absolute; left: 10px; top: 10px; display: flex; align-items: center; gap: 10px; background: rgba(255, 255, 255, 0.92); padding: 4px 8px; border-radius: 8px; box-shadow: 0 1px 4px rgba(20, 40, 80, 0.12); }
.geo-hud .readout { font-size: 11.5px; color: #4b5b72; }
.geo-tip { position: absolute; right: 10px; top: 10px; max-width: 300px; font-size: 11.5px; color: #4b5b72; background: rgba(255, 255, 255, 0.92); padding: 4px 8px; border-radius: 8px; }
</style>
