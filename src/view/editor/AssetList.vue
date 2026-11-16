<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import { Virtualizer } from 'virtua/vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Directive } from 'vue'
import { measureLineHeights } from '../thread/editorMeasure'
import { destroyPlayer, updatePlayer } from './media'
import type { PanelAssetRow } from './toolCalls'

// A long list of the assets of a panel (`renderAssetList` in toolCalls.ts):
// the kept assets of a compaction can be some hundred images and clips. A
// player loads its whole file, and holds a pipeline with a connection to
// the sound server. With every player of such a list at once, the open was
// slow, and the sound server refused the connections past some count: each
// refused player showed the card of a clip that this computer cannot play.
// So the list has a scroll box of its own, and only the rows near its
// visible part have an element (virtua). A row that leaves that part frees
// its player, but a row whose clip plays or fills the screen stays. A row
// that comes back gets a new player.

// `rows` is not readonly, as virtua's `data` is not.
const props = defineProps<{ view: EditorView, rows: PanelAssetRow[] }>()

const ROW_CLASS = 'dez-asset-list__row'

const box = ref<HTMLElement>()

/** The asset element and the key of each drawn row, by row element. */
const drawnRows = new WeakMap<Element, { element: HTMLElement, key: string }>()

/** Puts the element of the row (`PanelAssetRow.create`) into the row
 *  element, and takes down its player when the row goes. The row element
 *  has no Vue children, so Vue never touches the asset element. */
const vPanelAsset: Directive<HTMLElement, PanelAssetRow> = {
  mounted(rowElement, { value }) {
    const element = value.create()
    drawnRows.set(rowElement, { element, key: value.key })
    rowElement.appendChild(element)
  },
  // A Save or a Delete changes the tag of a clip, but not its key: the
  // player takes the new tag in place, and so keeps its place in the clip.
  updated(rowElement, { value, oldValue }) {
    const drawn = drawnRows.get(rowElement)
    if (drawn && value.asset !== oldValue?.asset && value.asset.kind === 'clip') updatePlayer(drawn.element, value.asset.tag)
  },
  beforeUnmount(rowElement) {
    const drawn = drawnRows.get(rowElement)
    if (drawn) destroyPlayer(drawn.element)
  },
}

/** The keys of the drawn rows whose clip plays or fills the screen. */
const liveKeys = shallowRef<ReadonlySet<string>>(new Set())

// virtua keeps these rows even when they are far from the visible part:
// a player that leaves the document stops, and ends its fullscreen.
const keepMounted = computed(() => props.rows.flatMap((row, index) => liveKeys.value.has(row.key) ? [index] : []))

function isLive(rowElement: Element): boolean {
  const fullscreen = document.fullscreenElement
  if (fullscreen && rowElement.contains(fullscreen)) return true
  return Array.from(rowElement.querySelectorAll<HTMLMediaElement>('audio, video')).some((media) => !media.paused)
}

function refreshLiveKeys(): void {
  const live = new Set<string>()
  for (const rowElement of box.value?.querySelectorAll(`.${ROW_CLASS}`) ?? []) {
    const drawn = drawnRows.get(rowElement)
    if (drawn && isLive(rowElement)) live.add(drawn.key)
  }
  if (live.size !== liveKeys.value.size || [...live].some((key) => !liveKeys.value.has(key))) liveKeys.value = live
}

// A Delete takes the media element out of a player, which then gets no
// `pause` event here.
watch(() => props.rows, refreshLiveKeys, { flush: 'post' })

// The list gets a new height as rows come in and get their sizes, which CM
// does not see (see `measureLineHeights`).
let drawnHeight = 0
const resizeObserver = new ResizeObserver(() => {
  const height = box.value?.offsetHeight ?? 0
  // 0: the list is not in the document.
  if (height === 0 || height === drawnHeight) return
  drawnHeight = height
  measureLineHeights(props.view)
})

onMounted(() => {
  if (box.value) resizeObserver.observe(box.value)
  document.addEventListener('fullscreenchange', refreshLiveKeys)
})

onBeforeUnmount(() => {
  resizeObserver.disconnect()
  document.removeEventListener('fullscreenchange', refreshLiveKeys)
})
</script>

<template>
  <!-- The scroll box is the parent of `Virtualizer`, which draws only the
       rows near its visible part and gives itself the height of all rows
       (see ModelPicker.vue). Media events do not bubble, so the box hears
       them in their capture phase; the end of a clip fires `pause` too.
       The slot must give exactly one element with a key. -->
  <div
    ref="box"
    class="dez-asset-list"
    @play.capture="refreshLiveKeys"
    @pause.capture="refreshLiveKeys"
  >
    <Virtualizer v-slot="{ item: row, index }" :data="rows" :keep-mounted="keepMounted">
      <div :key="row.key" v-panel-asset="row" :class="[ROW_CLASS, { 'dez-asset-list__row--after': index > 0 }]" />
    </Virtualizer>
  </div>
</template>
