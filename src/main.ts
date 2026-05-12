import { createApp } from "vue";
import { createPinia } from "pinia";
import sbp from "@sbp/sbp";
import "./view";
import "./controller";
import "./model";
import App from "./App.vue";
import { useThreadStore } from "./model/state/thread";
import { useTabStore } from "./model/state/tabs";
import { useSettingsStore } from "./model/state/settings";
import { usePromptsStore } from "./model/state/prompts";

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
