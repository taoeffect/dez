// `btoa` takes a string of byte values, and `String.fromCharCode` takes the
// bytes as call arguments. Engines limit the number of arguments, so a large
// image is turned into that string in chunks.
const CHUNK_BYTES = 0x8000

/** The standard base64 text of `bytes`, with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK_BYTES))
  }
  return btoa(binary)
}

/** The bytes of standard base64 text. Throws when the text is not base64. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
