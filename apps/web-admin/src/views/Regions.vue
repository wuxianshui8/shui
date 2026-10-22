<script setup>
/**
 * 区域管理（需求 5.5）：两种设置方式，右侧始终是地图预览。
 *
 *   ① 按地图设置：在地图上逐点画多边形（顶点可拖动微调）/ 圆形围栏 + 中心点半径
 *   ② 按行政区设置：输入地名（如「张北县」「杭州」「浙江」）→ 勾选候选行政区 →
 *      选定边界的并集就是这个片区的电子围栏（多环），地图上蓝色高亮预览
 *
 * 为什么保留两种：行政区边界适合「按标准区划划片」，手绘适合「按商圈/学区自定义」，
 * 判定逻辑一致（点落在围栏内即属于该片区，否则退化为「中心点 + 半径」）。
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import GeoFenceMap from "../components/GeoFenceMap.vue";
import { isValidPolygon, normalizePolygon, polygonCenter, polygonRadiusKm, ringsOfPolygon } from "../geo-fence";

const loading = ref(false);
const saving = ref(false);
const rows = ref([]);
const mapRef = ref(null);

/** 设置方式：map=按地图设置（手绘） / admin=按行政区设置 */
const setupMode = ref("admin");

/* ---------------- 按地图设置 ---------------- */

const model = reactive({
  id: null,
  mode: "polygon", // polygon | circle（手绘方式内部的围栏形状）
  centerLat: 30.262,
  centerLng: 120.133,
  radiusKm: 5,
  polygon: [],
});

/* ---------------- 按行政区设置 ---------------- */

const query = ref("");
const searching = ref(false);
const candidates = ref([]); // [{ code, name, short, level, center, points }]
const selectedCodes = ref([]);
const highlights = ref([]); // [{ code, name, center, rings }]
const dataset = reactive({ count: 0, levels: {}, error: "" });

const LEVEL_LABEL = { province: "省级", city: "地级市", district: "区县" };
const hasPolygon = (row) => {
  const p = row.polygon;
  if (!p) return false;
  const rings = ringsOfPolygon(typeof p === "string" ? safeParse(p) : p);
  return rings.some((r) => r.length >= 3);
};
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function ringCount(row) {
  const p = typeof row.polygon === "string" ? safeParse(row.polygon) : row.polygon;
  return ringsOfPolygon(p).filter((r) => r.length >= 3).length;
}
function pointCount(row) {
  const p = typeof row.polygon === "string" ? safeParse(row.polygon) : row.polygon;
  return ringsOfPolygon(p).reduce((s, r) => s + r.length, 0);
}

/* ---------------- 表单 ---------------- */

const form = reactive({ name: "", code: "" });

const total = computed(() => rows.value.length);
const mapCount = computed(() => rows.value.filter((r) => !r.adminCodes || !r.adminCodes.length).length);
const adminCount = computed(() => rows.value.length - mapCount.value);
const selectedNames = computed(() =>
  selectedCodes.value.map((c) => candidates.value.find((a) => a.code === c)?.name || String(c)),
);
const pointsInEditor = computed(() =>
  model.mode === "polygon" ? ringsOfPolygon(model.polygon).reduce((s, r) => s + r.length, 0) : 0,
);

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get("/admin/regions");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  await nextTick();
  // 首屏给一张全国视图；有片区时点「对准」或点列表行再放大
  mapRef.value?.resetToChina();
  // 拿一次数据集状态，页面上说明「内置多少个行政区」
  try {
    const res = await api.get("/admin/regions/areas?q=");
    if (res?.dataset) Object.assign(dataset, res.dataset);
  } catch {
    /* 空查询不返回候选，只用于探数据集状态 */
  }
});

/* ---------------- 搜索与选择 ---------------- */

async function search() {
  const q = query.value.trim();
  if (!q) {
    candidates.value = [];
    return;
  }
  searching.value = true;
  try {
    const res = await api.get("/admin/regions/areas?q=" + encodeURIComponent(q));
    candidates.value = res.list || [];
    if (res.dataset) Object.assign(dataset, res.dataset);
    if (!candidates.value.length) {
      ElMessage.warning(
        "没有匹配的行政区" + (dataset.error ? "：" + dataset.error : "。可用「按地图设置」手绘，或运行 node tools/build-admin-areas.mjs 扩充数据"),
      );
    }
    // 已选中但不在这次结果里的，保留勾选状态（候选列表合并显示）
    for (const code of selectedCodes.value) {
      if (!candidates.value.some((a) => a.code === code)) {
        const old = highlights.value.find((h) => h.code === code);
        if (old) candidates.value.push({ code: old.code, name: old.name, level: "district", points: 0, center: old.center });
      }
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    searching.value = false;
  }
}

/** 拉选中行政区的边界（含 rings），用于地图高亮与提交前的预览 */
async function loadHighlights() {
  if (!selectedCodes.value.length) {
    highlights.value = [];
    return;
  }
  try {
    const res = await api.get("/admin/regions/areas?codes=" + selectedCodes.value.join(","));
    highlights.value = (res.list || []).map((a) => ({ code: a.code, name: a.name, center: a.center, rings: a.rings }));
    if (!form.name.trim()) form.name = highlights.value.map((h) => h.name).join("、");
    await nextTick();
    mapRef.value?.fitPoints(highlights.value.flatMap((h) => ringsOfPolygon(h.rings).flat()), 40);
  } catch (e) {
    ElMessage.error(e.message);
  }
}

watch(selectedCodes, loadHighlights, { deep: true });

/* ---------------- 提交 ---------------- */

async function submit() {
  try {
    if (!form.name.trim()) throw new Error("请填写片区名称（选行政区时会自动填）");
    const body = { name: form.name.trim() };
    if (form.code.trim()) body.code = form.code.trim();

    if (setupMode.value === "admin") {
      if (!selectedCodes.value.length) throw new Error("请先用地名搜索并勾选至少一个行政区");
      body.adminCodes = selectedCodes.value.slice();
      saving.value = true;
      const r = await api.post("/admin/regions", body);
      ElMessage.success(
        `片区已创建：${r.name}（${r.code}），按行政区：${(r.adminNames || []).join("、")}`,
      );
    } else {
      if (model.mode === "polygon" && !isValidPolygon(model.polygon)) {
        throw new Error("多边形围栏至少需要在地图上点 3 个顶点（也可切到「圆形围栏」）");
      }
      const polygon = model.mode === "polygon" ? normalizePolygon(model.polygon) : null;
      body.centerLat = Number(model.centerLat);
      body.centerLng = Number(model.centerLng);
      body.radiusKm = Number(model.radiusKm) || 5;
      if (!Number.isFinite(body.centerLat) || !Number.isFinite(body.centerLng)) throw new Error("中心坐标不合法");
      if (polygon) body.polygon = polygon;
      saving.value = true;
      const r = await api.post("/admin/regions", body);
      ElMessage.success(
        `片区已创建：${r.name}（${r.code}）` + (polygon ? `，多边形围栏 ${pointCount({ polygon })} 点` : "，圆形围栏"),
      );
    }
    resetForm();
    await load();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    saving.value = false;
  }
}

function resetForm() {
  Object.assign(form, { name: "", code: "" });
  Object.assign(model, { id: null, mode: "polygon", centerLat: 30.262, centerLng: 120.133, radiusKm: 5, polygon: [] });
  candidates.value = [];
  selectedCodes.value = [];
  highlights.value = [];
  query.value = "";
  mapRef.value?.resetToChina();
}

/** 地图手绘：绘制/加载后同步中心点与等效半径 */
function onModel(next) {
  const polygonChanged = JSON.stringify(next.polygon) !== JSON.stringify(model.polygon);
  Object.assign(model, next);
  if (next.mode === "polygon" && polygonChanged && isValidPolygon(next.polygon)) {
    const c = polygonCenter(next.polygon);
    if (c) {
      model.centerLat = c[0];
      model.centerLng = c[1];
    }
    const r = polygonRadiusKm(next.polygon);
    if (r > 0) model.radiusKm = Math.min(80, Math.max(0.5, Number(r.toFixed(1))));
  }
}

/** 点列表某行：载入到地图继续编辑/预览 */
function loadRow(row) {
  if (row.adminCodes && row.adminCodes.length) {
    setupMode.value = "admin";
    selectedCodes.value = row.adminCodes.slice();
    candidates.value = (row.adminNames || []).map((name, i) => ({
      code: row.adminCodes[i],
      name,
      level: "district",
      points: 0,
      center: [Number(row.center_lat), Number(row.center_lng)],
    }));
    form.name = row.name + "（副本）";
    form.code = "";
    ElMessage.info("已载入「" + row.name + "」的行政区，可改完另存为新片区");
    return;
  }
  setupMode.value = "map";
  form.name = row.name + "（副本）";
  form.code = "";
  mapRef.value?.loadRegion(row);
  ElMessage.info("已载入「" + row.name + "」的围栏，可改完另存为新片区");
}

async function copyCode(row) {
  try {
    await navigator.clipboard.writeText(row.code);
    ElMessage.success("片区编码已复制：" + row.code);
  } catch {
    ElMessage.info("片区编码：" + row.code);
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="kpi">
      <div class="item"><div class="k">片区总数</div><div class="v">{{ total }}</div></div>
      <div class="item"><div class="k">按行政区设置</div><div class="v">{{ adminCount }}</div></div>
      <div class="item"><div class="k">按地图设置</div><div class="v">{{ mapCount }}</div></div>
      <div class="item">
        <div class="k">内置行政区</div>
        <div class="v">{{ dataset.count || "-" }}</div>
      </div>
    </div>

    <div class="card" style="margin-top: 16px">
      <div class="mode-row">
        <el-radio-group v-model="setupMode" data-setup-mode>
          <el-radio-button label="map" data-mode="map">按地图设置</el-radio-button>
          <el-radio-button label="admin" data-mode="admin">按行政区设置</el-radio-button>
        </el-radio-group>
        <span class="muted" style="margin-left: 12px; line-height: 1.7">
          {{ setupMode === "admin"
            ? "输入地名（省/市/区县）→ 勾选 → 提交；围栏 = 所选行政区边界的并集"
            : "在地图上画多边形或圆，适合按商圈/学区自定义" }}
        </span>
      </div>

      <div class="region-grid">
        <!-- 左栏：表单 -->
        <div class="region-form">
          <el-form label-width="86px" size="small">
            <el-form-item label="片区名称">
              <el-input v-model="form.name" placeholder="如：张北县片区" data-field="name" />
            </el-form-item>
            <el-form-item label="编码">
              <el-input v-model="form.code" placeholder="留空自动生成" data-field="code" />
            </el-form-item>

            <!-- 按行政区设置 -->
            <template v-if="setupMode === 'admin'">
              <el-form-item label="地名">
                <div class="search-row">
                  <el-input
                    v-model="query"
                    placeholder="输入地名，如：张北县 / 杭州 / 浙江"
                    clearable
                    data-field="area-query"
                    @keyup.enter="search"
                  />
                  <el-button :loading="searching" type="primary" plain data-act="area-search" @click="search">搜索</el-button>
                </div>
              </el-form-item>
              <el-form-item label="候选">
                <div class="area-box" data-area-box>
                  <el-checkbox-group v-model="selectedCodes">
                    <el-checkbox v-for="a in candidates" :key="a.code" :label="a.code" :data-area-code="a.code" class="area-item">
                      <span>{{ a.name }}</span>
                      <span class="muted"> · {{ LEVEL_LABEL[a.level] || a.level }} · {{ a.points }} 点</span>
                    </el-checkbox>
                  </el-checkbox-group>
                  <div v-if="!candidates.length" class="muted">先输入地名再搜索（内置省级 + 地级市，区县按需导入）</div>
                </div>
              </el-form-item>
              <el-form-item label="已选">
                <div data-area-selected>
                  <el-tag v-for="name in selectedNames" :key="name" class="area-tag" type="success">{{ name }}</el-tag>
                  <span v-if="!selectedNames.length" class="muted">未选择</span>
                </div>
              </el-form-item>
            </template>

            <!-- 按地图设置 -->
            <template v-else>
              <el-form-item label="围栏形状">
                <el-radio-group v-model="model.mode" size="small">
                  <el-radio-button label="polygon" data-mode="polygon">多边形</el-radio-button>
                  <el-radio-button label="circle" data-mode="circle">圆形</el-radio-button>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="中心纬度">
                <el-input v-model.number="model.centerLat" type="number" data-field="centerLat" />
              </el-form-item>
              <el-form-item label="中心经度">
                <el-input v-model.number="model.centerLng" type="number" data-field="centerLng" />
              </el-form-item>
              <el-form-item label="半径(km)">
                <el-input v-model.number="model.radiusKm" type="number" data-field="radiusKm" />
              </el-form-item>
              <el-form-item label="围栏顶点">
                <el-tag size="small" :type="pointsInEditor >= 3 ? 'success' : 'info'" data-fence-points>
                  {{ model.mode === "polygon" ? pointsInEditor + " 个顶点" : "圆形（用中心+半径）" }}
                </el-tag>
              </el-form-item>
              <el-form-item>
                <el-button-group size="small">
                  <el-button data-act="draw" @click="mapRef?.startDraw()">绘制</el-button>
                  <el-button data-act="undo" :disabled="!pointsInEditor" @click="mapRef?.undoPoint()">撤销顶点</el-button>
                  <el-button data-act="finish" :disabled="pointsInEditor < 3" @click="mapRef?.finishDraw()">完成绘制</el-button>
                  <el-button data-act="clear" @click="mapRef?.clearFence()">清空</el-button>
                </el-button-group>
              </el-form-item>
            </template>

            <el-form-item>
              <el-button type="primary" :loading="saving" data-act="save" @click="submit">提交</el-button>
              <el-button @click="resetForm">重置</el-button>
            </el-form-item>
          </el-form>
          <div class="muted" style="line-height: 1.7">
            片区用于订单归属、代理分成与教员派单半径：<br />
            有围栏时按「点是否落在围栏内」判定，否则按「中心点 + 半径」。
          </div>
        </div>

        <!-- 右栏：地图 -->
        <GeoFenceMap
          ref="mapRef"
          class="region-map"
          :regions="rows"
          :model="model"
          :highlights="highlights"
          :readonly="setupMode === 'admin'"
          @update:model="onModel"
        />
      </div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>片区列表（点一行可载入到地图）</h3>
      <el-table :data="rows" border size="small" row-style="cursor:pointer" @row-click="loadRow">
        <el-table-column prop="id" label="ID" width="64" />
        <el-table-column prop="name" label="片区名称" width="170" />
        <el-table-column label="编码" width="110">
          <template #default="{ row }">
            <el-button size="small" text @click.stop="copyCode(row)">{{ row.code }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="设置方式" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.adminCodes && row.adminCodes.length" size="small" type="success">按行政区</el-tag>
            <el-tag v-else size="small" type="info">按地图</el-tag>
            <div v-if="row.adminNames && row.adminNames.length" class="muted">{{ row.adminNames.join("、") }}</div>
          </template>
        </el-table-column>
        <el-table-column label="中心坐标" width="170">
          <template #default="{ row }">{{ Number(row.center_lat).toFixed(4) }}, {{ Number(row.center_lng).toFixed(4) }}</template>
        </el-table-column>
        <el-table-column label="半径" width="80">
          <template #default="{ row }">{{ row.radius_km }} km</template>
        </el-table-column>
        <el-table-column label="围栏" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="hasPolygon(row) ? 'success' : 'info'">
              {{ hasPolygon(row) ? "多边形 " + ringCount(row) + " 环" : "圆形" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="顶点数" width="90">
          <template #default="{ row }">
            <span class="mono">{{ hasPolygon(row) ? pointCount(row) : "-" }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="180" />
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.mode-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.region-grid { display: grid; grid-template-columns: 400px minmax(0, 1fr); gap: 16px; align-items: start; }
.region-form :deep(.el-form-item) { margin-bottom: 10px; }
.region-map { min-width: 0; }
.search-row { display: flex; gap: 8px; width: 100%; }
.area-box { width: 100%; max-height: 220px; overflow: auto; border: 1px solid var(--line, #e5e9f0); border-radius: 8px; padding: 8px 10px; background: #fff; }
.area-box :deep(.el-checkbox) { display: flex; margin-right: 0; height: 26px; }
.area-item { width: 100%; }
.area-tag { margin: 0 6px 6px 0; }
@media (max-width: 1200px) {
  .region-grid { grid-template-columns: 1fr; }
}
</style>
