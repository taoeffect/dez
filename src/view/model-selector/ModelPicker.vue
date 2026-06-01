<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import type { ModelInfo, ProviderInfo } from '../../model/providers'

interface DisplayModel extends ModelInfo {
  providerName: string
}

interface GroupedModels {
  providerId: string
  providerName: string
  models: DisplayModel[]
}

const props = withDefaults(defineProps<{
  // Currently-selected model, highlighted in the list. Parents own the meaning
  // of a selection (active model vs. default-new-tab model), so the picker is
  // purely presentational about what is selected.
  selectedProviderId?: string | null
  selectedModelId?: string | null
  // When set, renders a leading "None" row that emits `selectNone`.
  noneLabel?: string | null
  // When true, shows favorite-toggle stars + a Favorites group.
  showFavorites?: boolean
  // Whether the footer "Configure Providers" button + refresh spinner show.
  showFooter?: boolean
  // Autofocus the search input on mount.
  autofocus?: boolean
}>(), {
  selectedProviderId: null,
  selectedModelId: null,
  noneLabel: null,
  showFavorites: false,
  showFooter: true,
  autofocus: true,
})

defineEmits<{
  (e: 'select', model: ModelInfo): void
  (e: 'selectNone'): void
  (e: 'configure'): void
}>()

const { settings, modelCache, modelCacheRefreshing } = useModelState()

const searchQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const providers = ref<ProviderInfo[]>([])

// Models to show right now, derived reactively from the persisted cache: only
// providers that are currently configured AND whose cached `working !== false`.
// Computed locally because it must reactively combine the cache snapshot with
// the async-loaded `providers` ref.
const visibleModels = computed<ModelInfo[]>(() => {
  const configured = new Set<string>(
    providers.value.filter((provider) => provider.configured).map((provider) => provider.id),
  )
  const models: ModelInfo[] = []
  for (const [providerId, entry] of Object.entries(modelCache.value.providers)) {
    if (!entry || entry.working === false) continue
    if (!configured.has(providerId)) continue
    models.push(...entry.models)
  }
  return models
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
  const toDisplayModel = (m: ModelInfo): DisplayModel => ({
    ...m,
    providerName: providerById.get(m.provider)?.name ?? m.provider,
  })

  if (props.showFavorites) {
    const favModels: DisplayModel[] = []
    for (const fav of settings.value.favorites) {
      const m = visibleModels.value.find(
        (x) => x.provider === fav.providerId && x.id === fav.modelId,
      )
      if (m && modelMatches(m, providerById.get(m.provider))) favModels.push(toDisplayModel(m))
    }
    if (favModels.length > 0) {
      groups.push({ providerId: '__favorites__', providerName: 'Favorites', models: favModels })
    }
  }

  for (const provider of providers.value) {
    if (!provider.configured) continue
    const matchesProvider = providerMatches(provider)
    const models = visibleModels.value
      .filter((m) => m.provider === provider.id)
      .filter((m) => matchesProvider || modelMatches(m, provider))
      .map(toDisplayModel)
    if (models.length > 0) {
      groups.push({ providerId: provider.id, providerName: provider.name, models })
    }
  }
  return groups
})

// Load the configured-provider set + group names. Provider "configured" status
// depends on native key presence (async) and is not reactive, so it is
// refreshed each time the picker mounts rather than tracked as reactive state.
async function loadProviders() {
  try {
    providers.value = await sbp('dez.provider/infos') as ProviderInfo[]
  } catch (e) {
    console.error('Failed to load providers:', e)
  }
}

function isSelected(model: ModelInfo) {
  return props.selectedModelId === model.id && props.selectedProviderId === model.provider
}

function isFavorite(model: ModelInfo) {
  return settings.value.favorites.some(
    (favorite) => favorite.providerId === model.provider && favorite.modelId === model.id,
  )
}

function toggleFavorite(model: ModelInfo, e: MouseEvent) {
  e.stopPropagation()
  sbp('dez.model/settings/toggleFavorite', model.provider, model.id)
}

defineExpose({ focus })

function focus() {
  searchInput.value?.focus()
}

onMounted(async () => {
  // Show cached models immediately. We only await the cheap configured-provider
  // fetch (no model network calls); cached visibleModels render right away and
  // the background refresh reconciles them in place as results land.
  await loadProviders()
  void sbp('dez.controller/modelCache/refresh')
  if (props.autofocus) nextTick(() => searchInput.value?.focus())
})
</script>

<template>
  <div class="model-picker">
    <div class="model-picker-search">
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="text"
        class="model-picker-input"
        placeholder="Search models…"
        @keydown.escape.stop="$emit('configure')"
      />
    </div>
    <div class="model-picker-list">
      <button
        v-if="noneLabel"
        class="model-item model-item--none"
        :class="{ 'model-item--active': !selectedModelId }"
        @click="$emit('selectNone')"
      >
        <span class="model-item-name">{{ noneLabel }}</span>
      </button>
      <template v-if="filteredGrouped.length">
        <div v-for="group in filteredGrouped" :key="group.providerId" class="model-group">
          <div class="model-group-header">{{ group.providerName }}</div>
          <button
            v-for="model in group.models"
            :key="group.providerId + ':' + model.id"
            class="model-item"
            :class="{ 'model-item--active': isSelected(model) }"
            @click="$emit('select', model)"
          >
            <span
              v-if="showFavorites"
              class="model-item-star"
              :class="{ 'model-item-star--on': isFavorite(model) }"
              :title="isFavorite(model) ? 'Unfavorite' : 'Favorite'"
              @click="toggleFavorite(model, $event)"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1L6 8.6l-2.8 1.5.6-3.1L1.5 4.8l3.1-.4L6 1.5z" :fill="isFavorite(model) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="model-item-name">{{ model.name }}</span>
            <span class="model-item-provider">{{ model.providerName }}</span>
          </button>
        </div>
      </template>
      <div v-else class="model-picker-empty">
        No models found
      </div>
    </div>
    <div v-if="showFooter" class="model-picker-footer">
      <button class="model-picker-configure" @click="$emit('configure')">
        Configure Providers
      </button>
      <!-- Spinner signals an in-progress background model-cache refresh.
           Kept in the layout always (visibility toggled) so its width never
           shifts the centered "Configure Providers" text. -->
      <span
        class="model-picker-spinner"
        :class="{ 'is-hidden': !modelCacheRefreshing }"
        aria-label="Refreshing models"
      ></span>
    </div>
  </div>
</template>

<style scoped>
.model-picker {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.model-picker-search {
  padding: 8px;
  border-bottom: 1px solid var(--color-border);
}

.model-picker-input {
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

.model-picker-input:focus {
  border-color: var(--color-text);
}

.model-picker-list {
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

.model-picker-empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  opacity: 0.5;
}

.model-picker-footer {
  display: flex;
  align-items: center;
  border-top: 1px solid var(--color-border);
}

.model-picker-configure {
  flex: 1;
  padding: 8px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s;
  text-align: center;
}

.model-picker-configure:hover {
  opacity: 1;
}

/* Subtle CSS border spinner shown while a background model refresh runs.
   Theme vars keep it visible in both light and dark themes. */
.model-picker-spinner {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  margin-right: 10px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-text);
  border-radius: 50%;
  animation: model-picker-spin 0.7s linear infinite;
}

/* Hidden but still occupies layout space, preventing the centered configure
   text from shifting when the spinner toggles. */
.model-picker-spinner.is-hidden {
  visibility: hidden;
}

@keyframes model-picker-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
