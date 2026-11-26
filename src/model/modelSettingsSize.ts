// The size of the settings panel of the gear button of the bottom bar
// (`modelSettingsSize` in app_state.json), in whole px. The user sets it
// with a drag of the open panel's top edge, right edge, or top right corner
// (`view/model-selector/pickerResize.ts`), as the size of the model picker
// (`modelPickerSize.ts`).
//
// `width` is a floor, not a width: the panel is as wide as its longest row
// needs to show its whole label, and at least this wide
// (`ProviderSettingsPopup.vue`). So with no drag every label shows, and a
// drag to the left never cuts one.
//
// `maxHeight` is a limit, as the picker's: the panel is as tall as its rows,
// up to this limit and the room of the window, and its rows scroll. `null`
// is no limit of the user (the default): then only the room counts. The
// panel needs it, and the picker does not, as the panel shows all its rows
// at once: a limit that is stored as a number would cut a taller panel in a
// larger window.
export interface ModelSettingsSize {
  width: number
  maxHeight: number | null
}

// The width of the panel before the user gives it one, and also the
// minimum: a drag to the left as far as it goes gives this size back, so
// the panel needs no reset control.
export const MODEL_SETTINGS_SIZE_DEFAULT: Readonly<ModelSettingsSize> = { width: 250, maxHeight: null }

// The lowest height limit that a drag gives: the header and about three
// rows.
export const MODEL_SETTINGS_MIN_HEIGHT = 160

// A `maxHeight` that is not finite is no limit: a drag gives `Infinity` for
// no limit, and JSON has no `Infinity`.
export function clampModelSettingsSize(size: ModelSettingsSize): ModelSettingsSize {
  return {
    width: Math.max(MODEL_SETTINGS_SIZE_DEFAULT.width, Math.round(size.width)),
    maxHeight: size.maxHeight === null || !Number.isFinite(size.maxHeight)
      ? null
      : Math.max(MODEL_SETTINGS_MIN_HEIGHT, Math.round(size.maxHeight)),
  }
}
