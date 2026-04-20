<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, computed } from 'vue'
import { useThreadStore } from '../stores/threadStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { usePromptsStore, type Prompt } from '../stores/promptsStore'
import { useStreaming } from '../composables/useStreaming'
import {
  promptNode,
  sectionIsEmpty,
  sectionVisibleText,
  splitContentAt,
  textNode,
} from '../types/content'
import type { ContentNode, PromptNode, Section } from '../types/chat'
import PromptAutocomplete from './PromptAutocomplete.vue'

function sectionTextLength(section: Section): number {
  return sectionVisibleText(section).length
}

const store = useThreadStore()
const settingsStore = useSettingsStore()
const tabStore = useTabStore()
const promptsStore = usePromptsStore()
const { isStreaming, streamingTabId, streamingError, startStreaming, stopStreaming } = useStreaming()
const editorEl = ref<HTMLDivElement | null>(null)
let syncing = false
let streamRafId: number | null = null

// Selection-normalization hints (populated by mousedown / keydown). Module-
// level so `normalizeSelection` can consult them on any selectionchange.
let lastPointerX = 0
let lastPointerY = 0
let lastPointerTs = 0
let lastArrowDirection: 'forward' | 'backward' | null = null

// Slash-command autocomplete state
const AC_TRIGGER = '/prompt '
const acActive = ref(false)
const acQuery = ref('')
const acIndex = ref(0)
const acSectionId = ref<string | null>(null)
const acTriggerOffset = ref(0) // visible-text offset in section where `/prompt ` begins
const acCaretOffset = ref(0) // visible-text offset of caret within section
const acX = ref(0)
const acY = ref(0)

const acFiltered = computed<Prompt[]>(() => {
  if (!acActive.value) return []
  const q = acQuery.value.toLowerCase()
  const list = promptsStore.prompts
  if (!q) return list.slice(0, 20)
  return list.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20)
})

watch(acFiltered, (list) => {
  if (list.length === 0) {
    acIndex.value = 0
    return
  }
  if (acIndex.value >= list.length) acIndex.value = list.length - 1
  if (acIndex.value < 0) acIndex.value = 0
})

function closeAutocomplete() {
  acActive.value = false
  acQuery.value = ''
  acIndex.value = 0
  acSectionId.value = null
}

const isActiveTabStreaming = computed(() => isStreaming.value && streamingTabId.value === tabStore.activeTabId)
const showThinking = computed(() => {
  if (!isActiveTabStreaming.value) return false
  const last = store.sections[store.sections.length - 1]
  return last?.role === 'agent' && sectionIsEmpty(last)
})

let saveDebounce: ReturnType<typeof setTimeout> | null = null
function scheduleSave() {
  if (saveDebounce) clearTimeout(saveDebounce)
  saveDebounce = setTimeout(() => {
    saveDebounce = null
    tabStore.saveActiveTab().catch(() => {})
  }, 600)
}

const PILL_USER = '<dez:pill type="user"/>'
const PILL_AGENT = '<dez:pill type="agent"/>'

function serializePrompt(name: string, body: string): string {
  const escaped = body.replace(/<\/dez:prompt>/g, '<\\/dez:prompt>')
  return `<dez:prompt name="${name}">\n${escaped}\n</dez:prompt>`
}

function appendTextRun(block: HTMLElement, text: string) {
  if (text === '') return
  const lines = text.split('\n')
  lines.forEach((line, idx) => {
    if (idx > 0) block.appendChild(document.createElement('br'))
    if (line) block.appendChild(document.createTextNode(line))
  })
  // If text ends with '\n', append a trailing <br> so the empty final line
  // renders. Read-back (`readSectionNodes`) strips a trailing <br>, so this
  // round-trips symmetrically.
  if (text.endsWith('\n')) block.appendChild(document.createElement('br'))
}

function buildPromptPill(section: Section, node: PromptNode): HTMLSpanElement {
  const pill = document.createElement('span')
  pill.className = 'dez-prompt-pill'
  pill.contentEditable = 'false'
  pill.dataset.nodeId = node.id
  pill.textContent = node.expanded ? '▼' : '▶ ' + node.name
  pill.title = node.expanded ? 'Click to collapse' : 'Click to expand'
  if (node.expanded) pill.classList.add('dez-prompt-pill--expanded')
  pill.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    store.togglePromptExpanded(section.id, node.id)
    nextTick(() => {
      buildDOM()
      // buildDOM's save/restore skips positions inside pills, so we must
      // place the caret explicitly after the rebuilt pill.
      nextTick(() => {
        const el = editorEl.value
        if (!el) return
        const freshPill = el.querySelector(
          `.dez-prompt-pill[data-node-id="${node.id}"]`
        ) as HTMLElement | null
        if (!freshPill || !freshPill.parentNode) return
        let target: Node = freshPill
        if (
          target.nextSibling instanceof HTMLElement &&
          (target.nextSibling as HTMLElement).classList.contains('dez-prompt-body')
        ) {
          target = target.nextSibling
        }
        const parent = target.parentNode
        if (!parent) return
        const idx = Array.from(parent.childNodes).indexOf(target as ChildNode) + 1
        const s = window.getSelection()
        if (s) {
          const r = document.createRange()
          r.setStart(parent, idx)
          r.collapse(true)
          s.removeAllRanges()
          s.addRange(r)
        }
      })
    })
  })
  return pill
}

function buildPromptBody(node: PromptNode): HTMLSpanElement {
  const body = document.createElement('span')
  body.className = 'dez-prompt-body'
  body.dataset.nodeId = node.id
  // Editable inline span (inherits contenteditable=true from editor root).
  const lines = node.body.split('\n')
  lines.forEach((line, idx) => {
    if (idx > 0) body.appendChild(document.createElement('br'))
    if (line) body.appendChild(document.createTextNode(line))
  })
  if (node.body === '') body.appendChild(document.createTextNode('\u200b'))
  return body
}

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

    if (sectionIsEmpty(section)) {
      block.appendChild(document.createElement('br'))
    } else {
      for (const node of section.content) {
        if (node.kind === 'text') {
          if (node.text === '') {
            // Empty text nodes (normalize invariant adds them around pills)
            // must emit a zero-width space so the caret can land on a real
            // text node adjacent to the pill. The ZWSP is stripped on read
            // and counted as zero by the offset walkers.
            block.appendChild(document.createTextNode('\u200b'))
          } else {
            appendTextRun(block, node.text)
          }
        } else {
          block.appendChild(buildPromptPill(section, node))
          if (node.expanded) {
            block.appendChild(buildPromptBody(node))
          }
        }
      }
      // Ensure trailing editable text position exists: if last content node is
      // a prompt and not followed by a text run, the normalize invariant added
      // an empty text node — nothing to do. If the section ends with only a
      // pill and empty text, buildDOM emits no trailing node, so append a <br>
      // to keep the caret landable.
      if (block.lastChild && block.lastChild instanceof HTMLElement &&
          (block.lastChild.classList.contains('dez-prompt-pill') ||
           block.lastChild.classList.contains('dez-prompt-body'))) {
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
  const isEmpty = store.sections.length === 1 && sectionIsEmpty(store.sections[0])
  el.classList.toggle('is-empty', isEmpty)
}

interface SavedSelection {
  sectionIndex: number
  offset: number
  endSectionIndex: number
  endOffset: number
}

function isAtomicPillElement(node: Node | null): node is HTMLElement {
  return !!node && node instanceof HTMLElement &&
    (node.classList.contains('dez-prompt-pill') || node.classList.contains('dez-prompt-body'))
}

function ancestorAtomicPill(node: Node, root: Node): HTMLElement | null {
  let cur: Node | null = node
  while (cur && cur !== root) {
    if (isAtomicPillElement(cur)) return cur
    cur = cur.parentNode
  }
  return null
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

  // If cursor is inside a pill/body subtree, don't track it as a section
  // offset; callers will treat this as "no restorable position".
  if (ancestorAtomicPill(node, block)) return null

  const sectionIndex = parseInt(block.dataset.sectionIndex || '0', 10)
  const textOffset = getTextOffset(block, node, offset)
  return { sectionIndex, offset: textOffset }
}

function makeAtomicWalker(root: Node): TreeWalker {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE && isAtomicPillElement(n as HTMLElement)) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
}

function visibleTextLen(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 0x200b) n++
  return n
}

function getTextOffset(root: Node, targetNode: Node, targetOffset: number): number {
  let offset = 0
  const walker = makeAtomicWalker(root)
  let node: Node | null = walker.currentNode
  while (node) {
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        return offset + visibleTextLen((node.textContent || '').slice(0, targetOffset))
      }
      let count = 0
      for (let i = 0; i < targetOffset; i++) {
        const child = (node as HTMLElement).childNodes[i]
        if (child) {
          if (child.nodeType === Node.TEXT_NODE) {
            count += visibleTextLen(child.textContent || '')
          } else if (child instanceof HTMLElement) {
            if (child.classList.contains('dez-prompt-pill') || child.classList.contains('dez-prompt-body')) {
              // atomic: contributes 0 to section visible text offset
            } else if (child.tagName === 'BR') {
              count += 1
            }
          }
        }
      }
      return offset + count
    }
    if (node.nodeType === Node.TEXT_NODE && node !== root) {
      offset += visibleTextLen(node.textContent || '')
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
  const walker = makeAtomicWalker(root)
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
      const len = visibleTextLen(node.textContent || '')
      if (offset + len >= targetOffset) {
        // Convert visible-offset back into a raw text-node index.
        const remaining = targetOffset - offset
        const raw = node.textContent || ''
        let seen = 0
        let rawIdx = 0
        for (; rawIdx < raw.length; rawIdx++) {
          if (seen >= remaining) break
          if (raw.charCodeAt(rawIdx) !== 0x200b) seen++
        }
        return { node, offset: rawIdx }
      }
      offset += len
    } else if (node instanceof HTMLElement && node.tagName === 'BR') {
      offset += 1
      if (offset >= targetOffset) {
        const next = walker.nextNode()
        if (next && next.nodeType === Node.TEXT_NODE) {
          return { node: next, offset: 0 }
        }
        const parent = node.parentNode
        if (parent) {
          return { node: parent, offset: Array.from(parent.childNodes).indexOf(node) + 1 }
        }
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

/**
 * Read a block's children and produce a fresh ContentNode[]. Prompt pills
 * contribute a PromptNode (identity, name, promptId carried over from the
 * current store section by data-node-id). A trailing `.dez-prompt-body`
 * sibling provides the updated body text for the preceding pill.
 */
function readSectionNodes(block: HTMLElement, section: Section): ContentNode[] {
  const existingById = new Map<string, PromptNode>()
  for (const n of section.content) if (n.kind === 'prompt') existingById.set(n.id, n)

  const out: ContentNode[] = []
  let textBuf = ''
  const flushText = () => {
    if (textBuf.length > 0) {
      out.push(textNode(textBuf))
      textBuf = ''
    }
  }

  const children = Array.from(block.childNodes)
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.nodeType === Node.TEXT_NODE) {
      textBuf += (child.textContent || '').replace(/\u200b/g, '')
      continue
    }
    if (!(child instanceof HTMLElement)) continue

    if (child.tagName === 'BR') {
      // Strip a trailing BR unconditionally — matches the old
      // extractTextContent behavior. Any real newline produced by plain Enter
      // is contributed by the empty orphan <div> sibling that the browser
      // appends after the section-block.
      if (i === children.length - 1) continue
      textBuf += '\n'
      continue
    }

    if (child.classList.contains('dez-prompt-pill')) {
      const nodeId = child.dataset.nodeId || ''
      const existing = existingById.get(nodeId)
      if (!existing) continue
      flushText()
      // If the next sibling is the matching body, read it.
      const next = children[i + 1]
      let body = existing.body
      if (next instanceof HTMLElement && next.classList.contains('dez-prompt-body') &&
          next.dataset.nodeId === nodeId) {
        body = extractPlainText(next)
        i += 1
      }
      out.push({
        kind: 'prompt',
        id: existing.id,
        promptId: existing.promptId,
        name: existing.name,
        body,
        expanded: existing.expanded,
      })
      continue
    }

    if (child.classList.contains('dez-prompt-body')) {
      // Orphan body (pill was deleted but body wasn't) — ignore.
      continue
    }

    // Generic element: treat its text content as text.
    textBuf += extractPlainText(child)
  }
  flushText()
  return out
}

function extractPlainText(root: HTMLElement): string {
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || ''
      return
    }
    if (node instanceof HTMLElement) {
      if (node.tagName === 'BR') {
        text += '\n'
        return
      }
      for (const child of Array.from(node.childNodes)) walk(child)
    }
  }
  for (const child of Array.from(root.childNodes)) walk(child)
  if (text.endsWith('\n')) text = text.slice(0, -1)
  // Strip zero-width spaces used as empty-body placeholders.
  if (text.includes('\u200b')) text = text.replace(/\u200b/g, '')
  return text
}

function readDOMToStore() {
  if (syncing) return
  const el = editorEl.value
  if (!el) return

  // Group direct children by the most recent section-block owner.
  const groupedBlocks = new Map<string, HTMLElement[]>()
  const orphanTextPerSection = new Map<string, string>()
  const sectionOrder: string[] = []
  let currentId: string | null = null

  Array.from(el.childNodes).forEach((node) => {
    if (node instanceof HTMLElement) {
      if (node.classList.contains('pill-separator')) return
      if (node.classList.contains('section-block')) {
        const id = node.dataset.sectionId
        if (!id) return
        currentId = id
        if (!groupedBlocks.has(id)) {
          groupedBlocks.set(id, [])
          sectionOrder.push(id)
        }
        groupedBlocks.get(id)!.push(node)
        return
      }
    }
    if (!currentId) return
    let line = ''
    if (node.nodeType === Node.TEXT_NODE) {
      line = node.textContent || ''
    } else if (node instanceof HTMLElement) {
      line = node.tagName === 'BR' ? '' : extractPlainText(node)
    }
    const existing = orphanTextPerSection.get(currentId)
    orphanTextPerSection.set(currentId, existing === undefined ? line : existing + '\n' + line)
  })

  sectionOrder.forEach((sectionId) => {
    const section = store.sections.find((s) => s.id === sectionId)
    if (!section) return
    const blocks = groupedBlocks.get(sectionId) || []
    let nodes: ContentNode[] = []
    blocks.forEach((block, idx) => {
      if (idx > 0) {
        // Joining two cloned blocks with the same id: insert a newline in text.
        const last = nodes[nodes.length - 1]
        if (last && last.kind === 'text') last.text += '\n'
        else nodes.push(textNode('\n'))
      }
      nodes = nodes.concat(readSectionNodes(block, section))
    })
    const orphanText = orphanTextPerSection.get(sectionId)
    if (orphanText !== undefined) {
      const last = nodes[nodes.length - 1]
      if (last && last.kind === 'text') last.text += '\n' + orphanText
      else nodes.push(textNode('\n' + orphanText))
    }
    store.setSectionContent(sectionId, nodes.length > 0 ? nodes : [textNode('')])
  })
}

function hasOrphanSiblings(el: HTMLElement): boolean {
  return Array.from(el.childNodes).some((node) => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '') !== ''
    if (node instanceof HTMLElement) {
      return !node.classList.contains('section-block') && !node.classList.contains('pill-separator')
    }
    return false
  })
}

function hasClonedSectionBlocks(el: HTMLElement): boolean {
  const seen = new Set<string>()
  for (const node of Array.from(el.children)) {
    if (!(node instanceof HTMLElement)) continue
    if (!node.classList.contains('section-block')) continue
    const id = node.dataset.sectionId
    if (!id) continue
    if (seen.has(id)) return true
    seen.add(id)
  }
  return false
}

function computeStoreSelection(): { sectionId: string; offset: number } | null {
  const el = editorEl.value
  if (!el) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const cursorNode = range.startContainer
  const cursorOffset = range.startOffset

  // If the cursor landed inside an atomic pill/body, we can't express that as
  // a section offset — bail and let the caller skip cursor restoration.
  const inAtomic = ancestorAtomicPill(cursorNode, el)
  if (inAtomic) return null

  let topChild: Node | null = cursorNode
  while (topChild && topChild.parentNode !== el) {
    topChild = topChild.parentNode
  }
  if (!topChild) return null

  let currentId: string | null = null
  let accumulated = 0

  const children = Array.from(el.childNodes)
  for (const node of children) {
    const isTarget = node === topChild

    if (node instanceof HTMLElement && node.classList.contains('pill-separator')) {
      if (isTarget) return null
      continue
    }

    if (node instanceof HTMLElement && node.classList.contains('section-block')) {
      const id = node.dataset.sectionId
      if (!id) {
        if (isTarget) return null
        continue
      }
      if (isTarget) {
        if (id !== currentId) {
          currentId = id
          accumulated = 0
        } else {
          accumulated += 1
        }
        const within = getTextOffset(node, cursorNode, cursorOffset)
        return { sectionId: currentId, offset: accumulated + within }
      }
      if (id !== currentId) {
        currentId = id
        accumulated = blockTextLength(node)
      } else {
        accumulated += 1 + blockTextLength(node)
      }
      continue
    }

    if (isTarget) {
      if (!currentId) return null
      let within = 0
      if (node.nodeType === Node.TEXT_NODE) {
        within = cursorOffset
      } else if (node instanceof HTMLElement) {
        within = node.tagName === 'BR' ? 0 : getTextOffset(node, cursorNode, cursorOffset)
      }
      return { sectionId: currentId, offset: accumulated + 1 + within }
    }
    if (currentId) {
      let text = ''
      if (node.nodeType === Node.TEXT_NODE) {
        text = node.textContent || ''
      } else if (node instanceof HTMLElement) {
        text = node.tagName === 'BR' ? '' : extractPlainText(node)
      }
      accumulated += 1 + text.length
    }
  }
  return null
}

/** Length of a section-block's visible text (excluding pill/body atoms). */
function blockTextLength(block: HTMLElement): number {
  let len = 0
  const walker = makeAtomicWalker(block)
  let node: Node | null = walker.currentNode
  while (node) {
    if (node.nodeType === Node.TEXT_NODE && node !== block) {
      len += visibleTextLen(node.textContent || '')
    } else if (node instanceof HTMLElement && node.tagName === 'BR') {
      len += 1
    }
    node = walker.nextNode()
  }
  return len
}

function isInPromptBody(node: Node): boolean {
  let cur: Node | null = node
  while (cur) {
    if (cur instanceof HTMLElement && cur.classList.contains('dez-prompt-body')) return true
    cur = cur.parentNode
  }
  return false
}

function detectAutocomplete() {
  const el = editorEl.value
  if (!el) return closeAutocomplete()
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return closeAutocomplete()
  const range = sel.getRangeAt(0)
  if (isInPromptBody(range.startContainer)) return closeAutocomplete()

  // Find the section-block ancestor.
  let block: HTMLElement | null = null
  let cur: Node | null = range.startContainer
  while (cur && cur !== el) {
    if (cur instanceof HTMLElement && cur.classList.contains('section-block')) {
      block = cur
      break
    }
    cur = cur.parentNode
  }
  if (!block) return closeAutocomplete()
  const sectionId = block.dataset.sectionId
  if (!sectionId) return closeAutocomplete()
  const section = store.sections.find((s) => s.id === sectionId)
  if (!section) return closeAutocomplete()

  // Caret offset within this section-block's visible text.
  const offsetInBlock = getTextOffset(block, range.startContainer, range.startOffset)

  // Accumulate offset across cloned blocks (same sectionId earlier in DOM).
  let base = 0
  for (const b of Array.from(el.querySelectorAll('.section-block'))) {
    if ((b as HTMLElement).dataset.sectionId !== sectionId) continue
    if (b === block) break
    base += blockTextLength(b as HTMLElement) + 1
  }
  const caretOffset = base + offsetInBlock

  // Look backward through section's visible text for the trigger.
  const visible = sectionVisibleText(section)
  const before = visible.slice(0, caretOffset)
  const triggerIdx = before.lastIndexOf(AC_TRIGGER)
  if (triggerIdx < 0) return closeAutocomplete()

  const query = before.slice(triggerIdx + AC_TRIGGER.length)
  // Abort if query contains whitespace or newline; another trigger already
  // closed. Also abort if there's a newline between triggerIdx and caret.
  if (/[\s\n]/.test(query)) return closeAutocomplete()
  // Require the trigger to be at start-of-line or preceded by whitespace so
  // random substrings like "x/prompt " don't trip it.
  if (triggerIdx > 0) {
    const prev = before[triggerIdx - 1]
    if (prev !== '\n' && prev !== ' ' && prev !== '\t') return closeAutocomplete()
  }

  acActive.value = true
  acQuery.value = query
  acSectionId.value = sectionId
  acTriggerOffset.value = triggerIdx
  acCaretOffset.value = caretOffset

  // Position panel just below the caret.
  const rects = range.getClientRects()
  let rect: DOMRect | null = null
  if (rects.length > 0) rect = rects[0]
  else {
    const container = range.startContainer
    if (container instanceof HTMLElement) rect = container.getBoundingClientRect()
  }
  if (rect) {
    acX.value = rect.left
    acY.value = rect.bottom + 4
  }
}

function acceptPrompt(prompt: Prompt) {
  const sectionId = acSectionId.value
  if (!sectionId) return closeAutocomplete()
  const section = store.sections.find((s) => s.id === sectionId)
  if (!section) return closeAutocomplete()

  // Recompute fresh offsets from the CURRENT store state — do not rely on
  // stale `acTriggerOffset`/`acCaretOffset` which may have been captured
  // before recent DOM→store syncs. Use the current DOM caret to derive the
  // caret's visible-text offset within the section, then search backward
  // for the trigger in the section's current visible text.
  const el = editorEl.value
  if (!el) return closeAutocomplete()

  // Flush any pending DOM edits into the store so `section.content` and the
  // visible-text search reflect exactly what the user sees.
  readDOMToStore()
  const freshSection = store.sections.find((s) => s.id === sectionId)
  if (!freshSection) return closeAutocomplete()

  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return closeAutocomplete()
  const range = sel.getRangeAt(0)

  // Find the section-block containing the caret and derive offset-within-block.
  let block: HTMLElement | null = null
  let cur: Node | null = range.startContainer
  while (cur && cur !== el) {
    if (cur instanceof HTMLElement && cur.classList.contains('section-block')) {
      block = cur
      break
    }
    cur = cur.parentNode
  }
  if (!block || block.dataset.sectionId !== sectionId) return closeAutocomplete()

  const offsetInBlock = getTextOffset(block, range.startContainer, range.startOffset)
  let base = 0
  for (const b of Array.from(el.querySelectorAll('.section-block'))) {
    if ((b as HTMLElement).dataset.sectionId !== sectionId) continue
    if (b === block) break
    base += blockTextLength(b as HTMLElement) + 1
  }
  const caret = base + offsetInBlock

  const visible = sectionVisibleText(freshSection)
  const before = visible.slice(0, caret)
  const trigger = before.lastIndexOf(AC_TRIGGER)
  if (trigger < 0) return closeAutocomplete()

  // Split content at the caret; then trim `/prompt <query>` off the end of
  // the "before" half (length = caret - trigger).
  const [beforeAll, after] = splitContentAt(freshSection.content, caret)
  const trimLen = caret - trigger
  let remaining = trimLen
  const beforeNodes: ContentNode[] = []
  for (const node of beforeAll) beforeNodes.push(node)
  // Walk back through `beforeNodes` text nodes removing `remaining` chars.
  for (let i = beforeNodes.length - 1; i >= 0 && remaining > 0; i--) {
    const n = beforeNodes[i]
    if (n.kind !== 'text') continue
    if (n.text.length >= remaining) {
      beforeNodes[i] = textNode(n.text.slice(0, n.text.length - remaining))
      remaining = 0
      break
    } else {
      remaining -= n.text.length
      beforeNodes[i] = textNode('')
    }
  }

  const newPrompt = promptNode({
    promptId: prompt.id,
    name: prompt.name,
    body: prompt.content,
    expanded: false,
  })

  const combined: ContentNode[] = [...beforeNodes, newPrompt, ...after]
  const newSectionId = freshSection.id
  const promptNodeId = newPrompt.id
  store.setSectionContent(newSectionId, combined)

  closeAutocomplete()

  nextTick(() => {
    buildDOM()
    nextTick(() => {
      // Place caret in the text node immediately after the new pill.
      const el = editorEl.value
      if (!el) return
      const blocks = Array.from(el.querySelectorAll('.section-block'))
      for (const b of blocks) {
        if ((b as HTMLElement).dataset.sectionId !== newSectionId) continue
        const pill = b.querySelector(`.dez-prompt-pill[data-node-id="${promptNodeId}"]`)
        if (pill) {
          // The next sibling should be the caret-landable text (post-normalize).
          let target: Node | null = pill.nextSibling
          while (target && target.nodeType !== Node.TEXT_NODE) {
            if (target instanceof HTMLElement && target.classList.contains('dez-prompt-body')) {
              target = target.nextSibling
              continue
            }
            break
          }
          const sel = window.getSelection()
          if (!sel) return
          const range = document.createRange()
          if (target && target.nodeType === Node.TEXT_NODE) {
            range.setStart(target, 0)
          } else if (pill.parentNode) {
            const parent = pill.parentNode
            const idx = Array.from(parent.childNodes).indexOf(pill as ChildNode) + 1
            range.setStart(parent, idx)
          } else return
          range.collapse(true)
          sel.removeAllRanges()
          sel.addRange(range)
          return
        }
      }
    })
  })
}

function onSelectionChange() {
  if (syncing) return
  normalizeSelection()
  if (acActive.value) {
    // Re-run detection; if caret moved out of trigger region, it will close.
    detectAutocomplete()
  }
}

/**
 * Model-first selection reconciler. Runs on every selectionchange and snaps
 * the caret off ambiguous positions introduced by our ZWSP-anchored pill
 * structure. Borrows the idea from CodeMirror 6 / Lexical: normalize once
 * in a central place instead of patching every click/arrow handler.
 */
function normalizeSelection() {
  const el = editorEl.value
  if (!el) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return

  const node = range.startContainer
  const offset = range.startOffset

  // Helper to commit a new collapsed selection at (parent, index) or a text
  // node + offset. Uses parent+childIndex where possible to avoid landing
  // inside ZWSP text nodes at all.
  const setCaret = (anchor: Node, anchorOffset: number) => {
    const r = document.createRange()
    r.setStart(anchor, anchorOffset)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }

  // --- Rule 2: caret inside a contenteditable=false atomic (pill). Push
  // out on the side hinted by pointer X (or forward by default).
  const atomic = ancestorAtomicPill(node, el)
  if (atomic && atomic.classList.contains('dez-prompt-pill') && atomic.parentNode) {
    const parent = atomic.parentNode
    const pillRect = atomic.getBoundingClientRect()
    const forward = lastArrowDirection === 'forward' ||
      (lastArrowDirection === null && lastPointerX >= (pillRect.left + pillRect.right) / 2)
    const idx = Array.from(parent.childNodes).indexOf(atomic as ChildNode)
    setCaret(parent, forward ? idx + 1 : idx)
    return
  }

  // --- Rule 1b: caret at element-level position (parent, childIndex) that
  // is visually "before a pill" — the child at offset is a ZWSP-only text
  // node followed by a pill, or is a pill itself. Browsers sometimes place
  // the caret here instead of inside the adjacent text node.
  if (node.nodeType === Node.ELEMENT_NODE && node.parentNode) {
    const childAt = offset < node.childNodes.length ? node.childNodes[offset] : null

    let pillAhead: HTMLElement | null = null
    if (childAt instanceof HTMLElement && childAt.classList.contains('dez-prompt-pill')) {
      pillAhead = childAt
    } else if (childAt && childAt.nodeType === Node.TEXT_NODE &&
               (childAt.textContent || '').replace(/\u200b/g, '') === '') {
      pillAhead = findAdjacentPill(childAt, 'forward')
    }

    if (pillAhead) {
      const pillRect = pillAhead.getBoundingClientRect()
      const forward = lastArrowDirection === 'forward' ||
        (lastArrowDirection === null &&
          withinPointerRecency() &&
          (lastPointerY > pillRect.bottom || lastPointerX >= pillRect.right))
      if (forward) {
        let target: Node = pillAhead
        if (
          target.nextSibling instanceof HTMLElement &&
          (target.nextSibling as HTMLElement).classList.contains('dez-prompt-body')
        ) {
          target = target.nextSibling
        }
        const parent = target.parentNode
        if (parent) {
          const idx = Array.from(parent.childNodes).indexOf(target as ChildNode) + 1
          setCaret(parent, idx)
          return
        }
      } else if (lastArrowDirection === 'backward') {
        const parent = pillAhead.parentNode
        if (parent) {
          const idx = Array.from(parent.childNodes).indexOf(pillAhead as ChildNode)
          setCaret(parent, idx)
          return
        }
      }
    }
  }

  // --- Rule 1: caret inside a text node whose pre-offset content is all
  // ZWSP (or empty) AND a pill sibling follows (skipping empty/ZWSP
  // siblings). Snap to after-pill (forward hint) or before-the-ZWSP-run
  // (backward hint).
  if (node.nodeType === Node.TEXT_NODE) {
    const raw = node.textContent || ''
    const pre = raw.slice(0, offset)
    const preIsZwspOnly = pre.replace(/\u200b/g, '') === ''
    const post = raw.slice(offset)
    const postIsZwspOnly = post.replace(/\u200b/g, '') === ''

    // Find nearest non-empty non-atomic siblings in both directions.
    const nextPill = findAdjacentPill(node, 'forward')
    const prevPill = findAdjacentPill(node, 'backward')

    if (preIsZwspOnly && nextPill && node.parentNode) {
      // Caret visually at the start of a ZWSP-run that precedes a pill.
      // Decide forward vs backward.
      const pillRect = nextPill.getBoundingClientRect()
      const forward = lastArrowDirection === 'forward' ||
        (lastArrowDirection === null &&
          withinPointerRecency() &&
          (lastPointerY > pillRect.bottom || lastPointerX >= pillRect.right))
      if (forward) {
        // Caret goes AFTER the pill (skip expanded body if any).
        let target: Node = nextPill
        if (
          target.nextSibling instanceof HTMLElement &&
          (target.nextSibling as HTMLElement).classList.contains('dez-prompt-body')
        ) {
          target = target.nextSibling
        }
        const parent = target.parentNode
        if (parent) {
          const idx = Array.from(parent.childNodes).indexOf(target as ChildNode) + 1
          setCaret(parent, idx)
          return
        }
      } else if (lastArrowDirection === 'backward') {
        // Caret goes BEFORE the ZWSP text node (to any preceding text or
        // the block start).
        const parent = node.parentNode
        if (parent) {
          const idx = Array.from(parent.childNodes).indexOf(node as ChildNode)
          setCaret(parent, idx)
          return
        }
      }
    }

    if (postIsZwspOnly && prevPill && node.parentNode) {
      // Caret at end of a ZWSP-run after a pill. Decide forward vs back.
      const pillRect = prevPill.getBoundingClientRect()
      const backward = lastArrowDirection === 'backward' ||
        (lastArrowDirection === null &&
          withinPointerRecency() &&
          lastPointerX < pillRect.left &&
          lastPointerY <= pillRect.bottom)
      if (backward) {
        const parent = prevPill.parentNode
        if (parent) {
          const idx = Array.from(parent.childNodes).indexOf(prevPill as ChildNode)
          setCaret(parent, idx)
          return
        }
      } else if (lastArrowDirection === 'forward') {
        const parent = node.parentNode
        if (parent) {
          const idx = Array.from(parent.childNodes).indexOf(node as ChildNode) + 1
          setCaret(parent, idx)
          return
        }
      }
    }
  }

  // --- Rule 3: caret at (section-block, 0) but last pointer Y was below
  // the block's last rendered content rect — snap to block end.
  if (
    node instanceof HTMLElement &&
    node.classList.contains('section-block') &&
    offset === 0 &&
    withinPointerRecency()
  ) {
    const probe = document.createRange()
    probe.selectNodeContents(node)
    probe.collapse(false)
    const rects = probe.getClientRects()
    const lastRect = rects.length > 0 ? rects[rects.length - 1] : node.getBoundingClientRect()
    if (lastPointerY > lastRect.bottom) {
      sel.removeAllRanges()
      sel.addRange(probe)
    }
  }
}

/** Is the last-pointer hint recent enough to be trusted? */
function withinPointerRecency(): boolean {
  return performance.now() - lastPointerTs < 400
}

/**
 * Walk siblings from `from` in `dir`, skipping empty/ZWSP-only text nodes
 * and expanded prompt bodies, and return the next `dez-prompt-pill` if it's
 * the immediate non-trivial neighbor (else null).
 */
function findAdjacentPill(from: Node, dir: 'forward' | 'backward'): HTMLElement | null {
  let sib: Node | null = dir === 'forward' ? from.nextSibling : from.previousSibling
  while (sib) {
    if (sib.nodeType === Node.TEXT_NODE) {
      const t = sib.textContent || ''
      if (t.replace(/\u200b/g, '') === '') {
        sib = dir === 'forward' ? sib.nextSibling : sib.previousSibling
        continue
      }
      return null
    }
    if (sib instanceof HTMLElement) {
      if (sib.classList.contains('dez-prompt-pill')) return sib
      if (sib.classList.contains('dez-prompt-body')) {
        sib = dir === 'forward' ? sib.nextSibling : sib.previousSibling
        continue
      }
      if (sib.tagName === 'BR') {
        // A <br> is a visible line break — the pill isn't on the same run.
        return null
      }
      return null
    }
    sib = dir === 'forward' ? sib.nextSibling : sib.previousSibling
  }
  return null
}

/**
 * True if the caret is collapsed at a position where the first non-trivial
 * (non-empty / non-ZWSP) content of the current section-block following it
 * is a `dez-prompt-pill`. Used to intercept plain Enter so the pill moves
 * to a new section instead of the browser inserting a stray <br> above it.
 */
function isCaretBeforeLeadingPill(): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
  const el = editorEl.value
  if (!el) return false

  const range = sel.getRangeAt(0)
  const startNode = range.startContainer
  const startOffset = range.startOffset

  // Locate the enclosing section-block.
  let block: HTMLElement | null = null
  let cur: Node | null = startNode
  while (cur && cur !== el) {
    if (cur instanceof HTMLElement && cur.classList.contains('section-block')) {
      block = cur
      break
    }
    cur = cur.parentNode
  }
  if (!block) return false

  // Don't intercept if caret is inside a prompt body.
  if (isInPromptBody(startNode)) return false

  // Determine the starting child index of the block from which to scan
  // forward.  If the caret is on the block itself, it's startOffset.  If
  // the caret is inside a text-node child whose prefix up to startOffset is
  // empty / ZWSP-only, scan from the index of that text node onward.
  let scanFromIdx: number
  if (startNode === block) {
    scanFromIdx = startOffset
  } else if (startNode.nodeType === Node.TEXT_NODE && startNode.parentNode === block) {
    const prefix = (startNode.textContent || '').slice(0, startOffset)
    if (prefix.replace(/\u200b/g, '') !== '') return false
    scanFromIdx = Array.from(block.childNodes).indexOf(startNode as ChildNode)
    if (scanFromIdx < 0) return false
  } else {
    return false
  }

  const children = Array.from(block.childNodes)
  for (let i = scanFromIdx; i < children.length; i++) {
    const child = children[i]
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || '').replace(/\u200b/g, '') === '') continue
      return false
    }
    if (child instanceof HTMLElement) {
      if (child.classList.contains('dez-prompt-pill')) return true
      if (child.classList.contains('dez-prompt-body')) continue
      return false
    }
    return false
  }
  return false
}

function onInput(event: Event) {
  const el = editorEl.value
  const target = (event.target as Node) ?? null
  // Edits inside a prompt-body span update only that node's body; no DOM
  // restructuring is needed, so we can take a fast path that skips rebuild
  // detection.
  const sel = window.getSelection()
  const inBody = !!sel && sel.rangeCount > 0 && isInPromptBody(sel.getRangeAt(0).startContainer)

  const needsRebuild = !inBody && !!el && (hasOrphanSiblings(el) || hasClonedSectionBlocks(el))
  const storeSel = needsRebuild ? computeStoreSelection() : null
  readDOMToStore()
  if (el) {
    updateEmptyState(el)
    if (!el.querySelector('.section-block')) {
      buildDOM()
      nextTick(() => {
        if (el) {
          el.focus()
          setCursorToSection(store.sections.length - 1, sectionTextLength(store.sections[store.sections.length - 1]))
        }
      })
    } else if (needsRebuild) {
      nextTick(() => {
        buildDOM()
        nextTick(() => {
          if (storeSel) {
            const idx = store.sections.findIndex((s) => s.id === storeSel.sectionId)
            if (idx >= 0) {
              const section = store.sections[idx]
              const clamped = Math.min(storeSel.offset, sectionTextLength(section))
              setCursorToSection(idx, clamped)
            }
          }
        })
      })
    }
  }
  void target
  scheduleSave()
  nextTick(() => detectAutocomplete())
}

function onKeydown(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey

  // Track arrow-key direction as a hint for normalizeSelection.
  if (event.key === 'ArrowRight' || event.key === 'End' ||
      event.key === 'ArrowDown' || event.key === 'PageDown') {
    lastArrowDirection = 'forward'
  } else if (event.key === 'ArrowLeft' || event.key === 'Home' ||
             event.key === 'ArrowUp' || event.key === 'PageUp') {
    lastArrowDirection = 'backward'
  } else {
    lastArrowDirection = null
  }

  // Autocomplete intercepts navigation + accept keys first.
  if (acActive.value && acFiltered.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      acIndex.value = (acIndex.value + 1) % acFiltered.value.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      acIndex.value = (acIndex.value - 1 + acFiltered.value.length) % acFiltered.value.length
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAutocomplete()
      return
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !mod && !event.shiftKey)) {
      event.preventDefault()
      const picked = acFiltered.value[acIndex.value]
      if (picked) acceptPrompt(picked)
      return
    }
  }

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

  // Plain Enter immediately before a pill at the start of a section: split
  // the section so the pill moves to a new section below. Without this the
  // browser inserts a stray <br> above the pill.
  if (event.key === 'Enter' && !mod && !event.shiftKey) {
    if (isCaretBeforeLeadingPill()) {
      event.preventDefault()
      insertNewSection()
      return
    }
  }

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

  // Disallow splitting from inside a prompt body.
  if (isInPromptBody(range.startContainer)) return

  readDOMToStore()

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
    const lastSection = store.sections[store.sections.length - 1]
    if (!lastSection) return
    const cursorOffset = getTextOffset(el, range.startContainer, range.startOffset)
    const splitAt = Math.min(cursorOffset, sectionTextLength(lastSection))
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

  let offsetBefore = 0
  const allBlocks = Array.from(el.querySelectorAll('.section-block'))
  for (const block of allBlocks) {
    if ((block as HTMLElement).dataset.sectionId !== sectionId) continue
    if (block === cursorBlock) break
    offsetBefore += blockTextLength(block as HTMLElement) + 1
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

  if (isInPromptBody(range.startContainer)) return

  const pos = resolvePosition(el, range.startContainer, range.startOffset)
  if (!pos) return

  const section = store.sections[pos.sectionIndex]
  if (!section) return

  if (sectionIsEmpty(section) && store.sections.length > 1) {
    event.preventDefault()
    const focusIndex = pos.sectionIndex > 0 ? pos.sectionIndex - 1 : 1
    const focusSection = store.sections[focusIndex]
    const focusOffset = sectionTextLength(focusSection)
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
  const text = serializeFragment(fragment)

  event.preventDefault()
  event.clipboardData?.setData('text/plain', text.trimEnd())
}

function serializeFragment(fragment: DocumentFragment | HTMLElement): string {
  let out = ''
  const nodes = Array.from(fragment.childNodes)
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent || '').replace(/\u200b/g, '')
      continue
    }
    if (!(node instanceof HTMLElement)) continue

    if (node.classList.contains('pill-separator')) {
      const btn = node.querySelector('.pill')
      const role = btn?.textContent?.trim().toUpperCase()
      if (role === 'USER') out += PILL_USER + '\n'
      else if (role === 'AGENT') out += PILL_AGENT + '\n'
      continue
    }

    if (node.classList.contains('section-block')) {
      out += serializeBlock(node) + '\n'
      continue
    }

    if (node.classList.contains('dez-prompt-pill')) {
      const nodeId = node.dataset.nodeId || ''
      const info = findPromptInfo(nodeId)
      if (info) out += serializePrompt(info.name, info.body)
      continue
    }

    if (node.classList.contains('dez-prompt-body')) continue

    if (node.tagName === 'BR') {
      out += '\n'
      continue
    }

    out += serializeBlock(node)
  }
  return out
}

function serializeBlock(block: HTMLElement): string {
  let out = ''
  const children = Array.from(block.childNodes)
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.nodeType === Node.TEXT_NODE) {
      out += (child.textContent || '').replace(/\u200b/g, '')
      continue
    }
    if (!(child instanceof HTMLElement)) continue
    if (child.tagName === 'BR') {
      if (i === children.length - 1) continue
      out += '\n'
      continue
    }
    if (child.classList.contains('dez-prompt-pill')) {
      const nodeId = child.dataset.nodeId || ''
      const next = children[i + 1]
      let body = ''
      let name = ''
      const info = findPromptInfo(nodeId)
      if (info) {
        name = info.name
        body = info.body
      }
      if (next instanceof HTMLElement && next.classList.contains('dez-prompt-body') &&
          next.dataset.nodeId === nodeId) {
        body = extractPlainText(next)
        i += 1
      }
      out += serializePrompt(name, body)
      continue
    }
    if (child.classList.contains('dez-prompt-body')) continue
    out += extractPlainText(child)
  }
  return out
}

function findPromptInfo(nodeId: string): { name: string; body: string } | null {
  for (const section of store.sections) {
    for (const n of section.content) {
      if (n.kind === 'prompt' && n.id === nodeId) return { name: n.name, body: n.body }
    }
  }
  return null
}

function onEditorMousedown(event: MouseEvent) {
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  lastPointerTs = performance.now()
  lastArrowDirection = null
}

function onEditorClick(event: MouseEvent) {
  const el = editorEl.value
  if (!el) return

  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) return

  if (event.target === el) {
    el.focus()
    const blocks = el.querySelectorAll('.section-block')
    const lastBlock = blocks[blocks.length - 1] as HTMLElement | undefined
    if (lastBlock) {
      const range = document.createRange()
      range.selectNodeContents(lastBlock)
      range.collapse(false)
      const sel2 = window.getSelection()
      if (sel2) {
        sel2.removeAllRanges()
        sel2.addRange(range)
      }
    }
    return
  }

  // All other click-placement edge cases (click past right edge of a pill,
  // click in empty padding below the last content rect) are handled
  // centrally by `normalizeSelection` via the selectionchange listener.
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
      setCursorToSection(store.sections.length - 1, sectionTextLength(store.sections[store.sections.length - 1]))
    }
  })
  document.addEventListener('selectionchange', onSelectionChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', onSelectionChange)
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

// Rebuild when the *structure* of prompt nodes changes (insert/remove pill,
// expand/collapse). Text edits don't change this signature, so typing doesn't
// trigger a rebuild cascade.
const promptStructureSignature = computed(() => {
  return store.sections
    .map((s) => {
      const pills = s.content
        .filter((n): n is Extract<ContentNode, { kind: 'prompt' }> => n.kind === 'prompt')
        .map((p) => `${p.id}:${p.expanded ? 'E' : 'C'}`)
        .join(',')
      return `${s.id}[${pills}]`
    })
    .join('|')
})

watch(promptStructureSignature, () => {
  if (!syncing) {
    nextTick(() => buildDOM())
  }
})

watch(
  () => tabStore.activeTabId,
  () => {
    closeAutocomplete()
    nextTick(() => {
      buildDOM()
      nextTick(() => {
        const el = editorEl.value
        if (el) {
          el.focus()
          setCursorToSection(store.sections.length - 1, sectionTextLength(store.sections[store.sections.length - 1]))
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
          setCursorToSection(store.sections.length - 1, sectionTextLength(store.sections[store.sections.length - 1]))
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
      setCursorToSection(store.sections.length - 1, sectionTextLength(store.sections[store.sections.length - 1]))
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
      @mousedown="onEditorMousedown"
      @copy="onCopy"
      @cut="onCopy"
      @paste="onPaste"
      @click="onEditorClick"
      @blur="closeAutocomplete"
    />
    <PromptAutocomplete
      v-if="acActive && acFiltered.length > 0"
      :prompts="acFiltered"
      :selected-index="acIndex"
      :x="acX"
      :y="acY"
      @select="acceptPrompt"
      @hover="(i: number) => (acIndex = i)"
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
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
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

.thread-editor :deep(.dez-prompt-pill) {
  display: inline-block;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
  padding: 1px 8px;
  margin: 0 2px;
  border-radius: 8px;
  background-color: var(--color-border);
  opacity: 0.85;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  vertical-align: baseline;
  transition: opacity 0.15s;
}

.thread-editor :deep(.dez-prompt-pill:hover) {
  opacity: 1;
}

.thread-editor :deep(.dez-prompt-pill--expanded) {
  background-color: transparent;
  padding: 0 4px 0 0;
  margin: 0;
  border-radius: 0;
  opacity: 0.7;
}

.thread-editor :deep(.dez-prompt-body) {
  display: inline;
  margin: 0;
  padding: 0;
  background-color: transparent;
  border: none;
  font-family: inherit;
  font-size: inherit;
  white-space: pre-wrap;
  outline: none;
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
