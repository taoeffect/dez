<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { shortcutKeyText } from '../../model/shortcuts'

const { tabs, activeTabId, tabActivity, shortcuts } = useModelState()
const tabElements = ref(new Map<string, HTMLElement>())

function setTabElement(tabId: string, element: unknown) {
  if (element instanceof HTMLElement) {
    tabElements.value.set(tabId, element)
  } else {
    tabElements.value.delete(tabId)
  }
}

async function scrollActiveTabIntoView() {
  await nextTick()

  if (!activeTabId.value) return

  tabElements.value.get(activeTabId.value)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function onWheel(e: WheelEvent) {
  const target = e.currentTarget as HTMLElement
  const maxScrollLeft = target.scrollWidth - target.clientWidth

  if (maxScrollLeft <= 0) return

  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, target.scrollLeft + delta))

  if (nextScrollLeft === target.scrollLeft) return

  e.preventDefault()
  target.scrollLeft = nextScrollLeft
}

function closeTab(tabId: string) {
  void sbp('dez.controller/closeTab', tabId)
}

function onMiddleClick(e: MouseEvent, tabId: string) {
  if (e.button === 1) {
    e.preventDefault()
    closeTab(tabId)
  }
}

// Tab drag: pointer events, not HTML5 drag and drop, so it works the same
// in WebKitGTK and WKWebView, whatever Tauri's `dragDropEnabled` is. During
// a drag the bar shows a preview order; the model order changes once, at
// the drop, so the app state is saved once.
const DRAG_THRESHOLD_PX = 4
const EDGE_SCROLL_ZONE_PX = 24
const EDGE_SCROLL_MAX_STEP_PX = 12

interface TabPress {
  pointerId: number
  tabId: string
  startX: number
  startY: number
  clientX: number
  // The pointer x minus the left edge of the tab at the press: the dragged
  // tab keeps this distance to the pointer.
  grabOffsetX: number
  dragging: boolean
}

let press: TabPress | null = null
let edgeScrollFrame = 0
const stripElement = ref<HTMLElement | null>(null)
const draggedTabId = ref<string | null>(null)
const previewIndex = ref(0)
const dragOffsetX = ref(0)

const displayTabs = computed(() => {
  const dragged = tabs.value.find((tab) => tab.id === draggedTabId.value)
  if (!dragged) return tabs.value
  const order = tabs.value.filter((tab) => tab !== dragged)
  order.splice(previewIndex.value, 0, dragged)
  return order
})

// A press with the primary button on a tab, not on its close button, can
// become a drag. Until the pointer moves past the threshold it is a plain
// click, which switches tabs.
function onTabPointerDown(e: PointerEvent, tabId: string) {
  if (e.button !== 0 || (e.target as Element).closest('.tab-close')) return
  const element = tabElements.value.get(tabId)
  if (!element) return
  endPress(false)
  press = {
    pointerId: e.pointerId,
    tabId,
    startX: e.clientX,
    startY: e.clientY,
    clientX: e.clientX,
    grabOffsetX: e.clientX - element.getBoundingClientRect().left,
    dragging: false,
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('selectstart', preventSelectStart)
}

// WebKit lets a press on `user-select: none` content, such as a tab, start a
// text selection: at the first move over selectable text it fires
// `selectstart` on that text, so a tab dragged down into the thread selected
// its text. A canceled `selectstart` ends text selection for the rest of the
// press. A `preventDefault` on the press would also stop it, but it would
// keep the focus in the editor when a tab is clicked.
// https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/EventHandler.cpp
// (EventHandler::updateSelectionForMouseDrag)
function preventSelectStart(e: Event) {
  e.preventDefault()
}

function onPointerMove(e: PointerEvent) {
  if (e.pointerId !== press?.pointerId) return
  // No button down: the release was missed (it happened outside the window
  // before the drag took the pointer capture).
  if ((e.buttons & 1) === 0) {
    endPress(false)
    return
  }
  press.clientX = e.clientX
  if (!press.dragging) {
    if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) <= DRAG_THRESHOLD_PX) return
    startDrag(press)
  }
  void updateDrag()
}

function onPointerUp(e: PointerEvent) {
  if (e.pointerId === press?.pointerId) endPress(true)
}

function onPointerCancel(e: PointerEvent) {
  if (e.pointerId === press?.pointerId) endPress(false)
}

// The capture goes to the strip, not to the tab: the preview order moves
// the tab element in the DOM (remove, then insert), and an element that
// leaves the document loses its pointer capture. The click after the drop
// then targets the strip, not the tab, so the drag makes the tab active
// itself, as browser tab bars do.
// https://github.com/w3c/pointerevents/issues/487
function startDrag(state: TabPress) {
  state.dragging = true
  stripElement.value?.setPointerCapture(state.pointerId)
  previewIndex.value = tabs.value.findIndex((tab) => tab.id === state.tabId)
  draggedTabId.value = state.tabId
  sbp('dez.model/tabs/switch', state.tabId)
  edgeScrollFrame = requestAnimationFrame(edgeScroll)
}

// Puts the dragged tab under the pointer: the preview index is the number
// of other tabs whose middle is left of the pointer, and a translateX moves
// the tab from that slot to the pointer, inside the ends of the strip.
// Positions are in strip content px, which a scroll does not change.
// `offsetLeft` (the strip is `position: relative`) ignores the translateX
// and is the slot itself.
async function updateDrag() {
  const state = press
  const strip = stripElement.value
  if (!state?.dragging || !strip) return
  const pointerX = state.clientX - strip.getBoundingClientRect().left + strip.scrollLeft
  const index = displayTabs.value.filter((tab) => {
    const element = tabElements.value.get(tab.id)
    return tab.id !== state.tabId && element !== undefined && element.offsetLeft + element.offsetWidth / 2 < pointerX
  }).length
  if (index !== previewIndex.value) {
    previewIndex.value = index
    await nextTick()
    if (press !== state) return
  }
  const element = tabElements.value.get(state.tabId)
  const last = tabElements.value.get(displayTabs.value[displayTabs.value.length - 1].id)
  if (!element || !last) return
  const maxLeft = last.offsetLeft + last.offsetWidth - element.offsetWidth
  dragOffsetX.value = Math.max(0, Math.min(pointerX - state.grabOffsetX, maxLeft)) - element.offsetLeft
}

// While the pointer is near or past an end of a strip that scrolls, the
// strip scrolls each frame, faster closer to the end, so a tab can move to
// a place out of view.
function edgeScroll() {
  const state = press
  const strip = stripElement.value
  if (!state?.dragging || !strip) return
  edgeScrollFrame = requestAnimationFrame(edgeScroll)
  const rect = strip.getBoundingClientRect()
  const intoLeft = rect.left + EDGE_SCROLL_ZONE_PX - state.clientX
  const intoRight = state.clientX - (rect.right - EDGE_SCROLL_ZONE_PX)
  const into = Math.max(intoLeft, intoRight)
  if (into <= 0) return
  const step = Math.min(EDGE_SCROLL_MAX_STEP_PX, Math.ceil(into / EDGE_SCROLL_ZONE_PX * EDGE_SCROLL_MAX_STEP_PX))
  const scrollLeft = strip.scrollLeft
  strip.scrollLeft += intoLeft > intoRight ? -step : step
  if (strip.scrollLeft !== scrollLeft) void updateDrag()
}

// Ends a press. A drag that ends with `commit` moves the tab to the preview
// index; else the tab goes back to its place.
function endPress(commit: boolean) {
  const state = press
  press = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('selectstart', preventSelectStart)
  cancelAnimationFrame(edgeScrollFrame)
  if (!state?.dragging) return
  if (commit) sbp('dez.model/tabs/move', state.tabId, previewIndex.value)
  draggedTabId.value = null
  dragOffsetX.value = 0
}

function onLostPointerCapture(e: PointerEvent) {
  if (e.pointerId === press?.pointerId && press.dragging) endPress(false)
}

onBeforeUnmount(() => endPress(false))

watch(
  () => [activeTabId.value, tabs.value.length],
  scrollActiveTabIntoView,
  { immediate: true },
)
</script>

<template>
  <div class="tab-bar-tabs">
    <!-- The `+` stays outside this scrolling strip: as its last item, it
         scrolled out of view when a new tab was scrolled into view. -->
    <div
      ref="stripElement"
      class="tab-strip"
      :class="{ 'tab-strip--dragging': draggedTabId }"
      @wheel="onWheel"
      @lostpointercapture="onLostPointerCapture"
    >
      <div
        v-for="tab in displayTabs"
        :key="tab.id"
        :ref="(element) => setTabElement(tab.id, element)"
        class="tab"
        :class="{
          'tab--active': tab.id === activeTabId,
          'tab--busy': tabActivity[tab.id] === 'busy',
          'tab--done': tabActivity[tab.id] === 'done',
          'tab--dragging': tab.id === draggedTabId,
        }"
        :style="tab.id === draggedTabId ? { transform: `translateX(${dragOffsetX}px)` } : undefined"
        @click="sbp('dez.model/tabs/switch', tab.id)"
        @mousedown="onMiddleClick($event, tab.id)"
        @pointerdown="onTabPointerDown($event, tab.id)"
      >
        <span class="tab-title">{{ tab.title }}</span>
        <button
          v-if="tabs.length > 1"
          class="tab-close"
          title="Close tab"
          @click.stop="closeTab(tab.id)"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>
    <button class="tab-new" :title="`New tab (${shortcutKeyText(shortcuts, 'newTab')})`" @click="sbp('dez.controller/newTab')">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    </button>
  </div>
</template>

<style scoped>
.tab-bar-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

/* The strip is as wide as its tabs, so the `+` sits right after the last
   tab. When the tabs do not fit, the strip shrinks and scrolls, and the `+`
   stays at the right end of the bar. `position: relative` makes the strip
   the offset parent of the tabs, so a tab drag reads slots with
   `offsetLeft`. */
.tab-strip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-strip::-webkit-scrollbar {
  display: none;
}

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  opacity: 0.5;
  transition: opacity 0.15s, background 0.15s;
  flex-shrink: 0;
  max-width: 160px;
}

.tab:hover {
  opacity: 0.8;
  background: rgba(128, 128, 128, 0.1);
}

.tab--active {
  opacity: 1;
  background: rgba(128, 128, 128, 0.15);
}

/* Reply activity colors (dez.model/tabs/activity). A tab in the background
   dims only its title here, not the whole tab as `.tab` does, so the color
   keeps its full strength. `.tab:hover` has the same specificity as
   `.tab.tab--busy`, so the `:hover` selectors keep the color on a hover
   whatever the rule order. */
.tab.tab--busy,
.tab.tab--busy:hover,
.tab.tab--done,
.tab.tab--done:hover {
  opacity: 1;
}

.tab.tab--busy,
.tab.tab--busy:hover {
  background: var(--color-tab-busy);
}

.tab.tab--done,
.tab.tab--done:hover {
  background: var(--color-tab-done);
}

.tab--busy:not(.tab--active) .tab-title,
.tab--done:not(.tab--active) .tab-title {
  opacity: 0.6;
}

/* The dragged tab passes over its neighbors, so it is on top, fully
   opaque, and has an opaque background: the active gray over the bar color
   (a busy color is opaque already). The strip clips an outer shadow, so
   the outline is inset. */
.tab.tab--dragging {
  position: relative;
  z-index: 1;
  opacity: 1;
  box-shadow: inset 0 0 0 1px var(--color-border);
}

.tab.tab--dragging:not(.tab--busy) {
  background: linear-gradient(rgba(128, 128, 128, 0.15), rgba(128, 128, 128, 0.15)), var(--color-tab-bar);
}

.tab-strip--dragging,
.tab-strip--dragging .tab {
  cursor: grabbing;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.tab-close {
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  opacity: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.1s, background 0.1s;
}

.tab:hover .tab-close {
  opacity: 0.5;
}

.tab-close:hover {
  opacity: 1 !important;
  background: rgba(128, 128, 128, 0.2);
}

.tab-new {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  opacity: 0.4;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.tab-new:hover {
  opacity: 0.8;
}
</style>
