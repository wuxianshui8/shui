<script setup>
import { onLoad } from "@dcloudio/uni-app";
import { computed, reactive, ref } from "vue";
import { isLogin, request } from "../../../auth.js";

/** 家长订单详情：状态、教员、上课信息、金额；按状态给「支付 / 申请取消 / 确认完成 / 评价」 */
const o = ref(null);
const loading = ref(true);
const busy = ref("");
const cancelDraft = reactive({ open: false, reason: "" });
const review = reactive({ open: false, score: 5, content: "" });
const POSITIVE = ["准时", "耐心", "专业", "讲解清晰"];

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const fmt = (s) => {
  if (!s) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
};

async function load() {
  loading.value = true;
  try {
    const r = await request("GET", "/orders/" + o.value?.id).catch(() => null);
    if (r) o.value = r;
  } finally {
    loading.value = false;
  }
}

onLoad(async (options) => {
  const id = Number((options && options.id) || 0);
  loading.value = true;
  try {
    o.value = await request("GET", "/orders/" + id).catch(() => null);
  } finally {
    loading.value = false;
  }
});

const canPay = computed(() => o.value && o.value.status === "awaiting_payment");
const canCancel = computed(() => o.value && ["pending_class", "awaiting_parent_confirm"].includes(o.value.status) && !o.value.cancelRequested);
const canConfirm = computed(() => o.value && o.value.status === "awaiting_parent_confirm");
const canReview = computed(() => o.value && o.value.status === "completed" && !o.value.hasReview);

async function pay() {
  busy.value = "pay";
  const r = await new Promise((resolve) => {
    uni.request({
      url: "/api/orders/" + o.value.id + "/pay",
      method: "POST",
      data: {},
      header: {
        Authorization: "Bearer " + uni.getStorageSync("token"),
        "Content-Type": "application/json",
        "X-Idem-Key": "m-order-pay-" + o.value.id + "-" + Date.now(),
      },
      success: (res) => resolve(res.data && res.data.code === 0 ? res.data.data : null),
      fail: () => resolve(null),
    });
  });
  busy.value = "";
  uni.showToast({ title: r ? "担保支付成功" : "支付失败", icon: "none" });
  if (r) await load();
}

async function submitCancel() {
  const reason = String(cancelDraft.reason || "").trim();
  if (!reason) return uni.showToast({ title: "请填写取消原因", icon: "none" });
  busy.value = "cancel";
  try {
    await request("POST", "/orders/" + o.value.id + "/cancel", { reason });
    cancelDraft.open = false;
    cancelDraft.reason = "";
    uni.showToast({ title: "已提交取消申请，等教员确认", icon: "none" });
    await load();
  } catch (e) {
    uni.showToast({ title: e.message || "提交失败", icon: "none" });
  } finally {
    busy.value = "";
  }
}

async function confirmDone() {
  busy.value = "confirm";
  const r = await request("POST", "/orders/" + o.value.id + "/confirm", {}).catch(() => null);
  busy.value = "";
  uni.showToast({ title: r ? "已确认完成，课时费进入冻结期" : "操作失败", icon: "none" });
  if (r) await load();
}

async function submitReview() {
  busy.value = "review";
  const r = await request("POST", "/orders/" + o.value.id + "/review", {
    score: Number(review.score),
    content: String(review.content || "").trim() || "课程体验良好",
    tags: review.score >= 4 ? ["准时", "耐心"] : [],
  }).catch(() => null);
  busy.value = "";
  uni.showToast({ title: r ? "评价成功" : "评价失败", icon: "none" });
  if (r) {
    review.open = false;
    await load();
  }
}
</script>

<template>
  <view class="wrap">
    <view v-if="loading" class="card muted">加载中…</view>
    <view v-else-if="!o" class="card muted">订单不存在或无权查看。</view>

    <template v-else>
      <view class="card">
        <view class="row" style="border-bottom: none">
          <view>
            <view style="font-size: 32rpx; font-weight: 700">{{ o.statusText }}</view>
            <view class="muted" style="margin-top: 8rpx">{{ o.orderNo }}</view>
          </view>
          <view class="tag">{{ money(o.amount + (o.urgentFee || 0)) }}</view>
        </view>
        <view v-if="o.cancelRequested" class="muted" style="margin-top: 14rpx; color: #8a5a00">
          已提交取消申请（{{ fmt(o.cancelRequestedAt) }}），等待教员确认：同意即按规则退款，驳回则订单继续；超时平台自动退款。
        </view>
        <view v-else-if="o.cancelRejectedAt" class="muted" style="margin-top: 14rpx; color: #c02a2a">
          教员已于 {{ fmt(o.cancelRejectedAt) }} 驳回取消申请，理由：{{ o.cancelRejectReason || "未填写" }}。如仍有异议可联系客服仲裁。
        </view>
      </view>

      <view class="card">
        <view class="card-title">教员信息</view>
        <view class="row" style="border-bottom: none">
          <view style="flex: 1">
            <view style="font-size: 28rpx; font-weight: 600">{{ (o.teacher && o.teacher.nickname) || "-" }}</view>
            <view class="muted">{{ (o.teacher && o.teacher.levelName) || "" }} {{ (o.teacher && o.teacher.phone) || "" }}</view>
          </view>
          <view v-if="o.teacher && o.teacher.id" class="btn ghost" style="padding: 10rpx 24rpx"
            @click="uni.navigateTo({ url: '/pages/parent/teacher/index?id=' + o.teacher.id })">教员主页</view>
        </view>
      </view>

      <view class="card">
        <view class="card-title">上课信息</view>
        <view class="row"><text>科目 / 学段</text><text>{{ o.subject }} · {{ o.stage }}</text></view>
        <view class="row"><text>上课时间</text><text>{{ fmt(o.lessonTime) }}</text></view>
        <view class="row"><text>上课地址</text><text style="max-width: 60%; text-align: right">{{ o.address }}</text></view>
        <view class="row" v-if="o.remark"><text>备注</text><text style="max-width: 60%; text-align: right">{{ o.remark }}</text></view>
        <view class="row"><text>课时费</text><text>{{ money(o.amount) }}</text></view>
        <view class="row" v-if="o.urgentFee"><text>加急费</text><text>{{ money(o.urgentFee) }}</text></view>
        <view class="row" v-if="o.serviceFee != null"><text>平台服务费</text><text>{{ money(o.serviceFee) }}</text></view>
        <view class="row" v-if="o.refundAmount"><text>已退款</text><text>{{ money(o.refundAmount) }}</text></view>
      </view>

      <view class="card">
        <view v-if="canPay" class="btn" @click="pay">{{ busy === "pay" ? "支付中…" : "去支付（担保交易）" }}</view>

        <view v-else-if="canConfirm">
          <view class="btn" @click="confirmDone">{{ busy === "confirm" ? "处理中…" : "确认完成上课" }}</view>
          <view class="muted" style="margin-top: 12rpx">确认后课时费进入 7 天冻结期，冻结期满自动结算给教员。</view>
        </view>

        <view v-else-if="canReview">
          <view v-if="!review.open" class="btn" @click="review.open = true">去评价</view>
          <view v-else>
            <view class="muted" style="margin-bottom: 10rpx">课程满意度</view>
            <view class="row" style="gap: 12rpx; justify-content: flex-start; border-bottom: none">
              <text v-for="n in 5" :key="n" style="font-size: 40rpx; color: n <= review.score ? '#f59e0b' : '#d1d5db'" @click="review.score = n">★</text>
            </view>
            <view class="muted" style="margin: 12rpx 0 10rpx">好评标签</view>
            <view class="row" style="flex-wrap: wrap; gap: 12rpx; justify-content: flex-start; border-bottom: none">
              <text v-for="t in POSITIVE" :key="t" class="tag">{{ t }}</text>
            </view>
            <input v-model="review.content" class="input" style="margin-top: 16rpx" placeholder="说说这次课的感受（可选）" />
            <view class="btn" @click="submitReview">{{ busy === "review" ? "提交中…" : "提交评价" }}</view>
          </view>
        </view>

        <view v-if="canCancel">
          <view v-if="!cancelDraft.open" class="btn ghost" style="margin-top: 14rpx" @click="cancelDraft.open = true">申请取消订单</view>
          <view v-else>
            <view class="muted" style="margin: 12rpx 0 10rpx">取消原因（会同步给教员）</view>
            <input v-model="cancelDraft.reason" class="input" placeholder="如：孩子临时有事" />
            <view class="btn" @click="submitCancel">{{ busy === "cancel" ? "提交中…" : "提交取消申请" }}</view>
            <view class="muted" style="margin-top: 12rpx" @click="cancelDraft.open = false">先不取消</view>
          </view>
        </view>

        <view v-if="!canPay && !canConfirm && !canReview && !canCancel" class="muted">
          当前状态无需操作{{ o.status === "refunded" ? "，退款已按规则处理" : "" }}。
        </view>
      </view>

      <view v-if="!isLogin()" class="card muted">登录后可查看并操作订单。</view>
    </template>
  </view>
</template>
