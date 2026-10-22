<script setup>
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

/**
 * 运营字典：学段 / 科目。
 * 数据落在规则配置组 `catalog`（rule_configs），保存后规则缓存立即失效，
 * 家长端发单、教员服务、教员市场筛选的下拉都会用新值（前端读 /api/meta/dictionary）。
 */
const loading = ref(false);
const saving = ref(false);
const stages = ref([]);
const subjects = ref([]);
const draftStage = ref("");
const draftSubject = ref("");
const meta = ref({ label: "", grp: "", editable: true });
const MAX_ITEMS = 60;
const MAX_LEN = 12;

async function load() {
  loading.value = true;
  try {
    const list = await api.get("/admin/rules");
    const rows = Array.isArray(list) ? list : list.rules || [];
    const row = rows.find((r) => r.key === "catalog");
    if (!row) {
      ElMessage.warning("未找到 catalog 规则组：请先执行一次 db/seed-min.mjs 灌入默认字典");
      return;
    }
    const value = typeof row.value === "string" ? JSON.parse(row.value) : row.value || {};
    stages.value = [...(value.stages || [])];
    subjects.value = [...(value.subjects || [])];
    meta.value = { label: row.label || "", grp: row.grp || "", editable: row.editable !== 0 };
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function normalize(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function add(list, raw, name) {
  const v = normalize(raw);
  if (!v) return;
  if (v.length > MAX_LEN) {
    ElMessage.warning(name + "单项不超过 " + MAX_LEN + " 个字符");
    return;
  }
  if (list.value.includes(v)) {
    ElMessage.warning("「" + v + "」已存在");
    return;
  }
  if (list.value.length >= MAX_ITEMS) {
    ElMessage.warning(name + "最多 " + MAX_ITEMS + " 项");
    return;
  }
  list.value = [...list.value, v];
}

function remove(list, v) {
  list.value = list.value.filter((x) => x !== v);
}

function move(list, v, dir) {
  const arr = [...list.value];
  const i = arr.indexOf(v);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  list.value = arr;
}

const dirty = ref(false);
function touch() {
  dirty.value = true;
}
const summary = computed(() => "学段 " + stages.value.length + " 项 / 科目 " + subjects.value.length + " 项");

function validate() {
  if (!stages.value.length) return "学段至少保留 1 项（否则发单表单无法选择）";
  if (!subjects.value.length) return "科目至少保留 1 项";
  for (const [name, list] of [["学段", stages.value], ["科目", subjects.value]]) {
    for (const v of list) {
      if (!v || v.length > MAX_LEN) return name + "存在空项或超长项：" + v;
    }
    if (new Set(list).size !== list.length) return name + "存在重复项";
  }
  return "";
}

async function save() {
  const err = validate();
  if (err) {
    ElMessage.error(err);
    return;
  }
  try {
    await ElMessageBox.confirm(
      "保存后立即生效：家长发单、教员服务与市场筛选的下拉都会用新值（约 300 秒规则缓存会自动失效）。确认提交？",
      "学段 / 科目",
      { type: "warning" },
    );
  } catch {
    return;
  }
  saving.value = true;
  try {
    await api.put("/admin/rules/catalog", { value: { stages: stages.value, subjects: subjects.value } });
    ElMessage.success("已保存并即时生效");
    dirty.value = false;
    load();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="kpi">
      <div class="item"><div class="k">学段</div><div class="v">{{ stages.length }}</div></div>
      <div class="item"><div class="k">科目</div><div class="v">{{ subjects.length }}</div></div>
      <div class="item"><div class="k">生效方式</div><div class="v" style="font-size: 14px">保存即生效</div></div>
    </div>

    <div class="card" style="margin-top: 16px">
      <h3>学段 / 科目（运营工具）</h3>
      <div class="muted" style="margin-bottom: 12px">
        这两组选项是家长发单、教员上架服务、教员市场筛选的下拉来源；改完保存，前端下一次请求即拿到新值。
        单项不超过 {{ MAX_LEN }} 个字符，每类最多 {{ MAX_ITEMS }} 项，顺序会影响下拉与筛选项的排列。
      </div>

      <el-row :gutter="20">
        <el-col :span="10">
          <h4 style="margin: 6px 0 10px">学段<span class="muted"> （必填列）</span></h4>
          <div style="display: flex; gap: 8px; margin-bottom: 10px">
            <el-input
              v-model="draftStage"
              placeholder="如：小学 / 初中 / 高中"
              maxlength="12"
              show-word-limit
              @keyup.enter="add(stages, draftStage, '学段'); draftStage = ''; touch()"
            />
            <el-button type="primary" @click="add(stages, draftStage, '学段'); draftStage = ''; touch()">添加</el-button>
          </div>
          <el-table :data="stages.map((v, i) => ({ v, i }))" border size="small" empty-text="至少保留 1 项">
            <el-table-column label="#" width="52" align="center">
              <template #default="{ row }">{{ row.i + 1 }}</template>
            </el-table-column>
            <el-table-column label="学段">
              <template #default="{ row }"><b>{{ row.v }}</b></template>
            </el-table-column>
            <el-table-column label="顺序 / 操作" width="170" align="center">
              <template #default="{ row }">
                <el-button link size="small" @click="move(stages, row.v, -1); touch()">上移</el-button>
                <el-button link size="small" @click="move(stages, row.v, 1); touch()">下移</el-button>
                <el-button link type="danger" size="small" @click="remove(stages, row.v); touch()">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-col>

        <el-col :span="14">
          <h4 style="margin: 6px 0 10px">科目<span class="muted"> （必填列）</span></h4>
          <div style="display: flex; gap: 8px; margin-bottom: 10px">
            <el-input
              v-model="draftSubject"
              placeholder="如：语文 / 数学 / 钢琴"
              maxlength="12"
              show-word-limit
              @keyup.enter="add(subjects, draftSubject, '科目'); draftSubject = ''; touch()"
            />
            <el-button type="primary" @click="add(subjects, draftSubject, '科目'); draftSubject = ''; touch()">添加</el-button>
          </div>
          <div class="muted" style="margin-bottom: 8px">共 {{ subjects.length }} 项</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px">
            <el-tag
              v-for="(s, i) in subjects"
              :key="s"
              :closable="true"
              size="large"
              :type="i % 3 === 0 ? 'primary' : i % 3 === 1 ? 'success' : 'info'"
              @close="remove(subjects, s); touch()"
            >
              {{ s }}
            </el-tag>
            <span v-if="!subjects.length" class="muted">至少保留 1 项</span>
          </div>
        </el-col>
      </el-row>

      <div style="margin-top: 16px; display: flex; align-items: center; gap: 12px">
        <el-button type="primary" :loading="saving" @click="save">保存并生效</el-button>
        <el-button @click="load">重新加载</el-button>
        <span class="muted">{{ summary }}<span v-if="dirty"> · 有未保存的修改</span></span>
      </div>
      <div class="muted" style="margin-top: 8px">
        对应规则组：<b>{{ meta.grp }}</b> / {{ meta.label }}（key = <code>catalog</code>，
        {{ meta.editable ? "可编辑" : "只读" }}）；所有修改都会写进操作日志。
      </div>
    </div>
  </div>
</template>
