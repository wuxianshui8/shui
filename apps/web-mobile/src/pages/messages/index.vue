<script setup>
import { onMounted, ref } from "vue";

const list = ref([]);
const unread = ref(0);
const loading = ref(false);
const user = uni.getStorageSync("user") || {};

function req(path, method = "GET") {
  return new Promise((resolve) => {
    uni.request({
      url: "/api" + path,
      method,
      header: { "Content-Type": "application/json", Authorization: "Bearer " + uni.getStorageSync("token") },
      success: (res) => resolve(res.data && res.data.code === 0 ? res.data.data : null),
      fail: () => resolve(null),
    });
  });
}

async function load() {
  loading.value = true;
  const data = await req("/messages");
  list.value = (data && data.list) || [];
  unread.value = (data && data.unread) || 0;
  loading.value = false;
}
onMounted(load);

const TYPE = { order: "订单", payment: "资金", risk: "风控", system: "系统" };

async function readOne(m) {
  if (m.read) return;
  await req("/messages/" + m.id + "/read", "POST");
  load();
}

async function readAll() {
  if (!unread.value) return;
  await req("/messages/read-all", "POST");
  uni.showToast({ title: "已全部标记已读", icon: "none" });
  load();
}

function back() {
  uni.navigateBack({ delta: 1 });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">消息中心{{ user.nickname ? " · " + user.nickname : "" }}</view>
      <view class="muted">订单、支付、风控与平台公告通知；仅显示本人消息</view>
    </view>

    <view class="kpi">
      <view class="item"><view class="k">未读</view><view class="v">{{ unread }}</view></view>
      <view class="item"><view class="k">全部消息</view><view class="v">{{ list.length }}</view></view>
    </view>

    <view class="card">
      <view class="row" @tap="readAll">
        <view>全部标为已读</view>
        <view class="tag">{{ unread ? unread + " 条未读" : "已读完" }}</view>
      </view>
    </view>

    <view class="card">
      <view class="card-title">消息列表</view>
      <view
        v-for="m in list"
        :key="m.id"
        style="padding: 14rpx 0; border-bottom: 1rpx solid #eef1f6"
        @tap="readOne(m)"
      >
        <view class="row">
          <view style="font-size: 26rpx">
            <text v-if="!m.read" style="color: #1f6feb">● </text>{{ m.title }}
          </view>
          <view class="tag">{{ TYPE[m.type] || m.type }}</view>
        </view>
        <view class="muted">{{ m.content }}</view>
        <view class="muted">{{ m.created_at }}</view>
      </view>
      <view v-if="!list.length && !loading" class="muted">暂无消息</view>
    </view>

    <view class="card" @tap="back">
      <view class="row"><view>返回</view><view class="tag">返回</view></view>
    </view>
  </view>
</template>
