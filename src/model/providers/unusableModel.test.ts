import { describe, expect, it } from 'vitest'
import { unusableModelMessage } from './unusableModel'

describe('unusableModelMessage', () => {
  // The user cannot give a model a clip from the editor, so the text names
  // the clip and the tool that will give it.
  it.each([
    ['audio', 'an audio clip'],
    ['video', 'a video clip'],
  ] as const)('tells that a model with the clip input %s needs %s, and names the model_invoke tool', (clipInput, clip) => {
    const message = unusableModelMessage('Listener', { outputs: ['text'], clipInput })

    expect(message.startsWith(`Listener needs ${clip} `)).toBe(true)
    expect(message).toContain('model_invoke')
    // The outputs are not the cause, so the text does not blame an API.
    expect(message).not.toBe(unusableModelMessage('Listener', { outputs: ['text'] }))
  })

  it.each([
    [['image'], 'image'],
    // In table order, whatever order the model has.
    [['video', 'image'], 'image and video'],
    [['video', 'audio', 'text'], 'text, audio, and video'],
    // Unknown outputs count as text.
    [undefined, 'text'],
  ] as const)('names the outputs %j of a model that needs no clip as "%s"', (outputs, names) => {
    const message = unusableModelMessage('Upscaler', outputs ? { outputs: [...outputs] } : {})

    expect(message.startsWith('Dez cannot use Upscaler yet.')).toBe(true)
    expect(message).toContain(` ${names} output `)
  })

  it('names no output of a model that makes none', () => {
    expect(unusableModelMessage('Embedder', { outputs: [] })).toBe('Dez cannot use Embedder yet.')
  })
})
