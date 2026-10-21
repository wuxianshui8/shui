<script setup>
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, money } from "../api";

const tab = ref("banner");
const banners = ref([]);
const announcements = ref([]);
const coupons = ref([]);

async function loadAll() {
  try {
    [banners.value, announcements.value, coupons.value] = await Promise.all([
      api.get("/admin/banners"),
      api.get("/admin/announcements"),
      api.get("/admin/coupons"),
    ]);
  } catch (e) {
    ElMessage.error(e.message);
  }
}
onMounted(loadAll);

async function editBanner(row) {
  try {
    const { value } = await ElMessageBox.prompt("标题", row ? "编辑 Banner" : "新增 Banner", { inputValue: row?.title || "" });
    if (row) await api.put("/admin/banners/" + row.id, { title: value });
    else await api.post("/admin/banners", { title: value, status: "on", sort: 0 });
    ElMessage.success("已保存");
    loadAll();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
const toggleBanner = async (row) => { await api.post("/admin/banners/" + row.id + "/toggle"); loadAll(); };
const removeBanner = async (row) => { await api.del("/admin/banners/" + row.id); ElMessage.success("已删除"); loadAll(); };

async function createAnnouncement() {
  try {
    const { value } = await ElMessageBox.prompt("公告标题", "新增公告", { inputValue: "" });
    await api.post("/admin/announcements", { title: value, content: "", audience: "all", status: "on" });
    ElMessage.success("已创建");
    loadAll();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
const toggleAnn = async (row) => { await api.post("/admin/announcements/" + row.id + "/toggle"); loadAll(); };
const pinAnn = async (row) => { await api.post("/admin/announcements/" + row.id + "/pin"); loadAll(); };
const removeAnn = async (row) => { await api.del("/admin/announcements/" + row.id); ElMessage.success("已删除"); loadAll(); };

async function editCoupon(row) {
  try {
    const { value } = await ElMessageBox.prompt("优惠金额（元）", "调整优惠券：" + row.name, { inputValue: String(row.amount / 100) });
    await api.put("/admin/coupons/" + row.id, { amount: Math.round(Number(value) * 100) });
    ElMessage.success("已更新");
    loadAll();
  } catch (e) {
    if (e !== "cancel") ElMessage.error(e.message || String(e));
  }
}
const toggleCoupon = async (row) => { await api.post("/admin/coupons/" + row.id + "/toggle"); loadAll(); };
</script>

<template>
  <div>
    <el-tabs v-model="tab">
      <el-tab-pane label="Banner" name="banner">
        <div class="card">
          <div class="row" style="margin-bottom: 10px">
            <el-button type="primary" @click="editBanner(null)">新增 Banner</el-button>
          </div>
          <el-table :data="banners" size="small" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column prop="title" label="标题" min-width="220" />
            <el-table-column prop="link" label="跳转" width="160" />
            <el-table-column prop="sort" label="排序" width="80" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'on' ? 'success' : 'info'">{{ row.status === "on" ? "展示中" : "已停用" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text @click="editBanner(row)">编辑</el-button>
                <el-button size="small" text @click="toggleBanner(row)">{{ row.status === "on" ? "停用" : "启用" }}</el-button>
                <el-button size="small" text type="danger" @click="removeBanner(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <el-tab-pane label="公告" name="ann">
        <div class="card">
          <div class="row" style="margin-bottom: 10px">
            <el-button type="primary" @click="createAnnouncement">新增公告</el-button>
          </div>
          <el-table :data="announcements" size="small" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column prop="title" label="标题" min-width="220" />
            <el-table-column prop="audience" label="受众" width="100" />
            <el-table-column label="置顶" width="80">
              <template #default="{ row }">{{ row.pinned ? "是" : "否" }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'on' ? 'success' : 'info'">{{ row.status === "on" ? "上线" : "下线" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="240" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text @click="toggleAnn(row)">{{ row.status === "on" ? "下线" : "上线" }}</el-button>
                <el-button size="small" text @click="pinAnn(row)">{{ row.pinned ? "取消置顶" : "置顶" }}</el-button>
                <el-button size="small" text type="danger" @click="removeAnn(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <el-tab-pane label="优惠券" name="coupon">
        <div class="card">
          <el-table :data="coupons" size="small" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column prop="name" label="名称" min-width="180" />
            <el-table-column label="减免" width="100">
              <template #default="{ row }">{{ money(row.amount) }}</template>
            </el-table-column>
            <el-table-column label="门槛" width="110">
              <template #default="{ row }">{{ money(row.threshold) }}</template>
            </el-table-column>
            <el-table-column label="发行/已领" width="120">
              <template #default="{ row }">{{ row.total }} / {{ row.claimed }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'on' ? 'success' : 'info'">{{ row.status === "on" ? "可领取" : "已停用" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text @click="editCoupon(row)">改金额</el-button>
                <el-button size="small" text @click="toggleCoupon(row)">{{ row.status === "on" ? "停用" : "启用" }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
