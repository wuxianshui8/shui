<script setup>
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const data = ref(null);

async function load() {
  loading.value = true;
  try {
    data.value = await api.get("/admin/overview");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <div class="kpi" v-if="data">
      <div class="item"><div class="k">注册用户</div><div class="v">{{ data.metrics.totalUsers }}</div></div>
      <div class="item"><div class="k">今日新增订单</div><div class="v">{{ data.metrics.todayOrders }}</div></div>
      <div class="item"><div class="k">本月 GMV</div><div class="v">{{ money(data.metrics.monthGmv) }}</div></div>
      <div class="item"><div class="k">平台净收入</div><div class="v">{{ money(data.metrics.revenue) }}</div></div>
      <div class="item"><div class="k">担保账户余额</div><div class="v">{{ money(data.metrics.escrow) }}</div></div>
      <div class="item"><div class="k">累计订单</div><div class="v">{{ data.metrics.totalOrders }}</div></div>
    </div>

    <div class="card" style="margin-top: 16px" v-if="data">
      <h3>待处理事项</h3>
      <div class="row">
        <el-tag type="warning">待审核教员 {{ data.pending.teachers }}</el-tag>
        <el-tag type="danger">待审退款 {{ data.pending.refunds }}</el-tag>
        <el-tag type="warning">待审提现 {{ data.pending.withdrawals }}</el-tag>
        <el-tag type="info">未结风险事件 {{ data.pending.riskEvents }}</el-tag>
      </div>
    </div>

    <div class="card" v-if="data">
      <h3>角色分布</h3>
      <el-table :data="data.roleCount" size="small" border>
        <el-table-column prop="role" label="角色" width="160" />
        <el-table-column prop="c" label="人数" width="120" />
        <el-table-column label="说明">
          <template #default="{ row }">
            <span class="muted">
              {{ { admin: "平台管理员", parent: "家长", teacher: "教员", sales: "业务员", agent: "区域代理" }[row.role] || row.role }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-button @click="load">刷新数据</el-button>
  </div>
</template>
