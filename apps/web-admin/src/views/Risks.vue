<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const loading = ref(false);
const tab = ref("events");
const events = ref([]);
const appeals = ref([]);
const complaints = ref([]);

async function load() {
  loading.value = true;
  try {
    const data = await api.get("/admin/risks");
    events.value = data.events;
    appeals.value = data.appeals;
    complaints.value = data.complaints;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function handle(row, action) {
  try {
    let note;
    if (action === "punish") {
      const r = await ElMessageBox.prompt("请填写处理说明", "违规处理", { inputValue: "" });
      note = r.value;
    }
    await api.post("/admin/risks/" + row.id + "/handle", { action, note });
    ElMessage.success("已处理：" + action);
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}

async function arbitrate(row, accept) {
  try {
    let reason;
    if (!accept) {
      const r = await ElMessageBox.prompt("维持原判的说明", "驳回申诉", { inputValue: "维持原判" });
      reason = r.value;
    }
    const res = await api.post("/admin/appeals/" + row.id + "/arbitrate", { accept, reason });
    ElMessage.success("仲裁结果：" + res.status);
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}

async function closeComplaint(row) {
  try {
    const { value } = await ElMessageBox.prompt("结案说明", "客诉结案", { inputValue: "平台终审结案" });
    await api.post("/admin/complaints/" + row.id + "/close", { note: value });
    ElMessage.success("已结案");
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div v-loading="loading">
    <el-tabs v-model="tab">
      <el-tab-pane :label="'风控事件（' + events.length + '）'" name="events">
        <el-table :data="events" size="small" border>
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column prop="type" label="类型" width="150" />
          <el-table-column label="等级" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.level === 'high' ? 'danger' : 'warning'">{{ row.level }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="reason" label="原因" min-width="280" show-overflow-tooltip />
          <el-table-column prop="order_no" label="订单" width="180" />
          <el-table-column prop="nickname" label="相关用户" width="130" />
          <el-table-column label="结算冻结" width="100">
            <template #default="{ row }">{{ row.settlement_hold ? "是" : "否" }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="100" />
          <el-table-column label="处置" width="240" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text @click="handle(row, 'hold')">冻结</el-button>
              <el-button size="small" text @click="handle(row, 'release')">解除</el-button>
              <el-button size="small" text type="primary" @click="handle(row, 'close')">关闭</el-button>
              <el-button size="small" text type="danger" @click="handle(row, 'punish')">处罚</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="'差评申诉（' + appeals.length + '）'" name="appeals">
        <el-table :data="appeals" size="small" border>
          <el-table-column prop="id" label="评价ID" width="90" />
          <el-table-column prop="teacherName" label="教员" width="130" />
          <el-table-column prop="parentName" label="家长" width="130" />
          <el-table-column prop="score" label="评分" width="80" />
          <el-table-column prop="content" label="评价内容" min-width="200" show-overflow-tooltip />
          <el-table-column prop="appeal_reason" label="申诉理由" min-width="200" show-overflow-tooltip />
          <el-table-column prop="appeal_status" label="状态" width="110" />
          <el-table-column label="仲裁" width="210" fixed="right">
            <template #default="{ row }">
              <template v-if="row.appeal_status === 'pending'">
                <el-button size="small" text type="primary" @click="arbitrate(row, true)">撤销评价</el-button>
                <el-button size="small" text @click="arbitrate(row, false)">维持原判</el-button>
              </template>
              <span v-else class="muted">已仲裁</span>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="'客诉工单（' + complaints.length + '）'" name="complaints">
        <el-table :data="complaints" size="small" border>
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
          <el-table-column prop="fromName" label="发起人" width="130" />
          <el-table-column prop="order_no" label="订单" width="180" />
          <el-table-column prop="status" label="状态" width="120" />
          <el-table-column prop="created_at" label="时间" width="180" />
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.status !== 'closed'" size="small" text type="primary" @click="closeComplaint(row)">结案</el-button>
              <span v-else class="muted">已结案</span>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
