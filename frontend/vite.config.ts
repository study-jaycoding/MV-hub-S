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
      // 백엔드가 실제 접속 PC를 구분할 수 있게 전달한다. Resolve 로컬 기능은
      // 이 PC의 주소만 허용하므로, LAN의 다른 PC가 Vite를 경유해 우회하지 못한다.
      "/api": { target: BACKEND, changeOrigin: true, xfwd: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true, xfwd: true },
      "/media": { target: BACKEND, changeOrigin: true, xfwd: true },
    },
  },
});
