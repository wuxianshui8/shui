<script setup>
import { computed, onMounted, reactive, ref } from "vue";

const dash = ref(null);
const level = ref(null);
const demands = ref([]);
const orders = ref([]);
const busy = ref("");
const unread = ref(0);
const user = uni.getStorageSync("user") || {};

function req(method, path, body) {
  return new Promise((resolve) => {
    uni.request({
      url: "/api" + path,
      method,
      data: body || {},
      header: { Authorization: "Bearer " + uni.getStorageSync("token"), "Content-Type": "application/json" },
      success: (res) => resolve(res.data && res.data.code === 0 ? res.data.data : null),
      fail: () => resolve(null),
    });
  });
}

/* ---------------- 定位接单：当前位置 / 回落到服务基点 ---------------- */
/** 当前位置（定位失败则不带参数，后端回落到入驻服务基点） */
const loc = ref({ lat: null, lng: null, source: "" });
const locating = ref(false);
const origin = ref(null);
const radiusKm = ref(0);
const locText = computed(() => {
  if (locating.value) return "定位中…";
  const o = origin.value;
  if (!o) return loc.value.lat != null ? "已定位（" + Number(loc.value.lat).toFixed(4) + ", " + Number(loc.value.lng).toFixed(4) + "）" : "未定位";
  if (o.source === "current") return "按当前位置（" + Number(o.lat).toFixed(4) + ", " + Number(o.lng).toFixed(4) + "）· " + radiusKm.value + "km 内";
  return "定位不可用，按入驻服务基点（" + Number(o.lat).toFixed(4) + ", " + Number(o.lng).toFixed(4) + "）· " + radiusKm.value + "km 内";
});
const nearPath = () =>
  "/teacher/nearby-demands" + (loc.value.lat != null ? "?lat=" + loc.value.lat + "&lng=" + loc.value.lng : "");


/** 取真实定位（gcj02，与需求地址同一坐标系）；用户拒绝授权或超时就退回服务基点 */
function getLocation() {
  return new Promise((resolve) => {
    uni.getLocation({
      type: "gcj02",
      success: (r) => resolve({ lat: Number(r.latitude.toFixed(6)), lng: Number(r.longitude.toFixed(6)), source: "current" }),
      fail: () => resolve({ lat: null, lng: null, source: "denied" }),
    });
  });
}
async function refreshLocal() {
  locating.value = true;
  try {
    loc.value = await getLocation();
  } finally {
    locating.value = false;
  }
}

async function load() {
  dash.value = await req("GET", "/teacher/dashboard");
  level.value = await req("GET", "/teacher/level");
  await refreshLocal(); // 先拿定位，再按当前位置拉附近需求
  const list = await req("GET", nearPath());
  demands.value = (list && list.list) || [];
  origin.value = (list && list.origin) || null;
  radiusKm.value = (list && list.radiusKm) || 0;
  const msgs = await req("GET", "/messages");
  unread.value = (msgs && msgs.unread) || 0;
  const mine = await req("GET", "/teacher/orders");
  orders.value = (mine && mine.list) || [];
  await loadServices();
}

/* ---------------- 我的服务（P67）：服务级授课形式 ---------------- */
const services = ref([]);
const svcForm = reactive({ open: false, id: null, title: "", price: "", places: ["home"], description: "" });
// money/toast 在本页后面已有定义（第 ~248 行的 money）：这里只补服务区用到的 helper，不重复声明

async function loadServices() {
  const list = await req("GET", "/teacher/services");
  services.value = Array.isArray(list) ? list : [];
}
function openSvc(s) {
  svcForm.open = true;
  svcForm.id = s ? Number(s.id) : null;
  svcForm.title = s ? s.title : "";
  svcForm.price = s ? String(Number(s.price) / 100) : "";
  svcForm.places = s && Array.isArray(s.places) && s.places.length ? [...s.places] : ["home"];
  svcForm.description = s ? s.description || "" : "";
}
function toggleSvcPlace(v) {
  svcForm.places = svcForm.places.includes(v)
    ? svcForm.places.filter((x) => x !== v)
    : [...svcForm.places, v];
}
async function saveSvc() {
  if (!svcForm.title.trim()) return toast("请填写服务标题");
  if (!(Number(svcForm.price) > 0)) return toast("请填写课时价");
  if (!svcForm.places.length) return toast("请至少选择一种授课形式");
  busy.value = "svc-save";
  const body = {
    title: svcForm.title.trim(),
    price: Math.round(Number(svcForm.price) * 100),
    places: svcForm.places,
    description: String(svcForm.description || "").trim(),
  };
  const r = svcForm.id
    ? await req("PUT", "/teacher/services/" + svcForm.id, body)
    : await req("POST", "/teacher/services", body);
  busy.value = "";
  if (!r) return toast("保存失败，请检查标题与价格");
  toast(svcForm.id ? "服务已更新" : "服务已上架");
  svcForm.open = false;
  await loadServices();
}
async function toggleSvc(s) {
  busy.value = "svc-toggle" + s.id;
  const r = await req("POST", "/teacher/services/" + s.id + "/toggle");
  busy.value = "";
  if (!r) return toast("操作失败");
  await loadServices();
}

/** 手动重新定位（走到别处后点一下即可按新位置接单） */
async function relocalize() {
  await refreshLocal();
  const list = await req("GET", nearPath());
  demands.value = (list && list.list) || [];
  origin.value = (list && list.origin) || null;
  radiusKm.value = (list && list.radiusKm) || 0;
  toast(loc.value.lat != null ? "已按当前位置刷新附近需求" : "定位不可用，已按服务基点刷新");
}

/** 入驻状态：none / pending / approved / rejected（读 profile 判断，顺便给首页入口配色） */
const auditStatus = ref("none");
onMounted(async () => {
  const p = await req("GET", "/teacher/profile");
  auditStatus.value = p && p.applied ? (p.profile?.auditStatus || "pending") : "none";
});
const auditText = computed(() => ({
  none: "去认证",
  pending: "审核中",
  approved: "已通过",
  rejected: "待重新提交",
}[auditStatus.value]));
const auditHint = computed(() => ({
  none: "提交身份证正反面与资质材料，审核通过后即可接单",
  pending: "资料已提交，平台正在核验，无需重复提交",
  approved: "资质已通过，可查看已提交的证件与证书",
  rejected: "上次审核未通过，请按驳回原因修改后重新提交",
}[auditStatus.value]));
const auditBg = computed(() => (auditStatus.value === "approved" ? "#e7f8ee" : auditStatus.value === "rejected" ? "#fdecec" : "#eef4ff"));
const auditColor = computed(() => (auditStatus.value === "approved" ? "#15803d" : auditStatus.value === "rejected" ? "#c02a2a" : "#1f6feb"));

const goApply = () => uni.navigateTo({ url: "/pages/teacher/apply/index" });
onMounted(load);

const toast = (title) => uni.showToast({ title, icon: "none" });

async function grab(d) {
  busy.value = "grab" + d.id;
  // 带当前位置抢单：服务端用实时定位判定是否超出服务半径（定位失败则按服务基点）
  const at = loc.value.lat != null ? { lat: loc.value.lat, lng: loc.value.lng } : {};
  const r = await req("POST", "/demands/" + d.id + "/apply", at);
  busy.value = "";
  toast(r ? "抢单成功，等待家长确认" : "抢单失败");
  load();
}

/** 上门打卡：优先取真实定位，失败则按上课地址附近上报 */
function checkinLocation(o) {
  return new Promise((resolve) => {
    uni.getLocation({
      type: "gcj02",
      success: (res) => resolve({ lat: res.latitude, lng: res.longitude }),
      fail: () => resolve({ lat: o.lat + 0.0005, lng: o.lng + 0.0005 }),
    });
  });
}

async function checkin(o) {
  busy.value = "checkin" + o.id;
  const here = await checkinLocation(o);
  const r = await req("POST", "/orders/" + o.id + "/checkin", here);
  busy.value = "";
  // 到教员处上课：双方都打完卡才开课（P66）
  toast(
    r
      ? o.place === "teacher_place" && !r.bothArrived
        ? "打卡成功，等家长到场打卡后自动开课"
        : "打卡成功（距上课地点 " + r.checkinDistance + " 米）"
      : "打卡失败：超出阈值或状态不符",
  );
  load();
}

async function finish(o) {
  busy.value = "finish" + o.id;
  const r = await req("POST", "/orders/" + o.id + "/finish", {});
  busy.value = "";
  toast(r ? "已结束授课，等待家长确认" : "操作失败");
  load();
}

/** 教员「同意退款」：家长取消申请 → 按规则退款（金额以服务端重算为准） */
async function approveCancel(o) {
  const paid = money(Number(o.amount || 0) + Number(o.urgentFee || 0));
  const yes = await new Promise((resolve) => {
    uni.showModal({
      title: "同意退款",
      content: "同意家长取消订单" + (paid ? "，按规则退款上限 " + paid : "") + "？退款后订单结束。",
      confirmText: "同意并退款",
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
  if (!yes) return;
  busy.value = "approve" + o.id;
  const r = await req("POST", "/teacher/orders/" + o.id + "/cancel-approve", {});
  busy.value = "";
  toast(r ? "已同意取消，退款 " + money(r.refundAmount) : "操作失败");
  load();
}

/** 教员「驳回」：不同意取消，订单继续履约（理由必填，会展示给家长） */
async function rejectCancel(o) {
  const reason = await new Promise((resolve) => {
    uni.showModal({
      title: "驳回取消申请",
      editable: true,
      placeholderText: "如：距离上课不足 2 小时，已按约定备好课件",
      confirmText: "驳回",
      success: (r) => resolve(r.confirm ? r.content || "" : null),
      fail: () => resolve(null),
    });
  });
  if (reason == null) return;
  if (String(reason).trim().length < 2) return toast("请填写驳回理由（至少 2 个字）");
  busy.value = "reject" + o.id;
  const r = await req("POST", "/teacher/orders/" + o.id + "/cancel-reject", { reason: String(reason).trim() });
  busy.value = "";
  toast(r ? "已驳回，订单继续履约" : "操作失败");
  load();
}

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

function goWallet() {
  uni.navigateTo({ url: "/pages/teacher/wallet/index" });
}

/** 协议阅读（P75）：用户协议 / 隐私政策 / 退款规则 */
function goAgreement(key) {
  uni.navigateTo({ url: "/pages/agreements/index?key=" + key });
}

function goMessages() {
  uni.navigateTo({ url: "/pages/messages/index" });
}
</script>

<template>
  <view class="wrap">
    <view class="card" @tap="goMessages">
      <view class="row"><view>消息中心</view><view class="tag">{{ unread ? unread + " 条未读" : "查看" }}</view></view>
    </view>

    <view class="card">
      <view class="card-title">{{ user.nickname || "教员" }} · {{ dash && dash.overview ? dash.overview.level : "Lv" }}</view>
      <view class="muted" v-if="level">
        成长分 {{ level.growthScore }} · 抽佣 {{ (level.commission * 100).toFixed(0) }}% · 派单权重 {{ level.levelWeight }}
      </view>
    </view>

    <!-- 入驻认证入口：没提交过 / 被驳回时才显著提示（已通过则只作为「查看资料」） -->
    <view class="card" @tap="goApply">
      <view class="row">
        <view>入驻认证</view>
        <view class="tag" :style="{ background: auditBg, color: auditColor }">{{ auditText }}</view>
      </view>
      <view class="muted" style="margin-top: 8rpx">
        {{ auditHint }}
      </view>
    </view>

    <view class="kpi" v-if="dash">
      <view class="item"><view class="k">今日课时</view><view class="v">{{ dash.overview.todayLessons }}</view></view>
      <view class="item"><view class="k">今日收入</view><view class="v">{{ money(dash.overview.todayIncome) }}</view></view>
      <view class="item"><view class="k">待处理订单</view><view class="v">{{ dash.pendingCount }}</view></view>
      <view class="item"><view class="k">钱包可用</view><view class="v">{{ money(dash.wallet.balance) }}</view></view>
    </view>

    <view class="card">
      <view class="card-title">我的订单（{{ orders.length }}）</view>
      <view v-for="o in orders" :key="o.id" class="row">
        <view style="flex: 1">
          <view style="font-size: 26rpx">{{ o.subject }} · {{ o.stage }}</view>
          <view class="muted">{{ o.orderNo }} · {{ money(o.teacherIncome) }}</view>
          <view class="muted">{{ o.statusText }}</view>
        </view>
        <view>
          <!-- 家长申请取消：教员在这里选「退款」或「驳回」 -->
          <template v-if="o.cancelRequested">
            <view class="btn" style="padding: 10rpx 20rpx; margin-bottom: 8rpx" @click="approveCancel(o)">
              {{ busy === "approve" + o.id ? "处理中…" : "同意退款" }}
            </view>
            <view class="btn ghost" style="padding: 10rpx 20rpx" @click="rejectCancel(o)">
              {{ busy === "reject" + o.id ? "处理中…" : "驳回" }}
            </view>
          </template>
          <view v-else-if="o.status === 'pending_class'" class="btn" style="padding: 10rpx 20rpx" @click="checkin(o)">
            {{ busy === "checkin" + o.id ? "打卡中…" : (o.place === "teacher_place" ? "教学点打卡" : "上门打卡") }}
          </view>
          <view v-if="o.status === 'in_class'" class="btn" style="padding: 10rpx 20rpx" @click="finish(o)">
            {{ busy === "finish" + o.id ? "提交中…" : "结束授课" }}
          </view>
          <!-- 到教员处上课：显示家长是否已到场（P66，双方都打卡后自动开课） -->
          <view v-if="o.status === 'pending_class' && o.place === 'teacher_place'" class="muted" style="font-size: 22rpx">
            家长 {{ o.parentArrived ? "已到场 ✅" : "待打卡 ⏳" }}
          </view>
        </view>
      </view>
      <view v-if="!orders.length" class="muted">暂无订单</view>
    </view>

    <!-- 我的服务（P67）：上架的服务决定家长能怎么约——支持上门 / 在教员家授课 -->
    <view class="card">
      <view class="row">
        <view class="card-title" style="margin: 0">我的服务（{{ services.length }}）</view>
        <view class="tag" @click="openSvc(null)">＋ 新增</view>
      </view>
      <view v-for="s in services" :key="s.id" class="row" style="margin-top: 16rpx; align-items: flex-start">
        <view style="flex: 1">
          <view style="font-size: 26rpx">{{ s.title }}</view>
          <view class="muted">{{ money(s.price) }} / 课时 · {{ s.status === "on" ? "上架中" : "已下架" }}</view>
          <view class="muted">授课形式：{{ s.placesText || "上门授课" }}</view>
        </view>
        <view>
          <view class="btn ghost" style="padding: 10rpx 20rpx; margin-bottom: 8rpx" @click="openSvc(s)">编辑</view>
          <view class="btn ghost" style="padding: 10rpx 20rpx" @click="toggleSvc(s)">
            {{ busy === "svc-toggle" + s.id ? "处理中…" : (s.status === "on" ? "下架" : "上架") }}
          </view>
        </view>
      </view>
      <view v-if="!services.length" class="muted" style="margin-top: 12rpx">还没有上架的服务，家长无法直接预约</view>

      <view v-if="svcForm.open" style="margin-top: 20rpx; border-top: 1px solid #eef4ff; padding-top: 16rpx">
        <view class="muted" style="margin-bottom: 8rpx">服务标题</view>
        <input v-model="svcForm.title" class="input" placeholder="如 初中数学一对一辅导" />
        <view class="muted" style="margin: 12rpx 0 8rpx">课时价（元）</view>
        <input v-model="svcForm.price" class="input" type="digit" placeholder="如 200" />
        <view class="muted" style="margin: 12rpx 0 8rpx">授课形式（可多选）</view>
        <view class="row" style="gap: 12rpx; flex-wrap: wrap; border-bottom: none">
          <view
            class="tag"
            :style="{ background: svcForm.places.includes('home') ? '#1f6feb' : '#eef4ff', color: svcForm.places.includes('home') ? '#fff' : '#1f6feb' }"
            @click="toggleSvcPlace('home')"
          >🏠 上门授课</view>
          <view
            class="tag"
            :style="{ background: svcForm.places.includes('teacher_place') ? '#1f6feb' : '#eef4ff', color: svcForm.places.includes('teacher_place') ? '#fff' : '#1f6feb' }"
            @click="toggleSvcPlace('teacher_place')"
          >📍 在教员家授课</view>
        </view>
        <view class="muted" style="font-size: 22rpx; margin-top: 6rpx">
          选「在教员家」前请先在入驻资料里填「授课地址」；家长预约时只能选该服务支持的形式。
        </view>
        <view class="muted" style="margin: 12rpx 0 8rpx">服务说明（可选）</view>
        <input v-model="svcForm.description" class="input" placeholder="教学方式、提分计划等" />
        <view class="row" style="gap: 12rpx; margin-top: 16rpx; border-bottom: none">
          <view class="btn ghost" @click="svcForm.open = false">取消</view>
          <view class="btn" @click="saveSvc">{{ busy === "svc-save" ? "保存中…" : "保存" }}</view>
        </view>
      </view>
    </view>
    <view class="card">
      <view class="row">
        <view class="card-title" style="margin: 0">附近需求（{{ demands.length }}）</view>
        <view class="tag" data-act="relocate" @click="relocalize">{{ locating ? "定位中…" : "重新定位" }}</view>
      </view>
      <view class="muted" style="margin-top: 8rpx">{{ locText }}</view>
      <view v-for="d in demands" :key="d.id" class="row" style="margin-top: 16rpx">
        <view style="flex: 1">
          <view style="font-size: 26rpx">{{ d.subject }} · {{ d.stage }}</view>
          <view class="muted">{{ d.mode === "teacher_place" ? "📍 到我这里上课" : "🏠 我上门授课" }}</view>
          <view class="muted">{{ d.address }}</view>
          <view class="muted">{{ d.distanceKm }} km · 优先级 {{ d.priority }}</view>
        </view>
        <view class="btn ghost" style="padding: 10rpx 20rpx" @click="grab(d)">
          {{ busy === "grab" + d.id ? "抢单中…" : "抢单" }}
        </view>
      </view>
      <view v-if="!demands.length" class="muted" style="margin-top: 12rpx">当前定位附近没有可接的需求</view>
    </view>
    <view class="card" @tap="goWallet">
      <view class="row"><view>我的钱包（提现 / 流水）</view><view class="tag">进入 →</view></view>
    </view>
    <!-- 合规（P75）：教员端同样能查三份协议，文案由后台「运营工具 → 协议文案」维护 -->
    <view class="card">
      <view class="row" style="gap: 16rpx; flex-wrap: wrap">
        <view class="muted" @tap="goAgreement('user')">用户协议</view>
        <view class="muted" @tap="goAgreement('privacy')">隐私政策</view>
        <view class="muted" @tap="goAgreement('refund')">退款规则</view>
      </view>
    </view>
  </view>
</template>
