<script setup>
import { onMounted, ref } from "vue";

const dash = ref(null);
const orders = ref([]);
const user = uni.getStorageSync("user") || {};

function req(path) {
  return new Promise((resolve) => {
    uni.request({
      url: "/api" + path,
      header: { Authorization: "Bearer " + uni.getStorageSync("token") },
      success: (res) => resolve(res.data && res.data.code === 0 ? res.data.data : null),
      fail: () => resolve(null),
    });
  });
}

onMounted(async () => {
  dash.value = await req("/agent/dashboard");
  const o = await req("/agent/orders");
  orders.value = (o && o.list) || [];
});

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

function goComplaints() {
  uni.navigateTo({ url: "/pages/agent/complaints/index" });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">{{ user.nickname || "区域代理" }}</view>
      <view class="muted" v-if="dash && dash.region">{{ dash.region.name }}</view>
    </view>
    <view class="kpi" v-if="dash">
      <view class="item"><view class="k">本月 GMV</view><view class="v">{{ money(dash.metrics.monthGmv) }}</view></view>
      <view class="item"><view class="k">本月订单</view><view class="v">{{ dash.metrics.monthOrders }}</view></view>
      <view class="item"><view class="k">业务员</view><view class="v">{{ dash.metrics.salesCount }}</view></view>
      <view class="item"><view class="k">待结算分成</view><view class="v">{{ money(dash.metrics.pendingSettle) }}</view></view>
    </view>
    <view class="card" v-if="dash && dash.assessment">
      <view class="card-title">考核完成度</view>
      <view class="row"><view>GMV 完成度</view><view class="tag">{{ dash.assessment.gmvRate }}%</view></view>
      <view class="row"><view>订单完成度</view><view class="tag">{{ dash.assessment.orderRate }}%</view></view>
      <view class="row"><view>业务员完成度</view><view class="tag">{{ dash.assessment.salesRate }}%</view></view>
      <view class="row"><view>综合评分</view><view class="tag">{{ dash.assessment.score }} · {{ dash.assessment.status }}</view></view>
    </view>
    <view class="card">
      <view class="card-title">片区订单（{{ orders.length }}）</view>
      <view v-for="o in orders" :key="o.id" class="row">
        <view>
          <view style="font-size: 26rpx">{{ o.subject }} · {{ o.stage }}</view>
          <view class="muted">{{ o.address }}</view>
        </view>
        <view style="text-align: right">
          <view style="font-size: 26rpx">{{ money(o.amount) }}</view>
          <view class="tag">{{ o.statusText }}</view>
        </view>
      </view>
      <view v-if="!orders.length" class="muted">暂无片区订单</view>
    </view>
    <view class="card" @tap="goComplaints">
      <view class="row"><view>客诉工单处理</view><view class="tag">查看 →</view></view>
    </view>
  </view>
</template>
