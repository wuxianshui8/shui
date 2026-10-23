<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const loading = ref(false);
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const q = reactive({ role: "", keyword: "" });

const ROLE = { admin: "管理员", parent: "家长", teacher: "教员", sales: "业务员", agent: "代理" };

async function load() {
  loading.value = true;
  try {
    const p = new URLSearchParams({ page: page.value, pageSize: pageSize.value });
    if (q.role) p.set("role", q.role);
    if (q.keyword) p.set("keyword", q.keyword);
    const data = await api.get("/admin/users?" + p.toString());
    rows.value = data.list;
    total.value = data.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function toggle(row) {
  try {
    await ElMessageBox.confirm((row.status === "active" ? "禁用" : "启用") + "账号 " + row.nickname + "？", "账号状态", { type: "warning" });
    const r = await api.post("/admin/users/" + row.id + "/toggle", { reason: "后台操作" });
    ElMessage.success("已" + (r.status === "active" ? "启用" : "禁用"));
    load();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}

/**
 * 删除账号（软删除：打标记 + 匿名化）。
 *
 * - 家长 / 教员 / 业务员都可删；管理员不可，代理请走「代理管理」（有保证金与分成台账）
 * - 有未完结订单或冻结待结算金额时拒绝（这两种情况删了会有人吃亏）
 * - 有历史数据 → 打 `deleted_at` 标记 + 清掉手机号/昵称/头像/实名/身份证/证件图/口令，
 *   订单、资金流水、评价、提现台账原样保留（对账与合规要用），等于「注销」的管理员版
 * - 完全空白 → 物理删干净，不留垃圾行
 */
async function remove(row) {
  try {
    await ElMessageBox.confirm(
      "确定删除「" + row.nickname + "」（" + (ROLE[row.role] || row.role) + "）？<br />" +
        "有历史订单/需求的账号会被<b>打删除标记并匿名化</b>（手机号、昵称、证件等清除，订单与资金台账保留）；" +
        "完全空白的账号会被彻底删除；<b>有未完结订单或冻结金额时无法删除</b>。",
      "删除账号",
      { type: "warning", dangerouslyUseHTMLString: true, confirmButtonText: "确认删除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  try {
    const r = await api.del("/admin/users/" + row.id);
    if (r?.mode === "soft") {
      ElMessageBox.alert(
        "账号已删除并匿名化。<br />保留的业务台账：" + (r.kept || []).join("；") +
          "。<br />历史订单、资金流水与评价仍可对账，但已无法登录。",
        "已软删除",
        { dangerouslyUseHTMLString: true, type: "success", confirmButtonText: "知道了" },
      );
    } else {
      ElMessage.success("已删除账号：" + row.nickname);
    }
    load();
  } catch (e) {
    ElMessageBox.alert(e.message || String(e), "无法删除", { type: "warning", confirmButtonText: "知道了" });
  }
}
</script>

<template>
  <div>
    <div class="card">
      <div class="row">
        <el-select v-model="q.role" placeholder="全部角色" clearable style="width: 150px">
          <el-option v-for="(v, k) in ROLE" :key="k" :label="v" :value="k" />
        </el-select>
        <el-input v-model="q.keyword" placeholder="昵称 / 手机号" style="width: 220px" clearable />
        <el-button type="primary" @click="page = 1; load()">查询</el-button>
      </div>
    </div>

    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="nickname" label="昵称" width="160" />
      <el-table-column prop="phone" label="手机号" width="140" />
      <el-table-column label="角色" width="100">
        <template #default="{ row }">
          <el-tag size="small">{{ ROLE[row.role] || row.role }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === "active" ? "正常" : "禁用" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="档案摘要" min-width="240">
        <template #default="{ row }">
          <span v-if="row.teacher" class="muted">
            审核 {{ row.teacher.auditStatus }} · {{ row.teacher.level }} · 成长分 {{ row.teacher.growthScore }}
          </span>
          <span v-else-if="row.parent" class="muted">
            信用 {{ row.parent.credit_level }}（{{ row.parent.credit_score }}）· 完成 {{ row.parent.completed_orders }}
          </span>
          <span v-else-if="row.agent" class="muted">
            片区 #{{ row.agent.region_id }} · 等级 {{ row.agent.level }} · 保证金 ¥{{ (row.agent.deposit / 100).toFixed(2) }}
          </span>
          <span v-else-if="row.sales" class="muted">推广码 {{ row.sales.code }}</span>
          <span v-else class="muted">-</span>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="注册时间" width="180" />
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text :type="row.status === 'active' ? 'danger' : 'primary'" @click="toggle(row)">
            {{ row.status === "active" ? "禁用" : "启用" }}
          </el-button>
          <el-button
            v-if="['parent', 'teacher', 'sales'].includes(row.role)"
            size="small"
            text
            type="danger"
            :data-del="row.id"
            @click="remove(row)"
          >删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      style="margin-top: 14px"
      layout="total, prev, pager, next"
      :total="total"
      v-model:current-page="page"
      v-model:page-size="pageSize"
      @current-change="load"
    />
  </div>
</template>
