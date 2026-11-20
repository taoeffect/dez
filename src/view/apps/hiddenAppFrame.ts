import sbp from '@sbp/sbp'
import { APP_INVOKE_HANDLER, APP_RUN_FRAME_SIZE, type AppFrameEnd, type AppFrameRun } from '../../model/tools/appBridge'
import { closeAppFrame, openAppFrame, postToAppFrame } from './appFrame'

// The frame of a run of a UI app (`apps invoke`): the page of the app in a
// frame that the user does not see, for the one call of its handler. The
// frame follows the rules of every app frame (appFrame.ts). It is not a
// frame of the editor (appFrameHost.ts): a run is a job of its tab, and
// goes on when the user looks at another tab.
//
// The frame is in the page, in the viewport, and only not visible. WebKit
// slows the timers and stops the animation frames of a frame that is out
// of the viewport or has `display: none`, and gives a page with no box no
// layout: code that draws or measures would wait, or get zeros.
//
// A page runs on the thread of Dez's page. So the time limit of the job
// cannot end a script that never yields: no timer of Dez runs then.

// How long Dez waits for the first message of its client script after the
// page loaded. The script tells Dez that it runs before the page has
// loaded, so only a page without the script lets this time pass.
const CLIENT_GRACE_MS = 2000

// The id of the one call of a run.
const INVOKE_CALL_ID = 1

export default sbp('sbp/selectors/register', {
  /** Runs the handler of the page of a UI app once (`run`), in a new
   *  hidden frame, and tells how the run ended. The frame goes at every
   *  end. A stop of `run.signal` closes the frame, which ends the code of
   *  the page, and rejects with the reason of the stop. */
  'dez.ui/runAppFrame' (run: AppFrameRun): Promise<AppFrameEnd> {
    return new Promise((resolve, reject) => {
      if (run.signal.aborted) {
        reject(run.signal.reason)
        return
      }
      const host = document.createElement('div')
      // The user cannot reach the frame: no pointer, no Tab key, and no
      // screen reader.
      host.inert = true
      host.setAttribute('aria-hidden', 'true')
      Object.assign(host.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: `${APP_RUN_FRAME_SIZE.width}px`,
        height: `${APP_RUN_FRAME_SIZE.height}px`,
        visibility: 'hidden',
        pointerEvents: 'none',
        zIndex: '-1',
      })

      let called = false
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      const close = (): void => {
        clearTimeout(graceTimer)
        run.signal.removeEventListener('abort', onStop)
        closeAppFrame(frame)
        host.remove()
      }
      const end = (result: AppFrameEnd): void => {
        close()
        resolve(result)
      }
      const onStop = (): void => {
        close()
        reject(run.signal.reason)
      }

      const frame = openAppFrame(run.name, {
        // `escape` and `menu` tell of a key and a click of the user, which
        // this frame cannot get.
        onMessage(message) {
          if (message.dez === 'ready') {
            // A page that loads a second time is ready again.
            if (called) return
            called = true
            clearTimeout(graceTimer)
            // The client script runs the handler when the page has loaded.
            postToAppFrame(frame, { dez: 'call', id: INVOKE_CALL_ID, selector: APP_INVOKE_HANDLER, args: [run.parameters, { inputs: run.inputs }] })
            run.onRuns()
          } else if (message.dez === 'answer' && called && message.id === INVOKE_CALL_ID) {
            const { ok, value, error, noHandler, log } = message
            if (ok) end({ kind: 'returned', value, log })
            else if (noHandler) end({ kind: 'unregistered', log })
            else end({ kind: 'threw', error: error ?? '', log })
          }
        },
        onCall: (call) => run.onCall(call),
        onNavigated: () => end({ kind: 'navigated' }),
      })
      Object.assign(frame.style, { width: '100%', height: '100%', border: '0' })
      frame.addEventListener('load', () => {
        if (!called) graceTimer = setTimeout(() => end({ kind: 'noClient' }), CLIENT_GRACE_MS)
      }, { once: true })
      run.signal.addEventListener('abort', onStop, { once: true })
      host.append(frame)
      document.body.append(host)
    })
  },
})
