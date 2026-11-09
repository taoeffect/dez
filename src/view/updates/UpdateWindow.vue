<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'

const { updates } = useModelState()

const appVersion = __APP_VERSION__
const releases = computed(() => updates.value.releases)
// The window is open only while the store has a newer release: it opens
// only with one (`dez.model/updates/openWindow`), and a check that finds
// none closes it.
const newest = computed(() => releases.value[0])

const dialog = ref<HTMLElement | null>(null)

// The element that had the focus before the window opened, as in
// ConfirmDialog.vue. The dialog takes the focus, so keys never go to the
// editor behind the overlay, and the focus goes back when it closes.
let opener: Element | null = null

// Whether the last press started on the overlay itself. A drag that starts
// in the window (a text selection) and ends outside it also gives the
// overlay a click; only a press that started outside closes it.
let pressOnOverlay = false

onMounted(() => {
  opener = document.activeElement
  dialog.value?.focus({ preventScroll: true })
})

onBeforeUnmount(() => {
  const element = opener
  opener = null
  if (!(element instanceof HTMLElement) || !element.isConnected) return
  // `dez.editor/focus` puts back the editor's scroll, which WebKit can move
  // when the editor gets the focus again (focus.ts).
  if (element.closest('.cm-editor')) sbp('dez.editor/focus')
  else element.focus({ preventScroll: true })
})

function close() {
  sbp('dez.model/updates/closeWindow')
}

function openRelease(url: string) {
  sbp('dez.controller/openUrl', url)
}

function viewOnGitHub() {
  openRelease(newest.value.url)
  close()
}

// GitHub's `published_at`, as a date in the user's locale.
function formatDate(publishedAt: string | null): string | null {
  if (!publishedAt) return null
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function onOverlayMouseDown(event: MouseEvent) {
  pressOnOverlay = event.target === event.currentTarget
}

// Esc is not here: only the window handler closes modals on Esc
// (`closeOnEscape` in useKeyboardShortcuts.ts).
function onOverlayClick(event: MouseEvent) {
  if (pressOnOverlay && event.target === event.currentTarget) close()
  pressOnOverlay = false
}
</script>

<template>
  <div class="update-overlay" @mousedown="onOverlayMouseDown" @click="onOverlayClick">
    <div
      ref="dialog"
      class="update-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      tabindex="-1"
    >
      <div class="update-header">
        <div>
          <h2 id="update-title">Dez {{ newest.version }} is available</h2>
          <p>You have Dez {{ appVersion }}.</p>
        </div>
        <button class="update-close" title="Close (Esc)" @click="close">×</button>
      </div>

      <!-- Text bindings only: the change notes come from GitHub, so they are
           never rendered as HTML. -->
      <div class="update-releases">
        <section v-for="release in releases" :key="release.tag" class="update-release">
          <div class="update-release-head">
            <h3>Dez {{ release.version }}</h3>
            <span v-if="formatDate(release.publishedAt)" class="update-release-date">
              {{ formatDate(release.publishedAt) }}
            </span>
            <button class="update-release-link" @click="openRelease(release.url)">Release page</button>
          </div>
          <p v-if="!release.changes.length" class="update-release-empty">No change notes.</p>
          <template v-for="(block, index) in release.changes" :key="index">
            <h4 v-if="block.kind === 'label'" class="update-change-label">{{ block.text }}</h4>
            <ul v-else-if="block.kind === 'list'" class="update-change-list">
              <li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li>
            </ul>
            <p v-else class="update-change-paragraph">{{ block.text }}</p>
          </template>
        </section>
      </div>

      <div class="update-footer">
        <button class="update-btn" @click="close">Later</button>
        <button class="update-btn update-btn--primary" @click="viewOnGitHub">View on GitHub</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Above Settings (100), which has the button that opens it, and History
   (90); below the confirm prompt (110) and the toasts (120). */
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 105;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.update-modal {
  width: min(640px, calc(100vw - 48px));
  max-height: min(720px, calc(100vh - 48px));
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  outline: none;
}

.update-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.update-header h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.update-header p {
  font-size: 12px;
  opacity: 0.55;
  margin: 2px 0 0;
}

.update-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.update-close:hover {
  opacity: 1;
}

.update-releases {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 20px 16px;
}

.update-release {
  padding-top: 14px;
}

.update-release + .update-release {
  margin-top: 14px;
  border-top: 1px solid var(--color-border);
}

.update-release-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.update-release-head h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.update-release-date {
  font-size: 12px;
  opacity: 0.55;
}

.update-release-link {
  margin-left: auto;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-link);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.update-release-link:hover {
  text-decoration: underline;
}

.update-release-empty,
.update-change-paragraph {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.45;
}

.update-release-empty {
  opacity: 0.55;
}

.update-change-label {
  margin: 12px 0 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.6;
}

.update-change-list {
  margin: 6px 0 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.45;
}

.update-change-list li + li {
  margin-top: 3px;
}

.update-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
}

.update-btn {
  min-width: 72px;
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}

.update-btn:hover {
  background: var(--color-border);
}

/* The main action: the text and background colors swapped, as on the
   confirm prompt's default button. */
.update-btn--primary {
  border-color: var(--color-text);
  background: var(--color-text);
  color: var(--color-bg);
  font-weight: 500;
}

.update-btn--primary:hover {
  background: var(--color-text);
  opacity: 0.85;
}

.update-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
</style>
