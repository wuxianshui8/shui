<template>
  <div class="page">
    <el-card class="box" shadow="never">
      <template #header>
        <div class="box-head">
          <b>修改登录口令</b>
          <div class="muted small">
            {{ force ? "首次登录需要先修改平台下发的初始口令，改完才能使用其它功能。" : "改完会自动续上新凭证，不需要重新登录。" }}
          </div>
        </div>
      </template>

      <el-form :model="form" label-width="110px" @submit.prevent>
        <el-form-item label="当前口令">
          <el-input
            v-model="form.oldPassword"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="请输入当前使用中的口令"
            data-test="old-password"
          />
        </el-form-item>
        <el-form-item label="新口令">
          <el-input
            v-model="form.newPassword"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="至少 8 位，需同时包含字母与数字"
            data-test="new-password"
          />
        </el-form-item>
        <el-form-item label="确认新口令">
          <el-input
            v-model="form.confirm"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="再输入一次新口令"
            data-test="confirm-password"
          />
        </el-form-item>

        <el-alert
          v-if="error"
          :title="error"
          type="error"
          show-icon
          :closable="false"
          class="mb"
          data-test="password-error"
        />
        <el-alert
          v-if="force"
          title="未修改初始口令前，除「修改口令 / 我的信息 / 退出」外的接口都会拒绝访问。"
          type="warning"
          show-icon
          :closable="false"
          class="mb"
        />

        <el-form-item>
          <el-button type="primary" :loading="loading" @click="submit" data-test="submit-password">
            确认修改
          </el-button>
          <el-button v-if="!force" text @click="router.push('/overview')">返回</el-button>
          <el-button v-else text @click="logout">退出登录</el-button>
        </el-form-item>
      </el-form>

      <div class="tips muted small">
        口令策略：≥ 8 位、必须同时包含字母与数字、不能与当前口令相同。改密后旧令牌立即失效，
        系统会把新令牌写回本地，其它设备上的登录状态需重新登录。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, auth } from "../api";

const router = useRouter();
const route = useRoute();
const force = computed(() => route.query.force === "1");

const form = reactive({ oldPassword: "", newPassword: "", confirm: "" });
const loading = ref(false);
const error = ref("");

function validate() {
  const { oldPassword, newPassword, confirm } = form;
  if (!oldPassword) return "请输入当前口令";
  if (newPassword.length < 8) return "新口令至少 8 位";
  if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return "新口令需同时包含字母与数字";
  if (newPassword === oldPassword) return "新口令不能与当前口令相同";
  if (newPassword !== confirm) return "两次输入的新口令不一致";
  return "";
}

async function submit() {
  error.value = validate();
  if (error.value) return;
  loading.value = true;
  try {
    const data = await api.post("/auth/change-password", {
      oldPassword: form.oldPassword,
      newPassword: form.newPassword,
    });
    // 后端改密后 token_version 自增，旧令牌失效；返回的新令牌要立刻写回，避免被踢下线
    auth.save(data.token, { ...(auth.user || {}), mustChangePassword: false });
    ElMessage.success("口令已修改");
    form.oldPassword = form.newPassword = form.confirm = "";
    router.push("/overview");
  } catch (e) {
    error.value = e.message || "修改失败";
    ElMessage.error(error.value);
  } finally {
    loading.value = false;
  }
}

async function logout() {
  try {
    await ElMessageBox.confirm("退出后需要重新登录。", "退出登录", { type: "warning" });
  } catch {
    return;
  }
  auth.clear();
  router.push("/login");
}
</script>

<style scoped>
.page {
  display: flex;
  justify-content: center;
  padding: 24px 12px;
}
.box {
  width: 100%;
  max-width: 560px;
}
.box-head .muted {
  margin-top: 4px;
  line-height: 1.6;
}
.mb {
  margin-bottom: 12px;
}
.tips {
  margin-top: 8px;
  line-height: 1.7;
}
</style>
