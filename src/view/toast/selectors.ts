import sbp from '@sbp/sbp'
import { CLOSE_TOASTS, SHOW_TOAST } from './events'

export type ToastVariant = 'default' | 'success' | 'warning' | 'error'
export type ToastPosition =
  | 'top-right'
  | 'top-left'
  | 'top-center'
  | 'bottom-right'
  | 'bottom-left'
  | 'bottom-center'

export interface ToastSbpInvocation {
  selector: string
  args?: unknown[]
}

export interface ToastData {
  message: string
  title?: string
  variant?: ToastVariant
  position?: ToastPosition
  duration?: number
  icon?: string
  closeable?: boolean
  actionLabel?: string
  sbpInvocation?: ToastSbpInvocation | [string, ...unknown[]]
  // A name that the toast shares with the toasts that go out of date with
  // it: `dez.ui/closeToasts` closes them by it.
  group?: string
}

export default sbp('sbp/selectors/register', {
  'dez.ui/toast' (area: string, data: ToastData): void {
    if (!area || !data) {
      throw Error('sbp("dez.ui/toast") failed - Missing parameters')
    }

    if (!data.message || typeof data.message !== 'string') {
      throw Error('sbp("dez.ui/toast") failed - "message" is required and must be a string')
    }

    const defaultData = {
      variant: 'default' as ToastVariant,
      position: 'bottom-right' as ToastPosition,
      closeable: true,
    }

    sbp('okTurtles.events/emit', SHOW_TOAST, area, {
      ...defaultData,
      ...data,
    })
  },

  // Closes the open toasts of `area` that have this `group`
  // (`ToastData.group`): what they tell is out of date. A toast that is
  // not open any more is no error.
  'dez.ui/closeToasts' (area: string, group: string): void {
    sbp('okTurtles.events/emit', CLOSE_TOASTS, area, group)
  },
})
