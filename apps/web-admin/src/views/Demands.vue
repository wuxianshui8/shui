<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const rows = ref([]);
const total = ref(0);
const regions = ref([]);
const query = reactive({ status: "", subject: "", stage: "", regionId: "", urgent: false, page: 1, pageSize: 20 });

const STATUS = {
  published: "招募中",
  paused: "已暂停",
  matched: "已匹配",
  cancelled: "已取消",
  closed: "已关闭",
};
const STAGES = ["小学", "初中", "高中"];
const SUBJECTS = ["语文", "数学", "英语", "物理", "化学", "生物"];

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.subject) params.set("subject", query.subject);
    if (query.stage) params.set("stage", query.stage);
    if (query.regionId) params.set("regionId", query.regionId);
    if (query.urgent) params.set("urgent", "1");
    params.set("page", query.page);
    params.set("pageSize", query.pageSize);
    const data = await api.get("/admin/demands?" + params.toString());
    rows.value = data.list || [];
    total.value = data.total || 0;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function loadRegions() {
  try {
    regions.value = await api.get("/admin/regions");
  } catch {
    regions.value = [];
  }
}

onMounted(() => {
  loadRegions();
  load();
});

function reset() {
  Object.assign(query, { status: "", subject: "", stage: "", regionId: "", urgent: false, page: 1 });
  load();
}

function onPage(p) {
  query.page = p;
  load();
}
</script>

<template>
  <div v-loading="loading">
    <div class="card">
      <h3>需求池（需求 4.5.3）</h3>
      <el-form :inline="true" size="small">
        <el-form-item label="状态">
          <el-select v-model="query.status" clearable placeholder="全部" style="width: 120px" @change="onPage(1)">
            <el-option v-for="(label, value) in STATUS" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="学段">
          <el-select v-model="query.stage" clearable placeholder="全部" style="width: 100px" @change="onPage(1)">
            <el-option v-for="s in STAGES" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="科目">
          <el-select v-model="query.subject" clearable placeholder="全部" style="width: 110px" @change="onPage(1)">
            <el-option v-for="s in SUBJECTS" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="片区">
          <el-select v-model="query.regionId" clearable placeholder="全部" style="width: 130px" @change="onPage(1)">
            <el-option v-for="r in regions" :key="r.id" :label="r.name" :value="String(r.id)" />
          </el-select>
        </el-form-item>
        <el-form-item label="加急">
          <el-switch v-model="query.urgent" @change="onPage(1)" />
        </el-form-item>
        <el-form-item>
          <el-button size="small" @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>共 {{ total }} 条需求</h3>
      <el-table :data="rows" border size="small">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="学段/科目" width="120">
          <template #default="{ row }">{{ row.stage }} · {{ row.subject }}</template>
        </el-table-column>
        <el-table-column prop="address" label="上课地址" min-width="180" show-overflow-tooltip />
        <el-table-column label="预算" width="110">
          <template #default="{ row }">{{ money(row.budget) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'published' ? 'success' : row.status === 'matched' ? 'warning' : 'info'">
              {{ row.statusText || STATUS[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报名" width="110">
          <template #default="{ row }">
            {{ row.applications }}<span class="muted">（待处理 {{ row.pendingApplications }}）</span>
          </template>
        </el-table-column>
        <el-table-column label="家长" width="160">
          <template #default="{ row }">
            {{ row.parentName || "-" }}<br /><span class="muted">{{ row.parentPhone }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="regionName" label="片区" width="110" />
        <el-table-column label="加急" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.urgent" size="small" type="danger">+{{ money(row.urgentFee) }}</el-tag>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="发布时间" width="180" />
      </el-table>
      <el-pagination
        style="margin-top: 12px; justify-content: flex-end"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="query.pageSize"
        :current-page="query.page"
        @current-change="onPage"
      />
    </div>
  </div>
</template>
