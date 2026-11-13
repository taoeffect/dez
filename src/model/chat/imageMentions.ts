import { IMAGE_ID_SOURCE } from './images'

// A mention is `@` and an id in a user message: `@a` names the image whose
// reference has `id=a` (the badge on the image shows the id), or the clip
// whose media tag has `id="a"` (mediaTags.ts). The user types it to say
// which image or clip a request is about ("edit @a to add an apple", "make
// @c move to the beat of @b"). The request builder then sends that image
// with the message, at the place of the mention, while the message is the
// newest user message of the request (`sectionsToStreamMessages`,
// streams/messages.ts). A clip goes only to a media request, for a model
// that takes clips (`messageClips`, `mediaRequestInput`). The mention
// itself stays in the text as the user typed it.
//
// Most `@` words are not mentions: an e-mail address, a user name, a
// decorator in code. So a word counts only when it has the form below and
// an image or a clip has its id; every other word is plain text, with no
// error. This module finds the words of that form; `namedMentions`
// (assetMentions.ts) and the request builder know the images and the
// clips. The editor shows a mention that names one as a chip
// (view/editor/mentions.ts).

// The chars of a word, as the inside of a character class: the letters
// (with their combining marks) and digits of any script, and `_`.
const WORD_CHARS = String.raw`\p{L}\p{M}\p{N}_`
// `@` and one whole id: no word char comes before the `@` (`bob@a.com` is an
// address) or after the id (`@about` is the id `about`, never `a`, and `@a2`
// is no id). A `-` that joins the id to a word char makes one hyphenated
// word, which is no mention either: `@a-team` and `@a-1` are plain text.
// Every other char around a mention is fine: `(@a)`, `[@a]`, `@a, …`,
// `@a. …`, `@a: …`, and a `-` with no word char after it (`@a - b`). The
// regex takes the char before the `@` into the match, in place of a
// lookbehind, which older WebKit versions cannot parse. That char is never
// part of the mention before it, as a mention ends with a letter.
const MENTION = new RegExp(String.raw`(^|[^${WORD_CHARS}])@(${IMAGE_ID_SOURCE})(?![${WORD_CHARS}]|-[${WORD_CHARS}])`, 'gu')

/** One word of a text that has the form of a mention of an image or a
 *  clip. */
export interface AssetMention {
  /** Offset of the `@`. */
  from: number
  /** Offset after the id. */
  to: number
  id: string
}

/** The words of `text` that have the form of a mention of an image or a
 *  clip, in order. Give it only text outside image references: a path or a
 *  metadata value can hold an `@`. */
export function findAssetMentions(text: string): AssetMention[] {
  // `matchAll` copies the regex, so the shared one keeps no `lastIndex`.
  return Array.from(text.matchAll(MENTION), (match) => {
    const from = match.index + match[1].length
    return { from, to: from + 1 + match[2].length, id: match[2] }
  })
}
