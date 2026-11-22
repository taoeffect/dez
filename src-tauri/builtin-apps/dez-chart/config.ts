// The parameters of dez-chart (main.ts), and the Chart.js config of a chart
// from a table and the parameters. Apart from the drawing, so that a unit
// test reads them with no Chart.js and no skia-canvas.

import { csvTable, jsonTable, numericColumns, type Table, type TableValue } from 'dez-media'

export const APP = 'dez-chart'

const PARAMETERS = ['data', 'type', 'x', 'y', 'title', 'x_label', 'y_label', 'width', 'height', 'theme']
export const CHART_TYPES = ['line', 'bar', 'scatter', 'pie', 'doughnut', 'radar'] as const
const THEMES = ['light', 'dark'] as const
const DATA_ENDINGS = ['.csv', '.tsv', '.json']
const MIN_SIDE = 64
// The most pixels of one side of the picture (FRAMES_MAX_SIDE of Dez,
// src/model/tools/appsTool.ts).
const MAX_SIDE = 4096
const MAX_TEXT_LENGTH = 200

export type ChartType = typeof CHART_TYPES[number]

export interface ChartParameters {
  /** The data file, as a /work/ path. */
  data: string
  type: ChartType
  /** The column of the labels (the x values of a scatter chart); null for
   *  the first column. */
  x: string | null
  /** The columns of the series; null for each column of numbers. */
  y: string[] | null
  title: string
  xLabel: string
  yLabel: string
  width: number
  height: number
  theme: typeof THEMES[number]
}

/** The colors and the font size of a chart, which main.ts sets as the
 *  defaults of Chart.js. */
export interface ChartStyle {
  background: string
  text: string
  grid: string
  fontSize: number
}

const STYLES: Readonly<Record<ChartParameters['theme'], Omit<ChartStyle, 'fontSize'>>> = {
  light: { background: '#ffffff', text: '#444444', grid: 'rgba(0,0,0,0.1)' },
  dark: { background: '#14161c', text: '#e6e6e6', grid: 'rgba(255,255,255,0.12)' },
}

const quoted = (value: unknown) => JSON.stringify(value) ?? String(value)
const listed = (values: readonly string[]) => values.map((value) => `"${value}"`).join(', ')

// A text parameter of one line; "" when the call has none.
function textParameter(name: string, value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > MAX_TEXT_LENGTH) {
    throw new RangeError(`${name} must be a text of one line, at most ${MAX_TEXT_LENGTH} characters, not ${quoted(value)}.`)
  }
  return value
}

function sideParameter(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_SIDE || value > MAX_SIDE) {
    throw new RangeError(`${name} must be a whole number of pixels from ${MIN_SIDE} to ${MAX_SIDE}, not ${quoted(value)}.`)
  }
  return value
}

function choiceParameter<T extends string>(name: string, value: unknown, values: readonly T[]): T {
  if (value === undefined) return values[0]
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T
  throw new RangeError(`${name} must be one of ${listed(values)}, not ${quoted(value)}.`)
}

/**
 * The parameters of a run, checked. Throws a RangeError that tells how to
 * fix a parameter that the app does not take or whose value is not valid.
 * The columns that `x` and `y` name are checked against the table
 * (`chartConfig`).
 */
export function chartParameters(parameters: Record<string, unknown>): ChartParameters {
  // With a misspelled name, the run would else go on with the default value.
  const unknown = Object.keys(parameters).filter((name) => !PARAMETERS.includes(name))
  if (unknown.length > 0) throw new RangeError(`${APP} does not take the parameter ${listed(unknown)}. It takes only ${listed(PARAMETERS)}.`)
  const { data, x, y } = parameters
  if (typeof data !== 'string' || !DATA_ENDINGS.some((ending) => data.toLowerCase().endsWith(ending))) {
    throw new RangeError(`data must be the path of a CSV, TSV, or JSON file in /work/, as in "/work/sales.csv", not ${quoted(data)}.`)
  }
  if (x !== undefined && typeof x !== 'string') throw new RangeError(`x must be the name of a column, not ${quoted(x)}.`)
  const columns = typeof y === 'string' ? [y] : y
  if (columns !== undefined && (!Array.isArray(columns) || columns.length === 0 || !columns.every((column) => typeof column === 'string'))) {
    throw new RangeError(`y must be the name of a column, or a list of the names of columns, as in ["sales", "cost"], not ${quoted(y)}.`)
  }
  return {
    data,
    type: choiceParameter('type', parameters.type, CHART_TYPES),
    x: x ?? null,
    y: columns ?? null,
    title: textParameter('title', parameters.title),
    xLabel: textParameter('x_label', parameters.x_label),
    yLabel: textParameter('y_label', parameters.y_label),
    width: sideParameter('width', parameters.width, 1280),
    height: sideParameter('height', parameters.height, 720),
    theme: choiceParameter('theme', parameters.theme, THEMES),
  }
}

/**
 * The table of the text of the data file `path`: CSV, TSV, or JSON (a list
 * of objects, one for each row) by the ending of its name. Throws a
 * RangeError for a text that is no table.
 */
export function chartTable(path: string, text: string): Table {
  const name = path.toLowerCase()
  if (name.endsWith('.tsv')) return csvTable(text, { delimiter: '\t' })
  if (name.endsWith('.csv')) return csvTable(text)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new RangeError(`${path} is no JSON file: ${(error as Error).message}`)
  }
  return jsonTable(value)
}

/** A Chart.js config with the parts that this app gives, as plain data. */
export interface ChartConfig {
  type: ChartType
  data: {
    labels?: string[]
    datasets: { label: string, data: (number | null)[] | { x: number, y: number }[] }[]
  }
  options: Record<string, unknown>
}

/** A chart: its Chart.js config (with no plugin), its style, and the
 *  columns of its series. */
export interface ChartPlan {
  config: ChartConfig
  style: ChartStyle
  series: string[]
  rows: number
}

const labelOf = (value: TableValue) => (value === null ? '' : String(value))

// The options of one axis: its title, and the colors of its ticks and grid.
function axis(label: string, style: ChartStyle) {
  return {
    title: { display: label !== '', text: label, color: style.text },
    ticks: { color: style.text },
    grid: { color: style.grid },
  }
}

/**
 * The chart of `table` (`chartTable`) that `parameters` ask for
 * (`chartParameters`). Throws a RangeError for a column that the table does
 * not have, a series of a column that is not all numbers, and a table with
 * no row.
 */
export function chartConfig(table: Table, parameters: ChartParameters): ChartPlan {
  const { columns, rows } = table
  if (rows.length === 0) throw new RangeError(`${parameters.data} has no row of data, only its header.`)
  const missing = [parameters.x, ...(parameters.y ?? [])].filter((name): name is string => name !== null && !columns.includes(name))
  if (missing.length > 0) throw new RangeError(`${parameters.data} has no column ${listed(missing)}. Its columns are ${listed(columns)}.`)
  const x = parameters.x ?? columns[0]
  const numeric = numericColumns(table)
  const series = parameters.y ?? numeric.filter((name) => name !== x)
  if (series.length === 0) throw new RangeError(`${parameters.data} has no column of numbers besides ${quoted(x)}. Give the columns of the series as y.`)
  const notNumbers = series.filter((name) => !numeric.includes(name))
  if (notNumbers.length > 0) throw new RangeError(`The column ${listed(notNumbers)} of ${parameters.data} does not hold only numbers, and a series takes only numbers.`)
  if (parameters.type === 'scatter' && !numeric.includes(x)) {
    throw new RangeError(`A scatter chart takes its x values from a column of numbers, and ${quoted(x)} is not one. Give such a column as x, or another type.`)
  }

  const xIndex = columns.indexOf(x)
  const datasets = series.map((name) => {
    const index = columns.indexOf(name)
    if (parameters.type === 'scatter') {
      const points = rows.filter((row) => row[xIndex] !== null && row[index] !== null).map((row) => ({ x: row[xIndex] as number, y: row[index] as number }))
      return { label: name, data: points }
    }
    return { label: name, data: rows.map((row) => row[index] as number | null) }
  })
  const fontSize = Math.max(12, Math.round(parameters.height / 40))
  const style = { ...STYLES[parameters.theme], fontSize }
  const round = parameters.type === 'pie' || parameters.type === 'doughnut'
  const scales = round
    ? {}
    : parameters.type === 'radar'
      ? { r: { ticks: { color: style.text, backdropColor: 'transparent' }, grid: { color: style.grid }, angleLines: { color: style.grid }, pointLabels: { color: style.text } } }
      : { x: axis(parameters.xLabel || (parameters.type === 'scatter' ? x : ''), style), y: axis(parameters.yLabel, style) }
  const config: ChartConfig = {
    type: parameters.type,
    data: parameters.type === 'scatter' ? { datasets } : { labels: rows.map((row) => labelOf(row[xIndex])), datasets },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 1,
      layout: { padding: fontSize },
      plugins: {
        title: { display: parameters.title !== '', text: parameters.title, color: style.text, font: { size: Math.round(fontSize * 1.4), weight: 'bold' } },
        // A legend names the series; a pie names its slices.
        legend: { display: round || series.length > 1, labels: { color: style.text } },
        // The palette of Chart.js colors no series once a default color
        // changes (main.ts sets the grid color of the theme), so force it.
        colors: { forceOverride: true },
      },
      scales,
    },
  }
  return { config, style, series, rows: rows.length }
}
