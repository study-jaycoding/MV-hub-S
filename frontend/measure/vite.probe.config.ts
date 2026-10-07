import { defineConfig } from "vite";
export default defineConfig({
  root: "measure",
  build: { outDir: "../measure-dist", emptyOutDir: true, target: "es2022" },
});
