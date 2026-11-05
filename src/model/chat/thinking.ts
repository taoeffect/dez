import { cloneJsonObject } from '../../utils/json'
import type { SectionThinking, ThinkingReplay } from './types'

function cloneThinkingReplay(replay: ThinkingReplay): ThinkingReplay {
  switch (replay.kind) {
    case 'field':
      return { kind: 'field', field: replay.field }
    case 'anthropicBlocks':
      return { kind: 'anthropicBlocks', blocks: replay.blocks.map((block) => ({ ...block })), prefixHash: replay.prefixHash }
    case 'reasoningDetails':
      return { kind: 'reasoningDetails', details: replay.details.map(cloneJsonObject), prefixHash: replay.prefixHash }
    case 'copilot':
      return { kind: 'copilot', opaque: replay.opaque, prefixHash: replay.prefixHash }
  }
}

/** For object spreads: `{ thinking }` with a copy, or `{}` without one,
 *  because a copy of a section must never write `thinking: undefined`. */
export function thinkingField(thinking: SectionThinking | undefined): { thinking?: SectionThinking } {
  if (!thinking) return {}
  return {
    thinking: thinking.replay
      ? { text: thinking.text, replay: cloneThinkingReplay(thinking.replay) }
      : { text: thinking.text },
  }
}

/** Two absent values are equal. The store and the editor each keep their own
 *  copy (`thinkingField`), so this compares by value. The replay is compared
 *  as JSON: every copy keeps the key order of its source, and a false
 *  mismatch only costs one extra editor update. */
export function sameThinking(a: SectionThinking | undefined, b: SectionThinking | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.text === b.text && JSON.stringify(a.replay) === JSON.stringify(b.replay)
}
