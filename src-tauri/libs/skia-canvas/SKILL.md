# skia-canvas

The HTML canvas API (2D) in Deno, drawn by Skia (npm `skia-canvas` 4.0.1, MIT). It makes images and the frames of
clips in a script app and in `js_eval`.

## Where it works

In `js_eval`, and in a script app whose `manifest.json` has the field `"native": ["skia-canvas"]`: the library loads
a native file. A UI page cannot load it: it has the canvas of the browser in its place. Its native code can write
only the places of the run: the output folder, the work folder, and the folder of the app.

```json
{ "name": "poster", "description": "Draws a poster.", "kind": "script", "native": ["skia-canvas"] }
```

`js_eval` needs no field. Its code is the body of a function, so it loads the library with
`const { Canvas, loadImage } = await import("skia-canvas")`, and its `dez` has the same `inputs`, `outputFolder`,
`workFolder`, and `fonts` as the `dez` of an app.

## Import and draw

```ts
import { writeFile } from "node:fs/promises"
import { Canvas, loadImage } from "skia-canvas"
import { useShippedFonts } from "dez-media/canvas"

export default async function main(parameters, dez) {
  const families = useShippedFonts(dez.fonts)
  const canvas = new Canvas(1280, 720, { gpu: false })
  const ctx = canvas.getContext("2d")
  ctx.drawImage(await loadImage(dez.inputs[0].path), 0, 0, 1280, 720)
  ctx.font = `bold 64px ${families}`
  ctx.fillStyle = "#ffffff"
  ctx.fillText("Hello", 40, 100)
  await writeFile(`${dez.outputFolder}/poster.png`, await canvas.toBuffer("png"))
  return "Drew poster.png."
}
```

- Make each canvas with `{ gpu: false }`: the run has no GPU.
- The run sees no font of the computer. A canvas draws no text before `useShippedFonts(dez.fonts)` of
  `dez-media/canvas`. It gives a list of every shipped family for `ctx.font`, which draws each script that the fonts
  cover. One family of `dez.fonts` alone draws only its own scripts.
- `loadImage(path)` reads an image file: an input copy (`dez.inputs[i].path`) or a file of the work folder.
- `await canvas.toBuffer("png")` (or `"jpg"`, `"webp"`) gives the bytes of a file. Dez keeps the image files of
  `dez.outputFolder` as new images of the conversation.
- `canvas.toBufferSync("raw")` gives the RGBA pixels, 4 bytes each, not premultiplied.

## Clips

`FrameWriter` of `dez-media/frames` takes a canvas for each frame and writes a frame sequence, which Dez encodes
into one clip after the run:

```ts
import { FrameWriter } from "dez-media/frames"
const frames = new FrameWriter(dez.outputFolder, "intro", { fps: 30, width: 1280, height: 720 })
for (let i = 0; i < 90; i++) {
  ctx.clearRect(0, 0, 1280, 720)
  // draw frame i, at the time i / 30 s
  frames.add(canvas)
}
frames.end()
```

The clip is H.264 in MP4, whose width and height must be even. With `{ alpha: true }`, it is a MOV clip that keeps
the alpha of each pixel, for an overlay with `video ffmpeg`. Read `/libs/dez-media/SKILL.md` for the rules of a
frame sequence.
