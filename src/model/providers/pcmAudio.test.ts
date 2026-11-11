import { describe, expect, it } from 'vitest'
import { pcmLayout, wavFile, wavFileOfChannels } from './pcmAudio'

describe('pcmLayout', () => {
  // The content type of OpenRouter's HeyGen Voice answer.
  it('reads the rate and the channels from the content type, and takes the sample size from the caller', () => {
    expect(pcmLayout('audio/pcm;rate=44100;channels=1', 16)).toStrictEqual({ rate: 44100, channels: 1, sampleBits: 16 })
  })

  it('takes the parameters in any order, with spaces', () => {
    expect(pcmLayout('audio/pcm; channels=2; rate=24000', 16)).toStrictEqual({ rate: 24000, channels: 2, sampleBits: 16 })
  })

  it('counts one channel when the content type names none', () => {
    expect(pcmLayout('audio/pcm;rate=24000', 16)).toStrictEqual({ rate: 24000, channels: 1, sampleBits: 16 })
  })

  // A guessed rate plays the clip at a wrong speed.
  it.each([
    ['no rate', 'audio/pcm'],
    ['a rate of zero', 'audio/pcm;rate=0'],
    ['a rate that is no whole number', 'audio/pcm;rate=44100.5'],
    ['a rate that is no number', 'audio/pcm;rate=fast'],
    ['channels that are no count', 'audio/pcm;rate=44100;channels=stereo'],
    ['zero channels', 'audio/pcm;rate=44100;channels=0'],
  ])('knows no layout for %s', (_name, contentType) => {
    expect(pcmLayout(contentType, 16)).toBeNull()
  })

  it('knows no layout when the API does not tell the sample size', () => {
    expect(pcmLayout('audio/pcm;rate=44100;channels=1', undefined)).toBeNull()
  })

  // `audio/l16` samples are big-endian: a WAV file takes little-endian.
  it.each(['audio/l16;rate=44100', 'audio/mpeg', 'audio/wav', 'audio/pcmu;rate=8000', ''])('knows no layout for %j, which is not audio/pcm', (contentType) => {
    expect(pcmLayout(contentType, 16)).toBeNull()
  })
})

describe('wavFile', () => {
  const text = (file: Uint8Array, start: number) => new TextDecoder().decode(file.subarray(start, start + 4))

  it('writes the canonical 44-byte header, little-endian, before the samples', () => {
    const samples = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
    const file = wavFile(samples, { rate: 44100, channels: 2, sampleBits: 16 })
    const header = new DataView(file.buffer)

    expect({
      riff: text(file, 0),
      riffBytes: header.getUint32(4, true),
      wave: text(file, 8),
      fmt: text(file, 12),
      fmtBytes: header.getUint32(16, true),
      format: header.getUint16(20, true),
      channels: header.getUint16(22, true),
      rate: header.getUint32(24, true),
      bytesPerSecond: header.getUint32(28, true),
      frameBytes: header.getUint16(32, true),
      sampleBits: header.getUint16(34, true),
      data: text(file, 36),
      dataBytes: header.getUint32(40, true),
      samples: [...file.subarray(44)],
    }).toStrictEqual({
      riff: 'RIFF',
      // The file with no `RIFF` tag and no size field.
      riffBytes: 44,
      wave: 'WAVE',
      fmt: 'fmt ',
      fmtBytes: 16,
      format: 1,
      channels: 2,
      rate: 44100,
      bytesPerSecond: 176400,
      frameBytes: 4,
      sampleBits: 16,
      data: 'data',
      dataBytes: 8,
      samples: [1, 2, 3, 4, 5, 6, 7, 8],
    })
  })

  it('leaves out a last frame that is not whole', () => {
    // Three bytes of 16-bit mono: one frame and a half.
    const mono = wavFile(Uint8Array.from([1, 2, 3]), { rate: 8000, channels: 1, sampleBits: 16 })
    // Six bytes of 16-bit stereo: one frame and a half.
    const stereo = wavFile(Uint8Array.from([1, 2, 3, 4, 5, 6]), { rate: 8000, channels: 2, sampleBits: 16 })

    expect([
      [mono.length, new DataView(mono.buffer).getUint32(40, true), [...mono.subarray(44)]],
      [stereo.length, new DataView(stereo.buffer).getUint32(40, true), [...stereo.subarray(44)]],
    ]).toStrictEqual([
      [46, 2, [1, 2]],
      [48, 4, [1, 2, 3, 4]],
    ])
  })

  it('writes a header with no samples for an empty answer', () => {
    const file = wavFile(new Uint8Array(), { rate: 44100, channels: 1, sampleBits: 16 })

    expect([file.length, new DataView(file.buffer).getUint32(4, true), new DataView(file.buffer).getUint32(40, true)]).toStrictEqual([44, 36, 0])
  })

  // The samples of a response are a view of a larger buffer.
  it('reads only the bytes of the view that it gets', () => {
    const buffer = Uint8Array.from([9, 9, 1, 2, 3, 4, 9, 9])
    const file = wavFile(buffer.subarray(2, 6), { rate: 8000, channels: 1, sampleBits: 16 })

    expect([...file.subarray(44)]).toStrictEqual([1, 2, 3, 4])
  })
})

describe('wavFileOfChannels', () => {
  const samples = (file: Uint8Array) => {
    const view = new DataView(file.buffer, 44)
    return Array.from({ length: view.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true))
  }

  it('writes a 16-bit header for the channels and the rate, and interleaves the frames', () => {
    // The channels of a cut are views into larger decoded channels.
    const left = Float32Array.from([9, 0, 0.5, -0.5, 9]).subarray(1, 4)
    const right = Float32Array.from([9, 1, -1, 0.25, 9]).subarray(1, 4)
    const file = wavFileOfChannels([left, right], 48000)
    const header = new DataView(file.buffer)

    expect({
      channels: header.getUint16(22, true),
      rate: header.getUint32(24, true),
      bytesPerSecond: header.getUint32(28, true),
      frameBytes: header.getUint16(32, true),
      sampleBits: header.getUint16(34, true),
      dataBytes: header.getUint32(40, true),
      samples: samples(file),
    }).toStrictEqual({
      channels: 2,
      rate: 48000,
      bytesPerSecond: 192000,
      frameBytes: 4,
      sampleBits: 16,
      dataBytes: 12,
      samples: [0, 32767, 16384, -32768, -16384, 8192],
    })
  })

  it('clips samples past -1 and 1, and writes silence for a sample that is not a number', () => {
    const file = wavFileOfChannels([Float32Array.from([1.5, -2, Number.NaN])], 8000)

    expect(samples(file)).toStrictEqual([32767, -32768, 0])
  })

  it('writes a header with no samples for channels with no frames', () => {
    const file = wavFileOfChannels([new Float32Array(), new Float32Array()], 48000)

    expect([file.length, new DataView(file.buffer).getUint16(22, true), new DataView(file.buffer).getUint32(40, true)]).toStrictEqual([44, 2, 0])
  })
})
