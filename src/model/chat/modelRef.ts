import type { ModelRef } from './types'

/** The text form of a model ref, `provider/model`: the conversation header
 *  `model:` and the agent pill `model` attribute use it. */
export function modelRefKey(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`
}

/** Reads a `modelRefKey` value. Provider ids never hold `/`
 *  (`isValidProviderId`), but model ids can (`anthropic/claude-sonnet-4.5`),
 *  so the value splits at the first `/`. Null when a part is empty. */
export function parseModelRefKey(value: string): ModelRef | null {
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) return null
  return {
    providerId: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  }
}

/** Two absent refs are equal: both sections have no known model. */
export function sameModelRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.providerId === b.providerId && a.modelId === b.modelId
}

/** A copy with only the ref fields, so an `ActiveModel` passed as a ref does
 *  not store its `modelName`. */
export function cloneModelRef(ref: ModelRef): ModelRef {
  return { providerId: ref.providerId, modelId: ref.modelId }
}

/** For object spreads: `{ model }` with a copy of the ref, or `{}` without
 *  one, because a copy of a section must never write `model: undefined`. */
export function modelRefField(ref: ModelRef | undefined): { model?: ModelRef } {
  return ref ? { model: cloneModelRef(ref) } : {}
}
