<script setup>
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const loading = ref(false);
const saving = ref(false);
const keys = ref([]);
const roles = ref([]);
const matrix = ref({});

const ROLE_LABEL = {
  admin: "管理员",
  agent: "区域代理",
  sales: "业务员",
  teacher: "教员",
  parent: "家长",
};
const KEY_LABEL = {
  "order.price": "订单改价",
  "order.close": "强制关闭订单",
  "refund.review": "退款审批",
  "withdraw.review": "提现审核",
};

async function load() {
  loading.value = true;
  try {
    const data = await api.get("/admin/permissions");
    keys.value = data.keys || [];
    roles.value = data.roles || [];
    matrix.value = data.matrix || {};
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function has(key, role) {
  return (matrix.value[key] || []).includes(role);
}

function toggle(key, role, checked) {
  const cur = new Set(matrix.value[key] || []);
  if (role === "admin") {
    ElMessage.warning("管理员必须保留该权限（防自锁），不能取消");
    return;
  }
  if (checked) cur.add(role);
  else cur.delete(role);
  cur.add("admin");
  matrix.value = { ...matrix.value, [key]: [...cur] };
}

const grantedCount = computed(() =>
  keys.value.reduce((s, k) => s + (matrix.value[k] || []).filter((r) => r !== "admin").length, 0),
);

async function save() {
  try {
    await ElMessageBox.confirm("保存后立即生效（无需重启），确认提交？", "权限矩阵", { type: "warning" });
  } catch {
    return;
  }
  saving.value = true;
  try {
    const r = await api.put("/admin/permissions", { matrix: matrix.value });
    matrix.value = r.matrix || matrix.value;
    ElMessage.success("已保存并即时生效");
    load();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    saving.value = false;
  }
}

async function resetToAdminOnly() {
  try {
    await ElMessageBox.confirm("将把 4 个权限点都收回为「仅管理员」，确认？", "恢复默认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await api.put("/admin/permissions", { matrix: Object.fromEntries(keys.value.map((k) => [k, ["admin"]])) });
    ElMessage.success("已恢复默认矩阵");
    load();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="kpi">
      <div class="item"><div class="k">权限点</div><div class="v">{{ keys.length }}</div></div>
      <div class="item"><div class="k">已额外授予</div><div class="v">{{ grantedCount }}</div></div>
      <div class="item"><div class="k">可授予角色</div><div class="v">{{ roles.length }}</div></div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>细粒度权限矩阵（需求 4.5.9）</h3>
      <el-table :data="keys.map((k) => ({ key: k }))" border size="small">
        <el-table-column label="权限点" width="220">
          <template #default="{ row }">
            <b>{{ KEY_LABEL[row.key] || row.key }}</b><br />
            <span class="muted">{{ row.key }}</span>
          </template>
        </el-table-column>
        <el-table-column v-for="role in roles" :key="role" :label="ROLE_LABEL[role] || role" width="120" align="center">
          <template #default="{ row }">
            <el-checkbox
              :model-value="has(row.key, role)"
              :disabled="role === 'admin'"
              @change="(v) => toggle(row.key, role, v)"
            />
          </template>
        </el-table-column>
      </el-table>
      <div class="muted" style="margin-top: 10px">
        管理员一列固定勾选（后端强制保留，避免把后台锁死）；授予代理/业务员后，对应操作会写进操作日志。
      </div>
      <div style="margin-top: 12px">
        <el-button type="primary" :loading="saving" @click="save">保存并生效</el-button>
        <el-button @click="resetToAdminOnly">恢复默认（仅管理员）</el-button>
      </div>
    </div>
  </div>
</template>
