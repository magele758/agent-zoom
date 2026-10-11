import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.AGENT_CHATROOM_API ?? "http://127.0.0.1:8791";
const port = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    proxy: {
      "/api": api,
      "/mcp": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
