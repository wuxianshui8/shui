<template>
  <view class="page">
    <view class="card">
      <view class="card-title" style="margin: 0 0 8rpx">{{ doc.title || fallbackTitle }}</view>
      <view class="muted">最近更新：{{ doc.updatedAt || "—" }}</view>
    </view>

    <view v-if="loading" class="card muted">加载中…</view>
    <view v-else-if="err" class="card muted">{{ err }}</view>
    <view v-else class="card">
      <text class="content">{{ doc.content || "暂无内容" }}</text>
    </view>

    <view class="card">
      <view class="card-title" style="margin: 0 0 10rpx">其他协议</view>
      <view
        v-for="a in others"
        :key="a.key"
        class="row"
        style="margin-top: 12rpx"
        @click="openKey(a.key)"
      >
        <view style="flex: 1">{{ a.title }}</view>
        <view class="tag">查看 →</view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { request } from "../../auth.js";

const TITLES = { user: "用户服务协议", privacy: "隐私政策", refund: "退款规则" };

const key = ref("user");
const doc = ref({});
const all = ref([]);
const loading = ref(true);
const err = ref("");

const fallbackTitle = computed(() => TITLES[key.value] || "协议");
const others = computed(() => all.value.filter((a) => a.key !== key.value));

async function load() {
  loading.value = true;
  err.value = "";
  try {
    const [detail, list] = await Promise.all([
      request("GET", "/public/agreements/" + key.value),
      request("GET", "/public/agreements").catch(() => []),
    ]);
    doc.value = detail || {};
    all.value = Array.isArray(list) ? list : [];
  } catch (e) {
    err.value = e.message || "协议加载失败";
  } finally {
    loading.value = false;
  }
}

function openKey(next) {
  key.value = next;
  uni.setNavigationBarTitle({ title: TITLES[next] || "协议" });
  load();
}

onLoad((q) => {
  const k = String((q && q.key) || "user");
  key.value = TITLES[k] ? k : "user";
  uni.setNavigationBarTitle({ title: TITLES[key.value] || "协议" });
  load();
});
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
  background: #eef4ff;
  color: #1f6feb;
}
.content {
  font-size: 26rpx;
  line-height: 1.9;
  color: #111827;
  white-space: pre-wrap;
}
</style>
