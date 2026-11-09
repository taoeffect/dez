import * as z from 'zod'

// `updates/pending.json` holds the version that an update install relaunched
// Dez into (dez.controller/updates/install). The next startup reads and
// deletes it, and tells the user whether the update finished
// (dez.controller/updates/reportLastInstall).
const pendingUpdateSchema = z.object({
  version: z.string(),
})

// The version in a pending-update file, or null when the file is malformed:
// a broken file gives no report, and never breaks startup.
export function parsePendingUpdateJson(content: string): string | null {
  try {
    const result = pendingUpdateSchema.safeParse(JSON.parse(content))
    return result.success ? result.data.version : null
  } catch {
    return null
  }
}

export function serializePendingUpdateJson(version: string): string {
  return JSON.stringify({ version }, null, 2)
}
