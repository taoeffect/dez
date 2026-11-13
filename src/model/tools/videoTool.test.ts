import { describe, expect, it } from 'vitest'
import { MAX_SAVED_CLIP_BYTES } from '../chat/mediaFiles'
import { mediaTagText } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { reply, user } from '../streams/testing'
import { CONVERSATION, FILM, OPUS, probeOutput, RED, refusal, SKY, SONG, VP9, WEBM } from './testing'
import type { ToolArguments } from './types'
import {
  clipFacts,
  commandLineWords,
  DEFAULT_VIDEO_TIMEOUT_SECONDS,
  FFMPEG_FIXED_ARGS,
  ffmpegCall,
  ffmpegRunResult,
  ffmpegStateText,
  ffprobeCall,
  ffprobeFailedText,
  ffprobeResultText,
  joinClipsCall,
  joinPlan,
  joinProbeArgs,
  joinProbeFailedText,
  joinRunResult,
  MAX_VIDEO_OUTPUT_FILES,
  OutputStart,
  outputFiles,
  PROGRAM_OUTPUT_CAP,
  ProgramLog,
  VIDEO_TOOL,
  VIDEO_TOOL_DEFINITION,
  videoInputsText,
  type ClipFacts,
  type JoinPlan,
  type OutputFiles,
} from './videoTool'

// The arguments that ffmpeg gets for the command line `text`, without the
// ones that Dez adds.
function ffmpegWords(text: string, sections: Section[] = CONVERSATION): string[] {
  return ffmpegCall({ arguments: text }, sections).args.slice(FFMPEG_FIXED_ARGS.length)
}

function subcommand(name: string) {
  const found = VIDEO_TOOL.subcommands.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`The video tool has no subcommand ${name}.`)
  return found
}

describe('the video tool', () => {
  it('is one tool with the subcommands join_clips, ffmpeg, and ffprobe', () => {
    expect(VIDEO_TOOL_DEFINITION.name).toBe('video')
    expect(VIDEO_TOOL.subcommands.map(({ name, parameters }) => [name, parameters.map((parameter) => parameter.name)])).toStrictEqual([
      ['join_clips', ['clips', 'timeout_seconds']],
      ['ffmpeg', ['arguments', 'timeout_seconds']],
      ['ffprobe', ['arguments']],
    ])
  })

  it('runs a job for the time that its help states when a call gives none', () => {
    expect(ffmpegCall({ arguments: '-i @c out.mp4' }, CONVERSATION).timeoutMs).toBe(DEFAULT_VIDEO_TIMEOUT_SECONDS * 1000)
    expect(joinClipsCall({ clips: '@c @d' }, CONVERSATION).timeoutMs).toBe(DEFAULT_VIDEO_TIMEOUT_SECONDS * 1000)
    expect(subcommand('ffmpeg').parameters.at(-1)?.description).toContain(`${DEFAULT_VIDEO_TIMEOUT_SECONDS} (10 minutes)`)
  })

  it('accepts every example of its own help', () => {
    const examples = subcommand('ffmpeg').description.split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(line.indexOf(': ') + 2))

    expect(examples).toHaveLength(6)
    expect(ffmpegWords(examples[0])).toStrictEqual(['-i', 'c.webm', '-i', 'b.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', 'out.mp4'])
    for (const example of examples) expect(() => ffmpegCall({ arguments: example }, CONVERSATION), example).not.toThrow()
    expect(() => ffmpegCall(subcommand('ffmpeg').example as ToolArguments, CONVERSATION)).not.toThrow()
    expect(() => ffprobeCall(subcommand('ffprobe').example as ToolArguments, CONVERSATION)).not.toThrow()
    expect(() => joinClipsCall(subcommand('join_clips').example as ToolArguments, CONVERSATION)).not.toThrow()
  })
})

describe('commandLineWords', () => {
  it('splits at white space and keeps a quoted word whole, without its quotes', () => {
    expect(commandLineWords(' -i  x.mp4\n-vf "scale=640:-2, fps=5" -metadata title=\'My clip\' out.mp4 ', 'ffmpeg')).toStrictEqual([
      '-i', 'x.mp4', '-vf', 'scale=640:-2, fps=5', '-metadata', 'title=My clip', 'out.mp4',
    ])
  })

  it('keeps the single quotes of a word in double quotes, for a filter value', () => {
    expect(commandLineWords('-vf "select=\'eq(n,0)\'" x.jpg', 'ffmpeg')).toStrictEqual(['-vf', 'select=\'eq(n,0)\'', 'x.jpg'])
  })

  it('takes \\" in double quotes as a double quote, and leaves every other backslash', () => {
    expect(commandLineWords('-metadata "title=a \\"b\\" c" a\\ b \'c\\"d\'', 'ffmpeg')).toStrictEqual(['-metadata', 'title=a "b" c', 'a\\', 'b', 'c\\"d'])
  })

  it('keeps an empty quoted word', () => {
    expect(commandLineWords('-metadata "" x', 'ffmpeg')).toStrictEqual(['-metadata', '', 'x'])
  })

  it('drops the name of the program at the start', () => {
    expect(commandLineWords('ffmpeg -i x.mp4', 'ffmpeg')).toStrictEqual(['-i', 'x.mp4'])
    expect(commandLineWords('ffprobe x.mp4', 'ffprobe')).toStrictEqual(['x.mp4'])
  })

  it('refuses the name of the other program, and points to its subcommand', () => {
    expect(refusal(() => commandLineWords('ffprobe -show_format x.mp4', 'ffmpeg'))).toContain('Call the ffprobe subcommand of the video tool')
    expect(refusal(() => commandLineWords('ffmpeg -i x.mp4 y.mp4', 'ffprobe'))).toContain('Call the ffmpeg subcommand of the video tool')
  })

  it.each([['-i "x.mp4 out.mp4', 'double quote'], ['-metadata title=\'My clip out.mp4', 'single quote']])('refuses %j, whose quote does not close', (text, quote) => {
    expect(refusal(() => commandLineWords(text, 'ffmpeg'))).toContain(`a ${quote} that does not close`)
  })

  it.each(['', ' \n', 'ffmpeg'])('refuses the blank text %j', (text) => {
    expect(refusal(() => commandLineWords(text, 'ffmpeg'))).toContain('`arguments` is blank')
  })

  it.each(['&&', '||', '|', ';', '&', '>', '2>&1', '>log.txt', '<in.txt'])('refuses the shell word %j', (word) => {
    const text = refusal(() => commandLineWords(`-i x.mp4 out.mp4 ${word} out.txt`, 'ffmpeg'))

    expect(text).toContain(JSON.stringify(word))
    expect(text).toContain('with no shell')
  })

  it('takes a shell char inside a word as text of the program', () => {
    expect(commandLineWords('-af "pan=stereo|c0<c0+c2|c1<c1+c3" out.wav', 'ffmpeg')).toStrictEqual(['-af', 'pan=stereo|c0<c0+c2|c1<c1+c3', 'out.wav'])
  })
})

describe('ffmpegCall', () => {
  it('puts the arguments of Dez first, and the name of each copy in place of its @id', () => {
    const call = ffmpegCall({ arguments: '-i @c -i @b -map 0:v -map 1:a out.mp4' }, CONVERSATION)

    expect(call.args).toStrictEqual(['-nostdin', '-hide_banner', '-v', 'warning', '-stats', '-i', 'c.webm', '-i', 'b.wav', '-map', '0:v', '-map', '1:a', 'out.mp4'])
    expect(call.inputs).toStrictEqual([
      { kind: 'video', id: 'c', name: 'c.webm', clip: { kind: 'video', id: 'c', type: 'video/webm', src: FILM.src, url: null, expires: null } },
      { kind: 'audio', id: 'b', name: 'b.wav', clip: { kind: 'audio', id: 'b', type: 'audio/wav', src: SONG.src, url: null, expires: null } },
    ])
    expect(call.nullOutput).toBe(false)
  })

  it('gives an input that the arguments name more than once as one file, also inside a word', () => {
    const call = ffmpegCall({ arguments: '-i @c -filter_complex "movie=@d[logo];[0:v][logo]overlay,movie=@c[x]" -i @d out.mp4' }, CONVERSATION)

    expect(call.args.slice(FFMPEG_FIXED_ARGS.length)).toStrictEqual(['-i', 'c.webm', '-filter_complex', 'movie=d.webm[logo];[0:v][logo]overlay,movie=c.webm[x]', '-i', 'd.webm', 'out.mp4'])
    expect(call.inputs.map(({ id }) => id)).toStrictEqual(['c', 'd'])
  })

  it('names a clip by its media type, and a clip of an unknown type as .bin', () => {
    const odd = mediaTagText({ kind: 'video', id: 'a', type: 'video/x-matroska', src: null, url: 'https://clips.example/one', expires: null, other: [] })

    expect(ffmpegCall({ arguments: '-i @d out.mp4' }, CONVERSATION).inputs[0].name).toBe('d.webm')
    expect(ffmpegCall({ arguments: '-i @a out.mp4' }, [reply('a1', odd)]).inputs[0].name).toBe('a.bin')
  })

  it('gives a JPEG image as its file, and a PNG image as a JPEG copy', () => {
    const { inputs } = ffmpegCall({ arguments: '-i @a -i @e out.mp4' }, CONVERSATION)

    expect(inputs).toStrictEqual([
      { kind: 'image', id: 'a', name: 'a.jpg', path: RED, jpegCopy: false },
      { kind: 'image', id: 'e', name: 'e.jpg', path: SKY, jpegCopy: true },
    ])
    expect(videoInputsText(inputs)).toBe('The inputs of the run: the image @a as a.jpg, the image @e as e.jpg (a JPEG copy, with white in place of transparent pixels).')
  })

  it('tells that a run has no input', () => {
    const { inputs } = ffmpegCall({ arguments: '-f lavfi -i sine=frequency=440:duration=1 tone.wav' }, CONVERSATION)

    expect(videoInputsText(inputs)).toBe('The run has no input image and no input clip.')
  })

  it('knows a run with the null format', () => {
    expect(ffmpegCall({ arguments: '-v info -i @b -af volumedetect -f null -' }, CONVERSATION).nullOutput).toBe(true)
    expect(ffmpegCall({ arguments: '-i @b -af volumedetect -f:a null -' }, CONVERSATION).nullOutput).toBe(true)
  })

  it('takes a time limit of the call', () => {
    expect(ffmpegCall({ arguments: '-i @c out.mp4', timeout_seconds: 30 }, CONVERSATION).timeoutMs).toBe(30_000)
    expect(refusal(() => ffmpegCall({ arguments: '-i @c out.mp4', timeout_seconds: 5 }, CONVERSATION))).toContain('10 to 3600')
  })

  it.each([
    '-i @c -vf scale=iw/2:ih/2 out.mp4',
    '-i @c -vf "scale=iw / 2:ih / 2" out.mp4',
    '-i @c -r 30000/1001 -aspect 16/9 out.mp4',
    '-i @c -vf "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setpts=PTS/2" ./out.mp4',
    '-i @c -force_key_frames "expr:gte(t,n_forced*2)" out.mp4',
    '-ss 00:00:05 -i @c -map 0:v -c:v libx264 out.mp4',
    '-i @c -codec:data copy out.mov',
    '-i @c -vf "fade=t=in:st=0:d=1" out.mp4',
    '-f lavfi -i "color=c=black:s=1280x720:d=5" out.mp4',
    '-i @b -af aresample=async=1 out.wav',
    '-rtsp_transport tcp -i @c out.mp4',
    '-i @c -i @d -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" -map "[v]" out.mp4',
    '-i @c -i @d -filter_complex "xfade=transition=fade:duration=1:offset=4" out.mp4',
    '-f concat -i list.txt -c copy out.mp4',
    '-i @c -movflags +faststart out.mp4',
    '-i @c -f segment -segment_time 5 -reset_timestamps 1 part%03d.mp4',
    '-f lavfi -i "amovie=@b:wav:si=0" out.wav',
    '-i @c -metadata artist="Jack White" -metadata title=wait... out.mp4',
    '-i @c -c:v h264_v4l2m2m out.mp4',
    '-i @c -vf "select=\'eq(n,0)\'" -frames:v 1 frame.jpg',
    '-y -i @c -f null -',
    '-i @b -af volumedetect -f:a null -',
    '-i @c frame_%03d.jpg',
  ])('runs %j', (text) => {
    expect(() => ffmpegCall({ arguments: text }, CONVERSATION)).not.toThrow()
  })

  it.each([
    ['-i /etc/passwd out.mp4', '/etc/passwd', 'an absolute path'],
    ['-i @c /tmp/out.mp4', '/tmp/out.mp4', 'an absolute path'],
    ['-i @c -vf movie=/etc/x.mp4 out.mp4', 'movie=/etc/x.mp4', 'an absolute path'],
    ['-i @c -vf "movie=\'/etc/x.mp4\'" out.mp4', 'movie=\'/etc/x.mp4\'', 'an absolute path'],
    ['-i @c -vf "scale=iw /2:-2" out.mp4', 'scale=iw /2:-2', 'with no space before the "/"'],
    ['-i @c -f null /dev/null', '/dev/null', 'end the arguments with -f null -'],
    ['-i ../x.mp4 out.mp4', '../x.mp4', 'a parent folder'],
    ['-i @c sub/../../out.mp4', 'sub/../../out.mp4', 'a parent folder'],
    ['-i .. out.mp4', '..', 'a parent folder'],
    ['-i ~/x.mp4 out.mp4', '~/x.mp4', 'it holds "~"'],
    ['-i https://example.com/x.mp4 out.mp4', 'https://example.com/x.mp4', 'it holds a URL'],
    ['-i http:example.com/x.mp4 out.mp4', 'http:example.com/x.mp4', 'the protocol form "http"'],
    ['-i "ht\'t\'p:example.com/x.mp4" out.mp4', 'ht\'t\'p:example.com/x.mp4', 'the protocol form "http"'],
    ['-i file:@c out.mp4', 'file:@c', 'the protocol form "file"'],
    ['-i FILE:x.mp4 out.mp4', 'FILE:x.mp4', 'the protocol form "file"'],
    ['-i "concat:@c|@d" -c copy out.mp4', 'concat:@c|@d', 'use the join_clips subcommand or the concat filter'],
    ['-i crypto+file:x.mp4 out.mp4', 'crypto+file:x.mp4', 'the protocol form "crypto"'],
    ['-i subfile,,start,0,end,9,,:@c out.mp4', 'subfile,,start,0,end,9,,:@c', 'the protocol form "subfile"'],
    ['-i @c -f mpegts pipe:1', 'pipe:1', 'the protocol form "pipe"'],
    ['-i @c -vf movie=tcp:host:9 out.mp4', 'movie=tcp:host:9', 'the protocol form "tcp"'],
    ['-i @c -f mpegts -', '-', 'the standard input or output'],
    ['-i - out.mp4', '-', 'the standard input or output'],
    ['-f alsa -i default out.wav', 'alsa', 'the device alsa'],
    ['-f AVFoundation -i 0:0 out.mp4', 'AVFoundation', 'the device avfoundation'],
    ['-f lavfi -i amovie=default:f=pulse out.wav', 'amovie=default:f=pulse', 'the device pulse'],
    ['-i @c -f tee "[f=alsa]default|out.mp4"', '[f=alsa]default|out.mp4', 'the device alsa'],
    ['-f:v fbdev -i "" out.mp4', 'fbdev', 'the device fbdev'],
    ['-f lavfi -i "amovie=default:pulse" out.wav', 'amovie=default:pulse', 'the device pulse'],
    ['-f lavfi -i "movie=\'0,1\':AVFoundation" out.mp4', 'movie=\'0,1\':AVFoundation', 'the device avfoundation'],
    ['-f concat -safe 0 -i list.txt out.mp4', '-safe', 'the option safe'],
    ['-protocol_whitelist file,crypto -i @c out.mp4', '-protocol_whitelist', 'the option protocol_whitelist'],
    ['-i @c -filter_complex_script graph.txt out.mp4', '-filter_complex_script', 'the option filter_complex_script'],
    ['-i @c -filter_script:v graph.txt out.mp4', '-filter_script:v', 'the option filter_script'],
    ['-dump_attachment:t "" -i @c', '-dump_attachment:t', 'the option dump_attachment'],
    ['-f lavfi -i movie=list.txt:format_opts=safe=0:f=concat out.mp4', 'movie=list.txt:format_opts=safe=0:f=concat', 'the option safe'],
    ['-f lavfi -graph_file @c -i x out.wav', '-graph_file', 'the option graph_file'],
    ['-i @c -hls_key_info_file @d out.mp4', '-hls_key_info_file', 'the option hls_key_info_file'],
    ['-f hls -i @c -c copy out.mkv', 'hls', 'the hls format or an .m3u8 file'],
    ['-f HLS -i @c -i @d out.mkv', 'HLS', 'the hls format or an .m3u8 file'],
    ['-i @c -f hls -hls_flags delete_segments+append_list @c', 'hls', 'the hls format or an .m3u8 file'],
    ['-i @c -map 0 -f fifo -fifo_format hls -format_opts hls_flags=delete_segments+append_list @c', 'hls', 'the hls format or an .m3u8 file'],
    ['-i @c -map 0 -f tee "[f=fifo:fifo_format=hls]@c"', '[f=fifo:fifo_format=hls]@c', 'the hls format or an .m3u8 file'],
    ['-i @c -hls_flags delete_segments+append_list out.m3u8', 'out.m3u8', 'the hls format or an .m3u8 file'],
    ['-f lavfi -i "amovie=@c:f=hls" out.wav', 'amovie=@c:f=hls', 'the hls format or an .m3u8 file'],
    ['-f lavfi -i "movie=@c:format_name=h\'l\'s" out.mp4', 'movie=@c:format_name=h\'l\'s', 'the hls format or an .m3u8 file'],
    ['-f:v hls -i @c -c copy out.mkv', 'hls', 'the hls format or an .m3u8 file'],
    ['-f lavfi -i "amovie=@c:hls" out.wav', 'amovie=@c:hls', 'the hls format or an .m3u8 file'],
    ['-f lavfi -i "amovie = @c : hls " out.wav', 'amovie = @c : hls ', 'the hls format or an .m3u8 file'],
    ['-f lavfi -i "amovie@q=@c:hls" out.wav', 'amovie@q=@c:hls', 'the hls format or an .m3u8 file'],
    ['-f lavfi -i "amovie=x y=z:hls" out.wav', 'amovie=x y=z:hls', 'the hls format or an .m3u8 file'],
    ['-f lavfi -i "amo\'v\'ie@\'x,y\'=@c:hls" out.wav', 'amo\'v\'ie@\'x,y\'=@c:hls', 'the hls format or an .m3u8 file'],
    ['-/filter_complex graph.txt -i @c out.mp4', '-/filter_complex', 'reads its value from a file'],
    ['-i @c -vf "drawbox=x=10\\:y=2" out.mp4', 'drawbox=x=10\\:y=2', 'a backslash'],
  ])('refuses %j', (text, word, cause) => {
    const message = refusal(() => ffmpegCall({ arguments: text }, CONVERSATION))

    expect(message).toContain(`Dez refuses ${JSON.stringify(word)} in \`arguments\``)
    expect(message).toContain(cause)
    expect(message).toContain('Dez started no job.')
  })

  it('does not take the id of an input for a protocol or a device', () => {
    // Ids that a hand edit gave: `fd` is a protocol, and `oss` a device.
    const sections = [reply('a1', [
      mediaTagText({ ...SONG, id: 'fd' }),
      mediaTagText({ ...SONG, id: 'oss' }),
    ].join('\n'))]

    expect(ffmpegWords('-f lavfi -i "amovie=@fd:loop=0,amovie=f=@oss" out.wav', sections)).toStrictEqual(['-f', 'lavfi', '-i', 'amovie=fd.wav:loop=0,amovie=f=oss.wav', 'out.wav'])
  })

  it('refuses an @id that names nothing, and lists the images and the clips by their ids only', () => {
    const message = refusal(() => ffmpegCall({ arguments: '-i @z out.mp4' }, CONVERSATION))

    expect(message).toContain('@z names no image and no clip of this conversation')
    expect(message).toContain('Dez started no job.')
    expect(message).toContain('the image @a, the image @e, the audio clip @b, the video clip @c, the video clip @d')
    expect(message).not.toContain('/home')
  })

  it('takes a long @ word as text', () => {
    expect(ffmpegWords('-i @c -metadata artist=@someone out.mp4')).toStrictEqual(['-i', 'c.webm', '-metadata', 'artist=@someone', 'out.mp4'])
  })

  it('refuses a bad argument before an unknown id', () => {
    expect(refusal(() => ffmpegCall({ arguments: '-i @z /etc/out.mp4' }, CONVERSATION))).toContain('an absolute path')
  })
})

describe('ffprobeCall', () => {
  it('puts its own arguments first, and has the rules of an ffmpeg call', () => {
    expect(ffprobeCall({ arguments: 'ffprobe -v error -show_format -of json @c' }, CONVERSATION)).toStrictEqual({
      args: ['-hide_banner', '-v', 'error', '-show_format', '-of', 'json', 'c.webm'],
      inputs: [{ kind: 'video', id: 'c', name: 'c.webm', clip: { kind: 'video', id: 'c', type: 'video/webm', src: FILM.src, url: null, expires: null } }],
    })
    expect(ffprobeCall({ arguments: '-encoders' }, CONVERSATION)).toStrictEqual({ args: ['-hide_banner', '-encoders'], inputs: [] })
  })

  it.each([
    ['-show_format /etc/passwd', 'an absolute path'],
    ['-f hls @c', 'the hls format or an .m3u8 file'],
    ['-f:v hls @c', 'the hls format or an .m3u8 file'],
    ['-show_format @z', '@z names no image and no clip'],
  ])('tells that ffprobe did not run for %j', (text, cause) => {
    const message = refusal(() => ffprobeCall({ arguments: text }, CONVERSATION))

    expect(message).toContain(cause)
    expect(message).toContain('Dez did not run ffprobe.')
  })
})

describe('joinClipsCall', () => {
  it('gives the clips in the order of the call, and each one once as a file', () => {
    const { clips, inputs } = joinClipsCall({ clips: '@c @d @c' }, CONVERSATION)

    expect(clips.map(({ name }) => name)).toStrictEqual(['c.webm', 'd.webm', 'c.webm'])
    expect(inputs.map(({ id }) => id)).toStrictEqual(['c', 'd'])
  })

  it('takes ids with no @ and with commas', () => {
    expect(joinClipsCall({ clips: 'd, c' }, CONVERSATION).clips.map(({ id }) => id)).toStrictEqual(['d', 'c'])
  })

  it.each([
    ['@c', 'names one clip, and a join needs two or more video clips'],
    [' ', 'names no clip, and a join needs two or more video clips'],
    ['@c @d.webm', '"@d.webm", which is no id of a clip'],
    ['@c @a', '@a is an image'],
    ['@c @b', '@b is an audio clip'],
    ['@c @z', 'No video clip of this conversation has the id @z. Its video clips are @c, @d'],
  ])('refuses the clips %j', (clips, cause) => {
    const message = refusal(() => joinClipsCall({ clips }, CONVERSATION))

    expect(message).toContain(cause)
    expect(message).toContain('Dez started no job.')
    expect(message).not.toContain('/home')
  })

  it('tells that a conversation has no video clip', () => {
    expect(refusal(() => joinClipsCall({ clips: '@c @d' }, [user('u1', 'Join them.')]))).toContain('This conversation has no video clips')
  })

  it('refuses a bad time limit, and tells its own default', () => {
    const message = refusal(() => joinClipsCall({ clips: '@c @d', timeout_seconds: 4000 }, CONVERSATION))

    expect(message).toContain('10 to 3600')
    expect(message).toContain('10 minutes')
  })
})

function factsOf(streams: object[], format?: object): ClipFacts {
  const facts = clipFacts(probeOutput(streams, format))
  if (!facts) throw new Error('The probe output gave no facts.')
  return facts
}

describe('clipFacts', () => {
  it('reads the size, the frame rate, the sound, and the length of a clip', () => {
    expect(factsOf([VP9, OPUS])).toMatchObject({ width: 48, height: 36, frameRate: '5/1', hasAudio: true, duration: 2 })
    expect(factsOf([VP9], { format_name: 'matroska,webm' })).toMatchObject({ hasAudio: false, duration: null })
  })

  it('gives clips with the same streams one signature, whatever their length', () => {
    expect(factsOf([VP9, OPUS], { ...WEBM, duration: '9.5' }).signature).toBe(factsOf([VP9, OPUS]).signature)
  })

  it.each([
    ['another size', [{ ...VP9, width: 64 }, OPUS], WEBM],
    ['another codec', [{ ...VP9, codec_name: 'vp8' }, OPUS], WEBM],
    ['another frame rate', [{ ...VP9, r_frame_rate: '30/1' }, OPUS], WEBM],
    ['other codec setup data', [VP9, { ...OPUS, extradata_hash: 'MD5:20' }], WEBM],
    ['another sound format', [VP9, { ...OPUS, channels: 2, channel_layout: 'stereo' }], WEBM],
    ['no sound', [VP9], WEBM],
    ['another stream order', [{ ...OPUS, index: 0 }, { ...VP9, index: 1 }], WEBM],
    ['a rotation', [{ ...VP9, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }, OPUS], WEBM],
    ['another container', [VP9, OPUS], { ...WEBM, format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }],
  ])('gives a clip with %s another signature', (_, streams, format) => {
    expect(factsOf(streams, format).signature).not.toBe(factsOf([VP9, OPUS]).signature)
  })

  it('gives the size of a turned clip as a player shows it', () => {
    expect(factsOf([{ ...VP9, side_data_list: [{ rotation: -90 }] }])).toMatchObject({ width: 36, height: 48 })
    expect(factsOf([{ ...VP9, side_data_list: [{ rotation: 180 }] }])).toMatchObject({ width: 48, height: 36 })
  })

  it.each([
    [{ avg_frame_rate: '0/0', r_frame_rate: '30000/1001' }, '30000/1001'],
    [{ avg_frame_rate: '0/0', r_frame_rate: '1000/1' }, ''],
    [{ avg_frame_rate: '25/1,movie=x', r_frame_rate: '25' }, ''],
    [{ avg_frame_rate: '5/0', r_frame_rate: undefined }, ''],
  ])('takes only a frame rate that a clip can have: %j', (rates, frameRate) => {
    expect(factsOf([{ ...VP9, ...rates }]).frameRate).toBe(frameRate)
  })

  it.each([
    ['an empty object', '{}'],
    ['no JSON', 'c.mp4: Invalid data found when processing input'],
    ['only sound', probeOutput([OPUS])],
    ['a size that is no number', probeOutput([{ ...VP9, width: '48' }])],
    ['a size of 0', probeOutput([{ ...VP9, height: 0 }])],
    ['streams that are no list', JSON.stringify({ streams: 'none', format: WEBM })],
  ])('gives no facts for %s', (_, output) => {
    expect(clipFacts(output)).toBeNull()
  })

  it('asks ffprobe for the facts as JSON, of the copy of the clip', () => {
    const args = joinProbeArgs('c.mp4')

    expect(args.at(-1)).toBe('c.mp4')
    expect(args).toEqual(expect.arrayContaining(['-of', 'json', '-show_data_hash']))
  })
})

describe('joinPlan', () => {
  const facts = factsOf([VP9])
  const withSound = factsOf([{ ...VP9, width: 64, height: 48 }, OPUS], { ...WEBM, duration: '4.0' })

  it('copies the streams of clips that match, from a list file', () => {
    expect(joinPlan([{ name: 'c.webm', facts }, { name: 'd.webm', facts }, { name: 'c.webm', facts }])).toStrictEqual({
      kind: 'copy',
      list: { name: 'list.txt', text: 'ffconcat version 1.0\nfile \'c.webm\'\nfile \'d.webm\'\nfile \'c.webm\'\n' },
      args: [...FFMPEG_FIXED_ARGS, '-f', 'concat', '-i', 'list.txt', '-c', 'copy', 'joined.webm'],
      output: 'joined.webm',
    })
  })

  it('puts the index of a copied MP4 file at its start', () => {
    const plan = joinPlan([{ name: 'c.mp4', facts }, { name: 'd.mp4', facts }])

    expect(plan.args.slice(-5)).toStrictEqual(['-c', 'copy', '-movflags', '+faststart', 'joined.mp4'])
  })

  it('encodes clips of a type that takes no copy', () => {
    expect(joinPlan([{ name: 'c.bin', facts }, { name: 'd.bin', facts }]).kind).toBe('encode')
  })

  it('encodes clips that differ as WebM when the first clip is one, with silence for a clip with no sound', () => {
    const picture = (index: number) => `[${index}:v:0]scale=48:36:force_original_aspect_ratio=decrease,pad=48:36:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=5/1,format=yuv420p[v${index}]`

    expect(joinPlan([{ name: 'c.webm', facts }, { name: 'd.mp4', facts: withSound }])).toStrictEqual({
      kind: 'encode',
      args: [
        ...FFMPEG_FIXED_ARGS,
        '-i', 'c.webm', '-i', 'd.mp4',
        '-filter_complex', [
          picture(0),
          'anullsrc=r=48000:cl=stereo,atrim=duration=2.000[a0]',
          picture(1),
          '[1:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a1]',
          '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
        ].join(';'),
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus',
        'joined.webm',
      ],
      output: 'joined.webm',
      format: 'WebM (VP9, Opus)',
      width: 48,
      height: 36,
      hasAudio: true,
    })
  })

  it('encodes clips with no sound as MP4, at an even size and 30 frames a second when the first clip tells no rate', () => {
    const odd = factsOf([{ ...VP9, width: 49, height: 37, avg_frame_rate: '0/0', r_frame_rate: '0/0' }])
    const plan = joinPlan([{ name: 'c.mp4', facts: odd }, { name: 'd.webm', facts }])
    const picture = (index: number) => `[${index}:v:0]scale=48:36:force_original_aspect_ratio=decrease,pad=48:36:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}]`

    expect(plan).toMatchObject({ kind: 'encode', output: 'joined.mp4', format: 'MP4 (H.264)', width: 48, height: 36, hasAudio: false })
    expect(plan.args.slice(FFMPEG_FIXED_ARGS.length)).toStrictEqual([
      '-i', 'c.mp4', '-i', 'd.webm',
      '-filter_complex', `${picture(0)};${picture(1)};[v0][v1]concat=n=2:v=1:a=0[v]`,
      '-map', '[v]',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart',
      'joined.mp4',
    ])
  })

  it('gives a clip with no sound and no known length a start of silence', () => {
    const noLength = factsOf([VP9], { format_name: 'matroska,webm' })
    const plan = joinPlan([{ name: 'c.mp4', facts: withSound }, { name: 'd.webm', facts: noLength }])

    expect(plan.args.join(' ')).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=0.100[a1]')
  })
})

describe('outputFiles', () => {
  it('keeps the new files of a type that Dez stores, in the order of their names', () => {
    const files = [
      { name: 'c.mp4', size: 900 },
      { name: 'out.mp4', size: 500 },
      { name: 'frame_10.jpg', size: 30 },
      { name: 'frame_2.jpg', size: 30 },
      { name: 'clip.MOV', size: 70 },
      { name: 'pic.jpeg', size: 20 },
      { name: 'tone.opus', size: 20 },
    ]

    expect(outputFiles(files, new Set(['c.mp4']))).toStrictEqual({
      kept: [
        { name: 'clip.MOV', kind: 'video', type: 'video/quicktime', extension: 'mov' },
        { name: 'frame_2.jpg', kind: 'image', type: 'image/jpeg', extension: 'jpg' },
        { name: 'frame_10.jpg', kind: 'image', type: 'image/jpeg', extension: 'jpg' },
        { name: 'out.mp4', kind: 'video', type: 'video/mp4', extension: 'mp4' },
        { name: 'pic.jpeg', kind: 'image', type: 'image/jpeg', extension: 'jpg' },
        { name: 'tone.opus', kind: 'audio', type: 'audio/opus', extension: 'opus' },
      ],
      notKept: [],
    })
  })

  it('does not keep a file of another type, an empty file, and a file that is too large, and tells why', () => {
    const files = [
      { name: 'notes.txt', size: 4 },
      { name: 'graph.svg', size: 4 },
      { name: 'ffmpeg2pass-0', size: 4 },
      { name: 'empty.wav', size: 0 },
      { name: 'big.webm', size: MAX_SAVED_CLIP_BYTES + 1 },
      { name: 'most.webm', size: MAX_SAVED_CLIP_BYTES },
    ]
    const { kept, notKept } = outputFiles(files, new Set())

    expect(kept.map(({ name }) => name)).toStrictEqual(['most.webm'])
    expect(notKept).toHaveLength(5)
    expect(notKept).toEqual(expect.arrayContaining([
      'notes.txt (Dez stores no file of its type)',
      'graph.svg (Dez stores no file of its type)',
      'ffmpeg2pass-0 (Dez stores no file of its type)',
      'empty.wav (it is empty)',
    ]))
    expect(notKept.find((text) => text.startsWith('big.webm'))).toContain('it is larger than')
  })
})

const PROGRESS_START = 'frame=    5 fps=0.0 q=0.0 size=       0KiB time=00:00:01.00 bitrate=   0.4kbits/s speed=1.9x    '
const PROGRESS_END = 'frame=   10 fps=9.8 q=-0.0 Lsize=      12KiB time=00:00:02.00 bitrate=  49.1kbits/s speed=1.96x    '

function logOf(...pieces: string[]): ProgramLog {
  const log = new ProgramLog()
  for (const piece of pieces) log.add(piece)
  return log
}

describe('ProgramLog', () => {
  it('joins the pieces of a line, and keeps only the last progress line', () => {
    const log = logOf('[vp9 @ 0x1] a warn', `ing\n${PROGRESS_START}\r`, `${PROGRESS_END}\n[out#0] done\n`)

    expect(log.progress).toBe('frame=10 fps=9.8 q=-0.0 Lsize=12KiB time=00:00:02.00 bitrate=49.1kbits/s speed=1.96x')
    expect(log.end(4000)).toBe(`[vp9 @ 0x1] a warning\n[out#0] done\n${log.progress}`)
  })

  it('gives the progress of a run that is not done', () => {
    const log = logOf(`${PROGRESS_START}\r${PROGRESS_END}`)

    expect(log.progress).toBe('frame=5 fps=0.0 q=0.0 size=0KiB time=00:00:01.00 bitrate=0.4kbits/s speed=1.9x')
    expect(ffmpegStateText(log.progress)).toContain('frame=5 ')
    expect(ffmpegStateText('')).toBe('ffmpeg runs.')
  })

  it('takes the progress of a run with no picture', () => {
    expect(logOf('size=     256KiB time=00:00:10.00 bitrate= 209.7kbits/s speed= 512x    \r').progress).toBe('size=256KiB time=00:00:10.00 bitrate=209.7kbits/s speed=512x')
  })

  it('counts a last line with no line end, and gives the same end twice', () => {
    const log = logOf('one\ntwo')

    expect(log.end(4000)).toBe('one\ntwo')
    expect(log.end(4000)).toBe('one\ntwo')
  })

  it('cuts a long log at the start of a line', () => {
    const log = logOf(Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join(''))

    expect(log.end(30)).toBe('…\nline 97\nline 98\nline 99')
  })

  it('keeps only the end of a log of any size', () => {
    const log = new ProgramLog()
    for (let index = 0; index < 5000; index++) log.add(`a line of the log with the number ${index}\n`)
    log.add('x'.repeat(1_000_000))

    expect(log.end(4000).length).toBeLessThanOrEqual(4001)
    expect(log.end(1_000_000).length).toBeLessThan(20_000)
    expect(log.end(1_000_000)).toContain('the number 4999')
  })

  it('is blank for a run that wrote nothing', () => {
    expect(logOf('', '\n\r\n').end(4000)).toBe('')
  })
})

function outputOf(...pieces: string[]): OutputStart {
  const output = new OutputStart()
  for (const piece of pieces) output.add(piece)
  return output
}

describe('OutputStart', () => {
  it('keeps the first characters of an output, and tells of a cut', () => {
    const whole = outputOf('abc', 'def')
    const cut = outputOf('a'.repeat(PROGRAM_OUTPUT_CAP - 1), 'bc', 'd')

    expect([whole.text, whole.cut]).toStrictEqual(['abcdef', false])
    expect([cut.text, cut.cut]).toStrictEqual([`${'a'.repeat(PROGRAM_OUTPUT_CAP - 1)}b`, true])
  })
})

const NO_FILES: OutputFiles = { kept: [], notKept: [] }
const ENDED = { kind: 'exited', code: 0 } as const

describe('ffmpegRunResult', () => {
  const log = () => logOf('[warn] one\n', `${PROGRESS_END}\n`)

  it('names the kept files in the order of their ids, and the files that Dez did not keep', () => {
    const files: OutputFiles = {
      kept: [
        { name: 'frame.jpg', kind: 'image', type: 'image/jpeg', extension: 'jpg' },
        { name: 'out.mp4', kind: 'video', type: 'video/mp4', extension: 'mp4' },
      ],
      notKept: ['notes.txt (Dez stores no file of its type)'],
    }
    const { text, isError } = ffmpegRunResult({ nullOutput: false }, ENDED, files, log(), outputOf())

    expect(isError).toBe(false)
    expect(text).toContain('made 2 files that Dez keeps: frame.jpg (image), out.mp4 (video clip). The lines at the end give their ids in this order. '
      + 'Dez did not keep notes.txt (Dez stores no file of its type).')
    expect(text).toContain('The end of the log of ffmpeg:\n[warn] one\nframe=10 ')
  })

  it('tells of one kept file', () => {
    const files: OutputFiles = { kept: [{ name: 'out.wav', kind: 'audio', type: 'audio/wav', extension: 'wav' }], notKept: [] }
    const { text } = ffmpegRunResult({ nullOutput: false }, ENDED, files, logOf(), outputOf())

    expect(text).toBe('ffmpeg ended with no error and made 1 file that Dez keeps: out.wav (audio clip). The line at the end gives its id.\nffmpeg wrote no log.')
  })

  it('gives the log of a run that failed, as an error', () => {
    const { text, isError } = ffmpegRunResult({ nullOutput: false }, { kind: 'exited', code: 254 }, NO_FILES, logOf('c.mp4.mp4: No such file or directory\n'), outputOf())

    expect(isError).toBe(true)
    expect(text).toContain('ffmpeg ended with the error code 254, and Dez kept no file.')
    expect(text).toContain('holds only the inputs that the call names as @id')
    expect(text).toContain('c.mp4.mp4: No such file or directory')
  })

  it('tells that a run that the system ended is not a fault of the call', () => {
    const { text, isError } = ffmpegRunResult({ nullOutput: false }, { kind: 'exited', code: null }, NO_FILES, log(), outputOf())

    expect(isError).toBe(true)
    expect(text).toContain('The system ended ffmpeg')
    expect(text).toContain('This is not a fault of the call.')
  })

  it('tells how to get less output after a run that wrote too much', () => {
    const { text, isError } = ffmpegRunResult({ nullOutput: false }, { kind: 'outputTooLarge' }, NO_FILES, log(), outputOf())

    expect(isError).toBe(true)
    expect(text).toContain('-v error')
  })

  it('keeps no file of a run that made more files than one call can have', () => {
    const kept = Array.from({ length: MAX_VIDEO_OUTPUT_FILES + 1 }, (_, index) => ({ name: `f${index}.jpg`, kind: 'image' as const, type: 'image/jpeg', extension: 'jpg' }))
    const { text, isError } = ffmpegRunResult({ nullOutput: false }, ENDED, { kept, notKept: [] }, log(), outputOf())

    expect(isError).toBe(true)
    expect(text).toContain(`made ${MAX_VIDEO_OUTPUT_FILES + 1} files that Dez stores, and Dez keeps at most ${MAX_VIDEO_OUTPUT_FILES}`)
  })

  it('gives what a run with no file printed, with a note for a cut', () => {
    const list = ffmpegRunResult({ nullOutput: false }, ENDED, NO_FILES, logOf(), outputOf(' V..... libx264\n'))
    const long = ffmpegRunResult({ nullOutput: false }, ENDED, NO_FILES, logOf(), outputOf('x'.repeat(PROGRAM_OUTPUT_CAP + 1)))

    expect(list).toStrictEqual({ text: 'ffmpeg ended with no error and made no file. Its output:\nV..... libx264', isError: false })
    expect(long.text).toContain(`This is its first ${PROGRAM_OUTPUT_CAP} characters.`)
  })

  it('takes a run with the null format and no file as done', () => {
    const { text, isError } = ffmpegRunResult({ nullOutput: true }, ENDED, NO_FILES, logOf('[Parsed_volumedetect_0 @ 0x1] mean_volume: -9.0 dB\n'), outputOf())

    expect(isError).toBe(false)
    expect(text).toContain('It made no file, as the call asked for with -f null.')
    expect(text).toContain('mean_volume: -9.0 dB')
  })

  it('tells how to name an output after a run that made no file that Dez keeps', () => {
    const { text, isError } = ffmpegRunResult({ nullOutput: false }, ENDED, { kept: [], notKept: ['out.mkv (Dez stores no file of its type)'] }, log(), outputOf())

    expect(isError).toBe(true)
    expect(text).toContain('it made no new file that Dez keeps. Dez did not keep out.mkv (Dez stores no file of its type).')
    expect(text).toContain('.mp4, .webm, .mov')
    expect(text).toContain('.jpg, .gif')
  })
})

describe('joinRunResult', () => {
  const copy: JoinPlan = { kind: 'copy', list: { name: 'list.txt', text: '' }, args: [], output: 'joined.webm' }
  const encode: JoinPlan = { kind: 'encode', args: [], output: 'joined.mp4', format: 'MP4 (H.264, AAC)', width: 1280, height: 720, hasAudio: true }

  it('tells that a copy made no new encode', () => {
    expect(joinRunResult(copy, 3, ENDED, true, logOf())).toStrictEqual({ text: 'Joined the 3 clips into one clip with no new encode: their streams match.', isError: false })
  })

  it('tells the format of a new encode, and why Dez made one', () => {
    const { text, isError } = joinRunResult(encode, 2, ENDED, true, logOf())

    expect(isError).toBe(false)
    expect(text).toContain('Joined the 2 clips into one 1280x720 MP4 (H.264, AAC) clip.')
    expect(text).toContain('their streams do not match')
    expect(text).toContain('A clip with no sound has silence in the new clip.')
    expect(joinRunResult({ ...encode, hasAudio: false }, 2, ENDED, true, logOf()).text).not.toContain('silence')
  })

  it('gives the log of a join that failed, or that made no clip, as an error', () => {
    const failed = joinRunResult(encode, 2, { kind: 'exited', code: 8 }, false, logOf('Error opening output files\n'))
    const empty = joinRunResult(copy, 2, ENDED, false, logOf('[warn] nothing\n'))

    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('Dez could not join the clips.')
    expect(failed.text).toContain('Error opening output files')
    expect(empty.isError).toBe(true)
    expect(empty.text).toContain('it made no clip that Dez can store')
    expect(empty.text).toContain('[warn] nothing')
  })

  // A join call has only its clips: Dez builds the ffmpeg arguments.
  it.each([
    [{ kind: 'exited', code: 8 }, 'call again without that clip. Else this is not a fault of the call: tell the user.'],
    [{ kind: 'outputTooLarge' }, 'This is not a fault of the call. Tell the user.'],
  ] as const)('tells a fix that a join call can make after a failed run: %j', (end, advice) => {
    const { text } = joinRunResult(copy, 2, end, false, logOf('[warn] one\n'))

    expect(text).toContain(advice)
    expect(text).not.toMatch(/argument|log level|-v /)
  })
})

describe('joinProbeFailedText', () => {
  it.each([
    [{ kind: 'exited', code: 1 }, 'error code 1'],
    [{ kind: 'exited', code: null }, 'the system ended it'],
    [{ kind: 'timedOut' }, 'it did not end within 60 seconds'],
    [{ kind: 'outputTooLarge' }, 'it wrote more than 1.0 MB of output'],
  ] as const)('tells how the ffprobe run of a clip that it could not read ended: %j', (end, text) => {
    const failed = joinProbeFailedText('c', end, ' c.mp4: Invalid data found when processing input\n')

    expect(failed).toContain(`ffprobe could not read the video clip @c (${text}), so Dez joined nothing`)
    expect(failed).toContain('This is not a fault of the call.')
    expect(failed.endsWith('\nThe output of ffprobe:\nc.mp4: Invalid data found when processing input')).toBe(true)
    expect(joinProbeFailedText('c', end, ' \n')).not.toContain('The output of ffprobe')
  })
})

describe('the ffprobe results', () => {
  it('gives the standard output, then the error output', () => {
    expect(ffprobeResultText([], outputOf('{ "format": {} }\n'), outputOf('Input #0, mov\n'))).toBe('{ "format": {} }\n\nInput #0, mov')
    expect(ffprobeResultText([], outputOf(), outputOf(' \n'))).toBe('ffprobe ended with no error and wrote nothing.')
  })

  it('tells of a cut and of a JPEG copy in the first lines', () => {
    const { inputs } = ffprobeCall({ arguments: '-show_frames @e @a' }, CONVERSATION)
    const text = ffprobeResultText(inputs, outputOf('x'.repeat(PROGRAM_OUTPUT_CAP)), outputOf('warn'))
    const lines = text.split('\n')

    expect(lines[0]).toContain(`this is the first ${PROGRAM_OUTPUT_CAP} characters`)
    expect(lines[0]).toContain('-show_entries')
    expect(lines[1]).toBe('The image @e went to ffprobe as a JPEG copy, with white in place of transparent pixels: the facts are those of the copy.')
    expect(lines[2]).toBe('x'.repeat(PROGRAM_OUTPUT_CAP))
    expect(lines).toHaveLength(3)
  })

  it('tells why a run failed, with what ffprobe wrote', () => {
    expect(ffprobeFailedText({ kind: 'exited', code: 1 }, outputOf('{}\n'), outputOf('c.mp4: Invalid data found when processing input\n')))
      .toContain('ffprobe ended with the error code 1.')
    expect(ffprobeFailedText({ kind: 'exited', code: 1 }, outputOf('{}\n'), outputOf('c.mp4: Invalid data\n'))).toContain('{}\n\nc.mp4: Invalid data')
    expect(ffprobeFailedText({ kind: 'exited', code: null }, outputOf(), outputOf())).toContain('This is not a fault of the call.')
    expect(ffprobeFailedText({ kind: 'timedOut' }, outputOf(), outputOf())).toContain('did not end within 60 seconds')
    expect(ffprobeFailedText({ kind: 'outputTooLarge' }, outputOf(), outputOf())).toContain('-show_entries')
  })
})
