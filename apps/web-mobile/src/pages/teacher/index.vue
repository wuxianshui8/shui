<script setup>
import { onMounted, ref } from "vue";

const dash = ref(null);
const level = ref(null);
const demands = ref([]);
const orders = ref([]);
const busy = ref("");
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

async function load() {
  dash.value = await req("GET", "/teacher/dashboard");
  level.value = await req("GET", "/teacher/level");
  const list = await req("GET", "/teacher/nearby-demands");
  demands.value = (list && list.list) || [];
  const mine = await req("GET", "/teacher/orders");
  orders.value = (mine && mine.list) || [];
}
onMounted(load);

const toast = (title) => uni.showToast({ title, icon: "none" });

async function grab(d) {
  busy.value = "grab" + d.id;
  const r = await req("POST", "/demands/" + d.id + "/apply", {});
  busy.value = "";
  toast(r ? "抢单成功，等待家长确认" : "抢单失败");
  load();
}

/** 上门打卡：优先取真实定位，失败则按上课地址附近上报 */
function getLocation(o) {
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
  const loc = await getLocation(o);
  const r = await req("POST", "/orders/" + o.id + "/checkin", loc);
  busy.value = "";
  toast(r ? "打卡成功（距上课地点 " + r.checkinDistance + " 米）" : "打卡失败：超出阈值或状态不符");
  load();
}

async function finish(o) {
  busy.value = "finish" + o.id;
  const r = await req("POST", "/orders/" + o.id + "/finish", {});
  busy.value = "";
  toast(r ? "已结束授课，等待家长确认" : "操作失败");
  load();
}

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

function goWallet() {
  uni.navigateTo({ url: "/pages/teacher/wallet/index" });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">{{ user.nickname || "教员" }} · {{ dash && dash.overview ? dash.overview.level : "Lv" }}</view>
      <view class="muted" v-if="level">
        成长分 {{ level.growthScore }} · 抽佣 {{ (level.commission * 100).toFixed(0) }}% · 派单权重 {{ level.levelWeight }}
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
          <view v-if="o.status === 'pending_class'" class="btn" style="padding: 10rpx 20rpx" @click="checkin(o)">
            {{ busy === "checkin" + o.id ? "打卡中…" : "上门打卡" }}
          </view>
          <view v-else-if="o.status === 'in_class'" class="btn" style="padding: 10rpx 20rpx" @click="finish(o)">
            {{ busy === "finish" + o.id ? "提交中…" : "结束授课" }}
          </view>
        </view>
      </view>
      <view v-if="!orders.length" class="muted">暂无订单</view>
    </view>

    <view class="card">
      <view class="card-title">附近需求（{{ demands.length }}）</view>
      <view v-for="d in demands" :key="d.id" class="row">
        <view style="flex: 1">
          <view style="font-size: 26rpx">{{ d.subject }} · {{ d.stage }}</view>
          <view class="muted">{{ d.address }}</view>
          <view class="muted">{{ d.distanceKm }} km · 优先级 {{ d.priority }}</view>
        </view>
        <view class="btn ghost" style="padding: 10rpx 20rpx" @click="grab(d)">
          {{ busy === "grab" + d.id ? "抢单中…" : "抢单" }}
        </view>
      </view>
      <view v-if="!demands.length" class="muted">暂无附近需求</view>
    </view>
    <view class="card" @tap="goWallet">
      <view class="row"><view>我的钱包（提现 / 流水）</view><view class="tag">进入 →</view></view>
    </view>
  </view>
</template>
