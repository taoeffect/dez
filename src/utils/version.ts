export interface ParsedVersion {
  parts: [number, number, number]
  prerelease: string | null
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateVersion = parseVersion(candidate)
  const currentVersion = parseVersion(current)

  for (let index = 0; index < 3; index += 1) {
    if (candidateVersion.parts[index] > currentVersion.parts[index]) return true
    if (candidateVersion.parts[index] < currentVersion.parts[index]) return false
  }

  if (!candidateVersion.prerelease && currentVersion.prerelease) return true
  if (candidateVersion.prerelease && !currentVersion.prerelease) return false

  return false
}

export function parseVersion(version: string): ParsedVersion {
  const normalized = version.trim().replace(/^v/i, '')
  const [withoutBuild] = normalized.split('+', 1)
  const [main, prerelease = null] = withoutBuild.split('-', 2)
  const parts = main.split('.').map((part) => Number.parseInt(part, 10))

  return {
    parts: [parts[0] || 0, parts[1] || 0, parts[2] || 0],
    prerelease,
  }
}
