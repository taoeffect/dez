<script setup lang="ts">
import { computed } from 'vue'
import { useActiveContextSize } from '../composables/useActiveContextSize'
import { useModelState } from '../modelState'
import { costLabelTexts } from './costLabel'
import { tokenLabelTexts } from './tokenLabel'

const { activeTabCost, activeTabStreaming, activeTabCompacting } = useModelState()
const contextSize = useActiveContextSize()

// Null for a tab whose next request is empty (no model and no text): then
// there is no token count.
const tokens = computed(() => {
  const size = contextSize.value
  return size && size.tokens > 0 ? tokenLabelTexts(size) : null
})

// Null while the active tab's conversation has no counted request: then
// there is no cost.
const cost = computed(() => {
  const { cost, edited, compactions } = activeTabCost.value
  return cost ? { ...costLabelTexts(cost, edited, compactions), edited } : null
})

// The tooltip of the "Compacting…" part.
const COMPACTING_TOOLTIP = 'This conversation is near the limit of what one request can hold. '
  + 'Dez now asks the model for notes that take the place of the earlier messages. The reply goes on after that.'
</script>

<template>
  <span v-if="tokens || cost || activeTabCompacting" class="usage-label" :class="{ 'usage-label--busy': activeTabStreaming }">
    <!-- After a compaction, a part shows two numbers: the one of the buffer,
         then the one of the whole conversation in parentheses, with its own
         tooltip. The total is in its part, with no white space of the
         template around it: the part is one flex item, so the two numbers
         never part, and its text reads `~81.2k (1.2M)`. -->
    <span v-if="tokens" class="usage-label__part token-label" :title="tokens.tooltip">{{ tokens.text }}<span
      v-if="tokens.total"
      class="usage-label__total"
      :title="tokens.total.tooltip"
    >{{ ' ' + tokens.total.text }}</span></span>
    <span v-if="cost" class="usage-label__cost">
      <span v-if="tokens" class="usage-label__dot" aria-hidden="true">·</span>
      <span
        class="usage-label__part cost-label"
        :class="{ 'cost-label--edited': cost.edited }"
        :title="cost.tooltip"
      >{{ cost.text }}<span
        v-if="cost.total"
        class="usage-label__total"
        :title="cost.total.tooltip"
      >{{ ' ' + cost.total.text }}</span>{{ cost.mark }}</span>
    </span>
    <span v-if="activeTabCompacting" class="usage-label__state">
      <span v-if="tokens || cost" class="usage-label__dot" aria-hidden="true">·</span>
      <span class="usage-label__part compacting-label" :title="COMPACTING_TOOLTIP">Compacting…</span>
    </span>
  </span>
</template>

<style scoped>
/* The size and the cost of the active tab's conversation, in the middle of
   the bottom bar (`AppLayout.vue`): the token count, a dot, the cost, and,
   while the reply waits for a compaction of the conversation, a dot and
   "Compacting…". After a compaction, the count and the cost are the ones
   of the buffer (the conversation since its last compaction), each with
   the number of the whole conversation in parentheses after it
   (`.usage-label__total`, which has the look of its part). Each part and
   each total has its own tooltip. Their look tells whether
   the model works (busy), and whether a reply was edited (the cost is
   italic, and dimmer while idle). The colors are mixes of theme variables,
   as `--color-accent` and `--color-muted` have less than 3:1 on the light
   bar: each look of a part has 4.5:1 or more on `--color-tab-bar` in both
   themes, and stays dimmer than the model name. */
.usage-label {
  display: flex;
  flex-wrap: wrap;
  /* Every part is one line of the label's line height, so `center` puts
     all the text on one baseline. */
  align-items: center;
  max-width: 100%;
  height: 16px;
  /* The side padding is room for the slant of the italic cost, which
     `overflow` would cut. */
  padding: 0 2px;
  overflow: hidden;
  line-height: 16px;
  white-space: nowrap;
  font-size: 12px;
  /* Digits of one width, so a count that grows does not move the cost. */
  font-variant-numeric: tabular-nums;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}

/* A bar with too little room (a long model name in a narrow window) must
   keep Submit in view, so the label gives way: its grid column can get
   narrower than its text (`AppLayout.vue`). A part that does not fit then
   goes to a next line, which the height of the label cuts off. So no part
   ever shows cut: first "Compacting…" goes, then the cost, each with its
   dot, then the token count. A flex line keeps its first item also when
   that does not fit, so this empty first item takes that place, and the
   token count can go. It is as high as the label: a first line of no
   height would show the second one. */
.usage-label::before {
  content: '';
  height: 100%;
}

.usage-label__cost,
.usage-label__state {
  display: flex;
  align-items: center;
}

/* The color and its transition are on each part, not on the label:
   tests/e2e/usage-label.e2e.ts reads them from the part. */
.usage-label__part {
  color: var(--color-text);
  opacity: 0.65;
  transition: color 0.3s, opacity 0.3s;
}

.usage-label--busy .usage-label__part {
  color: color-mix(in srgb, var(--color-accent) 60%, var(--color-text));
  opacity: 1;
}

/* Only a separator: dimmer than the parts, and the same while busy. */
.usage-label__dot {
  margin: 0 6px;
  color: var(--color-text);
  opacity: 0.35;
}

.cost-label--edited {
  font-style: italic;
}

.usage-label:not(.usage-label--busy) .cost-label--edited {
  opacity: 0.6;
}
</style>
