<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import { keepTabInModal, restoreFocus } from '../composables/modal'
import { refusalReport, type UpdateRefusal } from '../../model/updates/refusal'

// The warning that opens when Dez refuses an update: the release failed one
// of the four checks that show that the developer made it, so it may be
// compromised. It names the failed check and asks the user to tell the
// developer. It offers no retry and no manual download: both would give the
// user the files that failed.
//
// It is open while the store holds a refusal (AppLayout.vue), over the
// update window, which closes with it (`dez.model/updates/closeRefusal`).
const props = defineProps<{ refusal: UpdateRefusal }>()

const appVersion = __APP_VERSION__
// What the user sends to the developer; the dialog shows it as it is, so
// the user sees what leaves the computer.
const report = computed(() => refusalReport(props.refusal, appVersion))

const dialog = ref<HTMLElement | null>(null)
// "Copy Report" says "Copied" after a copy that worked.
const copied = ref(false)

// The element that had the focus before the dialog opened: the update
// window. The dialog takes the focus, and Tab keeps it there
// (`keepTabInModal`). When the dialog closes, the window closes in the same
// step, first, and gives the focus back to its own opener; the dialog's
// opener is then gone, and `restoreFocus` does nothing.
let opener: Element | null = null

onMounted(() => {
  opener = document.activeElement
  dialog.value?.focus({ preventScroll: true })
})

onBeforeUnmount(() => {
  restoreFocus(opener)
  // The focus is still in the dialog when nothing took it back: the update
  // window closed under the dialog (a notification click), or the window's
  // own opener is gone (a toast's button). It would then be on nothing once
  // the dialog is gone, and keys would go nowhere, so the editor takes it
  // (unless Settings or History is open: `dez.editor/focus` refuses then).
  if (dialog.value?.contains(document.activeElement)) sbp('dez.editor/focus')
})

// Esc is not here: only the window handler closes modals on Esc
// (`closeOnEscape` in useKeyboardShortcuts.ts).
function close() {
  sbp('dez.model/updates/closeRefusal')
}

// For a report through another channel than GitHub.
async function copyReport() {
  try {
    await sbp('dez.ui/copyText', report.value)
    copied.value = true
  } catch (error) {
    console.error('Could not copy the report of the refused update', error)
    sbp('dez.ui/toast', 'app-global', {
      title: 'Report not copied',
      message: 'Dez could not copy the report. Select its text in the dialog and copy it.',
      variant: 'error',
    })
  }
}

function reportOnGitHub() {
  sbp('dez.controller/updates/reportRefusal')
}
</script>

<template>
  <!-- A click on the overlay does not close the dialog, unlike the other
       modals: a stray click would lose a security warning and its report.
       Only "Close" and Esc close it.

       `mousedown.self.prevent`: a press on the overlay would take the focus
       out of the dialog, and Tab could then reach the editor behind it
       (`keepTabInModal` only sees keys in the dialog). A press in the dialog
       keeps its default, so its text can be selected. -->
  <div class="refusal-overlay" @mousedown.self.prevent>
    <div
      ref="dialog"
      class="refusal-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="refusal-title"
      aria-describedby="refusal-message"
      tabindex="-1"
      @keydown="keepTabInModal"
    >
      <h2 id="refusal-title" class="refusal-title">Dez refused this update</h2>
      <p id="refusal-message" class="refusal-text">
        Dez {{ refusal.version }} failed a check that shows that the developer of Dez made it, so this release
        may be compromised. Dez installed nothing, and this is still Dez {{ appVersion }}.
      </p>
      <p class="refusal-text">
        Please report this to the developer with the text below, and do not install this release by hand.
      </p>
      <!-- A text binding: the last line comes from Rust and can hold text
           of the release's manifest, so it is never rendered as HTML. -->
      <p class="refusal-report">{{ report }}</p>
      <div class="refusal-actions">
        <button class="refusal-btn" @click="close">Close</button>
        <button class="refusal-btn" @click="copyReport">{{ copied ? 'Copied' : 'Copy Report' }}</button>
        <button class="refusal-btn refusal-btn--primary" @click="reportOnGitHub">Report on GitHub</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Above the update window (105), which stays open under the dialog; below
   the confirm prompt (110) and the toasts (120). */
.refusal-overlay {
  position: fixed;
  inset: 0;
  z-index: 107;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.refusal-dialog {
  width: min(480px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 20px;
  background: var(--color-bg);
  border: 1px solid var(--color-error-border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
  outline: none;
}

.refusal-title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-error);
}

.refusal-text {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 20px;
}

/* The report: its three lines as they are, in the tint of an error toast.
   The text can be selected, for a copy by hand. */
.refusal-report {
  margin: 0;
  padding: 10px 12px;
  background: var(--color-error-bg);
  border: 1px solid var(--color-error-border);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  /* A SHA-256 is one long word. */
  overflow-wrap: anywhere;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}

.refusal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.refusal-btn {
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

.refusal-btn:hover {
  background: var(--color-border);
}

/* The main action: the text and background colors swapped, as on the
   confirm prompt's default button. */
.refusal-btn--primary {
  border-color: var(--color-text);
  background: var(--color-text);
  color: var(--color-bg);
  font-weight: 500;
}

.refusal-btn--primary:hover {
  background: var(--color-text);
  opacity: 0.85;
}

.refusal-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
</style>
