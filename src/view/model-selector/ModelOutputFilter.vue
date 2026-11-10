<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { MODEL_OUTPUTS, toggleOutputFilter, type ModelOutput } from '../../model/modelOutputs'

// The output filter of the model picker: a funnel button at the right of
// the search field, and its dropdown with an "All" radio, a separator, and
// one checkbox per output type. `modelValue` is the filter (empty: All); the
// picker saves each change.
const props = defineProps<{
  modelValue: readonly ModelOutput[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: ModelOutput[]): void
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)
const dropdown = ref<HTMLElement | null>(null)
const dropdownId = useId()

const title = computed(() => {
  const labels = MODEL_OUTPUTS.filter((output) => props.modelValue.includes(output.id)).map((output) => output.label)
  return labels.length > 0 ? `Filter by output: ${labels.join(', ')}` : 'Filter by output'
})

// A mouse click keeps the focus where it is (the search field, `mousedown`
// is prevented), so the user can type on. Enter or Space on the button
// gives a click with `detail` 0; then the focus moves into the dropdown, as
// it does for any dialog that the keyboard opens.
function toggle(e: MouseEvent) {
  if (open.value) {
    close()
    return
  }
  open.value = true
  window.addEventListener('keydown', onWindowKeydown, true)
  document.addEventListener('mousedown', onDocumentMousedown, true)
  if (e.detail === 0) void nextTick(() => dropdown.value?.querySelector('input')?.focus())
}

// Gives the focus back to the button when it was in the dropdown, which
// the close removes.
function close() {
  if (!open.value) return
  const hadFocus = dropdown.value?.contains(document.activeElement) ?? false
  open.value = false
  window.removeEventListener('keydown', onWindowKeydown, true)
  document.removeEventListener('mousedown', onDocumentMousedown, true)
  if (hadFocus) button.value?.focus()
}

// While the dropdown is open, this listener gets each keydown first: the
// window capture phase runs before ModelSelector's document capture Esc
// handler, the search field's Esc handler, and the window shortcut handler
// (which closes Settings on Esc). It stops Esc, so Esc closes only the
// dropdown, not the picker or Settings.
function onWindowKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.preventDefault()
  e.stopImmediatePropagation()
  close()
}

function onDocumentMousedown(e: MouseEvent) {
  if (!root.value?.contains(e.target as Node)) close()
}

// Tab out of the dropdown (to the model list) closes it. A focus loss with
// no new focused element (the window loses the focus) does not.
function onFocusout(e: FocusEvent) {
  const next = e.relatedTarget
  if (next instanceof Node && !root.value?.contains(next)) close()
}

function toggleOutput(output: ModelOutput) {
  emit('update:modelValue', toggleOutputFilter(props.modelValue, output))
}

// A click on an option's text must not move the focus into the dropdown,
// so the user can type on in the search field. WebKitGTK focuses a
// checkbox when its label is clicked (macOS WebKit does not), so this
// stops the label's own action and clicks the input, which toggles it
// with no focus change. A click on the input itself is left as it is: the
// prevented mousedown already keeps the focus.
function onOptionClick(e: MouseEvent) {
  if (e.target instanceof HTMLInputElement) return
  e.preventDefault()
  const input = (e.currentTarget as HTMLLabelElement).control
  input?.click()
}

onBeforeUnmount(close)
</script>

<template>
  <div ref="root" class="output-filter" @focusout="onFocusout">
    <button
      ref="button"
      type="button"
      class="output-filter-btn"
      :class="{ 'output-filter-btn--active': modelValue.length > 0, 'output-filter-btn--open': open }"
      :title="title"
      aria-label="Filter by output"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="open ? dropdownId : undefined"
      @mousedown.prevent
      @click="toggle"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="M2 3h10L8.2 7.6v3.6L5.8 12.4V7.6L2 3z"
          :fill="modelValue.length > 0 ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <div
      v-if="open"
      :id="dropdownId"
      ref="dropdown"
      class="output-filter-dropdown"
      role="dialog"
      aria-label="Filter by output"
      @mousedown.prevent
    >
      <label class="output-filter-option" @click="onOptionClick">
        <input
          type="radio"
          :name="dropdownId"
          :checked="modelValue.length === 0"
          @change="emit('update:modelValue', [])"
        />
        <span>All</span>
      </label>
      <div class="output-filter-separator" role="separator"></div>
      <label v-for="output in MODEL_OUTPUTS" :key="output.id" class="output-filter-option" @click="onOptionClick">
        <input
          type="checkbox"
          :value="output.id"
          :checked="modelValue.includes(output.id)"
          @change="toggleOutput(output.id)"
        />
        <span>{{ output.label }}</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.output-filter {
  position: relative;
  display: flex;
  align-self: stretch;
  flex-shrink: 0;
}

/* As tall as the search field, with the same border and corners. */
.output-filter-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}

.output-filter-btn:hover,
.output-filter-btn--open {
  opacity: 1;
}

.output-filter-btn--open {
  border-color: var(--color-text);
}

/* A filter other than "All" is on: accent color and a filled funnel. */
.output-filter-btn--active {
  color: var(--color-accent);
  border-color: var(--color-accent);
  opacity: 1;
}

.output-filter-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 10;
  min-width: 132px;
  margin-top: 4px;
  padding: 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
}

/* Fixed row and box sizes: the picker's min-height (ModelPicker.vue) must
   fit the whole dropdown. */
.output-filter-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  color: var(--color-text);
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
}

.output-filter-option:hover {
  background: var(--color-border);
}

/* The boxes are drawn here, not by the platform: the app sets no
   `color-scheme`, so WebKitGTK draws native boxes white in the dark theme
   (an unchecked radio then looks like a checked one), and the native sizes
   differ between WebKitGTK and macOS WebKit. */
.output-filter-option input {
  appearance: none;
  -webkit-appearance: none;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  margin: 0;
  border: 1px solid var(--color-muted);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
}

.output-filter-option input[type="radio"] {
  border-radius: 50%;
}

.output-filter-option input:checked {
  border-color: var(--color-accent);
  background-color: var(--color-accent);
}

.output-filter-option input[type="checkbox"]:checked {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M2 5.2l2 2 4-4.4' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: center;
  background-repeat: no-repeat;
  background-size: 10px;
}

.output-filter-option input[type="radio"]:checked {
  background-image: radial-gradient(circle, white 0 2.5px, transparent 3px);
}

.output-filter-option input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.output-filter-separator {
  height: 1px;
  margin: 4px 0;
  background: var(--color-border);
}
</style>
