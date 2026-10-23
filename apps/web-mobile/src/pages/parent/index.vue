<script setup>
import { onShow } from "@dcloudio/uni-app";
import { ref } from "vue";
import { currentUser, goLogin, isLogin, request } from "../../auth.js";

const home = ref(null);
const orders = ref([]);
const user = ref(currentUser());
const busy = ref("");
const unread = ref(0);
/** 游客态：没登录也能看首页与「发布家教需求」；订单/消息才要求登录 */
const guest = ref(!isLogin());
/** 家长头像：有就用图片，没有就用昵称首字 */
const avatar = ref(currentUser().avatar || "");
const avatarBusy = ref(false);

/** 选图（压缩优先；超过 2MB 直接拦，与后端上限一致） */
function chooseImage() {
  return new Promise((resolve) => {
    uni.chooseImage({
      count: 1,
      sizeType: ["compressed"],
      success: (r) => resolve({ file: (r.tempFiles && r.tempFiles[0]) || null, path: (r.tempFilePaths && r.tempFilePaths[0]) || "" }),
      fail: () => resolve(null),
    });
  });
}

/** 图片 → dataURL：H5 用 FileReader，小程序读文件系统再补 MIME 头 */
function toDataUrl(file, path) {
  return new Promise((resolve, reject) => {
    // #ifdef H5
    const f = file && file.raw ? file.raw : file;
    if (f && typeof FileReader !== "undefined" && f instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(f);
      return;
    }
    // #endif
    try {
      const fs = uni.getFileSystemManager();
      const base64 = fs.readFileSync(path, "base64");
      const ext = String(path).split(".").pop().toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      resolve("data:" + mime + ";base64," + base64);
    } catch (e) {
      reject(new Error("图片读取失败，请重新选择"));
    }
  });
}

/** 换头像：上传 → 落库 → 同步本地登录用户（刷新后仍然生效） */
async function changeAvatar() {
  if (guest.value) {
    goLogin("");
    return;
  }
  if (avatarBusy.value) return;
  const picked = await chooseImage();
  if (!picked) return;
  if (picked.file && picked.file.size && picked.file.size > 2 * 1024 * 1024) {
    return toast("图片不能超过 2MB，请压缩后重试");
  }
  avatarBusy.value = true;
  try {
    const dataUrl = await toDataUrl(picked.file, picked.path);
    const original = (picked.file && picked.file.name) || (picked.path ? String(picked.path).split("/").pop() : "avatar.jpg");
    const saved = await request("POST", "/upload", { filename: original, dataUrl });
    const r = await request("PUT", "/parent/avatar", { avatar: saved.url });
    avatar.value = (r.user && r.user.avatar) || saved.url;
    const u = currentUser();
    u.avatar = avatar.value;
    uni.setStorageSync("user", u);
    user.value = u;
    toast("头像已更新");
  } catch (e) {
    toast(e.message || "头像上传失败");
  } finally {
    avatarBusy.value = false;
  }
}

function toast(title) {
  uni.showToast({ title, icon: "none" });
}

async function load() {
  guest.value = !isLogin();
  user.value = currentUser();
  // 游客走公开接口拿片区 / 附近在线教员 / 加急费；登录后同一份页面换成个人首页
  home.value = await request("GET", "/public/home?lat=30.262&lng=120.133").catch(() => null);
  if (isLogin()) {
    home.value = await request("GET", "/parent/home?lat=30.262&lng=120.133").catch(() => home.value);
    const msgs = await request("GET", "/messages").catch(() => null);
    unread.value = (msgs && msgs.unread) || 0;
    const list = await request("GET", "/parent/orders").catch(() => null);
    orders.value = (list && list.list) || [];
  } else {
    unread.value = 0;
    orders.value = [];
  }
}
onShow(load);

async function pay(o) {
  busy.value = "pay" + o.id;
  const r = await new Promise((resolve) => {
    uni.request({
      url: "/api/orders/" + o.id + "/pay",
      method: "POST",
      data: {},
      header: { Authorization: "Bearer " + uni.getStorageSync("token"), "Content-Type": "application/json", "X-Idem-Key": "m-pay-" + o.id + "-" + Date.now() },
      success: (res) => resolve(res.data && res.data.code === 0 ? res.data.data : null),
      fail: () => resolve(null),
    });
  });
  busy.value = "";
  toast(r ? "担保支付成功" : "支付失败");
  load();
}

async function confirmDone(o) {
  busy.value = "confirm" + o.id;
  const r = await request("POST", "/orders/" + o.id + "/confirm", {}).catch(() => null);
  busy.value = "";
  toast(r ? "已确认完成，课时费进入冻结期" : "操作失败");
  load();
}

async function review(o) {
  busy.value = "review" + o.id;
  const r = await request("POST", "/orders/" + o.id + "/review", { score: 5, content: "移动端评价：讲解清晰", tags: ["准时"] }).catch(() => null);
  busy.value = "";
  toast(r ? "评价成功（权重 " + r.weight + "）" : "评价失败");
  load();
}

const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

/** 发布需求对游客开放：直接进表单页，提交时才要求登录 */
function goPublish() {
  uni.navigateTo({ url: "/pages/parent/publish/index" });
}

/** 消息 / 订单是「我的」数据：游客先登录，登录后回到该页 */
function goMessages() {
  if (guest.value) {
    goLogin("/pages/messages/index");
    return;
  }
  uni.navigateTo({ url: "/pages/messages/index" });
}

function goLoginNow() {
  goLogin("");
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="row" style="gap: 20rpx; align-items: center">
        <!-- 头像：有图就铺满头像框（background-size: cover 等比裁切，不变形），没图显示昵称首字 -->
        <view class="my-avatar" @tap="changeAvatar">
          <view v-if="avatar" class="my-avatar-img" :style="{ backgroundImage: 'url(' + avatar + ')' }"></view>
          <text v-else class="my-avatar-text">{{ (user.nickname || "家长").slice(0, 1) }}</text>
          <text class="my-avatar-badge">{{ avatarBusy ? "…" : "📷" }}</text>
        </view>
        <view style="flex: 1">
          <view class="card-title" style="margin: 0">{{ guest ? "你好，先看看家教需求页吧" : "您好，" + (user.nickname || "家长") }}</view>
          <view class="muted" style="margin-top: 8rpx">{{ guest ? "登录后可上传头像" : "点击头像可更换图片" }}</view>
        </view>
      </view>
      <view class="muted" v-if="home" style="margin-top: 16rpx">当前片区：{{ home.region ? home.region.name : "未定位" }}（未登录也能看到，登录后按您的地址推荐）</view>
      <view class="btn" style="margin-top: 20rpx" @click="goPublish">发布家教需求</view>
      <view class="muted" v-if="guest" style="margin-top: 16rpx">
        不用登录就能填表；点「发布需求」时再登录，登录后自动发布。
      </view>
    </view>

    <view class="card" v-if="guest">
      <view class="row">
        <view style="flex: 1">
          <view class="bold">登录后可查看订单与消息</view>
          <view class="muted">担保支付、上课打卡、售后客服都在登录后可用</view>
        </view>
        <view class="btn ghost" style="padding: 10rpx 24rpx" @click="goLoginNow">登录</view>
      </view>
    </view>

    <view class="card" @tap="goMessages">
      <view class="row"><view>消息中心</view><view class="tag">{{ guest ? "登录后查看" : unread ? unread + " 条未读" : "查看" }}</view></view>
    </view>

    <view class="kpi" v-if="home">
      <view class="item"><view class="k">附近在线教员</view><view class="v">{{ (home.teachers || []).length }}</view></view>
      <view class="item"><view class="k">{{ guest ? "加急费起" : "可领优惠券" }}</view><view class="v">{{ guest ? money(home.urgentFee) : (home.couponCount || 0) + " 张" }}</view></view>
    </view>

    <view class="card" v-if="!guest">
      <view class="card-title">我的订单（{{ orders.length }}）</view>
      <view v-for="o in orders" :key="o.id" class="row">
        <view style="flex: 1">
          <view style="font-size: 26rpx">{{ o.subject }} · {{ o.stage }}</view>
          <view class="muted">{{ o.orderNo }}</view>
          <view class="muted">{{ money(o.amount) }} · {{ o.statusText }}</view>
        </view>
        <view>
          <view v-if="o.status === 'awaiting_payment'" class="btn" style="padding: 10rpx 20rpx" @click="pay(o)">
            {{ busy === "pay" + o.id ? "支付中…" : "支付" }}
          </view>
          <view v-else-if="o.status === 'awaiting_parent_confirm'" class="btn" style="padding: 10rpx 20rpx" @click="confirmDone(o)">
            {{ busy === "confirm" + o.id ? "处理中…" : "确认完成" }}
          </view>
          <view v-else-if="o.status === 'completed' && !o.hasReview" class="btn ghost" style="padding: 10rpx 20rpx" @click="review(o)">
            {{ busy === "review" + o.id ? "提交中…" : "去评价" }}
          </view>
        </view>
      </view>
      <view v-if="!orders.length" class="muted">暂无订单，先发布需求吧</view>
    </view>
  </view>
</template>

<style>
/* 家长头像框：固定方形圆角，图片 aspectFill 等比铺满（不变形、不留白边） */
.my-avatar {
  position: relative;
  width: 112rpx;
  height: 112rpx;
  border-radius: 32rpx;
  background: linear-gradient(135deg, #1f6feb, #1657c8);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
}
.my-avatar-img {
  width: 112rpx;
  height: 112rpx;
  border-radius: 32rpx;
  display: block;
  /* 图片在头像框内自适应：等比铺满、居中裁切，任意长宽比都不拉伸、不留白边 */
  background-size: cover;
  background-position: center center;
  background-repeat: no-repeat;
  overflow: hidden;
}
.my-avatar-text {
  color: #fff;
  font-size: 44rpx;
  font-weight: 700;
}
.my-avatar-badge {
  position: absolute;
  right: -8rpx;
  bottom: -8rpx;
  width: 40rpx;
  height: 40rpx;
  border-radius: 50%;
  background: #fff;
  border: 2rpx solid #e6eaf2;
  font-size: 20rpx;
  line-height: 40rpx;
  text-align: center;
  box-shadow: 0 4rpx 10rpx rgba(0, 0, 0, 0.12);
}
</style>
