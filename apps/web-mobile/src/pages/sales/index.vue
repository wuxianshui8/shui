<script setup>
import { onMounted, ref } from "vue";

const dash = ref(null);
const customers = ref([]);
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
  dash.value = await req("/sales/dashboard");
  const c = await req("/sales/customers");
  customers.value = (c && c.list) || [];
});

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

function goRewards() {
  uni.navigateTo({ url: "/pages/sales/rewards/index" });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">{{ user.nickname || "业务员" }}</view>
      <view class="muted" v-if="dash && dash.agent">{{ dash.agent.regionName }} · 上级 {{ dash.agent.name }}</view>
    </view>
    <view class="kpi" v-if="dash">
      <view class="item"><view class="k">本月注册</view><view class="v">{{ dash.month.registrations }}</view></view>
      <view class="item"><view class="k">本月成交</view><view class="v">{{ dash.month.deals }}</view></view>
      <view class="item"><view class="k">本月 GMV</view><view class="v">{{ money(dash.month.gmv) }}</view></view>
      <view class="item"><view class="k">待结奖励</view><view class="v">{{ money(dash.rewards.pending) }}</view></view>
    </view>
    <view class="card" v-if="dash">
      <view class="card-title">推广二维码通道</view>
      <view v-for="c in dash.codes" :key="c.id" class="row">
        <view>{{ c.target === "parent" ? "家长通道" : "教员通道" }}</view>
        <view class="tag">{{ c.token }}</view>
      </view>
    </view>
    <view class="card">
      <view class="card-title">我的客户（{{ customers.length }}）</view>
      <view v-for="c in customers" :key="c.id" class="row">
        <view>
          <view style="font-size: 26rpx">{{ c.nickname }}</view>
          <view class="muted">{{ c.phone }}</view>
        </view>
        <view class="tag">{{ c.status }}</view>
      </view>
      <view v-if="!customers.length" class="muted">暂无客户</view>
    </view>
    <view class="card" @tap="goRewards">
      <view class="row"><view>奖励明细（按类型汇总 / 筛选）</view><view class="tag">查看 →</view></view>
    </view>
  </view>
</template>
