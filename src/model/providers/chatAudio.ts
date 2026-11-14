import sbp from '@sbp/sbp'
import { base64ToBytes } from '../../utils/base64'
import { ExplainedError, REPORT_ADVICE } from '../../utils/errorText'
import { sanitizeErrorText } from '../../utils/protocol/errors'
import { MEDIA_TEMP_LIFETIME_MS } from '../chat/mediaFiles'
import { MEDIA_CACHE_FOLDER } from '../chat/mediaTags'
import type { AudioOutputConfig } from './config'
import { UnusableAnswerError } from './errors'
import { audioFileType, wavFile } from './pcmAudio'
import type { GeneratedClip } from './types'

/** Writes the audio of a chat answer (`data`: the base64 text of the
 *  stream, `SseTokenEvent` `audio`) to a temp copy in the cache's media
 *  folder, as the clips of a media request are, and gives it as a clip.
 *  `output` is the model's `audioOutputs` entry: it tells the type of the
 *  bytes. Raw PCM gets a WAV header, as no player plays it (pcmAudio.ts).
 *  `providerName` names the provider in the error of a type that Dez does
 *  not know; the config schema refuses such an entry (config.ts), so only
 *  a config that did not pass it gets that error. */
export async function saveChatAudio(data: string, output: AudioOutputConfig, providerName: string): Promise<GeneratedClip> {
  const startedAt = Date.now()
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(data)
  } catch {
    throw new UnusableAnswerError('The audio of the answer is not base64 text.')
  }

  const fileType = audioFileType(output.contentType, output.pcmSampleBits)
  if (fileType === null) {
    throw new ExplainedError(
      `Dez cannot store the audio of the answer: the provider settings of ${providerName} give it a type that Dez does not know (\`audioOutputs\`). Fix the type in the provider settings. ${REPORT_ADVICE}`,
      `Type: ${sanitizeErrorText(output.contentType, 100)}`,
    )
  }
  const { mediaType, extension, pcm } = fileType

  const file = `${MEDIA_CACHE_FOLDER}/${crypto.randomUUID()}.${extension}`
  await sbp('dez.native/saveAppFile', file, pcm ? wavFile(bytes, pcm) : bytes, 'cache')
  const cacheDir = await sbp('dez.native/getAppDir', 'cache') as string
  return {
    kind: 'audio',
    mediaType,
    src: `${cacheDir}/${file}`,
    url: null,
    // A time before the write, so the copy is there until then (see
    // `MEDIA_TEMP_LIFETIME_MS`).
    expires: new Date(startedAt + MEDIA_TEMP_LIFETIME_MS).toISOString(),
    jobId: null,
  }
}
