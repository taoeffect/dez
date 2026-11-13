<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, drawSelection } from '@codemirror/view'
import { EDITOR_FONT_SIZE_PROPERTY } from '../../model/editorFontSize'
import { markdownLinks } from '../editor/links'
import { markdownTables } from '../editor/tables'
import { dezLanguageSupport, dezTheme } from '../thread/cmEditor'

// A read-only view of a system prompt as markdown, drawn as the thread
// editor draws text. It has no image, tool, or media extension, so an image
// reference or a media tag in the prompt shows as its source text.

// Every size of `dezTheme` follows `EDITOR_FONT_SIZE_PROPERTY`. The root sets
// it to `fontSizePx`, so this view does not follow the user's editor font size.
const props = defineProps<{ text: string, fontSizePx: number }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

// `dezTheme` without the parts of a thread: the "User" pill of the first
// section and the room above it. Highest precedence, so these rules come
// after the ones of `dezTheme` in the style sheet and win.
const previewTheme = Prec.highest(EditorView.theme({
  '.cm-scroller': { padding: '10px' },
  '.cm-content': { padding: '0' },
  '.cm-content::before': { content: 'none' },
}))

onMounted(() => {
  if (!host.value) return
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.text,
      extensions: [
        EditorState.readOnly.of(true),
        drawSelection(),
        EditorView.lineWrapping,
        dezLanguageSupport(),
        dezTheme,
        previewTheme,
        markdownTables(),
        markdownLinks(),
      ],
    }),
  })
})

watch(() => props.text, (text) => {
  if (!view || view.state.doc.toString() === text) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <div class="system-prompt-preview" :style="{ [EDITOR_FONT_SIZE_PROPERTY]: `${fontSizePx}px` }">
    <div ref="host" class="system-prompt-preview-host" />
  </div>
</template>

<style scoped>
.system-prompt-preview {
  position: relative;
  min-height: 0;
}

/* Out of the flow, so a long prompt scrolls in the editor and does not make
   the box (whose height comes from its content) taller. Not on `.cm-editor`
   itself: CodeMirror's base theme makes it `position: relative !important`. */
.system-prompt-preview-host {
  position: absolute;
  inset: 0;
}
</style>
