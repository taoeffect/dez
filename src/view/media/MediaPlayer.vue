<script setup lang="ts">
import sbp from '@sbp/sbp'
import { computed, onBeforeUnmount, ref, shallowRef, watch, type ObjectDirective } from 'vue'
// Each import below defines one video.js custom element. Keep them equal to
// the video.js tags of the template, and to `videoJsElements` in
// vite.config.ts. `tooltip-label` and `tooltip-shortcut` are not in the
// template: a tooltip with no text of its own makes them, to show the name
// of the button before it.
import '@videojs/html/video/player'
import '@videojs/html/audio/player'
import '@videojs/html/ui/container'
import '@videojs/html/ui/play-button'
import '@videojs/html/ui/mute-button'
import '@videojs/html/ui/fullscreen-button'
import '@videojs/html/ui/time-group'
import '@videojs/html/ui/time'
import '@videojs/html/ui/time-separator'
import '@videojs/html/ui/time-slider'
import '@videojs/html/ui/volume-slider'
import '@videojs/html/ui/slider-track'
import '@videojs/html/ui/slider-buffer'
import '@videojs/html/ui/slider-fill'
import '@videojs/html/ui/slider-thumb'
import '@videojs/html/ui/tooltip-group'
import '@videojs/html/ui/tooltip'
import '@videojs/html/ui/tooltip-label'
import '@videojs/html/ui/tooltip-shortcut'
import { MAX_SAVED_CLIP_BYTES, mediaFileExtension } from '../../model/chat/mediaFiles'
import { isPastedMediaPath, type MediaTagKind } from '../../model/chat/mediaTags'
import type { Role } from '../../model/chat/types'
import { assetFactsText } from '../assetFacts'
import { clipFile, clipProblem, clipSourceKind, expiryNotice, problemCard, type ClipLoadFailure, type ClipProblem } from './clipState'
import { releaseRemovedMedia } from './releaseMedia'
import { videoAspectRatios } from './videoSizes'

// The player of one audio or video clip: a Dez skin made of the video.js UI
// parts (a packaged video.js skin cannot get new controls), plus the Save
// control and the clock of a clip that is not saved. video.js keeps the
// playback state: `<video-player>` finds the plain media element inside it,
// and each part shows or changes that state. A clip that does not play gets
// a card in place of its media element, which tells why: the clip is gone,
// or this computer cannot play its format. The component knows no tag: its
// owner gives the clip's source, and does the Save and the Delete
// (`src/view/editor/media.ts`).

const props = defineProps<{
  kind: MediaTagKind
  /** The clip's id in its conversation (the `id` of the clip's tag), which
   *  the badge shows. */
  id: string
  /** The clip's media type (the `type` of the clip's tag), which the card of
   *  a clip that this computer cannot play and the facts of the badge name;
   *  null when not known. */
  type: string | null
  /** The clip's source, as its tag has it: the path of the saved file, of
   *  the temp copy, or of a linked file, or a URL; null for a clip with no
   *  source. */
  src: string | null
  /** The role of the tag's section: a linked file plays only in a user
   *  section (`clipSourceKind`). */
  role: Role
  /** The time after which a source that is not saved stops working (the
   *  `expires` of the clip's tag). */
  expires: string | null
  /** A Save or a Delete of this clip runs. */
  busy: boolean
}>()

const emit = defineEmits<{ save: [], delete: [] }>()

const media = ref<HTMLMediaElement | null>(null)

const sourceKind = computed(() => clipSourceKind(props.src, props.role))
/** The kind, as the id badge and its tooltip name it. */
const kindName = computed(() => props.kind === 'video' ? 'Video' : 'Audio')
/** The clip plays from its saved file. */
const saved = computed(() => sourceKind.value === 'saved')
/** The clip plays from a linked file, which needs no Save: its Save
 *  control shows the kept face, whose trash removes only the tag. */
const linked = computed(() => sourceKind.value === 'linked')

/** What the media element loads: a URL, and the source that it is the URL
 *  of. */
interface LoadedSource {
  src: string
  url: string
}

const loaded = shallowRef<LoadedSource | null>(null)

let unmounted = false

/** A source of the clip that did not load, and how its load failed. It is
 *  the source and not a flag, so that the next source of the clip (after a
 *  Save or a Delete) gets its own try. */
interface FailedLoad {
  src: string
  failure: ClipLoadFailure
}

const failed = shallowRef<FailedLoad | null>(null)

/** The problem of the clip while its source is `src` (`clipProblem`). */
function problemOf(src: string | null): ClipProblem | 'ask' | null {
  const entry = failed.value
  return clipProblem(clipSourceKind(src, props.role), entry !== null && entry.src === src ? entry.failure : null)
}

/** Why the clip does not play: null while it plays, and while its URL is
 *  asked (the player keeps its look until the answer). */
const unavailable = computed(() => {
  const problem = problemOf(props.src)
  return problem === 'ask' ? null : problem
})

function fail(src: string, failure: ClipLoadFailure): void {
  const entry = { src, failure }
  failed.value = entry
  // The URL is asked only when it is the source that the clip has now: the
  // failure of a source of before shows nothing.
  if (problemOf(props.src) === 'ask') void askUrl(entry)
}

// A URL that gave "source not supported": its answer tells whether the clip
// is gone or this computer cannot decode it (`clipProblem`).
async function askUrl(entry: FailedLoad): Promise<void> {
  const answers = await sbp('dez.controller/media/urlAnswers', entry.src) as boolean
  // The clip got another source, or failed again, or the player went, while
  // the URL was asked.
  if (unmounted || props.src !== entry.src || failed.value !== entry) return
  failed.value = { src: entry.src, failure: { step: 'ask', answers } }
}

function onMediaError(event: Event): void {
  // A media element that the player removed (at unmount, or when the card
  // took its place) keeps this listener, and it can still fire `error`:
  // that was seen after a tab switch during the load of a local file, whose
  // blob URL is revoked then. It is no failure of the clip that shows now.
  if (event.target !== media.value) return
  const code = media.value?.error?.code
  // Only the code: the message can hold the URL, which can be a signed URL.
  console.error('[MediaPlayer] The clip did not load; media error code:', code)
  const source = loaded.value
  if (!source) return
  fail(source.src, { step: 'play', code })
  // The card takes the place of the media element, so the player needs no
  // source any more: this gives up the blob URL of a local file (the
  // `loaded` watcher revokes it), which holds the whole file in memory. A
  // URL that is asked first (`unavailable` stays null) keeps its element.
  if (unavailable.value !== null) load(null)
}

// A video is 16:9 until it tells its size.
const DEFAULT_ASPECT_RATIO = 16 / 9
const aspectRatio = ref((props.src !== null && videoAspectRatios.get(props.src)) || DEFAULT_ASPECT_RATIO)

// The position and the state to put back on the next source. A Save or a
// Delete gives the same clip a new source, and the media element then
// starts again from zero, paused.
let resume: { time: number, playing: boolean } | null = null

/** Gives the media element its next source. */
function load(next: LoadedSource | null): void {
  // The DOM changes after this function, so the element still has the
  // source of before.
  const element = media.value
  resume = element && (element.currentTime > 0 || !element.paused)
    ? { time: element.currentTime, playing: !element.paused && !element.ended }
    : null
  loaded.value = next
}

/** The size in bytes of the clip's file, from the read of the file (no
 *  second read), for the facts beside the id badge. Null for a clip that
 *  plays from its URL, and until the file is read. */
const fileBytes = ref<number | null>(null)

// A provider URL loads as it is. A local file (the saved file, the temp
// copy, or a linked file) loads from a blob URL of its bytes, and not from
// its asset protocol URL: the media player of WebKitGTK (GStreamer) loads
// http, https, and blob URLs only, and gives a "source not supported" error
// for the URL of a custom protocol. `fetch` has no such limit, so the asset
// protocol still reads the file. The whole file is in memory while the
// media element has it; the card of a clip that does not play gives it up
// (`onMediaError`). A linked file can be any size, so a file over the cap
// of a dropped clip (`MAX_SAVED_CLIP_BYTES`) is not read: it shows the
// "gone" card. Until the file is read, the media element keeps the source
// of before. A new media element (in place of a card) gets no source until
// then: so it does not change its source at the start of its load, which
// can stop the web process (the comment of `releaseRemovedMedia`).
// https://github.com/tauri-apps/tauri/issues/3725
watch(() => props.src, async (src, previous) => {
  const kind = sourceKind.value
  if (src === null || kind === 'none') {
    fileBytes.value = null
    load(null)
    return
  }
  if (kind === 'remote') {
    fileBytes.value = null
    load({ src, url: src })
    return
  }
  // A Save keeps the bytes of a clip that this computer cannot play: the
  // card stays, and the saved file is not read and tried again. (A hand
  // edit of the tag that gives other bytes the path of a saved file shows
  // this card too, until the next editor state makes a new player.)
  const before = failed.value
  if (kind === 'saved' && before !== null && before.src === previous
    && clipSourceKind(previous, props.role) !== 'saved' && problemOf(previous) === 'cannot-play') {
    failed.value = { src, failure: before.failure }
    load(null)
    return
  }
  if (media.value === null) load(null)
  let file: File | null = null
  try {
    file = await sbp('dez.controller/images/readFile', src, kind === 'linked' ? { maxBytes: MAX_SAVED_CLIP_BYTES } : {}) as File
  } catch {
    // The error names the path of the file, which stays out of the log.
    console.error('[MediaPlayer] The file of the clip could not be read')
  }
  // The clip got another source, or the player went, while the file was
  // read.
  if (unmounted || props.src !== src) return
  if (file === null) {
    fileBytes.value = null
    fail(src, { step: 'read' })
    load(null)
    return
  }
  fileBytes.value = file.size
  load({ src, url: URL.createObjectURL(file) })
}, { immediate: true })

// A blob URL keeps its bytes in memory until it is revoked.
function release(source: LoadedSource | null | undefined): void {
  if (source && source.url !== source.src) URL.revokeObjectURL(source.url)
}

// The `post` flush: the media element has the next URL by then.
watch(loaded, (_next, previous) => release(previous), { flush: 'post' })

// Only the blob URL is released here. The media element gives up its
// player when Vue removes it (`vReleaseOnRemove`).
onBeforeUnmount(() => {
  unmounted = true
  release(loaded.value)
})

// Vue calls `unmounted` each time it removed the media element, after the
// element left the document: at the unmount of the player, and when the
// card of a clip that does not play took its place. A removed element
// frees nothing by itself.
const vReleaseOnRemove: ObjectDirective<HTMLMediaElement> = { unmounted: releaseRemovedMedia }

function play(element: HTMLMediaElement): void {
  element.play().catch((error: unknown) => {
    console.error('[MediaPlayer] The clip did not start:', error)
  })
}

function onLoadedMetadata(): void {
  const element = media.value
  if (!element) return
  if (element instanceof HTMLVideoElement && element.videoWidth > 0 && element.videoHeight > 0) {
    aspectRatio.value = element.videoWidth / element.videoHeight
    if (loaded.value) videoAspectRatios.set(loaded.value.src, aspectRatio.value)
  }
  if (!resume) return
  const { time, playing } = resume
  resume = null
  element.currentTime = time
  if (playing) play(element)
}

/** The length of the clip in seconds, for the facts beside the id badge;
 *  null until the media element knows it. */
const seconds = ref<number | null>(null)

// The length is read from the media element that loads the clip anyway: no
// other load. A new source of the same clip (after a Save or a Delete)
// first has no length; the length of before stays until it has one. A
// stream with no end has an infinite length, which is no fact.
function onDurationChange(event: Event): void {
  // A removed media element can still send events (`onMediaError`).
  if (event.target !== media.value) return
  const duration = media.value?.duration ?? NaN
  if (Number.isFinite(duration)) seconds.value = duration
}

function togglePlay(): void {
  const element = media.value
  if (!element) return
  if (element.paused || element.ended) play(element)
  else element.pause()
}

// The time that the clock compares `expires` with. There is no timer: the
// time is read when the player is made, and each time the pointer or the
// focus comes to the clock, which is when its tooltip shows.
const now = ref(Date.now())

// Where the clip's file (the temp copy, the saved file, or the linked file)
// is, as the user reads it (`~` for the home folder): the clock's tooltip
// and the card of a clip that cannot play show it, so that the user can
// find the file. Null for a clip with no file, and until the path is read.
// The path is for the eye only: it goes into no doc text, so no request
// holds it.
const filePath = ref<string | null>(null)
watch(() => props.src, async (src) => {
  filePath.value = null
  const kind = sourceKind.value
  if (src === null || (kind !== 'temp' && kind !== 'saved' && kind !== 'linked')) return
  const path = await sbp('dez.controller/displayPath', src) as string
  // The clip got another source while the path was read.
  if (props.src === src) filePath.value = path
}, { immediate: true })

// The text of the card that shows in place of a clip that does not play.
const card = computed(() => {
  if (unavailable.value === null) return null
  const file = saved.value ? 'saved' : linked.value ? 'linked' : null
  return problemCard(unavailable.value, { type: props.type, file, path: file === null ? null : filePath.value })
})

// The clock goes away as soon as a Save starts, and comes back if it fails.
// A linked file does not expire.
const notice = computed(() => saved.value || linked.value || props.busy ? null : expiryNotice(props.expires, now.value, filePath.value))
/** The words of the clock's tooltip as one text, for screen readers. */
const noticeLabel = computed(() => {
  const value = notice.value
  if (!value) return undefined
  return value.file === null ? `${value.title}. ${value.text}` : `${value.title}. ${value.text} ${value.file}`
})

// The facts beside the id badge: the length, the format, and the size of
// the file, each when known (`assetFactsText`). None for a clip that is
// gone: its card already tells that there is no clip to tell of.
const factsText = computed(() => unavailable.value === 'gone' ? '' : assetFactsText({
  seconds: seconds.value,
  extension: mediaFileExtension(props.type ?? '', props.src),
  bytes: fileBytes.value,
}))

// How long the clock's tooltip stays after the pointer left it or the
// clock. A move from the clock to the tooltip that leaves the clock through
// its side misses the bridge for a moment.
const SELECTABLE_TOOLTIP_CLOSE_DELAY_MS = 150

// A triple click selects a paragraph, and WebKit's paragraph runs on past
// the tooltip into the editor lines after the player (the tooltip is a DOM
// child of the widget, inside the editor's text). So a triple click on a
// line of the tooltip selects that line only, here.
function selectTooltipLine(event: MouseEvent): void {
  if (event.detail < 3 || !(event.target instanceof Element)) return
  const line = event.target.closest('.media-player__tooltip-title, .media-player__tooltip-text')
  if (!line) return
  event.preventDefault()
  window.getSelection()?.selectAllChildren(line)
}

/** The faces of the Save control: `Save ⬇` → (saving) → `Saved ✓` → a green
 *  check in a circle, which is a trash under the pointer → (deleting) →
 *  `Save ⬇`. A linked clip has the check from the start: it needs no
 *  Save, and its trash removes only its tag. */
type SaveState = 'save' | 'saving' | 'just-saved' | 'saved' | 'deleting'

/** The clip's file stays: it is saved, or it is a linked file. */
const kept = computed(() => saved.value || linked.value)

// How long the word "Saved" shows before the control becomes the check.
const SAVED_WORD_MS = 1000
const justSaved = ref(false)
let justSavedTimer: number | undefined

// Whether the check plays its change from a filled disc to an outline
// (`data-outlining`; the CSS has the animation). Only a Save in this player
// starts it: a player that mounts with a saved clip (a tab switch makes new
// players) shows the outline at once. It ends with the animation, or when
// the trash hides the check and so stops the animation: the check would
// play it again each time it shows.
const outlining = ref(false)

// Whether the check becomes the trash under the pointer or the focus. After
// a Save, the pointer is still on the control; the trash right there would
// look as if the Save went wrong, and a second click would ask to delete
// the file. So the trash needs the pointer or the focus to come to the
// check anew (`armTrash`). The rule reads no leave event: the check is
// smaller than the Save button, and WebKitGTK sends no `pointerleave` when
// a control gets small and so leaves a pointer that does not move.
const trashArmed = ref(false)

watch(saved, (isSaved) => {
  window.clearTimeout(justSavedTimer)
  justSaved.value = isSaved
  outlining.value = false
  trashArmed.value = false
  if (!isSaved) return
  justSavedTimer = window.setTimeout(() => {
    justSaved.value = false
    outlining.value = true
  }, SAVED_WORD_MS)
})

onBeforeUnmount(() => window.clearTimeout(justSavedTimer))

const saveState = computed<SaveState>(() => {
  if (props.busy) return kept.value ? 'deleting' : 'saving'
  if (!kept.value) return 'save'
  return justSaved.value ? 'just-saved' : 'saved'
})

/** The pointer or the focus came to the Save control. */
function armTrash(): void {
  if (saveState.value === 'saved') trashArmed.value = true
}

const SAVE_HINTS: Record<SaveState, string> = {
  save: 'Save this clip',
  saving: 'Saving…',
  'just-saved': 'Saved',
  saved: 'Saved',
  deleting: 'Deleting…',
}

// The trash of a clip that the user pasted or dropped deletes the clip, and
// not only a saved copy, and the trash of a linked clip removes its tag and
// keeps its file (`deleteSavedClip`, src/view/editor/media.ts).
const trashHint = computed(() => {
  if (linked.value) return 'Remove this clip (its file stays)'
  return props.src !== null && isPastedMediaPath(props.src) ? 'Delete this clip' : 'Delete the saved file'
})
const saveHint = computed(() => {
  if (saveState.value === 'saved' && trashArmed.value) return trashHint.value
  return linked.value && saveState.value === 'saved' ? 'Linked file' : SAVE_HINTS[saveState.value]
})

function onSaveClick(): void {
  if (props.busy) return
  if (!kept.value) emit('save')
  else if (trashArmed.value) emit('delete')
}

// A right-click on the player pops up the native menu with "Reveal in File
// Manager" (`dez.controller/menu/popupAsset`), in place of the webview's
// own menu. The item is disabled when the clip has no file here
// (`clipFile`). The text of the clock's tooltip keeps the webview's menu,
// which can copy the selected text. The press of the click keeps the
// editor's caret and focus (`src/view/editor/media.ts`).
function onContextMenu(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('.media-player__tooltip--selectable') !== null) return
  event.preventDefault()
  void sbp('dez.controller/menu/popupAsset', clipFile(props.src, props.role, unavailable.value, props.busy))
}
</script>

<template>
  <component
    :is="kind === 'video' ? 'video-player' : 'audio-player'"
    class="media-player"
    :data-kind="kind"
    :data-unavailable="unavailable ?? undefined"
    :style="{ '--media-player-ratio': aspectRatio }"
    @contextmenu="onContextMenu"
  >
    <!-- `tabindex="-1"`: the card itself is no Tab stop (video.js gives it
         0); its buttons and sliders are. -->
    <media-container class="media-player__card" tabindex="-1">
      <!-- `pointerup.stop`: video.js gives the focus to the container on each
           pointer release in it, which would take the focus from the editor
           on a click on Play. The parts get their own pointer events first,
           so they still work. The div has no box (`display: contents`). -->
      <div class="media-player__parts" @pointerup.stop>
        <template v-if="!card">
          <video
            v-if="kind === 'video'"
            ref="media"
            v-release-on-remove
            class="media-player__video"
            :src="loaded?.url"
            preload="metadata"
            playsinline
            @click="togglePlay"
            @loadedmetadata="onLoadedMetadata"
            @durationchange="onDurationChange"
            @error="onMediaError"
          />
          <audio
            v-else
            ref="media"
            v-release-on-remove
            :src="loaded?.url"
            preload="metadata"
            @loadedmetadata="onLoadedMetadata"
            @durationchange="onDurationChange"
            @error="onMediaError"
          />
        </template>
        <div v-else class="media-player__unavailable">
          <svg class="media-player__icon media-player__icon--line" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="5.9" />
            <path d="M3.9 3.9l8.2 8.2" />
          </svg>
          <span class="media-player__unavailable-text">
            <span>{{ card.text }}</span>
            <span v-if="card.hint">{{ card.hint }}</span>
            <span v-if="card.file" class="media-player__unavailable-path">{{ card.file }}</span>
          </span>
        </div>
        <!-- One tooltip group: after the first tooltip, the next ones show
             with no delay. A tooltip belongs to the element before it. Under
             the card of a clip that this computer cannot play, the bar keeps
             the clock and the Save control: the file of the clip is still
             there, and the user can keep it. -->
        <media-tooltip-group v-if="unavailable !== 'gone'" class="media-player__bar">
          <template v-if="!card">
            <media-play-button class="media-player__button media-player__play">
              <svg class="media-player__icon media-player__icon--play" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M5.2 3.1c0-.6.66-.96 1.16-.63l7.2 4.9c.44.3.44.96 0 1.26l-7.2 4.9c-.5.33-1.16-.03-1.16-.63z" />
              </svg>
              <svg class="media-player__icon media-player__icon--pause" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3.6" y="2.8" width="3.2" height="10.4" rx="1" />
                <rect x="9.2" y="2.8" width="3.2" height="10.4" rx="1" />
              </svg>
              <svg class="media-player__icon media-player__icon--line media-player__icon--restart" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M1.4 3.2v3.6H5" />
                <path d="M2.9 9.8a5.4 5.4 0 1 0 1.28-5.62L1.4 6.8" />
              </svg>
            </media-play-button>
            <media-tooltip class="media-player__tooltip" boundary="viewport" />

            <media-time-group class="media-player__time">
              <media-time class="media-player__time-current" type="current" />
              <media-time-separator class="media-player__time-rest" />
              <media-time class="media-player__time-rest" type="duration" />
            </media-time-group>

            <media-time-slider class="media-player__slider media-player__slider--time" thumb-alignment="edge">
              <media-slider-track class="media-player__track">
                <media-slider-buffer class="media-player__buffer" />
                <media-slider-fill class="media-player__fill" />
              </media-slider-track>
              <media-slider-thumb class="media-player__thumb" />
            </media-time-slider>

            <media-mute-button class="media-player__button media-player__mute">
              <svg class="media-player__icon media-player__icon--volume-high" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 6.3c0-.28.22-.5.5-.5h2.1l2.95-2.5c.32-.28.82-.05.82.38v8.64c0 .43-.5.66-.82.38L4.6 10.2H2.5a.5.5 0 0 1-.5-.5z" />
                <path class="media-player__icon--line" d="M10.6 5.9a3 3 0 0 1 0 4.2M12.5 4a5.6 5.6 0 0 1 0 8" />
              </svg>
              <svg class="media-player__icon media-player__icon--volume-low" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 6.3c0-.28.22-.5.5-.5h2.1l2.95-2.5c.32-.28.82-.05.82.38v8.64c0 .43-.5.66-.82.38L4.6 10.2H2.5a.5.5 0 0 1-.5-.5z" />
                <path class="media-player__icon--line" d="M10.6 5.9a3 3 0 0 1 0 4.2" />
              </svg>
              <svg class="media-player__icon media-player__icon--volume-off" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 6.3c0-.28.22-.5.5-.5h2.1l2.95-2.5c.32-.28.82-.05.82.38v8.64c0 .43-.5.66-.82.38L4.6 10.2H2.5a.5.5 0 0 1-.5-.5z" />
                <path class="media-player__icon--line" d="M10.8 6.2l3.4 3.6m0-3.6l-3.4 3.6" />
              </svg>
            </media-mute-button>
            <media-tooltip class="media-player__tooltip" boundary="viewport" />

            <media-volume-slider class="media-player__slider media-player__slider--volume" thumb-alignment="edge">
              <media-slider-track class="media-player__track">
                <media-slider-fill class="media-player__fill" />
              </media-slider-track>
              <media-slider-thumb class="media-player__thumb" />
            </media-volume-slider>

            <template v-if="kind === 'video'">
              <media-fullscreen-button class="media-player__button media-player__fullscreen">
                <svg class="media-player__icon media-player__icon--line media-player__icon--enter" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10" />
                </svg>
                <svg class="media-player__icon media-player__icon--line media-player__icon--exit" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M6 2.6V6H2.6M13.4 6H10V2.6M10 13.4V10h3.4M2.6 10H6v3.4" />
                </svg>
              </media-fullscreen-button>
              <media-tooltip class="media-player__tooltip" boundary="viewport" />
            </template>
          </template>

          <template v-if="notice">
            <span
              class="media-player__clock"
              :data-expired="notice.expired ? '' : undefined"
              role="img"
              tabindex="0"
              :aria-label="noticeLabel"
              @pointerenter="now = Date.now()"
              @focus="now = Date.now()"
            >
              <svg class="media-player__icon media-player__icon--line" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="5.9" />
                <path d="M8 4.7V8l2.2 1.5" />
              </svg>
            </span>
            <!-- The one tooltip that takes the pointer: the user moves into
                 it and selects its text (the path of a temp copy). With
                 `disableHoverablePopup` off, video.js keeps it open while the
                 pointer is over it; the close delay keeps it open over a
                 quick move that cuts the corner of the bridge (the
                 `::after` in the styles). `src/view/editor/media.ts` keeps
                 the mousedown of its text and gives the focus back when it
                 closes. -->
            <media-tooltip
              class="media-player__tooltip media-player__tooltip--notice media-player__tooltip--selectable"
              boundary="viewport"
              :close-delay="SELECTABLE_TOOLTIP_CLOSE_DELAY_MS"
              :disableHoverablePopup.prop="false"
              @mousedown="selectTooltipLine"
            >
              <span class="media-player__tooltip-title">{{ notice.title }}</span>
              <span class="media-player__tooltip-text">{{ notice.text }}</span>
              <span v-if="notice.file" class="media-player__tooltip-text media-player__tooltip-path">{{ notice.file }}</span>
            </media-tooltip>
          </template>

          <!-- `aria-disabled`, not `disabled`: a disabled button gets no
               pointer events, so it would show no tooltip while a Save
               or a Delete runs. -->
          <button
            type="button"
            class="media-player__save"
            :data-state="saveState"
            :data-armed="trashArmed ? '' : undefined"
            :aria-disabled="busy ? 'true' : undefined"
            :aria-label="saveHint"
            @click="onSaveClick"
            @pointerenter="armTrash"
            @focus="armTrash"
          >
            <span class="media-player__save-label">{{ kept ? 'Saved' : 'Save' }}</span>
            <span v-if="busy" class="media-player__spinner" aria-hidden="true" />
            <svg v-else-if="!kept" class="media-player__icon media-player__icon--line" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.6v7.6M4.9 7.3L8 10.4l3.1-3.1M3.2 13.2h9.6" />
            </svg>
            <svg v-else-if="justSaved" class="media-player__icon media-player__icon--line" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.4 8.5l3 3 6.2-6.6" />
            </svg>
            <template v-else>
              <svg
                class="media-player__icon media-player__icon--line media-player__save-done"
                :data-outlining="outlining ? '' : undefined"
                viewBox="0 0 16 16"
                aria-hidden="true"
                @animationcancel="outlining = false"
              >
                <circle class="media-player__save-done-ring" cx="8" cy="8" r="6.4" />
                <g class="media-player__save-done-fill">
                  <circle cx="8" cy="8" r="6.4" />
                  <path d="M4.7 8.3l2.3 2.3 4.4-4.8" />
                </g>
                <path class="media-player__save-done-check" d="M4.7 8.3l2.3 2.3 4.4-4.8" @animationend="outlining = false" />
              </svg>
              <svg class="media-player__icon media-player__icon--line media-player__save-trash" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 4.4h10M6.2 4.4V3.3c0-.39.31-.7.7-.7h2.2c.39 0 .7.31.7.7v1.1M4.3 4.4l.5 8.1c.03.5.45.9.95.9h4.5c.5 0 .92-.4.95-.9l.5-8.1M6.7 7v3.8M9.3 7v3.8" />
              </svg>
            </template>
          </button>
          <media-tooltip class="media-player__tooltip" boundary="viewport">{{ saveHint }}</media-tooltip>
        </media-tooltip-group>
        <!-- A second video element, empty and never shown. It has an
             effect on macOS only.
             In element fullscreen, WebKit on macOS reads the text in the
             frame of a paused video (Live Text), and for that it puts a
             native view over the whole web view. That view takes every
             click. So, after the clip had played, no button of the bar
             worked in fullscreen: the page got no pointer event at all.
             (The dead clicks were seen on macOS; their cause is read
             from WebKit's code.)
             WebKit does this for one video only: the `<video>` with the
             largest box under the fullscreen element (the first one, if
             two are equal). And it does nothing for a video with no
             source, which has no frame. This element is that video. Two
             rules keep it so:
             - It has no `src`, and nothing loads it.
             - Its box is larger than the box of the clip's video: it has
               the size of the card, which is the video plus the bar.
             It comes after the clip's video, because video.js takes the
             first `video` in the player as its media.
             WebKitGTK has no such view. An element with no source has no
             media player (300 of them add no thread to the web process),
             so it needs no `v-release-on-remove`.
             The WebKit setting that turns the text recognition off is no
             option: the web process then still asks for the recognition,
             and WebKit ends the web process for it (the last URL).
             https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/FullScreen/WebFullScreenManager.cpp
             (`updateMainVideoElement`, `mainVideoElementTextRecognitionTimerFired`)
             https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/WebPage/WebPage.cpp
             (`beginTextRecognitionForVideoInElementFullScreen`)
             https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm
             (`installImageAnalysisOverlayView`)
             https://github.com/driceroland/Search/pull/794 -->
        <video v-if="kind === 'video' && !card" class="media-player__stand-in" />
      </div>
    </media-container>
    <!-- The id badge and the facts of the clip, in one toolbar as an image
         has them (`ImageWidget` in src/view/editor/images.ts). A model gets
         the id in the request form of the clip's tag
         (`mediaTagRequestText`), so a message can name the clip by it. The
         tooltip belongs to the badge, the element before it. -->
    <span class="media-player__overlay">
      <span class="media-player__id" role="img" :aria-label="`${kindName} id: ${id}`">
        <svg v-if="kind === 'video'" class="media-player__icon media-player__icon--line" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.8" y="4" width="8.6" height="8" rx="1.8" />
          <path d="M10.4 7.2l3.8-2.2v6l-3.8-2.2" />
        </svg>
        <svg v-else class="media-player__icon media-player__icon--line" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 6.5v3M5.5 4.4v7.2M8 2.8v10.4M10.5 5v6M13 6.7v2.6" />
        </svg>
        <span class="media-player__id-text">{{ id }}</span>
      </span>
      <media-tooltip class="media-player__tooltip media-player__tooltip--notice" boundary="viewport">
        <span class="media-player__tooltip-title">{{ kindName }} id: {{ id }}</span>
        <span class="media-player__tooltip-text">Refer to this clip in a message as <code>{{ kind }} @{{ id }}</code>.</span>
      </media-tooltip>
      <span v-if="factsText" class="media-player__facts">{{ factsText }}</span>
    </span>
  </component>
</template>

<style scoped>
/* Sizes follow the editor font size, as all of the editor does: `--u` is
   1px at the default size. The editor gives the unit and the max height of
   a video (`.dez-media` in `dezTheme`, cmEditor.ts).
   The player is a row: the card, then the toolbar of the id badge. It is
   a flex item of the editor's widget, so with no width of its own it is
   as wide as that row, and `max-width` keeps it in the line. Its box is
   the hover area that shows the toolbar. */
.media-player {
  --u: var(--dez-media-unit, 1px);
  --max-height: var(--dez-media-max-height, 320px);
  position: relative;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  max-width: 100%;
}

/* As wide as the video at its max height, but never narrower than the
   control bar needs: a portrait video then has black bars beside it. */
.media-player[data-kind="video"]:not([data-unavailable]) {
  width: min(100%, max(calc(var(--u) * 340), calc(var(--max-height) * var(--media-player-ratio))));
}

/* video.js elements are custom elements with no styles of their own
   (inline, no size): every one that has a box gets its layout here.
   `min-width: 0`: in a narrow line the card gets narrower, not the badge.
   `position`: the card is the containing block of the stand-in video, and
   of the tint that the editor puts over a card in a text selection (its
   `::after`, `dezTheme` in cmEditor.ts). */
.media-player__card {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: calc(var(--u) * 8);
  background: color-mix(in srgb, var(--color-text) 4%, var(--color-bg));
  color: var(--color-text);
  outline: none;
}

.media-player[data-kind="video"] > .media-player__card {
  width: 100%;
}

/* The bar is a size container, which adds no content width: with no width
   here, the card would shrink to its border. */
.media-player[data-kind="audio"] > .media-player__card {
  width: calc(var(--u) * 460);
}

.media-player[data-unavailable] > .media-player__card {
  width: auto;
}

.media-player__parts {
  display: contents;
}

.media-player__video {
  display: block;
  flex: none;
  width: 100%;
  max-height: var(--max-height);
  aspect-ratio: var(--media-player-ratio);
  object-fit: contain;
  background: #000;
  cursor: pointer;
}

/* The size of the card, out of the flow, with no picture and no pointer
   events: see the comment at the element. */
.media-player__stand-in {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  visibility: hidden;
  pointer-events: none;
}

/* The bar is a size container: it hides parts when it is narrow (the
   `@container` rules below). */
.media-player__bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: calc(var(--u) * 4);
  box-sizing: border-box;
  min-height: calc(var(--u) * 34);
  padding: calc(var(--u) * 3) calc(var(--u) * 8) calc(var(--u) * 3) calc(var(--u) * 4);
  font-size: calc(var(--u) * 12);
  line-height: 1;
  container-type: inline-size;
}

.media-player__icon {
  display: block;
  flex: none;
  width: calc(var(--u) * 16);
  height: calc(var(--u) * 16);
  fill: currentColor;
}

.media-player__icon--line {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.media-player__button {
  display: grid;
  flex: none;
  place-items: center;
  width: calc(var(--u) * 28);
  height: calc(var(--u) * 28);
  border-radius: calc(var(--u) * 6);
  outline: none;
  cursor: pointer;
}

.media-player__button:hover {
  background: color-mix(in srgb, var(--color-text) 9%, transparent);
}

.media-player__button:focus-visible,
.media-player__thumb:focus-visible,
.media-player__clock:focus-visible,
.media-player__save:focus-visible {
  box-shadow: 0 0 0 2px var(--color-link, #4a9eff);
}

/* video.js hides the fullscreen button where there is no fullscreen. */
.media-player__button[hidden] {
  display: none;
}

/* A button holds the icon of each of its states; video.js tells the state
   in data attributes. */
.media-player__button > .media-player__icon {
  display: none;
}

.media-player__play[data-ended] > .media-player__icon--restart,
.media-player__play:not([data-ended])[data-paused] > .media-player__icon--play,
.media-player__play:not([data-ended], [data-started]) > .media-player__icon--play,
.media-player__play[data-started]:not([data-ended], [data-paused]) > .media-player__icon--pause,
.media-player__mute:is([data-muted], [data-volume-level="off"]) > .media-player__icon--volume-off,
.media-player__mute[data-volume-level="low"]:not([data-muted]) > .media-player__icon--volume-low,
.media-player__mute:not([data-muted], [data-volume-level="off"], [data-volume-level="low"]) > .media-player__icon--volume-high,
.media-player__fullscreen[data-fullscreen] > .media-player__icon--exit,
.media-player__fullscreen:not([data-fullscreen]) > .media-player__icon--enter {
  display: block;
}

.media-player__time {
  display: flex;
  flex: none;
  align-items: center;
  gap: calc(var(--u) * 3);
  padding: 0 calc(var(--u) * 4) 0 calc(var(--u) * 2);
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.media-player__time-current {
  color: var(--color-text);
}

/* A slider: video.js gives the played, loaded, and pointer positions as
   percent in `--media-slider-fill`, `--media-slider-buffer`, and
   `--media-slider-pointer`. */
.media-player__slider {
  position: relative;
  display: flex;
  align-items: center;
  height: calc(var(--u) * 20);
  outline: none;
  cursor: pointer;
  /* A touch drag moves the thumb, not the page. */
  touch-action: none;
}

.media-player__slider--time {
  flex: 1 1 0;
  min-width: calc(var(--u) * 40);
}

.media-player__slider--volume {
  flex: none;
  width: calc(var(--u) * 56);
  margin-right: calc(var(--u) * 4);
}

/* No media yet, or a media with no length. */
.media-player__slider[data-disabled] {
  opacity: 0.5;
  cursor: default;
}

.media-player__track {
  position: absolute;
  inset-inline: 0;
  height: calc(var(--u) * 4);
  overflow: hidden;
  border-radius: calc(var(--u) * 2);
  background: color-mix(in srgb, var(--color-text) 14%, transparent);
}

.media-player__buffer,
.media-player__fill {
  position: absolute;
  inset-block: 0;
  left: 0;
}

.media-player__buffer {
  width: var(--media-slider-buffer, 0%);
  background: color-mix(in srgb, var(--color-text) 16%, transparent);
}

.media-player__fill {
  width: var(--media-slider-fill, 0%);
  background: var(--color-accent);
}

.media-player__thumb {
  position: absolute;
  left: var(--media-slider-fill, 0%);
  width: calc(var(--u) * 10);
  height: calc(var(--u) * 10);
  border-radius: 50%;
  background: var(--color-accent);
  outline: none;
  transform: translateX(-50%);
  opacity: 0;
}

.media-player__slider:hover > .media-player__thumb,
.media-player__slider[data-dragging] > .media-player__thumb,
.media-player__thumb:focus-visible {
  opacity: 1;
}

/* During a drag of the time slider, the fill and the thumb follow the
   pointer, not the playback position, which comes after it. */
.media-player__slider--time[data-dragging] .media-player__fill {
  width: var(--media-slider-pointer, 0%);
}

.media-player__slider--time[data-dragging] > .media-player__thumb {
  left: var(--media-slider-pointer, 0%);
}

.media-player__clock {
  display: grid;
  flex: none;
  place-items: center;
  width: calc(var(--u) * 22);
  height: calc(var(--u) * 22);
  border-radius: 50%;
  color: var(--color-muted);
  outline: none;
  cursor: default;
}

.media-player__clock[data-expired] {
  color: var(--color-error);
}

.media-player__clock > .media-player__icon {
  width: calc(var(--u) * 14);
  height: calc(var(--u) * 14);
}

/* The Save control is a pill; with no label it is as wide as it is high: a
   circle. */
.media-player__save {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: calc(var(--u) * 24);
  height: calc(var(--u) * 24);
  padding: 0 calc(var(--u) * 9);
  border: 1px solid var(--color-border);
  border-radius: calc(var(--u) * 12);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  white-space: nowrap;
  outline: none;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}

.media-player__save[data-state="save"]:hover {
  border-color: var(--color-muted);
}

.media-player__save[data-state="saving"],
.media-player__save[data-state="deleting"] {
  color: var(--color-muted);
  cursor: progress;
}

.media-player__save[data-state="just-saved"] {
  border-color: var(--color-success);
  color: var(--color-success);
  cursor: default;
}

.media-player__save[data-state="saved"],
.media-player__save[data-state="deleting"] {
  padding: 0;
  border-color: transparent;
}

.media-player__save[data-state="saved"] {
  color: var(--color-success);
}

.media-player__save[data-state="saved"]:not([data-armed]) {
  cursor: default;
}

.media-player__save-label {
  display: inline-block;
  max-width: 5em;
  margin-right: calc(var(--u) * 5);
  overflow: hidden;
}

.media-player__save[data-state="saved"] > .media-player__save-label,
.media-player__save[data-state="deleting"] > .media-player__save-label {
  max-width: 0;
  margin-right: 0;
  opacity: 0;
}

.media-player__save > .media-player__icon {
  width: calc(var(--u) * 14);
  height: calc(var(--u) * 14);
}

.media-player__save > .media-player__save-done {
  width: calc(var(--u) * 18);
  height: calc(var(--u) * 18);
}

/* The check of a saved clip: a green circle and check, in outline, so that
   it does not draw the eye from the clip. The ring's outer edge is at
   radius 7. */
.media-player__save-done-ring,
.media-player__save-done-check {
  stroke-width: 1.2;
}

/* The filled look of the check: a green disc, which with the ring is a disc
   of radius 7, and the check in the color of the card behind it. It shows
   only in the animation after a Save. */
.media-player__save-done-fill {
  opacity: 0;
}

.media-player__save-done-fill > circle {
  fill: currentColor;
  stroke: none;
}

.media-player__save-done-fill > path {
  stroke: var(--color-bg);
  stroke-width: 1.6;
}

/* The check line is about 9.8 units long (its `d`). One dash longer than
   the line, and a gap longer still, let the animation draw the line from
   its start with `stroke-dashoffset`. At an offset past the dash's length,
   all of the line is in the gap, with no dash end on it, which a round cap
   would paint as a dot. */
.media-player__save-done-check {
  stroke-dasharray: 10 20;
}

.media-player__save > .media-player__save-trash {
  display: none;
}

/* The trash in a red outline, in place of the check. */
.media-player__save[data-state="saved"][data-armed]:is(:hover, :focus-visible) {
  border-color: var(--color-error);
  color: var(--color-error);
}

.media-player__save[data-state="saved"][data-armed]:is(:hover, :focus-visible) > .media-player__save-done {
  display: none;
}

.media-player__save[data-state="saved"][data-armed]:is(:hover, :focus-visible) > .media-player__save-trash {
  display: block;
}

.media-player__spinner {
  display: block;
  flex: none;
  box-sizing: border-box;
  width: calc(var(--u) * 13);
  height: calc(var(--u) * 13);
  border: calc(var(--u) * 1.5) solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
}

/* The toolbar of the id badge and the facts has the look of an image's
   toolbar (`.dez-image__overlay`, `.dez-image__id`, and
   `.dez-image__facts` in `dezTheme`, cmEditor.ts): dark glass with white
   text in both themes, shown only while the pointer is over the player.
   Beside an audio card and the card of a clip that does not play, it
   covers no control of the bar, and it keeps its room while hidden, so a
   hover changes no size; the rule below puts it over the picture of a
   video. It is outside the card, which cuts its content (`overflow`); so
   the fullscreen view, which is the card, has no toolbar. */
.media-player__overlay {
  z-index: 2;
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: calc(var(--u) * 3);
  margin-left: calc(var(--u) * 8);
  padding: calc(var(--u) * 3);
  border: 1px solid var(--color-image-toolbar-border, rgba(255, 255, 255, 0.18));
  border-radius: calc(var(--u) * 9);
  background: var(--color-image-toolbar, rgba(18, 18, 22, 0.72));
  color: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22), 0 6px 18px rgba(0, 0, 0, 0.24);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
  backdrop-filter: blur(14px) saturate(130%);
  font-size: calc(var(--u) * 12.5);
  line-height: 1;
  white-space: nowrap;
  cursor: default;
  opacity: 0;
  transition: opacity 0.14s ease;
}

/* On a video, the toolbar is at the top-right corner of the picture, as
   on an image. */
.media-player[data-kind="video"]:not([data-unavailable]) > .media-player__overlay {
  position: absolute;
  top: calc(var(--u) * 8);
  right: calc(var(--u) * 8);
  margin: 0;
}

.media-player:hover > .media-player__overlay {
  opacity: 1;
}

.media-player__id {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--u) * 5);
  box-sizing: border-box;
  min-width: 0;
  max-width: calc(var(--u) * 114);
  height: calc(var(--u) * 24);
  padding: 0 calc(var(--u) * 8) 0 calc(var(--u) * 7);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.media-player__id > .media-player__icon {
  width: calc(var(--u) * 14);
  height: calc(var(--u) * 14);
  stroke-width: 1.3;
  opacity: 0.72;
}

/* An id is one or two letters. A tag that a user wrote can have a long
   one, which must not make the badge wider than its max width. The line
   height keeps `overflow` from cutting the letters that go below the
   line. */
.media-player__id-text {
  min-width: 0;
  overflow: hidden;
  line-height: 1.4;
  text-overflow: ellipsis;
}

/* The facts (length, format, file size) are less strong than the id, with
   digits of one width. The `::before` is the divider in the middle of the
   gap after the id. The video.js tooltip between the two is a popover,
   which takes no room in the toolbar. */
.media-player__facts {
  position: relative;
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  height: calc(var(--u) * 24);
  padding: 0 calc(var(--u) * 8);
  color: rgba(255, 255, 255, 0.78);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.media-player__facts::before {
  content: "";
  position: absolute;
  top: 25%;
  bottom: 25%;
  left: calc(var(--u) * -1.5 - 0.5px);
  width: 1px;
  background: var(--color-image-toolbar-border, rgba(255, 255, 255, 0.18));
}

/* A video.js tooltip is a popover in the top layer, so the card's
   `overflow` and the editor's scroller do not cut it. The rules undo the
   browser's popover styles (centered by a margin, a thick border) and give
   it the look of the editor's own tooltips (`.cm-tooltip` in `dezTheme`). */
.media-player__tooltip {
  margin: 0;
  padding: calc(var(--u) * 3) calc(var(--u) * 8);
  overflow: visible;
  border: 1px solid var(--color-border);
  border-radius: calc(var(--u) * 6);
  background: var(--color-bg);
  color: var(--color-text);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  font-size: calc(var(--u) * 12);
  line-height: 1.4;
  white-space: nowrap;
  /* The pointer goes through it, so it never takes the hover from its
     element, and a tooltip over the picture or over editor text takes no
     click. The clock's tooltip is the one exception (`--selectable`). */
  pointer-events: none;
  /* The gap between the tooltip and its element (read by video.js). */
  --media-tooltip-side-offset: calc(var(--u) * 6);
}

/* video.js tells the open state in data attributes; the browser's own
   `:popover-open` rule does not cover the time of the closing transition. */
.media-player__tooltip:not([data-open], [data-ending-style]) {
  display: none;
}

.media-player__tooltip:is([data-starting-style], [data-ending-style]) {
  opacity: 0;
}

.media-player__tooltip--notice {
  max-width: min(calc(var(--u) * 280), calc(100vw - 32px));
  padding: calc(var(--u) * 6) calc(var(--u) * 10) calc(var(--u) * 7);
  white-space: normal;
}

/* The clock's tooltip takes the pointer, and its text can be selected (the
   user copies the path of a temp copy from it). `.dez-media` turns the
   selection off for the rest of the player. */
.media-player__tooltip--selectable {
  pointer-events: auto;
  cursor: auto;
  user-select: text;
  -webkit-user-select: text;
}

/* The bridge: an invisible strip over the gap between the tooltip and the
   clock (the side offset), on the side of the clock. video.js counts it as
   a part of the tooltip, so a pointer that moves straight from the clock
   into the tooltip is always over one of them, and the tooltip stays open.
   2px more than the gap, so the strip overlaps the clock's box. */
.media-player__tooltip--selectable::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: calc(var(--media-tooltip-side-offset) + 2px);
}

.media-player__tooltip--selectable[data-side='top']::after {
  top: 100%;
}

.media-player__tooltip--selectable[data-side='bottom']::after {
  bottom: 100%;
}

/* CM's `hideNativeSelection` makes the native selection in the editor's
   lines transparent (and `Highlight` under a focused element: the card has
   the focus after a press in the tooltip). The tooltip is in a line, so its
   selection gets the editor's color back. Two classes more than CM's rules
   make this win. */
.cm-content .cm-line .media-player__tooltip--selectable ::selection {
  background-color: var(--color-selection, #d7d4f0) !important;
}

.media-player__tooltip-title {
  display: block;
  font-weight: 600;
}

.media-player__tooltip-text {
  display: block;
  margin-top: calc(var(--u) * 2);
  opacity: 0.8;
}

/* A path has no spaces: it breaks at any character, so a long one stays
   inside the tooltip. */
.media-player__tooltip-path {
  overflow-wrap: anywhere;
}

/* The code look of the image tooltips (`.dez-image-tooltip code` in
   `dezTheme`). */
.media-player__tooltip code {
  padding: 0 calc(var(--u) * 3);
  border-radius: calc(var(--u) * 3);
  background: rgba(127, 127, 127, 0.18);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 0.95em;
}

/* The card of a clip that does not play: the icon, and the lines of its
   text. */
.media-player__unavailable {
  display: flex;
  align-items: flex-start;
  gap: calc(var(--u) * 7);
  padding: calc(var(--u) * 8) calc(var(--u) * 12) calc(var(--u) * 8) calc(var(--u) * 10);
  color: var(--color-muted);
  font-size: calc(var(--u) * 13);
  line-height: 1.3;
}

.media-player__unavailable-text {
  display: flex;
  flex-direction: column;
  gap: calc(var(--u) * 2);
  min-width: 0;
}

/* A long path breaks at any place, not only at its slashes. */
.media-player__unavailable-path {
  overflow-wrap: anywhere;
}

/* Under the card, the bar holds only the clock and the Save control, at
   its end. */
.media-player[data-unavailable] .media-player__bar {
  justify-content: flex-end;
}

/* A narrow bar drops the volume slider first, then the total time. The
   `em` is the bar's font size. */
@container (max-width: 30em) {
  .media-player__slider--volume {
    display: none;
  }
}

@container (max-width: 22em) {
  .media-player__time-rest {
    display: none;
  }
}

/* Fullscreen shows the card (video.js sends the container, not the video,
   so the bar stays): the video takes all the space above the bar. */
.media-player__card:fullscreen {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: #000;
}

.media-player__card:fullscreen .media-player__video {
  flex: 1 1 0;
  min-height: 0;
  max-height: none;
  aspect-ratio: auto;
}

.media-player__card:fullscreen .media-player__bar {
  background: var(--color-bg);
}

@media (prefers-reduced-motion: no-preference) {
  .media-player__thumb {
    transition: opacity 0.12s;
  }

  .media-player__tooltip {
    transition: opacity 0.12s;
  }

  /* The toolbar drops into place from its top-right corner as it fades in,
     as the image toolbar does. */
  .media-player__overlay {
    transform: translateY(calc(var(--u) * -4)) scale(0.97);
    transform-origin: top right;
    transition: opacity 0.14s ease, transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .media-player:hover > .media-player__overlay {
    transform: none;
  }

  .media-player__save {
    transition: padding 0.25s ease, border-color 0.15s, color 0.15s;
  }

  .media-player__save-label {
    transition: max-width 0.25s ease, margin-right 0.25s ease, opacity 0.15s;
  }

  .media-player__save[data-state="just-saved"] > .media-player__icon {
    animation: media-player-pop 0.3s ease-out;
  }

  /* After a Save, the check changes from the filled disc to the outline:
     the pill becomes a circle (0.25 s, the `padding` transition), then the
     fill fades and leaves the ring, then the check draws itself in green.
     The old and the new check do not show at one time: in a cross-fade,
     the check would melt into the half-faded disc. */
  .media-player__save-done[data-outlining] > .media-player__save-done-fill {
    animation: media-player-fill-out 0.3s ease 0.25s both;
  }

  .media-player__save-done[data-outlining] > .media-player__save-done-check {
    animation: media-player-draw-check 0.3s ease-out 0.5s both;
  }

  .media-player__spinner {
    animation: media-player-spin 0.9s linear infinite;
  }
}

@keyframes media-player-pop {
  0% {
    transform: scale(0.4);
    opacity: 0;
  }

  60% {
    transform: scale(1.25);
  }

  100% {
    transform: scale(1);
  }
}

@keyframes media-player-fill-out {
  from {
    opacity: 1;
  }

  to {
    opacity: 0;
  }
}

@keyframes media-player-draw-check {
  from {
    stroke-dashoffset: 11;
  }

  to {
    stroke-dashoffset: 0;
  }
}

@keyframes media-player-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
