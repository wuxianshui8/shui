<script setup>
import { computed, onMounted, ref } from "vue";

const list = ref([]);
const loading = ref(false);
const user = uni.getStorageSync("user") || {};

function req(path, method = "GET", body) {
  return new Promise((resolve) => {
    uni.request({
      url: "/api" + path,
      method,
      data: body,
      header: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + uni.getStorageSync("token"),
      },
      success: (res) => resolve(res.data || null),
      fail: () => resolve(null),
    });
  });
}

async function load() {
  loading.value = true;
  const r = await req("/agent/complaints");
  list.value = (r && r.data && r.data.list) || [];
  loading.value = false;
}
onMounted(load);

const STATUS = {
  open: "待处理",
  agent_handled: "片区已处理",
  escalated: "已上报平台",
  closed: "已关闭",
};
const open = computed(() => list.value.filter((c) => c.status === "open" || c.status === "escalated").length);

async function handle(c, action) {
  const r = await req("/agent/complaints/" + c.id + "/handle", "POST", {
    action,
    note: action === "escalate" ? "片区无法协调，上报平台仲裁" : "片区已协调处理",
  });
  if (r && r.code === 0) {
    uni.showToast({ title: "已" + STATUS[r.data.status], icon: "none" });
    load();
  } else {
    uni.showToast({ title: (r && r.message) || "操作失败", icon: "none" });
  }
}

function back() {
  uni.navigateBack({ delta: 1 });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">片区客诉工单{{ user.nickname ? " · " + user.nickname : "" }}</view>
      <view class="muted">仅显示本片区工单，跨片区不可见、不可处理</view>
    </view>

    <view class="kpi">
      <view class="item"><view class="k">工单总数</view><view class="v">{{ list.length }}</view></view>
      <view class="item"><view class="k">待处理/已上报</view><view class="v">{{ open }}</view></view>
    </view>

    <view class="card">
      <view class="card-title">工单列表</view>
      <view v-for="c in list" :key="c.id" style="padding: 12rpx 0; border-bottom: 1rpx solid #eef1f6">
        <view class="row">
          <view style="font-size: 26rpx">#{{ c.id }} {{ c.title }}</view>
          <view class="tag">{{ STATUS[c.status] || c.status }}</view>
        </view>
        <view class="muted">{{ c.fromName || "用户" }} · 订单 {{ c.order_no || "-" }} · {{ c.created_at }}</view>
        <view class="row" v-if="c.status === 'open' || c.status === 'escalated'">
          <view class="tag" @tap="handle(c, 'handled')">标记已处理</view>
          <view class="tag" @tap="handle(c, 'escalate')">上报平台</view>
          <view class="tag" @tap="handle(c, 'close')">关闭工单</view>
        </view>
        <view class="muted" v-else-if="c.handle_note">处理说明：{{ c.handle_note }}</view>
      </view>
      <view v-if="!list.length && !loading" class="muted">本片区暂无客诉工单</view>
    </view>

    <view class="card">
      <view class="row" @tap="back"><view>返回代理首页</view><view class="tag">返回</view></view>
    </view>
  </view>
</template>
