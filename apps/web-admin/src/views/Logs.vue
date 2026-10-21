<script setup>
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

const loading = ref(false);
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);

async function load() {
  loading.value = true;
  try {
    const data = await api.get("/admin/audit-logs?page=" + page.value + "&pageSize=" + pageSize.value);
    rows.value = data.list;
    total.value = data.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <div class="card">
    <h3>操作日志（全链路留痕）</h3>
    <el-table :data="rows" v-loading="loading" size="small" border>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="action" label="动作" width="220" />
      <el-table-column label="操作人" width="150">
        <template #default="{ row }">{{ row.nickname || row.actor_id || "-" }}（{{ row.actor_role || "-" }}）</template>
      </el-table-column>
      <el-table-column prop="target" label="对象" width="200" />
      <el-table-column prop="detail" label="详情" min-width="280" show-overflow-tooltip />
      <el-table-column prop="ip" label="IP" width="140" />
      <el-table-column prop="created_at" label="时间" width="190" />
    </el-table>
    <el-pagination
      style="margin-top: 14px"
      layout="total, prev, pager, next"
      :total="total"
      v-model:current-page="page"
      v-model:page-size="pageSize"
      @current-change="load"
    />
  </div>
</template>
