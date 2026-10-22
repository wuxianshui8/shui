<script setup>
import { onMounted, reactive, ref } from "vue";

const form = reactive({
  stage: "初中",
  subject: "数学",
  address: "西湖区文三路 128 号 学军小区 3 幢 502",
  lat: 30.262,
  lng: 120.133,
  budget: 150,
  urgent: false,
  urgentFeeYuan: "20",
  remark: "",
});
const submitting = ref(false);
const STAGES = ["小学", "初中", "高中"];
const SUBJECTS = ["数学", "语文", "英语", "物理", "化学"];

/** 平台配置的加急费边界（元）：最低 = 标准价，最高 = 规则上限 */
const urgentMinYuan = ref(20);
const urgentMaxYuan = ref(200);

function req(method, path, body) {
  return new Promise((resolve) => {
    uni.request({
      url: "/api" + path,
      method,
      data: body || {},
      header: { Authorization: "Bearer " + uni.getStorageSync("token"), "Content-Type": "application/json" },
      success: (res) => resolve(res.data && res.data.code === 0 ? res.data.data : null),
      fail: () => resolve(null),
    });
  });
}

onMounted(async () => {
  const home = await req("GET", `/parent/home?lat=${form.lat}&lng=${form.lng}`);
  if (home && home.urgentFee != null) {
    urgentMinYuan.value = Number(home.urgentFee) / 100;
    urgentMaxYuan.value = Number(home.urgentMaxFee || home.urgentFee * 10) / 100;
    form.urgentFeeYuan = urgentMinYuan.value.toFixed(2);
  }
});

function toggleUrgent(e) {
  form.urgent = e.detail.value;
  // 打开加急时把金额重置为平台标准价，避免上次清空后带着空值提交
  if (form.urgent && !(Number(form.urgentFeeYuan) > 0)) form.urgentFeeYuan = urgentMinYuan.value.toFixed(2);
}

async function submit() {
  let urgentFee = 0;
  if (form.urgent) {
    const yuan = Number(form.urgentFeeYuan);
    if (!(yuan > 0)) return uni.showToast({ title: "请填写加急费（元）", icon: "none" });
    if (yuan < urgentMinYuan.value) {
      return uni.showToast({ title: `加急费不能低于 ¥${urgentMinYuan.value.toFixed(2)}`, icon: "none" });
    }
    if (yuan > urgentMaxYuan.value) {
      return uni.showToast({ title: `加急费最高 ¥${urgentMaxYuan.value.toFixed(2)}`, icon: "none" });
    }
    urgentFee = Math.round(yuan * 100);
  }
  submitting.value = true;
  const body = {
    stage: form.stage,
    subject: form.subject,
    address: form.address,
    lat: Number(form.lat),
    lng: Number(form.lng),
    budget: Math.round(Number(form.budget) * 100),
    urgent: form.urgent,
    urgentFee,
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

      <view class="row" style="margin: 20rpx 0 0">
        <view>加急派单（优先推送附近教员）</view>
        <switch :checked="form.urgent" @change="toggleUrgent" />
      </view>
      <view v-if="form.urgent" style="margin-top: 16rpx">
        <view class="muted" style="margin-bottom: 10rpx">
          加急费（元）· 最低 ¥{{ urgentMinYuan.toFixed(2) }}，最高 ¥{{ urgentMaxYuan.toFixed(2) }}
        </view>
        <input v-model="form.urgentFeeYuan" class="input" type="digit" placeholder="如 20" />
        <view class="muted" style="margin-top: 8rpx">加急费会连同课时费一起计入订单实付金额。</view>
      </view>

      <view class="muted" style="margin: 20rpx 0 10rpx">备注</view>
      <input v-model="form.remark" class="input" placeholder="如：希望老师有耐心" />

      <view class="btn" @click="submit">{{ submitting ? "提交中…" : "发布需求" }}</view>
      <view class="muted" style="margin-top: 16rpx">发布后按「距离 × 等级权重 × 响应速度」推送给服务半径内的在线教员。</view>
    </view>
  </view>
</template>
