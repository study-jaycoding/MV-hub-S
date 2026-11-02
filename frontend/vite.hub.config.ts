import { mergeConfig } from "vite";
import base from "./vite.config";

// test_dev_hub.bat 의 두 번째 Vite 전용 — 캐시를 같이 쓰면 5173 Vite 와 서로의 의존성 묶음을 덮는다.
export default mergeConfig(base, { cacheDir: "node_modules/.vite-hub" });
