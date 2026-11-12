// The user's Thinking toggle is stored with the popup toggles, under this key
// in settings.providerSettings[providerId]. A provider config may not use it
// as a `settings[]` key (config.ts refuses it). Two UIs change this one value:
// the Thinking row of the model picker's gear popup
// (ProviderSettingsPopup.vue) and the Thinking switch in Settings › Providers
// (ProviderManager.vue).
export const THINKING_SETTING_KEY = 'thinking'

// The stored toggles are sparse: a provider whose toggle the user never
// flipped has thinking on.
export const THINKING_DEFAULT = true

// The prefix hash of a signed replay: a hash of the JSON text of an array of
// what went before the reply that made it: the system prompt, the wire tools,
// and the wire messages (ApiFormat.chatBody). Providers refuse such a replay
// once anything before it changed, so a later request sends it only while
// what it builds before it hashes the same.
//
// The list grows one item at a time. A request checks the prefix of every
// replay it sends, so this hashes each item once instead of the whole prefix
// again at every replay. The same hasher makes the hash that a reply keeps
// (ApiFormat.chatBody), so the stored and checked hashes always agree.
export class ThinkingPrefixHasher {
  private readonly hash = new Cyrb53()
  private empty = true

  add(item: unknown): void {
    this.hash.feed(this.empty ? '[' : ',').feed(JSON.stringify(item) ?? 'null')
    this.empty = false
  }

  // The JSON text of an array is the JSON text of its items, joined by `,`,
  // in `[` `]`. Saved conversations keep these hashes, so a change to this
  // text drops the signed replays of every saved conversation.
  digest(): string {
    return this.hash.copy().feed(this.empty ? '[]' : ']').value().toString(36)
  }
}

// cyrb53 by bryc (public domain): a fast 53-bit string hash, here fed in
// parts. It only has to notice an edit, not resist an attacker, so a crypto
// hash (async in the webview) is not needed.
// https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
class Cyrb53 {
  constructor(private h1 = 0xdeadbeef, private h2 = 0x41c6ce57) {}

  feed(text: string): this {
    let h1 = this.h1
    let h2 = this.h2
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      h1 = Math.imul(h1 ^ code, 2654435761)
      h2 = Math.imul(h2 ^ code, 1597334677)
    }
    this.h1 = h1
    this.h2 = h2
    return this
  }

  copy(): Cyrb53 {
    return new Cyrb53(this.h1, this.h2)
  }

  value(): number {
    let h1 = Math.imul(this.h1 ^ (this.h1 >>> 16), 2246822507)
    h1 ^= Math.imul(this.h2 ^ (this.h2 >>> 13), 3266489909)
    let h2 = Math.imul(this.h2 ^ (this.h2 >>> 16), 2246822507)
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
  }
}
