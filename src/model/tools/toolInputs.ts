import type { ClipReadProblem } from '../chat/mediaFiles'
import type { MediaTagKind } from '../chat/mediaTags'
import type { ConversationAssets, PromptInput } from '../streams/mediaRequest'
import { ASSET_NAMES } from './jobs'

// What the tools share about the images and the clips of a conversation
// that a call takes as its inputs: the text of an `@id` word that names
// nothing, and the text of a clip that Dez could not read. Each text is a
// tool result, which goes to the chat provider: it names an image or a
// clip by its id only.

/** An image or a clip in a text for a model, as in `the image @a`. */
export function assetText({ id, kind }: PromptInput): string {
  return `the ${ASSET_NAMES[kind]} @${id}`
}

/** The words of the tool whose argument names its inputs with `@id`. */
export interface InputWording {
  /** The argument, as the text names it: `` `prompt` ``. */
  argument: string
  /** What Dez did not do for the call, as a sentence. */
  notDone: string
}

/** Why a call whose argument holds the `@id` words `unknownIds`, which
 *  name no image and no clip, does nothing; null when it can go. A model
 *  that names an input that is not there (a wrong id, an image that the
 *  user deleted) would pay or wait for a result without it. Most `@` words
 *  are no ids (a user name, an address), so only a word that is as short
 *  as an id of this conversation counts: a word longer than `nextId`, the
 *  next free id, cannot be one. */
export function unknownInputsProblem(
  unknownIds: readonly string[],
  assets: ConversationAssets,
  nextId: string,
  { argument, notDone }: InputWording,
): string | null {
  const unknown = unknownIds.filter((id) => id.length <= nextId.length).map((id) => `@${id}`)
  if (unknown.length === 0) return null
  const lead = `${unknown.join(', ')} ${unknown.length === 1 ? 'names' : 'name'} no image and no clip of this conversation`
  const known = [
    ...Array.from(assets.images.keys(), (id) => assetText({ id, kind: 'image' })),
    ...Array.from(assets.clips.values(), assetText),
  ]
  const notAnInput = 'Write a word that is no input without the @.'
  return known.length === 0
    ? `${lead}: it has none, so ${argument} can name no input. ${notDone} ${notAnInput}`
    : `${lead}. ${notDone} The conversation has ${known.join(', ')}: call again with these ids. ${notAnInput}`
}

/** The error result of a call of the tool `tool` whose input clip `id`
 *  Dez could not read (`ClipReadError`), by its problem. The details of
 *  the error tell what each source of the clip gave. */
export function clipReadProblemText(kind: MediaTagKind, id: string, tool: string, problem: ClipReadProblem): string {
  const name = `${ASSET_NAMES[kind]} @${id}`
  switch (problem) {
    case 'deleted':
      return `The ${name} is gone: the user deleted its file, and it has no web address to download it from. `
        + `This is not a fault of the call. Tell the user, and do not call the ${tool} tool again for @${id}.`
    case 'expired':
      return `The ${name} has expired: the provider that made it does not keep it any more, and the user did not save it. `
        + `This is not a fault of the call. Tell the user, and do not call the ${tool} tool again for @${id}.`
    case 'unreadable':
      return `Dez could not read the ${name}: its file is gone, Dez may not read it, or its server did not send it (the details tell which). `
        + `This is not a fault of the call. Tell the user, and call the ${tool} tool again for @${id} only when the user asks for it.`
  }
}
