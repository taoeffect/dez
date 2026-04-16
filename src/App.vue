<script setup lang="ts">
import AppLayout from "./components/AppLayout.vue";
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

:root {
  --color-bg: #f6f6f6;
  --color-text: #0f0f0f;
  --color-tab-bar: #e8e8e8;
  --color-border: #d0d0d0;

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
  :root {
    --color-bg: #1e1e1e;
    --color-text: #f6f6f6;
    --color-tab-bar: #2a2a2a;
    --color-border: #3a3a3a;
  }
}
</style>
