import { createRouter, createWebHashHistory } from "vue-router";
import { auth } from "./api";

const routes = [
  { path: "/login", component: () => import("./views/Login.vue"), meta: { public: true, title: "登录" } },
  { path: "/", redirect: "/overview" },
  { path: "/overview", component: () => import("./views/Overview.vue"), meta: { title: "总览" } },
  { path: "/orders", component: () => import("./views/Orders.vue"), meta: { title: "订单管理" } },
  { path: "/refunds", component: () => import("./views/Refunds.vue"), meta: { title: "退款工单" } },
  { path: "/finance", component: () => import("./views/Finance.vue"), meta: { title: "财务资金" } },
  { path: "/withdrawals", component: () => import("./views/Withdrawals.vue"), meta: { title: "提现审核" } },
  { path: "/invoices", component: () => import("./views/Invoices.vue"), meta: { title: "发票受理" } },
  { path: "/users", component: () => import("./views/Users.vue"), meta: { title: "用户管理" } },
  { path: "/teachers", component: () => import("./views/Teachers.vue"), meta: { title: "教员审核" } },
  { path: "/agents", component: () => import("./views/Agents.vue"), meta: { title: "代理管理" } },
  { path: "/regions", component: () => import("./views/Regions.vue"), meta: { title: "区域管理" } },
  { path: "/rules", component: () => import("./views/Rules.vue"), meta: { title: "规则配置中心" } },
  { path: "/ops", component: () => import("./views/Ops.vue"), meta: { title: "运营工具" } },
  { path: "/risks", component: () => import("./views/Risks.vue"), meta: { title: "风控与仲裁" } },
  { path: "/logs", component: () => import("./views/Logs.vue"), meta: { title: "操作日志" } },
];

const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!auth.token) return { path: "/login" };
  return true;
});

export default router;
