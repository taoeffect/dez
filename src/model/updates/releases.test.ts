import { describe, expect, it } from 'vitest'
import { parseReleaseList, type ReleaseListOptions } from './releases'

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

// A release as GitHub's "list releases" API sends it (the fields Dez reads
// and a few that it ignores), with the DMG and signature that CI uploads.
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
      { name: `Dez_${version}_aarch64.dmg`, browser_download_url: `${download}/Dez_${version}_aarch64.dmg`, size: 9531159 },
      { name: `Dez_${version}_aarch64.dmg.minisig`, browser_download_url: `${download}/Dez_${version}_aarch64.dmg.minisig`, size: 300 },
      { name: `Dez_${version}_linux_x86_64.AppImage`, browser_download_url: `${download}/Dez_${version}_linux_x86_64.AppImage`, size: 95316472 },
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

  it('gives the page, date, change notes, DMG, and signature of a release', () => {
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
      signatureAsset: {
        name: 'Dez_0.16.0_aarch64.dmg.minisig',
        url: `${REPO}/releases/download/v0.16.0/Dez_0.16.0_aarch64.dmg.minisig`,
      },
    })
  })

  it('has no DMG or signature when the release lacks the exact asset names', () => {
    const download = `${REPO}/releases/download/v0.16.0`
    const [release] = parse([githubRelease('v0.16.0', {
      body: null,
      assets: [
        { name: 'Dez_0.16.0_aarch64.dmg', browser_download_url: `${download}/Dez_0.16.0_aarch64.dmg` },
        { name: 'Dez_0.15.1_aarch64.dmg.minisig', browser_download_url: `${download}/Dez_0.15.1_aarch64.dmg.minisig` },
        { name: 'Dez_0.16.0_x64.dmg.minisig', browser_download_url: `${download}/Dez_0.16.0_x64.dmg.minisig` },
      ],
    })])
    expect(release.dmgAsset?.name).toBe('Dez_0.16.0_aarch64.dmg')
    expect(release.signatureAsset).toBeNull()
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

  it('refuses a newer release whose signature is outside the asset prefix', () => {
    const assets = [{ name: 'Dez_0.16.0_aarch64.dmg.minisig', browser_download_url: 'https://evil.example/Dez_0.16.0_aarch64.dmg.minisig' }]
    expect(() => parse([githubRelease('v0.16.0', { assets })])).toThrow('outside the Dez repository')
  })

  it('accepts assets under another prefix, as a smoke-test server serves them', () => {
    const server = 'http://127.0.0.1:8765/'
    const assets = [{ name: 'Dez_0.16.0_aarch64.dmg.minisig', browser_download_url: `${server}v0.16.0/Dez_0.16.0_aarch64.dmg.minisig` }]
    const [release] = parse([githubRelease('v0.16.0', { assets })], { ...OPTIONS, assetUrlPrefix: server })
    expect(release.signatureAsset?.url).toBe(`${server}v0.16.0/Dez_0.16.0_aarch64.dmg.minisig`)
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
