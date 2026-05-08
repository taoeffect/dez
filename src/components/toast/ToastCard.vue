<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import type { ToastData } from '../../sbp/ui'

export interface ToastItem extends ToastData {
  id: string
  createdTimestamp: number
  closing?: boolean
}

const props = defineProps<{
  data: ToastItem
}>()

const emit = defineEmits<{
  close: [id: string]
  'unpause-animation': [id: string, adjustedCreatedTimestamp: number]
}>()

const closing = ref(false)
const paused = ref(false)
const progressOnPause = ref<number | null>(null)
let closeTimer: ReturnType<typeof window.setTimeout> | null = null
let pauseStartedAt = 0

const showCloseButton = computed(() => props.data.closeable !== false)
const hasDuration = computed(() => typeof props.data.duration === 'number' && props.data.duration > 0)
const variant = computed(() => props.data.variant ?? 'default')
const icon = computed(() => {
  if (props.data.icon) return props.data.icon

  return {
    default: 'i',
    success: '✓',
    warning: '!',
    error: '!',
  }[variant.value]
})
const progressStyle = computed(() => ({
  animationDuration: `${props.data.duration ?? 0}ms`,
}))

function closeToast (): void {
  if (closing.value || props.data.closing) return

  closing.value = true
  props.data.closing = true
  closeTimer = window.setTimeout(() => {
    emit('close', props.data.id)
  }, 250)
}

function pauseAnimation (): void {
  if (!hasDuration.value || paused.value) return

  paused.value = true
  pauseStartedAt = Date.now()

  const elapsed = Date.now() - props.data.createdTimestamp
  const duration = props.data.duration ?? 0
  progressOnPause.value = Math.max(0, Math.min(100, 100 - (elapsed / duration) * 100))
}

function unpauseAnimation (): void {
  if (!paused.value) return

  const pauseDuration = Date.now() - pauseStartedAt
  paused.value = false
  progressOnPause.value = null
  emit('unpause-animation', props.data.id, props.data.createdTimestamp + pauseDuration)
}

function onAnimationEnd (event: AnimationEvent): void {
  if (event.animationName.includes('toast-timeout')) {
    closeToast()
  }
}

function onToastClick (): void {
  const invocation = props.data.sbpInvocation
  if (!invocation) return

  if (Array.isArray(invocation)) {
    const [selector, ...args] = invocation
    sbp(selector, ...args)
    return
  }

  sbp(invocation.selector, ...(invocation.args ?? []))
}

onUnmounted(() => {
  if (closeTimer) {
    window.clearTimeout(closeTimer)
  }
})

defineExpose({ closeToast })
</script>

<template>
  <article
    class="toast-card"
    :class="[`toast-card--${variant}`, { 'toast-card--closing': closing, 'toast-card--clickable': data.sbpInvocation }]"
    role="status"
    aria-live="polite"
    @mouseenter="pauseAnimation"
    @mouseleave="unpauseAnimation"
    @click="onToastClick"
    @animationend="onAnimationEnd"
  >
    <div class="toast-icon" aria-hidden="true">{{ icon }}</div>
    <div class="toast-content">
      <p v-if="data.title" class="toast-title">{{ data.title }}</p>
      <p class="toast-message">{{ data.message }}</p>
      <button
        v-if="data.actionLabel"
        class="toast-action"
        type="button"
        @click.stop="onToastClick"
      >
        {{ data.actionLabel }}
      </button>
    </div>
    <button
      v-if="showCloseButton"
      class="toast-close"
      type="button"
      aria-label="Close toast"
      @click.stop="closeToast"
    >
      ×
    </button>
    <div v-if="hasDuration" class="toast-progress" aria-hidden="true">
      <div
        class="toast-progress-bar"
        :class="{ 'toast-progress-bar--paused': paused }"
        :style="paused && progressOnPause !== null ? { width: `${progressOnPause}%` } : progressStyle"
      />
    </div>
  </article>
</template>

<style scoped>
.toast-card {
  position: relative;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 10px;
  width: min(360px, calc(100vw - 32px));
  overflow: hidden;
  padding: 12px 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg);
  color: var(--color-text);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  pointer-events: auto;
  animation: toast-enter 0.22s ease-out both;
}

.toast-card--closing {
  animation: toast-leave 0.25s ease-in both;
}

.toast-card--clickable {
  cursor: pointer;
}

.toast-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: rgba(120, 120, 120, 0.18);
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}

.toast-card--success .toast-icon {
  background: rgba(33, 150, 83, 0.16);
  color: #219653;
}

.toast-card--warning .toast-icon {
  background: rgba(245, 158, 11, 0.18);
  color: #b45309;
}

.toast-card--error .toast-icon {
  background: rgba(235, 87, 87, 0.16);
  color: #eb5757;
}

.toast-content {
  min-width: 0;
}

.toast-title,
.toast-message {
  margin: 0;
}

.toast-title {
  font-size: 13px;
  font-weight: 700;
  line-height: 18px;
}

.toast-message {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 18px;
  opacity: 0.9;
}

.toast-action {
  margin-top: 8px;
  padding: 0;
  border: none;
  background: transparent;
  color: currentColor;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  line-height: 18px;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.toast-action:hover {
  opacity: 0.78;
}

.toast-close {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  font-size: 20px;
  line-height: 18px;
  opacity: 0.55;
}

.toast-close:hover {
  opacity: 0.9;
}

.toast-progress {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 3px;
  background: rgba(120, 120, 120, 0.16);
}

.toast-progress-bar {
  width: 100%;
  height: 100%;
  background: currentColor;
  opacity: 0.35;
  animation-name: toast-timeout;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

.toast-progress-bar--paused {
  animation-play-state: paused;
}

@keyframes toast-enter {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes toast-leave {
  to {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
}

@keyframes toast-timeout {
  from {
    width: 100%;
  }

  to {
    width: 0;
  }
}
</style>
