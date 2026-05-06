/// <reference types="vite/client" />

import type sbp from './utils/ui'

declare global {
  const __APP_VERSION__: string

  interface Window {
    sbp: typeof sbp
  }
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
