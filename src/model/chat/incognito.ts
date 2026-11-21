import type { Tab } from './types'

/** For object spreads: `{ incognito: true }`, or `{}` when the flag is not
 *  set, because a copy of a tab must never write `incognito: undefined`. */
export function incognitoField(on: boolean | undefined): { incognito?: true } {
  return on ? { incognito: true } : {}
}

/** For object spreads: `{ requestSent: true }`, or `{}` when the mark is not
 *  set, because a copy of a tab must never write `requestSent: undefined`. */
export function requestSentField(sent: boolean | undefined): { requestSent?: true } {
  return sent ? { requestSent: true } : {}
}

/** Whether incognito can be turned on in `tab`: only while it is off and
 *  before any message of the tab went to a provider, as a request that
 *  went before would tie the incognito messages to Dez. Both marks are
 *  needed: a stopped or failed reply with no text removes its agent
 *  section (`endStreamSection`), but its request went (`requestSent`); and
 *  a conversation of an older Dez, or a paste of copied replies, has agent
 *  sections but no `requestSent`. Incognito is never turned off. */
export function canTurnOnIncognito(tab: Pick<Tab, 'incognito' | 'requestSent' | 'sections'>): boolean {
  return !tab.incognito && !tab.requestSent && !tab.sections.some((section) => section.role === 'agent')
}

/** What a chat request of a tab sends besides its messages, by the one
 *  rule of `requestParts`. */
export interface RequestParts {
  /** Dez's system prompt: the built-in one, or the user's own template of
   *  Settings › System Prompt. */
  dezSystemPrompt: boolean
  /** The Dez tools, where the model and its Tools toggle allow them
   *  (`dez.model/requestSendsTools`). */
  dezTools: boolean
  /** Dez compacts the conversation near a limit of the model
   *  (`compactIfDue`): its request and its notes name Dez. */
  compaction: boolean
  /** The provider's own system prompt is on, where its config has one
   *  (`ProviderConfig.providerSystemPrompt`). */
  providerSystemPrompt: boolean
}

/** The parts of the chat requests of `tab` (or of a reply of it). An
 *  incognito tab leaves out all that tells a provider that the request
 *  comes from Dez, so that the provider cannot tell it from the requests of
 *  other apps: no Dez system prompt (also no template of the user, a text
 *  that only this user sends), no Dez tools, and no compaction. It turns
 *  the provider's own system prompt on, as an app with no system prompt
 *  gets it. Every reader of these parts (the request, the estimate of its
 *  size, the checks of a submit) takes them from here. */
export function requestParts(tab: { incognito?: boolean }): RequestParts {
  const normal = !tab.incognito
  return { dezSystemPrompt: normal, dezTools: normal, compaction: normal, providerSystemPrompt: !normal }
}
