// Who reads the text of a problem with the input of a media request. The
// same checks run for both readers (clipInputs.ts, clipImages.ts,
// learnedImageLimit.ts, `dez.provider/generateMedia`); only the words of
// the fix differ, because each reader gives the input in its own way.

/** The reader of a problem text:
 *  - `user`: the user who sent a message. The inputs are the images and
 *    the clips of the message (pasted, dropped, or named with `@id`), and
 *    the fix is a change of the message.
 *  - `model`: the chat model that called `model_invoke`. The inputs are
 *    only the `@id` mentions of its `prompt` argument, and the fix is a new
 *    call. */
export type RequestReader = 'user' | 'model'

/** The words that tell what the request has, before a count: "…, and
 *  this message has 3." or "…, and the prompt names 3." */
export function requestHas(reader: RequestReader): string {
  return reader === 'user' ? 'this message has' : 'the prompt names'
}
