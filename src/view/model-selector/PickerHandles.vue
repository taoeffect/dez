<script setup lang="ts">
// The three resize handles of a box that opens up from the bottom bar
// (`pickerResize.ts`): the model picker and the settings panel of the gear.
// The parent is the box: it must be positioned and must not clip, as the
// handles are outside its border. It starts the drag on `press`.
import { PICKER_EDGES, type PickerEdge } from './pickerResize'

defineEmits<{ press: [edge: PickerEdge, event: PointerEvent] }>()
</script>

<template>
  <!-- A pointer control only; `.prevent` keeps the focus where it is (the
       search field of the picker) and starts no text selection. -->
  <div
    v-for="edge in PICKER_EDGES"
    :key="edge"
    class="picker-handle"
    :class="`picker-handle--${edge}`"
    aria-hidden="true"
    @pointerdown="$emit('press', edge, $event)"
    @mousedown.prevent
  ></div>
</template>

<style scoped>
/* Strips along the top and right edges and a square on the top right
   corner, which covers the ends of the strips. A strip covers the border
   and 7 px outside it (`PICKER_ROOM_MARGIN_PX` keeps that part in the
   window), so it takes none of the box's scrollbar; the corner reaches 6 px
   in, into the padding of the box's first row. Two-way cursors, as each
   handle makes the box larger and smaller. */
.picker-handle {
  position: absolute;
  z-index: 1;
}

.picker-handle--top {
  top: -8px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: ns-resize;
}

.picker-handle--right {
  top: 0;
  right: -8px;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
}

.picker-handle--corner {
  top: -8px;
  right: -8px;
  width: 14px;
  height: 14px;
  cursor: nesw-resize;
}
</style>

<!-- The cursor of a running resize, on every element: the pointer leaves
     the thin handle during a drag, and pointer capture does not keep the
     handle's cursor in every WebKit. `usePickerResize` sets the class on
     `<html>`. Not scoped, as it must reach the whole page. -->
<style>
html.picker-resizing--top,
html.picker-resizing--top * {
  cursor: ns-resize !important;
}

html.picker-resizing--right,
html.picker-resizing--right * {
  cursor: ew-resize !important;
}

html.picker-resizing--corner,
html.picker-resizing--corner * {
  cursor: nesw-resize !important;
}
</style>
