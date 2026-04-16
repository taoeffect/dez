<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { useChatStore } from '../stores/chatStore'

const store = useChatStore()
const input = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)

function resize() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

async function send() {
  const text = input.value.trim()
  if (!text) return
  store.addMessage('user', text)
  input.value = ''
  await nextTick()
  resize()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="chat-input-wrapper">
    <div class="chat-input">
      <textarea
        ref="textarea"
        v-model="input"
        @input="resize"
        @keydown="onKeydown"
        placeholder="Send a message…"
        rows="1"
      />
      <button class="send-btn" @click="send" :disabled="!input.trim()">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3 13V9l10-1-10-1V3l14 5-14 5z" fill="currentColor"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-input-wrapper {
  flex-shrink: 0;
  padding: 8px 16px 16px;
  background-color: var(--color-bg);
  border-top: 1px solid var(--color-border);
}

.chat-input {
  max-width: 768px;
  margin: 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background-color: var(--color-tab-bar);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 8px 12px;
}

textarea {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.5;
  resize: none;
  max-height: 200px;
  overflow-y: auto;
}

textarea::placeholder {
  color: var(--color-text);
  opacity: 0.4;
}

.send-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  opacity: 0.5;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
}

.send-btn:hover:not(:disabled) {
  opacity: 1;
}

.send-btn:disabled {
  opacity: 0.2;
  cursor: default;
}
</style>
