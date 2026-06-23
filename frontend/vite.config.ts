import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 백엔드(FastAPI)는 기본 8000 포트. /api 와 /ws 를 프록시한다.
// 백엔드 포트를 바꾸면 BACKEND 환경변수로 재정의.
const BACKEND = process.env.BACKEND || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true },
      "/media": { target: BACKEND, changeOrigin: true },
    },
  },
});
