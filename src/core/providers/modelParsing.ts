import type { ModelInfo, ProviderId } from './types'
import { providerModel } from './types'

export interface ModelDataResponse<T> {
  data?: T[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function modelData<T extends Record<string, unknown>>(data: unknown): T[] {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    return []
  }

  return data.data.filter(isRecord) as T[]
}

export function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  return typeof value === 'string' ? value : null
}

export function providerModelsFromIds(provider: ProviderId, ids: string[]): ModelInfo[] {
  return ids.map((id) => providerModel(provider, id, id))
}
