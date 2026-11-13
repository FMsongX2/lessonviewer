import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 중에는 Vite(5179)가 화면을, bun 서버(5178)가 API·슬라이드를 맡음
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1600 },   // 로컬 전용이라 분할 안 함 (KaTeX 포함)
  server: {
    port: 5179,
    strictPort: true,
    proxy: { "/api": "http://localhost:5178", "/slides": "http://localhost:5178" },
  },
});
