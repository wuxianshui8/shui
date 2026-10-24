<script setup>
import { onLoad } from "@dcloudio/uni-app";
import { ref } from "vue";
import { HOME, saveSession } from "../../auth.js";

const phone = ref("13900000301");
const password = ref("a123456");
const loading = ref(false);
/** 登录成功后的回跳地址（游客点「发布需求 / 立即预约」被带过来的页面） */
const next = ref("");

/** 首登改密（后台开通的账号 mustChangePassword=true 时进入此流程） */
const needChange = ref(false);
const newPassword = ref("");
const confirmPassword = ref("");
const pendingUser = ref(null);

onLoad((options) => {
  next.value = (options && options.next) ? decodeURIComponent(options.next) : "";
});

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    uni.request({
      url: "/api" + path,
      method,
      data: body || {},
      header: token ? { Authorization: "Bearer " + token, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
      success: (res) => {
        if (res.statusCode === 200 && res.data && res.data.code === 0) resolve(res.data.data);
        else reject(new Error((res.data && res.data.message) || "请求失败 " + res.statusCode));
      },
      fail: (e) => reject(new Error(e.errMsg || "网络异常")),
    });
  });
}

function enter(data) {
  saveSession(data);
  // 从游客动作过来的：直接退回原来那一页，由该页检测到已登录后继续完成动作
  if (next.value) {
    const stack = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    if (stack.length > 1) {
      uni.navigateBack({ delta: 1 });
      return;
    }
    uni.redirectTo({ url: next.value });
    return;
  }
  const target = HOME[data.user.role];
  if (!target) {
    uni.showToast({ title: "该角色暂无移动端页面", icon: "none" });
    return;
  }
  uni.showToast({ title: "登录成功", icon: "success" });
  uni.reLaunch({ url: target });
}

async function login() {
  loading.value = true;
  try {
    // 手机号或用户名都可以（教员端常用「用户名 + 密码」，家长/业务员用手机号）
    const data = await api("POST", "/auth/login-account", { account: String(phone.value || "").trim(), password: password.value });
    if (data.user && data.user.mustChangePassword) {
      // 初始口令必须先改：服务端在改密前只放行 change-password / me
      pendingUser.value = data.user;
      uni.setStorageSync("token", data.token);
      needChange.value = true;
      uni.showToast({ title: "首次登录请修改初始口令", icon: "none" });
      return;
    }
    enter(data);
  } catch (e) {
    uni.showToast({ title: e.message, icon: "none" });
  } finally {
    loading.value = false;
  }
}

/** 微信一键登录：小程序取 uni.login 的 code，H5/App 用一次性随机 code 走演示通道 */
async function wechatLogin() {
  loading.value = true;
  try {
    let code = "";
    // #ifdef MP-WEIXIN
    code = await new Promise((resolve, reject) => {
      uni.login({
        provider: "weixin",
        success: (r) => resolve(r.code || ""),
        fail: (e) => reject(new Error((e && e.errMsg) || "微信授权失败")),
      });
    });
    // #endif
    // #ifndef MP-WEIXIN
    code = "h5-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    // #endif
    const data = await api("POST", "/auth/wechat", { code });
    uni.showToast({ title: "微信登录成功", icon: "success" });
    enter(data);
  } catch (e) {
    uni.showToast({ title: e.message, icon: "none" });
  } finally {
    loading.value = false;
  }
}

async function changePassword() {
  if (newPassword.value !== confirmPassword.value) {
    uni.showToast({ title: "两次输入的新口令不一致", icon: "none" });
    return;
  }
  loading.value = true;
  try {
    const r = await api(
      "POST",
      "/auth/change-password",
      { oldPassword: password.value, newPassword: newPassword.value },
      uni.getStorageSync("token"),
    );
    // 改密后服务端返回新令牌（旧令牌立即失效）
    enter({ token: r.token || uni.getStorageSync("token"), user: { ...pendingUser.value, mustChangePassword: false } });
  } catch (e) {
    uni.showToast({ title: e.message, icon: "none" });
  } finally {
    loading.value = false;
  }
}

/** 协议阅读（P75）：登录页的《用户协议》《隐私政策》《退款规则》都能点开看 */
function openAgreement(key) {
  uni.navigateTo({ url: "/pages/agreements/index?key=" + key });
}
</script>

<template>
  <view class="wrap">
    <view class="card" style="margin-top: 60rpx">
      <view class="card-title">家教上门撮合平台</view>
      <view class="muted" style="margin-bottom: 24rpx">移动端 · uni-app（家长 / 教员 / 业务员 / 区域代理）</view>

      <template v-if="!needChange">
        <input v-model="phone" class="input" placeholder="手机号 / 用户名" />
        <input v-model="password" class="input" password placeholder="口令" />
        <view class="btn" @click="login">{{ loading ? "登录中…" : "登录 / 注册" }}</view>

        <!-- 微信一键登录排在「登录 / 注册」下面：先用手机号，或直接微信 -->
        <view class="or"><text class="or-text">或</text></view>
        <view class="btn wechat" @click="wechatLogin">{{ loading ? "登录中…" : "💬 微信一键登录" }}</view>

        <view class="muted" style="margin-top: 20rpx">
          演示：家长 13900000301 / 教员 13900000201 / 业务员 13900000101 / 代理 13900000010，口令均 a123456
        </view>
        <view class="muted" v-if="next" style="margin-top: 12rpx">登录后将回到刚才的页面继续操作。</view>
        <!-- 合规（P75）：登录即视为同意三份协议，文案可在后台「运营工具 → 协议文案」维护 -->
        <view class="muted" style="margin-top: 18rpx; line-height: 1.9">
          登录即表示同意
          <text class="link" @click="openAgreement('user')">《用户服务协议》</text>
          <text class="link" @click="openAgreement('privacy')">《隐私政策》</text>
          <text class="link" @click="openAgreement('refund')">《退款规则》</text>
        </view>
      </template>

      <template v-else>
        <view class="card-title">设置新口令</view>
        <view class="muted" style="margin-bottom: 20rpx">首次登录（或口令被重置）需修改初始口令：至少 8 位且同时包含字母与数字。</view>
        <input v-model="newPassword" class="input" password placeholder="新口令" />
        <input v-model="confirmPassword" class="input" password placeholder="再次输入新口令" />
        <view class="btn" @click="changePassword">{{ loading ? "提交中…" : "保存并进入" }}</view>
      </template>
    </view>
  </view>
</template>

<style>
.btn.wechat {
  background: linear-gradient(135deg, #07c160, #06a350);
  color: #fff;
  box-shadow: 0 8rpx 20rpx rgba(7, 193, 96, 0.28);
}
.or {
  display: flex;
  align-items: center;
  margin: 18rpx 0;
}
.or-text {
  flex: 1;
  text-align: center;
  font-size: 22rpx;
  color: #9aa3af;
}
.link {
  color: #1f6feb;
}
</style>
