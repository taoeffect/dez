/// <reference types="vite/client" />

import type sbp from '@sbp/sbp'

declare global {
  const __APP_VERSION__: string

  interface Window {
    sbp: typeof sbp
  }

  interface ImportMetaEnv {
    // A smoke-test build's update check source (src/controller/updates.ts).
    readonly VITE_DEZ_RELEASES_API_URL?: string
  }
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
