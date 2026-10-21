<script setup>
import { computed, onMounted, ref } from "vue";

const data = ref(null);
const withdrawals = ref([]);
const amountYuan = ref("");
const account = ref("");
const channel = ref("wechat");
const submitting = ref(false);
const user = uni.getStorageSync("user") || {};

function req(path, method = "GET", body, header) {
  return new Promise((resolve) => {
    uni.request({
      url: "/api" + path,
      method,
      data: body,
      header: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + uni.getStorageSync("token"),
        ...(header || {}),
      },
      success: (res) => resolve(res.data || null),
      fail: () => resolve(null),
    });
  });
}

async function load() {
  const w = await req("/wallet");
  data.value = w && w.code === 0 ? w.data : null;
  const wd = await req("/withdrawals");
  withdrawals.value = wd && wd.code === 0 ? wd.data || [] : [];
}
onMounted(load);

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);
const rule = computed(() => (data.value && data.value.rule) || {});
const wallet = computed(() => (data.value && data.value.wallet) || {});
const txns = computed(() => (data.value && data.value.txns) || []);
const minYuan = computed(() => (Number(rule.value.min_withdraw ?? 10000) / 100).toFixed(2));
const feeCents = computed(() => {
  const cents = Math.round(Number(amountYuan.value || 0) * 100);
  return cents > 0 ? Math.round(cents * Number(rule.value.withdraw_fee_rate ?? 0)) : 0;
});
const actualCents = computed(() => Math.max(0, Math.round(Number(amountYuan.value || 0) * 100) - feeCents.value));
const STATUS = { pending: "待审核", paid: "已打款", rejected: "已驳回" };
const TXN = { income: "课时收入", settle: "结算入账", withdraw: "提现", adjust: "平台调整", reward: "奖励" };

async function submit() {
  if (submitting.value) return;
  const cents = Math.round(Number(amountYuan.value || 0) * 100);
  if (!(cents > 0)) {
    uni.showToast({ title: "请输入提现金额", icon: "none" });
    return;
  }
  if (!account.value.trim()) {
    uni.showToast({ title: "请填写收款账号", icon: "none" });
    return;
  }
  submitting.value = true;
  const r = await req(
    "/withdrawals",
    "POST",
    { amount: cents, account: account.value.trim(), channel: channel.value },
    { "X-Idem-Key": "m" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) },
  );
  submitting.value = false;
  if (r && r.code === 0) {
    uni.showToast({ title: "已提交，待平台审核", icon: "none" });
    amountYuan.value = "";
    load();
  } else {
    uni.showToast({ title: (r && r.message) || "提交失败", icon: "none" });
  }
}

function back() {
  uni.navigateBack({ delta: 1 });
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">我的钱包{{ user.nickname ? " · " + user.nickname : "" }}</view>
      <view class="muted">冻结金额在订单完成 T+{{ rule.freeze_days || 7 }} 天后自动结算入余额</view>
    </view>

    <view class="kpi">
      <view class="item"><view class="k">可用余额</view><view class="v">{{ money(wallet.balance) }}</view></view>
      <view class="item"><view class="k">冻结中</view><view class="v">{{ money(wallet.frozen) }}</view></view>
      <view class="item"><view class="k">累计收入</view><view class="v">{{ money(wallet.totalIncome) }}</view></view>
      <view class="item"><view class="k">累计提现</view><view class="v">{{ money(wallet.totalWithdraw) }}</view></view>
    </view>

    <view class="card">
      <view class="card-title">提现申请</view>
      <view class="row">
        <view>提现金额（元）</view>
        <input v-model="amountYuan" type="digit" placeholder="最低 {{ minYuan }}" style="text-align: right; width: 200rpx" />
      </view>
      <view class="row">
        <view>收款账号</view>
        <input v-model="account" placeholder="微信号 / 支付宝账号" style="text-align: right; width: 300rpx" />
      </view>
      <view class="row">
        <view>收款渠道</view>
        <view style="display: flex; gap: 12rpx">
          <view class="tag" :style="channel === 'wechat' ? 'background:#1f6feb;color:#fff' : ''" @tap="channel = 'wechat'">微信</view>
          <view class="tag" :style="channel === 'alipay' ? 'background:#1f6feb;color:#fff' : ''" @tap="channel = 'alipay'">支付宝</view>
        </view>
      </view>
      <view class="muted">手续费 {{ (Number(rule.withdraw_fee_rate || 0) * 100).toFixed(2) }}%（{{ money(feeCents) }}），预计到账 {{ money(actualCents) }}</view>
      <view class="row" @tap="submit">
        <view style="font-size: 28rpx">{{ submitting ? "提交中…" : "提交提现申请" }}</view>
        <view class="tag">最低 {{ minYuan }} 元</view>
      </view>
    </view>

    <view class="card">
      <view class="card-title">提现记录（{{ withdrawals.length }}）</view>
      <view v-for="w in withdrawals" :key="w.id" class="row">
        <view>
          <view style="font-size: 26rpx">申请 {{ money(w.amount) }} · 到账 {{ money(w.actual) }}</view>
          <view class="muted">{{ w.created_at }}</view>
        </view>
        <view class="tag">{{ STATUS[w.status] || w.status }}</view>
      </view>
      <view v-if="!withdrawals.length" class="muted">暂无提现记录</view>
    </view>

    <view class="card">
      <view class="card-title">钱包流水（最近 50 条）</view>
      <view v-for="t in txns" :key="t.id" class="row">
        <view>
          <view style="font-size: 26rpx">{{ TXN[t.type] || t.type }} · 订单 {{ t.order_no || "-" }}</view>
          <view class="muted">{{ t.remark || t.created_at }}</view>
        </view>
        <view class="tag">{{ money(t.amount) }}</view>
      </view>
      <view v-if="!txns.length" class="muted">暂无流水</view>
    </view>

    <view class="card">
      <view class="row" @tap="back"><view>返回教员首页</view><view class="tag">返回</view></view>
    </view>
  </view>
</template>
