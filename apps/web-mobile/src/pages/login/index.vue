<script setup>
import { ref } from "vue";

const phone = ref("13900000301");
const password = ref("a123456");
const loading = ref(false);

/** 首登改密（后台开通的账号 mustChangePassword=true 时进入此流程） */
const needChange = ref(false);
const newPassword = ref("");
const confirmPassword = ref("");
const pendingUser = ref(null);

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

const HOME = { parent: "/pages/parent/index", teacher: "/pages/teacher/index", sales: "/pages/sales/index", agent: "/pages/agent/index" };

function enter(data) {
  uni.setStorageSync("token", data.token);
  uni.setStorageSync("user", data.user);
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
    const data = await api("POST", "/auth/login-password", { phone: phone.value, password: password.value });
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
</script>

<template>
  <view class="wrap">
    <view class="card" style="margin-top: 60rpx">
      <view class="card-title">家教上门撮合平台</view>
      <view class="muted" style="margin-bottom: 24rpx">移动端 · uni-app（家长 / 教员 / 业务员 / 区域代理）</view>

      <template v-if="!needChange">
        <input v-model="phone" class="input" placeholder="手机号" />
        <input v-model="password" class="input" password placeholder="口令" />
        <view class="btn" @click="login">{{ loading ? "登录中…" : "登录" }}</view>
        <view class="muted" style="margin-top: 20rpx">
          演示：家长 13900000301 / 教员 13900000201 / 业务员 13900000101 / 代理 13900000010，口令均 a123456
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
