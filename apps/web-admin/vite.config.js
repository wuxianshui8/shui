import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 构建产物由 NestJS 以 /admin-vue/ 静态托管（见 apps/api-nest/src/main.ts）
export default defineConfig({
  plugins: [vue()],
  base: "/admin-vue/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 4400,
    proxy: {
      "/api": { target: "http://127.0.0.1:4300", changeOrigin: true },
    },
  },
});
