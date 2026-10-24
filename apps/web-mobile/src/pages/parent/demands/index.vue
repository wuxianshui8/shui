<script setup>
// 我的需求（P68）：家长发布后的闭环——看谁报名、暂停/恢复/撤销、确认教员成单。
// 此前家长端只能「发布需求」，发完就再也看不到报名情况（后端接口一直有）。
import { onShow } from "@dcloudio/uni-app";
import { ref } from "vue";
import { goLogin, isLogin, request } from "../../../auth.js";

const list = ref([]);
const loading = ref(true);
const busy = ref("");
const guest = ref(!isLogin());

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const fmt = (s) => {
  if (!s) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
};
const STATUS = { published: "接单中", paused: "已暂停", revoked: "已撤销", matched: "已成交", closed: "已关闭" };
const statusText = (s) => STATUS[s] || s;
/** 授课形式（P65 起需求就有 mode，这里第一次在家长侧展示出来） */
const placeText = (m) => (m === "teacher_place" ? "我到教员处" : "教员上门");

async function load() {
  guest.value = !isLogin();
  if (guest.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    list.value = (await request("GET", "/demands/mine").catch(() => [])) || [];
  } finally {
    loading.value = false;
  }
}

onShow(() => {
  void load();
});

async function act(d, action, label) {
  busy.value = action + d.id;
  try {
    await request("POST", "/demands/" + d.id + "/action", { action });
    uni.showToast({ title: label + "成功", icon: "none" });
    await load();
  } catch (e) {
    uni.showToast({ title: e.message || label + "失败", icon: "none" });
  } finally {
    busy.value = "";
  }
}

function goDetail(d) {
  uni.navigateTo({ url: "/pages/parent/demand/index?id=" + d.id });
}

function goPublish() {
  uni.navigateTo({ url: "/pages/parent/publish/index" });
}

function goLoginNow() {
  goLogin("/pages/parent/demands/index");
}
</script>

<template>
  <view class="wrap">
    <view v-if="guest" class="card">
      <view class="card-title">我的需求</view>
      <view class="muted">登录后可查看自己发布的家教需求、教员报名情况并确认成单。</view>
      <view class="btn" style="margin-top: 20rpx" @click="goLoginNow">去登录</view>
    </view>

    <template v-else>
      <view v-if="loading" class="card muted">加载中…</view>

      <template v-else>
        <view v-for="d in list" :key="d.id" class="card">
          <view class="row">
            <view style="flex: 1">
              <view style="font-size: 28rpx; font-weight: 600">{{ d.subject }} · {{ d.stage }}</view>
              <view class="muted">{{ d.address }}</view>
              <view class="muted">
                预算 {{ money(d.budget) }} / 课时 · {{ placeText(d.mode) }}
                <text v-if="d.urgent"> · 加急 {{ money(d.urgent_fee) }}</text>
              </view>
              <view class="muted">报名 {{ d.applyCount || 0 }} 人 · {{ fmt(d.created_at) }}</view>
            </view>
            <view class="tag">{{ statusText(d.status) }}</view>
          </view>

          <view class="row" style="flex-wrap: wrap; gap: 12rpx; margin-top: 16rpx; border-bottom: none">
            <view class="btn" style="padding: 10rpx 22rpx" @click="goDetail(d)">
              {{ d.applyCount ? "看报名 / 确认教员" : "查看详情" }}
            </view>
            <view
              v-if="d.status === 'published'"
              class="btn ghost"
              style="padding: 10rpx 22rpx"
              @click="act(d, 'pause', '暂停')"
            >{{ busy === "pause" + d.id ? "处理中…" : "暂停接单" }}</view>
            <view
              v-if="d.status === 'paused'"
              class="btn ghost"
              style="padding: 10rpx 22rpx"
              @click="act(d, 'resume', '恢复')"
            >{{ busy === "resume" + d.id ? "处理中…" : "恢复接单" }}</view>
            <view
              v-if="d.status === 'published' || d.status === 'paused'"
              class="btn ghost"
              style="padding: 10rpx 22rpx"
              @click="act(d, 'revoke', '撤销')"
            >{{ busy === "revoke" + d.id ? "处理中…" : "撤销需求" }}</view>
          </view>
        </view>

        <view v-if="!list.length" class="card">
          <view class="muted">还没有发布过家教需求</view>
          <view class="btn" style="margin-top: 20rpx" @click="goPublish">发布家教需求</view>
        </view>
      </template>
    </template>
  </view>
</template>
