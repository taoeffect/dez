import sbp from '@sbp/sbp'
import type { ModelCache } from '../model/persistence/types'
import type { ProviderInfo } from '../model/providers/types'
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

const TOOL_RUNNERS: Record<string, ToolRunner> = {
  // The models as the model picker shows them, from the model cache as it
  // is (refreshed at startup and when the picker opens): no network request.
  async model_list (args) {
    const providers = await sbp('dez.provider/infos') as ProviderInfo[]
    const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
    return modelListText(cache, providers, typeof args.filter === 'string' ? args.filter : undefined)
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
      console.error(`The tool ${call.name} failed:`, error)
      return { content: `The tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  },
})
