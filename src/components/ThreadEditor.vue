<script setup lang="ts">
import { ref, nextTick, watch, onMounted } from 'vue'
import { useThreadStore } from '../stores/threadStore'
import { useSettingsStore } from '../stores/settingsStore'

const store = useThreadStore()
const settingsStore = useSettingsStore()
const sectionRefs = ref<Map<string, HTMLTextAreaElement>>(new Map())
const editorEl = ref<HTMLElement | null>(null)

function setSectionRef(id: string, el: HTMLTextAreaElement | null) {
  if (el) {
    sectionRefs.value.set(id, el)
    resizeTextarea(el)
  } else {
    sectionRefs.value.delete(id)
  }
}

function resizeTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

function onSectionInput(id: string, event: Event) {
  const el = event.target as HTMLTextAreaElement
  store.updateSectionContent(id, el.value)
  resizeTextarea(el)
}

function onPillClick(id: string) {
  store.toggleSectionRole(id)
}

function onSectionKeydown(id: string, event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey

  if (event.key === 'Enter' && mod) {
    event.preventDefault()
    submitThread()
    return
  }

  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault()
    const el = sectionRefs.value.get(id)
    if (el) {
      const cursorPos = el.selectionStart
      const newSection = store.splitSection(id, cursorPos)
      if (newSection) {
        nextTick(() => {
          const newEl = sectionRefs.value.get(newSection.id)
          if (newEl) {
            newEl.focus()
            newEl.setSelectionRange(0, 0)
          }
        })
      }
    }
    return
  }

  if (event.key === 'Backspace') {
    const section = store.sections.find((s) => s.id === id)
    if (section && section.content === '') {
      const index = store.sections.findIndex((s) => s.id === id)
      if (store.sections.length > 1) {
        event.preventDefault()
        const focusIndex = index > 0 ? index - 1 : 1
        const focusId = store.sections[focusIndex].id
        store.removeSectionIfEmpty(id)
        nextTick(() => {
          const el = sectionRefs.value.get(focusId)
          if (el) {
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          }
        })
      }
    }
  }
}

function submitThread() {
  const thread = store.getThreadForSubmission()
  if (thread.length === 0) return

  const lastSection = store.sections[store.sections.length - 1]
  if (lastSection.role !== 'agent' || lastSection.content.trim() !== '') {
    store.addSection('agent')
  }

  const agentSection = store.sections[store.sections.length - 1]
  agentSection.content = '…'

  nextTick(() => {
    const lastUserSection = store.sections[store.sections.length - 1]
    if (lastUserSection.role === 'agent') {
      store.addSection('user')
    }
    nextTick(() => {
      focusLastSection()
    })
  })
}

function focusLastSection() {
  const last = store.sections[store.sections.length - 1]
  if (last) {
    const el = sectionRefs.value.get(last.id)
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }
}

function pillLabel(role: string): string {
  return role === 'user' ? 'User' : 'Agent'
}

onMounted(() => {
  nextTick(() => focusLastSection())
})

watch(
  () => store.sections.length,
  () => {
    nextTick(() => {
      sectionRefs.value.forEach((el) => resizeTextarea(el))
    })
  }
)
</script>

<template>
  <div ref="editorEl" class="thread-editor">
    <div class="thread-editor-content">
      <template v-for="section in store.sections" :key="section.id">
        <div
          v-if="settingsStore.showPillSeparators"
          class="pill-separator"
        >
          <button
            class="pill"
            @click="onPillClick(section.id)"
            :title="'Click to toggle role'"
          >
            {{ pillLabel(section.role) }}
          </button>
        </div>
        <textarea
          :ref="(el) => setSectionRef(section.id, el as HTMLTextAreaElement)"
          :value="section.content"
          @input="onSectionInput(section.id, $event)"
          @keydown="onSectionKeydown(section.id, $event)"
          class="section-textarea"
          :class="`section-textarea--${section.role}`"
          :placeholder="section.role === 'user' ? 'Start typing…' : ''"
          rows="1"
          spellcheck="false"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.thread-editor {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
}

.thread-editor-content {
  max-width: 768px;
  margin: 0 auto;
  padding: 0 16px;
}

.pill-separator {
  display: flex;
  align-items: center;
  padding: 4px 0;
  margin: 4px 0 2px;
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
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: opacity 0.15s;
}

.pill:hover {
  opacity: 0.8;
}

.section-textarea {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.6;
  resize: none;
  overflow: hidden;
  padding: 4px 0;
}

.section-textarea::placeholder {
  color: var(--color-text);
  opacity: 0.3;
}

.section-textarea--agent {
  opacity: 0.85;
}
</style>
