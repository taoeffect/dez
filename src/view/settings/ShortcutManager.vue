<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { SHORTCUT_GROUPS, currentShortcutPlatform, eventShortcutKey, shortcutLabel, type ShortcutId } from '../../model/shortcuts'

const { shortcuts } = useModelState()

const groups = computed(() => SHORTCUT_GROUPS
  .map((name) => ({ name, shortcuts: shortcuts.value.filter((shortcut) => shortcut.group === name) }))
  .filter((group) => group.shortcuts.length > 0))

const anyChanged = computed(() => shortcuts.value.some((shortcut) => shortcut.key !== shortcut.defaultKey))

// The row that records a key, and why the last key or reset was refused.
const recordingId = ref<ShortcutId | null>(null)
const refusal = ref<{ id: ShortcutId, text: string } | null>(null)

function keycap (key: string): string {
  return shortcutLabel(key, currentShortcutPlatform)
}

function keyText (key: string): string {
  return shortcutLabel(key, currentShortcutPlatform, 'text')
}

// While a row records, this listener gets each keydown first: the window
// capture phase runs before ModelSelector's document capture Esc handler,
// CodeMirror, and the window shortcut handler, and it stops the event, so
// none of them acts on the key (and the menu accelerators are off, see
// `dez.controller/menu/suspendAccelerators`). A modifier alone waits for the
// next key. Bare Esc cancels, so the only way back to Esc for Stop is its
// reset button.
function onRecordKeydown (event: KeyboardEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
  const id = recordingId.value
  const key = eventShortcutKey(event)
  if (!id || key === null) return
  if (key !== 'Escape') {
    const text = sbp('dez.model/settings/setShortcut', id, key) as string | null
    refusal.value = text ? { id, text } : null
  }
  stopRecording()
}

// A press anywhere but the recording key button cancels. A press on that
// button is the start of a click, which cancels in `onKeyClick`.
function onRecordMousedown (event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('.shortcut-key--recording')) return
  stopRecording()
}

function startRecording (id: ShortcutId): void {
  refusal.value = null
  if (recordingId.value === null) {
    window.addEventListener('keydown', onRecordKeydown, true)
    document.addEventListener('mousedown', onRecordMousedown, true)
    // Leaving the window cancels, so the menu keys never stay off.
    window.addEventListener('blur', stopRecording)
    void sbp('dez.controller/menu/suspendAccelerators', true)
  }
  recordingId.value = id
}

function stopRecording (): void {
  if (recordingId.value === null) return
  recordingId.value = null
  window.removeEventListener('keydown', onRecordKeydown, true)
  document.removeEventListener('mousedown', onRecordMousedown, true)
  window.removeEventListener('blur', stopRecording)
  void sbp('dez.controller/menu/suspendAccelerators', false)
}

function onKeyClick (id: ShortcutId): void {
  if (recordingId.value === id) stopRecording()
  else startRecording(id)
}

function reset (id: ShortcutId): void {
  stopRecording()
  const text = sbp('dez.model/settings/setShortcut', id, null) as string | null
  refusal.value = text ? { id, text } : null
}

function resetAll (): void {
  stopRecording()
  refusal.value = null
  sbp('dez.model/settings/resetShortcuts')
}

onUnmounted(stopRecording)
</script>

<template>
  <div class="shortcut-manager">
    <p class="shortcut-hint">Click a shortcut, then press the new keys. Esc cancels.</p>
    <section v-for="group in groups" :key="group.name" class="shortcut-group">
      <h3 class="shortcut-group-title">{{ group.name }}</h3>
      <ul class="shortcut-list">
        <li
          v-for="shortcut in group.shortcuts"
          :key="shortcut.id"
          class="shortcut-row"
          :data-shortcut-id="shortcut.id"
        >
          <span class="shortcut-label">{{ shortcut.label }}</span>
          <!-- The default aliases work while the action has its default key,
               so a "Used by Redo" refusal of Ctrl+Y needs this note. -->
          <span v-if="shortcut.keys.length > 1" class="shortcut-aliases">also {{ shortcut.keys.slice(1).map(keycap).join(', ') }}</span>
          <button
            class="shortcut-key"
            :class="{ 'shortcut-key--recording': recordingId === shortcut.id }"
            :aria-label="recordingId === shortcut.id
              ? `${shortcut.label}: press the new keys, Esc cancels`
              : `${shortcut.label}: ${keyText(shortcut.key)}, click to change`"
            @click="onKeyClick(shortcut.id)"
          >
            {{ recordingId === shortcut.id ? 'Press keys…' : keycap(shortcut.key) }}
          </button>
          <button
            class="settings-btn settings-btn--sm shortcut-reset"
            :disabled="shortcut.key === shortcut.defaultKey"
            :title="`Reset to ${keyText(shortcut.defaultKey)}`"
            :aria-label="`Reset ${shortcut.label} to ${keyText(shortcut.defaultKey)}`"
            @click="reset(shortcut.id)"
          >
            Reset
          </button>
          <p v-if="refusal?.id === shortcut.id" class="settings-error shortcut-error" role="alert">{{ refusal.text }}</p>
        </li>
      </ul>
    </section>
    <div class="settings-row settings-row--end">
      <button class="settings-btn settings-btn--sm shortcut-reset-all" :disabled="!anyChanged" @click="resetAll">
        Reset All Shortcuts
      </button>
    </div>
  </div>
</template>

<style scoped>
.shortcut-manager {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.shortcut-hint {
  font-size: 12px;
  color: var(--color-muted);
}

.shortcut-group-title {
  margin-bottom: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
}

.shortcut-list {
  list-style: none;
}

.shortcut-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
}

.shortcut-row:last-child {
  border-bottom: none;
}

.shortcut-label {
  flex: 1;
  min-width: 0;
}

.shortcut-aliases {
  font-size: 12px;
  color: var(--color-muted);
}

/* A fixed width, so the keys of all rows line up. */
.shortcut-key {
  min-width: 128px;
  padding: 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.shortcut-key:hover {
  border-color: var(--color-text);
}

.shortcut-key--recording,
.shortcut-key--recording:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.shortcut-error {
  flex-basis: 100%;
  text-align: right;
}
</style>
