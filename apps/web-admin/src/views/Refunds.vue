<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const rows = ref([]);

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get("/admin/refunds");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function review(row, approve) {
  try {
    let reason;
    if (!approve) {
      const r = await ElMessageBox.prompt("请填写驳回原因", "驳回退款", { confirmButtonText: "确认驳回" });
      reason = r.value;
    } else {
      await ElMessageBox.confirm("批准后将原路退回担保资金 " + money(row.amount + row.urgentFee) + "，确认？", "批准退款", { type: "warning" });
    }
    const res = await api.post("/admin/refunds/" + row.id + "/review", { approve, reason });
    ElMessage.success("处理完成：" + res.status);
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div class="card">
    <h3>退款工单</h3>
    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="orderNo" label="订单号" width="190" />
      <el-table-column label="家长" width="140">
        <template #default="{ row }">{{ row.parent?.nickname || "-" }}</template>
      </el-table-column>
      <el-table-column label="金额" width="110">
        <template #default="{ row }">{{ money(row.amount + row.urgentFee) }}</template>
      </el-table-column>
      <el-table-column prop="cancelReason" label="退款原因" min-width="180" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'refunded' ? 'success' : 'warning'">{{ row.statusText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status === 'refunding'">
            <el-button size="small" type="primary" @click="review(row, true)">批准退款</el-button>
            <el-button size="small" text type="danger" @click="review(row, false)">驳回</el-button>
          </template>
          <span v-else class="muted">已处理</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
