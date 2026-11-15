import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive, type EffectScope } from 'vue'
import sbp from '@sbp/sbp'
import type { Compactions } from '../../model/chat/compaction'
import type { ContextSize } from '../../model/chat/contextSize'
import type { ActiveModel } from '../../model/chat/types'
import { modelFamily } from '../../model/providers/modelFamilies'
import type { ModelInfo } from '../../model/providers/types'
import { CONTEXT_SIZE_READ_INTERVAL_MS, useActiveContextSize } from './useActiveContextSize'

// The model state that the composable reads, as reactive data of the test.
const state = reactive({
  activeTabId: 'first',
  sizes: {} as Record<string, ContextSize>,
  compactions: {} as Record<string, Compactions>,
  activeModel: null as ActiveModel | null,
  cachedModel: null as ModelInfo | null,
})
// How many times the size was read: one read builds a whole request.
let reads = 0

sbp('sbp/selectors/register', {
  'dez.model/tabs/activeId': () => state.activeTabId,
  'dez.model/tabs/contextSize' (tabId: string): ContextSize | undefined {
    reads += 1
    const size = state.sizes[tabId]
    return size && { ...size }
  },
  'dez.model/tabs/compactions': (tabId: string) => state.compactions[tabId],
  'dez.model/activeModel': () => state.activeModel,
  'dez.model/modelCache/model': () => state.cachedModel,
})

describe('useActiveContextSize', () => {
  let scope: EffectScope

  const shownSize = () => {
    scope = effectScope()
    return scope.run(useActiveContextSize)!
  }
  const setTokens = (tabId: string, tokens: number) => {
    state.sizes[tabId] = { tokens, estimated: true }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    state.activeTabId = 'first'
    state.sizes = { first: { tokens: 100, estimated: false }, second: { tokens: 7000, estimated: true } }
    state.compactions = {}
    state.activeModel = null
    state.cachedModel = null
    reads = 0
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })

  it('gives the size of the active tab, and the one of another tab at once after a switch', () => {
    const shown = shownSize()
    expect(shown.value).toStrictEqual({ tokens: 100, estimated: false, contextWindow: undefined, compactions: undefined })

    // A change right before the switch: the read interval has not passed.
    setTokens('first', 150)
    state.activeTabId = 'second'

    expect(shown.value).toStrictEqual({ tokens: 7000, estimated: true, contextWindow: undefined, compactions: undefined })
  })

  it('gives the compaction numbers of the tab with its size, also the numbers of a new compaction', () => {
    const numbers = (count: number): Compactions => ({ count, tokens: count * 150_000, cost: { usd: count, requests: 9 * count, unpriced: 0 } })
    state.compactions.second = numbers(2)
    const shown = shownSize()

    state.activeTabId = 'second'
    expect(shown.value?.compactions).toStrictEqual(numbers(2))

    // A compaction puts a small text into the tab, and then its numbers.
    vi.advanceTimersByTime(CONTEXT_SIZE_READ_INTERVAL_MS + 1)
    setTokens('second', 20)
    state.compactions.second = numbers(3)
    vi.advanceTimersByTime(CONTEXT_SIZE_READ_INTERVAL_MS)

    expect(shown.value).toStrictEqual({ tokens: 20, estimated: true, contextWindow: undefined, compactions: numbers(3) })
  })

  it('reads at most once in each interval while the tab keeps changing, and once more after the last change', () => {
    const shown = shownSize()
    reads = 0

    // 20 changes in 2 intervals, as the tokens of a stream.
    for (let change = 1; change <= 20; change += 1) {
      setTokens('first', 100 + change)
      vi.advanceTimersByTime(CONTEXT_SIZE_READ_INTERVAL_MS / 10)
    }
    expect(reads).toBeLessThanOrEqual(3)

    vi.advanceTimersByTime(CONTEXT_SIZE_READ_INTERVAL_MS)
    expect(shown.value?.tokens).toBe(120)

    // No change, no read.
    const readsAfterLastChange = reads
    vi.advanceTimersByTime(10 * CONTEXT_SIZE_READ_INTERVAL_MS)
    expect(reads).toBe(readsAfterLastChange)
  })

  it('shows one change at once, with no second read', () => {
    const shown = shownSize()
    vi.advanceTimersByTime(CONTEXT_SIZE_READ_INTERVAL_MS + 1)
    reads = 0

    setTokens('first', 101)
    expect(shown.value?.tokens).toBe(101)
    vi.advanceTimersByTime(10 * CONTEXT_SIZE_READ_INTERVAL_MS)
    expect(reads).toBe(1)
  })

  it('gives the window of a chat model: the one of the model list, else the one of its family', () => {
    const model = (id: string, facts: Partial<ModelInfo> = {}): ModelInfo => ({ id, name: id, provider: 'local', ...facts })
    const shown = shownSize()
    const windowOf = (activeModel: ActiveModel | null, cachedModel: ModelInfo | null) => {
      state.activeModel = activeModel
      state.cachedModel = cachedModel
      vi.advanceTimersByTime(2 * CONTEXT_SIZE_READ_INTERVAL_MS)
      return shown.value?.contextWindow
    }
    const gemini: ActiveModel = { providerId: 'local', modelId: 'gemini-2.5-pro', modelName: 'Gemini' }
    const familyWindow = modelFamily(gemini.modelId).contextWindow

    expect(windowOf(gemini, model(gemini.modelId, { contextWindow: 64_000 }))).toBe(64_000)
    expect(windowOf(gemini, model(gemini.modelId))).toBe(familyWindow)
    // A model that the cache does not have yet.
    expect(windowOf(gemini, null)).toBe(familyWindow)
    // An image model has no window that Dez knows.
    expect(windowOf(gemini, model(gemini.modelId, { request: 'image' }))).toBeUndefined()
    expect(windowOf(null, null)).toBeUndefined()
  })
})
