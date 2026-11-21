import { describe, expect, it } from 'vitest'
import { appTagsForRequest, appTagText, findAppTags, labelAppTags, splitAppTags } from './appTags'

const TAG = '<dez:app name="unit-converter"/>'

// The names of the apps of the tags of a user text.
function names(text: string): string[] {
  return findAppTags(text, 'user').map((tag) => tag.name)
}

describe('appTagText and findAppTags', () => {
  it('reads back the tag that the writer gives, with the range of its line', () => {
    expect(appTagText('unit-converter')).toBe(TAG)
    const text = `Here it is:\n\n${TAG}\n\nTry it.`
    expect(findAppTags(text, 'agent')).toStrictEqual([{ name: 'unit-converter', from: 13, to: 13 + TAG.length }])
    expect(text.slice(13, 13 + TAG.length)).toBe(TAG)
  })

  it('reads a tag at the text start and at the text end, and two tags on two lines', () => {
    expect(names(`${TAG}\n${appTagText('b_2')}`)).toStrictEqual(['unit-converter', 'b_2'])
  })

  it('takes a tag only as a whole line', () => {
    for (const text of [`See ${TAG}`, `${TAG} here`, ` ${TAG}`, `${TAG} `, `${TAG}${TAG}`]) {
      expect(names(text), text).toStrictEqual([])
    }
  })

  it('takes no tag whose name is no name of an app', () => {
    for (const name of ['', 'Notes', '-notes', '../notes', 'a/b', 'a b', 'a'.repeat(65)]) {
      expect(names(`<dez:app name="${name}"/>`), name).toStrictEqual([])
    }
    expect(names(`<dez:app name="${'a'.repeat(64)}"/>`)).toStrictEqual(['a'.repeat(64)])
  })

  it('takes no tag with no name, no tag of another form, and no longer tag name', () => {
    for (const text of ['<dez:app/>', '<dez:app id="a"/>', '<dez:app name="a">', '<dez:app name="a"></dez:app>', '<dez:apps name="a"/>', '<dez:appname="a"/>', '<\\dez:app name="a"/>']) {
      expect(names(text), text).toStrictEqual([])
    }
  })

  it('reads the name of a tag with more attributes, and its first name', () => {
    expect(names('<dez:app height="320" name="a" other="x &quot;y&quot;" />')).toStrictEqual(['a'])
    expect(names('<dez:app name="a" name="b"/>')).toStrictEqual(['a'])
  })

  it('takes a tag in the code of a user text as text, unless the caller asks for it', () => {
    const text = `\`\`\`\n${TAG}\n\`\`\`\n\n${appTagText('b')}`
    expect(names(text)).toStrictEqual(['b'])
    expect(findAppTags(text, 'user', { inCode: true }).map((tag) => tag.name)).toStrictEqual(['unit-converter', 'b'])
  })

  it('takes a tag after an open code fence of a model: a tag line is a line of Dez', () => {
    expect(findAppTags(`\`\`\`js\nlet a\n${TAG}`, 'agent').map((tag) => tag.name)).toStrictEqual(['unit-converter'])
  })
})

describe('splitAppTags', () => {
  it('gives the text and the tags in order, with the line breaks in the text', () => {
    expect(splitAppTags(`One\n${TAG}\nTwo`, 'user')).toStrictEqual([
      { kind: 'text', text: 'One\n' },
      { kind: 'app', tag: { name: 'unit-converter', from: 4, to: 4 + TAG.length } },
      { kind: 'text', text: '\nTwo' },
    ])
  })

  it('gives a text with no tag as one piece, and no piece for a blank text', () => {
    expect(splitAppTags('One <dez:app', 'user')).toStrictEqual([{ kind: 'text', text: 'One <dez:app' }])
    expect(splitAppTags('', 'user')).toStrictEqual([])
  })
})

describe('appTagsForRequest', () => {
  it('sends each tag as the writer gives it, whatever more the tag holds', () => {
    expect(appTagsForRequest('Look:\n<dez:app height="320"  name="a" />\nDone')).toBe(`Look:\n${appTagText('a')}\nDone`)
  })

  it('leaves a tag in code and every other text as they are', () => {
    const text = `\`\`\`\n<dez:app name="a" />\n\`\`\`\n<dez:app name="-"/>\n@a`
    expect(appTagsForRequest(text)).toBe(text)
  })
})

describe('labelAppTags', () => {
  it('puts the label of the app in place of each tag', () => {
    expect(labelAppTags(`One\n${TAG}\nTwo`, 'agent')).toBe('One\n[app unit-converter]\nTwo')
    expect(labelAppTags(`One\n${TAG}\nTwo`, 'agent', () => ' ')).toBe('One\n \nTwo')
  })

  it('leaves a tag in code as its text', () => {
    const text = `\`\`\`\n${TAG}\n\`\`\``
    expect(labelAppTags(text, 'user')).toBe(text)
  })
})
