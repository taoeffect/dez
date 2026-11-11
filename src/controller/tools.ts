import sbp from '@sbp/sbp'
import { modelRefKey } from '../model/chat/modelRef'
import type { ModelCache } from '../model/persistence/types'
import { effectiveParameterValues } from '../model/providers/modelParameters'
import { effectiveRequest, isClipKind, type ProviderInfo } from '../model/providers/types'
import type { SettingsSnapshot } from '../model/state'
import { modelInfoParameterValues, modelInfoText, modelInfoTarget, type ModelInfoRequest, type ModelInfoTarget } from '../model/tools/modelInfo'
import { modelListText } from '../model/tools/modelList'
import type { ToolArguments, ToolRunResult } from '../model/tools/types'

/** A call that Dez runs: a Dez tool and the arguments that its definition
 *  accepted (`checkToolCalls`). */
export interface ToolRunCall {
  name: string
  arguments: ToolArguments
}

// The code of each Dez tool (TOOL_DEFINITIONS), by tool name. A runner gives
// the result text, or throws for an error result. `signal` aborts when the
// user stops the reply; a runner that waits on something must stop then.
type ToolRunner = (args: ToolArguments, signal: AbortSignal) => Promise<string>

// Waits for `work` until the user stops the reply; then rejects at once.
// The work itself goes on: a model-list check still updates the model cache.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

// The model that a `model_info` call names, and its raw model-list entry in
// memory (undefined when there is none). Throws for a model that the user
// cannot use (`modelInfoTarget`).
async function modelInfoLookup(args: ToolArguments): Promise<ModelInfoTarget & { entry: unknown }> {
  const providers = await sbp('dez.provider/infos') as ProviderInfo[]
  const target = modelInfoTarget(sbp('dez.model/modelCache/snapshot') as ModelCache, providers, args)
  return { ...target, entry: sbp('dez.model/modelCache/rawModel', target.provider.id, target.model.id) as unknown }
}

const TOOL_RUNNERS: Record<string, ToolRunner> = {
  // The models as the model picker shows them, from the model cache as it
  // is (refreshed at startup and when the picker opens): no network request.
  async model_list (args) {
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
    return modelListText(cache, providers, args)
  },
  // All that Dez and the provider know about one model. The raw entries of
  // the provider's model list are in memory only, so after a start they are
  // missing until the provider's next model check; then this one runs a
  // check of that provider now, and looks again (the model may be gone).
  //
  // For a model with parameters (a clip model), the result also tells the
  // value that a request sends for each one now: the call's own value, else
  // the user's (the provider settings popup), else the default. For those
  // values it asks the provider for the price of one request, which costs
  // nothing. A failed price request does not fail the call.
  async model_info (args, signal) {
    let found = await modelInfoLookup(args)
    if (found.entry === undefined) {
      await untilAborted(sbp('dez.controller/modelCache/refresh', { providerIds: [found.provider.id], force: true }) as Promise<void>, signal)
      found = await modelInfoLookup(args)
    }
    const { provider, model, entry } = found
    const ref = { providerId: provider.id, modelId: model.id }
    const called = modelInfoParameterValues(model, args)
    const chosen = (sbp('dez.model/settings/snapshot') as SettingsSnapshot).modelParameters[modelRefKey(ref)]
    const request: ModelInfoRequest = { values: effectiveParameterValues(model.parameters ?? [], { ...chosen, ...called }) }

    const mediaEntry = sbp('dez.model/modelCache/rawModel', provider.id, model.id, 'media') as unknown
    if (mediaEntry !== undefined) request.mediaEntry = mediaEntry

    const kind = effectiveRequest(model)
    if (isClipKind(kind)) {
      try {
        const usd = await untilAborted(sbp('dez.provider/mediaQuote', { ...ref, kind, parameters: request.values }) as Promise<number | null>, signal)
        if (usd !== null) request.cost = { usd }
      } catch (error) {
        if (signal.aborted) throw error
        // The provider's error text stays in the log: it can echo details
        // of the user's account, and this result goes to a chat provider.
        console.error(`Failed to get the price of a ${model.id} request:`, error)
        request.cost = { error: 'The provider did not answer the price request.' }
      }
    }
    return modelInfoText(provider, model, entry, request)
  },
}

export default sbp('sbp/selectors/register', {
  /** Runs one call of a reply's tool round. Never throws: a tool with no
   *  runner and a runner that throws give an error result, which the model
   *  reads in the next round. */
  async 'dez.controller/tools/run' (call: ToolRunCall, signal: AbortSignal): Promise<ToolRunResult> {
    const runner = Object.hasOwn(TOOL_RUNNERS, call.name) ? TOOL_RUNNERS[call.name] : undefined
    if (!runner) {
      console.error(`No runner for the tool ${JSON.stringify(call.name)}`)
      return { content: `Unknown tool: ${JSON.stringify(call.name)}.`, isError: true }
    }
    try {
      return { content: await runner(call.arguments, signal), isError: false }
    } catch (error) {
      // A run that the user stopped did not fail; the reply drops its result.
      if (!signal.aborted) console.error(`The tool ${call.name} failed:`, error)
      return { content: `The tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  },
})
