# Toast components

Dez toasts are emitted through the global SBP selector and rendered by `ToastContainer`.

## Mounting

Import and mount one or more containers where toast UI should appear:

```vue
<script setup lang="ts">
import ToastContainer from './ToastContainer.vue'
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

sbp('dez.ui/toast', 'app-global', {
  title: 'Conversation saved',
  message: path,
  variant: 'success',
  duration: 5000,
  sbpInvocation: ['dez.controller/revealInFileManager', path],
})

sbp('dez.ui/toast', 'app-global', {
  title: 'Request failed',
  message: 'Venice returned HTTP 401: {"error":"Authentication failed"}',
  variant: 'error',
})
```

## ToastData fields

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `message` | Yes | `string` | Main toast text. |
| `title` | No | `string` | Optional bold heading. |
| `variant` | No | `'default' \| 'success' \| 'warning' \| 'error'` | Controls icon color and default icon. `error` also changes the card's look and size (see below). |
| `position` | No | `'top-right' \| 'top-left' \| 'top-center' \| 'bottom-right' \| 'bottom-left' \| 'bottom-center'` | Chooses the desktop toast pocket. |
| `duration` | No | `number` | Milliseconds before auto-dismiss. Omit for persistent toast. |
| `icon` | No | `string` | Overrides the default variant icon. |
| `closeable` | No | `boolean` | Shows or hides the close button. |
| `actionLabel` | No | `string` | Renders a text-button action inside the toast. |
| `sbpInvocation` | No | `{ selector: string, args?: unknown[] }` or `[string, ...unknown[]]` | Invoked when the toast body or action is clicked: `[selector, ...args]` calls `sbp(selector, ...args)`. The selector may be async. A selector that throws or rejects is logged with `console.error`. |
| `closeOnClick` | No | `boolean` | A click that runs `sbpInvocation` also closes the toast. |

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
- A layout with a bar at the bottom sets the CSS variable `--toast-inset-bottom` to the bar's height, and the container keeps every toast above it. `AppLayout.vue` sets it, so the bottom toasts never cover the bottom bar and its Submit/Stop button.
- `duration` adds a progress bar and auto-dismisses the toast when the timer completes.
- Hover pauses the progress animation and timer; leaving the toast resumes them.
- A toast with `sbpInvocation` shows a pointer cursor. A click on it runs the invocation and does not close the toast, unless `closeOnClick` is set; a click on the close button does not run it. An invocation that opens an external URL uses `['dez.controller/openUrl', url]`.
- `closeable: false` hides the close button, but the toast can still close by timeout or max-count eviction.
- `error` toasts have a red tint, a red stripe on the left, and a red icon and title, from the theme variables `--color-error`, `--color-error-bg`, and `--color-error-border` in `App.vue` (light and dark values). The card grows with its text from the normal 360 px up to 560 px (never wider than the window less 32 px). A message taller than 40% of the window scrolls inside the card. The message text is selectable, so the user can copy it.
- Errors of a chat request (`dez.stream/start`) and a send with no model (`dez.controller/submitTab`) are `error` toasts with no `duration`, so they stay until the user closes them. The thread shows no error text. E2E specs read open error toasts with `openErrorToasts` in `tests/e2e/harness/thread.ts`.
- Toast title, message, and action text are rendered as Vue text bindings, not `v-html`, so HTML in toast content is not executed.
