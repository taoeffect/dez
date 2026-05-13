<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import { SHOW_TOAST } from './events'
import ToastCard from './ToastCard.vue'
import type { ToastItem } from './ToastCard.vue'
import type { ToastData, ToastPosition } from './selectors'

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

const toasts = ref<ToastItem[]>([])
const isSmallScreen = ref(false)
const toastRefs = new Map<string, InstanceType<typeof ToastCard>>()
let mediaQuery: MediaQueryList | null = null

const smallGroupedToasts = computed<Record<'top' | 'bottom', ToastItem[]>>(() => ({
  top: toasts.value.filter((toast) => toast.position?.startsWith('top')),
  bottom: toasts.value.filter((toast) => toast.position?.startsWith('bottom')),
}))
const positionedGroupedToasts = computed<Record<ToastPosition, ToastItem[]>>(() => positions.reduce<Record<ToastPosition, ToastItem[]>>((groups, position) => {
  groups[position] = toasts.value.filter((toast) => toast.position === position)
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
    createdTimestamp: Date.now(),
  } satisfies ToastItem

  toasts.value.push(toast)

  while (toasts.value.filter((item) => !item.closing).length > MAX_TOAST_COUNT) {
    const oldestToast = toasts.value.find((item) => !item.closing)
    if (!oldestToast) return

    const oldestToastCard = toastRefs.get(oldestToast.id)

    if (oldestToastCard) {
      oldestToastCard.closeToast()
    } else {
      oldestToast.closing = true
      closeToast(oldestToast.id)
    }
  }
}

function closeToast (id: string): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id)
  toastRefs.delete(id)
}

function updateCreatedTimestamp (id: string, adjustedCreatedTimestamp: number): void {
  const toast = toasts.value.find((item) => item.id === id)
  if (toast) {
    toast.createdTimestamp = adjustedCreatedTimestamp
  }
}

function updateSmallScreenState (): void {
  isSmallScreen.value = mediaQuery?.matches ?? false
}

onMounted(() => {
  sbp('okTurtles.events/on', SHOW_TOAST, onShowToast)

  mediaQuery = window.matchMedia(SMALL_SCREEN_QUERY)
  updateSmallScreenState()
  mediaQuery.addEventListener('change', updateSmallScreenState)
})

onUnmounted(() => {
  sbp('okTurtles.events/off', SHOW_TOAST, onShowToast)
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
          @unpause-animation="updateCreatedTimestamp"
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
          @unpause-animation="updateCreatedTimestamp"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  inset: 0;
  z-index: 120;
  pointer-events: none;
}

.toast-pocket {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: min(360px, calc(100vw - 32px));
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
