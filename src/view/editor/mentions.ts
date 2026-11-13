import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from '@codemirror/view'
import { namedMentions, type AssetKind } from '../../model/chat/assetMentions'
import { plainLiveText } from '../../model/chat/content'
import { sectionsField } from '../thread/cmEditor'
import { tooltipContent } from './images'
import { sectionRolesChanged, sectionTexts } from './lineBlocks'

// An `@id` mention (src/model/chat/imageMentions.ts) that names an image or
// a clip of the conversation shows as a chip: a small rounded fill behind
// the text, in the mention color. The chip tells the user that Dez read the
// word as a mention, and which asset it names; a word with no chip (`@zz`,
// an e-mail address) is plain text for a request too. The mention stays
// doc text, so the caret, the selection, find, and copy work as on any
// text: the chip is a mark decoration, never a widget.
//
// The chips come from `namedMentions` (assetMentions.ts), the rule that a
// test ties to the request builder. Sections of both roles get them: a
// reply can name an asset too, and its id reads the same there.

/** A mention that the editor shows as a chip: its doc range, its id, and
 *  what the id names. */
export interface ShownMention {
  from: number
  to: number
  id: string
  kind: AssetKind
}

interface MentionDecorations {
  /** In doc order. */
  mentions: readonly ShownMention[]
  decorations: DecorationSet
}

const chip = Decoration.mark({ class: 'dez-mention' })

/** The mentions that get a chip, in doc order. Each section is read as a
 *  request reads it: its plain text, with the bodies of its prompt pills
 *  and no pill marker (`plainLiveText`), so a mention in an expanded pill's
 *  body gets its chip. (One in a collapsed pill is under the pill's widget,
 *  so its mark draws nothing.) Not shown: a mention with a pill marker
 *  inside it, which a request reads as one word (`@` at the end of a
 *  pill's body and the id right after the pill): one mark cannot go over
 *  the marker's hidden range. A state with no `sectionsField` has no
 *  roles, so it has no chips. */
function findShownMentions(state: EditorState): ShownMention[] {
  const sections = state.field(sectionsField, false)
  if (!sections) return []
  const doc = state.doc.toString()
  if (!doc.includes('@')) return []
  const texts = sectionTexts(doc, sections)
  const plain = texts.map(({ text }) => plainLiveText(text))
  const named = namedMentions(texts.map(({ section }, index) => ({ role: section.role, text: plain[index].text })))
  return texts.flatMap(({ from }, index) => named[index].flatMap((mention): ShownMention[] => {
    const { liveOffset } = plain[index]
    const start = liveOffset(mention.from)
    // The offset of the last char, not of the char after the mention: a
    // marker right after the mention is not part of it.
    const end = liveOffset(mention.to - 1) + 1
    if (end - start !== mention.to - mention.from) return []
    return [{ from: from + start, to: from + end, id: mention.id, kind: mention.kind }]
  }))
}

function buildMentionDecorations(state: EditorState): MentionDecorations {
  const mentions = findShownMentions(state)
  return { mentions, decorations: Decoration.set(mentions.map((mention) => chip.range(mention.from, mention.to))) }
}

/** The chips come only from the doc text and the roles of the sections,
 *  never from the caret or the viewport: a mention gets its chip as soon as
 *  the doc holds the asset that it names (a paste, a reply's image), and
 *  loses it when that asset's text goes. A mention reads only its own and
 *  earlier sections, but a change in any section can change the chips of
 *  the sections after it, so each doc change reads the whole doc again, as
 *  the images and the players do. */
const mentionDecorationsField = StateField.define<MentionDecorations>({
  create: buildMentionDecorations,
  update: (value, tr) => tr.docChanged || sectionRolesChanged(tr) ? buildMentionDecorations(tr.state) : value,
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

const NO_MENTIONS: readonly ShownMention[] = []

/** The mentions that show as chips in `state`, in doc order; none for a
 *  state without `mentionChips()`. */
export function shownMentions(state: EditorState): readonly ShownMention[] {
  return state.field(mentionDecorationsField, false)?.mentions ?? NO_MENTIONS
}

/** The chip at `pos`: the one that holds `pos` inside, or that starts or
 *  ends there when `side` points into it. */
export function mentionAt(state: EditorState, pos: number, side: -1 | 1): ShownMention | null {
  return shownMentions(state).find(({ from, to }) => (from < pos && pos < to) || (pos === from && side > 0) || (pos === to && side < 0)) ?? null
}

/** The text of a chip's tooltip: what the id names (the title is the one
 *  of the id badge of that image or player, so the two read as the same
 *  id), then the rule that makes the mention useful. Help › Assets ("What a
 *  model sees", HelpView.vue) tells the same rules: keep the two true. */
function mentionTooltip({ id, kind }: ShownMention): HTMLElement {
  if (kind === 'image') {
    return tooltipContent(`Image id: ${id}`, `This names the image ${id}. A model sees an older image only when your newest message names it.`)
  }
  return tooltipContent(
    `${kind === 'video' ? 'Video' : 'Audio'} id: ${id}`,
    `This names the ${kind} clip ${id}. A model that takes ${kind} gets an older clip only when your newest message names it. A chat model gets only the id.`,
  )
}

/** The gap between a chip's text and its tooltip. The fill of a chip hangs
 *  out of its text, so a tooltip with no gap touches the fill. */
const MENTION_TOOLTIP_GAP_PX = 4

/** Hovering a chip shows what it names, above it (below, the pointer would
 *  cover the start of the text). The tooltip goes when its chip does: an
 *  edit of the mention, or of the asset that it names. */
const mentionHover = hoverTooltip(
  (view, pos, side) => {
    const mention = mentionAt(view.state, pos, side)
    if (!mention) return null
    return {
      pos: mention.from,
      end: mention.to,
      above: true,
      create: () => ({ dom: mentionTooltip(mention), offset: { x: 0, y: MENTION_TOOLTIP_GAP_PX } }),
    }
  },
  { hideOn: (tr, tooltip) => mentionAt(tr.state, tr.changes.mapPos(tooltip.pos), 1) === null },
)

/** The mention chips of the thread editor (`buildState()` in
 *  `ThreadEditor.vue`), with their tooltips. The state needs
 *  `sectionsField`. The CSS is in `dezTheme`. */
export function mentionChips(): Extension {
  return [mentionDecorationsField, mentionHover]
}
