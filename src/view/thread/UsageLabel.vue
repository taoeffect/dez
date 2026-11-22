<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import sbp from '@sbp/sbp'
import type { MoneyLimit } from '../../model/chat/moneyLimit'
import { useActiveContextSize } from '../composables/useActiveContextSize'
import { useModelState } from '../modelState'
import { costLabelTexts } from './costLabel'
import { draftLimitUsd, moneyLimitLabelTexts, moneySpentText } from './moneyLimitLabel'
import { tokenLabelTexts } from './tokenLabel'

const { activeTabId, activeTabCost, activeTabMoneyLimit, activeTabStreaming, activeTabCompacting } = useModelState()
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

const moneyLimit = computed(() => moneyLimitLabelTexts(activeTabMoneyLimit.value, activeTabCost.value.cost))

// The popup of the money limit. It sets the limit of the tab that was
// active when it opened (`popupTabId`, null while it is closed), and closes
// when the active tab changes. The field holds a draft: Enter, a change of
// the field, or a close with a click outside sets the limit of the draft;
// Escape closes the popup and sets nothing.
const areaEl = ref<HTMLElement | null>(null)
const usdField = ref<HTMLInputElement | null>(null)
const popupTabId = ref<string | null>(null)
const draft = ref('')
const draftUsd = computed(() => draftLimitUsd(draft.value))
const draftIsAmount = computed(() => typeof draftUsd.value === 'number')
const spentText = computed(() => moneySpentText(activeTabCost.value.cost))

function togglePopup(): void {
  if (popupTabId.value) {
    closeToEditor(true)
    return
  }
  const limit = activeTabMoneyLimit.value
  popupTabId.value = activeTabId.value
  draft.value = limit ? String(limit.usd) : ''
  void nextTick(() => usdField.value?.select())
}

function savedLimit(tabId: string): MoneyLimit | undefined {
  return sbp('dez.model/tabs/moneyLimit', tabId) as MoneyLimit | undefined
}

// A draft that is no amount sets nothing; the popup tells why while it is
// open.
function applyDraft(): void {
  const tabId = popupTabId.value
  const usd = draftUsd.value
  if (!tabId || usd === undefined) return
  const limit = savedLimit(tabId)
  if (usd === null) {
    if (limit) sbp('dez.model/tabs/setMoneyLimit', tabId, null)
  } else if (usd !== limit?.usd) {
    sbp('dez.model/tabs/setMoneyLimit', tabId, { usd, unknownPrices: limit?.unknownPrices ?? false })
  }
}

// The checkbox sets the limit of the draft too, so that a check right after
// a typed amount does not need an Enter first.
function setUnknownPrices(event: Event): void {
  const tabId = popupTabId.value
  const usd = draftUsd.value
  if (!tabId || typeof usd !== 'number') return
  sbp('dez.model/tabs/setMoneyLimit', tabId, { usd, unknownPrices: (event.target as HTMLInputElement).checked })
}

function closePopup(apply: boolean): void {
  if (apply) applyDraft()
  popupTabId.value = null
}

function closeToEditor(apply: boolean): void {
  closePopup(apply)
  sbp('dez.editor/focus')
}

// Enter on a draft that is no amount keeps the popup open, with the text
// that tells why.
function onFieldEnter(): void {
  if (draftUsd.value !== undefined) closeToEditor(true)
}

function onMousedownOutside(event: MouseEvent): void {
  if (popupTabId.value && !areaEl.value?.contains(event.target as Node)) closePopup(true)
}

// On `document` in the capture phase, as the popups of ModelSelector.vue:
// the open popup takes Escape before the editor and the global shortcut
// handler, which would else close find or stop the stream.
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !popupTabId.value) return
  event.stopPropagation()
  closeToEditor(false)
}

watch(activeTabId, () => {
  if (popupTabId.value) closePopup(true)
})

onMounted(() => {
  document.addEventListener('mousedown', onMousedownOutside)
  document.addEventListener('keydown', onKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onMousedownOutside)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <!-- The grid item of the bottom bar. The label cuts off the parts that do
       not fit (`overflow: hidden`), so the popup is next to it, not in it. -->
  <div ref="areaEl" class="usage-area">
    <span class="usage-label" :class="{ 'usage-label--busy': activeTabStreaming }">
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
      <!-- `mousedown.prevent` keeps the focus and the caret where they are. -->
      <button
        type="button"
        class="money-limit-button"
        :class="{ 'money-limit-button--set': activeTabMoneyLimit }"
        :title="moneyLimit.tooltip"
        aria-label="Money limit"
        :aria-expanded="popupTabId !== null"
        @mousedown.prevent
        @click="togglePopup"
      >
        <!-- A coin with a dollar sign. -->
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M10 5.9C9.6 5.3 8.9 5 8 5c-1.2 0-2 .6-2 1.5S6.8 7.7 8 8s2 .8 2 1.6S9.2 11 8 11c-.9 0-1.6-.3-2-.9M8 3.8V5M8 11v1.2" />
        </svg>
        <span v-if="moneyLimit.text" class="money-limit-label">{{ moneyLimit.text }}</span>
      </button>
      <span v-if="activeTabCompacting" class="usage-label__state">
        <span class="usage-label__dot" aria-hidden="true">·</span>
        <span class="usage-label__part compacting-label" :title="COMPACTING_TOOLTIP">Compacting…</span>
      </span>
    </span>
    <!-- The words "money limit" and "Allow unknown prices" are the ones of
         the refusal texts of the money rule (`moneyProblem`). -->
    <div v-if="popupTabId" class="money-limit-popup" role="dialog" aria-label="Money limit">
      <div class="money-limit-popup__header">Money limit</div>
      <label class="money-limit-popup__row">
        <span>Limit in USD</span>
        <input
          ref="usdField"
          v-model="draft"
          class="money-limit-popup__field"
          type="text"
          inputmode="decimal"
          spellcheck="false"
          autocomplete="off"
          placeholder="None"
          @change="applyDraft"
          @keydown.enter.exact.prevent="onFieldEnter"
        >
      </label>
      <p v-if="draftUsd === undefined" class="money-limit-popup__text money-limit-popup__problem">
        Type an amount in USD, such as 5 or 2.50. An empty field means no limit.
      </p>
      <label class="money-limit-popup__row money-limit-popup__check" :class="{ 'money-limit-popup__row--off': !draftIsAmount }">
        <input
          type="checkbox"
          :checked="draftIsAmount && activeTabMoneyLimit?.unknownPrices === true"
          :disabled="!draftIsAmount"
          @change="setUnknownPrices"
        >
        <span>Allow unknown prices</span>
      </label>
      <p class="money-limit-popup__text">
        Dez sends no request of this tab that would cost more than the limit. Without "Allow
        unknown prices", it also sends no request whose price it does not know. No model can
        change the limit.
      </p>
      <p class="money-limit-popup__text money-limit-popup__spent">{{ spentText }}</p>
    </div>
  </div>
</template>

<style scoped>
/* The grid item of the bottom bar, and the place of the popup. Its column
   can get narrower than the label (`AppLayout.vue`), so it can too. */
.usage-area {
  position: relative;
  display: flex;
  min-width: 0;
  max-width: 100%;
}

/* The size and the cost of the active tab's conversation, in the middle of
   the bottom bar (`AppLayout.vue`): the token count, a dot, the cost, the
   money limit (a coin, and the limit when the tab has one), and, while
   the reply waits for a compaction of the conversation, a dot and
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
   ever shows cut: first "Compacting…" goes, then the money limit, then
   the cost, each with its dot, then the token count. A flex line keeps
   its first item also when that does not fit, so this empty first item
   takes that place, and the token count can go. It is as high as the
   label: a first line of no height would show the second one. */
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

/* A control, so it keeps its look while the model works. With no limit,
   only the coin, as dim as the Help button of the bar. */
.money-limit-button {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 16px;
  padding: 0 2px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  opacity: 0.4;
  cursor: pointer;
  transition: opacity 0.15s;
}

.money-limit-button:not(:first-child) {
  margin-left: 6px;
}

.money-limit-button--set {
  opacity: 0.65;
}

.money-limit-button:hover,
.money-limit-button[aria-expanded='true'] {
  opacity: 0.9;
}

/* Over the middle of the label, with the look of the provider settings
   popup (ProviderSettingsPopup.vue). The label is in the middle of the
   bar, so the margin puts the popup over the top edge of the bar. */
.money-limit-popup {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: 270px;
  margin-bottom: 10px;
  padding-bottom: 6px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.2);
  color: var(--color-text);
  font-size: 13px;
  z-index: 50;
}

.money-limit-popup__header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.5;
  padding: 8px 12px 4px;
}

.money-limit-popup__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 12px;
}

.money-limit-popup__check {
  justify-content: flex-start;
}

.money-limit-popup__check input {
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.money-limit-popup__row--off {
  opacity: 0.5;
}

.money-limit-popup__row--off input {
  cursor: default;
}

.money-limit-popup__field {
  width: 110px;
  box-sizing: border-box;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background-color: var(--color-bg);
  color: var(--color-text);
  color-scheme: dark light;
  font-size: 13px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  outline: none;
}

.money-limit-popup__field:focus {
  border-color: var(--color-text);
}

.money-limit-popup__text {
  margin: 0;
  padding: 4px 12px;
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.7;
}

.money-limit-popup__problem {
  color: var(--color-error);
  opacity: 1;
}
</style>
