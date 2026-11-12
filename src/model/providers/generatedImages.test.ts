import { describe, expect, it } from 'vitest'
import { UnusableAnswerError } from './errors'
import { generatedImage } from './generatedImages'

describe('generatedImage', () => {
  it.each([
    ['a bare root', '<svg/>'],
    ['white space before the root', '\n  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"></svg>'],
    ['a byte order mark and an XML declaration', '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['comments and a DOCTYPE with entities, as an editor writes them', [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<!-- Generator: Adobe Illustrator 27.0, SVG Export Plug-In -->',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [',
      '  <!ENTITY ns_svg "http://www.w3.org/2000/svg">',
      ']>',
      '<svg version="1.1" xmlns="&ns_svg;" width="24" height="24"><path d="M0 0h24v24H0z"/></svg>',
    ].join('\n')],
  ])('takes an SVG file with %s as an SVG image', (_case, svg) => {
    const bytes = new TextEncoder().encode(svg)

    expect(generatedImage(bytes)).toStrictEqual({ bytes, mediaType: 'image/svg+xml' })
  })

  it.each([
    ['an HTML page', '<!DOCTYPE html><html><body><svg/></body></html>'],
    ['an XML file of another root', '<?xml version="1.0"?><feed><svg/></feed>'],
    ['an element whose name only starts with svg', '<svgx/>'],
    ['a comment that does not end', '<!-- <svg/>'],
    ['a JSON error that holds SVG text', '{"error":"<svg/>"}'],
    ['an empty file', ''],
  ])('refuses %s', (_case, body) => {
    expect(() => generatedImage(new TextEncoder().encode(body))).toThrow(new UnusableAnswerError('The image is not a PNG, JPEG, GIF, WebP, or SVG image.'))
  })
})
