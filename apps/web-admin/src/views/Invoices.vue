<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const rows = ref([]);

async function load() {
  loading.value = true;
  try {
    const fin = await api.get("/admin/finance");
    rows.value = fin.invoices || [];
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function review(row, approve) {
  try {
    if (approve) {
      const { value } = await ElMessageBox.prompt("电子发票下载地址（可留空）", "受理开票：" + row.invoice_no, {
        inputValue: "https://example.com/fp/" + row.invoice_no + ".pdf",
      });
      const r = await api.post("/admin/invoices/" + row.id + "/review", { approve: true, invoiceUrl: value });
      ElMessage.success("已开票：" + r.status);
    } else {
      const { value } = await ElMessageBox.prompt("驳回原因（必填）", "驳回开票：" + row.invoice_no, { inputValue: "抬头需与实名一致" });
      await api.post("/admin/invoices/" + row.id + "/review", { approve: false, rejectReason: value });
      ElMessage.success("已驳回");
    }
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}

const STATUS = { pending: "待受理", issued: "已开票", rejected: "已驳回" };
</script>

<template>
  <div class="card">
    <h3>发票受理（需求 4.1.6）</h3>
    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="invoice_no" label="申请单号" width="190" />
      <el-table-column prop="order_no" label="订单号" width="180" />
      <el-table-column prop="nickname" label="申请人" width="130" />
      <el-table-column label="抬头" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          {{ row.title }}
          <span class="muted">（{{ row.title_type === "company" ? "企业" : "个人" }}{{ row.tax_no ? " · " + row.tax_no : "" }}）</span>
        </template>
      </el-table-column>
      <el-table-column label="金额" width="110">
        <template #default="{ row }">{{ money(row.amount) }}</template>
      </el-table-column>
      <el-table-column prop="email" label="邮箱" width="180" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'issued' ? 'success' : row.status === 'rejected' ? 'info' : 'warning'">
            {{ STATUS[row.status] || row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="reject_reason" label="驳回原因" min-width="160" show-overflow-tooltip />
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status === 'pending'">
            <el-button size="small" type="primary" @click="review(row, true)">开票</el-button>
            <el-button size="small" text type="danger" @click="review(row, false)">驳回</el-button>
          </template>
          <span v-else class="muted">已受理</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
