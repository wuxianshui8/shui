<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const rows = ref([]);
const summary = ref(null);

async function load() {
  loading.value = true;
  try {
    const fin = await api.get("/admin/finance");
    rows.value = fin.withdrawals || [];
    summary.value = fin.summary;
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
      await ElMessageBox.confirm("确认已线下打款 " + money(row.actual) + "（手续费 " + money(row.fee) + "）？", "提现审核", { type: "warning" });
      const r = await api.post("/admin/withdrawals/" + row.id + "/review", { approve: true });
      ElMessage.success("已打款：" + r.status);
    } else {
      const { value } = await ElMessageBox.prompt("驳回原因", "驳回提现", { inputValue: "收款信息不完整" });
      await api.post("/admin/withdrawals/" + row.id + "/review", { approve: false, reason: value });
      ElMessage.success("已驳回，金额退回余额");
    }
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}

const ROLE = { teacher: "教员", sales: "业务员", agent: "代理" };
</script>

<template>
  <div v-loading="loading">
    <div class="kpi" v-if="summary">
      <div class="item"><div class="k">待审提现总额</div><div class="v">{{ money(summary.withdrawPending) }}</div></div>
      <div class="item"><div class="k">钱包可用合计</div><div class="v">{{ money(summary.totalWallet) }}</div></div>
      <div class="item"><div class="k">冻结池合计</div><div class="v">{{ money(summary.totalFrozen) }}</div></div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>提现审核（需求 5.4）</h3>
      <el-table :data="rows" border size="small">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="申请人" width="150">
          <template #default="{ row }">{{ row.nickname }}（{{ ROLE[row.role] || row.role }}）</template>
        </el-table-column>
        <el-table-column label="申请金额" width="110">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="手续费" width="100">
          <template #default="{ row }">{{ money(row.fee) }}</template>
        </el-table-column>
        <el-table-column label="实付" width="110">
          <template #default="{ row }">{{ money(row.actual) }}</template>
        </el-table-column>
        <el-table-column prop="account" label="收款账号（脱敏）" width="160" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'paid' ? 'success' : row.status === 'rejected' ? 'info' : 'warning'">
              {{ { pending: "待审核", paid: "已打款", rejected: "已驳回" }[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="申请时间" width="180" />
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button size="small" type="primary" @click="review(row, true)">通过打款</el-button>
              <el-button size="small" text type="danger" @click="review(row, false)">驳回</el-button>
            </template>
            <span v-else class="muted">已处理</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
