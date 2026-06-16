import { describe, expect, it } from 'vitest'
import { zaiFallbackModels, zaiProvider } from './zai'

describe('Z.ai provider models', () => {
  it('includes glm-5.2 in fallback models', () => {
    expect(zaiFallbackModels[0]).toEqual({
      id: 'glm-5.2',
      name: 'GLM 5.2',
      provider: 'zai',
    })
  })

  it('adds glm-5.2 to live model results', () => {
    const models = zaiProvider.parseModels({
      data: [
        { id: 'glm-5.1' },
        { id: 'glm-5' },
      ],
    })

    expect(models.map((model) => model.id)).toEqual(['glm-5.2', 'glm-5.1', 'glm-5'])
    expect(models[0].name).toBe('GLM 5.2')
  })

  it('does not duplicate glm-5.2 when live model results include it', () => {
    const models = zaiProvider.parseModels({
      data: [
        { id: 'glm-5.2' },
        { id: 'glm-5.1' },
      ],
    })

    expect(models.filter((model) => model.id === 'glm-5.2')).toHaveLength(1)
    expect(models.map((model) => model.id)).toEqual(['glm-5.2', 'glm-5.1'])
  })
})
