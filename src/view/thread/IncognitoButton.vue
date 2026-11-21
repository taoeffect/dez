<script setup lang="ts">
import { computed } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'

const { activeTabId, activeTabIncognito } = useModelState()

// A domino mask with two eye holes. Off: its outline, grey as the Help
// button. On: filled purple with the eyes cut out (`evenodd`), and a
// brighter purple rim on the outer edge only: the eye holes are about 1.5
// units tall, and a rim in them would close them.
const MASK_EDGE = 'M1.3 5.7C3.6 4.3 6.1 4.7 8 5.6c1.9-.9 4.4-1.3 6.7.1.5 2.6-.4 5.3-2.9 5.5-1.6.1-2.7-.8-3.8-1.9-1.1 1.1-2.2 2-3.8 1.9-2.5-.2-3.4-2.9-2.9-5.5Z'
const MASK_PATH = MASK_EDGE
  + 'M3.6 7.6c.5-.9 2.4-1 3 .1-.6.9-2.4 1-3-.1Z'
  + 'M9.4 7.7c.6-1.1 2.5-1 3-.1-.6 1.1-2.4 1-3 .1Z'

// What incognito leaves out of a request (`requestParts`), why, that it is
// no guarantee of privacy, and its rule (`canTurnOnIncognito`).
const tooltip = computed(() => [
  activeTabIncognito.value ? 'Incognito is on in this tab.' : 'Incognito: click to turn it on in this tab.',
  'An incognito tab sends no Dez tools and no system prompt of Dez (also not your own from Settings), and Dez does not compact its conversation. A provider that has a system prompt of its own, such as Venice, gets it turned on.',
  'So a provider cannot easily tell your requests from the requests of other apps: you hide in a larger crowd.',
  'This is no guarantee of privacy: your messages, the model that you pick, your network address, your provider account, and more can still tell who you are. Dez still saves the conversation on this computer.',
  activeTabIncognito.value
    ? 'Incognito cannot be turned off in a tab once enabled.'
    : 'Incognito can go on only before the first message of a tab, and it cannot be turned off.',
].join('\n'))

function onClick (event: MouseEvent): void {
  // The second click of a double-click would show the notice that
  // incognito stays on, right after the first click turned it on. Only the
  // first click of a series acts; `detail` is 0 for a keyboard press.
  if (event.detail > 1) return
  void sbp('dez.controller/turnOnIncognito', activeTabId.value)
}
</script>

<template>
  <!-- `mousedown.prevent` keeps the focus and the caret where they are. -->
  <button
    class="incognito-button"
    :class="{ 'incognito-button--on': activeTabIncognito }"
    :title="tooltip"
    aria-label="Incognito"
    :aria-pressed="activeTabIncognito"
    @mousedown.prevent
    @click="onClick"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <template v-if="activeTabIncognito">
        <path class="incognito-mask-fill" fill-rule="evenodd" :d="MASK_PATH"/>
        <path class="incognito-mask-rim" :d="MASK_EDGE"/>
      </template>
      <path
        v-else
        fill="none"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linejoin="round"
        :d="MASK_PATH"
      />
    </svg>
  </button>
</template>

<style scoped>
/* Off: as the Help button next to it. */
.incognito-button {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  opacity: 0.4;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.incognito-button:hover {
  opacity: 0.8;
}

/* On: full opacity, a vibrant purple with a brighter purple rim, and a
   soft glow in the purple of the rim. */
.incognito-button--on,
.incognito-button--on:hover {
  opacity: 1;
}

.incognito-button--on svg {
  filter: drop-shadow(0 0 2px rgba(185, 138, 255, 0.5));
}

.incognito-mask-fill {
  fill: #7b2ff7;
}

.incognito-mask-rim {
  fill: none;
  stroke: #b98aff;
  stroke-width: 1;
  stroke-linejoin: round;
}
</style>
