import { describe, expect, it } from 'vitest'
import { unusableModelMessage } from './unusableModel'

describe('unusableModelMessage', () => {
  it.each([
    [['image'], 'image'],
    // In table order, whatever order the model has.
    [['video', 'image'], 'image and video'],
    [['video', 'audio', 'text'], 'text, audio, and video'],
    // Unknown outputs count as text.
    [undefined, 'text'],
  ] as const)('names the outputs %j of the model as "%s"', (outputs, names) => {
    const message = unusableModelMessage('Painter', outputs ? { outputs: [...outputs] } : {})

    expect(message.startsWith('Dez cannot use Painter yet.')).toBe(true)
    expect(message).toContain(` ${names} output `)
  })

  it('names no output of a model that makes none, and tells the user to choose another model', () => {
    expect(unusableModelMessage('Embedder', { outputs: [] })).toBe('Dez cannot use Embedder yet. Choose another model.')
  })
})
