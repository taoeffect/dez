/** Fullscreen shows only one element of the page: the card of a media
 *  player, or the frame host of an app. The confirm prompt and the toasts
 *  are outside that element (`AppLayout.vue`), so the user would not see
 *  them, and a prompt that is not seen takes the keys. So code that shows
 *  a prompt or a toast for something in `root` calls this first. Resolves
 *  when the page shows again; at once when nothing in `root` fills the
 *  screen. */
export async function leaveFullscreen(root: Element): Promise<void> {
  if (!root.contains(document.fullscreenElement)) return
  try {
    await document.exitFullscreen()
  } catch (error) {
    console.error('Failed to leave fullscreen:', error)
  }
}
