<script setup>
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api, auth } from "../api";

const router = useRouter();
const loading = ref(false);
const form = reactive({ phone: "13900000001", password: "a123456" });

async function submit() {
  loading.value = true;
  try {
    const data = await api.post("/auth/login-password", { phone: form.phone, password: form.password });
    if (data.user.role !== "admin") {
      ElMessage.error("该账号不是平台管理员，无法登录后台");
      return;
    }
    auth.save(data.token, data.user);
    ElMessage.success("登录成功");
    router.push("/overview");
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-card">
    <h1>平台管理后台</h1>
    <p class="sub">家教上门撮合平台 · 运营与风控中心</p>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="手机号">
        <el-input v-model="form.phone" placeholder="请输入管理员手机号" data-test="phone" />
      </el-form-item>
      <el-form-item label="登录口令">
        <el-input
          v-model="form.password"
          type="password"
          show-password
          placeholder="请输入口令"
          data-test="password"
          @keyup.enter="submit"
        />
      </el-form-item>
      <el-button type="primary" style="width: 100%" :loading="loading" data-test="login" @click="submit">
        登录
      </el-button>
    </el-form>
    <div class="hint">
      演示账号：13900000001 / a123456<br />
      口令失败次数超阈值会被锁定 15 分钟（阈值由规则配置中心控制）。
    </div>
  </div>
</template>
