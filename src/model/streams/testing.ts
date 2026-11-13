import type { ModelRef, Section } from '../chat/types'

// Shared helpers of the unit tests of this folder: the sections of a tab.

/** The model of the agent sections that `reply` makes. */
export const model: ModelRef = { providerId: 'local', modelId: 'm' }

/** A user section with one text. */
export const user = (id: string, text: string): Section => ({ id, role: 'user', content: [{ kind: 'text', text }] })

/** An agent section of `model` with one text. */
export const reply = (id: string, text: string): Section => ({ id, role: 'agent', model, content: [{ kind: 'text', text }] })
