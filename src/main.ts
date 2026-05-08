import { createApp } from "vue";
import { createPinia } from "pinia";
import sbp from "@sbp/sbp";
import "./sbp";
import App from "./App.vue";
import { useThreadStore } from "./stores/threadStore";
import { useTabStore } from "./stores/tabStore";
import { useSettingsStore } from "./stores/settingsStore";
import { usePromptsStore } from "./stores/promptsStore";

const app = createApp(App);
app.use(createPinia());
app.mount("#app");

window.sbp = sbp;

if (import.meta.env.DEV) {
  (window as unknown as { __stores: unknown }).__stores = {
    thread: useThreadStore(),
    tab: useTabStore(),
    settings: useSettingsStore(),
    prompts: usePromptsStore(),
  };
}
