import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UpdateRefusal } from '../updates/refusal'
import type { Release } from '../updates/releases'

// Where the update check is: `idle` until the first check of this session
// starts, then `checking`, then the outcome of the last check.
export type UpdateCheckStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'failed'

// Where the install of the newest release is (dez.controller/updates/install):
// `idle` before it starts and after the window closes, then each step in
// turn, and at the end one of two:
// - `failed`, with the message that the window shows. `retry` is false once
//   the install ran: Rust then refuses a new download until Dez restarts.
// - `refused`: the release failed one of its four checks. The refusal
//   dialog is then open over the window (`refusal` in the store), and the
//   window offers nothing: no retry, and no manual download, because the
//   DMG on GitHub is the file that failed.
// `total` is null when the server sends no length.
export type UpdateInstall =
  | { phase: 'idle' }
  | { phase: 'downloading', received: number, total: number | null }
  | { phase: 'installing' }
  | { phase: 'relaunching' }
  | { phase: 'failed', error: string, retry: boolean }
  | { phase: 'refused' }

// An install in these phases must run to its end: the window stays open,
// and no update check runs.
export function installIsBusy(install: UpdateInstall): boolean {
  return install.phase === 'downloading' || install.phase === 'installing' || install.phase === 'relaunching'
}

// Internal model implementation detail: the update check, the update
// window, the install, and the refusal dialog, for this session only
// (nothing here is saved). Mutations live in the dez.model/updates/*
// selectors; dez.controller/checkForUpdates and
// dez.controller/updates/install drive them.
export const useUpdatesStore = defineStore('updates', () => {
  const status = ref<UpdateCheckStatus>('idle')
  // The message of the last failed check; null after a good one.
  const error = ref<string | null>(null)
  // The releases newer than the running one, newest first, from the last
  // check that succeeded.
  const releases = ref<Release[]>([])
  const windowOpen = ref(false)
  const install = ref<UpdateInstall>({ phase: 'idle' })
  // Why this Dez cannot install an update by itself (`can_install_update`
  // in src-tauri/src/updater/mod.rs), or null when it can. Only macOS asks;
  // elsewhere it stays null, and the window offers the release page.
  const installBlockedReason = ref<string | null>(null)
  // The update that Dez refused, while its dialog is open
  // (UpdateRefusedDialog.vue); null otherwise. It is apart from the window's
  // state because the dialog stays when the window closes under it: only
  // the user closes this warning (dez.model/updates/closeRefusal).
  const refusal = ref<UpdateRefusal | null>(null)

  return {
    status,
    error,
    releases,
    windowOpen,
    install,
    installBlockedReason,
    refusal,
  }
})
