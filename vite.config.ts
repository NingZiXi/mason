import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Local QA exports can contain entire unpacked releases and Python runtimes.
      // Walking these trees delays the desktop's first render even on a cache hit.
      ignored: [
        "**/src-tauri/**", "**/films/**", "**/docs/**",
        "**/test_out/**", "**/artifacts/**", "**/.npm-cache/**", "**/.tauri/**",
      ],
    },
  },
  // Scan only the desktop entry; nested video projects contain many unrelated
  // HTML entry points and dependency trees that can stall initial loading.
  optimizeDeps: {
    entries: ["index.html"],
  },
  build: {
    target:
      // @ts-expect-error process is a nodejs global
      process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
