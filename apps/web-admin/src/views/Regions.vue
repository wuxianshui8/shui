<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

const loading = ref(false);
const rows = ref([]);

const form = reactive({
  name: "",
  code: "",
  centerLat: 30.262,
  centerLng: 120.133,
  radiusKm: 5,
  polygon: "",
});

const total = computed(() => rows.value.length);
const withPolygon = computed(() => rows.value.filter((r) => r.polygon).length);

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
onMounted(load);

function parsePolygon(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let poly;
  try {
    poly = JSON.parse(raw);
  } catch {
    throw new Error("围栏 JSON 解析失败，示例：[[30.28,120.12],[30.28,120.16],[30.24,120.16]]");
  }
  if (!Array.isArray(poly) || poly.length < 3) throw new Error("围栏至少需要 3 个顶点");
  const ok = poly.every(
    (p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(Number(n))),
  );
  if (!ok) throw new Error("围栏顶点格式应为 [[lat,lng], …]");
  return poly;
}

async function submit() {
  try {
    if (!form.name.trim()) throw new Error("请填写片区名称");
    const polygon = parsePolygon(form.polygon);
    const body = {
      name: form.name.trim(),
      centerLat: Number(form.centerLat),
      centerLng: Number(form.centerLng),
      radiusKm: Number(form.radiusKm),
    };
    if (form.code.trim()) body.code = form.code.trim();
    if (polygon) body.polygon = polygon;
    const r = await api.post("/admin/regions", body);
    ElMessage.success("片区已创建：" + r.name + "（" + r.code + "）");
    Object.assign(form, { name: "", code: "", polygon: "" });
    load();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  }
}

async function toggle(item) {
  try {
    await navigator.clipboard.writeText(item.code);
    ElMessage.success("片区编码已复制：" + item.code);
  } catch {
    ElMessage.info("片区编码：" + item.code);
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
      <el-form :inline="true" size="small">
        <el-form-item label="片区名称">
          <el-input v-model="form.name" placeholder="如：余杭片区" style="width: 150px" />
        </el-form-item>
        <el-form-item label="编码">
          <el-input v-model="form.code" placeholder="留空自动生成" style="width: 130px" />
        </el-form-item>
        <el-form-item label="中心维度">
          <el-input v-model="form.centerLat" style="width: 110px" />
        </el-form-item>
        <el-form-item label="中心经度">
          <el-input v-model="form.centerLng" style="width: 110px" />
        </el-form-item>
        <el-form-item label="半径(km)">
          <el-input v-model="form.radiusKm" style="width: 90px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="submit">创建片区</el-button>
        </el-form-item>
      </el-form>
      <el-form size="small">
        <el-form-item label="电子围栏（可选，JSON 顶点数组）">
          <el-input
            v-model="form.polygon"
            type="textarea"
            :rows="2"
            placeholder="[[30.28,120.12],[30.28,120.16],[30.24,120.16]]"
          />
        </el-form-item>
      </el-form>
      <div class="muted">
        片区用于订单归属、代理分成与教员派单半径；未配置围栏时按「中心点 + 半径」判定归属。
      </div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>片区列表</h3>
      <el-table :data="rows" border size="small">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="片区名称" width="140" />
        <el-table-column label="编码" width="120">
          <template #default="{ row }">
            <el-button size="small" text @click="toggle(row)">{{ row.code }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="中心坐标" width="180">
          <template #default="{ row }">{{ row.center_lat }}, {{ row.center_lng }}</template>
        </el-table-column>
        <el-table-column label="半径" width="90">
          <template #default="{ row }">{{ row.radius_km }} km</template>
        </el-table-column>
        <el-table-column label="围栏类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.polygon ? 'success' : 'info'">
              {{ row.polygon ? "多边形围栏" : "圆形围栏" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="180" />
      </el-table>
    </div>
  </div>
</template>
