<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const rows = ref([]);
const total = ref(0);
const openCount = ref(0);
const loading = ref(false);
const filter = ref({ status: "", type: "", page: 1, pageSize: 50 });

const STATUS = { open: "待受理", processing: "处理中", replied: "已回复", closed: "已结案" };
const TYPE = {
  service: "服务态度", quality: "教学质量", safety: "安全问题", refund: "退款纠纷",
  fraud: "虚假信息", other: "其他",
};

async function load() {
  loading.value = true;
  try {
    const q = new URLSearchParams();
    if (filter.value.status) q.set("status", filter.value.status);
    if (filter.value.type) q.set("type", filter.value.type);
    q.set("page", String(filter.value.page));
    q.set("pageSize", String(filter.value.pageSize));
    const r = await api.get("/admin/complaints?" + q.toString());
    rows.value = r.list || [];
    total.value = Number(r.total || 0);
    openCount.value = Number(r.openCount || 0);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function handle(row, status) {
  try {
    const { value } = await ElMessageBox.prompt("处理说明（会记入工单与审计日志）", status === "replied" ? "回复工单" : "受理工单", {
      inputValue: row.handleNote || "",
      inputPlaceholder: "如：已电话联系双方，协商一致",
    });
    await api.post("/admin/complaints/" + row.id + "/handle", { status, note: value });
    ElMessage.success("已更新");
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}

async function close(row) {
  try {
    const { value } = await ElMessageBox.prompt("结案说明", "结案", { inputValue: row.handleNote || "平台终审结案" });
    await api.post("/admin/complaints/" + row.id + "/close", { note: value });
    ElMessage.success("已结案");
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div>
    <div class="card">
      <div class="row" style="margin-bottom: 12px; gap: 10px; flex-wrap: wrap">
        <el-select v-model="filter.status" placeholder="全部状态" clearable style="width: 150px" @change="filter.page = 1; load()">
          <el-option label="待受理" value="open" />
          <el-option label="处理中" value="processing" />
          <el-option label="已回复" value="replied" />
          <el-option label="已结案" value="closed" />
        </el-select>
        <el-select v-model="filter.type" placeholder="全部类型" clearable style="width: 160px" @change="filter.page = 1; load()">
          <el-option v-for="(v, k) in TYPE" :key="k" :label="v" :value="k" />
        </el-select>
        <el-button @click="load">刷新</el-button>
        <span class="muted">共 {{ total }} 条 · 未结案 {{ openCount }} 条</span>
      </div>

      <el-table :data="rows" size="small" border v-loading="loading">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="类型" width="110">
          <template #default="{ row }">{{ TYPE[row.type] || row.type }}</template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
        <el-table-column prop="content" label="内容" min-width="240" show-overflow-tooltip />
        <el-table-column label="投诉人" width="150">
          <template #default="{ row }">
            {{ row.fromName || "—" }}
            <span class="muted">（{{ row.fromRole }}）</span>
          </template>
        </el-table-column>
        <el-table-column label="关联订单" width="170">
          <template #default="{ row }">
            <span v-if="row.orderNo">{{ row.orderNo }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="regionName" label="片区" width="110" />
        <el-table-column label="状态" width="95">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'closed' ? 'info' : row.status === 'open' ? 'danger' : 'warning'">
              {{ row.statusText || STATUS[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="handleNote" label="处理说明" min-width="160" show-overflow-tooltip />
        <el-table-column prop="createdAt" label="提交时间" width="180" show-overflow-tooltip />
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text :disabled="row.status !== 'open'" @click="handle(row, 'processing')">受理</el-button>
            <el-button size="small" text :disabled="row.status === 'closed'" @click="handle(row, 'replied')">回复</el-button>
            <el-button size="small" text type="danger" :disabled="row.status === 'closed'" @click="close(row)">结案</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
