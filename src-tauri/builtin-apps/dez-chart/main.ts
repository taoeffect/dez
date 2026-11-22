// dez-chart: a chart picture (PNG) of the data of a CSV, TSV, or JSON file
// in /work/, drawn with Chart.js.
//
// Inputs: none.
//
// Parameters:
// - data (required): the path of the data file in /work/: CSV or TSV with a
//   header line, or JSON as a list of objects, one for each row.
// - type: "line" (default), "bar", "scatter", "pie", "doughnut", or
//   "radar".
// - x: the column of the labels (the x values of a scatter chart); the first
//   column by default.
// - y: the column of the series, or a list of them; by default each other
//   column that holds only numbers.
// - title, x_label, y_label: texts of the chart and its axes.
// - width, height: the size of the picture, 1280×720 by default.
// - theme: "light" (default, white) or "dark".
//
// It writes chart.png into the output folder, and Dez adds it to the
// conversation as an image of the run.

import { readFile, writeFile } from 'node:fs/promises'
import { Chart, registerables } from 'chart.js'
import { Canvas } from 'skia-canvas'
import { workFile } from 'dez-media'
import { useShippedFonts } from 'dez-media/canvas'
import { APP, chartConfig, chartParameters, chartTable } from './config.ts'

/** What a run gives the code (only the parts that this app reads). */
interface Dez {
  inputs: readonly unknown[]
  outputFolder: string
  workFolder: string
  fonts: readonly { file: string, family: string, weight: number, scripts: string, path: string }[]
}

// The text of the data file, with a text for the model when it is missing.
async function dataText(file: { path: string, shown: string }): Promise<string> {
  try {
    return await readFile(file.path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') throw new RangeError(`There is no file ${file.shown}. Write the data there first, or give the path of another file.`)
    throw error
  }
}

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  if (dez.inputs.length > 0) throw new RangeError(`${APP} takes no input: give the path of the data file in /work/ as data.`)
  const chart = chartParameters(parameters)
  const file = workFile(dez.workFolder, chart.data)
  const { config, style, series, rows } = chartConfig(chartTable(file.shown, await dataText(file)), chart)

  Chart.register(...registerables)
  Chart.defaults.font.family = useShippedFonts(dez.fonts)
  Chart.defaults.font.size = style.fontSize
  Chart.defaults.color = style.text
  Chart.defaults.borderColor = style.grid
  const canvas = new Canvas(chart.width, chart.height, { gpu: false })
  // Chart.js draws on a clear canvas; the background goes under its pixels.
  const background = {
    id: 'background',
    beforeDraw(drawn: Chart) {
      const ctx = drawn.ctx
      ctx.save()
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = style.background
      ctx.fillRect(0, 0, drawn.width, drawn.height)
      ctx.restore()
    },
  }
  const drawn = new Chart(canvas, { ...config, plugins: [background] })
  await writeFile(`${dez.outputFolder}/chart.png`, await canvas.toBuffer('png'))
  drawn.destroy()
  const names = series.map((name) => JSON.stringify(name)).join(', ')
  return `A ${chart.type} chart of ${names} (${rows} ${rows === 1 ? 'row' : 'rows'}) from ${file.shown}: chart.png, ${chart.width}×${chart.height}, ${chart.theme} theme.`
}
