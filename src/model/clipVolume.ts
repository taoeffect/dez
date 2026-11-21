import type { MediaTagKind } from './chat/mediaTags'

// The volume of the clip players: one for every video clip, and one for
// every audio clip (`clipVolumes` in app_state.json). The volume slider and
// the mute button of a player set the value of its kind, and every player
// of that kind takes it, also a player that Dez makes later (when a clip
// comes back into view, after a tab switch, after a restart).
export interface ClipVolume {
  /** In percent, 0-100, as `doneSoundVolume`. */
  volume: number
  muted: boolean
}

export type ClipVolumes = Record<MediaTagKind, ClipVolume>

// Full and not muted, as a media element starts: nothing changes until the
// user moves the volume.
const CLIP_VOLUME_DEFAULT: Readonly<ClipVolume> = { volume: 100, muted: false }
const CLIP_VOLUME_MIN = 0
const CLIP_VOLUME_MAX = 100

export function defaultClipVolumes(): ClipVolumes {
  return { audio: { ...CLIP_VOLUME_DEFAULT }, video: { ...CLIP_VOLUME_DEFAULT } }
}

export function clampClipVolume(percent: number): number {
  return Math.min(CLIP_VOLUME_MAX, Math.max(CLIP_VOLUME_MIN, Math.round(percent)))
}
