<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useTabStore } from '../model/state/tabs'
import type { ConversationSummary } from '../model/persistence/types'

const emit = defineEmits<{
  close: []
}>()

const tabStore = useTabStore()

const conversations = ref<ConversationSummary[]>([])
const search = ref('')
const sortMode = ref<'recent' | 'alphabetical'>('recent')
const loading = ref(false)
const error = ref<string | null>(null)
const pendingDeleteId = ref<string | null>(null)

const filteredConversations = computed(() => {
  const q = search.value.trim().toLowerCase()
  const filtered = q
    ? conversations.value.filter((conversation) => {
        const haystack = [
          conversation.title,
          conversation.model ?? '',
          conversation.preview,
        ].join('\n').toLowerCase()
        return haystack.includes(q)
      })
    : conversations.value

  return [...filtered].sort((a, b) => {
    if (sortMode.value === 'alphabetical') {
      return displayTitle(a).localeCompare(displayTitle(b))
    }
    return b.updatedAt - a.updatedAt
  })
})

onMounted(() => {
  void loadConversations()
})

async function loadConversations() {
  loading.value = true
  error.value = null
  try {
    conversations.value = await sbp('dez.persistence/listConversations') as ConversationSummary[]
  } catch (e) {
    console.error('Failed to load history:', e)
    error.value = `Failed to load history: ${e}`
  } finally {
    loading.value = false
  }
}

function displayTitle(conversation: ConversationSummary): string {
  return conversation.title.trim() || 'Untitled conversation'
}

function formatDate(ms: number): string {
  if (!ms) return 'Unknown date'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms))
}

function messageLabel(count: number): string {
  return count === 1 ? '1 message' : `${count} messages`
}

async function openConversation(id: string) {
  const tab = await tabStore.openConversationInNewTab(id)
  if (tab) emit('close')
}

function requestDelete(id: string) {
  pendingDeleteId.value = id
}

function cancelDelete() {
  pendingDeleteId.value = null
}

async function confirmDelete(id: string) {
  await tabStore.deleteConversationById(id)
  pendingDeleteId.value = null
  conversations.value = conversations.value.filter((conversation) => conversation.id !== id)
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('history-overlay')) {
    emit('close')
  }
}
</script>

<template>
  <div class="history-overlay" @click="onOverlayClick" @keydown.escape="emit('close')">
    <div class="history-modal">
      <div class="history-header">
        <div>
          <h2>Conversation History</h2>
          <p>{{ conversations.length }} saved conversations</p>
        </div>
        <button class="history-close" title="Close (Esc)" @click="emit('close')">×</button>
      </div>

      <div class="history-toolbar">
        <input
          v-model="search"
          type="text"
          class="history-search"
          placeholder="Search title, model, or content…"
        />
        <select v-model="sortMode" class="history-sort" title="Sort conversations">
          <option value="recent">Newest first</option>
          <option value="alphabetical">Alphabetical</option>
        </select>
        <button class="history-refresh" :disabled="loading" @click="loadConversations">
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
      </div>

      <p v-if="error" class="history-error">{{ error }}</p>

      <div v-if="loading && !conversations.length" class="history-empty">
        Loading history…
      </div>
      <div v-else-if="!filteredConversations.length" class="history-empty">
        {{ search.trim() ? 'No matching conversations.' : 'No saved conversations yet.' }}
      </div>
      <ul v-else class="history-list">
        <li
          v-for="conversation in filteredConversations"
          :key="conversation.id"
          class="history-row"
          @click="openConversation(conversation.id)"
        >
          <template v-if="pendingDeleteId === conversation.id">
            <div class="history-confirm" @click.stop>
              <div>
                <strong>Delete {{ displayTitle(conversation) }}?</strong>
                <span>This cannot be undone.</span>
              </div>
              <div class="history-confirm-actions">
                <button class="history-confirm-btn history-confirm-btn--danger" @click="confirmDelete(conversation.id)">
                  Delete
                </button>
                <button class="history-confirm-btn" @click="cancelDelete">Cancel</button>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="history-row-main">
              <div class="history-row-title-line">
                <h3>{{ displayTitle(conversation) }}</h3>
                <span class="history-row-date">{{ formatDate(conversation.updatedAt || conversation.createdAt) }}</span>
              </div>
              <div class="history-row-meta">
                <span>{{ conversation.model || 'No model' }}</span>
                <span>{{ messageLabel(conversation.messageCount) }}</span>
              </div>
              <p class="history-row-preview">{{ conversation.preview || 'No preview available.' }}</p>
            </div>
            <button
              class="history-row-trash"
              title="Delete conversation"
              @click.stop="requestDelete(conversation.id)"
            >
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.5 3.5h7m-5.5 0V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5V3.5m-3 0v6a.5.5 0 00.5.5h4a.5.5 0 00.5-.5v-6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </template>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.history-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.history-modal {
  width: min(860px, calc(100vw - 48px));
  height: min(720px, calc(100vh - 48px));
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.history-header h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.history-header p {
  font-size: 12px;
  opacity: 0.55;
  margin: 2px 0 0;
}

.history-close {
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

.history-close:hover {
  opacity: 1;
}

.history-toolbar {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--color-border);
}

.history-search {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.history-search:focus {
  border-color: var(--color-text);
}

.history-sort {
  padding: 7px 30px 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E") no-repeat right 10px center;
  color: var(--color-text);
  color-scheme: dark light;
  font-size: 13px;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}

.history-sort option {
  background: var(--color-bg);
  color: var(--color-text);
}

.history-refresh,
.history-confirm-btn {
  padding: 7px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.history-refresh:hover,
.history-confirm-btn:hover {
  background: var(--color-border);
}

.history-refresh:disabled {
  cursor: default;
  opacity: 0.5;
}

.history-error {
  margin: 12px 20px 0;
  font-size: 12px;
  color: #f44336;
}

.history-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  opacity: 0.55;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 8px 12px 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.1s;
}

.history-row:hover {
  background: var(--color-border);
}

.history-row-main {
  flex: 1;
  min-width: 0;
}

.history-row-title-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.history-row-title-line h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-row-date {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.55;
}

.history-row-meta {
  display: flex;
  gap: 10px;
  margin-top: 3px;
  font-size: 11px;
  opacity: 0.6;
}

.history-row-preview {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.75;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.history-row-trash {
  opacity: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  padding: 3px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.1s, color 0.1s;
}

.history-row:hover .history-row-trash {
  opacity: 0.6;
}

.history-row-trash:hover {
  opacity: 1 !important;
  color: #f44336;
}

.history-confirm {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.history-confirm strong,
.history-confirm span {
  display: block;
}

.history-confirm strong {
  font-size: 13px;
  font-weight: 600;
}

.history-confirm span {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.6;
}

.history-confirm-actions {
  display: flex;
  gap: 6px;
}

.history-confirm-btn--danger {
  color: #f44336;
  border-color: #f44336;
}

.history-confirm-btn--danger:hover {
  background: rgba(244, 67, 54, 0.15);
}
</style>
