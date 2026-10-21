<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const rows = ref([]);

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get("/admin/teachers/pending");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function audit(row, approve) {
  try {
    let reason;
    if (!approve) {
      const r = await ElMessageBox.prompt("请填写驳回原因", "驳回入驻申请", { confirmButtonText: "驳回" });
      reason = r.value;
    }
    await api.post("/admin/teachers/" + row.id + "/audit", { approve, reason });
    ElMessage.success(approve ? "已通过审核" : "已驳回");
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div class="card">
    <h3>待审核教员（{{ rows.length }}）</h3>
    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="realName" label="真实姓名" width="110" />
      <el-table-column prop="nickname" label="昵称" width="120" />
      <el-table-column prop="phone" label="手机号" width="130" />
      <el-table-column label="身份" width="100">
        <template #default="{ row }">{{ { student: "大学生", in_service: "在职教师" }[row.identityType] || row.identityType }}</template>
      </el-table-column>
      <el-table-column prop="subjects" label="科目" width="120" />
      <el-table-column label="课时单价" width="110">
        <template #default="{ row }">{{ money(row.hourlyPrice) }}</template>
      </el-table-column>
      <el-table-column prop="intro" label="自我介绍" min-width="200" show-overflow-tooltip />
      <el-table-column prop="updatedAt" label="提交时间" width="180" />
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="audit(row, true)">通过</el-button>
          <el-button size="small" text type="danger" @click="audit(row, false)">驳回</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="muted" style="margin-top: 10px">提示：审核通过后账号角色切换为 teacher，并站内通知本人。</div>
  </div>
</template>
