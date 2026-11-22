# fft.js

A fast radix-4 FFT of real and complex values (npm `fft.js` 4.0.4, MIT).

Most work needs no direct call: `dez-media` has `rfft(x, n)` (as `np.fft.rfft`: it gives `{ re, im }`) and
`stft(y, { nfft, hop, window })`, which use fft.js. Read `/libs/dez-media/SKILL.md`.

## Import

```js
import FFT from "fft.js"                       // a script app, a UI page
const { default: FFT } = await import("fft.js") // js_eval: a literal name
```

## Use

```js
const fft = new FFT(1024)              // the size: a power of 2, 2 or more
const spectrum = fft.createComplexArray() // 2 × size values: re0, im0, re1, im1, …
fft.realTransform(spectrum, samples)   // samples: `size` real values
fft.completeSpectrum(spectrum)         // realTransform fills only the first half
const back = fft.createComplexArray()
fft.inverseTransform(back, spectrum)   // divides by the size
const real = fft.fromComplexArray(back) // the real parts
```

- `transform(out, data)` is the forward FFT of a complex array; `toComplexArray(real)` makes one from real values.
- The output array and the input array must be two different arrays.
- Bin k is `k × rate / size` Hz. The magnitude of bin k is `Math.hypot(spectrum[2 * k], spectrum[2 * k + 1])`.
- Pad a part of a signal with zeros to a power of 2, and multiply it by a window (`hann` of `dez-media`) first.
