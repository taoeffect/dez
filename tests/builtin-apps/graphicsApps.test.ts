import { describe, expect, it } from 'vitest'
import { chartConfig, chartParameters, chartTable } from '../../src-tauri/builtin-apps/dez-chart/config'
import { APP, DEFAULT_FONT, TITLE_PARAMETERS, titleParameters } from '../../src-tauri/builtin-apps/dez-title/parameters'
import { VIDEO_ALIASES } from '../../src/model/tools/appAliases'
import { SHIPPED_FONTS } from '../../src/model/tools/videoFonts'

// The parts of the graphics built-ins that do not draw: the checks of
// their parameters, and the chart of a table. The drawing needs
// skia-canvas, so the e2e specs run it (video-tool, apps-invoke).

const FONTS = SHIPPED_FONTS.map(({ file }) => file)

describe('dez-title parameters', () => {
  it('gives a 4 s 1080p title at 30 fps in the black serif font when the call gives only the text', () => {
    expect(FONTS).toContain(DEFAULT_FONT)
    expect(titleParameters({ text: 'NEON CITY' }, FONTS)).toStrictEqual({
      text: 'NEON CITY',
      subtitle: '',
      font: DEFAULT_FONT,
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 4,
      fill: 'chrome',
      outline: '#c80a1e',
      glow: '#ff2878',
      position: 'center',
      entrance: 'slam',
      exit: 'glitch',
      glint: true,
      frames: 120,
    })
  })

  it('takes the values of a call, and rounds the frame count', () => {
    const parameters = {
      text: '新宿', subtitle: 'EPISODE 1', font: 'NotoSans-Bold.ttf', width: 1280, height: 720, fps: 25, duration: 1.5,
      fill: '#fff', outline: 'none', glow: '#00FFCC', position: 'bottom', entrance: 'fade', exit: 'none', glint: false,
    }
    expect(titleParameters(parameters, FONTS)).toStrictEqual({ ...parameters, frames: 38 })
  })

  it('refuses a parameter that it does not take, and a value that is not valid, with a text that tells the fix', () => {
    const refusal = (parameters: Record<string, unknown>) => () => titleParameters({ text: 'A', ...parameters }, FONTS)
    expect(refusal({ colour: '#fff' })).toThrow('dez-title does not take the parameter "colour". It takes only "text", "subtitle", "font",')
    expect(() => titleParameters({}, FONTS)).toThrow('text must be a text, as in "NEON CITY", not undefined.')
    expect(refusal({ text: 'ONE\nTWO' })).toThrow('text must be one line: give the second line as subtitle, or make two titles.')
    expect(refusal({ font: 'Arial.ttf' })).toThrow(`font must be the file name of a font that Dez ships, one of "${FONTS[0]}",`)
    expect(refusal({ fill: 'red' })).toThrow('fill must be a hex color, as in "#c80a1e", or "chrome", not "red".')
    expect(refusal({ outline: 'chrome' })).toThrow('outline must be a hex color, as in "#c80a1e", or "none", not "chrome".')
    expect(refusal({ position: 'left' })).toThrow('position must be one of "center", "top", "bottom", not "left".')
    expect(refusal({ entrance: 'zoom' })).toThrow('entrance must be one of "slam", "fade", "none", not "zoom".')
    expect(refusal({ width: 1280.5 })).toThrow('width must be a whole number from 16 to 4096, not 1280.5.')
    expect(refusal({ fps: 120 })).toThrow('fps must be a whole number from 1 to 60, not 120.')
    expect(refusal({ duration: 0.5 })).toThrow('duration must be a number of seconds from 1 to 30, not 0.5.')
    expect(refusal({ glint: 'yes' })).toThrow('glint must be true or false, not "yes".')
  })

  it('makes at most 600 million pixels in all the frames, about 9.6 s of 1080p at 30 fps', () => {
    expect(titleParameters({ text: 'A', duration: 9.6 }, FONTS).frames).toBe(288)
    expect(() => titleParameters({ text: 'A', duration: 10 }, FONTS)).toThrow(
      'A clip of 1920×1080 at 30 fps for 10 s has 300 frames of 2.1 million pixels, and dez-title makes at most 600 million pixels in all '
      + '(about 9.6 s of 1920×1080 at 30 fps). Give a shorter duration, a lower fps, or a smaller width and height (the overlay can scale the title up).',
    )
    expect(titleParameters({ text: 'A', duration: 30, width: 1280, height: 720, fps: 20 }, FONTS).frames).toBe(600)
  })

  // A call of `video title` gives its arguments to the app as they are, and
  // the app refuses a parameter that it does not take.
  it('takes each parameter of `video title`, and the example call of its help', () => {
    const alias = VIDEO_ALIASES.find(({ app }) => app === APP)
    if (!alias) throw new Error(`The video tool has no alias of ${APP}.`)

    expect(alias.subcommand.parameters.map(({ name }) => name)).toStrictEqual(TITLE_PARAMETERS)
    expect(titleParameters(alias.subcommand.example, FONTS)).toMatchObject(alias.subcommand.example)
  })
})

describe('dez-chart', () => {
  const SALES = 'month,sales,cost,note\nJan,3,1,ok\nFeb,5,,\nMar,2,2,"a, b"\n'
  const plan = (parameters: Record<string, unknown>, text = SALES) => chartConfig(chartTable('/work/sales.csv', text), chartParameters({ data: '/work/sales.csv', ...parameters }))

  it('draws a line chart of each column of numbers over the first column by default, with a gap for an empty field', () => {
    const { config, series, rows, style } = plan({})
    expect([series, rows]).toStrictEqual([['sales', 'cost'], 3])
    expect(config.type).toBe('line')
    expect(config.data).toStrictEqual({ labels: ['Jan', 'Feb', 'Mar'], datasets: [{ label: 'sales', data: [3, 5, 2] }, { label: 'cost', data: [1, null, 2] }] })
    expect(style).toStrictEqual({ background: '#ffffff', text: '#444444', grid: 'rgba(0,0,0,0.1)', fontSize: 18 })
    expect(config.options).toMatchObject({ responsive: false, animation: false, devicePixelRatio: 1, plugins: { title: { display: false }, legend: { display: true } } })
  })

  it('takes the columns, the texts, the size, and the theme of a call', () => {
    const { config, style, series } = plan({ type: 'bar', x: 'note', y: 'cost', title: 'Costs', y_label: 'k€', height: 400, theme: 'dark' })
    expect(series).toStrictEqual(['cost'])
    expect(config.data.labels).toStrictEqual(['ok', '', 'a, b'])
    expect(style).toStrictEqual({ background: '#14161c', text: '#e6e6e6', grid: 'rgba(255,255,255,0.12)', fontSize: 12 })
    expect(config.options).toMatchObject({
      plugins: { title: { display: true, text: 'Costs', font: { size: 17 } }, legend: { display: false } },
      scales: { x: { title: { display: false } }, y: { title: { display: true, text: 'k€', color: '#e6e6e6' }, grid: { color: 'rgba(255,255,255,0.12)' } } },
    })
  })

  it('gives a scatter chart points of two columns of numbers, and refuses labels as its x', () => {
    const { config } = plan({ type: 'scatter', x: 'sales', y: ['cost'] })
    expect(config.data).toStrictEqual({ datasets: [{ label: 'cost', data: [{ x: 3, y: 1 }, { x: 2, y: 2 }] }] })
    expect(config.options.scales).toMatchObject({ x: { title: { display: true, text: 'sales' } } })
    expect(() => plan({ type: 'scatter' })).toThrow('A scatter chart takes its x values from a column of numbers, and "month" is not one.')
  })

  it('gives a pie no axes and a legend of its slices, and a radar one round scale', () => {
    expect(plan({ type: 'pie', y: 'sales' }).config.options).toMatchObject({ scales: {}, plugins: { legend: { display: true } } })
    expect(Object.keys(plan({ type: 'radar' }).config.options.scales as object)).toStrictEqual(['r'])
  })

  it('reads a TSV file and a JSON list of rows by the ending of the name', () => {
    expect(chartTable('/work/a.TSV', 'a\tb\n1\t2\n')).toStrictEqual({ columns: ['a', 'b'], rows: [[1, 2]] })
    expect(chartTable('/work/a.json', '[{"a": "x", "b": 2}]')).toStrictEqual({ columns: ['a', 'b'], rows: [['x', 2]] })
    expect(() => chartTable('/work/a.json', '{oops')).toThrow(/^\/work\/a\.json is no JSON file: /)
  })

  it('refuses a call with no data file, and columns that the table does not have or that hold no numbers', () => {
    expect(() => chartParameters({})).toThrow('data must be the path of a CSV, TSV, or JSON file in /work/, as in "/work/sales.csv", not undefined.')
    expect(() => chartParameters({ data: '/work/a.xlsx' })).toThrow(RangeError)
    expect(() => chartParameters({ data: '/work/a.csv', y: [] })).toThrow('y must be the name of a column, or a list of the names of columns')
    expect(() => chartParameters({ data: '/work/a.csv', kind: 'bar' })).toThrow('dez-chart does not take the parameter "kind".')
    expect(() => chartParameters({ data: '/work/a.csv', kind: 'bar', colour: 'red' })).toThrow('dez-chart does not take the parameters "kind", "colour".')
    expect(() => plan({ y: ['sales', 'profit'] })).toThrow('/work/sales.csv has no column "profit". Its columns are "month", "sales", "cost", "note".')
    expect(() => plan({ x: 'day', y: ['profit', 'profit'] })).toThrow('/work/sales.csv has none of the columns "day", "profit". Its columns are')
    expect(() => plan({ y: 'profit' }, 'sales\n3\n')).toThrow('/work/sales.csv has no column "profit". Its only column is "sales".')
    expect(() => plan({ y: 'note' })).toThrow('The column "note" of /work/sales.csv does not hold only numbers, and a series takes only numbers.')
    expect(() => plan({ y: ['note', 'month', 'note'] })).toThrow('The columns "note", "month" of /work/sales.csv do not hold only numbers, and a series takes only numbers.')
    expect(() => plan({}, 'month,sales\n')).toThrow('/work/sales.csv has no row of data.')
    expect(() => chartConfig(chartTable('/work/a.json', '[]'), chartParameters({ data: '/work/a.json' }))).toThrow('/work/a.json has no row of data.')
    expect(() => plan({}, 'month,note\nJan,ok\n')).toThrow('/work/sales.csv has no column of numbers besides "month". Give the columns of the series as y.')
  })
})
