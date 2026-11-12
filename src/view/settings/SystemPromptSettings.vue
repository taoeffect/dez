<script setup lang="ts">
import { computed, ref } from 'vue'
import sbp from '@sbp/sbp'
import { effectiveRequest, type ModelInfo, type ProviderSettingsDescriptor } from '../../model/providers'
import {
  BUILT_IN_SYSTEM_PROMPT,
  SYSTEM_PROMPT_VARIABLES,
  buildSystemPrompt,
  systemPromptIsBlank,
  systemPromptProblem,
} from '../../model/systemPrompt'
import { TOOL_DEFINITIONS } from '../../model/tools/registry'
import { modelLabel } from '../modelLabel'
import { useModelState } from '../modelState'
import SystemPromptPreview from './SystemPromptPreview.vue'

const { settings, activeModel, modelDisplayNames } = useModelState()

// Off each time the page opens, so a stray key never changes the prompt.
const editing = ref(false)
const mode = ref<'source' | 'preview'>('source')

const template = computed(() => settings.value.systemPrompt ?? BUILT_IN_SYSTEM_PROMPT)
const problem = computed(() => systemPromptProblem(template.value))
const blank = computed(() => systemPromptIsBlank(template.value))

// The prompt of a chat request in the active tab now: its model, the name
// of its provider, and the tools that the request offers. A text in place
// of the prompt when there is none to show.
const preview = computed((): { text: string, model: string } | { note: string } => {
  const model = activeModel.value
  if (!model) return { note: 'No model is selected. Choose a model in the bottom bar to see the prompt that it gets.' }
  if (problem.value !== null) return { note: 'Fix the error in the prompt to see the preview.' }
  const modelName = modelLabel(model, modelDisplayNames.value).modelName
  const cached = sbp('dez.model/modelCache/model', model.providerId, model.modelId) as ModelInfo | null
  if (effectiveRequest(cached ?? {}) !== 'chat') {
    return { note: `${modelName} gets no system prompt: Dez sends it only to chat models.` }
  }
  const provider = sbp('dez.provider/settingsDescriptor', model.providerId, model.modelId) as ProviderSettingsDescriptor | null
  const providerName = provider?.name ?? model.providerId
  const tools = sbp('dez.model/requestSendsTools', model) as boolean ? TOOL_DEFINITIONS : []
  const text = buildSystemPrompt(template.value, model, providerName, tools)
  if (text === undefined) return { note: 'Dez sends no system prompt.' }
  return { text, model: `${modelName} (${providerName})` }
})

function onInput(event: Event) {
  sbp('dez.model/settings/setSystemPrompt', (event.target as HTMLTextAreaElement).value)
}

async function restoreDefault() {
  const confirmed = await sbp('dez.ui/confirm', {
    message: 'Are you sure you want to restore the default system prompt? This deletes your own prompt.',
    confirmLabel: 'Restore Default',
    cancelLabel: 'Cancel',
  }) as boolean
  if (confirmed) sbp('dez.model/settings/setSystemPrompt', null)
}
</script>

<template>
  <div class="settings-section system-prompt">
    <div class="settings-group">
      <p class="settings-hint">
        Dez sends this text to the model as the system prompt of each chat request.
      </p>
      <label class="settings-checkbox-row">
        <input v-model="editing" type="checkbox" class="system-prompt-edit" />
        Edit
      </label>
    </div>

    <div class="settings-group system-prompt-main">
      <div class="system-prompt-box">
        <!-- v-show, not v-if: the textarea keeps its scroll and caret over
             a look at the preview. -->
        <textarea
          v-show="mode === 'source'"
          class="system-prompt-source"
          :value="template"
          :readonly="!editing"
          spellcheck="false"
          aria-label="System prompt"
          @input="onInput"
        />
        <template v-if="mode === 'preview'">
          <SystemPromptPreview v-if="'text' in preview" :text="preview.text" />
          <p v-else class="settings-hint system-prompt-preview-note">{{ preview.note }}</p>
        </template>
        <div class="system-prompt-bar">
          <div class="system-prompt-modes" :class="{ 'system-prompt-modes--preview': mode === 'preview' }">
            <span class="system-prompt-modes-highlight" />
            <button
              type="button"
              class="system-prompt-mode"
              :class="{ 'system-prompt-mode--active': mode === 'source' }"
              :aria-pressed="mode === 'source'"
              @click="mode = 'source'"
            >
              Source
            </button>
            <button
              type="button"
              class="system-prompt-mode"
              :class="{ 'system-prompt-mode--active': mode === 'preview' }"
              :aria-pressed="mode === 'preview'"
              @click="mode = 'preview'"
            >
              Preview
            </button>
          </div>
          <span v-if="mode === 'preview' && 'text' in preview" class="system-prompt-preview-model">
            As {{ preview.model }} gets it
          </span>
          <button
            v-if="settings.systemPrompt !== null"
            type="button"
            class="settings-btn settings-btn--sm system-prompt-restore"
            @click="restoreDefault()"
          >
            Restore Default
          </button>
        </div>
      </div>
      <p v-if="problem !== null" class="settings-error system-prompt-error">{{ problem }}</p>
      <p v-else-if="blank" class="settings-hint system-prompt-blank">
        The prompt is empty, so Dez sends no system prompt.
      </p>
    </div>

    <div class="settings-group">
      <span class="settings-label">Variables</span>
      <p class="settings-hint">Dez puts in the value of each variable when it sends a request.</p>
      <table class="system-prompt-variables">
        <tbody>
          <tr v-for="variable in SYSTEM_PROMPT_VARIABLES" :key="variable.name">
            <!-- v-text: a `}}` in a {{ }} interpolation would end it. -->
            <td><code v-text="'{{' + variable.name + '}}'" /></td>
            <td>{{ variable.meaning }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
/* The page fills the pane, and the prompt box takes the room that is left;
   a short window makes the pane scroll. The root is the section itself:
   SettingsView's scoped `.settings-section` reaches a child's root element. */
.system-prompt {
  flex: 1 0 auto;
}

.system-prompt-main {
  flex: 1;
}

.system-prompt-box {
  flex: 1;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}

.system-prompt-box:focus-within {
  border-color: var(--color-text);
}

/* The font of the thread editor (`dezTheme`, cmEditor.ts). */
.system-prompt-source {
  flex: 1;
  min-height: 0;
  padding: 10px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  line-height: 1.6;
  outline: none;
  resize: none;
}

.system-prompt-box > .system-prompt-preview {
  flex: 1;
}

.system-prompt-preview-note {
  flex: 1;
  margin: 0;
  padding: 10px;
}

.system-prompt-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px;
  border-top: 1px solid var(--color-border);
}

/* Two buttons with one highlight that slides to the active one. */
.system-prompt-modes {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 2px;
  border-radius: 6px;
  background: var(--color-border);
}

.system-prompt-modes-highlight {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc(50% - 2px);
  border-radius: 4px;
  background: var(--color-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  transition: transform 150ms ease;
}

.system-prompt-modes--preview .system-prompt-modes-highlight {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .system-prompt-modes-highlight {
    transition: none;
  }
}

.system-prompt-mode {
  position: relative;
  padding: 3px 12px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
  opacity: 0.7;
}

.system-prompt-mode--active {
  opacity: 1;
  font-weight: 500;
}

.system-prompt-preview-model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-muted);
}

.system-prompt-restore {
  margin-left: auto;
}

.system-prompt-error,
.system-prompt-blank {
  margin: 0;
}

.system-prompt-variables {
  border-collapse: collapse;
  font-size: 12px;
}

.system-prompt-variables td {
  padding: 4px 12px 4px 0;
  vertical-align: top;
}

.system-prompt-variables code {
  font-size: 12px;
  white-space: nowrap;
}
</style>
