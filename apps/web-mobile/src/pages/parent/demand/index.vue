<script setup>
// 需求详情（P68）：看报名教员 → 确认一位 → 生成订单去支付。
// 报名列表按「实时优先级」排序（后端按当前派单规则重算，不是报名时的快照）。
import { onLoad, onShow } from "@dcloudio/uni-app";
import { ref } from "vue";
import { request } from "../../../auth.js";

const id = ref(0);
const d = ref(null);
const loading = ref(true);
const busy = ref("");

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const fmt = (s) => {
  if (!s) return "-";
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return String(s);
  const p = (n) => String(n).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()) + " " + p(dt.getHours()) + ":" + p(dt.getMinutes());
};
const STATUS = { published: "接单中", paused: "已暂停", revoked: "已撤销", matched: "已成交", closed: "已关闭" };
const statusText = (s) => STATUS[s] || s;
const placeText = (m) => (m === "teacher_place" ? "我到教员处上课" : "教员上门授课");
const timeText = (t) => (t && t.date ? t.date + " " + (t.start || "") + "-" + (t.end || "") : "-");

async function load() {
  if (!id.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    d.value = await request("GET", "/demands/" + id.value).catch(() => null);
  } finally {
    loading.value = false;
  }
}

onLoad((options) => {
  id.value = Number((options && options.id) || 0);
});
// 抢单报名会随时发生，回到本页就重新拉一次
onShow(() => {
  void load();
});

/** 确认某位教员 → 后端生成订单（并发安全，只会成功一次），然后跳订单详情去支付 */
async function confirm(app) {
  busy.value = "confirm" + app.id;
  try {
    const order = await request("POST", "/demands/" + id.value + "/confirm", { applicationId: Number(app.id) });
    uni.showToast({ title: "已确认，去支付", icon: "none" });
    await load();
    setTimeout(() => {
      uni.navigateTo({ url: "/pages/parent/order/index?id=" + order.id });
    }, 600);
  } catch (e) {
    uni.showToast({ title: e.message || "确认失败", icon: "none" });
  } finally {
    busy.value = "";
  }
}

async function act(action, label) {
  busy.value = action;
  try {
    await request("POST", "/demands/" + id.value + "/action", { action });
    uni.showToast({ title: label + "成功", icon: "none" });
    await load();
  } catch (e) {
    uni.showToast({ title: e.message || label + "失败", icon: "none" });
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <view class="wrap">
    <view v-if="loading" class="card muted">加载中…</view>
    <view v-else-if="!d" class="card muted">需求不存在或无权查看</view>

    <template v-else>
      <view class="card">
        <view class="row">
          <view class="card-title" style="margin: 0">{{ d.subject }} · {{ d.stage }}</view>
          <view class="tag">{{ statusText(d.status) }}</view>
        </view>
        <view class="row"><text>上课形式</text><text>{{ placeText(d.mode) }}</text></view>
        <view class="row"><text>上课地址</text><text style="max-width: 60%; text-align: right">{{ d.address }}</text></view>
        <view class="row"><text>时间</text><text>{{ timeText((d.times || [])[0]) }}</text></view>
        <view class="row"><text>预算</text><text>{{ money(d.budget) }} / 课时</text></view>
        <view class="row" v-if="d.urgent"><text>加急费</text><text>{{ money(d.urgent_fee) }}</text></view>
        <view class="row" v-if="d.remark"><text>备注</text><text style="max-width: 60%; text-align: right">{{ d.remark }}</text></view>
        <view class="muted" style="margin-top: 10rpx">发布 {{ fmt(d.created_at) }} · 报名 {{ (d.applications || []).length }} 人</view>

        <view class="row" style="gap: 12rpx; margin-top: 16rpx; border-bottom: none; flex-wrap: wrap">
          <view v-if="d.status === 'published'" class="btn ghost" style="padding: 10rpx 22rpx" @click="act('pause', '暂停')">
            {{ busy === "pause" ? "处理中…" : "暂停接单" }}
          </view>
          <view v-if="d.status === 'paused'" class="btn ghost" style="padding: 10rpx 22rpx" @click="act('resume', '恢复')">
            {{ busy === "resume" ? "处理中…" : "恢复接单" }}
          </view>
          <view
            v-if="d.status === 'published' || d.status === 'paused'"
            class="btn ghost"
            style="padding: 10rpx 22rpx"
            @click="act('revoke', '撤销')"
          >{{ busy === "revoke" ? "处理中…" : "撤销需求" }}</view>
        </view>
      </view>

      <view class="card">
        <view class="card-title">报名教员（{{ (d.applications || []).length }}）</view>
        <view class="muted" style="margin-bottom: 12rpx">按当前派单规则实时排序（等级、响应速度、距离、加急费）</view>

        <view v-for="a in d.applications" :key="a.id" class="row" style="align-items: flex-start; border-bottom: 1px solid #eef4ff">
          <view style="flex: 1">
            <view style="font-size: 26rpx">{{ a.nickname || ("教员#" + a.teacher_id) }}</view>
            <view class="muted">
              距离 {{ a.distance_km != null ? Number(a.distance_km).toFixed(1) + " km" : "-" }}
              · 优先级 {{ a.priority != null ? Number(a.priority).toFixed(2) : "-" }}
              · {{ a.status === "confirmed" ? "已确认" : a.status === "rejected" ? "未选中" : "待确认" }}
            </view>
            <view class="muted" v-if="a.created_at">报名 {{ fmt(a.created_at) }}</view>
          </view>
          <view
            v-if="d.status === 'published' && a.status === 'pending'"
            class="btn"
            style="padding: 10rpx 20rpx"
            @click="confirm(a)"
          >{{ busy === "confirm" + a.id ? "确认中…" : "确认这位教员" }}</view>
          <view v-else-if="a.status === 'confirmed'" class="tag">已选</view>
        </view>

        <view v-if="!(d.applications || []).length" class="muted">还没有教员报名，可以先等一等或提高预算</view>
      </view>
    </template>
  </view>
</template>
