import sbp from '@sbp/sbp'
import type { AppCardFacts } from '../../model/tools/appShow'
import { appSizeText } from '../../model/tools/appsTool'

// The facts of the apps that the view shows (`dez.controller/apps/card`):
// the card of an app (editor/apps.ts) and the bar of an app that runs
// (appFrameHost.ts) both draw from them. The facts are kept by the name of
// the app, for all conversations: a card draws from the last facts at
// once, with no empty frame in between, and then reads them again.

const knownFacts = new Map<string, AppCardFacts>()

// The reads of the facts that run now, by the name of their app: the cards
// of one app that are drawn together share one read.
const factReads = new Map<string, Promise<AppCardFacts>>()

/** The last facts that Dez read of the app `name`; undefined before the
 *  first read ends. */
export function knownAppFacts(name: string): AppCardFacts | undefined {
  return knownFacts.get(name)
}

/** Reads the facts of the app `name` again; never rejects. */
export function readAppFacts(name: string): Promise<AppCardFacts> {
  const running = factReads.get(name)
  if (running) return running
  const read: Promise<AppCardFacts> = (sbp('dez.controller/apps/card', name) as Promise<AppCardFacts>).then((facts) => {
    // A read that a delete of the app overtook (`setAppDeleted`) tells of
    // files that are gone.
    if (factReads.get(name) !== read) return knownFacts.get(name) ?? facts
    knownFacts.set(name, facts)
    factReads.delete(name)
    return facts
  })
  factReads.set(name, read)
  return read
}

/** Dez deleted the app `name`: its facts are those of an app that is gone,
 *  with no new read. */
export function setAppDeleted(name: string): void {
  factReads.delete(name)
  knownFacts.set(name, { state: 'missing' })
}

/** The size of the folder of an app with `facts`, as a text for its card
 *  and its bar; empty when the facts have none. */
export function appSizeLabel(facts: AppCardFacts | undefined): string {
  return facts && 'size' in facts && facts.size ? appSizeText(facts.size) : ''
}
