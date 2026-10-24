<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, money, STATUS_TEXT } from "../api";

const loading = ref(false);
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const q = reactive({ status: "", keyword: "" });

async function load() {
  loading.value = true;
  try {
    const p = new URLSearchParams({ page: page.value, pageSize: pageSize.value });
    if (q.status) p.set("status", q.status);
    if (q.keyword) p.set("keyword", q.keyword);
    const data = await api.get("/admin/orders?" + p.toString());
    rows.value = data.list;
    total.value = data.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function closeOrder(row) {
  try {
    const { value } = await ElMessageBox.prompt("平台强制关闭将退回担保资金，请填写原因", "关闭订单 " + row.orderNo, {
      confirmButtonText: "确认关闭",
      cancelButtonText: "取消",
    });
    const r = await api.post("/admin/orders/" + row.id + "/close", { reason: value });
    ElMessage.success("订单已关闭，退款 " + money(r.refunded));
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}

async function exportCsv() {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.keyword) p.set("keyword", q.keyword);
  const res = await fetch("/api/admin/orders/export?" + p.toString(), {
    headers: { Authorization: "Bearer " + localStorage.getItem("jiajiao_admin_token") },
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "platform-orders.csv";
  a.click();
  URL.revokeObjectURL(url);
}

async function priceOrder(row) {
  try {
    const { value } = await ElMessageBox.prompt("新的订单金额（元）", "平台改价：" + row.orderNo, {
      inputValue: String((row.amount / 100).toFixed(2)),
    });
    const cents = Math.round(Number(value) * 100);
    if (!(cents > 0)) return ElMessage.error("金额不合法");
    await api.post("/admin/orders/" + row.id + "/price", { amount: cents, note: "后台改价" });
    ElMessage.success("改价成功");
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div>
    <div class="card">
      <div class="row">
        <el-select v-model="q.status" placeholder="全部状态" clearable style="width: 160px">
          <el-option v-for="(v, k) in STATUS_TEXT" :key="k" :label="v" :value="k" />
        </el-select>
        <el-input v-model="q.keyword" placeholder="订单号" style="width: 220px" clearable />
        <el-button type="primary" @click="page = 1; load()">查询</el-button>
        <el-button @click="exportCsv">导出 CSV</el-button>
      </div>
    </div>

    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="orderNo" label="订单号" width="190" />
      <el-table-column label="家长/教员" width="180">
        <template #default="{ row }">
          <div>{{ row.parent?.nickname || "-" }}</div>
          <div class="muted">{{ row.teacher?.nickname || "-" }}</div>
        </template>
      </el-table-column>
      <el-table-column label="科目" width="120">
        <template #default="{ row }">{{ row.subject }} · {{ row.stage }}</template>
      </el-table-column>
      <!-- 授课方式（P65）：home=教员上门 / teacher_place=家长到教员处 -->
      <el-table-column label="授课方式" width="120">
        <template #default="{ row }">
          <el-tag size="small" :type="row.place === 'teacher_place' ? 'warning' : 'info'">
            {{ row.placeText || "教员上门" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="实付" width="100">
        <template #default="{ row }">{{ money(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="服务费/教员实收" width="150">
        <template #default="{ row }">{{ money(row.serviceFee) }} / {{ money(row.teacherIncome) }}</template>
      </el-table-column>
      <el-table-column label="代理/业务员/平台" width="170">
        <template #default="{ row }">{{ money(row.agentShare) }} / {{ money(row.salesCommission) }} / {{ money(row.platformRevenue) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'refunded' || row.status === 'cancelled' ? 'info' : row.status === 'settled' || row.status === 'completed' ? 'success' : 'warning'">
            {{ row.statusText }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" width="180" />
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text @click="priceOrder(row)">改价</el-button>
          <el-button size="small" text type="danger" @click="closeOrder(row)">强制关闭</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      style="margin-top: 14px"
      layout="total, sizes, prev, pager, next"
      :total="total"
      v-model:current-page="page"
      v-model:page-size="pageSize"
      :page-sizes="[10, 20, 50]"
      @current-change="load"
      @size-change="load"
    />
  </div>
</template>
