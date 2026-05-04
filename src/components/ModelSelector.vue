<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useThreadStore } from '../stores/threadStore'
import { useSettingsStore } from '../stores/settingsStore'

interface ProviderInfo {
  id: string
  name: string
  configured: boolean
}

interface ModelInfo {
  id: string
  name: string
  provider: string
}

interface GroupedModels {
  providerId: string
  providerName: string
  models: ModelInfo[]
}

const threadStore = useThreadStore()
const settingsStore = useSettingsStore()

const isOpen = ref(false)
const searchQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const dropdownEl = ref<HTMLElement | null>(null)

const providers = ref<ProviderInfo[]>([])
const allModels = ref<ModelInfo[]>([])

const displayName = computed(() => {
  if (threadStore.activeModel) {
    return threadStore.activeModel.modelName
  }
  return 'Select model'
})

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function fuzzyIncludes(text: string, query: string) {
  let queryIndex = 0
  for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
    if (text[textIndex] === query[queryIndex]) queryIndex += 1
  }
  return queryIndex === query.length
}

function fieldMatches(fields: string[], queryTerms: string[]) {
  if (!queryTerms.length) return true
  const normalizedFields = fields.map(normalizeSearchText).filter(Boolean)
  const combined = normalizedFields.join(' ')

  return queryTerms.every((term) =>
    normalizedFields.some((field) => field.includes(term) || fuzzyIncludes(field, term)) ||
    combined.includes(term) ||
    fuzzyIncludes(combined, term),
  )
}

const filteredGrouped = computed<GroupedModels[]>(() => {
  const queryTerms = normalizeSearchText(searchQuery.value).split(/\s+/).filter(Boolean)
  const groups: GroupedModels[] = []

  const providerById = new Map(providers.value.map((provider) => [provider.id, provider]))
  const providerMatches = (provider: ProviderInfo) =>
    fieldMatches([provider.name, provider.id], queryTerms)
  const modelMatches = (m: ModelInfo, provider: ProviderInfo | undefined) => {
    const fields = provider
      ? [provider.name, provider.id, m.name, m.id]
      : [m.provider, m.name, m.id]
    return fieldMatches(fields, queryTerms)
  }

  const favModels: ModelInfo[] = []
  for (const fav of settingsStore.favorites) {
    const m = allModels.value.find(
      (x) => x.provider === fav.providerId && x.id === fav.modelId,
    )
    if (m && modelMatches(m, providerById.get(m.provider))) favModels.push(m)
  }
  if (favModels.length > 0) {
    groups.push({ providerId: '__favorites__', providerName: 'Favorites', models: favModels })
  }

  for (const provider of providers.value) {
    if (!provider.configured) continue
    const matchesProvider = providerMatches(provider)
    const models = allModels.value
      .filter((m) => m.provider === provider.id)
      .filter((m) => matchesProvider || modelMatches(m, provider))
    if (models.length > 0) {
      groups.push({ providerId: provider.id, providerName: provider.name, models })
    }
  }
  return groups
})

async function loadModels() {
  try {
    providers.value = await invoke<ProviderInfo[]>('get_configured_providers')
    const models: ModelInfo[] = []
    for (const p of providers.value) {
      if (p.configured) {
        try {
          const pModels = await invoke<ModelInfo[]>('list_models', { providerId: p.id })
          models.push(...pModels)
        } catch (e) {
          console.error(`Failed to load models for ${p.id}:`, e)
        }
      }
    }
    allModels.value = models
  } catch (e) {
    console.error('Failed to load providers:', e)
  }
}

function toggle() {
  if (isOpen.value) {
    close()
  } else {
    open()
  }
}

async function open() {
  isOpen.value = true
  searchQuery.value = ''
  await loadModels()
  nextTick(() => {
    searchInput.value?.focus()
  })
}

function close() {
  isOpen.value = false
  searchQuery.value = ''
}

function selectModel(model: ModelInfo) {
  threadStore.setActiveModel(model.provider, model.id, model.name)
  close()
}

function toggleFavorite(model: ModelInfo, e: MouseEvent) {
  e.stopPropagation()
  settingsStore.toggleFavorite(model.provider, model.id)
}

function openProviderSettings() {
  close()
  settingsStore.openSettings()
}

function onClickOutside(e: MouseEvent) {
  if (dropdownEl.value && !dropdownEl.value.contains(e.target as Node)) {
    close()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen.value) {
    e.stopPropagation()
    close()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside)
  document.addEventListener('keydown', onKeydown, true)
  threadStore.initActiveModel()
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onClickOutside)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div ref="dropdownEl" class="model-selector">
    <div class="model-selector-bar">
      <button class="model-selector-btn" @click="toggle">
        <span class="model-selector-label">{{ displayName }}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="model-selector-chevron" :class="{ 'model-selector-chevron--open': isOpen }">
          <path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="model-selector-gear" title="Configure providers" @click="openProviderSettings">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path d="M7 9a2 2 0 100-4 2 2 0 000 4z" fill="currentColor"/>
          <path d="M13 8.5l-1.3-.7a4.8 4.8 0 000-1.6L13 5.5l-1-1.7-1.4.4a4.7 4.7 0 00-1.4-.8L9 2H7l-.2 1.4a4.7 4.7 0 00-1.4.8L4 3.8 3 5.5l1.3.7a4.8 4.8 0 000 1.6L3 8.5l1 1.7 1.4-.4c.4.3.9.6 1.4.8L7 12h2l.2-1.4c.5-.2 1-.5 1.4-.8l1.4.4 1-1.7z" stroke="currentColor" stroke-width="1" fill="none"/>
        </svg>
      </button>
    </div>

    <div v-if="isOpen" class="model-dropdown">
      <div class="model-dropdown-search">
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="text"
          class="model-dropdown-input"
          placeholder="Search models…"
          @keydown.escape.stop="close"
        />
      </div>
      <div class="model-dropdown-list">
        <template v-if="filteredGrouped.length">
          <div v-for="group in filteredGrouped" :key="group.providerId" class="model-group">
            <div class="model-group-header">{{ group.providerName }}</div>
            <button
              v-for="model in group.models"
              :key="group.providerId + ':' + model.id"
              class="model-item"
              :class="{ 'model-item--active': threadStore.activeModel?.modelId === model.id && threadStore.activeModel?.providerId === model.provider }"
              @click="selectModel(model)"
            >
              <span
                class="model-item-star"
                :class="{ 'model-item-star--on': settingsStore.isFavorite(model.provider, model.id) }"
                :title="settingsStore.isFavorite(model.provider, model.id) ? 'Unfavorite' : 'Favorite'"
                @click="toggleFavorite(model, $event)"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1L6 8.6l-2.8 1.5.6-3.1L1.5 4.8l3.1-.4L6 1.5z" :fill="settingsStore.isFavorite(model.provider, model.id) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="model-item-name">{{ model.name }}</span>
              <span class="model-item-provider">{{ group.providerName }}</span>
            </button>
          </div>
        </template>
        <div v-else class="model-dropdown-empty">
          No models found
        </div>
      </div>
      <button class="model-dropdown-configure" @click="openProviderSettings">
        Configure Providers
      </button>
    </div>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
  flex-shrink: 0;
}

.model-selector-bar {
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 8px;
  background-color: var(--color-tab-bar);
  border-top: 1px solid var(--color-border);
  gap: 4px;
}

.model-selector-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.model-selector-btn:hover {
  opacity: 1;
}

.model-selector-chevron {
  transition: transform 0.15s;
}

.model-selector-chevron--open {
  transform: rotate(180deg);
}

.model-selector-gear {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  opacity: 0.4;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
}

.model-selector-gear:hover {
  opacity: 0.8;
}

.model-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
  width: 320px;
  max-height: 360px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  margin-bottom: 4px;
  z-index: 50;
}

.model-dropdown-search {
  padding: 8px;
  border-bottom: 1px solid var(--color-border);
}

.model-dropdown-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}

.model-dropdown-input:focus {
  border-color: var(--color-text);
}

.model-dropdown-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.model-group-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text);
  opacity: 0.5;
  padding: 6px 8px 2px;
}

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.model-item:hover {
  background: var(--color-border);
}

.model-item--active {
  background: var(--color-border);
  font-weight: 500;
}

.model-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-item-star {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 6px;
  border-radius: 3px;
  color: var(--color-text);
  opacity: 0.3;
  transition: opacity 0.1s, color 0.1s;
  flex-shrink: 0;
}

.model-item-star:hover {
  opacity: 0.9;
}

.model-item-star--on {
  opacity: 1;
  color: #e0b34a;
}

.model-item-provider {
  font-size: 11px;
  opacity: 0.5;
  flex-shrink: 0;
  margin-left: 8px;
}

.model-dropdown-empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  opacity: 0.5;
}

.model-dropdown-configure {
  padding: 8px;
  border: none;
  border-top: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s;
  text-align: center;
}

.model-dropdown-configure:hover {
  opacity: 1;
}
</style>
