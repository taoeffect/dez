# Chart.js

Charts on a 2D canvas (npm `chart.js` 4.6.1, MIT). Its color helper `@kurkle/color` ships with it.

## The ready app: dez-chart

`apps invoke dez-chart` draws a chart of a data file of `/work/` into `chart.png`, with no code of your own:

- `data` (required): the path of a `.csv`, `.tsv`, or `.json` file in `/work/`. CSV and TSV have a header line;
  JSON is a list of objects, one for each row.
- `type`: line (default), bar, scatter, pie, doughnut, or radar.
- `x`: the column of the labels; `y`: a column or a list of columns (by default each other column of numbers).
- `title`, `x_label`, `y_label`; `width` and `height` from 64 to 4096 (1280 × 720 by default); `theme`: light or
  dark.

To start an app of your own, read `/apps/dez-chart/main.ts` and `/apps/dez-chart/config.ts`.

## Import

```js
import { Chart, registerables } from "chart.js"
Chart.register(...registerables)
```

`import Chart from "chart.js/auto"` registers all the parts. `chart.js/helpers` and `@kurkle/color` are there too.

## A chart in a script app

Chart.js draws on a canvas of skia-canvas, so the `manifest.json` of the app needs `"native": ["skia-canvas"]`
(read `/libs/skia-canvas/SKILL.md`). `js_eval` cannot draw a chart: it cannot load skia-canvas.

```ts
import { writeFile } from "node:fs/promises"
import { Chart, registerables } from "chart.js"
import { Canvas } from "skia-canvas"
import { useShippedFonts } from "dez-media/canvas"

export default async function main(parameters, dez) {
  Chart.register(...registerables)
  Chart.defaults.font.family = useShippedFonts(dez.fonts)
  const canvas = new Canvas(1280, 720, { gpu: false })
  // The canvas is clear: this puts a white background under the chart.
  const background = {
    id: "background",
    beforeDraw(chart) {
      const ctx = chart.ctx
      ctx.save()
      ctx.globalCompositeOperation = "destination-over"
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, chart.width, chart.height)
      ctx.restore()
    },
  }
  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels: ["Jan", "Feb"], datasets: [{ label: "Sales", data: [3, 5] }] },
    options: { responsive: false, animation: false, devicePixelRatio: 1 },
    plugins: [background],
  })
  await writeFile(`${dez.outputFolder}/chart.png`, await canvas.toBuffer("png"))
  chart.destroy()
  return "Drew chart.png."
}
```

- Set `responsive: false`, `animation: false`, and `devicePixelRatio: 1`: there is no window. Make no fake `window`
  or `document`.
- A canvas draws no text before `useShippedFonts(dez.fonts)`.
- Read the data of a file with `csvTable`, `jsonTable`, and `numericColumns` of `dez-media`.

## In a UI page

`import Chart from "chart.js/auto"`, then draw on a `<canvas>` of the page.
