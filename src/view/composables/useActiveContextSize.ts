import { effect, onScopeDispose, shallowRef, type ShallowRef } from 'vue'
import sbp from '@sbp/sbp'
import { debounce, throttle } from 'turtledash'
import type { Compactions } from '../../model/chat/compaction'
import type { ContextSize } from '../../model/chat/contextSize'
import type { ActiveModel } from '../../model/chat/types'
import { contextWindowOf } from '../../model/providers/modelFamilies'
import { effectiveRequest, type ModelInfo } from '../../model/providers/types'

/** The context size of the active tab, with the context window of its
 *  active model, in tokens. No window: the tab has no model, or its model
 *  takes no chat request (Dez knows no window of an image model).
 *  `compactions` are the numbers of the compactions of the tab's
 *  conversation (undefined before its first one), which give the size of
 *  the whole conversation. They come from the same read as the size: a
 *  compaction changes both, and a later read of only one of them would
 *  show the old size with the new sum for a moment. */
export interface ActiveContextSize extends ContextSize {
  contextWindow: number | undefined
  compactions: Compactions | undefined
}

/** The least time between two reads of the size while the tab changes. */
export const CONTEXT_SIZE_READ_INTERVAL_MS = 250

/** The context size of the active tab (`dez.model/tabs/contextSize`), for
 *  the token label of the bottom bar; undefined while there is no tab.
 *
 *  It is no `computed`: one read builds the request of the whole tab, and a
 *  stream changes the tab with each token. So this is an effect with its
 *  own scheduler. The effect tracks all that a read used (the text, the
 *  model, the settings, the model cache), but a change only asks for the
 *  next read: at most one each `CONTEXT_SIZE_READ_INTERVAL_MS` while the
 *  changes keep coming (throttle), then one more after they stop
 *  (debounce), so that the last value is right. A tab switch reads at
 *  once: the count of another tab must never show. */
export function useActiveContextSize(): Readonly<ShallowRef<ActiveContextSize | undefined>> {
  const shown = shallowRef<ActiveContextSize>()
  let shownTabId = ''
  // Whether the tab changed since the last read.
  let stale = false

  const read = effect(() => {
    stale = false
    shownTabId = sbp('dez.model/tabs/activeId') as string
    const size = sbp('dez.model/tabs/contextSize', shownTabId) as ContextSize | undefined
    shown.value = size && {
      ...size,
      contextWindow: contextWindowOfModel(sbp('dez.model/activeModel') as ActiveModel | null),
      compactions: sbp('dez.model/tabs/compactions', shownTabId) as Compactions | undefined,
    }
  }, {
    scheduler: () => {
      stale = true
      if (sbp('dez.model/tabs/activeId') !== shownTabId) {
        read()
        return
      }
      readThrottled()
      readLater()
    },
  })
  const readThrottled = throttle(read, CONTEXT_SIZE_READ_INTERVAL_MS)
  // Nothing to do when the throttled read already saw the last change.
  const readLater = debounce(() => {
    if (stale) read()
  }, CONTEXT_SIZE_READ_INTERVAL_MS)
  // The scope of the caller stops the effect; the timer is not a part of it.
  onScopeDispose(() => readLater.clear())

  return shown
}

// The context window of `model`: the one of its entry in the model cache,
// else the one of its family. A model that the cache does not have (yet)
// counts as a chat model, as everywhere.
function contextWindowOfModel(model: ActiveModel | null): number | undefined {
  if (!model) return undefined
  const cached = sbp('dez.model/modelCache/model', model.providerId, model.modelId) as ModelInfo | null
  return effectiveRequest(cached ?? {}) === 'chat' ? contextWindowOf(cached ?? { id: model.modelId }) : undefined
}
