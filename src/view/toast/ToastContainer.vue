<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { CLOSE_TOASTS, SHOW_TOAST } from './events'
import ToastCard from './ToastCard.vue'
import type { ToastItem } from './ToastCard.vue'
import type { ToastData, ToastPosition } from './selectors'
import { keptToasts, overflowToasts, toastShows } from './tabToasts'

const props = defineProps<{
  area: string
}>()

const MAX_TOAST_COUNT = 4
const SMALL_SCREEN_QUERY = '(max-width: 768px)'
const positions = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const satisfies readonly ToastPosition[]

const { activeTabId, tabIds } = useModelState()
// Every toast of the container, also those that wait for their tab
// (`ToastData.tabId`, `tabToasts.ts`). Only the toasts that show have a card.
const toasts = ref<ToastItem[]>([])
const shownToasts = computed(() => toasts.value.filter((toast) => toastShows(toast, activeTabId.value)))
const isSmallScreen = ref(false)
const toastRefs = new Map<string, InstanceType<typeof ToastCard>>()
let mediaQuery: MediaQueryList | null = null

const smallGroupedToasts = computed<Record<'top' | 'bottom', ToastItem[]>>(() => ({
  top: shownToasts.value.filter((toast) => toast.position?.startsWith('top')),
  bottom: shownToasts.value.filter((toast) => toast.position?.startsWith('bottom')),
}))
const positionedGroupedToasts = computed<Record<ToastPosition, ToastItem[]>>(() => positions.reduce<Record<ToastPosition, ToastItem[]>>((groups, position) => {
  groups[position] = shownToasts.value.filter((toast) => toast.position === position)
  return groups
}, {
  'top-left': [],
  'top-center': [],
  'top-right': [],
  'bottom-left': [],
  'bottom-center': [],
  'bottom-right': [],
}))

function makeToastId (): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function setToastRef (id: string, component: InstanceType<typeof ToastCard> | null): void {
  if (component) {
    toastRefs.set(id, component)
    return
  }

  toastRefs.delete(id)
}

function onShowToast (toastArea: unknown, data: unknown): void {
  if (toastArea !== props.area || !data || typeof data !== 'object' || Array.isArray(data)) return

  const toast = {
    ...(data as ToastData),
    id: makeToastId(),
  } satisfies ToastItem

  // A toast of a tab that is not open any more is dropped at once.
  toasts.value = keptToasts([...toasts.value, toast], activeTabId.value, tabIds.value)
  closeOverflow()
}

// Closes the oldest toasts that show, over `MAX_TOAST_COUNT`.
function closeOverflow (): void {
  for (const toast of overflowToasts(toasts.value, activeTabId.value, MAX_TOAST_COUNT)) startClose(toast)
}

// Closes `toast` with the animation of its card, or at once while it has
// no card (a toast of the same tick, or one that waits for its tab).
function startClose (toast: ToastItem): void {
  const card = toastRefs.get(toast.id)
  if (card) {
    card.closeToast()
  } else {
    toast.closing = true
    closeToast(toast.id)
  }
}

function onCloseToasts (toastArea: unknown, group: unknown): void {
  if (toastArea !== props.area) return
  for (const toast of toasts.value.filter((item) => item.group === group && !item.closing)) startClose(toast)
}

function closeToast (id: string): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id)
  toastRefs.delete(id)
}

// A switch of the tab draws the toasts of the new tab, and each starts its
// timer again with its new card; a close of a tab drops its toasts.
watch([activeTabId, tabIds], ([tabId, openTabIds]) => {
  toasts.value = keptToasts(toasts.value, tabId, openTabIds)
  closeOverflow()
})

function updateSmallScreenState (): void {
  isSmallScreen.value = mediaQuery?.matches ?? false
}

onMounted(() => {
  sbp('okTurtles.events/on', SHOW_TOAST, onShowToast)
  sbp('okTurtles.events/on', CLOSE_TOASTS, onCloseToasts)

  mediaQuery = window.matchMedia(SMALL_SCREEN_QUERY)
  updateSmallScreenState()
  mediaQuery.addEventListener('change', updateSmallScreenState)
})

onUnmounted(() => {
  sbp('okTurtles.events/off', SHOW_TOAST, onShowToast)
  sbp('okTurtles.events/off', CLOSE_TOASTS, onCloseToasts)
  mediaQuery?.removeEventListener('change', updateSmallScreenState)
})
</script>

<template>
  <div class="toast-container" aria-live="polite">
    <template v-if="isSmallScreen">
      <div
        v-for="position in ['top', 'bottom'] as const"
        :key="position"
        class="toast-pocket"
        :class="[`toast-pocket--${position}`]"
      >
        <ToastCard
          v-for="toast in smallGroupedToasts[position]"
          :key="toast.id"
          :ref="(component) => setToastRef(toast.id, component as InstanceType<typeof ToastCard> | null)"
          :data="toast"
          @close="closeToast"
        />
      </div>
    </template>

    <template v-else>
      <div
        v-for="position in positions"
        :key="position"
        class="toast-pocket"
        :class="[`toast-pocket--${position}`, { 'toast-pocket--top': position.startsWith('top'), 'toast-pocket--bottom': position.startsWith('bottom') }]"
      >
        <ToastCard
          v-for="toast in positionedGroupedToasts[position]"
          :key="toast.id"
          :ref="(component) => setToastRef(toast.id, component as InstanceType<typeof ToastCard> | null)"
          :data="toast"
          @close="closeToast"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* A layout with a bar at the bottom sets `--toast-inset-bottom` to the
   bar's height, so the bottom toasts stay above the bar. */
.toast-container {
  position: fixed;
  inset: 0 0 var(--toast-inset-bottom, 0px);
  z-index: 120;
  pointer-events: none;
}

.toast-pocket {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* The widest card: an error card grows with its text up to 560 px. */
  max-width: min(560px, calc(100vw - 32px));
}

.toast-pocket--top {
  flex-direction: column-reverse;
}

.toast-pocket--bottom {
  flex-direction: column;
}

.toast-pocket--top-left {
  top: 16px;
  left: 16px;
  align-items: flex-start;
}

.toast-pocket--top-center {
  top: 16px;
  left: 50%;
  align-items: center;
  transform: translateX(-50%);
}

.toast-pocket--top-right {
  top: 16px;
  right: 16px;
  align-items: flex-end;
}

.toast-pocket--bottom-left {
  bottom: 16px;
  left: 16px;
  align-items: flex-start;
}

.toast-pocket--bottom-center {
  bottom: 16px;
  left: 50%;
  align-items: center;
  transform: translateX(-50%);
}

.toast-pocket--bottom-right {
  right: 16px;
  bottom: 16px;
  align-items: flex-end;
}

@media (max-width: 768px) {
  .toast-pocket {
    right: 16px;
    left: 16px;
    align-items: center;
    max-width: none;
    transform: none;
  }

  .toast-pocket--top {
    top: 16px;
  }

  .toast-pocket--bottom {
    bottom: 16px;
  }
}
</style>
