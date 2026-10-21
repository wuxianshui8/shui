<script setup>
import { computed, onMounted, ref } from "vue";

const data = ref(null);
const filter = ref("");
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

async function load() {
  data.value = await req("/sales/rewards" + (filter.value ? "?type=" + filter.value : ""));
}
onMounted(load);

function pick(t) {
  filter.value = filter.value === t ? "" : t;
  load();
}

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const STATUS = { pending: "待结算", settled: "已结算", cancelled: "已取消" };
const list = computed(() => (data.value && data.value.list) || []);
const byType = computed(() => {
  const m = {};
  ((data.value && data.value.byType) || []).forEach((r) => {
    m[r.type] = { count: Number(r.c), total: Number(r.total) };
  });
  return m;
});
const pending = computed(() => list.value.filter((r) => r.status === "pending").reduce((s, r) => s + Number(r.amount || 0), 0));

function back() {
  uni.navigateBack({ delta: 1 });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">奖励明细{{ user.nickname ? " · " + user.nickname : "" }}</view>
      <view class="muted">筛选类型可点下方标签，再次点击取消筛选</view>
    </view>

    <view class="kpi">
      <view class="item"><view class="k">钱包可用</view><view class="v">{{ money(data && data.wallet && data.wallet.balance) }}</view></view>
      <view class="item"><view class="k">当前筛选待结</view><view class="v">{{ money(pending) }}</view></view>
      <view class="item"><view class="k">明细条数</view><view class="v">{{ list.length }}</view></view>
    </view>

    <view class="card">
      <view class="card-title">按类型汇总</view>
      <view v-for="t in (data && data.types) || []" :key="t.value" class="row" @tap="pick(t.value)">
        <view>
          {{ t.label }}
          <text class="muted">（{{ (byType[t.value] && byType[t.value].count) || 0 }} 笔）</text>
        </view>
        <view style="text-align: right">
          <view style="font-size: 26rpx">{{ money((byType[t.value] && byType[t.value].total) || 0) }}</view>
          <view class="tag" v-if="filter === t.value">筛选中</view>
        </view>
      </view>
    </view>

    <view class="card">
      <view class="card-title">明细列表{{ filter ? "（" + filter + "）" : "" }}</view>
      <view v-for="r in list" :key="r.id" class="row">
        <view>
          <view style="font-size: 26rpx">{{ r.type }} · 订单 {{ r.order_no || "-" }}</view>
          <view class="muted">{{ r.created_at }}</view>
        </view>
        <view style="text-align: right">
          <view style="font-size: 26rpx">{{ money(r.amount) }}</view>
          <view class="tag">{{ STATUS[r.status] || r.status }}</view>
        </view>
      </view>
      <view v-if="!list.length" class="muted">暂无奖励记录</view>
    </view>

    <view class="card">
      <view class="row" @tap="back"><view>返回业务员首页</view><view class="tag">返回</view></view>
    </view>
  </view>
</template>
