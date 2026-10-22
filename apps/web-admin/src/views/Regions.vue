<script setup>
/**
 * 区域管理（需求 5.5）：
 *   - 左侧：片区表单（名称/编码/中心/半径/围栏模式），中心点与半径可在右侧地图上点选
 *   - 右侧：中国地图（离线省级底图），直接在地图上勾出电子围栏多边形，顶点可拖动微调
 *   - 列表：已有片区叠加在地图上（灰色），点一行可载入继续编辑/新建
 */
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import GeoFenceMap from "../components/GeoFenceMap.vue";
import { isValidPolygon, normalizePolygon, polygonCenter, polygonRadiusKm } from "../geo-fence";

const loading = ref(false);
const saving = ref(false);
const rows = ref([]);
const mapRef = ref(null);
const editingId = ref(null);

/** 地图双向绑定：mode = polygon | circle */
const model = reactive({
  id: null,
  mode: "polygon",
  centerLat: 30.262,
  centerLng: 120.133,
  radiusKm: 5,
  polygon: [],
});

/** 表单（名称/编码与几何分开存，避免地图频繁写表单） */
const form = reactive({ name: "", code: "" });

const total = computed(() => rows.value.length);
const withPolygon = computed(() => rows.value.filter((r) => hasPolygon(r)).length);
const points = computed(() => (model.mode === "polygon" ? model.polygon.length : 0));

function hasPolygon(row) {
  const p = row.polygon;
  if (!p) return false;
  if (Array.isArray(p)) return p.length >= 3;
  try {
    const parsed = JSON.parse(p);
    return Array.isArray(parsed) && parsed.length >= 3;
  } catch {
    return false;
  }
}

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
  // 首屏固定显示「全国视图」：用户一眼能看到中国地图，再点列表某行放大到对应片区
  await nextTick();
  mapRef.value?.resetToChina();
});

/** 地图提示：绘制/加载后同步中心点与等效半径 */
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

function resetForm() {
  editingId.value = null;
  Object.assign(form, { name: "", code: "" });
  Object.assign(model, {
    id: null, mode: "polygon", centerLat: 30.262, centerLng: 120.133, radiusKm: 5, polygon: [],
  });
  mapRef.value?.resetToChina();
}

/** 点列表某行：载入到地图继续编辑（保存时会以「新建」提交，片区不提供在线改界面的接口） */
function loadRow(row) {
  editingId.value = row.id;
  form.name = row.name + "（副本）";
  form.code = "";
  mapRef.value?.loadRegion(row);
  ElMessage.info("已载入「" + row.name + "」的围栏，可改完另存为新片区");
}

async function submit() {
  try {
    if (!form.name.trim()) throw new Error("请填写片区名称");
    if (model.mode === "polygon" && !isValidPolygon(model.polygon)) {
      throw new Error("多边形围栏至少需要在地图上点 3 个顶点（也可切到「圆形围栏」）");
    }
    const polygon = model.mode === "polygon" ? normalizePolygon(model.polygon) : null;
    const body = {
      name: form.name.trim(),
      centerLat: Number(model.centerLat),
      centerLng: Number(model.centerLng),
      radiusKm: Number(model.radiusKm) || 5,
    };
    if (!Number.isFinite(body.centerLat) || !Number.isFinite(body.centerLng)) throw new Error("中心坐标不合法");
    if (form.code.trim()) body.code = form.code.trim();
    if (polygon) body.polygon = polygon;

    saving.value = true;
    const r = await api.post("/admin/regions", body);
    ElMessage.success(`片区已创建：${r.name}（${r.code}）` + (polygon ? `，多边形围栏 ${polygon.length} 点` : "，圆形围栏"));
    resetForm();
    await load();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    saving.value = false;
  }
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
      <div class="item"><div class="k">配置了电子围栏</div><div class="v">{{ withPolygon }}</div></div>
      <div class="item"><div class="k">仅圆形围栏</div><div class="v">{{ total - withPolygon }}</div></div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>新建片区（需求 5.5 区域管理）</h3>
      <div class="region-grid">
        <div class="region-form">
          <el-form label-width="96px" size="small">
            <el-form-item label="片区名称">
              <el-input v-model="form.name" placeholder="如：余杭片区" />
            </el-form-item>
            <el-form-item label="编码">
              <el-input v-model="form.code" placeholder="留空自动生成" />
            </el-form-item>
            <el-form-item label="围栏模式">
              <el-radio-group v-model="model.mode" size="small">
                <el-radio-button label="polygon" data-mode="polygon">多边形围栏</el-radio-button>
                <el-radio-button label="circle" data-mode="circle">圆形围栏</el-radio-button>
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
              <el-tag size="small" :type="points >= 3 ? 'success' : 'info'" data-fence-points>
                {{ model.mode === "polygon" ? points + " 个顶点" : "圆形（用中心+半径）" }}
              </el-tag>
            </el-form-item>
            <el-form-item>
              <el-button-group size="small">
                <el-button data-act="draw" @click="mapRef?.startDraw()">绘制多边形</el-button>
                <el-button data-act="undo" :disabled="!points" @click="mapRef?.undoPoint()">撤销顶点</el-button>
                <el-button data-act="finish" :disabled="points < 3" @click="mapRef?.finishDraw()">完成绘制</el-button>
                <el-button data-act="clear" @click="mapRef?.clearFence()">清空围栏</el-button>
              </el-button-group>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="saving" data-act="save" @click="submit">创建片区</el-button>
              <el-button @click="resetForm">重置</el-button>
            </el-form-item>
          </el-form>
          <div class="muted" style="line-height: 1.7">
            在地图上点「绘制多边形」后逐点单击勾边界（双击闭合），顶点可拖动微调；<br />
            切到「圆形围栏」时点地图设置圆心，半径用上面输入框。<br />
            片区用于订单归属、代理分成与教员派单半径：有围栏按「点在多边形内」判定，否则按「中心点 + 半径」。
          </div>
        </div>
        <GeoFenceMap
          ref="mapRef"
          class="region-map"
          :regions="rows"
          :model="model"
          @update:model="onModel"
        />
      </div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>片区列表（点一行可载入到地图）</h3>
      <el-table :data="rows" border size="small" @row-click="loadRow" row-style="cursor:pointer">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="片区名称" width="160" />
        <el-table-column label="编码" width="120">
          <template #default="{ row }">
            <el-button size="small" text @click.stop="copyCode(row)">{{ row.code }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="中心坐标" width="180">
          <template #default="{ row }">{{ row.center_lat }}, {{ row.center_lng }}</template>
        </el-table-column>
        <el-table-column label="半径" width="90">
          <template #default="{ row }">{{ row.radius_km }} km</template>
        </el-table-column>
        <el-table-column label="围栏" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="hasPolygon(row) ? 'success' : 'info'">
              {{ hasPolygon(row) ? "多边形围栏" : "圆形围栏" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="顶点数" width="90">
          <template #default="{ row }">
            <span class="mono">{{ hasPolygon(row) ? (typeof row.polygon === "string" ? JSON.parse(row.polygon).length : row.polygon.length) : "-" }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="180" />
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.region-grid { display: grid; grid-template-columns: 380px minmax(0, 1fr); gap: 16px; align-items: start; }
.region-form :deep(.el-form-item) { margin-bottom: 10px; }
.region-map { min-width: 0; }
@media (max-width: 1200px) {
  .region-grid { grid-template-columns: 1fr; }
}
</style>
