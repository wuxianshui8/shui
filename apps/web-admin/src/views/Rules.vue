<script setup>
/**
 * 规则配置中心：运营改的是「表单」，不是 JSON。
 * 左侧选规则组，右侧按字段类型渲染表单（数字框 / 开关 / 标签 / 可编辑表格），
 * 原始数据只放在最下面「高级」里只读展示，供核对与排障，不作为编辑入口。
 */
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import RuleValueEditor from "../components/RuleValueEditor.vue";
import { validateRuleValue } from "../rule-meta";

const loading = ref(false);
const saving = ref(false);
const rules = ref([]);
const active = ref("");
const value = ref(null);
const dirty = ref(false);

const current = computed(() => rules.value.find((r) => r.key === active.value) || null);
const editable = computed(() => !!current.value && current.value.editable !== 0 && current.value.editable !== false);
const jsonPreview = computed(() => JSON.stringify(value.value, null, 2));

const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

async function fetchRules() {
  const data = await api.get("/admin/rules");
  const list = Array.isArray(data) ? data : data.rules || [];
  rules.value = list.map((r) => ({
    ...r,
    value: typeof r.value === "string" ? JSON.parse(r.value) : r.value,
  }));
}

async function load() {
  loading.value = true;
  try {
    await fetchRules();
    if (rules.value.length) select(rules.value.find((r) => r.key === active.value) || rules.value[0]);
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function select(r) {
  if (!r) return;
  active.value = r.key;
  value.value = clone(r.value);
  dirty.value = false;
}

function onValueChange(next) {
  value.value = next;
  dirty.value = true;
}

async function save() {
  if (!editable.value) return;
  const errs = validateRuleValue(value.value);
  if (errs.length) {
    ElMessage({ type: "error", message: errs[0], duration: 6000 });
    return;
  }
  saving.value = true;
  try {
    await api.put("/admin/rules/" + active.value, { value: value.value });
    ElMessage.success("已保存并即时生效（内存 + Redis 缓存已失效）");
    await fetchRules();
    select(rules.value.find((r) => r.key === active.value));
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    saving.value = false;
  }
}

const reset = () => select(current.value);
</script>

<template>
  <div v-loading="loading" class="rules-wrap">
    <div class="card rules-side">
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

    <div class="card rules-main" v-if="current">
      <h3>{{ current.label }} <span class="muted mono">{{ current.key }}</span></h3>
      <p class="muted" style="margin: -4px 0 14px">
        按字段直接填数字 / 开关 / 标签即可；比例的填 0~1 的小数（0.15 = 15%），金额单位是「分」。
      </p>

      <RuleValueEditor
        v-if="value !== null"
        :model-value="value"
        :readonly="!editable"
        @update:model-value="onValueChange"
      />

      <el-collapse style="margin-top: 16px">
        <el-collapse-item name="raw" title="高级：查看这组规则的原始数据（只读，仅供核对）">
          <pre class="mono pre-wrap" style="margin: 0; max-height: 260px; overflow: auto; color: #64748b">{{ jsonPreview }}</pre>
        </el-collapse-item>
      </el-collapse>

      <div class="row" style="margin-top: 16px">
        <el-button type="primary" :loading="saving" :disabled="!editable" @click="save">保存并生效</el-button>
        <el-button :disabled="!dirty" @click="reset">放弃修改</el-button>
        <el-tag v-if="!editable" type="info">该规则不可修改</el-tag>
        <el-tag v-else-if="dirty" type="warning">有未保存的修改</el-tag>
        <span class="muted">保存后立即生效，无需重启（内存 + Redis 缓存同时失效）</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 宽屏：左侧分组列表 + 右侧表单并排；窄屏（面板/小屏/投影）自动上下堆叠，
   否则固定 320px 的列表会把表单挤出可视区。 */
.rules-wrap { display: flex; gap: 12px; align-items: flex-start; }
.rules-side { width: 320px; flex: 0 0 320px; max-height: 78vh; overflow: auto; }
.rules-main { flex: 1; min-width: 0; }
@media (max-width: 1100px) {
  .rules-wrap { flex-wrap: wrap; }
  .rules-side { width: 100%; flex: 1 1 100%; max-height: 30vh; }
  .rules-main { flex: 1 1 100%; }
}
</style>
