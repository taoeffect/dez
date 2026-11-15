import sbp from '@sbp/sbp'
import { assetPlaces } from '../model/chat/assetOrigins'
import { sectionPlainText } from '../model/chat/content'
import type { ConversationCost } from '../model/chat/conversationCost'
import { findImageReferences } from '../model/chat/images'
import type { NewPicture, ShownPicture } from '../model/chat/shownPictures'
import type { ModelRef, Section } from '../model/chat/types'
import { failedChatRequestCost, type ChatUsage } from '../model/providers/chatUsage'
import type { ClipAttachment } from '../model/providers/clipInputs'
import { modelFamily } from '../model/providers/modelFamilies'
import type { ProviderStreamChatResult } from '../model/providers/streamTypes'
import type { GeneratedClip, ModelInfo } from '../model/providers/types'
import { compactedSections, type CompactedSections } from '../model/streams/compactedSections'
import {
  assetDecisions,
  assetTableText,
  carriedAssetLines,
  clipPictureLabel,
  compactionAssets,
  compactionScope,
  keptUserTexts,
  openJobInputs,
  type AssetChoice,
} from '../model/streams/compactionAssets'
import { answerHasNotes, compactionInstruction, readCompactionAnswer } from '../model/streams/compactionRequest'
import { conversationAssets, type FoundAsset } from '../model/streams/mediaRequest'
import { compactedPictureLimits, requestImageCount } from '../model/streams/pictureBudget'
import type { StreamMessage } from '../model/streams/types'
import { probedClipFacts, type ProbedClip } from '../model/tools/assetFacts'
import { ASSET_INFO_TOOL } from '../model/tools/assetInfo'
import { assetViewCall } from '../model/tools/assetView'
import type { JobInfo } from '../model/tools/jobs'
import { clipInput } from '../model/tools/programRuns'
import { ToolError, type ToolDefinition } from '../model/tools/types'
import { ExplainedError } from '../utils/errorText'
import { probeClip, readImageFacts } from './assetInfo'
import { viewClip } from './assetView'
import { logRequest } from './diagnostics/requestLog'
import { discardMadeAssets, generatedClipAsset } from './jobs'
import { inWorkFolder } from './programRuns'
import { discardShownPictures, saveShownPictures } from './shownPictures'

// The compaction of a conversation (model/chat/compaction.ts): one request
// that asks the model of a reply for the notes of the work so far, and the
// sections that take the place of the conversation. The pure parts are in
// model/streams (compactionRequest.ts: the instruction and the reader of
// the answer; compactionAssets.ts: the assets and what happens to each
// one; compactedSections.ts: the new sections). This module does their
// work on the files and sends the request.
//
// It registers no selector, and it changes no tab: its caller puts the
// result into the tab, when the reply is still the one that asked.

/** The explanation of a compaction whose answer holds no notes. The toast
 *  of a failed compaction (`dez.stream/start`) first tells what Dez tried,
 *  and that the conversation stays as it is. */
export const NO_COMPACTION_NOTES_TEXT = 'The model did not write the notes that Dez asked it for. Send the message again, or choose another model.'

/** What a compaction needs. */
export interface CompactionInput {
  /** The tab of the conversation, for the developer's request log. */
  tabId: string
  conversationId: string
  /** The sections of the tab. */
  sections: readonly Section[]
  /** The id of the section of the reply that runs. At a submit, that is
   *  the empty section of the new reply. */
  replySectionId: string
  /** The model that gets the request, and that the compaction section
   *  names as its writer: the model of the reply. */
  model: ModelRef
  /** The model that reads the compacted conversation, when it is not
   *  `model`: the pictures of the result follow its limits. A reply to a
   *  model whose context window is too small for the conversation gives it
   *  (`dez.stream/start`); then `model` is the model of an earlier reply. */
  readerModel?: ModelRef
  /** The messages, the system prompt, the tools, the output flags, and the
   *  provider settings of the next request of the reply. The compaction
   *  request sends them as they are, so it reads the prompt cache of the
   *  requests before it, and one more user message after them. */
  messages: readonly StreamMessage[]
  system: string | undefined
  tools: readonly ToolDefinition[]
  imageOutput: boolean
  audioOutput: boolean
  providerSettings: Record<string, boolean> | undefined
  /** The id of the request: `dez.http/cancelStream` with it cancels the
   *  request. */
  requestId: string
  /** Stops the compaction: the request, and the runs of the programs. The
   *  compaction then rejects with the stop. */
  signal: AbortSignal
  /** The jobs of the reply that runs. A reply that sent no request yet
   *  (a compaction at a submit) has none. */
  jobs: readonly JobInfo[]
  /** The cost of the conversation now. Read before the request, for the
   *  instruction, and after `countCost`, for the notes: a job of the reply
   *  can count a request of its own meanwhile. */
  cost: () => ConversationCost | undefined
  /** Counts the price of the compaction request in the cost of the tab
   *  (null: not known). Called once, and only for a request that went. */
  countCost: (usd: number | null) => void
}

/** What a compaction gives: the new sections of the tab, the assets that
 *  left the conversation, and the saved pictures that the new compaction
 *  tag names. A caller that does not put the sections into its tab
 *  discards these pictures (`discardShownPictures`). */
export interface Compaction extends CompactedSections {
  /** What the provider told about the tokens of the compaction request:
   *  its input tokens are the size of the conversation that the compaction
   *  replaces. */
  usage: ChatUsage | undefined
}

// The probe of `clip` on a copy in the work folder `folder`. A run that
// did not start (a `ToolError`; `runProgram` logged its cause) fails only
// the facts of its clip.
async function clipProbe(clip: ClipAttachment, folder: string, signal: AbortSignal): Promise<ProbedClip> {
  try {
    // The probe of `asset_info`, whose name only the text of that
    // `ToolError` holds.
    return await probeClip(clipInput(clip), folder, signal, ASSET_INFO_TOOL.name)
  } catch (error) {
    if (!(error instanceof ToolError)) throw error
    return { kind: 'notProbed' }
  }
}

// What a compaction reads of the files of the assets `found`, the assets
// of the sections of `sections` before `end`:
// - `facts`: the facts text of each asset that has no line in the notes of
//   the compaction before (`carriedAssetLines`), by its id. The line of an
//   earlier asset tells its facts.
// - `imageBytes`: how many bytes a request sends for each image of those
//   sections that a request can send (the file, or its smaller copy;
//   `dez.provider/chatImageSizes`), by its path. An image that Dez cannot
//   read, or that the webview cannot decode, has no entry.
async function readAssetFiles(
  sections: readonly Section[],
  end: number,
  found: readonly FoundAsset[],
  signal: AbortSignal,
): Promise<{ facts: Map<string, string>, imageBytes: Map<string, number> }> {
  const carried = carriedAssetLines(sections)
  const facts = new Map<string, string>()
  // The images that a request can send, as far as the reads tell.
  const sendable = new Set<string>()
  const notRead = new Set<string>()
  for (const asset of found) {
    if (asset.kind !== 'image' || carried.has(asset.id)) continue
    signal.throwIfAborted()
    const { path } = asset.reference
    const read = await readImageFacts(asset.id, path)
    facts.set(asset.id, read.facts)
    if (read.kind === 'read') sendable.add(path)
    else if (read.kind === 'notRead') notRead.add(path)
  }
  // The other images: the earlier ones, the ones with no id, and a second
  // reference of an id.
  for (const section of sections.slice(0, end)) {
    for (const { path } of findImageReferences(sectionPlainText(section), section.role)) if (!notRead.has(path)) sendable.add(path)
  }
  signal.throwIfAborted()
  const imageBytes = await sbp('dez.provider/chatImageSizes', [...sendable]) as Map<string, number>

  const clips = found.flatMap((asset) => (asset.kind === 'clip' && !carried.has(asset.id) ? [asset.clip] : []))
  if (clips.length > 0) {
    await inWorkFolder(async (folder) => {
      for (const clip of clips) {
        signal.throwIfAborted()
        facts.set(clip.id, probedClipFacts(clip, await clipProbe(clip, folder, signal)))
      }
    })
  }
  return { facts, imageBytes }
}

// The compaction request with the messages `messages`: the answer text,
// and what the provider told about the tokens. The answer goes nowhere
// else: no text into the tab, and no tool call of it runs. A request that
// went counts in the cost of the tab and has a row in the developer's
// request log, also when it failed.
async function requestNotes(input: CompactionInput, messages: StreamMessage[]): Promise<{ text: string, usage: ChatUsage | undefined }> {
  let text = ''
  let sent = false
  const startedAt = Date.now()
  const imageCount = requestImageCount(messages)
  const countRequest = (cost: number | null, usage?: ChatUsage) => {
    input.countCost(cost)
    logRequest({ tabId: input.tabId, kind: 'compaction', model: input.model, startedAt, usage, cost, imageCount })
  }
  let result: ProviderStreamChatResult
  try {
    result = await sbp('dez.provider/streamChat', {
      providerId: input.model.providerId,
      conversationId: input.conversationId,
      system: input.system,
      tools: input.tools,
      imageOutput: input.imageOutput,
      audioOutput: input.audioOutput,
      modelId: input.model.modelId,
      messages,
      requestId: input.requestId,
      providerSettings: input.providerSettings,
      signal: input.signal,
      onSent: () => { sent = true },
      onToken: (token: string) => { text += token },
      onThinking: () => {},
      // A model that makes images or audio gets the same request body as
      // in its chat rounds (the prompt cache needs it), so its answer can
      // hold one. The notes are text: an image is not saved, and the temp
      // copy of the audio goes.
      onImage: () => {},
      onClip: (clip: GeneratedClip) => discardMadeAssets([generatedClipAsset(clip)]),
    }) as ProviderStreamChatResult
  } catch (error) {
    if (sent) countRequest(failedChatRequestCost(error))
    throw error
  }
  // Also when a stop cut the answer off: it gives no price.
  countRequest(result.cost ?? null, result.usage)
  return { text, usage: result.usage }
}

// The picture of `clip` that a compaction keeps for its model: the frame
// sheet of a video clip, or the wave of an audio clip, as `asset_view`
// draws them with no other argument. Null for a clip with no picture (Dez
// cannot read it, or it has no frame and no sound), and for a run that did
// not start (a `ToolError`; `runProgram` logged its cause).
async function clipPicture(clip: ClipAttachment, folder: string, signal: AbortSignal): Promise<NewPicture | null> {
  try {
    const { picture } = await viewClip(clip, assetViewCall({ assets: `@${clip.id}` }), 'show', folder, signal)
    return picture && { label: clipPictureLabel(picture.shows), file: picture.file, size: picture.size }
  } catch (error) {
    if (!(error instanceof ToolError)) throw error
    return null
  }
}

// The saved pictures of the clips that the model wants to see (`show`), by
// clip id: of the first `count` of them, in the order of the answer's
// lines, as the budget of the pictures takes them in that order
// (`compactedSections`). A clip whose picture Dez could not make or save
// has none.
async function saveClipPictures(choices: readonly AssetChoice[], count: number, signal: AbortSignal): Promise<Map<string, ShownPicture>> {
  const clips = choices
    .filter((choice) => choice.decision === 'show')
    .sort((a, b) => a.rank - b.rank)
    .flatMap(({ asset }) => (asset.asset.kind === 'clip' ? [asset.asset.clip] : []))
    .slice(0, count)
  if (clips.length === 0) return new Map()
  // A new folder, not the one of the facts: `viewClip` copies its clip
  // itself, and a run refuses an input whose name the folder already has.
  const made = await inWorkFolder(async (folder) => {
    const pictures: { id: string, picture: NewPicture }[] = []
    for (const clip of clips) {
      signal.throwIfAborted()
      const picture = await clipPicture(clip, folder, signal)
      if (picture) pictures.push({ id: clip.id, picture })
    }
    return pictures
  })
  // A stopped compaction has no result, so its copies would have no tag.
  signal.throwIfAborted()
  const saved = await saveShownPictures(made.map(({ picture }) => picture))
  return new Map(made.flatMap(({ id }, index): [string, ShownPicture][] => {
    const copy = saved[index]
    return copy ? [[id, copy]] : []
  }))
}

/** Compacts the conversation of `input`: reads the files of its assets,
 *  sends the compaction request, and builds the sections that take the
 *  place of the conversation from the answer (`compactedSections`). It
 *  changes no tab.
 *
 *  Rejects, with nothing left behind, for a request that failed, for a
 *  stop of `input.signal`, and with an `ExplainedError` for an answer with
 *  no notes. A file that Dez cannot read fails nothing: its asset keeps a
 *  text that says so, and goes to no request as pixels. */
export async function compactConversation(input: CompactionInput): Promise<Compaction> {
  const { sections, replySectionId, model, signal } = input
  signal.throwIfAborted()
  const scope = compactionScope(sections, replySectionId)
  const found = [...conversationAssets(sections).found.values()].filter((asset) => asset.section < scope.end)
  const { facts, imageBytes } = await readAssetFiles(sections, scope.end, found, signal)
  // No request after a stop while a file was read.
  signal.throwIfAborted()
  const assets = compactionAssets(sections, found, assetPlaces(sections, found), facts)

  const instruction = compactionInstruction({ assetTable: assetTableText(assets), jobs: input.jobs, cost: input.cost(), tools: input.tools.length > 0 })
  const { text, usage } = await requestNotes(input, [...input.messages, { role: 'user', content: instruction }])
  // A stop after the first bytes of the answer ends the request with no
  // error, and the text is not whole.
  signal.throwIfAborted()
  const answer = readCompactionAnswer(text)
  if (!answerHasNotes(answer)) {
    console.error('The answer to a compaction request holds no notes.')
    throw new ExplainedError(NO_COMPACTION_NOTES_TEXT)
  }
  const replyText = scope.reply === null ? '' : sectionPlainText(sections[scope.reply])
  const choices = assetDecisions(assets, answer, { jobInputs: openJobInputs(replyText, input.jobs), keptUserTexts: keptUserTexts(sections, scope) })

  // The model of the next request: it reads the pictures of the result.
  const reader = input.readerModel ?? model
  const cached = sbp('dez.model/modelCache/model', reader.providerId, reader.modelId) as ModelInfo | null
  const sendImages = cached?.imageInput !== false
  const limits = compactedPictureLimits(cached ?? { id: reader.modelId })
  let clipPictures = new Map<string, ShownPicture>()
  try {
    // No more pictures than a compacted conversation can hold.
    if (sendImages) clipPictures = await saveClipPictures(choices, limits.pictures, signal)
    // A stop while the copies were saved: the save takes no signal.
    signal.throwIfAborted()
    const compacted = compactedSections({
      sections,
      replySectionId,
      model,
      choices,
      answer,
      jobs: input.jobs,
      cost: input.cost(),
      clipPictures,
      sendImages,
      limits,
      rule: modelFamily(reader.modelId).imageTokens,
      imageBytes,
      newId: () => crypto.randomUUID(),
    })
    const used = new Set(compacted.pictures.map(({ file }) => file))
    await discardShownPictures([...clipPictures.values()].filter(({ file }) => !used.has(file)))
    return { ...compacted, usage }
  } catch (error) {
    await discardShownPictures([...clipPictures.values()])
    throw error
  }
}
