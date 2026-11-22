// The ES module entry of skia-canvas for Dez, written by scripts/update-libs.js
// from lib/index.mjs. The package is CommonJS, so this file loads index.js
// with `require`, as Node does.
import { createRequire } from 'node:module';

const skiaCanvas = createRequire(import.meta.url)('./index.js');

export default skiaCanvas;
export const {
  Canvas,
  CanvasGradient,
  CanvasPattern,
  CanvasTexture,
  Image,
  ImageData,
  loadImage,
  loadImageData,
  loadCanvas,
  Path2D,
  DOMPoint,
  DOMMatrix,
  DOMRect,
  FontLibrary,
  TextMetrics,
  CanvasRenderingContext2D,
  App,
  Window,
} = skiaCanvas;
