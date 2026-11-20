import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { findAppTags, type AppTag } from '../../model/chat/appTags'
import { SENTINEL_CHAR, plainLiveText } from '../../model/chat/content'
import { sectionsField, type SectionModel } from '../thread/cmEditor'
import { compactionBlockEnd } from './compactionBlock'
import { lineBlocks, sectionRolesChanged, sectionTexts } from './lineBlocks'
import { ROUND_STROKE, svgIcon, type IconShapes } from './svgIcon'

// The apps that Dez shows in a conversation (app tags,
// src/model/chat/appTags.ts), each shown as a card in place of its tag,
// in every section: `apps show` writes a tag into a reply, and a paste can
// bring one into a user section. The card names the app. It is a line
// block, as a media player is (media.ts).

const ROOT_CLASS = 'dez-app'

// A window with a title bar.
const APP_ICON_SHAPES: IconShapes = [
  ['rect', { x: '2', y: '3', width: '12', height: '10', rx: '2', ...ROUND_STROKE, 'stroke-width': '1.3' }],
  ['path', { d: 'M2.3 6.3h11.4', ...ROUND_STROKE, 'stroke-width': '1.3' }],
]

interface AppDecorations {
  /** In doc order. */
  apps: readonly AppTag[]
  decorations: DecorationSet
}

/** The card of one app, in place of its tag. The root has the name of the
 *  app (`data-app`). */
class AppWidget extends WidgetType {
  constructor(readonly name: string) {
    super()
  }
  eq(other: WidgetType): boolean {
    return other instanceof AppWidget && other.name === this.name
  }
  toDOM(): HTMLElement {
    const root = document.createElement('span')
    root.className = ROOT_CLASS
    root.dataset.app = this.name
    const card = document.createElement('span')
    card.className = `${ROOT_CLASS}__card`
    const icon = document.createElement('span')
    icon.className = `${ROOT_CLASS}__icon`
    icon.append(svgIcon('0 0 16 16', APP_ICON_SHAPES))
    const label = document.createElement('span')
    label.className = `${ROOT_CLASS}__label`
    label.textContent = 'App'
    const name = document.createElement('span')
    name.className = `${ROOT_CLASS}__name`
    name.textContent = this.name
    card.append(icon, label, name)
    root.append(card)
    return root
  }
}

/** The tags that the editor shows as cards, in doc order, as doc ranges.
 *  Each section is read on its own (`sectionTexts`). Left as text: a line
 *  that is not a valid tag, a tag that holds a sentinel (a prompt pill),
 *  whose widgets and atomic ranges must stay the only ones there, a tag in
 *  Markdown code of the section's plain text (`plainLiveText`), which a
 *  request reads, and a tag before `blockEnd`, the end of the compaction
 *  block, which is out of view as a whole. */
function findRenderedApps(doc: string, sections: readonly SectionModel[], blockEnd: number): AppTag[] {
  const apps: AppTag[] = []
  if (!doc.includes('<dez:app')) return apps
  for (const { section, from, text } of sectionTexts(doc, sections)) {
    const tags = findAppTags(text, section.role, { inCode: true }).filter((tag) => !SENTINEL_CHAR.test(text.slice(tag.from, tag.to)))
    if (tags.length === 0) continue
    const plain = plainLiveText(text)
    const outOfCode = new Set(findAppTags(plain.text, section.role).map((tag) => plain.liveOffset(tag.from)))
    for (const tag of tags) {
      if (outOfCode.has(tag.from) && from + tag.from >= blockEnd) apps.push({ name: tag.name, from: from + tag.from, to: from + tag.to })
    }
  }
  return apps
}

function buildAppDecorations(state: EditorState): AppDecorations {
  const apps = findRenderedApps(state.doc.toString(), state.field(sectionsField, false) ?? [], compactionBlockEnd(state.doc))
  return { apps, decorations: Decoration.set(apps.map((tag) => Decoration.replace({ widget: new AppWidget(tag.name) }).range(tag.from, tag.to))) }
}

/** Each app tag is replaced by its card. The ranges are atomic, so the
 *  caret is never inside the hidden text. */
const appDecorationsField = StateField.define<AppDecorations>({
  create: buildAppDecorations,
  update: (value, tr) => tr.docChanged || sectionRolesChanged(tr) ? buildAppDecorations(tr.state) : value,
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
})

const NO_APPS: readonly AppTag[] = []

/** The tags that the editor shows as cards in `state`, in doc order; none
 *  for a state without `markdownApps()`. The array is the same object
 *  until the doc or the sections change, so callers can cache by it. */
export function renderedApps(state: EditorState): readonly AppTag[] {
  return state.field(appDecorationsField, false)?.apps ?? NO_APPS
}

/** App cards for the thread editor (`buildState()` in `ThreadEditor.vue`).
 *  The cards are line blocks (`lineBlocks.ts`), as the media players are.
 *  Find skips the hidden text (`protectedRanges` in `find.ts`). The CSS of
 *  the card is in `dezTheme`. The state needs `sectionsField`. */
export function markdownApps(): Extension {
  return [appDecorationsField, lineBlocks(renderedApps)]
}
