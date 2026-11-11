// Venice's reference-to-video models: they make a video that shows the
// people, things, and places of the input images, and they take those
// images in a reference field of the queue request, not as frames
// (`image_url`, `end_image_url`). Nothing in Venice's model list marks
// them: they have `model_type: image-to-video` and the same constraint keys
// as the models that take frames. Only the id says `reference-to-video`, so
// the id chooses the family. A model that takes frames refuses the
// reference fields ("This model does not support reference images").
//
// The fields and the counts are facts of Venice's request schema, so they
// are data of the `venice` media format (mediaFormats.ts) and not of the
// provider config: a custom provider of the `venice` format gets them too.
// The counts come from the API's own refusals (validation 400s, which cost
// nothing; checked 2026-11-11): "reference_image_urls must have at most 7
// images". A count that changes gets the same refusal, which
// `ClipFormat.refusedImages` reads.
//
// The prompt names the images by their order in the request. The guides
// tell the names of Kling O3 and Grok (`@Element1`, `@Image1`), Seedance
// (`<Image 1>`, "canonical and case-sensitive"), and Wan 3.0 (`@Image1`).
// The others have no guide: they get `@Image1`, the name of most families
// and the default `ref_name` of `image_references` ("defaults to Image1,
// Image2 and so on").
// https://docs.venice.ai/api-reference/endpoint/video/queue
// https://docs.venice.ai/guides/media/reference-to-video
// https://docs.venice.ai/guides/media/seedance-2-0
// https://docs.venice.ai/guides/media/wan-3-0

// The request field of a family's images:
// - `reference_image_urls`: a list of URLs.
// - `image_references`: a list of `{ image_url }` objects, for Wan 2.7 and
//   PixVerse C1: the schema names them as the models that read the other
//   fields of an object (a voice, a type, a name), which Dez does not send
//   yet.
// - `elements`: Kling's list of `{ frontal_image_url }`, at most 4. An
//   element holds the look of a person or a thing over the whole video,
//   which is what "make @a move" asks for, and one meets Kling's rule of
//   at least one visual input. Kling's other list, `scene_image_urls`, is
//   for the place and the style (`@Image1`); Dez sends none.
export type VeniceReferenceField = 'reference_image_urls' | 'image_references' | 'elements'

export interface VeniceReferenceFamily {
  // The start of the ids of the family's models.
  idPrefix: string
  field: VeniceReferenceField
  // The most images of one request.
  maxImages: number
  // The name of the n-th image in the prompt, with `{n}` for the number.
  promptName: string
}

const AT_IMAGE = '@Image{n}'

// The first entry whose prefix starts the id wins, so a longer prefix comes
// before a shorter one of the same family.
const VENICE_REFERENCE_FAMILIES: readonly VeniceReferenceFamily[] = [
  { idPrefix: 'grok-imagine-', field: 'reference_image_urls', maxImages: 7, promptName: AT_IMAGE },
  { idPrefix: 'seedance-2-0-', field: 'reference_image_urls', maxImages: 9, promptName: '<Image {n}>' },
  { idPrefix: 'seedance-', field: 'reference_image_urls', maxImages: 30, promptName: '<Image {n}>' },
  { idPrefix: 'wan-3-0-', field: 'reference_image_urls', maxImages: 10, promptName: AT_IMAGE },
  { idPrefix: 'wan-2-7-', field: 'image_references', maxImages: 5, promptName: AT_IMAGE },
  { idPrefix: 'gemini-omni-flash-1-1-', field: 'reference_image_urls', maxImages: 10, promptName: AT_IMAGE },
  { idPrefix: 'gemini-omni-flash-', field: 'reference_image_urls', maxImages: 3, promptName: AT_IMAGE },
  { idPrefix: 'happyhorse-1-0-', field: 'reference_image_urls', maxImages: 5, promptName: AT_IMAGE },
  { idPrefix: 'happyhorse-', field: 'reference_image_urls', maxImages: 9, promptName: AT_IMAGE },
  { idPrefix: 'minimax-h3-', field: 'reference_image_urls', maxImages: 9, promptName: AT_IMAGE },
  { idPrefix: 'kling-o3-', field: 'elements', maxImages: 4, promptName: '@Element{n}' },
  { idPrefix: 'kling-v3-', field: 'elements', maxImages: 4, promptName: '@Element{n}' },
  { idPrefix: 'kling-v4-', field: 'reference_image_urls', maxImages: 10, promptName: AT_IMAGE },
  { idPrefix: 'pixverse-c1-', field: 'image_references', maxImages: 7, promptName: AT_IMAGE },
]

// A reference model of no family above: the plain list, with the count of
// the schema (`maxItems: 30`).
const OTHER_REFERENCE_MODELS: VeniceReferenceFamily = { idPrefix: '', field: 'reference_image_urls', maxImages: 30, promptName: AT_IMAGE }

/** The reference fields that a Venice refusal can name. */
export const VENICE_REFERENCE_FIELDS: readonly VeniceReferenceField[] = ['reference_image_urls', 'image_references', 'elements']

/** The family of the Venice model `modelId`; undefined for a model that
 *  takes its images as frames. */
export function veniceReferenceFamily(modelId: string): VeniceReferenceFamily | undefined {
  if (!modelId.includes('reference-to-video')) return undefined
  return VENICE_REFERENCE_FAMILIES.find((family) => modelId.startsWith(family.idPrefix)) ?? OTHER_REFERENCE_MODELS
}

/** The request field of `family` with the images `urls`, in their order. */
export function veniceReferenceBody(family: VeniceReferenceFamily, urls: readonly string[]): Record<string, unknown> {
  switch (family.field) {
    case 'reference_image_urls':
      return { reference_image_urls: [...urls] }
    case 'image_references':
      return { image_references: urls.map((url) => ({ image_url: url })) }
    case 'elements':
      return { elements: urls.map((url) => ({ frontal_image_url: url })) }
  }
}
