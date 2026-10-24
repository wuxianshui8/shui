<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { auth } from "./api";

const route = useRoute();
const router = useRouter();

const menus = [
  { path: "/overview", title: "总览", icon: "DataLine" },
  { path: "/orders", title: "订单管理", icon: "Tickets" },
  { path: "/refunds", title: "退款工单", icon: "RefreshLeft" },
  { path: "/finance", title: "财务资金", icon: "Money" },
  { path: "/withdrawals", title: "提现审核", icon: "CreditCard" },
  { path: "/invoices", title: "发票受理", icon: "Tickets" },
  { path: "/users", title: "用户管理", icon: "User" },
  { path: "/teachers", title: "教员审核", icon: "Reading" },
  { path: "/agents", title: "代理管理", icon: "OfficeBuilding" },
  { path: "/admins", title: "管理员账号", icon: "UserFilled" },
  { path: "/permissions", title: "权限矩阵", icon: "Lock" },
  { path: "/demands", title: "需求池", icon: "Search" },
  { path: "/regions", title: "区域管理", icon: "MapLocation" },
  { path: "/rules", title: "规则配置中心", icon: "SetUp" },
  { path: "/ops", title: "运营工具", icon: "Picture" },
  { path: "/catalog", title: "学段 / 科目", icon: "Collection" },
  { path: "/risks", title: "风控与仲裁", icon: "Warning" },
  { path: "/complaints", title: "投诉工单", icon: "ChatDotRound" },
  { path: "/logs", title: "操作日志", icon: "Document" },
];

const isLogin = computed(() => route.path === "/login");
const title = computed(() => route.meta.title || "平台管理后台");
const who = computed(() => auth.user || {});

function logout() {
  auth.clear();
  router.push("/login");
}
</script>

<template>
  <div v-if="isLogin" class="login-wrap">
    <router-view />
  </div>
  <div v-else class="shell">
    <aside class="side">
      <div class="brand">
        家教上门撮合平台
        <small>平台管理后台 · Vue3 + Element Plus</small>
      </div>
      <nav class="menu">
        <router-link
          v-for="m in menus"
          :key="m.path"
          :to="m.path"
          :class="{ on: route.path === m.path }"
        >
          <el-icon><component :is="m.icon" /></el-icon>
          <span>{{ m.title }}</span>
        </router-link>
      </nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="title">{{ title }}</div>
        <div class="who">
          <span>{{ who.nickname || "管理员" }}（{{ who.role || "admin" }}）</span>
          <el-button size="small" text @click="router.push('/password')" data-test="top-password">修改口令</el-button>
          <el-button size="small" text @click="logout">退出登录</el-button>
        </div>
      </header>
      <main class="content">
        <router-view />
      </main>
    </div>
  </div>
</template>
