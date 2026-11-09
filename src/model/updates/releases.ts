import * as z from 'zod'
import { isNewerVersion } from '../../utils/version'
import { releaseChanges, type ChangeBlock } from './changes'

export interface ReleaseAsset {
  name: string
  url: string
}

// A Dez release that is newer than the running one.
export interface Release {
  // `X.Y.Z`, without the tag's `v`.
  version: string
  tag: string
  // The release page on GitHub.
  url: string
  publishedAt: string | null
  changes: ChangeBlock[]
  // The Apple Silicon DMG and its minisign signature. A release without both
  // cannot update a macOS install; the update window then links to GitHub.
  dmgAsset: ReleaseAsset | null
  signatureAsset: ReleaseAsset | null
}

export interface ReleaseListOptions {
  // The running version (`__APP_VERSION__`).
  currentVersion: string
  // Every release page URL must start with this; end it with `/`.
  releaseUrlPrefix: string
  // The DMG and signature URLs must start with this; end it with `/`.
  assetUrlPrefix: string
}

// The fields that Dez reads from GitHub's "list releases" response.
const releaseListSchema = z.array(z.object({
  tag_name: z.string(),
  html_url: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  body: z.string().nullish(),
  assets: z.array(z.object({
    name: z.string(),
    browser_download_url: z.string(),
  })),
}))

// Only plain `vX.Y.Z` tags are offered: the Rust installer downloads from
// the `v<version>` tag (updater/verify.rs `dmg_url`) and accepts no build
// metadata, and Dez does not offer prerelease versions, flagged or not.
const STABLE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/

// Returns the releases in a GitHub "list releases" response that are newer
// than the running version, newest first, without drafts and prereleases.
// Throws when the text is not a release list, or when a newer release has a
// URL outside the given prefixes.
export function parseReleaseList(text: string, options: ReleaseListOptions): Release[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('GitHub sent a release list that is not JSON')
  }
  const parsed = releaseListSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`GitHub sent an unexpected release list (${issue.path.join('.') || 'list'}: ${issue.message})`)
  }

  const releases: Release[] = []
  for (const release of parsed.data) {
    if (release.draft || release.prerelease) continue
    const version = STABLE_TAG.exec(release.tag_name)?.[1]
    if (!version || !isNewerVersion(version, options.currentVersion)) continue

    // The names that `build-macos-dmg` and `sign-macos-dmg` upload
    // (.github/workflows/release-desktop.yml).
    const dmgName = `Dez_${version}_aarch64.dmg`
    const asset = (name: string): ReleaseAsset | null => {
      const found = release.assets.find((candidate) => candidate.name === name)
      return found ? { name, url: checkedUrl(found.browser_download_url, options.assetUrlPrefix) } : null
    }
    releases.push({
      version,
      tag: release.tag_name,
      url: checkedUrl(release.html_url, options.releaseUrlPrefix),
      publishedAt: release.published_at,
      changes: releaseChanges(release.body),
      dmgAsset: asset(dmgName),
      signatureAsset: asset(`${dmgName}.minisig`),
    })
  }
  return releases.sort((a, b) => {
    if (isNewerVersion(a.version, b.version)) return -1
    return isNewerVersion(b.version, a.version) ? 1 : 0
  })
}

// Returns `url` normalized, or throws when it is not under `prefix`. The
// update window opens release pages in the browser and fetches the signature
// from its asset URL, so a corrupt response must not send either elsewhere.
// Normalizing first stops a `..` segment from leaving the prefix.
function checkedUrl(url: string, prefix: string): string {
  let href: string | null = null
  try {
    href = new URL(url).href
  } catch {
    // An unparsable URL fails the check below.
  }
  if (!href?.startsWith(prefix)) {
    throw new Error(`GitHub sent a release URL outside the Dez repository: "${url}"`)
  }
  return href
}
