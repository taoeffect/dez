import type { MessagePart, PicturePart } from '../chat/types'
import type { StreamMessage } from './types'

// The pictures that the `asset_view` calls of one reply show the model.
// The section never holds them: a request of the reply sends them in one
// `user` message right after the tool message of the round whose call
// showed them. Each later request of the same reply sends them again, at
// the same place, as the same bytes: the prompt cache needs the same bytes
// of the earlier messages, and so do the thinking replays, as a replay
// goes back only while the request before it hashes to its `prefixHash`
// (`wireChat`, providers/apiFormats.ts). The next reply has none of them:
// a model that needs a picture again calls `asset_view` again. The
// Anthropic format joins the message to the tool results before it, after
// the results (`withResultsJoined`).

/** The most pictures of one reply: each later request of the reply sends
 *  every one of them again. */
export const MAX_REPLY_PICTURES = 12

/** One picture that a tool shows the model. */
export interface ReplyPicture {
  /** What the picture shows: the text that goes right before it. */
  label: string
  picture: PicturePart
}

/** The pictures of one reply. */
export class ReplyPictures {
  // By the id of the first call of the group of calls whose round showed
  // them: the `callId` of the first result of that round's tool message.
  private readonly byRound = new Map<string, ReplyPicture[]>()
  private count = 0

  /** How many more pictures the reply can show. */
  get left(): number {
    return MAX_REPLY_PICTURES - this.count
  }

  /** Keeps `pictures` for the round whose group of calls starts with the
   *  call `roundCallId`, in order, after the earlier ones of that round:
   *  at most `left` of them, the first ones. */
  add(roundCallId: string, pictures: readonly ReplyPicture[]): void {
    const kept = pictures.slice(0, this.left)
    if (kept.length === 0) return
    const round = this.byRound.get(roundCallId)
    if (round) round.push(...kept)
    else this.byRound.set(roundCallId, [...kept])
    this.count += kept.length
  }

  /** `messages` with the picture message of each round right after the
   *  tool message of that round. */
  inMessages(messages: readonly StreamMessage[]): StreamMessage[] {
    return messages.flatMap((message): StreamMessage[] => {
      const pictures = message.role === 'tool' && message.results.length > 0 ? this.byRound.get(message.results[0].callId) : undefined
      if (!pictures) return [message]
      return [message, { role: 'user', content: pictures.flatMap(({ label, picture }): MessagePart[] => [{ type: 'text', text: label }, picture]) }]
    })
  }
}
