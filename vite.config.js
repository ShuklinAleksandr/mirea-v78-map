import { defineConfig } from "vite";
import { releaseDataPlugin } from "./scripts/lib/release-data.mjs";

export function normalizeBuildBase(value = "/") {
  const base = String(value).trim();
  if (
    !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*\/?$/.test(base) ||
    base.includes("//") ||
    base.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      "BUILD_BASE must be an absolute site path such as /mirea-v78-map/.",
    );
  return base.endsWith("/") ? base : `${base}/`;
}

export default defineConfig({
  base: normalizeBuildBase(process.env.BUILD_BASE),
  plugins: [releaseDataPlugin()],
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
  preview: { host: "127.0.0.1", port: 4173, strictPort: false },
  build: {
    // Keep the WebGL engine in a stable cacheable chunk across map-data/UI changes.
    chunkSizeWarningLimit: 650,
    rollupOptions: { output: { manualChunks: { three: ["three"] } } },
  },
});
