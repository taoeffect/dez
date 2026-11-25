import { describe, expect, it } from 'vitest'
import { AUDIO_ALIASES, VIDEO_ALIASES } from './appAliases'
import { programNotConfinedText } from './programRuns'

describe('programNotConfinedText', () => {
  // The text lists the alias subcommands by hand, as its module cannot
  // import appAliases.ts: each alias runs Deno, so a new one must join the
  // list. The list reads "(audio beats, onsets, and align; video …)".
  it.each([
    ['audio', AUDIO_ALIASES],
    ['video', VIDEO_ALIASES],
  ])('names each alias subcommand of %s, and no other', (tool, aliases) => {
    const list = /that runs a built-in app \(([^)]*)\)/.exec(programNotConfinedText('deno'))?.[1] ?? ''
    const part = list.split('; ').find((each) => each.startsWith(`${tool} `)) ?? ''
    const named = part.slice(tool.length + 1).split(/,? and |, /)

    expect(named.sort()).toStrictEqual(aliases.map((alias) => alias.subcommand.name).sort())
  })
})
