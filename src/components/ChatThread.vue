<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { useChatStore } from '../stores/chatStore'
import ChatMessage from './ChatMessage.vue'

const store = useChatStore()

const scrollContainer = ref<HTMLElement | null>(null)
const isUserScrolledUp = ref(false)

function isNearBottom(): boolean {
  const el = scrollContainer.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

function scrollToBottom() {
  const el = scrollContainer.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

function onScroll() {
  isUserScrolledUp.value = !isNearBottom()
}

function shouldShowPill(index: number): boolean {
  if (!store.showPillSeparators) return false
  if (index === 0) return true
  return store.messages[index].role !== store.messages[index - 1].role
}

watch(
  () => store.messages.length,
  async () => {
    if (!isUserScrolledUp.value) {
      await nextTick()
      scrollToBottom()
    }
  }
)

onMounted(() => {
  scrollContainer.value?.addEventListener('scroll', onScroll, { passive: true })
  scrollToBottom()
})

onBeforeUnmount(() => {
  scrollContainer.value?.removeEventListener('scroll', onScroll)
})
</script>

<template>
  <div ref="scrollContainer" class="chat-thread">
    <div class="chat-thread-messages">
      <template v-for="(msg, i) in store.messages" :key="msg.id">
        <div v-if="shouldShowPill(i)" class="pill-separator">
          <span class="pill">{{ msg.role === 'user' ? 'User' : 'Agent' }}</span>
        </div>
        <ChatMessage :message="msg" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.chat-thread {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
}

.chat-thread-messages {
  max-width: 768px;
  margin: 0 auto;
}

.pill-separator {
  display: flex;
  align-items: center;
  padding: 4px 16px;
  margin: 8px 0 4px;
}

.pill {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text);
  opacity: 0.5;
  padding: 2px 8px;
  border-radius: 8px;
  background-color: var(--color-border);
}
</style>
