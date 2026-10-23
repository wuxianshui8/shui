<script setup>
import { onShow } from "@dcloudio/uni-app";
import { ref } from "vue";
import { currentUser, goLogin, isLogin, request } from "../../auth.js";

const home = ref(null);
const orders = ref([]);
const user = ref(currentUser());
const busy = ref("");
const unread = ref(0);
/** 游客态：没登录也能看首页与「发布家教需求」；订单/消息才要求登录 */
const guest = ref(!isLogin());

function toast(title) {
  uni.showToast({ title, icon: "none" });
}

async function load() {
  guest.value = !isLogin();
  user.value = currentUser();
  // 游客走公开接口拿片区 / 附近在线教员 / 加急费；登录后同一份页面换成个人首页
  home.value = await request("GET", "/public/home?lat=30.262&lng=120.133").catch(() => null);
  if (isLogin()) {
    home.value = await request("GET", "/parent/home?lat=30.262&lng=120.133").catch(() => home.value);
    const msgs = await request("GET", "/messages").catch(() => null);
    unread.value = (msgs && msgs.unread) || 0;
    const list = await request("GET", "/parent/orders").catch(() => null);
    orders.value = (list && list.list) || [];
  } else {
    unread.value = 0;
    orders.value = [];
  }
}
onShow(load);

async function pay(o) {
  busy.value = "pay" + o.id;
  const r = await new Promise((resolve) => {
    uni.request({
      url: "/api/orders/" + o.id + "/pay",
      method: "POST",
      data: {},
      header: { Authorization: "Bearer " + uni.getStorageSync("token"), "Content-Type": "application/json", "X-Idem-Key": "m-pay-" + o.id + "-" + Date.now() },
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
  const r = await request("POST", "/orders/" + o.id + "/confirm", {}).catch(() => null);
  busy.value = "";
  toast(r ? "已确认完成，课时费进入冻结期" : "操作失败");
  load();
}

async function review(o) {
  busy.value = "review" + o.id;
  const r = await request("POST", "/orders/" + o.id + "/review", { score: 5, content: "移动端评价：讲解清晰", tags: ["准时"] }).catch(() => null);
  busy.value = "";
  toast(r ? "评价成功（权重 " + r.weight + "）" : "评价失败");
  load();
}

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

/** 发布需求对游客开放：直接进表单页，提交时才要求登录 */
function goPublish() {
  uni.navigateTo({ url: "/pages/parent/publish/index" });
}

/** 消息 / 订单是「我的」数据：游客先登录，登录后回到该页 */
function goMessages() {
  if (guest.value) {
    goLogin("/pages/messages/index");
    return;
  }
  uni.navigateTo({ url: "/pages/messages/index" });
}

function goLoginNow() {
  goLogin("");
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">{{ guest ? "你好，先看看家教需求页吧" : "您好，" + (user.nickname || "家长") }}</view>
      <view class="muted" v-if="home">当前片区：{{ home.region ? home.region.name : "未定位" }}（未登录也能看到，登录后按您的地址推荐）</view>
      <view class="btn" style="margin-top: 20rpx" @click="goPublish">发布家教需求</view>
      <view class="muted" v-if="guest" style="margin-top: 16rpx">
        不用登录就能填表；点「发布需求」时再登录，登录后自动发布。
      </view>
    </view>

    <view class="card" v-if="guest">
      <view class="row">
        <view style="flex: 1">
          <view class="bold">登录后可查看订单与消息</view>
          <view class="muted">担保支付、上课打卡、售后客服都在登录后可用</view>
        </view>
        <view class="btn ghost" style="padding: 10rpx 24rpx" @click="goLoginNow">登录</view>
      </view>
    </view>

    <view class="card" @tap="goMessages">
      <view class="row"><view>消息中心</view><view class="tag">{{ guest ? "登录后查看" : unread ? unread + " 条未读" : "查看" }}</view></view>
    </view>

    <view class="kpi" v-if="home">
      <view class="item"><view class="k">附近在线教员</view><view class="v">{{ (home.teachers || []).length }}</view></view>
      <view class="item"><view class="k">{{ guest ? "加急费起" : "可领优惠券" }}</view><view class="v">{{ guest ? money(home.urgentFee) : (home.couponCount || 0) + " 张" }}</view></view>
    </view>

    <view class="card" v-if="!guest">
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
