<script setup lang="ts">
import { useKeyboardShortcuts } from "../composables/useKeyboardShortcuts";

useKeyboardShortcuts();
</script>

<template>
  <div class="app-layout">
    <header class="tab-bar">
      <div class="tab-bar-tabs"></div>
      <div class="tab-bar-actions"></div>
    </header>
    <main class="main-content">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.tab-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 8px;
  background-color: var(--color-tab-bar);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  user-select: none;
  -webkit-user-select: none;
}

.tab-bar-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.tab-bar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.main-content {
  flex: 1;
  overflow: auto;
  background-color: var(--color-bg);
}
</style>
