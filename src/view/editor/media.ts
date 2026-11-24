import sbp from '@sbp/sbp'
import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { createApp, h, reactive, shallowRef, type App, type ShallowRef } from 'vue'
import { assetModel } from '../../model/chat/assetModels'
import { MEDIA_TAG_NAMES, findMediaTags, isLinkedMediaPath, isPastedMediaPath, isTempMediaPath, mediaTagText, savedMediaTag, unsavedMediaTag, type MediaTag, type MediaTagData } from '../../model/chat/mediaTags'
import { assetModelLabel } from '../assetModelLabel'
import { sameModelFacts, type ModelFacts } from '../modelLabel'
import { leaveFullscreen } from '../fullscreen'
import MediaPlayer from '../media/MediaPlayer.vue'
import { expiryNotice } from '../media/clipState'
import { sectionsField, type SectionModel } from '../thread/cmEditor'
import { measureLineHeights } from '../thread/editorMeasure'
import { modelDisplayNames } from '../thread/modelChip'
import { selectedAssetLook } from './assetSelection'
import { focusKeepingScroll, syncDomSelection } from './focus'
import { compactionBlockEnd } from './compactionBlock'
import { noteDrawnAsset, type AssetPlace } from './drawnAssets'
import { HiddenAssetWidget, hiddenAssetOwnerKinds } from './hiddenAssets'
import { linesRemovalRange } from './images'
import { assetModelsChanged, lineBlocks, sectionRolesChanged, shownSectionTags } from './lineBlocks'
import { followShownRange, pendingRanges } from './pendingRanges'

// The audio and video clips of every section (media tags,
// src/model/chat/mediaTags.ts), each shown as a player in place of its tag:
// in agent sections the clips that models and Dez tools made, in user
// sections the clip files that the user pasted or dropped. The player is a
// Vue component (src/view/media/MediaPlayer.vue); this module is its owner
// in the editor: it finds the tags, mounts a player for each, and does the
// Save and the Delete of a clip, which rewrite or remove the tag.

const ROOT_CLASS = 'dez-media'

/** The class of the player's one tooltip whose text can be selected: the
 *  clock's tooltip (`MediaPlayer.vue`). */
const SELECTABLE_TOOLTIP_CLASS = 'media-player__tooltip--selectable'

/** Whether an event's target is in that tooltip. The target of a
 *  `selectstart` event can be a text node; mouse events always target an
 *  element. */
export function isInSelectableTooltip(target: EventTarget | null): boolean {
  const element = target instanceof Text ? target.parentElement : target
  return element instanceof Element && element.closest(`.${SELECTABLE_TOOLTIP_CLASS}`) !== null
}

/** A tag that the editor shows as a player, and whether a linked `src`
 *  counts there: only in a user section (`sectionClipSource`). The clips of
 *  the compaction block play in the assets chip (compactionChip.ts). */
interface RenderedMedia extends MediaTag {
  linkedSrc: boolean
}

/** A tag of `renderedMedia`, with the section that holds it. */
interface MediaInSection {
  tag: RenderedMedia
  section: SectionModel
}

interface MediaDecorations {
  /** In doc order. */
  media: readonly RenderedMedia[]
  /** The tags of `media` that are line blocks: each one but the tags of
   *  the compaction block (compactionBlock.ts), which the assets chip
   *  plays. */
  blocks: readonly RenderedMedia[]
  decorations: DecorationSet
}

/** The `src` values of the clips that a Save or a Delete works on. It is
 *  reactive, so each player of such a clip shows the busy state. A new
 *  editor state (a tab switch, the end of a stream) makes new players, and
 *  they read it too. */
const busyClips = reactive(new Set<string>())

/** The height of each player that was drawn, by clip, for
 *  `MediaWidget.estimatedHeight`. */
const playerHeights = new Map<string, number>()

function heightKey({ kind, src }: MediaTagData): string {
  return `${kind}:${src ?? ''}`
}

interface MountedPlayer {
  app: App
  /** The tag that the player shows now. */
  tag: ShallowRef<MediaTagData>
  /** The model label that the player shows now. */
  model: ShallowRef<ModelFacts | null>
  observer: ResizeObserver
}

const mountedPlayers = new WeakMap<HTMLElement, MountedPlayer>()

/** Mounts the player of the clip `shownTag`, and returns its root element.
 *  `linkedSrc` tells whether a linked `src` counts where the tag is
 *  (`clipSourceKind`), and `shownModel` is the label of the model that
 *  made the clip. `destroyPlayer` must take it down.
 *
 *  `place` tells where the tag is in the doc now, for the Save and the
 *  Delete. With none, the player is drawn in place of its tag, and its DOM
 *  tells (`MediaWidget`). The player of a hidden clip is drawn in the panel
 *  of its chip (toolCalls.ts), whose DOM is at the chip's place, so the
 *  chip gives the place; the preview box of a mention (assetPreview.ts)
 *  gives the place of the clip that it shows. */
export function createPlayer(view: EditorView, shownTag: MediaTagData, linkedSrc: boolean, shownModel: ModelFacts | null, place?: AssetPlace): HTMLElement {
  const root = document.createElement('span')
  root.className = ROOT_CLASS
  const tagPlace = place ?? (() => view.contentDOM.contains(root) ? view.posAtDOM(root) : null)
  noteDrawnAsset(root, tagPlace)
  const tag = shallowRef(shownTag)
  const model = shallowRef(shownModel)
  const app = createApp({
    // The player gets the source as the tag has it, and makes the URL
    // that loads it.
    render: () => {
      const { kind, id, type, src, expires } = tag.value
      return h(MediaPlayer, {
        kind,
        id,
        type,
        src,
        linkedSrc,
        expires,
        busy: src !== null && busyClips.has(src),
        model: model.value,
        onSave: () => { void saveClip(view, root, tagPlace, tag.value) },
        onDelete: () => { void deleteSavedClip(view, root, tagPlace, tag.value) },
      })
    },
  })
  app.mount(root)
  // The player changes its height in place (a video's size comes with its
  // metadata, and the card of a clip that does not play has its own
  // size), which CM does not see (see `measureLineHeights`).
  let drawnHeight = 0
  const observer = new ResizeObserver(() => {
    const height = root.offsetHeight
    // 0: the player is not in the document. A player in the preview box of
    // a mention (assetPreview.ts) is out of the text: its height is no
    // line's, and it has the size of the box.
    if (height === 0 || height === drawnHeight || !view.contentDOM.contains(root)) return
    drawnHeight = height
    playerHeights.set(heightKey(tag.value), height)
    measureLineHeights(view)
  })
  observer.observe(root)
  mountedPlayers.set(root, { app, tag, model, observer })
  // A press on the player keeps the caret and the focus where they are, as
  // a press on a tool call chip does. The controls work by pointer and
  // click events, which this does not stop. A press on the text of the
  // clock's tooltip keeps its default, so that the text can be selected.
  root.addEventListener('mousedown', (event) => {
    if (!isInSelectableTooltip(event.target)) event.preventDefault()
  })
  // On macOS a context click selects the word next to the pointer before
  // its `contextmenu` event, also after a canceled press, when the editor
  // has the focus (`sendContextMenuEvent` in WebKit's EventHandler.cpp).
  // So a right-click on the player, which opens its own menu
  // (`MediaPlayer.vue`), would move the editor's selection. That selection
  // starts with `selectstart`, and is canceled with it. The tooltip's text
  // is the only text of the player that can be selected.
  root.addEventListener('selectstart', (event) => {
    if (!isInSelectableTooltip(event.target)) event.preventDefault()
  })
  // A video.js slider gives the focus to its thumb when a press starts on
  // it, with no regard to the line above. So when the editor had the
  // focus, it gets it back at the end of the press. The slider stops its
  // pointer events from going up, so only capture listeners get them.
  //
  // A press on the tooltip's text puts the focus on the card. There the
  // give-back waits until the tooltip closes: a focused editor writes its
  // own selection to the DOM, which would end the user's selection in the
  // tooltip. So the debt stays over presses until a give-back pays it.
  let editorHadFocus = false
  let pressInTooltip = false
  root.addEventListener('pointerdown', (event) => {
    if (view.hasFocus) editorHadFocus = true
    pressInTooltip = isInSelectableTooltip(event.target)
  }, true)
  const giveFocusBack = () => {
    if (editorHadFocus && root.contains(document.activeElement)) focusKeepingScroll(view)
    editorHadFocus = false
  }
  const endPress = () => {
    if (!pressInTooltip) giveFocusBack()
  }
  root.addEventListener('pointerup', endPress, true)
  root.addEventListener('pointercancel', endPress, true)
  root.addEventListener('open-change', (event) => {
    const { open } = (event as CustomEvent<{ open: boolean }>).detail
    if (!open && isInSelectableTooltip(event.target)) giveFocusBack()
  }, true)
  // The card has the focus while the player fills the screen, so keys do
  // not go to the editor behind it. At the end, the editor gets the focus
  // back. The card is no Tab stop, so the focus is on it only then.
  root.addEventListener('fullscreenchange', () => {
    const active = document.activeElement
    if (!document.fullscreenElement && active?.localName === 'media-container' && root.contains(active)) focusKeepingScroll(view)
  })
  return root
}

/** Gives the mounted player `root` the new tag of its clip, after a Save or
 *  a Delete changed the tag's `src`, and the new label of the model that
 *  made it, after the names of the models came in. A new player would
 *  start from zero, with no Save animation; the drawn one keeps its place
 *  in the clip over a new source (`MediaPlayer.vue`). False when `root`
 *  has no player of that clip (a clip's kind and id never change). */
export function updatePlayer(root: HTMLElement, tag: MediaTagData, model: ModelFacts | null): boolean {
  const player = mountedPlayers.get(root)
  if (!player || player.tag.value.kind !== tag.kind || player.tag.value.id !== tag.id) return false
  // The player keeps its height, so its observer writes no entry for the
  // key of the new `src`. The old entry stays: an undo of the Save, or
  // another tag of the same file, still uses it.
  const height = playerHeights.get(heightKey(player.tag.value))
  if (height !== undefined) playerHeights.set(heightKey(tag), height)
  player.tag.value = tag
  player.model.value = model
  return true
}

/** Takes down the player that `createPlayer` mounted in `root`. Its media
 *  elements free their players as they leave the document
 *  (`v-release-on-remove` in `MediaPlayer.vue`). */
export function destroyPlayer(root: HTMLElement): void {
  const player = mountedPlayers.get(root)
  if (!player) return
  player.observer.disconnect()
  player.app.unmount()
  mountedPlayers.delete(root)
}

/** What a player shows of its clip: the tag, whether a linked `src` counts
 *  where the tag is (`clipSourceKind`), and the label of the model that
 *  made the clip. */
interface PlayerFacts {
  tag: MediaTagData
  linkedSrc: boolean
  model: ModelFacts | null
}

/** Whether two players show the same clip in the same way: every field
 *  that a player shows or that Save and Delete read. Doc offsets are left
 *  out: a stream token before a player moves it. A drawn player gets
 *  `updatePlayer` only when this is false, as a new tag object makes Vue
 *  draw it again. */
export function samePlayerFacts(a: PlayerFacts, b: PlayerFacts): boolean {
  return a.linkedSrc === b.linkedSrc && a.tag.kind === b.tag.kind && a.tag.id === b.tag.id && a.tag.type === b.tag.type
    && a.tag.src === b.tag.src && a.tag.url === b.tag.url && a.tag.expires === b.tag.expires && sameModelFacts(a.model, b.model)
}

/** The player of one clip, in place of its tag. */
class MediaWidget extends WidgetType {
  constructor(readonly tag: MediaTagData, readonly linkedSrc: boolean, readonly model: ModelFacts | null) {
    super()
  }
  eq(other: WidgetType): boolean {
    return other instanceof MediaWidget && samePlayerFacts(this, other)
  }
  toDOM(view: EditorView): HTMLElement {
    return createPlayer(view, this.tag, this.linkedSrc, this.model)
  }
  // A changed tag or model label goes to the drawn player (`updatePlayer`),
  // so CM makes no new one, and a clip that plays goes on. A new editor
  // state (`view.setState`: a tab switch, the end of a stream), a role
  // change of the section (which changes `linkedSrc`), or a hidden or kept
  // mark makes a new widget, so it stops a clip that plays.
  //
  // The player's element also stays in the document while CM draws its line
  // again, which a player that fills the screen needs: an element that
  // leaves the document ends its fullscreen. This rests on the order in
  // which CM takes the line's old widget buffers (the zero-width
  // `img.cm-widgetBuffer` on each side of an inline widget).
  // @codemirror/view 6.43.15 takes them in doc order. 6.41.1 took them in
  // the reverse order, and moved the player out of the line and back in to
  // make the DOM agree, so a Save in fullscreen ended the fullscreen (the
  // e2e case "keeps a video in fullscreen over a Save" covers it).
  updateDOM(dom: HTMLElement, _view: EditorView, from: MediaWidget): boolean {
    return from.linkedSrc === this.linkedSrc && updatePlayer(dom, this.tag, this.model)
  }
  destroy(dom: HTMLElement): void {
    destroyPlayer(dom)
  }
  // CM uses this for the lines that it has not drawn yet.
  get estimatedHeight(): number {
    return playerHeights.get(heightKey(this.tag)) ?? -1
  }
  // The player takes its own events; CM leaves them all alone.
  ignoreEvent(): boolean {
    return true
  }
}

/** The tags that the editor shows as players (`shownSectionTags`), in doc
 *  order, each with the section that holds it (for `assetModel`) and
 *  whether a linked `src` counts there. */
function findRenderedMedia(doc: string, sections: readonly SectionModel[]): MediaInSection[] {
  if (!MEDIA_TAG_NAMES.some((name) => doc.includes(`<${name}`))) return []
  return shownSectionTags(doc, sections, findMediaTags).map(({ tag, section, from, to }) => ({ tag: { ...tag, from, to, linkedSrc: section.role === 'user' }, section }))
}

function buildMediaDecorations(state: EditorState): MediaDecorations {
  const rendered = findRenderedMedia(state.doc.toString(), state.field(sectionsField, false) ?? [])
  // A clip of the compaction block gets no widget: the block is out of
  // view as a whole, and its clips play in the panel of the assets chip.
  const blockEnd = compactionBlockEnd(state.doc)
  const shown = blockEnd === 0 ? rendered : rendered.filter(({ tag }) => tag.from >= blockEnd)
  // A hidden clip plays in the panel of its chip (hiddenAssets.ts). It
  // stays a line block here; only its widget is the one of a hidden asset,
  // so that no second player of the clip is made.
  const hidden = hiddenAssetOwnerKinds(state)
  const names = modelDisplayNames(state)
  const decorations = Decoration.set(shown.map(({ tag, section }) => {
    const owner = hidden.get(tag.from)
    // The filter left out the clips of the compaction block.
    const model = owner ? null : assetModelLabel(assetModel(tag, section, false), names)
    return Decoration.replace({
      widget: owner ? new HiddenAssetWidget(tag.kind, tag.id, owner) : new MediaWidget(tag, tag.linkedSrc, model),
    }).range(tag.from, tag.to)
  }))
  return { media: rendered.map(({ tag }) => tag), blocks: shown.map(({ tag }) => tag), decorations }
}

/** Each media tag is replaced by its player. The ranges are atomic, so the
 *  caret is never inside the hidden text. A new model label
 *  (`assetModelsChanged`) changes no tag, so the tags stay the same
 *  objects. */
const mediaDecorationsField = StateField.define<MediaDecorations>({
  create: buildMediaDecorations,
  update(value, tr) {
    if (tr.docChanged || sectionRolesChanged(tr)) return buildMediaDecorations(tr.state)
    return assetModelsChanged(tr) ? { ...value, decorations: buildMediaDecorations(tr.state).decorations } : value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
})

const NO_MEDIA: readonly RenderedMedia[] = []

/** The tags that the editor shows as players in `state`, in doc order; none
 *  for a state without `markdownMedia()`. The tags of the compaction block
 *  are here too: they play in the panel of the assets chip, and the Save
 *  and the Delete find them here. The array is the same object until the
 *  doc or the sections change, so callers can cache by it. */
export function renderedMedia(state: EditorState): readonly RenderedMedia[] {
  return state.field(mediaDecorationsField, false)?.media ?? NO_MEDIA
}

function mediaBlocks(state: EditorState): readonly RenderedMedia[] {
  return state.field(mediaDecorationsField, false)?.blocks ?? NO_MEDIA
}

/** What `createPlayer` takes: the tag of a clip, whether a linked `src`
 *  counts where it is, and the label of the model that made it. */
export interface ClipToDraw {
  tag: MediaTagData
  linkedSrc: boolean
  model: ModelFacts | null
}

/** The clip that the editor plays in place of its tag at `from`
 *  (`MediaWidget`), as `createPlayer` takes it, with the model label of
 *  that place; null when it plays none there: a hidden clip, a clip of the
 *  compaction block, or no clip. The preview of a mention draws it so
 *  (assetPreview.ts). The tag has no doc offsets. */
export function shownClipAt(state: EditorState, from: number): ClipToDraw | null {
  let shown: ClipToDraw | null = null
  state.field(mediaDecorationsField, false)?.decorations.between(from, from, (start, _end, { spec }) => {
    if (start !== from || !(spec.widget instanceof MediaWidget)) return
    const { tag: { kind, id, type, src, url, expires, other }, linkedSrc, model } = spec.widget
    shown = { tag: { kind, id, type, src, url, expires, other }, linkedSrc, model }
    return false
  })
  return shown
}

/** Follows the tag of a player, which is at `place`, while async work on
 *  its clip runs (`followShownRange`). In a new state of the same tab the
 *  tag is found again by its kind, id, and `src`. Null when the tag is not
 *  in the doc now with the `src` of `clip`. */
function followClip(view: EditorView, place: AssetPlace, clip: MediaTagData) {
  const from = place()
  const isClip = (tag: MediaTag) => tag.kind === clip.kind && tag.id === clip.id && tag.src === clip.src
  const shown = renderedMedia(view.state).find((tag) => tag.from === from && isClip(tag))
  return shown ? followShownRange(view, shown, renderedMedia, isClip) : null
}

// A toast for the player `root`, which leaves fullscreen first
// (`leaveFullscreen`, fullscreen.ts), as it does before its delete prompt.
// The root's `fullscreenchange` listener then gives the focus back to the
// editor.
function warnClipChanged(root: HTMLElement, title: string, message: string): void {
  void leaveFullscreen(root)
  sbp('dez.ui/toast', 'app-global', { title, message, variant: 'warning', duration: 8000 })
}

/** The Save of the player `root`, whose tag is at `place`: keeps the file
 *  of `clip` (`dez.controller/media/save`: a download, or a move of the
 *  temp copy), then makes the saved file the `src` of the clip's tag
 *  (`savedMediaTag`).
 *  A failed save (the controller has shown a toast) keeps the tag. When the
 *  tag is gone at the end of a download (see `followClip`), the new file is
 *  deleted again, and a toast tells the user. The file of a temp copy has
 *  moved by then and stays: its tag, where it still is, names the temp copy
 *  that is gone. */
async function saveClip(view: EditorView, root: HTMLElement, place: AssetPlace, clip: MediaTagData): Promise<void> {
  const { src } = clip
  if (src === null || busyClips.has(src)) return
  const followed = followClip(view, place, clip)
  if (!followed) return
  busyClips.add(src)
  let path: string | null = null
  try {
    path = await sbp('dez.controller/media/save', { kind: clip.kind, type: clip.type, src, url: clip.url }) as string
  } catch {
    // The controller has logged the failure and shown a toast.
    void leaveFullscreen(root)
  }
  const tag = path === null ? null : followed.current()
  // In one synchronous block with the rewrite, so that the player goes from
  // "saving" to "saved" with no other state between.
  busyClips.delete(src)
  if (path !== null && tag) {
    followed.end({ from: tag.from, to: tag.to, insert: mediaTagText(savedMediaTag(tag, path)) })
    return
  }
  followed.end()
  if (path === null) return
  if (isTempMediaPath(src)) {
    const shownPath = await sbp('dez.controller/displayPath', path) as string
    warnClipChanged(root, 'Clip saved, but not shown', `The conversation changed while the clip was saved, so its player does not show the saved file. The file is at ${shownPath}.`)
    return
  }
  warnClipChanged(root, 'Clip not saved', 'The conversation changed while the clip was saved. Try again.')
  try {
    await sbp('dez.controller/media/delete', path)
  } catch {
    // The controller has logged the failure and shown a toast.
  }
}

/** The trash of the player `root`, whose tag is at `place`: asks whether
 *  to delete the saved file of `clip`, and on "Yes" deletes it
 *  (`dez.controller/media/delete`), then
 *  gives the clip's tag its source of before (`unsavedMediaTag`: the
 *  provider URL, or no source). The prompt warns when the clip can be lost
 *  after the delete: there is no URL, or the URL's `expires` is over (the
 *  rule of the player's clock). A clip that the user pasted or dropped
 *  (`isPastedMediaPath`) has no other source: its trash deletes the clip,
 *  and takes the tag's whole line out of the doc (`linesRemovalRange`), as
 *  the image trash does with an image reference. A linked clip
 *  (`isLinkedMediaPath`, linkedFiles.ts) keeps its file: its trash takes
 *  only the tag's line out, in a normal edit that an undo takes back (the
 *  other changes are not in the undo history, see `followShownRange`).
 *  When the tag is gone after the prompt (see `followClip`), no file is
 *  deleted, and a toast tells the user. A failed delete (the controller has
 *  shown a toast) keeps the tag. */
export async function deleteSavedClip(view: EditorView, root: HTMLElement, place: AssetPlace, clip: MediaTagData): Promise<void> {
  const { src } = clip
  if (src === null || busyClips.has(src)) return
  const followed = followClip(view, place, clip)
  if (!followed) return
  const linked = isLinkedMediaPath(src)
  const pasted = isPastedMediaPath(src)
  await leaveFullscreen(root)
  let message = 'Are you sure you want to delete the saved file of this clip?'
  if (linked) message = 'Are you sure you want to remove this clip from the conversation? Its file stays where it is.'
  else if (pasted) message = 'Are you sure you want to delete this clip?'
  else if (clip.url === null) message += ' The clip cannot be played again after that.'
  else if (expiryNotice(clip.expires, Date.now(), null)?.expired) message += ' The web address of the clip has expired, so the clip can stop playing after that.'
  const confirmed = await sbp('dez.ui/confirm', { message }) as boolean
  if (!confirmed) {
    followed.end()
    return
  }
  const current = followed.current()
  if (!current) {
    followed.end()
    warnClipChanged(root, linked ? 'Clip not removed' : 'Clip not deleted', 'The conversation changed while the prompt was open. Try again.')
    return
  }
  if (linked) {
    followed.end(linesRemovalRange(view.state.doc, current), { undoable: true, userEvent: 'delete' })
    syncDomSelection(view)
    return
  }
  busyClips.add(src)
  let deleted = false
  try {
    await sbp('dez.controller/media/delete', src)
    deleted = true
  } catch {
    // The controller has logged the failure and shown a toast. The user can
    // have gone to fullscreen again after the prompt.
    void leaveFullscreen(root)
  }
  // When the tag went while its file was deleted, its text stays where it
  // is, and its player says that the clip is not available.
  const tag = deleted ? followed.current() : null
  busyClips.delete(src)
  if (!tag) {
    followed.end()
    return
  }
  followed.end(pasted ? linesRemovalRange(view.state.doc, tag) : { from: tag.from, to: tag.to, insert: mediaTagText(unsavedMediaTag(tag)) }, { userEvent: 'delete' })
  // The prompt gave the focus back a few ms ago (`syncDomSelection`).
  syncDomSelection(view)
}

/** Media players for the thread editor (`buildState()` in
 *  `ThreadEditor.vue`). The players are line blocks (`lineBlocks.ts`), as
 *  the tool call chips are. Find skips the hidden text (`protectedRanges`
 *  in `find.ts`). A player inside a selection looks selected
 *  (`assetSelection.ts`). The widget's CSS is in `dezTheme`, and the
 *  player's in `MediaPlayer.vue`. The state needs `sectionsField`. */
export function markdownMedia(): Extension {
  return [mediaDecorationsField, lineBlocks(mediaBlocks), pendingRanges(), selectedAssetLook(ROOT_CLASS, mediaBlocks)]
}
