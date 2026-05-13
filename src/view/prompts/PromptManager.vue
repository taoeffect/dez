<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState, type Prompt } from '../modelState'

const { prompts } = useModelState()

const search = ref('')
const selectedId = ref<string | null>(null)
const pendingDeleteId = ref<string | null>(null)

const editName = ref('')
const nameError = ref<string | null>(null)
const nameInputRef = ref<HTMLInputElement | null>(null)

const nameWhitespaceRe = /\s/
const UNTITLED = 'Untitled'

const sortedPrompts = computed<Prompt[]>(() =>
  [...prompts.value].sort((a, b) => a.name.localeCompare(b.name)),
)

const filteredPrompts = computed<Prompt[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return sortedPrompts.value
  return sortedPrompts.value.filter(
    (p) => p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q),
  )
})

const selected = computed<Prompt | null>(() => {
  if (!selectedId.value) return null
  return prompts.value.find((p) => p.id === selectedId.value) ?? null
})

function validateName(name: string, ignoreId: string | null): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required.'
  if (nameWhitespaceRe.test(trimmed)) return 'Name cannot contain whitespace.'
  const collision = prompts.value.find((p) => p.name === trimmed && p.id !== ignoreId)
  if (collision) return 'Name must be unique.'
  return null
}

function selectPrompt(id: string) {
  selectedId.value = id
  pendingDeleteId.value = null
  const p = prompts.value.find((x) => x.id === id)
  editName.value = p?.name ?? ''
  nameError.value = null
}

function onAdd() {
  const existing = sbp('dez.model/prompts/getByName', UNTITLED) as Prompt | undefined
  if (existing) {
    if (selectedId.value !== existing.id) selectPrompt(existing.id)
    return
  }
  const p = sbp('dez.model/prompts/add', UNTITLED, '') as Prompt
  selectPrompt(p.id)
  void nextTick(() => nameInputRef.value?.focus())
}

function onNameInput() {
  if (!selected.value) return
  const err = validateName(editName.value, selected.value.id)
  nameError.value = err
  if (!err) {
    sbp('dez.model/prompts/update', selected.value.id, { name: editName.value.trim() })
  }
}

function onContentInput(e: Event) {
  if (!selected.value) return
  const el = e.target as HTMLTextAreaElement
  sbp('dez.model/prompts/update', selected.value.id, { content: el.value })
}

function requestDelete(id: string) {
  pendingDeleteId.value = id
}

function cancelDelete() {
  pendingDeleteId.value = null
}

function confirmDelete(id: string) {
  const list = sortedPrompts.value
  const idx = list.findIndex((p) => p.id === id)
  const wasSelected = selectedId.value === id

  sbp('dez.model/prompts/remove', id)
  pendingDeleteId.value = null

  if (wasSelected) {
    const remaining = sortedPrompts.value
    if (!remaining.length) {
      selectedId.value = null
      editName.value = ''
      nameError.value = null
      return
    }
    const next = remaining[idx] ?? remaining[idx - 1] ?? remaining[0]
    if (next) selectPrompt(next.id)
  }
}

// Keep editName in sync if the underlying prompt's name changes externally
// or if the selected prompt changes.
watch(
  () => selected.value?.name,
  (newName) => {
    if (newName === undefined) return
    // Only overwrite local edit if there's no active invalid edit.
    if (!nameError.value) editName.value = newName
  },
)

onMounted(() => {
  if (!selectedId.value && sortedPrompts.value.length) {
    selectPrompt(sortedPrompts.value[0].id)
  }
})
</script>

<template>
  <div class="prompt-manager">
    <!-- LEFT COLUMN -->
    <div class="prompt-sidebar">
      <div class="prompt-sidebar-controls">
        <input
          v-model="search"
          type="text"
          class="prompt-search"
          placeholder="Search…"
        />
        <button class="prompt-add-btn" title="New prompt" @click="onAdd">+</button>
      </div>

      <ul v-if="filteredPrompts.length" class="prompt-list">
        <li
          v-for="p in filteredPrompts"
          :key="p.id"
          class="prompt-row"
          :class="{ 'prompt-row--active': p.id === selectedId }"
          @click="selectPrompt(p.id)"
        >
          <template v-if="pendingDeleteId === p.id">
            <span class="prompt-row-confirm-text">Delete?</span>
            <div class="prompt-row-confirm-actions" @click.stop>
              <button class="prompt-confirm-btn prompt-confirm-btn--danger" @click="confirmDelete(p.id)">Yes</button>
              <button class="prompt-confirm-btn" @click="cancelDelete">Cancel</button>
            </div>
          </template>
          <template v-else>
            <span class="prompt-row-name">{{ p.name }}</span>
            <button
              class="prompt-row-trash"
              title="Delete prompt"
              @click.stop="requestDelete(p.id)"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.5 3.5h7m-5.5 0V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5V3.5m-3 0v6a.5.5 0 00.5.5h4a.5.5 0 00.5-.5v-6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </template>
        </li>
      </ul>
      <p v-else-if="search.trim()" class="prompt-sidebar-empty">No matches.</p>
      <p v-else class="prompt-sidebar-empty">No prompts yet.</p>
    </div>

    <!-- RIGHT COLUMN -->
    <div class="prompt-editor">
      <template v-if="selected">
        <input
          ref="nameInputRef"
          v-model="editName"
          type="text"
          class="prompt-name-input"
          placeholder="prompt-name"
          @input="onNameInput"
        />
        <p v-if="nameError" class="settings-error prompt-name-error">{{ nameError }}</p>
        <textarea
          class="prompt-body-input"
          :value="selected.content"
          placeholder="Prompt body…"
          @input="onContentInput"
        />
      </template>
      <div v-else class="prompt-editor-empty">
        <p>No prompt selected.</p>
        <p class="prompt-editor-empty-hint">Create one with the + button.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prompt-manager {
  display: flex;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

/* Left column */
.prompt-sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.prompt-sidebar-controls {
  display: flex;
  gap: 6px;
}

.prompt-search {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  outline: none;
  font-family: inherit;
  min-width: 0;
}

.prompt-search:focus {
  border-color: var(--color-text);
}

.prompt-add-btn {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s;
}

.prompt-add-btn:hover {
  background: var(--color-border);
}

.prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.prompt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--color-text);
  transition: background 0.1s;
}

.prompt-row:hover {
  background: var(--color-border);
}

.prompt-row--active {
  background: var(--color-border);
  font-weight: 500;
}

.prompt-row-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
}

.prompt-row-trash {
  opacity: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  padding: 2px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.1s, background 0.1s, color 0.1s;
}

.prompt-row:hover .prompt-row-trash {
  opacity: 0.6;
}

.prompt-row-trash:hover {
  opacity: 1 !important;
  color: #f44336;
  background: transparent;
}

.prompt-row-confirm-text {
  font-size: 12px;
  opacity: 0.8;
}

.prompt-row-confirm-actions {
  display: flex;
  gap: 4px;
}

.prompt-confirm-btn {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  font-size: 11px;
  cursor: pointer;
}

.prompt-confirm-btn:hover {
  background: var(--color-border);
}

.prompt-confirm-btn--danger {
  color: #f44336;
  border-color: #f44336;
}

.prompt-confirm-btn--danger:hover {
  background: rgba(244, 67, 54, 0.15);
}

.prompt-sidebar-empty {
  font-size: 12px;
  opacity: 0.5;
  margin: 0;
  text-align: center;
  padding: 12px 0;
}

/* Right column */
.prompt-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  min-width: 0;
}

.prompt-name-input {
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: monospace;
  font-weight: 600;
  outline: none;
}

.prompt-name-input:focus {
  border-color: var(--color-text);
}

.prompt-name-error {
  margin: 0;
}

.prompt-body-input {
  flex: 1;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  resize: none;
  min-height: 120px;
}

.prompt-body-input:focus {
  border-color: var(--color-text);
}

.prompt-editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  opacity: 0.5;
  font-size: 13px;
}

.prompt-editor-empty p {
  margin: 0;
}

.prompt-editor-empty-hint {
  font-size: 12px;
  opacity: 0.7;
}

.settings-error {
  font-size: 12px;
  color: #f44336;
}
</style>
