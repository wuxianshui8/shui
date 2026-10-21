<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, auth } from "../api";

const loading = ref(false);
const rows = ref([]);
const form = reactive({ nickname: "", phone: "" });

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get("/admin/admins");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function create() {
  try {
    if (!form.nickname.trim()) throw new Error("请填写管理员姓名");
    if (!/^1\d{10}$/.test(form.phone.trim())) throw new Error("请填写正确的手机号");
    const r = await api.post("/admin/admins", { nickname: form.nickname.trim(), phone: form.phone.trim() });
    // 一次性初始口令只在此刻可见（账号首登强制改密）
    await ElMessageBox.alert(
      "初始口令：" + r.initialPassword + "\n\n该账号首次登录必须先修改口令，请通过安全渠道转达（勿写入工单/群聊）。",
      "管理员已创建",
      { confirmButtonText: "我已记录" },
    );
    Object.assign(form, { nickname: "", phone: "" });
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}

async function toggle(row) {
  const self = row.id === (auth.user || {}).id;
  try {
    await ElMessageBox.confirm(
      self ? "不能禁用当前登录的管理员账号（后端会拒绝）。仍要尝试吗？" : "确认" + (row.status === "active" ? "禁用" : "启用") + "「" + row.nickname + "」？",
      "管理员账号",
      { type: "warning" },
    );
    const r = await api.post("/admin/admins/" + row.id + "/toggle");
    ElMessage.success("已" + (r.status === "disabled" ? "禁用" : "启用") + "（旧令牌立即失效）");
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="card">
      <h3>新建管理员（需求 4.5.9）</h3>
      <el-form :inline="true" size="small">
        <el-form-item label="姓名">
          <el-input v-model="form.nickname" placeholder="如：王运营" style="width: 150px" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="form.phone" placeholder="11 位手机号" style="width: 160px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="create">创建并获取一次性口令</el-button>
        </el-form-item>
      </el-form>
      <div class="muted">新账号为一次性 12 位强口令 + 首登强制改密；创建动作与启停均写操作日志。</div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>管理员列表（{{ rows.length }}）</h3>
      <el-table :data="rows" border size="small">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="nickname" label="姓名" width="160" />
        <el-table-column prop="phone" label="手机号（脱敏）" width="150" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
              {{ row.status === "active" ? "启用" : "禁用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180" />
        <el-table-column prop="lastLoginAt" label="最后登录" width="180" />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :type="row.status === 'active' ? 'danger' : 'primary'" text @click="toggle(row)">
              {{ row.status === "active" ? "禁用" : "启用" }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="muted">护栏：不能禁用自己；至少保留一个启用的管理员；禁用时旧令牌立即失效。</div>
    </div>
  </div>
</template>
