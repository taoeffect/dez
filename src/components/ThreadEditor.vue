<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue'
import { useThreadStore } from '../stores/threadStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useStreaming } from '../composables/useStreaming'

const store = useThreadStore()
const settingsStore = useSettingsStore()
const tabStore = useTabStore()
const { isStreaming, streamingTabId, streamingError, startStreaming, stopStreaming } = useStreaming()
const editorEl = ref<HTMLDivElement | null>(null)
let syncing = false
let streamRafId: number | null = null

const isActiveTabStreaming = computed(() => isStreaming.value && streamingTabId.value === tabStore.activeTabId)
const showThinking = computed(() => {
  if (!isActiveTabStreaming.value) return false
  const last = store.sections[store.sections.length - 1]
  return last?.role === 'agent' && last.content === ''
})

const PILL_USER = '------------------- USER -----------------------'
const PILL_AGENT = '------------------- AGENT -----------------------'

function buildDOM() {
  const el = editorEl.value
  if (!el) return

  syncing = true
  const savedSelection = saveSelection(el)

  el.innerHTML = ''

  store.sections.forEach((section, index) => {
    if (settingsStore.showPillSeparators) {
      const pill = document.createElement('div')
      pill.className = 'pill-separator'
      pill.contentEditable = 'false'
      pill.dataset.sectionId = section.id

      const btn = document.createElement('button')
      btn.className = 'pill'
      btn.textContent = section.role === 'user' ? 'User' : 'Agent'
      btn.title = 'Click to toggle role'
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        store.toggleSectionRole(section.id)
        buildDOM()
      })
      pill.appendChild(btn)
      el.appendChild(pill)
    }

    const block = document.createElement('div')
    block.className = `section-block section-block--${section.role}`
    block.dataset.sectionId = section.id
    block.dataset.sectionIndex = String(index)

    if (section.content === '') {
      block.appendChild(document.createElement('br'))
    } else {
      const lines = section.content.split('\n')
      lines.forEach((line, lineIdx) => {
        if (lineIdx > 0) {
          block.appendChild(document.createElement('br'))
        }
        if (line) {
          block.appendChild(document.createTextNode(line))
        }
      })
      if (section.content.endsWith('\n')) {
        block.appendChild(document.createElement('br'))
      }
    }

    el.appendChild(block)
  })

  updateEmptyState(el)
  restoreSelection(el, savedSelection)
  syncing = false
}

function updateEmptyState(el: HTMLElement) {
  const isEmpty = store.sections.length === 1 && store.sections[0].content === ''
  el.classList.toggle('is-empty', isEmpty)
}

interface SavedSelection {
  sectionIndex: number
  offset: number
  endSectionIndex: number
  endOffset: number
}

function saveSelection(container: HTMLElement): SavedSelection | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null

  const range = sel.getRangeAt(0)
  const start = resolvePosition(container, range.startContainer, range.startOffset)
  const end = resolvePosition(container, range.endContainer, range.endOffset)
  if (!start || !end) return null

  return {
    sectionIndex: start.sectionIndex,
    offset: start.offset,
    endSectionIndex: end.sectionIndex,
    endOffset: end.offset,
  }
}

function resolvePosition(container: HTMLElement, node: Node, offset: number): { sectionIndex: number; offset: number } | null {
  let block: HTMLElement | null = null
  let current: Node | null = node
  while (current && current !== container) {
    if (current instanceof HTMLElement && current.classList.contains('section-block')) {
      block = current
      break
    }
    current = current.parentNode
  }
  if (!block) return null

  const sectionIndex = parseInt(block.dataset.sectionIndex || '0', 10)
  const textOffset = getTextOffset(block, node, offset)
  return { sectionIndex, offset: textOffset }
}

function getTextOffset(root: Node, targetNode: Node, targetOffset: number): number {
  let offset = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let node: Node | null = walker.currentNode
  while (node) {
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        return offset + targetOffset
      }
      let count = 0
      for (let i = 0; i < targetOffset; i++) {
        const child = (node as HTMLElement).childNodes[i]
        if (child) {
          if (child.nodeType === Node.TEXT_NODE) {
            count += child.textContent?.length || 0
          } else if ((child as HTMLElement).tagName === 'BR') {
            count += 1
          }
        }
      }
      return offset + count
    }
    if (node.nodeType === Node.TEXT_NODE && node !== root) {
      offset += node.textContent?.length || 0
    } else if (node instanceof HTMLElement && node.tagName === 'BR') {
      offset += 1
    }
    node = walker.nextNode()
  }
  return offset
}

function restoreSelection(container: HTMLElement, saved: SavedSelection | null) {
  if (!saved) return

  const blocks = container.querySelectorAll('.section-block')
  const startBlock = blocks[saved.sectionIndex]
  const endBlock = blocks[saved.endSectionIndex]
  if (!startBlock || !endBlock) return

  const startPos = findNodeAtOffset(startBlock, saved.offset)
  const endPos = findNodeAtOffset(endBlock, saved.endOffset)
  if (!startPos || !endPos) return

  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  sel.removeAllRanges()
  sel.addRange(range)
}

function findNodeAtOffset(root: Node, targetOffset: number): { node: Node; offset: number } | null {
  let offset = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let node: Node | null = walker.currentNode

  if (targetOffset === 0) {
    const firstChild = root.firstChild
    if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
      return { node: firstChild, offset: 0 }
    }
    return { node: root, offset: 0 }
  }

  while (node) {
    if (node.nodeType === Node.TEXT_NODE && node !== root) {
      const len = node.textContent?.length || 0
      if (offset + len >= targetOffset) {
        return { node, offset: targetOffset - offset }
      }
      offset += len
    } else if (node instanceof HTMLElement && node.tagName === 'BR') {
      offset += 1
      if (offset >= targetOffset) {
        const next = walker.nextNode()
        if (next && next.nodeType === Node.TEXT_NODE) {
          return { node: next, offset: 0 }
        }
        return { node: node.parentNode!, offset: Array.from(node.parentNode!.childNodes).indexOf(node) + 1 }
      }
    }
    node = walker.nextNode()
  }

  const lastChild = root.lastChild
  if (lastChild && lastChild.nodeType === Node.TEXT_NODE) {
    return { node: lastChild, offset: lastChild.textContent?.length || 0 }
  }
  return { node: root, offset: root.childNodes.length }
}

function readDOMToStore() {
  if (syncing) return
  const el = editorEl.value
  if (!el) return

  // Gather all section blocks, grouping by sectionId since the browser
  // may clone a block when Enter splits a line
  const allBlocks = Array.from(el.querySelectorAll('.section-block'))
  const grouped = new Map<string, HTMLElement[]>()
  allBlocks.forEach((block) => {
    const id = (block as HTMLElement).dataset.sectionId
    if (!id) return
    if (!grouped.has(id)) grouped.set(id, [])
    grouped.get(id)!.push(block as HTMLElement)
  })

  grouped.forEach((blocks, sectionId) => {
    let content = ''
    blocks.forEach((block, i) => {
      if (i > 0 && content.length > 0 && !content.endsWith('\n')) {
        content += '\n'
      }
      content += extractTextContent(block)
    })
    const section = store.sections.find((s) => s.id === sectionId)
    if (section && section.content !== content) {
      store.updateSectionContent(sectionId, content)
    }
  })
}

function extractTextContent(block: HTMLElement): string {
  let text = ''
  block.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || ''
    } else if (node instanceof HTMLElement) {
      if (node.tagName === 'BR') {
        text += '\n'
      } else if (node.tagName === 'DIV' || node.tagName === 'P') {
        if (text.length > 0 && !text.endsWith('\n')) {
          text += '\n'
        }
        text += node.textContent || ''
      } else {
        text += node.textContent || ''
      }
    }
  })
  if (text.endsWith('\n')) {
    text = text.slice(0, -1)
  }
  return text
}

function onInput() {
  readDOMToStore()
  const el = editorEl.value
  if (el) {
    updateEmptyState(el)
    // If the browser destroyed our section-block structure, rebuild it
    if (!el.querySelector('.section-block')) {
      buildDOM()
      nextTick(() => {
        if (el) {
          el.focus()
          setCursorToSection(store.sections.length - 1, store.sections[store.sections.length - 1].content.length)
        }
      })
    }
  }
}

function onKeydown(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey

  if (event.key === 'Enter' && mod) {
    event.preventDefault()
    submitThread()
    return
  }

  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault()
    insertNewSection()
    return
  }

  // Plain Enter: let the browser handle it natively for responsiveness

  if (event.key === 'Backspace') {
    handleBackspace(event)
  }
}

function insertNewSection() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return

  const range = sel.getRangeAt(0)
  const el = editorEl.value
  if (!el) return

  // Sync DOM to store first so cloned blocks are merged
  readDOMToStore()

  // Find which section-block the cursor is in, and compute the offset
  // across all cloned blocks with the same sectionId
  let cursorBlock: HTMLElement | null = null
  let node: Node | null = range.startContainer
  while (node && node !== el) {
    if (node instanceof HTMLElement && node.classList.contains('section-block')) {
      cursorBlock = node
      break
    }
    node = node.parentNode
  }
  if (!cursorBlock) {
    // DOM has no section-block (structure was destroyed) — rescue text content,
    // rebuild, then split
    const rawText = el.textContent || ''
    const lastSection = store.sections[store.sections.length - 1]
    if (!lastSection) return
    lastSection.content = rawText
    const cursorOffset = getTextOffset(el, range.startContainer, range.startOffset)
    const splitAt = Math.min(cursorOffset, rawText.length)
    const newSection = store.splitSection(lastSection.id, splitAt)
    if (newSection) {
      nextTick(() => {
        buildDOM()
        nextTick(() => {
          setCursorToSection(store.sections.findIndex((s) => s.id === newSection.id), 0)
        })
      })
    }
    return
  }

  const sectionId = cursorBlock.dataset.sectionId
  if (!sectionId) return

  const section = store.sections.find((s) => s.id === sectionId)
  if (!section) return

  // Sum content length of all preceding clones with the same sectionId
  let offsetBefore = 0
  const allBlocks = Array.from(el.querySelectorAll('.section-block'))
  for (const block of allBlocks) {
    if ((block as HTMLElement).dataset.sectionId !== sectionId) continue
    if (block === cursorBlock) break
    const blockText = extractTextContent(block as HTMLElement)
    offsetBefore += blockText.length + 1 // +1 for the newline between clones
  }

  const offsetInBlock = getTextOffset(cursorBlock, range.startContainer, range.startOffset)
  const totalOffset = offsetBefore + offsetInBlock

  const newSection = store.splitSection(section.id, totalOffset)
  if (newSection) {
    nextTick(() => {
      buildDOM()
      nextTick(() => {
        setCursorToSection(store.sections.findIndex((s) => s.id === newSection.id), 0)
      })
    })
  }
}

function handleBackspace(event: KeyboardEvent) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return

  const range = sel.getRangeAt(0)
  if (!range.collapsed) return

  const el = editorEl.value
  if (!el) return

  const pos = resolvePosition(el, range.startContainer, range.startOffset)
  if (!pos) return

  const section = store.sections[pos.sectionIndex]
  if (!section) return

  if (section.content === '' && store.sections.length > 1) {
    event.preventDefault()
    const focusIndex = pos.sectionIndex > 0 ? pos.sectionIndex - 1 : 1
    const focusSection = store.sections[focusIndex]
    const focusOffset = focusSection.content.length
    store.removeSectionIfEmpty(section.id)
    nextTick(() => {
      buildDOM()
      nextTick(() => {
        setCursorToSection(Math.min(focusIndex, store.sections.length - 1), focusOffset)
      })
    })
  }
}

function setCursorToSection(sectionIndex: number, offset: number) {
  const el = editorEl.value
  if (!el) return

  const blocks = el.querySelectorAll('.section-block')
  const block = blocks[sectionIndex]
  if (!block) return

  const pos = findNodeAtOffset(block, offset)
  if (!pos) return

  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStart(pos.node, pos.offset)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

function submitThread() {
  if (isActiveTabStreaming.value) return
  const thread = store.getThreadForSubmission()
  if (thread.length === 0) return

  startStreaming()
  nextTick(() => {
    buildDOM()
    scrollToBottom()
  })
}

function scrollToBottom() {
  const el = editorEl.value
  if (el) el.scrollTop = el.scrollHeight
}

function onCopy(event: ClipboardEvent) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return

  const el = editorEl.value
  if (!el) return

  const range = sel.getRangeAt(0)
  const fragment = range.cloneContents()
  let text = ''

  fragment.childNodes.forEach((node) => {
    if (node instanceof HTMLElement) {
      if (node.classList.contains('pill-separator')) {
        const btn = node.querySelector('.pill')
        if (btn) {
          const role = btn.textContent?.trim().toUpperCase()
          if (role === 'USER') {
            text += PILL_USER + '\n'
          } else if (role === 'AGENT') {
            text += PILL_AGENT + '\n'
          }
        }
      } else if (node.classList.contains('section-block')) {
        text += extractTextContent(node as HTMLElement) + '\n'
      } else {
        text += (node.textContent || '') + '\n'
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || ''
    }
  })

  event.preventDefault()
  event.clipboardData?.setData('text/plain', text.trimEnd())
}

function onEditorClick(event: MouseEvent) {
  const el = editorEl.value
  if (!el) return

  if (event.target === el) {
    el.focus()
    setCursorToSection(store.sections.length - 1, store.sections[store.sections.length - 1].content.length)
  }
}

function onPaste(event: ClipboardEvent) {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') || ''
  document.execCommand('insertText', false, text)
}

onMounted(() => {
  buildDOM()
  nextTick(() => {
    const el = editorEl.value
    if (el) {
      el.focus()
      setCursorToSection(store.sections.length - 1, store.sections[store.sections.length - 1].content.length)
    }
  })
})

watch(
  () => settingsStore.showPillSeparators,
  () => {
    nextTick(() => buildDOM())
  }
)

watch(
  () => store.sections.length,
  () => {
    if (!syncing) {
      nextTick(() => buildDOM())
    }
  }
)

watch(
  () => tabStore.activeTabId,
  () => {
    nextTick(() => {
      buildDOM()
      nextTick(() => {
        const el = editorEl.value
        if (el) {
          el.focus()
          setCursorToSection(store.sections.length - 1, store.sections[store.sections.length - 1].content.length)
        }
      })
    })
  }
)

watch(isActiveTabStreaming, (streaming) => {
  if (streaming) {
    const streamRefresh = () => {
      if (!isActiveTabStreaming.value) {
        streamRafId = null
        buildDOM()
        nextTick(() => {
          setCursorToSection(store.sections.length - 1, store.sections[store.sections.length - 1].content.length)
          scrollToBottom()
        })
        return
      }
      buildDOM()
      scrollToBottom()
      streamRafId = requestAnimationFrame(streamRefresh)
    }
    streamRafId = requestAnimationFrame(streamRefresh)
  } else {
    if (streamRafId !== null) {
      cancelAnimationFrame(streamRafId)
      streamRafId = null
    }
    buildDOM()
    nextTick(() => {
      setCursorToSection(store.sections.length - 1, store.sections[store.sections.length - 1].content.length)
    })
  }
})
</script>

<template>
  <div class="editor-container">
    <div
      ref="editorEl"
      class="thread-editor"
      contenteditable="true"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @copy="onCopy"
      @cut="onCopy"
      @paste="onPaste"
      @click="onEditorClick"
    />
    <div v-if="showThinking" class="thinking-indicator">
      <span class="thinking-dot" />
      <span class="thinking-dot" />
      <span class="thinking-dot" />
    </div>
    <div v-if="streamingError && !isActiveTabStreaming" class="stream-error">
      {{ streamingError }}
    </div>
    <button
      v-if="isActiveTabStreaming"
      class="stop-button"
      @click="stopStreaming"
    >
      Stop
    </button>
  </div>
</template>

<style scoped>
.editor-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
}

.thread-editor {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  outline: none;
  color: var(--color-text);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.6;
  min-height: 100%;
  cursor: text;
  position: relative;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.thread-editor.is-empty :deep(.section-block)::before {
  content: 'Start typing…';
  color: var(--color-text);
  opacity: 0.3;
  pointer-events: none;
  position: absolute;
}

.thread-editor :deep(.pill-separator) {
  display: flex;
  align-items: center;
  padding: 4px 0;
  margin: 4px 0 2px;
  user-select: all;
  -webkit-user-select: all;
}

.thread-editor :deep(.pill) {
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

.thread-editor :deep(.pill:hover) {
  opacity: 0.8;
}

.thread-editor :deep(.section-block) {
  padding: 4px 0;
  min-height: 1.6em;
  position: relative;
}

.thread-editor :deep(.section-block--agent) {
  opacity: 0.85;
}

.thinking-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--color-text);
  opacity: 0.4;
  animation: thinking-pulse 1.4s ease-in-out infinite;
}

.thinking-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.thinking-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes thinking-pulse {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 0.6; transform: scale(1); }
}

.stream-error {
  padding: 8px 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  color: #e55;
  font-size: 13px;
}

.stop-button {
  position: absolute;
  bottom: 16px;
  right: 16px;
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg, #1e1e1e);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.15s;
}

.stop-button:hover {
  opacity: 1;
}
</style>
