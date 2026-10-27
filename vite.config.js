import { defineConfig } from "vite";
import { releaseDataPlugin } from "./scripts/lib/release-data.mjs";

export default defineConfig({
  plugins: [releaseDataPlugin()],
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
  preview: { host: "127.0.0.1", port: 4173, strictPort: false },
  build: {
    // Keep the WebGL engine in a stable cacheable chunk across map-data/UI changes.
    chunkSizeWarningLimit: 650,
    rollupOptions: { output: { manualChunks: { three: ["three"] } } },
  },
});
