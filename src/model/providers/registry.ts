import type { ProviderId, ProviderInfo, ProviderSpec } from './types'

const specs = new Map<ProviderId, ProviderSpec>()

export function registerProviderSpec(spec: ProviderSpec): void {
  specs.set(spec.id, spec)
}

export function getProviderSpec(providerId: ProviderId): ProviderSpec | null {
  return specs.get(providerId) ?? null
}

export function getProviderSpecs(): ProviderSpec[] {
  return Array.from(specs.values())
}

export function getProviderInfos(configuredProviderIds: Iterable<string>): ProviderInfo[] {
  const configured = new Set(configuredProviderIds)

  return getProviderSpecs().map((spec) => ({
    id: spec.id,
    name: spec.name,
    configured: configured.has(spec.id),
  }))
}

export function clearProviderSpecs(): void {
  specs.clear()
}
