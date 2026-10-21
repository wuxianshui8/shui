<script setup>
import { onMounted, reactive, ref } from "vue";

const home = ref(null);
const orders = ref([]);
const user = uni.getStorageSync("user") || {};
const busy = ref("");

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
  home.value = await req("GET", "/parent/home?lat=30.262&lng=120.133");
  const list = await req("GET", "/parent/orders");
  orders.value = (list && list.list) || [];
}
onMounted(load);

function toast(title) {
  uni.showToast({ title, icon: "none" });
}

async function pay(o) {
  busy.value = "pay" + o.id;
  const idem = "m-pay-" + o.id + "-" + Date.now();
  const r = await new Promise((resolve) => {
    uni.request({
      url: "/api/orders/" + o.id + "/pay",
      method: "POST",
      data: {},
      header: { Authorization: "Bearer " + uni.getStorageSync("token"), "Content-Type": "application/json", "X-Idem-Key": idem },
      success: (res) => resolve(res.data && res.data.code === 0 ? res.data.data : null),
      fail: () => resolve(null),
    });
  });
  busy.value = "";
  toast(r ? "担保支付成功" : "支付失败");
  load();
}

async function confirmDone(o) {
  busy.value = "confirm" + o.id;
  const r = await req("POST", "/orders/" + o.id + "/confirm", {});
  busy.value = "";
  toast(r ? "已确认完成，课时费进入冻结期" : "操作失败");
  load();
}

async function review(o) {
  busy.value = "review" + o.id;
  const r = await req("POST", "/orders/" + o.id + "/review", { score: 5, content: "移动端评价：讲解清晰", tags: ["准时"] });
  busy.value = "";
  toast(r ? "评价成功（权重 " + r.weight + "）" : "评价失败");
  load();
}

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">您好，{{ user.nickname || "家长" }}</view>
      <view class="muted" v-if="home">当前片区：{{ home.region ? home.region.name : "未定位" }}</view>
      <view class="btn" style="margin-top: 20rpx" @click="uni.navigateTo({ url: '/pages/parent/publish/index' })">发布家教需求</view>
    </view>

    <view class="kpi" v-if="home">
      <view class="item"><view class="k">附近在线教员</view><view class="v">{{ (home.nearbyTeachers || []).length }}</view></view>
      <view class="item"><view class="k">可领优惠券</view><view class="v">{{ (home.coupons || []).length }}</view></view>
    </view>

    <view class="card">
      <view class="card-title">我的订单（{{ orders.length }}）</view>
      <view v-for="o in orders" :key="o.id" class="row">
        <view style="flex: 1">
          <view style="font-size: 26rpx">{{ o.subject }} · {{ o.stage }}</view>
          <view class="muted">{{ o.orderNo }}</view>
          <view class="muted">{{ money(o.amount) }} · {{ o.statusText }}</view>
        </view>
        <view>
          <view v-if="o.status === 'awaiting_payment'" class="btn" style="padding: 10rpx 20rpx" @click="pay(o)">
            {{ busy === "pay" + o.id ? "支付中…" : "支付" }}
          </view>
          <view v-else-if="o.status === 'awaiting_parent_confirm'" class="btn" style="padding: 10rpx 20rpx" @click="confirmDone(o)">
            {{ busy === "confirm" + o.id ? "处理中…" : "确认完成" }}
          </view>
          <view v-else-if="o.status === 'completed' && !o.hasReview" class="btn ghost" style="padding: 10rpx 20rpx" @click="review(o)">
            {{ busy === "review" + o.id ? "提交中…" : "去评价" }}
          </view>
        </view>
      </view>
      <view v-if="!orders.length" class="muted">暂无订单，先发布需求吧</view>
    </view>
  </view>
</template>
