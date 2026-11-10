<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import sbp from '@sbp/sbp'
import { Virtualizer } from 'virtua/vue'
import { useModelState } from '../modelState'
import { availableModels, searchTerms } from '../../model/modelSearch'
import type { ModelInfo, ProviderInfo } from '../../model/providers'
import ModelOutputFilter from './ModelOutputFilter.vue'
import { pickerRows } from './pickerRows'

// The padding of the list's scroll box, in px. The virtual list starts
// below the top padding, and it must know that distance (`start-margin`) to
// find the rows in view. The CSS reads the same value.
const LIST_PADDING_PX = 4

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

const visibleModels = computed(() => availableModels(modelCache.value, providers.value))

// The list as flat rows (pickerRows.ts). A provider can have thousands of
// models, so a virtual list draws only the rows in view, and such a list
// takes one flat array. The search and the output filter (a setting that
// both pickers share) apply to every group, Favorites too.
const rows = computed(() => pickerRows({
  providers: providers.value,
  models: visibleModels.value,
  query: { terms: searchTerms(searchQuery.value), outputs: settings.value.modelOutputFilter },
  favorites: props.showFavorites ? settings.value.favorites : null,
  none: Boolean(props.noneLabel),
}))

const hasModels = computed(() => rows.value.some((row) => row.kind === 'model'))

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
      <ModelOutputFilter
        :model-value="settings.modelOutputFilter"
        @update:model-value="sbp('dez.model/settings/setModelOutputFilter', $event)"
      />
    </div>
    <div class="model-picker-list">
      <!-- The virtual list (virtua). `Virtualizer` draws only the rows near
           the visible part of its parent, the scroll box, and gives itself
           the height of all rows. So the picker is as tall as its list, up
           to the limit of its dropdown, as before. (virtua's `VList` is a
           scroll box of its own with no content height: the dropdown would
           not grow with the list.)
           The slot must give exactly one element with a key: virtua follows
           a row by that key, and it measures the row's height through the
           wrapper that it puts around that one element. -->
      <Virtualizer v-slot="{ item: row }" :data="rows" :start-margin="LIST_PADDING_PX">
        <button
          v-if="row.kind === 'none'"
          :key="row.key"
          class="model-item model-item--none"
          :class="{ 'model-item--active': !selectedModelId }"
          @click="$emit('selectNone')"
        >
          <span class="model-item-name">{{ noneLabel }}</span>
        </button>
        <div v-else-if="row.kind === 'header'" :key="row.key" class="model-group-header">{{ row.label }}</div>
        <button
          v-else
          :key="row.key"
          class="model-item"
          :class="{ 'model-item--active': isSelected(row.model) }"
          @click="$emit('select', row.model)"
        >
          <span
            v-if="showFavorites"
            class="model-item-star"
            :class="{ 'model-item-star--on': isFavorite(row.model) }"
            :title="isFavorite(row.model) ? 'Unfavorite' : 'Favorite'"
            @click="toggleFavorite(row.model, $event)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1L6 8.6l-2.8 1.5.6-3.1L1.5 4.8l3.1-.4L6 1.5z" :fill="isFavorite(row.model) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="model-item-name" :title="row.model.name">{{ row.model.name }}</span>
          <span class="model-item-provider">{{ row.providerName }}</span>
        </button>
      </Virtualizer>
      <div v-if="!hasModels" class="model-picker-empty">
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
/* At least as tall as the search row plus the output filter's dropdown,
   which hangs over the model list: with few models (or none that pass the
   filter) the picker would else end above the dropdown's last rows, and in
   the bottom bar those rows would leave the window. */
.model-picker {
  display: flex;
  flex-direction: column;
  min-height: 200px;
  height: 100%;
}

.model-picker-search {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--color-border);
}

.model-picker-input {
  flex: 1;
  min-width: 0;
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
  padding: v-bind("LIST_PADDING_PX + 'px'");
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

/* `pointer-events`: virtua sets `pointer-events: none` on the box around
   the rows while the list scrolls, and for 150 ms after the last scroll
   event. The rows inherit it, so a click soon after the wheel stops did
   nothing. The rows set the property back; they need no such rest. */
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
  pointer-events: auto;
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
