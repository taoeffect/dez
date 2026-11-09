<script setup lang="ts">
import { ref, watch } from 'vue'
import { keepTabInModal, restoreFocus, useOverlayDismiss } from '../composables/modal'
import { answerConfirm, confirmRequest } from './selectors'

const confirmButton = ref<HTMLButtonElement | null>(null)

// The element that had the focus before the prompt opened. It gets the
// focus back when the prompt closes (`restoreFocus`).
let opener: Element | null = null

// A click on the overlay cancels, unless the press started in the dialog.
const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(() => answerConfirm(false))

// `post`: the dialog is in the DOM when this runs, so its button can take
// the focus. A prompt that takes the place of an open one keeps the first
// opener.
watch(confirmRequest, (request, previous) => {
  if (request) {
    if (!previous) opener = document.activeElement
    confirmButton.value?.focus()
  } else {
    restoreFocus(opener)
    opener = null
  }
}, { flush: 'post' })

// Esc is not here: only the window handler closes modals on Esc
// (`closeOnEscape` in useKeyboardShortcuts.ts).
//
// Enter on a button clicks that button. Enter anywhere else in the dialog
// (after a click on its text) picks the default button. Tab and Shift+Tab
// move only between the two buttons (`keepTabInModal`).
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault()
    answerConfirm(true)
  } else {
    keepTabInModal(event)
  }
}
</script>

<template>
  <div v-if="confirmRequest" class="confirm-overlay" @mousedown="onOverlayMouseDown" @click="onOverlayClick">
    <div
      class="confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-describedby="confirm-message"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <p id="confirm-message" class="confirm-message">{{ confirmRequest.message }}</p>
      <div class="confirm-actions">
        <button class="confirm-btn confirm-btn--cancel" @click="answerConfirm(false)">
          {{ confirmRequest.cancelLabel }}
        </button>
        <button ref="confirmButton" class="confirm-btn confirm-btn--confirm" @click="answerConfirm(true)">
          {{ confirmRequest.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Above Settings (100) and History (90), below the toasts (120). */
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.confirm-dialog {
  width: min(400px, calc(100vw - 48px));
  padding: 20px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
  outline: none;
}

.confirm-message {
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.confirm-btn {
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

.confirm-btn--cancel:hover {
  background: var(--color-border);
}

/* The default button: the text and background colors swapped, which reads
   well in both themes. */
.confirm-btn--confirm {
  border-color: var(--color-text);
  background: var(--color-text);
  color: var(--color-bg);
  font-weight: 500;
}

.confirm-btn--confirm:hover {
  opacity: 0.85;
}

.confirm-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
</style>
