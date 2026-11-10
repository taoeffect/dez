import { describe, expect, it } from 'vitest'
import { hasSignedMacDownload, parseReleaseList, type ReleaseListOptions } from './releases'

const REPO = 'https://github.com/taoeffect/dez'

const OPTIONS: ReleaseListOptions = {
  currentVersion: '0.15.1',
  releaseUrlPrefix: `${REPO}/releases/`,
  assetUrlPrefix: `${REPO}/releases/download/`,
}

interface ReleaseFields {
  draft?: boolean
  prerelease?: boolean
  body?: string | null
  htmlUrl?: string
  assets?: { name: string, browser_download_url: string }[]
}

// One asset of a release, as GitHub lists it: a file `name` in `folder`.
function asset(name: string, folder = `${REPO}/releases/download/v0.16.0`) {
  return { name, browser_download_url: `${folder}/${name}` }
}

// A release as GitHub's "list releases" API sends it (the fields Dez reads
// and a few that it ignores), with the DMG, the manifest, and the
// manifest's signature that CI uploads.
function githubRelease(tag: string, fields: ReleaseFields = {}) {
  const version = tag.replace(/^v/, '')
  const download = `${REPO}/releases/download/${tag}`
  return {
    id: 1,
    tag_name: tag,
    name: tag,
    html_url: fields.htmlUrl ?? `${REPO}/releases/tag/${tag}`,
    draft: fields.draft ?? false,
    prerelease: fields.prerelease ?? false,
    published_at: fields.draft ? null : '2026-11-09T01:46:04Z',
    body: fields.body === undefined ? '' : fields.body,
    assets: fields.assets ?? [
      { ...asset(`Dez_${version}_aarch64.dmg`, download), size: 9531159 },
      { ...asset(`Dez_${version}_aarch64.dmg.manifest.json`, download), size: 420 },
      { ...asset(`Dez_${version}_aarch64.dmg.manifest.json.minisig`, download), size: 340 },
      { ...asset(`Dez_${version}_linux_x86_64.AppImage`, download), size: 95316472 },
    ],
  }
}

function parse(releases: unknown[], options: ReleaseListOptions = OPTIONS) {
  return parseReleaseList(JSON.stringify(releases), options)
}

describe('release list', () => {
  it('keeps the published stable releases newer than the running one, newest first', () => {
    const releases = parse([
      githubRelease('v0.9.0'),
      githubRelease('v0.16.0'),
      githubRelease('v0.18.0', { draft: true }),
      githubRelease('v0.17.0', { prerelease: true }),
      githubRelease('v0.17.0-rc.1'),
      githubRelease('v0.17.0+build.5'),
      githubRelease('nightly'),
      githubRelease('v0.15.1'),
      githubRelease('0.15.2'),
      githubRelease('v0.100.0'),
    ])
    expect(releases.map((release) => [release.version, release.tag])).toEqual([
      ['0.100.0', 'v0.100.0'],
      ['0.16.0', 'v0.16.0'],
    ])
  })

  it('offers the stable release of a prerelease that is running', () => {
    const releases = parse([githubRelease('v0.16.0')], { ...OPTIONS, currentVersion: '0.16.0-beta.1' })
    expect(releases.map((release) => release.version)).toEqual(['0.16.0'])
  })

  it('gives the page, date, change notes, DMG, manifest, and manifest signature of a release', () => {
    const [release] = parse([githubRelease('v0.16.0', { body: '## Changes\r\n\r\n**NEW**\r\n\r\n- Self-update on macOS' })])
    expect(release).toEqual({
      version: '0.16.0',
      tag: 'v0.16.0',
      url: `${REPO}/releases/tag/v0.16.0`,
      publishedAt: '2026-11-09T01:46:04Z',
      changes: [
        { kind: 'label', text: 'NEW' },
        { kind: 'list', items: ['Self-update on macOS'] },
      ],
      dmgAsset: {
        name: 'Dez_0.16.0_aarch64.dmg',
        url: `${REPO}/releases/download/v0.16.0/Dez_0.16.0_aarch64.dmg`,
      },
      manifestAsset: {
        name: 'Dez_0.16.0_aarch64.dmg.manifest.json',
        url: `${REPO}/releases/download/v0.16.0/Dez_0.16.0_aarch64.dmg.manifest.json`,
      },
      manifestSignatureAsset: {
        name: 'Dez_0.16.0_aarch64.dmg.manifest.json.minisig',
        url: `${REPO}/releases/download/v0.16.0/Dez_0.16.0_aarch64.dmg.manifest.json.minisig`,
      },
    })
  })

  // Another architecture's files, another version's files, and a signature
  // of the DMG itself (which CI no longer makes) are not these assets.
  it('finds the DMG, the manifest, and its signature only by their exact names', () => {
    const [release] = parse([githubRelease('v0.16.0', {
      assets: [
        asset('Dez_0.16.0_x64.dmg'),
        asset('Dez_0.16.0_x64.dmg.manifest.json'),
        asset('Dez_0.16.0_x64.dmg.manifest.json.minisig'),
        asset('Dez_0.15.1_aarch64.dmg'),
        asset('Dez_0.15.1_aarch64.dmg.manifest.json'),
        asset('Dez_0.15.1_aarch64.dmg.manifest.json.minisig'),
        asset('Dez_0.16.0_aarch64.dmg.minisig'),
      ],
    })])
    expect(release).toMatchObject({ dmgAsset: null, manifestAsset: null, manifestSignatureAsset: null })
  })

  // Releases from before the `sign-macos-manifest` CI job have a DMG and
  // no manifest; the update window then links to GitHub.
  it('has a DMG and no manifest when the release has only the DMG', () => {
    const dmg = asset('Dez_0.16.0_aarch64.dmg')
    const [release] = parse([githubRelease('v0.16.0', { assets: [dmg] })])
    expect(release).toMatchObject({
      dmgAsset: { name: dmg.name, url: dmg.browser_download_url },
      manifestAsset: null,
      manifestSignatureAsset: null,
    })
  })

  // GitHub sends `body: null` for a release with no notes; the list must
  // still parse.
  it('gives no change notes for a release whose body is null', () => {
    const [release] = parse([githubRelease('v0.16.0', { body: null })])
    expect(release.changes).toEqual([])
  })

  it('refuses a newer release whose page is outside the repository', () => {
    for (const htmlUrl of [
      'https://github.com/taoeffect/dez-evil/releases/tag/v0.16.0',
      'https://evil.example/taoeffect/dez/releases/tag/v0.16.0',
      `${REPO}/releases/../../evil/releases/tag/v0.16.0`,
      'not a url',
    ]) {
      expect(() => parse([githubRelease('v0.16.0', { htmlUrl })]), htmlUrl).toThrow('outside the Dez repository')
    }
  })

  // The install fetches both files from these URLs.
  it.each([
    'Dez_0.16.0_aarch64.dmg.manifest.json',
    'Dez_0.16.0_aarch64.dmg.manifest.json.minisig',
  ])('refuses a newer release whose %s is outside the asset prefix', (name) => {
    const assets = [asset(name, 'https://evil.example')]
    expect(() => parse([githubRelease('v0.16.0', { assets })])).toThrow('outside the Dez repository')
  })

  it('accepts assets under another prefix, as a smoke-test server serves them', () => {
    const server = 'http://127.0.0.1:8765/'
    const assets = [asset('Dez_0.16.0_aarch64.dmg.manifest.json', `${server}v0.16.0`)]
    const [release] = parse([githubRelease('v0.16.0', { assets })], { ...OPTIONS, assetUrlPrefix: server })
    expect(release.manifestAsset?.url).toBe(`${server}v0.16.0/Dez_0.16.0_aarch64.dmg.manifest.json`)
  })

  it('ignores a bad URL of a release that is not offered', () => {
    const htmlUrl = 'https://evil.example/old'
    expect(parse([githubRelease('v0.15.0', { htmlUrl }), githubRelease('v0.16.0', { draft: true, htmlUrl })])).toEqual([])
  })

  it('refuses a response that is not JSON or not a release list', () => {
    expect(() => parseReleaseList('<html>', OPTIONS)).toThrow('not JSON')
    // GitHub's error shape, in case a non-2xx status got through.
    expect(() => parseReleaseList(JSON.stringify({ message: 'API rate limit exceeded' }), OPTIONS)).toThrow('unexpected release list')
    const { tag_name: _tagName, ...withoutTag } = githubRelease('v0.16.0')
    expect(() => parse([withoutTag])).toThrow('unexpected release list (0.tag_name')
  })
})

describe('hasSignedMacDownload', () => {
  const NAMES = [
    'Dez_0.16.0_aarch64.dmg',
    'Dez_0.16.0_aarch64.dmg.manifest.json',
    'Dez_0.16.0_aarch64.dmg.manifest.json.minisig',
  ]

  it('is true for a release with the DMG, the manifest, and the manifest signature', () => {
    const [release] = parse([githubRelease('v0.16.0', { assets: NAMES.map((name) => asset(name)) })])
    expect(hasSignedMacDownload(release)).toBe(true)
  })

  // Rust needs all three: it downloads the DMG and checks it against the
  // manifest, which it trusts only with its signature.
  it.each(NAMES)('is false for a release without %s', (missing) => {
    const assets = NAMES.filter((name) => name !== missing).map((name) => asset(name))
    const [release] = parse([githubRelease('v0.16.0', { assets })])
    expect(hasSignedMacDownload(release)).toBe(false)
  })
})
