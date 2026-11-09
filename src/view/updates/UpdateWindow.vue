<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { keepTabInModal, restoreFocus, useOverlayDismiss } from '../composables/modal'
import { isMacPlatform } from '../../utils/platform'

const { updates } = useModelState()

const appVersion = __APP_VERSION__
const releases = computed(() => updates.value.releases)
// The window is open only while the store has a newer release: it opens
// only with one (`dez.model/updates/openWindow`), and a check that finds
// none closes it.
const newest = computed(() => releases.value[0])

const install = computed(() => updates.value.install)
// While the install runs, the window has no buttons and cannot close
// (`dez.model/updates/closeWindow` refuses).
const busy = computed(() => updates.value.installBusy)
// Only macOS installs updates; elsewhere the store has no reason, and the
// window just offers the release page.
const hasSignedDmg = computed(() => Boolean(newest.value.dmgAsset && newest.value.signatureAsset))
const canInstall = computed(() => isMacPlatform && !updates.value.installBlockedReason && hasSignedDmg.value)
// Why a macOS Dez offers the release page instead of the install.
const installUnavailableNote = computed(() => {
  if (!isMacPlatform || canInstall.value) return null
  return updates.value.installBlockedReason ??
    `Dez ${newest.value.version} has no signed macOS download, so Dez cannot install it by itself.`
})

// The install button, or "Try Again" after a failure that a new download
// can fix. Once the install ran, Rust refuses a new download until Dez
// restarts, and the failure's message says what to do instead.
const showInstallButton = computed(() => {
  const state = install.value
  return canInstall.value && (state.phase !== 'failed' || state.retry)
})

// The step that runs, as "Downloading… 4.2 of 9.5 MB".
const progressText = computed(() => {
  const state = install.value
  if (state.phase === 'downloading') {
    if (state.total) return `Downloading… ${megabytes(state.received)} of ${megabytes(state.total)} MB`
    return state.received ? `Downloading… ${megabytes(state.received)} MB` : 'Downloading…'
  }
  if (state.phase === 'installing') return 'Installing…'
  if (state.phase === 'relaunching') return 'Restarting…'
  return null
})
// The share of the download that arrived, or null with no known length.
const downloadFraction = computed(() => {
  const state = install.value
  return state.phase === 'downloading' && state.total ? Math.min(1, state.received / state.total) : null
})

const dialog = ref<HTMLElement | null>(null)

// The element that had the focus before the window opened. The dialog takes
// the focus, and Tab keeps it in the window (`keepTabInModal`), so keys
// never go to the editor behind the overlay. The focus goes back when the
// window closes (`restoreFocus`).
let opener: Element | null = null

onMounted(() => {
  opener = document.activeElement
  dialog.value?.focus({ preventScroll: true })
})

onBeforeUnmount(() => restoreFocus(opener))

// The clicked button goes away while the install runs. The focus moves to
// the dialog first, so it stays in the window and keys never reach the
// editor behind it: a reply started there during the download would stop
// with no prompt once the install is done.
watch(busy, (isBusy) => {
  if (isBusy) dialog.value?.focus({ preventScroll: true })
})

// Decimal megabytes with one decimal, as Finder shows file sizes.
function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

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

function installUpdate() {
  void sbp('dez.controller/updates/install')
}

// GitHub's `published_at`, as a date in the user's locale.
function formatDate(publishedAt: string | null): string | null {
  if (!publishedAt) return null
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

// A click on the overlay closes the window, unless the press started in it.
// Esc is not here: only the window handler closes modals on Esc
// (`closeOnEscape` in useKeyboardShortcuts.ts).
const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(close)
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
      @keydown="keepTabInModal"
    >
      <div class="update-header">
        <div>
          <h2 id="update-title">Dez {{ newest.version }} is available</h2>
          <p>You have Dez {{ appVersion }}.</p>
        </div>
        <button v-if="!busy" class="update-close" title="Close (Esc)" @click="close">×</button>
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
        <div v-if="busy" class="update-progress" role="status">
          <span>{{ progressText }}</span>
          <div v-if="downloadFraction !== null" class="update-progress-track">
            <div class="update-progress-fill" :style="{ width: `${downloadFraction * 100}%` }" />
          </div>
        </div>
        <p v-else-if="install.phase === 'failed'" class="update-note update-note--error" role="alert">
          {{ install.error }}
        </p>
        <p v-else-if="installUnavailableNote" class="update-note">{{ installUnavailableNote }}</p>
        <div v-if="!busy" class="update-buttons">
          <button class="update-btn" @click="close">Later</button>
          <!-- After a failure, the release page is the way out besides a retry. -->
          <button
            v-if="!canInstall || install.phase === 'failed'"
            class="update-btn"
            :class="{ 'update-btn--primary': !showInstallButton }"
            @click="viewOnGitHub"
          >
            View on GitHub
          </button>
          <button v-if="showInstallButton" class="update-btn update-btn--primary" @click="installUpdate">
            {{ install.phase === 'failed' ? 'Try Again' : 'Download and Install' }}
          </button>
        </div>
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

/* The note or progress on the left, the buttons on the right. */
.update-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
}

.update-buttons {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  margin-left: auto;
}

.update-note {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-muted);
  /* An error can hold a path or a long word. */
  overflow-wrap: anywhere;
}

.update-note--error {
  color: var(--color-error);
}

/* The footer keeps its height while the buttons are gone. */
.update-progress {
  flex: 1;
  min-width: 0;
  min-height: 30px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
}

.update-progress-track {
  height: 4px;
  border-radius: 2px;
  background: var(--color-border);
  overflow: hidden;
}

.update-progress-fill {
  height: 100%;
  background: var(--color-accent);
  transition: width 0.2s;
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
