<script setup>
import { reactive, ref } from "vue";

const form = reactive({
  stage: "初中",
  subject: "数学",
  address: "西湖区文三路 128 号 学军小区 3 幢 502",
  lat: 30.262,
  lng: 120.133,
  budget: 150,
  urgent: false,
  remark: "",
});
const submitting = ref(false);
const STAGES = ["小学", "初中", "高中"];
const SUBJECTS = ["数学", "语文", "英语", "物理", "化学"];

async function submit() {
  submitting.value = true;
  const body = {
    stage: form.stage,
    subject: form.subject,
    address: form.address,
    lat: Number(form.lat),
    lng: Number(form.lng),
    budget: Math.round(Number(form.budget) * 100),
    urgent: form.urgent,
    remark: form.remark,
  };
  uni.request({
    url: "/api/demands",
    method: "POST",
    data: body,
    header: { Authorization: "Bearer " + uni.getStorageSync("token"), "Content-Type": "application/json" },
    success: (res) => {
      submitting.value = false;
      if (res.data && res.data.code === 0) {
        uni.showToast({ title: "发布成功，等待教员报名", icon: "none" });
        setTimeout(() => uni.navigateBack(), 800);
      } else {
        uni.showToast({ title: (res.data && res.data.message) || "发布失败", icon: "none" });
      }
    },
    fail: () => {
      submitting.value = false;
      uni.showToast({ title: "网络异常", icon: "none" });
    },
  });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">发布家教需求</view>

      <view class="muted" style="margin-bottom: 10rpx">学段</view>
      <view class="row" style="flex-wrap: wrap; gap: 12rpx">
        <view
          v-for="s in STAGES"
          :key="s"
          class="tag"
          :style="{ background: form.stage === s ? '#1f6feb' : '#eef4ff', color: form.stage === s ? '#fff' : '#1f6feb' }"
          @click="form.stage = s"
        >{{ s }}</view>
      </view>

      <view class="muted" style="margin: 20rpx 0 10rpx">科目</view>
      <view class="row" style="flex-wrap: wrap; gap: 12rpx">
        <view
          v-for="s in SUBJECTS"
          :key="s"
          class="tag"
          :style="{ background: form.subject === s ? '#1f6feb' : '#eef4ff', color: form.subject === s ? '#fff' : '#1f6feb' }"
          @click="form.subject = s"
        >{{ s }}</view>
      </view>

      <view class="muted" style="margin: 20rpx 0 10rpx">上课地址</view>
      <input v-model="form.address" class="input" placeholder="详细地址" />

      <view class="muted" style="margin-bottom: 10rpx">课时预算（元）</view>
      <input v-model="form.budget" class="input" type="digit" placeholder="如 150" />

      <view class="row">
        <view>加急派单（+¥20，优先推送）</view>
        <switch :checked="form.urgent" @change="form.urgent = $event.detail.value" />
      </view>

      <view class="muted" style="margin: 20rpx 0 10rpx">备注</view>
      <input v-model="form.remark" class="input" placeholder="如：希望老师有耐心" />

      <view class="btn" @click="submit">{{ submitting ? "提交中…" : "发布需求" }}</view>
      <view class="muted" style="margin-top: 16rpx">发布后按「距离 × 等级权重 × 响应速度」推送给服务半径内的在线教员。</view>
    </view>
  </view>
</template>
