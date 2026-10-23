<script setup>
/**
 * 代理管理（需求 4.5.2 / 5.3）：区域代理账号的增删改查 + 保证金台账 + 考核完成度。
 *
 * 新增：填入姓名/手机号/片区，服务端生成一次性初始口令（首登强制改密），
 *       分成比例默认取规则 `agent_commission`，可在弹窗里覆盖。
 * 删除：只允许删「没有任何业务痕迹」的账号；有订单分成/归属绑定/下属业务员/保证金或
 *       钱包余额时后端会拒绝并逐条说明，此时应改用「禁用」（读接口返回的中文原因）。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, money } from "../api";

const loading = ref(false);
const saving = ref(false);
const rows = ref([]);
const regions = ref([]);
const detail = ref(null);
const depForm = reactive({ direction: "in", amount: 50000, remark: "" });

/* ---------------- 新增代理 ---------------- */
const createVisible = ref(false);
const blankForm = () => ({ nickname: "", phone: "", regionId: null, level: "A", commissionRate: 25, mgmtRate: 1, deposit: 0 });
const form = reactive(blankForm());
const canSubmit = computed(() => !!form.nickname.trim() && /^1\d{10}$/.test(form.phone.trim()) && !!form.regionId);

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get("/admin/agents");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function loadRegions() {
  try {
    regions.value = await api.get("/admin/regions");
  } catch {
    regions.value = [];
  }
}

onMounted(async () => {
  await Promise.all([load(), loadRegions()]);
});

function openCreate() {
  Object.assign(form, blankForm());
  createVisible.value = true;
}

async function submitCreate() {
  if (!form.nickname.trim()) return ElMessage.error("请填写代理姓名");
  if (!/^1\d{10}$/.test(form.phone.trim())) return ElMessage.error("请填写 11 位手机号");
  if (!form.regionId) return ElMessage.error("请选择代理片区");
  for (const [label, v] of [["服务费分成", form.commissionRate], ["管理提成", form.mgmtRate]]) {
    const n = Number(v);
    if (!(n >= 0 && n <= 100)) return ElMessage.error(label + "需在 0~100 之间（单位 %）");
  }
  saving.value = true;
  try {
    const r = await api.post("/admin/agents", {
      nickname: form.nickname.trim(),
      phone: form.phone.trim(),
      regionId: Number(form.regionId),
      level: form.level,
      commissionRate: Number(form.commissionRate) / 100,
      mgmtRate: Number(form.mgmtRate) / 100,
      deposit: Math.round(Number(form.deposit || 0)),
    });
    createVisible.value = false;
    await load();
    ElMessage.success("代理已创建：ID " + r.id);
    if (r.initialPassword) {
      await ElMessageBox.alert(
        "一次性初始口令：<b class='mono'>" + r.initialPassword + "</b><br />请让代理首次登录后立即修改（服务端已置「强制改密」）。",
        "代理账号已创建",
        { dangerouslyUseHTMLString: true, confirmButtonText: "我已记录" },
      );
    }
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    saving.value = false;
  }
}

/**
 * 删除代理（软删除：打标记 + 匿名化）。
 *
 * - 钱没结清（保证金/钱包余额/冻结）或有未完结订单时后端拒绝，先结清再删
 * - 有历史数据 → 打删除标记 + 清掉手机号/昵称/实名/口令，订单分成、归属绑定、下属业务员、
 *   保证金台账全部保留（对账与合规追溯要用），等于「注销」的管理员版
 * - 完全空白 → 物理删干净
 */
async function remove(row) {
  try {
    await ElMessageBox.confirm(
      "确定删除代理「" + row.nickname + "」？<br />" +
        "有历史数据的代理会被<b>打删除标记并匿名化</b>（手机号、昵称、实名、口令清除，订单分成与保证金台账保留）；" +
        "完全空白的会被彻底删除；<b>保证金/钱包余额未结清或有未完结订单时无法删除</b>。",
      "删除代理",
      { type: "warning", dangerouslyUseHTMLString: true, confirmButtonText: "确认删除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  try {
    const r = await api.del("/admin/agents/" + row.user_id);
    if (r?.mode === "soft") {
      ElMessageBox.alert(
        "代理已删除并匿名化。<br />保留的业务台账：" + (r.kept || []).join("；") +
          "。<br />历史订单分成、保证金台账仍可对账，但账号已无法登录。",
        "已软删除",
        { dangerouslyUseHTMLString: true, type: "success", confirmButtonText: "知道了" },
      );
    } else {
      ElMessage.success("已删除代理：" + row.nickname);
    }
    await load();
  } catch (e) {
    // 后端会说明是哪些资金/订单挡住了删除
    ElMessageBox.alert(e.message || String(e), "无法删除", { type: "warning", confirmButtonText: "知道了" });
  }
}

/* ---------------- 详情 / 保证金 / 分成 ---------------- */
async function open(row) {
  try {
    detail.value = await api.get("/admin/agents/" + row.user_id);
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function toggle(row) {
  try {
    const r = await api.post("/admin/agents/" + row.user_id + "/toggle");
    ElMessage.success("代理状态：" + r.status);
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function deposit() {
  try {
    await api.post("/admin/agents/" + detail.value.agent.userId + "/deposit", {
      direction: depForm.direction,
      amount: Number(depForm.amount),
      remark: depForm.remark,
    });
    ElMessage.success("保证金操作成功");
    open({ user_id: detail.value.agent.userId });
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function editRates(row) {
  try {
    const { value } = await ElMessageBox.prompt("服务费分成比例（0~1）", "调整分成", { inputValue: String(row.commission_rate) });
    const rate = Number(value);
    if (!(rate >= 0 && rate <= 1)) return ElMessage.error("比例需在 0~1 之间");
    await api.put("/admin/agents/" + row.user_id, { commissionRate: rate });
    ElMessage.success("已更新分成比例");
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
</script>

<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" data-act="agent-create" @click="openCreate">新增代理</el-button>
      <span class="muted">
        区域代理账号在这里开设；账号有订单/绑定/下属/资金余额时只能「禁用」，不能删除
      </span>
    </div>

    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="user_id" label="ID" width="70" />
      <el-table-column prop="nickname" label="代理" width="160" />
      <el-table-column prop="phone" label="手机号" width="130" />
      <el-table-column prop="regionName" label="片区" width="140" />
      <el-table-column prop="level" label="等级" width="80" />
      <el-table-column label="服务费分成" width="110">
        <template #default="{ row }">{{ (row.commission_rate * 100).toFixed(0) }}%</template>
      </el-table-column>
      <el-table-column label="管理提成" width="110">
        <template #default="{ row }">{{ (row.mgmt_rate * 100).toFixed(1) }}%</template>
      </el-table-column>
      <el-table-column label="保证金" width="120">
        <template #default="{ row }">{{ money(row.deposit) }}</template>
      </el-table-column>
      <el-table-column label="业务员/累计分成" width="150">
        <template #default="{ row }">{{ row.salesCount }} 人 / {{ money(row.totalShare) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === "active" ? "启用" : "禁用" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="270" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="open(row)">详情</el-button>
          <el-button size="small" text @click="editRates(row)">调分成</el-button>
          <el-button size="small" text :type="row.status === 'active' ? 'danger' : 'primary'" @click="toggle(row)">
            {{ row.status === "active" ? "禁用" : "启用" }}
          </el-button>
          <el-button size="small" text type="danger" :data-del="row.user_id" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增代理 -->
    <el-dialog v-model="createVisible" title="新增代理" width="520px">
      <el-form label-width="96px" size="small">
        <el-form-item label="代理姓名">
          <el-input v-model="form.nickname" placeholder="如：余杭代理·赵经理" data-field="agent-name" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="form.phone" placeholder="11 位手机号，用作登录账号" maxlength="11" data-field="agent-phone" />
        </el-form-item>
        <el-form-item label="代理片区">
          <el-select v-model="form.regionId" placeholder="选择片区" style="width: 100%" data-field="agent-region">
            <el-option v-for="r in regions" :key="r.id" :label="r.name + '（' + r.code + '）'" :value="r.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="等级">
          <el-select v-model="form.level" style="width: 120px">
            <el-option label="A" value="A" />
            <el-option label="B" value="B" />
            <el-option label="C" value="C" />
          </el-select>
        </el-form-item>
        <el-form-item label="服务费分成">
          <el-input-number v-model="form.commissionRate" :min="0" :max="100" :step="1" controls-position="right" style="width: 140px" />
          <span class="muted" style="margin-left: 8px">%（默认取规则 agent_commission）</span>
        </el-form-item>
        <el-form-item label="管理提成">
          <el-input-number v-model="form.mgmtRate" :min="0" :max="100" :step="0.5" :precision="1" controls-position="right" style="width: 140px" />
          <span class="muted" style="margin-left: 8px">%</span>
        </el-form-item>
        <el-form-item label="首笔保证金">
          <el-input-number v-model="form.deposit" :min="0" :step="5000" controls-position="right" style="width: 160px" />
          <span class="muted" style="margin-left: 8px">元（可 0，后续在详情里缴纳）</span>
        </el-form-item>
      </el-form>
      <div class="muted">提交后服务端生成一次性初始口令，代理首登需改密。</div>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!canSubmit" data-act="agent-submit" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detail" :with-header="true" size="520px" title="代理详情">
      <template v-if="detail">
        <div class="card">
          <h3>考核完成度</h3>
          <div class="muted">
            本月 GMV {{ money(detail.assessment.monthGmv) }} / 目标 {{ money(detail.assessment.targets.monthly_gmv_target) }}（{{ detail.assessment.gmvRate }}%）<br />
            本月订单 {{ detail.assessment.monthOrders }} / {{ detail.assessment.targets.monthly_orders_target }}（{{ detail.assessment.orderRate }}%）<br />
            活跃业务员 {{ detail.assessment.salesCount }} / {{ detail.assessment.targets.active_sales_target }}（{{ detail.assessment.salesRate }}%）
          </div>
        </div>
        <div class="card">
          <h3>保证金台账</h3>
          <div class="row" style="margin-bottom: 10px">
            <el-select v-model="depForm.direction" style="width: 110px">
              <el-option label="缴纳" value="in" />
              <el-option label="退还" value="out" />
            </el-select>
            <el-input-number v-model="depForm.amount" :min="1" :step="1000" controls-position="right" style="width: 150px" />
            <el-input v-model="depForm.remark" placeholder="备注" style="width: 140px" />
            <el-button type="primary" @click="deposit">提交</el-button>
          </div>
          <el-table :data="detail.deposits" size="small" border max-height="240">
            <el-table-column prop="direction" label="方向" width="80">
              <template #default="{ row }">{{ row.direction === "in" ? "缴纳" : "退还" }}</template>
            </el-table-column>
            <el-table-column label="金额" width="110">
              <template #default="{ row }">{{ money(row.amount) }}</template>
            </el-table-column>
            <el-table-column label="余额" width="110">
              <template #default="{ row }">{{ money(row.balance) }}</template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="150" />
          </el-table>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.toolbar .muted { font-size: 12px; line-height: 1.6; }
</style>
