import type { PromptData } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePrompt(value: unknown): PromptData | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.content !== 'string'
  ) return null
  return {
    id: value.id,
    name: value.name,
    content: value.content,
  }
}

export function parsePromptsJson(content: string): PromptData[] {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(parsePrompt).filter((prompt): prompt is PromptData => prompt !== null)
  } catch {
    return []
  }
}

export function serializePromptsJson(prompts: PromptData[]): string {
  return JSON.stringify(prompts, null, 2)
}
