// The volume of the reply-done sound in percent (`doneSoundVolume` in
// app_state.json), set with the slider in Settings › Notifications.
export const DONE_SOUND_VOLUME_DEFAULT = 50
const DONE_SOUND_VOLUME_MIN = 0
const DONE_SOUND_VOLUME_MAX = 100

export function clampDoneSoundVolume(percent: number): number {
  return Math.min(DONE_SOUND_VOLUME_MAX, Math.max(DONE_SOUND_VOLUME_MIN, Math.round(percent)))
}
