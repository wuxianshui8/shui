<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api, money } from "../api";

const tab = ref("banner");
const banners = ref([]);
const announcements = ref([]);
const coupons = ref([]);
const busy = ref(false);

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

/* ---------------- Banner（P72：图片 + 跳转 + 排序） ---------------- */
const bannerDlg = ref(false);
const bannerForm = reactive({ id: 0, title: "", image: "", link: "", sort: 0, status: "on" });

function openBanner(row) {
  Object.assign(bannerForm, row
    ? { id: row.id, title: row.title || "", image: row.image || "", link: row.link || "", sort: Number(row.sort || 0), status: row.status || "on" }
    : { id: 0, title: "", image: "", link: "", sort: 0, status: "on" });
  bannerDlg.value = true;
}

async function saveBanner() {
  if (!String(bannerForm.title || "").trim()) return ElMessage.warning("请填写标题");
  busy.value = true;
  try {
    const body = {
      title: bannerForm.title.trim(),
      image: String(bannerForm.image || "").trim(),
      link: String(bannerForm.link || "").trim(),
      sort: Number(bannerForm.sort || 0),
      status: bannerForm.status,
    };
    if (bannerForm.id) await api.put("/admin/banners/" + bannerForm.id, body);
    else await api.post("/admin/banners", body);
    ElMessage.success("已保存");
    bannerDlg.value = false;
    loadAll();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    busy.value = false;
  }
}

const toggleBanner = async (row) => { await api.post("/admin/banners/" + row.id + "/toggle"); loadAll(); };
const removeBanner = async (row) => { await api.del("/admin/banners/" + row.id); ElMessage.success("已删除"); loadAll(); };

/* ---------------- 公告（P72：正文 + 受众 + 推送） ---------------- */
const annDlg = ref(false);
const annForm = reactive({ id: 0, title: "", content: "", audience: "all", pinned: false, status: "on", push: false });

function openAnn(row) {
  Object.assign(annForm, row
    ? { id: row.id, title: row.title || "", content: row.content || "", audience: row.audience || "all", pinned: !!row.pinned, status: row.status || "on", push: false }
    : { id: 0, title: "", content: "", audience: "all", pinned: false, status: "on", push: false });
  annDlg.value = true;
}

async function saveAnn() {
  if (!String(annForm.title || "").trim()) return ElMessage.warning("请填写标题");
  busy.value = true;
  try {
    const body = {
      title: annForm.title.trim(),
      content: String(annForm.content || "").trim(),
      audience: annForm.audience,
      pinned: !!annForm.pinned,
      status: annForm.status,
      push: !!annForm.push,
    };
    if (annForm.id) await api.put("/admin/announcements/" + annForm.id, body);
    else await api.post("/admin/announcements", body);
    ElMessage.success(annForm.push ? "已保存并推送站内消息" : "已保存");
    annDlg.value = false;
    loadAll();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    busy.value = false;
  }
}

const toggleAnn = async (row) => { await api.post("/admin/announcements/" + row.id + "/toggle"); loadAll(); };
const pinAnn = async (row) => { await api.post("/admin/announcements/" + row.id + "/pin"); loadAll(); };
const removeAnn = async (row) => { await api.del("/admin/announcements/" + row.id); ElMessage.success("已删除"); loadAll(); };

/* ---------------- 优惠券（P71：后台可建券 + 改门槛/发行量/有效期） ---------------- */
const couponDlg = ref(false);
const couponForm = reactive({ id: 0, name: "", amountYuan: 10, thresholdYuan: 100, total: 0, validFrom: "", validTo: "", status: "on" });

function openCoupon(row) {
  Object.assign(couponForm, row
    ? {
        id: row.id, name: row.name || "",
        amountYuan: Number(row.amount || 0) / 100, thresholdYuan: Number(row.threshold || 0) / 100,
        total: Number(row.total || 0), validFrom: row.valid_from || "", validTo: row.valid_to || "", status: row.status || "on",
      }
    : { id: 0, name: "", amountYuan: 10, thresholdYuan: 100, total: 0, validFrom: "", validTo: "", status: "on" });
  couponDlg.value = true;
}

async function saveCoupon() {
  if (!String(couponForm.name || "").trim()) return ElMessage.warning("请填写券名称");
  if (!(Number(couponForm.amountYuan) > 0)) return ElMessage.warning("优惠金额必须大于 0");
  busy.value = true;
  try {
    const body = {
      name: couponForm.name.trim(),
      amount: Math.round(Number(couponForm.amountYuan) * 100),
      threshold: Math.round(Number(couponForm.thresholdYuan || 0) * 100),
      total: Number(couponForm.total || 0),
      validFrom: couponForm.validFrom || null,
      validTo: couponForm.validTo || null,
      status: couponForm.status,
    };
    if (couponForm.id) await api.put("/admin/coupons/" + couponForm.id, body);
    else await api.post("/admin/coupons", body);
    ElMessage.success("已保存");
    couponDlg.value = false;
    loadAll();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    busy.value = false;
  }
}

const toggleCoupon = async (row) => { await api.post("/admin/coupons/" + row.id + "/toggle"); loadAll(); };

/* ---------------- 运维任务（P73）：把只有后端接口、没有按钮的能力补上 ---------------- */
const tasks = [
  { key: "expire", label: "清理过期报名", desc: "把过期未确认的报名置为 expired，释放需求名额", api: "/admin/applications/expire" },
  { key: "close", label: "关闭超时未支付订单", desc: "超过规则时限仍未支付的订单自动关单（jobs 也在跑，这里是手动兜底）", api: "/admin/orders/close-expired" },
  { key: "reminder", label: "跑一次上课提醒", desc: "给即将上课的订单发站内提醒（无需等定时任务）", api: "/admin/reminders/run" },
  { key: "settle", label: "结算业务员奖励", desc: "把 pending 的业务员提成按周结规则入账", api: "/admin/rewards/settle" },
];
const taskBusy = ref("");

async function runTask(t) {
  taskBusy.value = t.key;
  try {
    const r = await api.post(t.api);
    ElMessage.success(t.label + " 完成：" + (r && typeof r === "object" ? JSON.stringify(r) : String(r)));
    loadAll();
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    taskBusy.value = "";
  }
}

/* ---------------- 协议文案（P75）：用户协议 / 隐私政策 / 退款规则 ---------------- */
const AGREEMENT_LABEL = { user: "用户服务协议", privacy: "隐私政策", refund: "退款规则" };
const agreements = ref([]);
const agreeKey = ref("user");
const agreeForm = reactive({ title: "", content: "", updatedAt: "" });
const agreeBusy = ref(false);

function pickAgreement(key) {
  agreeKey.value = key;
  const row = agreements.value.find((a) => a.key === key);
  agreeForm.title = row ? row.title : "";
  agreeForm.content = row ? row.content : "";
  agreeForm.updatedAt = row ? row.updatedAt || "" : "";
}

async function loadAgreements() {
  try {
    agreements.value = (await api.get("/admin/agreements")) || [];
    const exists = agreements.value.find((a) => a.key === agreeKey.value);
    pickAgreement(exists ? agreeKey.value : (agreements.value[0] && agreements.value[0].key) || "user");
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function saveAgreement() {
  if (!String(agreeForm.title || "").trim()) return ElMessage.warning("请填写协议标题");
  if (String(agreeForm.content || "").trim().length < 10) return ElMessage.warning("正文太短（至少 10 个字）");
  agreeBusy.value = true;
  try {
    const r = await api.put("/admin/agreements/" + agreeKey.value, {
      title: agreeForm.title.trim(),
      content: agreeForm.content,
    });
    const row = agreements.value.find((a) => a.key === agreeKey.value);
    if (row) { row.title = r.title; row.updatedAt = r.updatedAt; }
    agreeForm.updatedAt = r.updatedAt || "";
    ElMessage.success("已保存，家长/教员端立即生效");
  } catch (e) {
    ElMessage.error(e.message || String(e));
  } finally {
    agreeBusy.value = false;
  }
}
onMounted(loadAgreements);
</script>

<template>
  <div>
    <el-tabs v-model="tab">
      <el-tab-pane label="Banner" name="banner">
        <div class="card">
          <div class="row" style="margin-bottom: 10px">
            <el-button type="primary" @click="openBanner(null)">新增 Banner</el-button>
            <span class="muted" style="margin-left: 10px">图片支持站内 /uploads 地址或外链；链接可填 /m/xxx 站内路由或 https 外链</span>
          </div>
          <el-table :data="banners" size="small" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="图" width="90">
              <template #default="{ row }">
                <el-image v-if="row.image" :src="row.image" fit="cover" style="width: 56px; height: 32px; border-radius: 4px" />
                <span v-else class="muted">无</span>
              </template>
            </el-table-column>
            <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
            <el-table-column prop="link" label="跳转" min-width="160" show-overflow-tooltip />
            <el-table-column prop="sort" label="排序" width="80" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'on' ? 'success' : 'info'">{{ row.status === "on" ? "展示中" : "已停用" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text @click="openBanner(row)">编辑</el-button>
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
            <el-button type="primary" @click="openAnn(null)">新增公告</el-button>
          </div>
          <el-table :data="announcements" size="small" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
            <el-table-column prop="content" label="正文" min-width="240" show-overflow-tooltip>
              <template #default="{ row }">
                <span v-if="row.content">{{ row.content }}</span>
                <span v-else class="muted">（空）</span>
              </template>
            </el-table-column>
            <el-table-column prop="audience" label="受众" width="90" />
            <el-table-column label="置顶" width="70">
              <template #default="{ row }">{{ row.pinned ? "是" : "否" }}</template>
            </el-table-column>
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'on' ? 'success' : 'info'">{{ row.status === "on" ? "上线" : "下线" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="260" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text @click="openAnn(row)">编辑</el-button>
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
          <div class="row" style="margin-bottom: 10px">
            <el-button type="primary" @click="openCoupon(null)">新增优惠券</el-button>
            <span class="muted" style="margin-left: 10px">发行量 0 = 不限量；家长在移动端「我的优惠券」领取，下单时选用</span>
          </div>
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
              <template #default="{ row }">{{ Number(row.total) > 0 ? row.total : "不限" }} / {{ row.claimed }}</template>
            </el-table-column>
            <el-table-column label="有效期" min-width="200">
              <template #default="{ row }">
                <span v-if="row.valid_from || row.valid_to">{{ row.valid_from || "—" }} ~ {{ row.valid_to || "—" }}</span>
                <span v-else class="muted">长期有效</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'on' ? 'success' : 'info'">{{ row.status === "on" ? "可领取" : "已停用" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text @click="openCoupon(row)">编辑</el-button>
                <el-button size="small" text @click="toggleCoupon(row)">{{ row.status === "on" ? "停用" : "启用" }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <el-tab-pane label="运维任务" name="task">
        <div class="card">
          <div class="muted" style="margin-bottom: 12px">
            这些能力后端一直有（定时任务也在跑），但后台此前没有按钮；补上便于手动兜底与排障。
          </div>
          <el-table :data="tasks" size="small" border>
            <el-table-column prop="label" label="任务" width="180" />
            <el-table-column prop="desc" label="说明" min-width="320" show-overflow-tooltip />
            <el-table-column label="接口" width="260">
              <template #default="{ row }"><code>{{ row.api }}</code></template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="primary" :loading="taskBusy === row.key" @click="runTask(row)">执行</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
      <el-tab-pane label="协议文案" name="agreement">
        <div class="card">
          <div class="muted" style="margin-bottom: 12px">
            这三份文案同时用于：家长端「我的 → 用户协议 / 隐私政策 / 退款规则」、教员端同入口、以及登录页勾选提示。
            保存后立即生效（`updated_at` 会刷新，界面会显示最近更新时间）。
          </div>
          <div class="row" style="gap: 10px; margin-bottom: 12px">
            <el-radio-group v-model="agreeKey" @change="pickAgreement">
              <el-radio-button v-for="a in agreements" :key="a.key" :value="a.key">
                {{ a.title || AGREEMENT_LABEL[a.key] || a.key }}
              </el-radio-button>
            </el-radio-group>
            <el-button @click="loadAgreements">重新加载</el-button>
          </div>
          <el-form label-width="80px">
            <el-form-item label="标题">
              <el-input v-model="agreeForm.title" style="max-width: 420px" />
            </el-form-item>
            <el-form-item label="正文">
              <el-input
                v-model="agreeForm.content"
                type="textarea"
                :rows="16"
                placeholder="协议正文（支持换行，前端按白名单换行渲染）"
              />
            </el-form-item>
            <el-form-item label="最近更新">
              <span class="muted">{{ agreeForm.updatedAt || "—" }}（保存后自动刷新）</span>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="agreeBusy" @click="saveAgreement">保存文案</el-button>
              <span class="muted" style="margin-left: 12px">正文少于 10 个字会被拒绝（防手滑清空）</span>
            </el-form-item>
          </el-form>
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="bannerDlg" :title="bannerForm.id ? '编辑 Banner' : '新增 Banner'" width="520px">
      <el-form label-width="90px">
        <el-form-item label="标题"><el-input v-model="bannerForm.title" placeholder="如「新用户首单立减」" /></el-form-item>
        <el-form-item label="图片地址"><el-input v-model="bannerForm.image" placeholder="/uploads/xxx.png 或 https://..." /></el-form-item>
        <el-form-item label="跳转链接"><el-input v-model="bannerForm.link" placeholder="/m/pages/parent/index 或 https://..." /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="bannerForm.sort" :min="0" :max="999" /></el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="bannerForm.status">
            <el-radio value="on">展示中</el-radio>
            <el-radio value="off">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bannerDlg = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="saveBanner">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="annDlg" :title="annForm.id ? '编辑公告' : '新增公告'" width="560px">
      <el-form label-width="90px">
        <el-form-item label="标题"><el-input v-model="annForm.title" /></el-form-item>
        <el-form-item label="正文">
          <el-input v-model="annForm.content" type="textarea" :rows="5" placeholder="公告正文（家长/教员端按受众展示）" />
        </el-form-item>
        <el-form-item label="受众">
          <el-select v-model="annForm.audience" style="width: 100%">
            <el-option label="全部" value="all" />
            <el-option label="家长" value="parent" />
            <el-option label="教员" value="teacher" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="annForm.status">
            <el-radio value="on">上线</el-radio>
            <el-radio value="off">下线</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="置顶"><el-switch v-model="annForm.pinned" /></el-form-item>
        <el-form-item label="同时推送">
          <el-switch v-model="annForm.push" />
          <span class="muted" style="margin-left: 8px">开启后给该受众写一条站内消息</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="annDlg = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="saveAnn">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="couponDlg" :title="couponForm.id ? '编辑优惠券' : '新增优惠券'" width="540px">
      <el-form label-width="100px">
        <el-form-item label="名称"><el-input v-model="couponForm.name" placeholder="如「新客立减 10 元」" /></el-form-item>
        <el-form-item label="减免（元）"><el-input-number v-model="couponForm.amountYuan" :min="1" :step="1" /></el-form-item>
        <el-form-item label="门槛（元）"><el-input-number v-model="couponForm.thresholdYuan" :min="0" :step="10" /></el-form-item>
        <el-form-item label="发行量">
          <el-input-number v-model="couponForm.total" :min="0" />
          <span class="muted" style="margin-left: 8px">0 = 不限量</span>
        </el-form-item>
        <el-form-item label="有效期起"><el-input v-model="couponForm.validFrom" placeholder="2026-11-01（可空）" /></el-form-item>
        <el-form-item label="有效期止"><el-input v-model="couponForm.validTo" placeholder="2026-12-31（可空）" /></el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="couponForm.status">
            <el-radio value="on">可领取</el-radio>
            <el-radio value="off">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="couponDlg = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="saveCoupon">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
