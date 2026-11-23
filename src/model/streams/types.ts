import type { ActiveModel, MessagePart, RequestMessage } from '../chat/types'

export type StreamStatus = 'idle' | 'streaming' | 'finished' | 'error' | 'cancelled'

export type StreamEndStatus = Exclude<StreamStatus, 'idle' | 'streaming'>

// A request message before `dez.provider/streamChat` reads its image bytes
// (sectionsToStreamMessages).
export type StreamMessage = RequestMessage<MessagePart>

export interface RequestMessages {
  messages: StreamMessage[]
  // The images of the newest user message that went as text only, because
  // the request model does not read images.
  imagesLeftOut: number
  // The images of the conversation that went as text only, and the
  // pictures (of its compaction tag, and of its `asset_view` calls) that
  // did not go, because the request or their message holds as many images
  // as its model takes (`RequestOptions.imageLimit` and
  // `messageImageLimit`, messages.ts).
  imagesOverLimit: number
  // The newest user message as a message of its own: the source of a media
  // request (`mediaRequestInput`). In `messages` it can be a part of the
  // compaction message. With no user message, it is the last message part
  // of the notes of a compaction (`notesMessages`); `''` when there is
  // none either.
  newestUserMessage: string | MessagePart[]
  // The request offers the Dez tools: the Tools toggle applies to the model
  // (`toolsApply` in providers/modelToggles.ts), and the provider's toggle
  // is on.
  sendTools: boolean
}

export interface StreamStartInput {
  tabId: string
  sectionId: string
  model: ActiveModel
  messages: StreamMessage[]
}

/** When one tool call of a reply started, and when it ended: null while it
 *  runs. */
export interface CallTime {
  startedAt: number
  endedAt: number | null
}

export interface StreamSessionState {
  tabId: string
  sectionId: string
  status: StreamStatus
  model: ActiveModel
  startedAt: number
  finishedAt: number | null
  /** The reply waits for a compaction request (controller/compaction.ts):
   *  it writes no text until the compaction ends. */
  compacting: boolean
  /** The tool calls of the reply that started, by call id, for the live
   *  times of their chips. The blocks of a group stay `running` until the
   *  whole group ends, so only these times tell the view which call of the
   *  group runs now. */
  callTimes: Record<string, CallTime>
}

/** A session after its stream ended (finished, failed, or stopped). */
export interface EndedStreamSession extends StreamSessionState {
  status: StreamEndStatus
  finishedAt: number
}

/** What the view needs for the live times of a reply that runs: the
 *  section that it writes, when it started, and its tool calls. */
export interface LiveTimes {
  sectionId: string
  startedAt: number
  calls: Readonly<Record<string, CallTime>>
}

export interface StreamTerminalInput {
  tabId: string
  status: StreamEndStatus
}
