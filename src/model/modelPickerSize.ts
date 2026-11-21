// The size of the model picker of the bottom bar (`modelPickerSize` in
// app_state.json), in whole px. The user sets it with a drag of the open
// picker's top edge, right edge, or top right corner
// (`view/model-selector/pickerResize.ts`).
//
// `maxHeight` is a limit, not a height: the picker is as tall as its list,
// up to this limit (`ModelPicker.vue`), so a search with few results still
// gives a short picker. So a drag up of a picker whose list is shorter than
// it raises the limit, but the top edge stops at the end of the list.
export interface ModelPickerSize {
  width: number
  maxHeight: number
}

// The designed size, and also the minimum: a drag only makes the picker
// larger than this, and a drag down and to the left as far as it goes gives
// this size back, so the picker needs no reset control.
export const MODEL_PICKER_SIZE_DEFAULT: Readonly<ModelPickerSize> = { width: 320, maxHeight: 360 }

export function clampModelPickerSize(size: ModelPickerSize): ModelPickerSize {
  return {
    width: Math.max(MODEL_PICKER_SIZE_DEFAULT.width, Math.round(size.width)),
    maxHeight: Math.max(MODEL_PICKER_SIZE_DEFAULT.maxHeight, Math.round(size.maxHeight)),
  }
}
