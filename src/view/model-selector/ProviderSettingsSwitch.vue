<script setup lang="ts">
// One on/off row of the provider settings popup (ProviderSettingsPopup.vue):
// a provider toggle, or a switch parameter of the model. The popup stores
// the value, so a click only asks it to flip.
defineProps<{
  label: string
  on: boolean
}>()

defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    class="provider-settings-row"
    type="button"
    role="switch"
    :aria-checked="on"
    @click="$emit('toggle')"
  >
    <!-- The popup styles the label, as its parameter rows have it too. -->
    <span class="provider-settings-label">{{ label }}</span>
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
