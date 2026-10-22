/**
 * 规则值编辑器：把一组规则数据渲染成「按字段类型生成的表单」，运营不需要看到 JSON。
 *
 * 支持的数据形状（覆盖 rule_configs 里全部 16 组规则）
 * - 对象（标量字段集合）        dispatch / settlement / credit_rules / risk / notify / platforms ...
 * - 对象 + 一层嵌套对象          growth_rules.violation
 * - 对象 + 字符串数组            review_scoring.positive_tags / catalog.stages / permissions.*
 * - 顶层就是对象数组             teacher_levels / parent_credit
 * - 对象里的对象数组             sales_rewards.deal_tiers
 *
 * 关键约定：提交给接口的永远是原始数据（金额=分、比例=0~1 小数、null=不限制），
 * 表单上只做「再展示一遍」的换算，双击不该改数值的字段也不会被改坏。
 */
<script setup>
import { reactive } from "vue";
import RuleRowsTable from "./RuleRowsTable.vue";
import {
  ROLE_CODES, fieldLabel, isMultiplier, isObject, isObjectArray,
  isPrimitiveArray, isRate, isRoleList, minOf, numberHint, precisionOf, roleLabel, stepOf,
} from "../rule-meta";

const props = defineProps({
  modelValue: { type: null, required: true },
  readonly: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue"]);

/** 标签输入框的草稿（按字段名分开存，避免多个标签字段互相串值） */
const drafts = reactive({});

const patch = (next) => emit("update:modelValue", next);
const patchKey = (key, val) => patch({ ...props.modelValue, [key]: val });

function addTag(key) {
  const v = String(drafts[key] || "").trim();
  drafts[key] = "";
  if (!v) return;
  const list = props.modelValue[key] || [];
  if (list.includes(v)) return;
  patchKey(key, [...list, v]);
}
const removeTag = (key, val) => patchKey(key, (props.modelValue[key] || []).filter((x) => x !== val));

function toggleRole(key, code, on) {
  const list = props.modelValue[key] || [];
  patchKey(key, on ? [...list, code] : list.filter((x) => x !== code));
}

/** 数字框清空时会回 null，统一兜回 0（这些字段在业务上不允许缺省） */
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
</script>

<template>
  <!-- 顶层就是「表」：教员等级、家长信用等级 -->
  <RuleRowsTable
    v-if="isObjectArray(modelValue)"
    :rows="modelValue"
    :readonly="readonly"
    row-name="档"
    @update:rows="patch"
  />

  <!-- 顶层是标签数组（极少见，兜底） -->
  <div v-else-if="isPrimitiveArray(modelValue)" class="rblock">
    <div class="tagline">
      <el-tag
        v-for="t in modelValue"
        :key="t"
        :closable="!readonly"
        size="large"
        class="tag"
        @close="patch(modelValue.filter((x) => x !== t))"
      >{{ roleLabel(t) }}</el-tag>
      <el-input
        v-if="!readonly"
        :model-value="drafts.__root || ''"
        size="small"
        placeholder="输入后回车添加"
        style="width: 200px"
        @update:model-value="(v) => (drafts.__root = v)"
        @keyup.enter="() => { const v = String(drafts.__root || '').trim(); drafts.__root = ''; if (v && !modelValue.includes(v)) patch([...modelValue, v]); }"
      />
    </div>
  </div>

  <!-- 普通规则对象 -->
  <div v-else-if="isObject(modelValue)" class="rule-form">
    <template v-for="[k, v] in Object.entries(modelValue)" :key="k">
      <!-- 对象数组：整块表格 -->
      <div v-if="isObjectArray(v)" class="rblock">
        <div class="rblock-head">
          <span>{{ fieldLabel(k) || k }}<span class="muted mono"> · {{ k }}</span></span>
        </div>
        <RuleRowsTable
          :rows="v"
          :readonly="readonly"
          :row-name="k === 'deal_tiers' ? '阶梯' : '行'"
          @update:rows="(nv) => patchKey(k, nv)"
        />
      </div>

      <!-- 嵌套对象：一格一格的开关/数字 -->
      <div v-else-if="isObject(v)" class="rblock">
        <div class="rblock-head">
          <span>{{ fieldLabel(k) || k }}<span class="muted mono"> · {{ k }}</span></span>
        </div>
        <div class="nested">
          <div v-for="[k2, v2] in Object.entries(v)" :key="k2" class="rrow">
            <label>{{ fieldLabel(k2) || k2 }}</label>
            <div class="rctl">
              <el-switch
                v-if="typeof v2 === 'boolean'"
                :model-value="v2"
                :disabled="readonly"
                @update:model-value="(nv) => patchKey(k, { ...v, [k2]: nv })"
              />
              <template v-else-if="typeof v2 === 'number'">
                <el-input-number
                  :model-value="v2"
                  :disabled="readonly"
                  :precision="precisionOf(v2)"
                  :step="stepOf(v2)"
                  :min="minOf(k2)"
                  controls-position="right"
                  style="width: 170px"
                  @update:model-value="(nv) => patchKey(k, { ...v, [k2]: num(nv) })"
                />
                <span v-if="numberHint(k2, v2)" class="muted">{{ numberHint(k2, v2) }}</span>
              </template>
              <el-input
                v-else
                :model-value="v2"
                :disabled="readonly"
                style="max-width: 360px"
                @update:model-value="(nv) => patchKey(k, { ...v, [k2]: nv })"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- 标量 / 字符串数组 -->
      <div v-else class="rrow">
        <label>
          {{ fieldLabel(k) || k }}
          <span v-if="!fieldLabel(k)" class="muted mono"> · {{ k }}</span>
        </label>
        <div class="rctl">
          <!-- 开关 -->
          <el-switch
            v-if="typeof v === 'boolean'"
            :model-value="v"
            :disabled="readonly"
            active-text="开启"
            inactive-text="关闭"
            inline-prompt
            @update:model-value="(nv) => patchKey(k, nv)"
          />

          <!-- 数字 -->
          <template v-else-if="typeof v === 'number'">
            <el-input-number
              :model-value="v"
              :disabled="readonly"
              :precision="precisionOf(v)"
              :step="stepOf(v)"
              :min="minOf(k)"
              controls-position="right"
              style="width: 180px"
              @update:model-value="(nv) => patchKey(k, num(nv))"
            />
            <span v-if="numberHint(k, v)" class="hint-chip">{{ numberHint(k, v) }}</span>
            <span v-else-if="isRate(k)" class="muted">（0~1 的小数）</span>
            <span v-else-if="isMultiplier(k)" class="muted">（倍数）</span>
          </template>

          <!-- 角色权限：勾选，不让人手打错角色名 -->
          <div v-else-if="isRoleList(v)" class="rolebox">
            <el-checkbox
              v-for="code in ROLE_CODES"
              :key="code"
              :model-value="v.includes(code)"
              :disabled="readonly"
              @update:model-value="(on) => toggleRole(k, code, on)"
            >{{ roleLabel(code) }}</el-checkbox>
          </div>

          <!-- 字符串数组：标签 -->
          <div v-else-if="isPrimitiveArray(v)" class="tagline">
            <el-tag
              v-for="t in v"
              :key="t"
              :closable="!readonly"
              size="large"
              class="tag"
              @close="removeTag(k, t)"
            >{{ t }}</el-tag>
            <el-input
              v-if="!readonly"
              :model-value="drafts[k] || ''"
              size="small"
              placeholder="输入后回车添加"
              style="width: 190px"
              @update:model-value="(nv) => (drafts[k] = nv)"
              @keyup.enter="() => addTag(k)"
            />
            <span v-if="!v.length" class="muted">还没有内容</span>
          </div>

          <!-- 文本 -->
          <el-input
            v-else-if="typeof v === 'string'"
            :model-value="v"
            :disabled="readonly"
            :type="String(v).length > 40 ? 'textarea' : 'text'"
            :rows="3"
            style="max-width: 520px"
            @update:model-value="(nv) => patchKey(k, nv)"
          />

          <!-- null：明确表示「不限制」 -->
          <el-input
            v-else-if="v === null"
            :model-value="''"
            :disabled="readonly"
            placeholder="留空 = 不限制"
            style="max-width: 240px"
            @update:model-value="(nv) => { const s = String(nv || '').trim(); patchKey(k, s === '' ? null : Number(s)); }"
          />

          <span v-else class="muted">该字段类型不支持表单编辑</span>
        </div>
      </div>
    </template>

    <div v-if="!Object.keys(modelValue).length" class="muted">这组规则还是空的，暂无可编辑字段。</div>
  </div>

  <div v-else class="muted">该规则的数据结构无法识别，请联系开发处理。</div>
</template>

<style scoped>
.rule-form { display: flex; flex-direction: column; gap: 14px; }
.rrow { display: grid; grid-template-columns: 250px minmax(0, 1fr); align-items: center; gap: 12px; }
.rrow label { font-size: 13px; font-weight: 600; color: var(--ink-2, #475569); }
.rctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.rblock { border: 1px solid var(--line, #e5e9f0); border-radius: 10px; padding: 12px 14px; background: #fcfdff; }
.rblock-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 13px; font-weight: 700; }
.nested { display: flex; flex-direction: column; gap: 10px; }
.tagline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tagline .tag { margin: 0; }
.rolebox { display: flex; flex-wrap: wrap; gap: 14px; }
.hint-chip {
  font-size: 12.5px; color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4;
  border-radius: 6px; padding: 2px 8px; font-weight: 600;
}
@media (max-width: 1100px) {
  .rrow { grid-template-columns: 1fr; align-items: start; }
}
</style>
