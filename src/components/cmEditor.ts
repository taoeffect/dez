import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import type { Section } from '../types/chat'
import { sectionPlainText } from '../types/content'

/**
 * Step 2 scaffold: the CM document is the concatenation of every section's
 * plain text (pill bodies included, role boundaries dropped). Section
 * encoding with the U+001E sentinel lands in step 3.
 */
export function buildInitialDoc(sections: Section[]): string {
  return sections.map(sectionPlainText).join('')
}

/** Dez-flavored markdown highlight. Colors inherit from the CSS custom
 *  properties set in `App.vue` so theme switching Just Works via
 *  `data-theme` on `<html>`. */
export const dezHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: 'var(--color-text)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--color-link, #4a9eff)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--color-link, #4a9eff)' },
  { tag: t.monospace, fontFamily: 'inherit', color: 'var(--color-code, #c792ea)' },
  { tag: t.quote, color: 'var(--color-muted, #888)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--color-text)' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.meta, color: 'var(--color-muted, #888)' },
])

export const dezTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-text)',
    backgroundColor: 'transparent',
    fontSize: '15px',
  },
  '.cm-scroller': {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    lineHeight: '1.6',
    padding: '16px',
  },
  '.cm-content': {
    maxWidth: '768px',
    margin: '0 auto',
    width: '100%',
    caretColor: 'var(--color-text)',
    padding: 0,
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-text)' },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-selection, rgba(100, 149, 237, 0.35))',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-selection, rgba(100, 149, 237, 0.35))',
  },
  '.cm-gutters': { display: 'none' },
})

export function dezLanguageSupport(): Extension {
  return [markdown(), syntaxHighlighting(dezHighlightStyle)]
}
