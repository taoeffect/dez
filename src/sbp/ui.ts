import sbp from '@sbp/sbp'
import { openUrl } from '@tauri-apps/plugin-opener'
import { SHOW_TOAST } from '../utils/events'

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
}

export default sbp('sbp/selectors/register', {
  'dez.ui/openUrl' (url: string): void {
    if (!url || typeof url !== 'string') {
      throw Error('sbp("dez.ui/openUrl") failed - "url" is required and must be a string')
    }

    openUrl(url).catch((error) => {
      console.error('Failed to open URL:', error)
    })
  },

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
})
