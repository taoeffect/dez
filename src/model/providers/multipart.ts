// A `multipart/form-data` body (RFC 7578), for a media endpoint that takes
// a file only as an upload: Venice's transcription and voice changer. The
// provider gets the clip as raw bytes in the form, not as base64 text in a
// JSON body; only the step to Rust carries the form as base64 text
// (`HttpBody::Base64`, `Provider.mediaApiRequest`).
// https://www.rfc-editor.org/rfc/rfc7578

/** One field of a form: a text, or a file with its bytes. The names come
 *  from the media formats, never from the user, and a file name names no
 *  local path (a provider gets no path). */
export type MultipartField =
  | { name: string, value: string }
  | { name: string, file: { bytes: Uint8Array, mediaType: string, fileName: string } }

// A name or a file name in a quoted header parameter. RFC 7578 tells to
// percent-encode the quote and the line breaks, as browsers do.
function quotedParameter(text: string): string {
  return text.replace(/["\r\n]/g, (char) => encodeURIComponent(char))
}

/** The bytes of a form with `fields`, in their order, and the content type
 *  that names its boundary. The boundary is random: the chance that a
 *  file holds it is too small to check for. */
export function multipartBody(fields: readonly MultipartField[]): { contentType: string, body: Uint8Array } {
  const boundary = `dez-${crypto.randomUUID()}`
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const field of fields) {
    const disposition = `Content-Disposition: form-data; name="${quotedParameter(field.name)}"`
    const head = 'file' in field
      ? `--${boundary}\r\n${disposition}; filename="${quotedParameter(field.file.fileName)}"\r\nContent-Type: ${field.file.mediaType}\r\n\r\n`
      : `--${boundary}\r\n${disposition}\r\n\r\n`
    parts.push(encoder.encode(head), 'file' in field ? field.file.bytes : encoder.encode(field.value), encoder.encode('\r\n'))
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`))

  const body = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body }
}
