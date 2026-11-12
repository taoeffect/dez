import { describe, expect, it } from 'vitest'
import { multipartBody } from './multipart'

// The standard parser of the platform reads the form, as a server would.
async function parsedForm(contentType: string, body: Uint8Array): Promise<FormData> {
  return new Response(body, { headers: { 'Content-Type': contentType } }).formData()
}

describe('multipartBody', () => {
  it('gives a form whose text fields and file bytes a standard parser reads back unchanged', async () => {
    // Bytes that hold a line break, a boundary start, and every byte value.
    const bytes = new Uint8Array([...new TextEncoder().encode('\r\n--x\r\n'), ...Array.from({ length: 256 }, (_, index) => index)])
    const { contentType, body } = multipartBody([
      { name: 'model', value: 'whisper' },
      { name: 'file', file: { bytes, mediaType: 'audio/wav', fileName: 'clip.wav' } },
      { name: 'note', value: 'two\r\nlines' },
    ])

    expect(contentType).toMatch(/^multipart\/form-data; boundary=dez-[0-9a-f-]{36}$/)
    const form = await parsedForm(contentType, body)
    expect([...form.keys()]).toStrictEqual(['model', 'file', 'note'])
    expect(form.get('model')).toBe('whisper')
    expect(form.get('note')).toBe('two\r\nlines')
    const file = form.get('file') as File
    expect([file.name, file.type]).toStrictEqual(['clip.wav', 'audio/wav'])
    expect(new Uint8Array(await file.arrayBuffer())).toStrictEqual(bytes)
  })

  it('keeps a quote and a line break of a name and a file name, which a parser reads back', async () => {
    const { contentType, body } = multipartBody([
      { name: 'a"b', value: '1' },
      { name: 'f', file: { bytes: new Uint8Array([1]), mediaType: 'audio/mpeg', fileName: 'x"\r\ny.mp3' } },
    ])

    const form = await parsedForm(contentType, body)
    expect([...form.keys()]).toStrictEqual(['a"b', 'f'])
    expect((form.get('f') as File).name).toBe('x"\r\ny.mp3')
  })
})
