# Toast components

Dez toasts are emitted through the global SBP selector and rendered by `ToastContainer`.

## Mounting

Import and mount one or more containers where toast UI should appear:

```vue
<script setup lang="ts">
import ToastContainer from './toast/ToastContainer.vue'
</script>

<template>
  <ToastContainer area="app-global" />
</template>
```

`AppLayout.vue` already mounts the app-wide container with `area="app-global"`.

## Area behavior

Each toast is sent to an area string. A container only renders toasts whose emitted area matches its `area` prop, so separate UI regions can opt into separate toast streams.

```js
sbp('dez.ui/toast', 'app-global', { message: 'Hello from Dez' })
```

## Examples

```js
sbp('dez.ui/toast', 'app-global', { message: 'Hello from Dez' })

sbp('dez.ui/toast', 'app-global', {
  title: 'Saved',
  message: 'Settings saved',
  variant: 'success',
  position: 'top-right',
  duration: 5000,
})

sbp('dez.ui/toast', 'app-global', {
  message: 'Check this warning',
  variant: 'warning',
  position: 'bottom-center',
  duration: 8000,
  closeable: true,
})

sbp('dez.ui/toast', 'app-global', {
  message: 'Click me',
  variant: 'default',
  actionLabel: 'Run action',
  sbpInvocation: ['dez.ui/toast', 'app-global', {
    message: 'Clicked toast action',
    variant: 'success',
  }],
})
```

## ToastData fields

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `message` | Yes | `string` | Main toast text. |
| `title` | No | `string` | Optional bold heading. |
| `variant` | No | `'default' \| 'success' \| 'warning' \| 'error'` | Controls icon color and default icon. |
| `position` | No | `'top-right' \| 'top-left' \| 'top-center' \| 'bottom-right' \| 'bottom-left' \| 'bottom-center'` | Chooses the desktop toast pocket. |
| `duration` | No | `number` | Milliseconds before auto-dismiss. Omit for persistent toast. |
| `icon` | No | `string` | Overrides the default variant icon. |
| `closeable` | No | `boolean` | Shows or hides the close button. |
| `actionLabel` | No | `string` | Renders a text-button action inside the toast. |
| `sbpInvocation` | No | `{ selector: string, args?: unknown[] }` or `[string, ...unknown[]]` | Invoked when the toast body or action is clicked. |

Defaults applied by `dez.ui/toast`:

```ts
{
  variant: 'default',
  position: 'bottom-right',
  closeable: true,
}
```

## Behavior notes

- Each `ToastContainer` displays a maximum of 4 toasts and closes the oldest toast when a fifth is added.
- Desktop layouts support six pockets: top-left, top-center, top-right, bottom-left, bottom-center, and bottom-right.
- On screens up to 768px wide, positions are grouped into top and bottom stacks.
- `duration` adds a progress bar and auto-dismisses the toast when the timer completes.
- Hover pauses the progress animation and timer; leaving the toast resumes them.
- `closeable: false` hides the close button, but the toast can still close by timeout or max-count eviction.
- Toast title, message, and action text are rendered as Vue text bindings, not `v-html`, so HTML in toast content is not executed.
