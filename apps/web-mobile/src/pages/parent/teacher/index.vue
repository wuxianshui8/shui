<script setup>
import { onLoad, onShow } from "@dcloudio/uni-app";
import { computed, reactive, ref } from "vue";
import { goLogin, isLogin, request } from "../../../auth.js";

const id = ref(0);
const teacher = ref(null);
const addrs = ref([]);
const loading = ref(true);
const guest = ref(!isLogin());
const booking = ref(false);
const submitting = ref(false);
const addingAddr = ref(false);

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const pad = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
};

const draft = reactive({
  serviceId: 0,
  addressId: 0,
  // 授课方式（P65）：home=教员上门 / teacher_place=家长到教员处（教员填了授课地址才可选）
  place: "home",
  date: today(),
  start: "19:00",
  end: "20:30",
  remark: "",
});
// 新家长（如微信登录）还没有地址时，就地填一个再约
const newAddr = reactive({ contact: "", phone: "", address: "", label: "家" });

const services = computed(() => (teacher.value && teacher.value.services) || []);
const chosenService = computed(() => services.value.find((s) => Number(s.id) === Number(draft.serviceId)) || services.value[0] || null);
// 授课形式（P67）：由**所选服务**决定它支持「上门授课 / 在教员家授课」
const svcPlaces = computed(() => {
  const s = chosenService.value;
  return Array.isArray(s && s.places) && s.places.length ? s.places : ["home"];
});
const atTeacher = computed(
  () => !!(teacher.value && teacher.value.acceptAtTeacherPlace) && svcPlaces.value.includes("teacher_place"),
);
const canBook = computed(() => {
  if (!chosenService.value || !draft.date || !draft.start) return false;
  if (draft.place === "teacher_place") return atTeacher.value;
  return svcPlaces.value.includes("home") && !!draft.addressId;
});

onLoad((options) => {
  id.value = Number((options && options.id) || 0);
});

/** 换服务时把授课方式收敛到该服务支持的形式（P67） */
function pickService(s) {
  draft.serviceId = Number(s.id);
  const opts = Array.isArray(s && s.places) && s.places.length ? s.places : ["home"];
  if (!opts.includes(draft.place)) draft.place = opts[0];
}

// 每次进入/回到本页都重新读一次：登录回来后要立刻从「需登录」变成可预约，并把地址补上
onShow(() => {
  void loadTeacher();
});

async function loadTeacher() {
  if (!id.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  guest.value = !isLogin();
  try {
    const base = isLogin() ? "/parent/teachers/" : "/public/teachers/";
    const t = await request("GET", base + id.value + "?lat=30.262&lng=120.133").catch(() => null);
    teacher.value = t;
    if (t && t.services && t.services.length && !draft.serviceId) draft.serviceId = Number(t.services[0].id);
    if (isLogin()) {
      const list = await request("GET", "/addresses").catch(() => []);
      addrs.value = list || [];
      if (!draft.addressId) {
        const def = addrs.value.find((a) => Number(a.is_default) === 1) || addrs.value[0] || null;
        if (def) draft.addressId = Number(def.id);
        else addingAddr.value = true;
      }
    }
  } finally {
    loading.value = false;
  }
}

function openBooking() {
  if (guest.value) {
    // 游客点「立即预约」→ 先登录，登录后回到本页继续
    goLogin("/pages/parent/teacher/index?id=" + id.value);
    return;
  }
  booking.value = true;
}

async function saveAddr() {
  if (!String(newAddr.contact || "").trim()) return uni.showToast({ title: "请填写联系人", icon: "none" });
  if (!String(newAddr.address || "").trim()) return uni.showToast({ title: "请填写详细地址", icon: "none" });
  try {
    // 手填地址按服务片区默认坐标落库（与家长端首页「手填地址」口径一致）
    const a = await request("POST", "/addresses", {
      label: newAddr.label || "家",
      contact: String(newAddr.contact).trim(),
      phone: String(newAddr.phone || "").trim(),
      address: String(newAddr.address).trim(),
      lat: 30.262,
      lng: 120.133,
    });
    addrs.value = addrs.value.concat([a]);
    draft.addressId = Number(a.id);
    addingAddr.value = false;
    uni.showToast({ title: "地址已保存", icon: "none" });
  } catch (e) {
    uni.showToast({ title: e.message || "地址保存失败", icon: "none" });
  }
}

async function submit() {
  if (!chosenService.value) return uni.showToast({ title: "该教员暂未上架可预约服务", icon: "none" });
  if (draft.place !== "teacher_place" && !draft.addressId) return uni.showToast({ title: "请先添加上课地址", icon: "none" });
  if (!draft.date || !draft.start) return uni.showToast({ title: "请选择上课时间", icon: "none" });
  const startAt = new Date(draft.date + "T" + draft.start + ":00");
  if (Number.isNaN(startAt.getTime())) return uni.showToast({ title: "上课时间格式不正确", icon: "none" });
  if (startAt.getTime() < Date.now()) return uni.showToast({ title: "上课时间不能早于现在", icon: "none" });

  submitting.value = true;
  try {
    const order = await request("POST", "/orders/from-service", {
      serviceId: Number(chosenService.value.id),
      lessonTime: startAt.toISOString(),
      lessonEnd: draft.end ? draft.date + "T" + draft.end + ":00" : null,
      addressId: draft.place === "teacher_place" ? undefined : Number(draft.addressId),
      place: draft.place,
      remark: String(draft.remark || "").trim(),
    });
    uni.showToast({ title: "预约已创建，去支付", icon: "none" });
    booking.value = false;
    setTimeout(() => {
      uni.navigateTo({ url: "/pages/parent/order/index?id=" + order.id });
    }, 700);
  } catch (e) {
    uni.showToast({ title: e.message || "预约失败", icon: "none" });
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <view class="wrap">
    <view v-if="loading" class="card muted">加载中…</view>

    <template v-else-if="teacher">
      <!-- 教员卡片 -->
      <view class="card">
        <view class="row" style="border-bottom: none">
          <view style="flex: 1">
            <view class="row" style="border-bottom: none; padding: 0; gap: 10rpx; justify-content: flex-start">
              <text style="font-size: 34rpx; font-weight: 700">{{ teacher.nickname }}</text>
              <text class="tag">{{ teacher.levelName || teacher.level }}</text>
              <text v-if="teacher.online" class="tag" style="background: #e7f8ee; color: #15803d">在线</text>
            </view>
            <view class="muted" style="margin-top: 10rpx">
              距您 {{ teacher.distanceKm }} km · 评分 {{ Number(teacher.ratingAvg || 0).toFixed(1) }}（{{ teacher.ratingCount || 0 }}）· 服务半径 {{ teacher.serviceRadiusKm }} km
            </view>
            <view class="row" style="border-bottom: none; padding: 10rpx 0 0; gap: 10rpx; justify-content: flex-start; flex-wrap: wrap">
              <text v-for="s in (teacher.subjects || [])" :key="s" class="tag" style="background: #f4f6fa; color: #475569">{{ s }}</text>
              <text v-for="s in (teacher.stages || [])" :key="'st' + s" class="tag" style="background: #f4f6fa; color: #475569">{{ s }}</text>
            </view>
          </view>
          <view style="text-align: right">
            <view style="font-size: 32rpx; font-weight: 700; color: #1f6feb">{{ money(teacher.hourlyPrice) }}</view>
            <view class="muted">元/课时</view>
          </view>
        </view>
        <view v-if="teacher.intro" class="muted" style="margin-top: 14rpx; line-height: 1.7">{{ teacher.intro }}</view>
      </view>

      <!-- 可预约服务 -->
      <view class="card">
        <view class="card-title">可预约服务（{{ services.length }}）</view>
        <view v-if="!services.length" class="muted">该教员暂未上架可预约服务，可先发布需求等教员抢单。</view>
        <view v-for="s in services" :key="s.id" class="row">
          <view style="flex: 1">
            <view style="font-size: 28rpx">{{ s.title }}</view>
            <view class="muted">{{ s.subjects }} · {{ s.stages }} · 服务半径 {{ s.cover_radius_km || s.coverRadiusKm || teacher.serviceRadiusKm }} km</view>
          </view>
          <view style="font-weight: 700; color: #1f6feb">{{ money(s.price) }}</view>
        </view>
      </view>

      <!-- 评价 -->
      <view class="card" v-if="(teacher.reviews || []).length">
        <view class="card-title">学员评价（{{ teacher.reviews.length }}）</view>
        <view v-for="r in teacher.reviews.slice(0, 5)" :key="r.id" class="row">
          <view style="flex: 1">
            <view class="muted">{{ r.parentName || "家长" }} · {{ "★".repeat(r.score) }}</view>
            <view style="font-size: 26rpx; margin-top: 6rpx">{{ r.content }}</view>
          </view>
        </view>
      </view>

      <!-- 立即预约 -->
      <view v-if="!booking" class="card">
        <view class="btn" @click="openBooking">{{ guest ? "立即预约（需登录）" : "立即预约" }}</view>
        <view class="muted" style="margin-top: 16rpx">
          预约后课时费进入平台担保账户，上课确认完成后 T+7 结算给教员；未排课可在开课前 4 小时免费取消。
        </view>
      </view>

      <!-- 预约表单 -->
      <view v-else class="card">
        <view class="card-title">填写预约信息</view>

        <view class="muted" style="margin-bottom: 10rpx">选择服务</view>
        <view class="row" style="flex-wrap: wrap; gap: 12rpx; border-bottom: none; justify-content: flex-start">
          <view
            v-for="s in services"
            :key="s.id"
            class="tag"
            :style="{ background: Number(draft.serviceId) === Number(s.id) ? '#1f6feb' : '#eef4ff', color: Number(draft.serviceId) === Number(s.id) ? '#fff' : '#1f6feb' }"
            @click="pickService(s)"
          >{{ s.title }} · {{ money(s.price) }}{{ Array.isArray(s.places) && s.places.length > 1 ? "（可到老师家）" : "" }}</view>
        </view>

        <!-- 授课方式（P67）：由所选服务支持的形式决定给哪几个选项 -->
        <view v-if="svcPlaces.length > 1" class="muted" style="margin: 20rpx 0 10rpx">授课方式</view>
        <view v-if="svcPlaces.length > 1" class="row" style="flex-wrap: wrap; gap: 12rpx; border-bottom: none">
          <view
            v-if="svcPlaces.includes('home')"
            class="tag"
            :style="{ background: draft.place === 'home' ? '#1f6feb' : '#eef4ff', color: draft.place === 'home' ? '#fff' : '#1f6feb' }"
            @click="draft.place = 'home'"
          >🏠 教员上门</view>
          <view
            v-if="atTeacher"
            class="tag"
            :style="{ background: draft.place === 'teacher_place' ? '#1f6feb' : '#eef4ff', color: draft.place === 'teacher_place' ? '#fff' : '#1f6feb' }"
            @click="draft.place = 'teacher_place'"
          >📍 我到教员处</view>
        </view>
        <view class="muted" style="margin-bottom: 12rpx; font-size: 24rpx">
          {{ draft.place === 'teacher_place'
            ? '教员授课地址：' + ((teacher && teacher.baseAddress) || '')
            : (svcPlaces.includes('home') ? '教员到您选择的上课地址授课' : '该服务仅支持在教员家授课') }}
        </view>

        <template v-if="draft.place !== 'teacher_place'">
        <view class="muted" style="margin: 20rpx 0 10rpx">上课地址</view>
        <picker v-if="addrs.length" :range="addrs" range-key="address" @change="(e) => (draft.addressId = Number(addrs[e.detail.value].id))">
          <view class="input">
            {{ (addrs.find((a) => Number(a.id) === Number(draft.addressId)) || {}).address || "请选择地址" }}
          </view>
        </picker>
        <view v-else class="muted">还没有上课地址，请在下面添加。</view>

        <view v-if="addingAddr">
          <input v-model="newAddr.contact" class="input" placeholder="联系人（如 周女士）" />
          <input v-model="newAddr.phone" class="input" type="number" placeholder="联系电话" />
          <input v-model="newAddr.address" class="input" placeholder="详细地址（小区 + 楼幢门牌）" />
          <view class="btn ghost" @click="saveAddr">保存地址</view>
        </view>
        <view v-else class="muted" style="margin-bottom: 12rpx" @click="addingAddr = true">＋ 添加新地址</view>
        </template>

        <view class="muted" style="margin: 8rpx 0 10rpx">上课日期</view>
        <picker mode="date" :value="draft.date" @change="(e) => (draft.date = e.detail.value)">
          <view class="input">{{ draft.date }}</view>
        </picker>

        <view class="row" style="border-bottom: none; gap: 16rpx">
          <view style="flex: 1">
            <view class="muted" style="margin-bottom: 10rpx">开始时间</view>
            <picker mode="time" :value="draft.start" @change="(e) => (draft.start = e.detail.value)">
              <view class="input">{{ draft.start }}</view>
            </picker>
          </view>
          <view style="flex: 1">
            <view class="muted" style="margin-bottom: 10rpx">结束时间</view>
            <picker mode="time" :value="draft.end" @change="(e) => (draft.end = e.detail.value)">
              <view class="input">{{ draft.end }}</view>
            </picker>
          </view>
        </view>

        <view class="muted" style="margin: 8rpx 0 10rpx">备注（可选）</view>
        <input v-model="draft.remark" class="input" placeholder="孩子年级、薄弱环节、希望重点提升的内容" />

        <view class="muted" style="margin-bottom: 14rpx">
          课时费 {{ chosenService ? money(chosenService.price) : "-" }} 支付后进入平台担保账户；上课确认完成后 T+7 结算给教员。
        </view>
        <view class="btn" :class="{ ghost: !canBook }" @click="submit">{{ submitting ? "提交中…" : "提交预约并去支付" }}</view>
        <view class="muted" style="margin-top: 14rpx" @click="booking = false">取消</view>
      </view>
    </template>

    <view v-else class="card muted">教员不存在或已下架。</view>
  </view>
</template>
