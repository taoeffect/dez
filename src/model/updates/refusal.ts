import * as z from 'zod'

// The four checks that a release must pass before Dez installs it, by the
// names that Rust gives them (`Check` in src-tauri/src/updater/verify.rs).
// A failed one means that the release may be compromised.
const UPDATE_CHECKS = ['manifestSignature', 'versionSignature', 'version', 'dmgSha256'] as const

export type UpdateCheck = typeof UPDATE_CHECKS[number]

// What each check looks at, in words for the report of a refusal.
const CHECK_SUBJECTS: Record<UpdateCheck, string> = {
  manifestSignature: "the release key's signature of the manifest",
  versionSignature: "the developer's signature of the version",
  version: 'the version that the developer signed',
  dmgSha256: 'the SHA-256 of the download',
}

// What Rust found when a check failed (`Refusal` in verify.rs). `message`
// is a whole sentence.
export interface FailedCheck {
  check: UpdateCheck
  message: string
}

// An update that Dez refused to install.
export interface UpdateRefusal extends FailedCheck {
  // The version of the refused release.
  version: string
}

const failedCheckSchema = z.object({
  check: z.enum(UPDATE_CHECKS),
  message: z.string(),
})

// Returns the failed check in an error of `download_update` or
// `install_update`, or null for any other failure. Rust rejects with an
// object for a failed check and with a plain string for everything else
// (`UpdateError` in src-tauri/src/updater/mod.rs), so the shape tells them
// apart, never the words of a message.
export function failedCheck(error: unknown): FailedCheck | null {
  const parsed = failedCheckSchema.safeParse(error)
  return parsed.success ? parsed.data : null
}

// The text that the user sends to the developer after a refusal: which Dez
// refused which update, the check that failed (in words, and by its name in
// the code), and what Rust found. It holds no path and nothing private.
export function refusalReport(refusal: UpdateRefusal, runningVersion: string): string {
  return [
    `Dez ${runningVersion} refused the update to Dez ${refusal.version}.`,
    `Failed check: ${CHECK_SUBJECTS[refusal.check]} (${refusal.check}).`,
    refusal.message,
  ].join('\n')
}
