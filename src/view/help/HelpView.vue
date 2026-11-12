<script setup lang="ts">
import { computed, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { shortcutKeyText } from '../../model/shortcuts'
import { DEZ_DISCUSSIONS_URL } from '../../utils/dezLinks'

type HelpPage = 'general' | 'tips' | 'support'

const PAGES: { id: HelpPage; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'tips', label: 'Tips' },
  { id: 'support', label: 'Support' },
]

const { shortcuts } = useModelState()

// A local ref, not a store field: the panel opens on General each time.
const page = ref<HelpPage>('general')

// The keys that the text names, as they are now, so that the text follows
// a change in Settings › Shortcuts.
const keys = computed(() => ({
  submit: shortcutKeyText(shortcuts.value, 'submit'),
  stop: shortcutKeyText(shortcuts.value, 'stop'),
  newMessage: shortcutKeyText(shortcuts.value, 'newMessage'),
  settings: shortcutKeyText(shortcuts.value, 'settings'),
  history: shortcutKeyText(shortcuts.value, 'history'),
}))

function onClose() {
  sbp('dez.model/settings/helpClose')
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('help-overlay')) {
    onClose()
  }
}
</script>

<template>
  <div class="help-overlay" @click="onOverlayClick">
    <div class="help-modal">
      <div class="help-header">
        <h2>Dez Help</h2>
        <button class="help-close" title="Close (Esc)" @click="onClose">×</button>
      </div>

      <div class="help-body">
        <nav class="help-nav">
          <button
            v-for="p in PAGES"
            :key="p.id"
            class="help-nav-btn"
            :class="{ 'help-nav-btn--active': page === p.id }"
            @click="page = p.id"
          >
            {{ p.label }}
          </button>
        </nav>

        <div class="help-content">
          <section v-if="page === 'general'" class="help-page help-page--general">
            <p>
              Each tab is one conversation, written as one text document. Write your message, then
              press <kbd>{{ keys.submit }}</kbd> or click Submit: Dez sends the conversation to the
              model, and the reply comes in below your message. <kbd>{{ keys.stop }}</kbd> stops a
              reply, and <kbd>{{ keys.newMessage }}</kbd> starts a new message. You can edit all of
              the text, the replies too, before you send it again.
            </p>
            <p>
              The model picker at the lower left sets the model of the tab, and the gear next to it
              shows the settings of that model. Add your API keys and your own providers in Settings ›
              Providers (<kbd>{{ keys.settings }}</kbd>). Models can use Dez tools, for example to
              find other models. Dez saves each conversation: History (<kbd>{{ keys.history }}</kbd>)
              opens it again.
            </p>
            <p>
              Paste or drop images, audio, and video into a message. Each one gets an id
              (<code>a</code>, <code>b</code>, …), which shows when you point at it: write
              <code>@a</code> in a message to name it. Dez keeps a copy of a pasted file. A dropped
              file stays where it is, and the message links to it, so do not move or delete it; Dez
              keeps a copy only of a file from a temp folder. A model that makes images, audio, or
              video puts them in its reply. Type <code>/prompt</code> to insert a saved prompt
              (Settings › Prompts).
            </p>
          </section>

          <section v-if="page === 'tips'" class="help-page help-page--tips">
            <p>
              Shift+Click a role pill (User or Agent) to change its message from User to Agent, or
              from Agent to User: for example, to write a reply yourself. The first message is always
              User, and the pill of a reply that is coming in does not change.
            </p>
          </section>

          <section v-if="page === 'support'" class="help-page help-page--support">
            <p>Ask questions, share ideas, and report problems in the Dez discussions on GitHub:</p>
            <p>
              <!-- A button, not an <a href>: a link would load the page in
                   the app window. The system browser opens it. -->
              <button type="button" class="help-link" @click="sbp('dez.controller/openUrl', DEZ_DISCUSSIONS_URL)">
                {{ DEZ_DISCUSSIONS_URL }}
              </button>
            </p>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The overlay, modal, header, and nav of SettingsView.vue, in a smaller
   modal: the pages are short. One size for every page, so the modal does
   not move when the user switches pages. */
.help-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.help-modal {
  width: min(720px, calc(100vw - 48px));
  height: min(80vh, 440px);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

.help-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.help-header h2 {
  font-size: 15px;
  font-weight: 600;
}

.help-close {
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

.help-close:hover {
  opacity: 1;
}

.help-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.help-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  width: 140px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
}

.help-nav-btn {
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}

.help-nav-btn:hover {
  opacity: 0.9;
  background: var(--color-border);
}

.help-nav-btn--active {
  opacity: 1;
  background: var(--color-border);
  font-weight: 500;
}

/* A stable gutter, as `.settings-scroller` has: a classic scrollbar that
   comes or goes then never changes the width of the text. */
.help-content {
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 16px 20px;
  min-height: 0;
}

.help-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
  line-height: 1.6;
  user-select: text;
  -webkit-user-select: text;
}

.help-page kbd,
.help-page code {
  padding: 1px 5px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  white-space: nowrap;
}

.help-page code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

.help-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-link);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.help-link:hover {
  text-decoration: underline;
}
</style>
