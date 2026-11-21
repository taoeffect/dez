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
