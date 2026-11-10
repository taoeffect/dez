/** The aspect ratio (width / height) of each video whose metadata loaded,
 *  by the source of its clip (the `src` of the tag). The editor makes a
 *  clip's player again each time it builds its state (the end of each
 *  stream, a tab switch), and a player knows its video's size only after a
 *  load. With the ratio from here, the new player has its final height at
 *  once, so the text below it does not jump. */
export const videoAspectRatios = new Map<string, number>()
