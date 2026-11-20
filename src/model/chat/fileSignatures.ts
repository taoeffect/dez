import { imageExtension, type ImageMediaType } from './images'
import { mediaFileExtension } from './mediaFiles'
import type { MediaTagKind } from './mediaTags'

// The type of a file from its first bytes, for a file whose name and
// whose stated type Dez cannot trust: the answer of a provider, and a file
// that the code of a model wrote. Only the types that Dez stores as assets
// are here (`isImageMediaType`, images.ts; `knownMediaType`,
// mediaFiles.ts).
//
// The check tells what a file claims to be at its start. It does not
// decode the file, so a file that starts as a PNG and holds no picture
// still passes: the reader of a stored asset must take a broken file.

/** The type of a file that Dez stores as an asset, and the extension of
 *  its stored file. */
export type StoredFileType =
  | { kind: 'image', type: ImageMediaType, extension: string }
  | { kind: MediaTagKind, type: string, extension: string }

function hasBytes(data: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  return data.length >= offset + bytes.length && bytes.every((byte, index) => data[offset + index] === byte)
}

// Whether `data` holds the ASCII text `text` at `offset`.
function hasText(data: Uint8Array, offset: number, text: string): boolean {
  return hasBytes(data, offset, [...text].map((character) => character.charCodeAt(0)))
}

// The ASCII text of `length` bytes of `data` at `offset` (shorter at the
// end of the data).
function textAt(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length))
}

// The start of the text of an SVG file (the decoder drops a UTF-8 byte
// order mark): the XML prolog (white space, processing instructions such as
// the `<?xml …?>` declaration, comments, and a DOCTYPE of the root `svg`),
// then the root `svg` element. Each prolog part ends at its first end mark
// and the repeated item takes one white-space char at a time, so a text
// that is no SVG fails in one pass, with no backtracking blow-up.
const SVG_START = /^(?:\s|<\?(?:[^?]|\?(?!>))*\?>|<!--(?:[^-]|-(?!->))*-->|<!DOCTYPE\s+svg\b[^[>]*(?:\[[^\]]*\])?\s*>)*<svg[\s/>]/
// The part of the bytes in which `SVG_START` looks for the root element:
// far more than the prolog of any SVG that a program writes (an editor's
// DOCTYPE with its entities is about 1 KB), and a bound on the text that a
// large file that is no image makes.
const SVG_PROLOG_MAX_BYTES = 64 * 1024

/** The type of an image that Dez stores, from its first bytes; null for
 *  any other bytes. WebP is a RIFF file (the 4 bytes after `RIFF` are its
 *  size) with `WEBP` at offset 8. SVG is text and has no such bytes
 *  (`SVG_START`). */
export function imageTypeOfBytes(data: Uint8Array): ImageMediaType | null {
  if (hasBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (hasBytes(data, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (hasText(data, 0, 'GIF8')) return 'image/gif'
  if (hasText(data, 0, 'RIFF') && hasText(data, 8, 'WEBP')) return 'image/webp'
  return SVG_START.test(new TextDecoder().decode(data.subarray(0, SVG_PROLOG_MAX_BYTES))) ? 'image/svg+xml' : null
}

// The major brands of an ISO media file (`ftyp`) that is a still picture
// (HEIF, AVIF), which Dez does not store, and those of an audio file. Any
// other brand is a video: the brands of MP4 video are many (`isom`,
// `mp42`, `avc1`, `dash`, …), and a new one must still pass.
const PICTURE_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'])
const AUDIO_BRANDS: ReadonlySet<string> = new Set(['M4A ', 'M4B ', 'M4P '])

// The media type of an ISO media file (MP4, QuickTime) from the major
// brand of its `ftyp` box, the first box of the file.
function isoMediaType(data: Uint8Array): string | null {
  const brand = textAt(data, 8, 4)
  if (brand.length < 4 || PICTURE_BRANDS.has(brand)) return null
  if (brand === 'qt  ') return 'video/quicktime'
  return AUDIO_BRANDS.has(brand) ? 'audio/mp4' : 'video/mp4'
}

// The bytes in which the doctype of an EBML file must be: its header is
// about 40 bytes.
const EBML_HEADER_BYTES = 64
// The DocType element of a WebM file: its id (42 82), its size (4), and
// `webm`. Matroska (`matroska`) has the same header, and Dez stores none.
const WEBM_DOCTYPE = [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]

function isWebm(data: Uint8Array): boolean {
  for (let offset = 4; offset < EBML_HEADER_BYTES; offset += 1) {
    if (hasBytes(data, offset, WEBM_DOCTYPE)) return true
  }
  return false
}

// The media type of an Ogg file. The data of its first page comes after
// the 27 bytes of the page header and one byte for each segment (the count
// is byte 26); an Opus stream starts with `OpusHead`.
function oggMediaType(data: Uint8Array): string {
  return hasText(data, 27 + (data[26] ?? 0), 'OpusHead') ? 'audio/opus' : 'audio/ogg'
}

// Whether `data` starts with the header of an MPEG audio frame of layer 3
// (an MP3 file with no ID3 tag): 11 set bits, a version and a layer, and a
// bit rate and a sample rate that are no reserved value. Only layer 3
// counts, so the byte order mark of a UTF-16 text (FF FE) is no frame.
function isMp3Frame(data: Uint8Array): boolean {
  if (data.length < 3 || data[0] !== 0xff) return false
  const second = data[1]
  const third = data[2]
  return (second & 0xe0) === 0xe0 && (second & 0x18) !== 0x08 && (second & 0x06) === 0x02
    && (third & 0xf0) !== 0xf0 && (third & 0x0c) !== 0x0c
}

// Whether `data` starts with the header of an ADTS frame (a raw AAC file):
// 12 set bits, the layer 0, and a sample rate that is no reserved value.
function isAdtsFrame(data: Uint8Array): boolean {
  return data.length >= 3 && data[0] === 0xff && (data[1] & 0xf6) === 0xf0 && ((data[2] >> 2) & 0x0f) < 13
}

// The media type of a clip that Dez stores, from its first bytes.
function clipTypeOfBytes(data: Uint8Array): string | null {
  if (hasText(data, 4, 'ftyp')) return isoMediaType(data)
  if (hasBytes(data, 0, [0x1a, 0x45, 0xdf, 0xa3])) return isWebm(data) ? 'video/webm' : null
  if (hasText(data, 0, 'RIFF') && hasText(data, 8, 'WAVE')) return 'audio/wav'
  if (hasText(data, 0, 'fLaC')) return 'audio/flac'
  if (hasText(data, 0, 'OggS')) return oggMediaType(data)
  if (hasText(data, 0, 'ID3') || isMp3Frame(data)) return 'audio/mpeg'
  return isAdtsFrame(data) ? 'audio/aac' : null
}

/** The type of a file that Dez stores as an asset (an image, an audio
 *  clip, or a video clip), from its first bytes; null for any other bytes.
 *
 *  A container tells its kind only by what is in it, which this check does
 *  not read. So a WebM file with only sound reads as a video, an MP4 file
 *  with only sound reads as a video unless its brand is one of audio
 *  (`M4A `, as ffmpeg writes it for `.m4a`), and an Ogg file with a
 *  picture reads as audio. Such a clip still plays. */
export function storedTypeOfBytes(data: Uint8Array): StoredFileType | null {
  const image = imageTypeOfBytes(data)
  if (image) return { kind: 'image', type: image, extension: imageExtension(image) }
  const type = clipTypeOfBytes(data)
  const extension = type === null ? null : mediaFileExtension(type, null)
  if (type === null || extension === null) return null
  return { kind: type.startsWith('audio/') ? 'audio' : 'video', type, extension }
}
