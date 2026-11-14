<script setup lang="ts">
import { computed } from 'vue'
import { useModelState } from '../modelState'
import { costLabelTexts } from './costLabel'

const { activeTabCost, activeTabStreaming } = useModelState()

// Null while the active tab's conversation has no counted request: then
// there is no label.
const label = computed(() => {
  const { cost, edited } = activeTabCost.value
  return cost ? { ...costLabelTexts(cost, edited), edited } : null
})
</script>

<template>
  <span
    v-if="label"
    class="cost-label"
    :class="{ 'cost-label--busy': activeTabStreaming, 'cost-label--edited': label.edited }"
    :title="label.tooltip"
  >{{ label.text }}</span>
</template>

<style scoped>
/* The cost of the active tab's conversation, in the middle of the bottom bar
   (`AppLayout.vue`). Its look tells whether the model works (busy), and
   whether a reply was edited (italic, and dimmer while idle). The colors are
   mixes of theme variables, as `--color-accent` and `--color-muted` have less
   than 3:1 on the light bar: each look has 4.5:1 or more on
   `--color-tab-bar` in both themes, and stays dimmer than the model name. */
.cost-label {
  white-space: nowrap;
  color: var(--color-text);
  opacity: 0.65;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  transition: color 0.3s, opacity 0.3s;
}

.cost-label--busy {
  color: color-mix(in srgb, var(--color-accent) 60%, var(--color-text));
  opacity: 1;
}

.cost-label--edited {
  font-style: italic;
}

.cost-label--edited:not(.cost-label--busy) {
  opacity: 0.6;
}
</style>
