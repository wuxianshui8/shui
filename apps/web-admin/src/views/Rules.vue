<script setup>
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

const loading = ref(false);
const rules = ref([]);
const active = ref("");
const draft = ref("");

const current = computed(() => rules.value.find((r) => r.key === active.value) || null);

async function load() {
  loading.value = true;
  try {
    const data = await api.get("/admin/rules");
    rules.value = data.rules;
    if (!active.value && rules.value.length) select(rules.value[0]);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function select(r) {
  active.value = r.key;
  draft.value = JSON.stringify(r.value, null, 2);
}

async function save() {
  let value;
  try {
    value = JSON.parse(draft.value);
  } catch {
    return ElMessage.error("JSON 格式不正确");
  }
  try {
    await api.put("/admin/rules/" + active.value, { value });
    ElMessage.success("规则已保存并即时生效（Redis 缓存已失效）");
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}
</script>

<template>
  <div v-loading="loading" class="row" style="align-items: flex-start; flex-wrap: nowrap">
    <div class="card" style="width: 320px; flex: 0 0 320px; max-height: 74vh; overflow: auto">
      <h3>规则分组（{{ rules.length }}）</h3>
      <div
        v-for="r in rules"
        :key="r.key"
        @click="select(r)"
        style="padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px"
        :style="{ background: active === r.key ? 'rgba(31,111,235,.1)' : 'transparent' }"
      >
        <div style="font-size: 13px; font-weight: 600">{{ r.label }}</div>
        <div class="muted mono">{{ r.key }} · {{ r.grp }}</div>
      </div>
    </div>

    <div class="card grow" v-if="current">
      <h3>{{ current.label }} <span class="muted mono">{{ current.key }}</span></h3>
      <el-input v-model="draft" type="textarea" :rows="18" class="mono" spellcheck="false" />
      <div class="row" style="margin-top: 12px">
        <el-button type="primary" @click="save" :disabled="!current.editable">保存并生效</el-button>
        <el-button @click="select(current)">重置</el-button>
        <el-tag v-if="!current.editable" type="info">该规则不可修改</el-tag>
        <span class="muted">修改后立即生效，无需重启（内存 + Redis 缓存同时失效）</span>
      </div>
    </div>
  </div>
</template>
