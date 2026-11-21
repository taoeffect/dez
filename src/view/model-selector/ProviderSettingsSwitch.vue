<script setup lang="ts">
// One on/off row of the provider settings popup (ProviderSettingsPopup.vue):
// a provider toggle, or a switch parameter of the model. The popup stores
// the value, so a click only asks it to flip.
defineProps<{
  label: string
  on: boolean
  // The row takes no click; `note` tells why, under the label.
  disabled?: boolean
  note?: string
}>()

defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    class="provider-settings-row"
    type="button"
    role="switch"
    :aria-checked="on"
    :disabled="disabled"
    @click="$emit('toggle')"
  >
    <!-- The popup styles the label, as its parameter rows have it too. -->
    <span class="provider-settings-label">{{ label }}<span v-if="note" class="provider-settings-note">{{ note }}</span></span>
    <span class="provider-settings-switch" :class="{ 'provider-settings-switch--on': on }">
      <span class="provider-settings-knob"></span>
    </span>
  </button>
</template>

<style scoped>
.provider-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.provider-settings-row:hover {
  background: var(--color-border);
}

.provider-settings-row:disabled {
  cursor: default;
}

.provider-settings-row:disabled:hover {
  background: transparent;
}

.provider-settings-row:disabled .provider-settings-switch {
  opacity: 0.5;
}

/* The label of the popup cuts its one line; a note wraps. */
.provider-settings-note {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.3;
  white-space: normal;
  opacity: 0.6;
}

.provider-settings-switch {
  flex-shrink: 0;
  width: 28px;
  height: 16px;
  margin-left: 8px;
  border-radius: 8px;
  background: var(--color-border);
  display: inline-flex;
  align-items: center;
  padding: 2px;
  box-sizing: border-box;
  transition: background 0.15s;
}

.provider-settings-switch--on {
  background: var(--color-accent);
}

.provider-settings-knob {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-bg);
  transition: transform 0.15s;
}

.provider-settings-switch--on .provider-settings-knob {
  transform: translateX(12px);
}
</style>
