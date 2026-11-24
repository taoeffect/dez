import { describe, expect, it } from 'vitest'
import { align, ALIGN_RATE, ANCHOR_RATE, BEAT_RATE, beatGrid, onsetEnvelope, onsets, tempo, trackBeats } from '../../src-tauri/libs/dez-media/audio.js'
import { stft } from '../../src-tauri/libs/dez-media/dsp.js'
import { alignInputs, anchorInput, clickTrack, closeValues, inputHash, oracle } from './testing'

const HOP = 256
const frameOf = (time: number) => Math.round((time * BEAT_RATE) / HOP)

describe('dez-media beatGrid against beats.py with NumPy', () => {
  const samples = clickTrack()
  const expected = oracle.beats

  it('gets the same click track as numpyOracle.py', () => {
    expect(inputHash(samples)).toBe(oracle.inputs.clickTrack)
  })

  // NumPy's math on float32 samples is single precision, and dez-media's is
  // double: the values agree to about 1e-6.
  it('has the magnitudes of the spectrogram of beats.py', () => {
    const spectrogram = stft(samples)
    expect(spectrogram.frames).toBe(expected.frames)
    expected.stftFrames.forEach((frame, row) => {
      const actual = expected.stftBins.map((bin) => spectrogram.magnitude[frame * spectrogram.bins + bin])
      expect(closeValues(actual, expected.stft[row], 0, 1e-5), `frame ${frame}`).toBeNull()
    })
  })

  it('has the onset envelopes, the tempo, and the beat frames of beats.py', () => {
    const spectrogram = stft(samples)
    const env = onsetEnvelope(spectrogram)
    expect(closeValues(env, expected.envelope, 0, 1e-5)).toBeNull()
    expect(closeValues(onsetEnvelope(spectrogram, 0, 13), expected.lowEnvelope, 0, 1e-5)).toBeNull()
    const { bpm, period } = tempo(env, BEAT_RATE / HOP)
    expect(bpm).toBeCloseTo(expected.bpm, 6)
    expect(period).toBeCloseTo(expected.period, 5)
    expect(trackBeats(env, period)).toEqual(expected.beats)
  })

  it('gives the beat grid of beats.py in seconds', () => {
    const grid = beatGrid(samples)
    expect(grid.duration).toBe(20)
    expect(grid.bpm).toBeCloseTo(expected.bpm, 6)
    expect(grid.beats.map(frameOf)).toEqual(expected.beats)
    expect(grid.downbeatPhase).toBe(expected.downbeatPhase)
    expect(grid.downbeats.map(frameOf)).toEqual(expected.beats.filter((_, k) => k % 4 === expected.downbeatPhase))
    expect(closeValues(grid.loudness, expected.loudness, 0, 1e-5)).toBeNull()
    expect(grid.accents.map(frameOf)).toEqual(expected.accents)
  })

  it('finds the tempo of the click track (123.05 BPM) and its accented beats', () => {
    const grid = beatGrid(samples)
    expect(Math.abs(grid.bpm - 123.05)).toBeLessThan(0.1)
    // The louder click with a hum is every fourth beat from the second.
    expect(grid.downbeatPhase).toBe(1)
  })

  it('has no beat in silence, and says so', () => {
    expect(() => beatGrid(new Float32Array(BEAT_RATE * 5))).toThrow(/no beat/)
  })

  // tempo needs the lag of one beat at 190 BPM (28 frames) and two frames
  // more, so the shortest song is 30 frames: 9472 samples, 0.4296 s.
  it('refuses a song that is too short for tempo, with its least length rounded up', () => {
    expect(() => beatGrid(samples.subarray(0, 9471))).toThrow('beatGrid: the song is too short. It needs at least 0.43 s.')
    const { bpm } = beatGrid(samples.subarray(0, 9472))
    expect(bpm).toBeGreaterThan(70)
    expect(bpm).toBeLessThan(190)
  })
})

describe('dez-media onsets against sfx_anchor with NumPy', () => {
  const samples = anchorInput()

  it('gets the same sound as numpyOracle.py', () => {
    expect(inputHash(samples)).toBe(oracle.inputs.anchors)
  })

  it('gives the first onset and the peak of sfx_anchor, and each onset over the level', () => {
    const found = onsets(samples, ANCHOR_RATE)
    expect(found.first).toBeCloseTo(oracle.anchors.onset, 12)
    expect(found.peak).toBeCloseTo(oracle.anchors.peak, 12)
    expect(closeValues(found.onsets, oracle.anchors.onsets, 1e-12)).toBeNull()
  })

  it('has no onset in silence or in a clip shorter than a frame', () => {
    expect(onsets(new Float32Array(8000))).toEqual({ first: null, peak: null, onsets: [] })
    expect(onsets(Float32Array.of(0.5, 0.5))).toEqual({ first: null, peak: null, onsets: [] })
  })

  it('refuses a level that no frame can pass', () => {
    expect(() => onsets(samples, ANCHOR_RATE, { level: 1 })).toThrow(RangeError)
    expect(() => onsets(samples, ANCHOR_RATE, { level: 0 })).toThrow(RangeError)
  })
})

describe('dez-media align against sync_check.py with NumPy', () => {
  const { song, mix, noise } = alignInputs()
  // The search of sync_check.py: the frames of the mix from its first
  // sample only.
  const reference = { phases: 1 }

  it('gets the same song, mix, and noise as numpyOracle.py', () => {
    expect(inputHash(song)).toBe(oracle.inputs.alignSong)
    expect(inputHash(mix)).toBe(oracle.inputs.alignMix)
    expect(inputHash(noise)).toBe(oracle.inputs.alignNoise)
  })

  it('finds the song at 3.72 s in the mix, with a high confidence', () => {
    const found = align(song, mix, ALIGN_RATE, reference)
    expect(found.offset).toBe(oracle.align.mix.offset)
    expect(found.offset).toBeCloseTo(3.72, 12)
    expect(found.confidence).toBeCloseTo(oracle.align.mix.confidence, 5)
    expect(found.confidence).toBeGreaterThan(0.9)
    // The song starts on a frame: the other starts match less.
    expect(align(song, mix, ALIGN_RATE)).toStrictEqual(found)
  })

  // In a mix of 8 s, align searches the offsets up to 4 s (half the mix),
  // not 6 s, and cuts the song to the 4 s of the mix after each offset.
  it('searches half of a short mix, with a cut song', () => {
    const found = align(song, mix.subarray(0, 64000), ALIGN_RATE, reference)
    expect(found.offset).toBe(oracle.align.shortMix.offset)
    expect(found.confidence).toBeCloseTo(oracle.align.shortMix.confidence, 5)
  })

  it('has a low confidence for sounds that do not match', () => {
    const found = align(song, noise, ALIGN_RATE, reference)
    expect(found.offset).toBe(oracle.align.noise.offset)
    expect(found.confidence).toBeCloseTo(oracle.align.noise.confidence, 5)
    expect(align(song, noise, ALIGN_RATE).confidence).toBeLessThan(0.3)
  })

  // A change from sync_check.py: a song that starts half a frame (2.5 ms)
  // after a frame start matched it with a confidence under 0.3.
  it('finds a song that starts between two frames, with a high confidence, to 1.25 ms', () => {
    for (const delay of [10, 20, 30]) {
      const later = new Float32Array(mix.length + delay)
      later.set(mix, delay)
      const found = align(song, later, ALIGN_RATE)
      expect(found.offset).toBeCloseTo(3.72 + delay / ALIGN_RATE, 12)
      expect(found.confidence).toBeGreaterThan(0.9)
    }
  })

  it('refuses a clip shorter than two of its 5 ms frames, and a count of phases that is not a whole number from 1', () => {
    expect(() => align(new Float32Array(50), mix, ALIGN_RATE)).toThrow(/too short/)
    expect(() => align(song, mix, ALIGN_RATE, { phases: 0 })).toThrow(/phases/)
    expect(() => align(song, mix, ALIGN_RATE, { phases: 1.5 })).toThrow(/phases/)
  })
})
