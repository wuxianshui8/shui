/**
 * 规则里的「表格型」值：等级表 / 信用等级 / 提成阶梯。
 * 直接渲染成可编辑表格 —— 运营看到的是「等级 Lv1 / 见习教员 / 下限 0 / 抽佣 18%」，
 * 不是 [{...}]。列由数据自动推导，单元格类型按列判定（数字/开关/文本/留空=不限制）。
 */
<script setup>
import { computed } from "vue";
import {
  fieldLabel, isMoney, isRate, minOf, precisionOf, stepOf,
} from "../rule-meta";

const props = defineProps({
  rows: { type: Array, required: true },
  readonly: { type: Boolean, default: false },
  /** 加一行的按钮旁提示，例如「等级」 */
  rowName: { type: String, default: "行" },
});
const emit = defineEmits(["update:rows"]);

/** 列 = 所有行出现过的 key 的并集（不同行的字段可能不同，例如最后一档 max=null） */
const columns = computed(() => {
  const cols = [];
  for (const row of props.rows) {
    for (const k of Object.keys(row || {})) if (!cols.includes(k)) cols.push(k);
  }
  return cols;
});

/** 按「首个非 null 值」判定列类型 */
function cellType(col) {
  for (const row of props.rows) {
    const v = row ? row[col] : undefined;
    if (v !== null && v !== undefined) return typeof v;
  }
  return "string";
}
const hasNullCell = (col) => props.rows.some((r) => r && r[col] === null);

function patch(idx, col, val) {
  emit("update:rows", props.rows.map((r, i) => (i === idx ? { ...r, [col]: val } : r)));
}
function addRow() {
  const tpl = {};
  for (const col of columns.value) {
    const t = cellType(col);
    if (hasNullCell(col)) tpl[col] = null;
    else tpl[col] = t === "number" ? 0 : t === "boolean" ? false : "";
  }
  emit("update:rows", [...props.rows, tpl]);
}
function removeRow(idx) {
  emit("update:rows", props.rows.filter((_, i) => i !== idx));
}
function moveRow(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= props.rows.length) return;
  const rows = [...props.rows];
  [rows[idx], rows[j]] = [rows[j], rows[idx]];
  emit("update:rows", rows);
}
/** 「留空 = 不限制」单元格：空串回填 null，否则转数字 */
function setNullable(idx, col, raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return patch(idx, col, null);
  const n = Number(s);
  patch(idx, col, Number.isFinite(n) ? n : null);
}
</script>

<template>
  <div class="rtable-wrap">
    <div class="rtable-head">
      <span class="hint">
        共 {{ rows.length }} {{ rowName }}
        <template v-if="!readonly">· 单元格可点开直接改，改完记得点下方「保存并生效」</template>
      </span>
      <el-button v-if="!readonly" size="small" type="primary" plain @click="addRow">新增{{ rowName }}</el-button>
    </div>
    <div class="rtable-scroll">
      <table class="rtable">
        <thead>
          <tr>
            <th v-for="col in columns" :key="col">
              {{ fieldLabel(col) || col }}
              <span v-if="hasNullCell(col)" class="muted">（留空=不限制）</span>
            </th>
            <th v-if="!readonly" class="ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i">
            <td v-for="col in columns" :key="col">
              <el-switch
                v-if="cellType(col) === 'boolean'"
                :model-value="!!row[col]"
                :disabled="readonly"
                @update:model-value="(v) => patch(i, col, v)"
              />
              <el-input-number
                v-else-if="cellType(col) === 'number' && row[col] !== null"
                :model-value="row[col]"
                :disabled="readonly"
                :precision="precisionOf(row[col])"
                :step="stepOf(row[col])"
                :min="minOf(col)"
                :controls="false"
                size="small"
                style="width: 100%"
                @update:model-value="(v) => patch(i, col, v === null || v === undefined ? 0 : v)"
              />
              <el-input
                v-else-if="row[col] === null"
                :model-value="''"
                :disabled="readonly"
                size="small"
                placeholder="不限制"
                @update:model-value="(v) => setNullable(i, col, v)"
              />
              <el-input
                v-else
                :model-value="row[col]"
                :disabled="readonly"
                size="small"
                @update:model-value="(v) => patch(i, col, v)"
              />
              <div v-if="isRate(col) && typeof row[col] === 'number'" class="muted cell-hint">
                {{ (Number(row[col]) * 100).toFixed(2).replace(/\.?0+$/, "") }}%
              </div>
              <div v-else-if="isMoney(col) && typeof row[col] === 'number'" class="muted cell-hint">
                ¥ {{ (Number(row[col]) / 100).toFixed(2) }}
              </div>
            </td>
            <td v-if="!readonly" class="ops">
              <el-button link size="small" @click="moveRow(i, -1)">上移</el-button>
              <el-button link size="small" @click="moveRow(i, 1)">下移</el-button>
              <el-button link size="small" type="danger" @click="removeRow(i)">删除</el-button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + (readonly ? 0 : 1)" class="muted" style="padding: 14px">
              暂无数据，点右上角「新增{{ rowName }}」
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.rtable-wrap { border: 1px solid var(--line, #e5e9f0); border-radius: 10px; padding: 10px 12px; background: #fff; }
.rtable-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.rtable-head .hint { font-size: 12.5px; color: var(--muted, #64748b); }
.rtable-scroll { overflow-x: auto; }
.rtable { width: 100%; border-collapse: collapse; }
.rtable th, .rtable td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line, #eef2f7); vertical-align: middle; }
.rtable th { font-size: 12.5px; font-weight: 700; color: var(--ink-2, #475569); white-space: nowrap; }
.rtable td.ops, .rtable th.ops { white-space: nowrap; }
.rtable .cell-hint { font-size: 11.5px; margin-top: 2px; }
.rtable tbody tr:last-child td { border-bottom: none; }
</style>
