// The text of a clip request (speech, music, video): the prompt, and the
// lyrics of a song. What a model takes is data on the model
// (`ModelInfo.text`), which a media format reads from the provider's model
// data (`ClipFormat.textRules` in mediaFormats.ts).

// What a model takes as the text of a request. A missing field: the
// provider does not tell it, and Dez does not check it.
export interface ClipTextRules {
  // The least and the most characters of the prompt.
  minPromptLength?: number
  maxPromptLength?: number
  // Present: the model takes lyrics, as a text of their own.
  lyrics?: {
    // true: the model makes no clip without lyrics.
    required: boolean
    // The most characters of the lyrics.
    maxLength?: number
  }
}

// The text of one request.
export interface ClipText {
  prompt: string
  // Never empty. Only for a model that takes lyrics.
  lyrics?: string
}

// A copy that shares no object with `rules`.
export function cloneClipTextRules(rules: ClipTextRules): ClipTextRules {
  return { ...rules, ...(rules.lyrics && { lyrics: { ...rules.lyrics } }) }
}

// A line that holds only `Lyrics:`, in any letter case.
const LYRICS_LINE = /^[ \t]*lyrics:[ \t]*\r?$/im

/** The prompt and the lyrics of a message `text`, for a model with `rules`.
 *  Lyrics are content, so they are in the message and not in a setting: for
 *  a model that takes lyrics, the first line that is only `Lyrics:` splits
 *  the message. The text before it is the prompt (the style of the song),
 *  and the text after it is the lyrics. With no such line, with nothing
 *  after it, and for a model that takes no lyrics, the message has no
 *  lyrics. */
export function clipText(rules: ClipTextRules | undefined, text: string): ClipText {
  const line = rules?.lyrics ? LYRICS_LINE.exec(text) : null
  if (!line) return { prompt: text }
  const lyrics = text.slice(line.index + line[0].length).trim()
  return { prompt: text.slice(0, line.index).trim(), ...(lyrics !== '' && { lyrics }) }
}

function characters(count: number): string {
  return count === 1 ? '1 character' : `${count} characters`
}

/** Why the model `modelName` with `rules` does not take `text`, as a
 *  sentence for the user; null when it takes it, as far as Dez knows. The
 *  check costs nothing, and its text is clearer than the provider's error.
 *  The lengths are in UTF-16 units, as the providers' own checks count. */
export function clipTextProblem(modelName: string, rules: ClipTextRules | undefined, { prompt, lyrics }: ClipText): string | null {
  if (!rules) return null
  if (rules.lyrics?.required && lyrics === undefined) {
    return `${modelName} needs lyrics. Write the style, then a line "Lyrics:", then the lyrics.`
  }
  // A message with lyrics is longer than its prompt, so the text tells
  // which part counts.
  const promptName = lyrics === undefined ? 'a prompt' : 'a prompt (the text before the "Lyrics:" line)'
  if (rules.minPromptLength !== undefined && prompt.length < rules.minPromptLength) {
    return `${modelName} needs ${promptName} of at least ${characters(rules.minPromptLength)}. This one has ${prompt.length}.`
  }
  if (rules.maxPromptLength !== undefined && prompt.length > rules.maxPromptLength) {
    return `${modelName} takes ${promptName} of at most ${characters(rules.maxPromptLength)}. This one has ${prompt.length}.`
  }
  const maxLyrics = rules.lyrics?.maxLength
  if (lyrics !== undefined && maxLyrics !== undefined && lyrics.length > maxLyrics) {
    return `${modelName} takes lyrics of at most ${characters(maxLyrics)}. These have ${lyrics.length}.`
  }
  return null
}
