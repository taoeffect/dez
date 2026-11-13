// WAV files: raw PCM audio (`audio/pcm`), the samples of a clip with no
// file format, which no player plays, gets a WAV header before its samples
// (`wavFile`); decoded audio (Web Audio's float samples) becomes a 16-bit
// WAV file (`wavFileOfChannels`, for the webview's cut of an audio clip).

// How the samples of raw PCM audio are laid out. The samples are signed
// whole numbers, little-endian.
export interface PcmLayout {
  // Samples of one channel in a second.
  rate: number
  channels: number
  // The size of one sample, in bits.
  sampleBits: number
}

/** The layout of the raw PCM audio of a response with `contentType` (lower
 *  case, with its parameters, such as `audio/pcm;rate=44100;channels=1`).
 *  The content type tells the rate and the count of channels. It does not
 *  tell the size of a sample: that is a fact of the provider's API
 *  (`sampleBits`; undefined when the API's docs do not tell it).
 *
 *  Null when the response is not `audio/pcm`, and when a part of the layout
 *  is not known. Dez never guesses a rate: a wrong one plays the clip at a
 *  wrong speed. With no `channels`, the audio has one channel: that is the
 *  default of the `audio/L16` type (RFC 2586), which these parameters come
 *  from. `audio/l16` itself is not taken: its samples are big-endian.
 *  https://www.rfc-editor.org/rfc/rfc2586 */
export function pcmLayout(contentType: string, sampleBits: number | undefined): PcmLayout | null {
  const [mediaType, ...parts] = contentType.split(';').map((part) => part.trim())
  if (mediaType !== 'audio/pcm' || sampleBits === undefined) return null

  const parameter = (name: string): number | undefined => {
    const text = parts.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
    return text !== undefined && /^[1-9]\d*$/.test(text) ? Number(text) : undefined
  }
  const rate = parameter('rate')
  // A `channels` that is not a count is an unknown layout, not one channel.
  const channels = parts.some((part) => part.startsWith('channels=')) ? parameter('channels') : 1
  return rate === undefined || channels === undefined ? null : { rate, channels, sampleBits }
}

const WAV_HEADER_BYTES = 44

// A WAV file with room for `dataBytes` bytes of samples after the 44-byte
// header of the canonical form (a `fmt ` chunk of format 1, PCM, and a
// `data` chunk). The header is written; the samples are zero.
function blankWavFile(dataBytes: number, { rate, channels, sampleBits }: PcmLayout): Uint8Array {
  const frameBytes = channels * sampleBits / 8
  const file = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const header = new DataView(file.buffer)
  const tag = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) header.setUint8(offset + index, text.charCodeAt(index))
  }
  // Every number of the header is little-endian.
  tag(0, 'RIFF')
  // The bytes of the file after this field.
  header.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  // The bytes of the `fmt ` chunk after this field.
  header.setUint32(16, 16, true)
  // Format 1: PCM samples that are whole numbers.
  header.setUint16(20, 1, true)
  header.setUint16(22, channels, true)
  header.setUint32(24, rate, true)
  header.setUint32(28, rate * frameBytes, true)
  header.setUint16(32, frameBytes, true)
  header.setUint16(34, sampleBits, true)
  tag(36, 'data')
  header.setUint32(40, dataBytes, true)
  return file
}

/** A WAV file of raw PCM `samples`: the header, then the samples. A last
 *  frame that is not whole is left out: every frame of a WAV file has one
 *  sample of each channel. */
export function wavFile(samples: Uint8Array, layout: PcmLayout): Uint8Array {
  const frameBytes = layout.channels * layout.sampleBits / 8
  const dataBytes = samples.length - samples.length % frameBytes
  const file = blankWavFile(dataBytes, layout)
  file.set(samples.subarray(0, dataBytes), WAV_HEADER_BYTES)
  return file
}

/** A 16-bit WAV file of decoded audio at `rate` frames a second: one array
 *  of samples per channel, all of one length, each sample from -1 to 1 (the
 *  channels of a Web Audio `AudioBuffer`). A sample past that range is
 *  clipped to it. */
export function wavFileOfChannels(channels: readonly Float32Array[], rate: number): Uint8Array {
  const frames = channels[0]?.length ?? 0
  const file = blankWavFile(frames * channels.length * 2, { rate, channels: channels.length, sampleBits: 16 })
  const samples = new DataView(file.buffer, WAV_HEADER_BYTES)
  let offset = 0
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame]))
      // -1 to 1 onto the whole range of a 16-bit sample, -32768 to 32767.
      samples.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true)
      offset += 2
    }
  }
  return file
}
