// The thread editor's font size in px (`editorFontSize` in app_state.json).
// The app chrome does not follow it.
export const EDITOR_FONT_SIZE_DEFAULT = 15
/** The CSS custom property on `<html>` that holds the editor font size
 *  (`dez.ui/applyEditorFontSize`). */
export const EDITOR_FONT_SIZE_PROPERTY = '--dez-editor-font-size'
const EDITOR_FONT_SIZE_MIN = 10
const EDITOR_FONT_SIZE_MAX = 32

export function clampEditorFontSize(px: number): number {
  return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(px)))
}
