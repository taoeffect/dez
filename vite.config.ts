import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import pkg from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// The video.js custom elements in the template of
// src/view/media/MediaPlayer.vue. Vue must take each as a native element,
// not as a Vue component that it cannot find. Keep the list exact: a prefix
// rule (`media-`) would also hide a typing error in a component name.
const videoJsElements: Record<string, true> = {
  "video-player": true,
  "audio-player": true,
  "media-container": true,
  "media-play-button": true,
  "media-mute-button": true,
  "media-fullscreen-button": true,
  "media-time-group": true,
  "media-time": true,
  "media-time-separator": true,
  "media-time-slider": true,
  "media-volume-slider": true,
  "media-slider-track": true,
  "media-slider-buffer": true,
  "media-slider-fill": true,
  "media-slider-thumb": true,
  "media-tooltip-group": true,
  "media-tooltip": true,
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // `=== true`: a name of `Object.prototype` is not in the list.
          isCustomElement: (tag: string) => videoJsElements[tag] === true,
        },
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port (devUrl in src-tauri/tauri.conf.json), fail if that port is not available
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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
