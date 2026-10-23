<script setup>
import { onShow } from "@dcloudio/uni-app";
import { ref } from "vue";
import { goLogin, isLogin, request } from "../../../auth.js";

/** 附近教员：游客可浏览（与首页一致的游客体验），点进详情；预约/收藏时才要求登录 */
const list = ref([]);
const total = ref(0);
const loading = ref(true);
const guest = ref(!isLogin());
const subject = ref("");
const sort = ref("priority");
const SUBJECTS = ["", "语文", "数学", "英语", "物理", "化学"];
const SORTS = [
  { v: "priority", t: "智能推荐" },
  { v: "distance", t: "距离最近" },
  { v: "price", t: "价格最低" },
  { v: "rating", t: "评分最高" },
];

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

async function load() {
  loading.value = true;
  guest.value = !isLogin();
  try {
    // 已登录走家长接口（带收藏状态）；游客走公开接口（收藏恒 false、手机号脱敏）
    const base = isLogin() ? "/parent/teachers" : "/public/teachers";
    const q = "?lat=30.262&lng=120.133&radiusKm=20&pageSize=20&sort=" + sort.value + (subject.value ? "&subject=" + encodeURIComponent(subject.value) : "");
    const r = await request("GET", base + q).catch(() => null);
    list.value = (r && r.list) || [];
    total.value = (r && r.total) || 0;
  } finally {
    loading.value = false;
  }
}
onShow(load);

function open(t) {
  uni.navigateTo({ url: "/pages/parent/teacher/index?id=" + t.id });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">附近教员（{{ total }}）</view>
      <view class="muted">按「距离 × 等级 × 评分」排序，常用片区半径 20 公里内。</view>

      <view class="muted" style="margin: 18rpx 0 10rpx">科目</view>
      <view class="row" style="flex-wrap: wrap; gap: 12rpx; border-bottom: none; justify-content: flex-start">
        <view
          v-for="s in SUBJECTS"
          :key="s || 'all'"
          class="tag"
          :style="{ background: subject === s ? '#1f6feb' : '#eef4ff', color: subject === s ? '#fff' : '#1f6feb' }"
          @click="subject = s; load()"
        >{{ s || "全部" }}</view>
      </view>

      <view class="muted" style="margin: 18rpx 0 10rpx">排序</view>
      <view class="row" style="flex-wrap: wrap; gap: 12rpx; border-bottom: none; justify-content: flex-start">
        <view
          v-for="s in SORTS"
          :key="s.v"
          class="tag"
          :style="{ background: sort === s.v ? '#1f6feb' : '#eef4ff', color: sort === s.v ? '#fff' : '#1f6feb' }"
          @click="sort = s.v; load()"
        >{{ s.t }}</view>
      </view>
    </view>

    <view v-if="loading" class="card muted">加载中…</view>
    <view v-else-if="!list.length" class="card muted">附近暂无符合条件的教员，换个科目或稍后再试。</view>

    <view v-for="t in list" :key="t.id" class="card" @tap="open(t)">
      <view class="row" style="border-bottom: none">
        <view style="flex: 1">
          <view class="row" style="border-bottom: none; padding: 0; gap: 10rpx; justify-content: flex-start">
            <text style="font-size: 30rpx; font-weight: 600">{{ t.nickname }}</text>
            <text class="tag">{{ t.levelName || t.level }}</text>
            <text v-if="t.online" class="tag" style="background: #e7f8ee; color: #15803d">在线</text>
          </view>
          <view class="muted" style="margin-top: 8rpx">
            距您 {{ t.distanceKm }} km · 评分 {{ Number(t.ratingAvg || 0).toFixed(1) }}（{{ t.ratingCount || 0 }}）· 已授 {{ t.completedLessons || 0 }} 课时
          </view>
          <view class="row" style="border-bottom: none; padding: 8rpx 0 0; gap: 10rpx; justify-content: flex-start; flex-wrap: wrap">
            <text v-for="s in (t.subjects || [])" :key="s" class="tag" style="background: #f4f6fa; color: #475569">{{ s }}</text>
          </view>
        </view>
        <view style="text-align: right">
          <view style="font-size: 30rpx; font-weight: 700; color: #1f6feb">{{ money(t.hourlyPrice) }}</view>
          <view class="muted">元/课时</view>
          <view class="btn" style="margin-top: 12rpx; padding: 10rpx 24rpx">查看</view>
        </view>
      </view>
    </view>

    <view v-if="guest" class="card muted">登录后可「立即预约」下单，当前为游客浏览。</view>
  </view>
</template>
