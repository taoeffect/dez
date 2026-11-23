import { Facet, type EditorState, type Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { TIMED_CALL_MIN_MS } from '../../model/chat/duration'
import type { LiveTimes } from '../../model/streams/types'
import { liveDuration, longDuration, longLiveDuration, shortDuration } from '../../utils/durationText'
import { streamingSectionField } from '../thread/modelChip'

// The times that count while a reply runs: the reply time on its agent pill
// (`pillDuration.ts`) and the time of each tool call on its chip
// (`toolCalls.ts`). They are in no doc text and in no state field: the
// stream store holds the stamps (`dez.model/streams/liveTimes`), and one
// ticker of the view changes the drawn text in place. A widget whose `eq`
// held a live time would make CodeMirror draw a new pill or chip each
// second, which restarts the busy animations and takes the focus (read
// `pillThinkingUpdater`, cmEditor.ts). So the `toDOM` of a pill or a chip
// reads the source at its draw, and the ticker keeps the drawn ones up to
// date.

/** A time that a pill or a chip shows. `live`: it still counts. */
export interface ShownTime {
  ms: number
  live: boolean
}

export type LiveTimesSource = () => LiveTimes | null

/** Draws the live times of one kind of widget in `view`, at `now`, from
 *  `times` (null when no reply runs: a drawn live time goes). */
export type LiveTimeRenderer = (view: EditorView, times: LiveTimes | null, now: number) => void

const NO_LIVE_TIMES: LiveTimesSource = () => null

/** Where the live times of a state come from: ThreadEditor gives the read
 *  of the tab that the state shows. A state with none shows no live
 *  time. */
export const liveTimesSource = Facet.define<LiveTimesSource, LiveTimesSource>({
  combine: (sources) => sources[0] ?? NO_LIVE_TIMES,
})

/** The renderers that the ticker runs, one for each kind of widget. */
export const liveTimeRenderers = Facet.define<LiveTimeRenderer>()

export function readLiveTimes(state: EditorState): LiveTimes | null {
  return state.facet(liveTimesSource)()
}

function shownAfterMinimum(ms: number, live: boolean): ShownTime | null {
  return ms >= TIMED_CALL_MIN_MS ? { ms, live } : null
}

/** The live time of the reply that streams into section `sectionId`, at
 *  `now`; null for a section that no reply streams into, and before the
 *  reply ran a second. */
export function replyTime(times: LiveTimes | null, sectionId: string, now: number): ShownTime | null {
  return times?.sectionId === sectionId ? shownAfterMinimum(now - times.startedAt, true) : null
}

/** The time of the call `callId` of the reply that streams into section
 *  `sectionId`, at `now`: live while the call runs; fixed once it ended
 *  while its group still runs (the time that its final block keeps). Null
 *  for a call that did not start, and for a call shorter than a second.
 *  Call ids are unique only in one section. */
export function callTime(times: LiveTimes | null, sectionId: string | null, callId: string, now: number): ShownTime | null {
  if (times?.sectionId !== sectionId || !Object.hasOwn(times.calls, callId)) return null
  const { startedAt, endedAt } = times.calls[callId]
  return endedAt === null ? shownAfterMinimum(now - startedAt, true) : shownAfterMinimum(endedAt - startedAt, false)
}

/** Where a call of a running group is, when its chip must not look busy:
 *  `ended` (its block stays `running` until the last call of its group
 *  ends), or `waiting` (it did not start, and another call of the reply
 *  runs). Null for the call that runs, and while the times do not tell
 *  (before the first call of a group starts). */
export type CallPhase = 'ended' | 'waiting'

export function callPhase(times: LiveTimes | null, sectionId: string | null, callId: string): CallPhase | null {
  if (times?.sectionId !== sectionId) return null
  if (Object.hasOwn(times.calls, callId)) return times.calls[callId].endedAt === null ? null : 'ended'
  return Object.values(times.calls).some(({ endedAt }) => endedAt === null) ? 'waiting' : null
}

export function timeText({ ms, live }: ShownTime): string {
  return live ? liveDuration(ms) : shortDuration(ms)
}

export function timeWords({ ms, live }: ShownTime): string {
  return live ? longLiveDuration(ms) : longDuration(ms)
}

/** Shows `time` in the time part `part`, whose class is `baseClass`, with
 *  the `--live` modifier while it counts, and `description` as its
 *  tooltip. It writes only what changed, as the ticker calls it each
 *  second. */
export function drawTime(part: HTMLElement, baseClass: string, time: ShownTime, description: string): void {
  const className = time.live ? `${baseClass} ${baseClass}--live` : baseClass
  if (part.className !== className) part.className = className
  const text = timeText(time)
  if (part.textContent !== text) part.textContent = text
  if (part.title !== description) part.title = description
}

const SECOND_MS = 1000
/** The longest sleep of the ticker. A call that starts changes no doc text
 *  when its block is drawn already (the second call of a group), so the
 *  ticker learns of it at its next read. */
const MAX_TICK_MS = 250

/** The time until the next whole second of a time that counts in `times`,
 *  at most `MAX_TICK_MS`. */
export function nextTickDelay(times: LiveTimes, now: number): number {
  const starts = [times.startedAt, ...Object.values(times.calls).filter((time) => time.endedAt === null).map((time) => time.startedAt)]
  const untilChange = Math.min(...starts.map((start) => SECOND_MS - ((now - start) % SECOND_MS)))
  return Math.min(Math.max(untilChange, 1), MAX_TICK_MS)
}

// One ticker for each view. It runs while a section of its state streams:
// each tick reads the source once and runs every renderer, then sleeps to
// the next whole second of a time (the text of a live time changes there)
// or `MAX_TICK_MS`. A tick that reads no times runs the renderers once
// more, so no live time stays, and sleeps until the streaming section
// changes. A time part is one line of text in a line box that it does not
// grow (`dezTheme`), so a tick moves no line height.
class LiveTimeTicker {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly view: EditorView) {
    if (this.streamingSection(view.state) !== null) this.tick()
  }

  update({ startState, state }: ViewUpdate): void {
    if (this.streamingSection(startState) !== this.streamingSection(state)) this.tick()
  }

  destroy(): void {
    this.stop()
  }

  private streamingSection(state: EditorState): string | null {
    return state.field(streamingSectionField, false) ?? null
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private tick(): void {
    this.stop()
    const { state } = this.view
    const times = this.streamingSection(state) === null ? null : readLiveTimes(state)
    const now = Date.now()
    for (const render of state.facet(liveTimeRenderers)) render(this.view, times, now)
    if (times) this.timer = setTimeout(() => this.tick(), nextTickDelay(times, now))
  }
}

const liveTimeTicker = ViewPlugin.fromClass(LiveTimeTicker)

/** The live times of one kind of widget: `render` runs at each tick of
 *  the view's one ticker. */
export function liveTimes(render: LiveTimeRenderer): Extension {
  return [liveTimeRenderers.of(render), liveTimeTicker]
}
