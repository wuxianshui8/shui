<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const rows = ref([]);
const detail = ref(null);
const depForm = reactive({ direction: "in", amount: 50000, remark: "" });

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get("/admin/agents");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function open(row) {
  try {
    detail.value = await api.get("/admin/agents/" + row.user_id);
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function toggle(row) {
  try {
    const r = await api.post("/admin/agents/" + row.user_id + "/toggle");
    ElMessage.success("代理状态：" + r.status);
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function deposit() {
  try {
    await api.post("/admin/agents/" + detail.value.agent.userId + "/deposit", {
      direction: depForm.direction,
      amount: Number(depForm.amount),
      remark: depForm.remark,
    });
    ElMessage.success("保证金操作成功");
    open({ user_id: detail.value.agent.userId });
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function editRates(row) {
  try {
    const { value } = await ElMessageBox.prompt("服务费分成比例（0~1）", "调整分成", { inputValue: String(row.commission_rate) });
    const rate = Number(value);
    if (!(rate >= 0 && rate <= 1)) return ElMessage.error("比例需在 0~1 之间");
    await api.put("/admin/agents/" + row.user_id, { commissionRate: rate });
    ElMessage.success("已更新分成比例");
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div>
    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="user_id" label="ID" width="70" />
      <el-table-column prop="nickname" label="代理" width="160" />
      <el-table-column prop="phone" label="手机号" width="130" />
      <el-table-column prop="regionName" label="片区" width="140" />
      <el-table-column prop="level" label="等级" width="80" />
      <el-table-column label="服务费分成" width="110">
        <template #default="{ row }">{{ (row.commission_rate * 100).toFixed(0) }}%</template>
      </el-table-column>
      <el-table-column label="管理提成" width="110">
        <template #default="{ row }">{{ (row.mgmt_rate * 100).toFixed(1) }}%</template>
      </el-table-column>
      <el-table-column label="保证金" width="120">
        <template #default="{ row }">{{ money(row.deposit) }}</template>
      </el-table-column>
      <el-table-column label="业务员/累计分成" width="150">
        <template #default="{ row }">{{ row.salesCount }} 人 / {{ money(row.totalShare) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === "active" ? "启用" : "禁用" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="open(row)">详情</el-button>
          <el-button size="small" text @click="editRates(row)">调分成</el-button>
          <el-button size="small" text :type="row.status === 'active' ? 'danger' : 'primary'" @click="toggle(row)">
            {{ row.status === "active" ? "禁用" : "启用" }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-drawer v-model="detail" :with-header="true" size="520px" title="代理详情">
      <template v-if="detail">
        <div class="card">
          <h3>考核完成度</h3>
          <div class="muted">
            本月 GMV {{ money(detail.assessment.monthGmv) }} / 目标 {{ money(detail.assessment.targets.monthly_gmv_target) }}（{{ detail.assessment.gmvRate }}%）<br />
            本月订单 {{ detail.assessment.monthOrders }} / {{ detail.assessment.targets.monthly_orders_target }}（{{ detail.assessment.orderRate }}%）<br />
            活跃业务员 {{ detail.assessment.salesCount }} / {{ detail.assessment.targets.active_sales_target }}（{{ detail.assessment.salesRate }}%）
          </div>
        </div>
        <div class="card">
          <h3>保证金台账</h3>
          <div class="row" style="margin-bottom: 10px">
            <el-select v-model="depForm.direction" style="width: 110px">
              <el-option label="缴纳" value="in" />
              <el-option label="退还" value="out" />
            </el-select>
            <el-input-number v-model="depForm.amount" :min="1" :step="1000" controls-position="right" style="width: 150px" />
            <el-input v-model="depForm.remark" placeholder="备注" style="width: 140px" />
            <el-button type="primary" @click="deposit">提交</el-button>
          </div>
          <el-table :data="detail.deposits" size="small" border max-height="240">
            <el-table-column prop="direction" label="方向" width="80">
              <template #default="{ row }">{{ row.direction === "in" ? "缴纳" : "退还" }}</template>
            </el-table-column>
            <el-table-column label="金额" width="110">
              <template #default="{ row }">{{ money(row.amount) }}</template>
            </el-table-column>
            <el-table-column label="余额" width="110">
              <template #default="{ row }">{{ money(row.balance) }}</template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="150" />
          </el-table>
        </div>
      </template>
    </el-drawer>
  </div>
</template>
