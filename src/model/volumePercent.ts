const VOLUME_PERCENT_MIN = 0
const VOLUME_PERCENT_MAX = 100

/** A volume in whole percent, 0-100: the clip players and the reply-done sound. */
export function clampVolumePercent(percent: number): number {
  return Math.min(VOLUME_PERCENT_MAX, Math.max(VOLUME_PERCENT_MIN, Math.round(percent)))
}
