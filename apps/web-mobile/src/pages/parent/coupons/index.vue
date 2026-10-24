<template>
  <view class="page">
    <view class="card">
      <view class="row">
        <view class="card-title" style="margin: 0">我的优惠券（{{ usableCount }} 张可用）</view>
        <view class="tag" @click="load">刷新</view>
      </view>
      <view class="muted" style="margin-top: 8rpx">下单时自动可选；已使用/不可用的券在这里可查。</view>
    </view>

    <view class="card">
      <view class="card-title" style="margin: 0 0 10rpx">可用</view>
      <view v-for="c in usable" :key="c.id" class="row" style="margin-top: 16rpx">
        <view style="flex: 1">
          <view style="font-size: 28rpx; font-weight: 700">{{ c.name }}</view>
          <view class="muted">满 {{ money(c.threshold) }} 可用 · 立减 {{ money(c.amount) }}</view>
          <view class="muted">领取于 {{ (c.claimedAt || "").slice(0, 10) }}</view>
        </view>
        <view class="tag" style="background: #eef4ff; color: #1f6feb">-{{ money(c.amount) }}</view>
      </view>
      <view v-if="!usable.length" class="muted">暂无可用券，去下面领一张</view>
    </view>

    <view class="card">
      <view class="card-title" style="margin: 0 0 10rpx">领取中心</view>
      <view v-for="c in claimable" :key="c.id" class="row" style="margin-top: 16rpx">
        <view style="flex: 1">
          <view style="font-size: 28rpx; font-weight: 700">{{ c.name }}</view>
          <view class="muted">满 {{ money(c.threshold) }} 可用 · 立减 {{ money(c.amount) }}</view>
          <view class="muted">{{ claimedText(c) }}</view>
        </view>
        <view
          class="btn"
          :class="{ ghost: claimedIds.includes(Number(c.id)) }"
          style="padding: 10rpx 24rpx"
          @click="claim(c)"
        >
          {{ claimedIds.includes(Number(c.id)) ? "已领" : claiming === c.id ? "领取中…" : "领取" }}
        </view>
      </view>
      <view v-if="!claimable.length" class="muted">暂无可领的券</view>
    </view>

    <view v-if="usedList.length" class="card">
      <view class="card-title" style="margin: 0 0 10rpx">已使用 / 已失效</view>
      <view v-for="c in usedList" :key="c.id" class="row muted" style="margin-top: 12rpx">
        <view style="flex: 1">{{ c.name }} · 立减 {{ money(c.amount) }}</view>
        <view>{{ c.used ? "已使用" : "—" }}</view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { request, isLogin, goLogin } from "../../../auth.js";

const mine = ref([]);
const publicList = ref([]);
const loading = ref(false);
const claiming = ref(0);

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const claimedIds = computed(() => mine.value.map((c) => Number(c.couponId)));
const usable = computed(() => mine.value.filter((c) => !c.used));
const usedList = computed(() => mine.value.filter((c) => c.used));
const usableCount = computed(() => usable.value.length);
const claimable = computed(() =>
  publicList.value.filter((c) => !claimedIds.value.includes(Number(c.id))),
);
const claimedText = (c) =>
  Number(c.total) > 0 ? "已领 " + Number(c.claimed) + " / " + Number(c.total) : "不限量";

async function load() {
  if (!isLogin()) return goLogin("/pages/parent/coupons/index");
  loading.value = true;
  try {
    const [my, pub] = await Promise.all([
      request("GET", "/parent/coupons").catch(() => ({ list: [] })),
      request("GET", "/public/coupons").catch(() => []),
    ]);
    mine.value = (my && my.list) || [];
    publicList.value = Array.isArray(pub) ? pub : [];
  } catch (e) {
    uni.showToast({ title: e.message || "加载失败", icon: "none" });
  } finally {
    loading.value = false;
  }
}

async function claim(c) {
  if (claimedIds.value.includes(Number(c.id))) return;
  claiming.value = c.id;
  try {
    await request("POST", "/parent/coupons/" + c.id + "/claim", {});
    uni.showToast({ title: "领取成功", icon: "success" });
    await load();
  } catch (e) {
    uni.showToast({ title: e.message || "领取失败", icon: "none" });
    await load();
  } finally {
    claiming.value = 0;
  }
}

onShow(load);
</script>

<style scoped>
.page {
  padding: 24rpx;
}
.card {
  background: #fff;
  border-radius: 20rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}
.card-title {
  font-size: 30rpx;
  font-weight: 700;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}
.muted {
  color: #6b7280;
  font-size: 24rpx;
  line-height: 1.6;
}
.tag {
  font-size: 24rpx;
  padding: 6rpx 16rpx;
  border-radius: 999rpx;
  background: #f3f4f6;
  color: #374151;
}
.btn {
  background: #1f6feb;
  color: #fff;
  border-radius: 999rpx;
  font-size: 26rpx;
  text-align: center;
}
.btn.ghost {
  background: #eef4ff;
  color: #1f6feb;
}
</style>
