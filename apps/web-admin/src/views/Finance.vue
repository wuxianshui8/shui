<script setup>
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const fin = ref(null);

async function load() {
  loading.value = true;
  try {
    fin.value = await api.get("/admin/finance");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function runSettlement() {
  try {
    const r = await api.post("/admin/settlement/run", { force: true });
    ElMessage.success("结算完成 " + r.settled + " 笔，担保余额 " + money(r.escrowBalance));
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="kpi" v-if="fin">
      <div class="item"><div class="k">GMV（已支付）</div><div class="v">{{ money(fin.summary.totalGmv) }}</div></div>
      <div class="item"><div class="k">平台服务费</div><div class="v">{{ money(fin.summary.serviceFee) }}</div></div>
      <div class="item"><div class="k">代理分成</div><div class="v">{{ money(fin.summary.agentShare) }}</div></div>
      <div class="item"><div class="k">业务员提成</div><div class="v">{{ money(fin.summary.salesCommission) }}</div></div>
      <div class="item"><div class="k">平台净收入</div><div class="v">{{ money(fin.summary.revenue) }}</div></div>
      <div class="item"><div class="k">担保账户余额</div><div class="v">{{ money(fin.summary.escrow) }}</div></div>
      <div class="item"><div class="k">待结算课时费</div><div class="v">{{ money(fin.summary.pendingSettle) }}</div></div>
      <div class="item"><div class="k">钱包可用/冻结</div><div class="v small">{{ money(fin.summary.totalWallet) }} / {{ money(fin.summary.totalFrozen) }}</div></div>
      <div class="item"><div class="k">待审提现</div><div class="v">{{ money(fin.summary.withdrawPending) }}</div></div>
      <div class="item"><div class="k">待受理/已开票</div><div class="v small">{{ fin.summary.invoicePending }} / {{ fin.summary.invoiceIssued }}</div></div>
    </div>

    <div class="card" style="margin-top: 16px">
      <div class="row">
        <el-button type="primary" @click="runSettlement">立即执行 T+N 结算</el-button>
        <el-button @click="load">刷新</el-button>
      </div>
    </div>

    <div class="card" v-if="fin">
      <h3>担保台账（最近 60 笔）</h3>
      <el-table :data="fin.escrowLedger" size="small" border max-height="320">
        <el-table-column prop="order_id" label="订单" width="90" />
        <el-table-column prop="direction" label="方向" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.direction === 'in' ? 'success' : 'danger'">{{ row.direction === "in" ? "入账" : "出账" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="110">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="余额" width="120">
          <template #default="{ row }">{{ money(row.balance) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="240" />
        <el-table-column prop="created_at" label="时间" width="180" />
      </el-table>
    </div>
  </div>
</template>
