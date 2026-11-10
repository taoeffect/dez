<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import sbp from '@sbp/sbp'
import AppLayout from './AppLayout.vue'

onMounted(() => {
  void sbp('dez.controller/app/init')
})

onUnmounted(() => {
  sbp('dez.controller/app/cleanup')
})
</script>

<template>
  <AppLayout />
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* Editor colors (dezTheme in cmEditor.ts): the selection, the find
   highlights, and the text colors that sit on them. Find highlights are
   translucent and stack on the selection. The light values are the look the
   user approved. The dark values give every text color 4.5:1 or more on the
   selection. The dark selection is translucent because WebKit turns an
   opaque `::selection` color (the thinking panel uses it) into one that
   matches only over white, which came out almost black on the dark panel. */
:root {
  --color-bg: #f6f6f6;
  --color-text: #0f0f0f;
  --color-tab-bar: #e8e8e8;
  --color-border: #d0d0d0;
  --color-accent: #4c8dff;
  --color-muted: #888;
  --color-link: #4a9eff;
  --color-code: #c792ea;
  --color-selection: #d7d4f0;
  --color-selection-inactive: rgba(100, 149, 237, 0.35);
  --color-find-match: rgba(255, 190, 60, 0.35);
  --color-find-match-current: rgba(255, 150, 0, 0.6);
  --color-find-match-outline: rgba(230, 120, 0, 0.95);
  /* Error toasts (ToastCard.vue): the title and icon color, the card tint,
     and its border. The title color is 4.5:1 or more on the tint. */
  --color-error: #c4302b;
  --color-error-bg: #fdeeed;
  --color-error-border: #f0b9b5;
  /* A solid danger fill under a white icon (the image trash on hover). */
  --color-error-fill: #c4302b;
  /* A thing that went well: the "Saved" state of a clip's Save control
     (MediaPlayer.vue). As text it is 4.5:1 or more on the background. */
  --color-success: #1a7f37;
  /* Tab bar backgrounds (TabBar.vue): a tab whose reply streams (busy), and
     a tab whose reply ended in the background (done). */
  --color-tab-busy: #f7dc9b;
  --color-tab-done: #c2e5c4;
  /* The image overlay toolbar (dezTheme in cmEditor.ts): a dark glass
     surface with white text in both themes, so that it reads on any image,
     and its hairline border and divider. */
  --color-image-toolbar: rgba(18, 18, 22, 0.72);
  --color-image-toolbar-border: rgba(255, 255, 255, 0.18);

  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-weight: 400;

  color: var(--color-text);
  background-color: var(--color-bg);

  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg: #1e1e1e;
    --color-text: #f6f6f6;
    --color-tab-bar: #2a2a2a;
    --color-border: #3a3a3a;
    --color-muted: #a8a8a8;
    --color-link: #6cb4ff;
    --color-selection: rgba(16, 56, 113, 0.7);
    --color-selection-inactive: #283242;
    --color-find-match: rgba(224, 160, 48, 0.22);
    --color-find-match-current: rgba(255, 128, 0, 0.32);
    --color-find-match-outline: #ffa040;
    --color-error: #ff7b72;
    --color-error-bg: #3a2224;
    --color-error-border: #6b3236;
    --color-error-fill: #da3633;
    --color-success: #3fb950;
    --color-tab-busy: #5b4716;
    --color-tab-done: #234d2e;
    --color-image-toolbar: rgba(40, 40, 46, 0.8);
    --color-image-toolbar-border: rgba(255, 255, 255, 0.14);
  }
}

:root[data-theme="dark"] {
  --color-bg: #1e1e1e;
  --color-text: #f6f6f6;
  --color-tab-bar: #2a2a2a;
  --color-border: #3a3a3a;
  --color-muted: #a8a8a8;
  --color-link: #6cb4ff;
  --color-selection: rgba(16, 56, 113, 0.7);
  --color-selection-inactive: #283242;
  --color-find-match: rgba(224, 160, 48, 0.22);
  --color-find-match-current: rgba(255, 128, 0, 0.32);
  --color-find-match-outline: #ffa040;
  --color-error: #ff7b72;
  --color-error-bg: #3a2224;
  --color-error-border: #6b3236;
  --color-error-fill: #da3633;
  --color-success: #3fb950;
  --color-tab-busy: #5b4716;
  --color-tab-done: #234d2e;
  --color-image-toolbar: rgba(40, 40, 46, 0.8);
  --color-image-toolbar-border: rgba(255, 255, 255, 0.14);
}
</style>
