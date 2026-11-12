import sbp from '@sbp/sbp'
import type * as TauriCore from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { DrawnImage, DrawnMediaType, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { findImageReferences, imageMarkdown, storedImageFile, type ImageFolder, type ImageMediaType } from '../model/chat/images'
import { FileTooLargeError } from '../model/chat/mediaFiles'
import './images'

// Unit tests run outside Tauri, which gives the asset URL of a path.
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof TauriCore>(),
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}))

interface SavedFile {
  path: string
  content: Uint8Array
}

interface Toast {
  title?: string
  message: string
  variant?: string
}

let appDir: string
let savedFiles: SavedFile[] = []
let saveAppFile: (file: SavedFile) => Promise<void>
let deletedFiles: string[] = []
let deleteAppFile: (path: string) => Promise<void>
let toasts: Toast[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.native/getAppDir' (): Promise<string> {
    return appDir
  },
  'dez.native/saveAppFile' (path: string, content: Uint8Array): Promise<void> {
    return saveAppFile({ path, content })
  },
  'dez.native/deleteAppFile' (path: string): Promise<void> {
    return deleteAppFile(path)
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
})

function save(bytes: Uint8Array, mediaType: ImageMediaType, options?: { folder?: ImageFolder }): Promise<string> {
  return sbp('dez.controller/images/save', bytes, mediaType, options) as Promise<string>
}

beforeEach(() => {
  appDir = '/home/ann/.config/dez'
  savedFiles = []
  saveAppFile = async (file) => {
    savedFiles.push(file)
  }
  deletedFiles = []
  deleteAppFile = async (path) => {
    deletedFiles.push(path)
  }
  toasts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
  vi.unstubAllGlobals()
})

describe('dez.controller/images/save', () => {
  it('writes the bytes to a new file in the image folder and returns its absolute path', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])

    const first = await save(bytes, 'image/png')
    const second = await save(bytes, 'image/jpeg')

    expect(savedFiles.map((file) => file.content)).toEqual([bytes, bytes])
    expect(savedFiles.map((file) => `${appDir}/${file.path}`)).toEqual([first, second])
    expect(first).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/images\/[0-9a-f-]{36}\.png$/)
    expect(second).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/images\/[0-9a-f-]{36}\.jpg$/)
    expect(first.slice(0, -4)).not.toBe(second.slice(0, -4))
    expect(findImageReferences(imageMarkdown(first)).map((ref) => ref.path)).toEqual([first])
    expect(toasts).toEqual([])
  })

  it('writes a generated image to the generated image folder, where the reader and the trash find it', async () => {
    const bytes = new Uint8Array([82, 73, 70, 70])

    const path = await save(bytes, 'image/webp', { folder: 'generated' })

    expect(path).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/generated\/images\/[0-9a-f-]{36}\.webp$/)
    expect(savedFiles).toEqual([{ path: path.slice(appDir.length + 1), content: bytes }])
    expect(storedImageFile(path, appDir)).toBe(savedFiles[0].path)
    expect(findImageReferences(imageMarkdown(path)).map((ref) => ref.path)).toEqual([path])
  })

  it('logs, shows an error toast, and rejects when the write fails', async () => {
    saveAppFile = async () => {
      throw 'Write error: No space left on device'
    }

    await expect(save(new Uint8Array([1]), 'image/png')).rejects.toBe('Write error: No space left on device')

    expect(consoleError).toHaveBeenCalledWith('Failed to save the image:', 'Write error: No space left on device')
    expect(toasts).toEqual([{
      title: 'Could not save the image',
      message: 'The system did not let Dez write the image file. The details tell why (for example, the disk is full). Fix that, and try again.\n\nDetails: Write error: No space left on device',
      variant: 'error',
    }])
  })

  it.each([
    ['a relative Dez folder ($HOME not set)', './.config/dez'],
    ['a Dez folder with a bracket', '/home/a]b/.config/dez'],
  ])('writes no file and rejects for %s, whose references would not render', async (_case, dir) => {
    appDir = dir

    await expect(save(new Uint8Array([1]), 'image/png')).rejects.toThrow(dir)

    expect(savedFiles).toEqual([])
    expect(toasts).toMatchObject([{ title: 'Could not save the image', variant: 'error' }])
  })
})

describe('dez.controller/images/delete', () => {
  function deleteImage(path: string): Promise<void> {
    return sbp('dez.controller/images/delete', path) as Promise<void>
  }

  it('deletes a stored image of this Dez folder by its app-file path', async () => {
    await deleteImage(`${appDir}/assets/images/red.png`)

    expect(deletedFiles).toEqual(['assets/images/red.png'])
    expect(toasts).toEqual([])
  })

  it('deletes a generated image of this Dez folder by its app-file path', async () => {
    await deleteImage(`${appDir}/assets/generated/images/red.webp`)

    expect(deletedFiles).toEqual(['assets/generated/images/red.webp'])
    expect(toasts).toEqual([])
  })

  it('deletes no file for an image of another Dez folder, even with a file of that name here', async () => {
    await deleteImage('/home/bob/.config/dez/assets/images/red.png')

    expect(deletedFiles).toEqual([])
    expect(toasts).toEqual([])
  })

  it('logs, shows an error toast, and rejects when the delete fails', async () => {
    deleteAppFile = async () => {
      throw 'Failed to delete assets/images/red.png: Permission denied (os error 13)'
    }

    await expect(deleteImage(`${appDir}/assets/images/red.png`)).rejects.toBe('Failed to delete assets/images/red.png: Permission denied (os error 13)')

    expect(consoleError).toHaveBeenCalledWith(`Failed to delete the image ${appDir}/assets/images/red.png:`, 'Failed to delete assets/images/red.png: Permission denied (os error 13)')
    expect(toasts).toEqual([{
      title: 'Could not delete the image',
      message: 'The system did not let Dez delete the image file. The details tell why (for example, Dez has no permission to change the folder). Fix that, and try again.\n\nDetails: Failed to delete assets/images/red.png: Permission denied (os error 13)',
      variant: 'error',
    }])
  })
})

// Unit tests have no DOM: a stand-in image of a known size, and a stand-in
// canvas that records what is drawn on it.
describe('dez.controller/images/redraw', () => {
  interface Drawn {
    canvas: string
    // The other canvas calls, in order.
    steps: string[]
    // The numbers of `drawImage`: the part of the image, then the place on
    // the canvas.
    numbers: number[]
    type: string
  }

  const SOURCE = new Blob([new Uint8Array([66, 77])], { type: 'image/bmp' })
  const DRAWN_BYTES = [9, 8, 7]

  function stubImage(width: number, height: number, decode: () => Promise<void> = () => Promise.resolve()): void {
    vi.stubGlobal('Image', class {
      src = ''
      naturalWidth = width
      naturalHeight = height
      decode = decode
    })
  }

  /** The drawings of the canvases of a test. `writes` is the type of the
   *  file that a canvas gives, when it is not the type that was asked. */
  function stubCanvas(writes?: string): Drawn[] {
    const drawn: Drawn[] = []
    vi.stubGlobal('document', {
      createElement: () => {
        const steps: string[] = []
        let numbers: number[] = []
        const step = (name: string) => (...args: unknown[]) => {
          steps.push([name, ...args].join(' '))
        }
        const context = {
          imageSmoothingQuality: 'low',
          fillStyle: '#000000',
          fillRect: (...args: number[]): void => step('fillRect')(context.fillStyle, ...args),
          translate: step('translate'),
          rotate: step('rotate'),
          scale: step('scale'),
          beginPath: step('beginPath'),
          rect: step('rect'),
          clip: step('clip'),
          // The pixels of the canvas, as one pixel whatever its size: a
          // transparent one before the draw, and a color after it, so that
          // a test sees the change of the colors of the drawn image.
          getImageData: (...args: number[]) => {
            step('getImageData')(...args)
            return { data: new Uint8ClampedArray(numbers.length ? [100, 150, 200, 255] : [0, 0, 0, 0]) }
          },
          putImageData: (pixels: { data: Uint8ClampedArray }, ...args: number[]) => step('putImageData')(`[${pixels.data.join(' ')}]`, ...args),
          drawImage(_image: unknown, ...drawNumbers: number[]) {
            numbers = drawNumbers
          },
        }
        const canvas = {
          width: 300,
          height: 150,
          getContext: () => context,
          toBlob(callback: (blob: Blob | null) => void, type: string) {
            drawn.push({ canvas: `${canvas.width}x${canvas.height}`, steps, numbers, type })
            callback(new Blob([new Uint8Array(DRAWN_BYTES)], { type: writes ?? type }))
          },
        }
        return canvas
      },
    })
    return drawn
  }

  function redraw(plan: (size: ImageSize) => ImageDrawing | null, mediaType: DrawnMediaType = 'image/png'): Promise<DrawnImage | null> {
    return sbp('dez.controller/images/redraw', SOURCE, plan, mediaType) as Promise<DrawnImage | null>
  }

  it('draws the part of the image that the plan names, at the size that the plan names', async () => {
    stubImage(400, 1000)
    const drawn = stubCanvas()
    const sizes: ImageSize[] = []

    const image = await redraw((size) => {
      sizes.push(size)
      return { crop: { x: 10, y: 20, width: 380, height: 950 }, width: 300, height: 750 }
    }, 'image/jpeg')

    expect(sizes).toStrictEqual([{ width: 400, height: 1000 }])
    expect(drawn).toStrictEqual([{ canvas: '300x750', steps: [], numbers: [10, 20, 380, 950, 0, 0, 300, 750], type: 'image/jpeg' }])
    expect(image).toStrictEqual({ bytes: new Uint8Array(DRAWN_BYTES), width: 300, height: 750 })
  })

  it('draws nothing for an image that the plan leaves as it is', async () => {
    stubImage(400, 1000)
    const drawn = stubCanvas()

    expect(await redraw(() => null)).toBeNull()
    expect(drawn).toStrictEqual([])
  })

  it('rejects for an image that the webview cannot decode, and asks for no plan', async () => {
    stubImage(0, 0, () => Promise.reject(new Error('unknown image format')))
    stubCanvas()
    const plan = vi.fn(() => null)

    await expect(redraw(plan)).rejects.toThrow('The image cannot be decoded.')
    expect(plan).not.toHaveBeenCalled()
  })

  it('rejects for an image with no size', async () => {
    stubImage(0, 0)
    stubCanvas()

    await expect(redraw(() => null)).rejects.toThrow('The image has no size.')
  })

  // WebKit maps the source rectangle to the viewBox of an SVG with no width
  // and height, so an SVG is drawn whole, and the crop is where it lands.
  it('draws an SVG whole, scaled and placed so that the crop fills the canvas', async () => {
    stubImage(300, 150)
    const drawn = stubCanvas()
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30"/>'], { type: 'image/svg+xml' })

    const image = await sbp('dez.controller/images/redraw', svg, () => ({ crop: { x: 100, y: 30, width: 100, height: 90 }, width: 50, height: 45 }), 'image/png')

    expect(drawn).toStrictEqual([{ canvas: '50x45', steps: [], numbers: [-50, -15, 150, 75], type: 'image/png' }])
    expect(image).toStrictEqual({ bytes: new Uint8Array(DRAWN_BYTES), width: 50, height: 45 })
  })

  it('paints the background, then draws the part at its size, mirrored, then turned, with its center at the center of the canvas', async () => {
    stubImage(400, 200)
    const drawn = stubCanvas()

    const image = await redraw(() => ({
      crop: { x: 0, y: 0, width: 400, height: 200 },
      width: 300,
      height: 500,
      partSize: { width: 400, height: 200 },
      flip: 'horizontal',
      turn: 90,
      background: '#ff8800',
    }))

    // The canvas applies the transforms to the part in reverse order.
    expect(drawn).toStrictEqual([{
      canvas: '300x500',
      steps: ['fillRect #ff8800 0 0 300 500', 'translate 150 250', `rotate ${Math.PI / 2}`, 'scale -1 1', 'translate -200 -100'],
      numbers: [0, 0, 400, 200, 0, 0, 400, 200],
      type: 'image/png',
    }])
    expect(image).toStrictEqual({ bytes: new Uint8Array(DRAWN_BYTES), width: 300, height: 500 })
  })

  it('mirrors top and bottom for a vertical flip, with the part at the size of the canvas', async () => {
    stubImage(400, 200)
    const drawn = stubCanvas()

    await redraw(() => ({ crop: { x: 0, y: 0, width: 400, height: 200 }, width: 40, height: 20, flip: 'vertical' }))

    expect(drawn).toStrictEqual([{
      canvas: '40x20',
      steps: ['translate 20 10', 'scale 1 -1', 'translate -20 -10'],
      numbers: [0, 0, 400, 200, 0, 0, 40, 20],
      type: 'image/png',
    }])
  })

  it('changes the colors of the whole canvas after the draw', async () => {
    stubImage(400, 200)
    const drawn = stubCanvas()

    await redraw(() => ({ crop: { x: 0, y: 0, width: 400, height: 200 }, width: 40, height: 20, colors: { kind: 'invert' } }))

    expect(drawn).toStrictEqual([{
      canvas: '40x20',
      steps: ['getImageData 0 0 40 20', 'putImageData [155 105 55 255] 0 0'],
      numbers: [0, 0, 400, 200, 0, 0, 40, 20],
      type: 'image/png',
    }])
  })

  // Drawn whole, the SVG would show outside of a part that does not fill
  // the canvas.
  it('clips a turned SVG to its part', async () => {
    stubImage(300, 150)
    const drawn = stubCanvas()
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30"/>'], { type: 'image/svg+xml' })

    await sbp('dez.controller/images/redraw', svg, () => ({ crop: { x: 100, y: 30, width: 100, height: 90 }, width: 80, height: 80, partSize: { width: 50, height: 45 }, turn: 45 }), 'image/png')

    expect(drawn).toStrictEqual([{
      canvas: '80x80',
      steps: ['translate 40 40', `rotate ${Math.PI / 4}`, 'translate -25 -22.5', 'beginPath', 'rect 0 0 50 45', 'clip'],
      numbers: [-50, -15, 150, 75],
      type: 'image/png',
    }])
  })

  it('draws the file type that the drawing names, in place of the type that the caller asks for', async () => {
    stubImage(40, 30)
    const drawn = stubCanvas()

    await redraw(({ width, height }) => ({ crop: { x: 0, y: 0, width, height }, width, height, turn: 45, mediaType: 'image/png' }), 'image/jpeg')

    expect(drawn.map(({ type }) => type)).toStrictEqual(['image/png'])
  })

  // The canvas of a webview that cannot write a type writes a PNG in its
  // place; a file with the wrong type must not go on under the type that
  // was asked.
  it('rejects when the canvas writes a file of another type', async () => {
    stubImage(40, 30)
    stubCanvas('image/png')

    await expect(redraw(({ width, height }) => ({ crop: { x: 0, y: 0, width, height }, width, height }), 'image/jpeg'))
      .rejects.toThrow('The image could not be drawn as image/jpeg.')
  })

  it('rejects with the error of a plan that throws', async () => {
    stubImage(40, 30)
    const drawn = stubCanvas()

    await expect(redraw(() => {
      throw new Error('The crop is outside the image.')
    })).rejects.toThrow('The crop is outside the image.')
    expect(drawn).toStrictEqual([])
  })
})

const ASSET_PATH = '/home/ann/Videos/dance.mp4'
const ASSET_URL = `asset://localhost${ASSET_PATH}`
let requests: { url: string, range: string | null }[] = []

/** Gives each request of the asset protocol the answer of `answer`, by the
 *  range that it asks for (null: the whole file). */
function stubAssets(answer: (range: string | null) => Response): void {
  requests = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range')
    requests.push({ url, range })
    return answer(range)
  })
}

/** A file that holds `content` and takes ranges, as the asset protocol
 *  does. */
function stubFile(content: string): void {
  stubAssets((range) => {
    if (range === null) return new Response(content, { headers: { 'Content-Type': 'video/mp4' } })
    if (content === '') return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */0' } })
    return new Response(content.slice(0, 1), { status: 206, headers: { 'Content-Range': `bytes 0-0/${content.length}` } })
  })
}

describe('dez.controller/images/fileSize', () => {
  function fileSize(): Promise<number | null> {
    return sbp('dez.controller/images/fileSize', ASSET_PATH) as Promise<number | null>
  }

  it.each([['hello', 5], ['', 0]])('gives the size of a file (%j) from a request of its first byte', async (content, size) => {
    stubFile(content)

    expect(await fileSize()).toBe(size)
    expect(requests).toStrictEqual([{ url: ASSET_URL, range: 'bytes=0-0' }])
  })

  it('gives no size for a missing file, and for an answer with no range', async () => {
    stubAssets(() => new Response(null, { status: 404 }))
    expect(await fileSize()).toBeNull()

    stubAssets(() => new Response('hello'))
    expect(await fileSize()).toBeNull()
  })
})

describe('dez.controller/images/readFile', () => {
  function readFile(options?: { maxBytes?: number }): Promise<File> {
    return sbp('dez.controller/images/readFile', ASSET_PATH, options) as Promise<File>
  }

  it.each(['hello', ''])('asks for the size first, and reads a file that is not too large (%j)', async (content) => {
    stubFile(content)

    const file = await readFile({ maxBytes: 5 })

    expect(requests).toStrictEqual([{ url: ASSET_URL, range: 'bytes=0-0' }, { url: ASSET_URL, range: null }])
    expect([file.name, file.type, await file.text()]).toStrictEqual(['dance.mp4', 'video/mp4', content])
  })

  it('rejects a file that is too large, with its size, without reading it', async () => {
    stubFile('hello')

    await expect(readFile({ maxBytes: 4 })).rejects.toStrictEqual(new FileTooLargeError(5, 4))
    expect(requests).toStrictEqual([{ url: ASSET_URL, range: 'bytes=0-0' }])
  })

  it('checks the size of the bytes read when the size request gives no size', async () => {
    stubAssets(() => new Response('hello'))

    await expect(readFile({ maxBytes: 4 })).rejects.toStrictEqual(new FileTooLargeError(5, 4))
    expect(requests).toHaveLength(2)
  })

  it('rejects when the file cannot be read', async () => {
    stubAssets(() => new Response(null, { status: 404 }))

    await expect(readFile({ maxBytes: 4 })).rejects.toThrow('The file cannot be read (HTTP 404).')
  })

  it('reads the file with one request when it has no size limit', async () => {
    stubFile('hello')

    const file = await readFile()

    expect(requests).toStrictEqual([{ url: ASSET_URL, range: null }])
    expect(await file.text()).toBe('hello')
  })
})
