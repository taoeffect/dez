"""The NumPy oracle of the tests of dez-media (src-tauri/libs/dez-media/).

Writes numpy.json next to this file: what NumPy gives for the inputs of the
tests. The tests (*.test.ts here) check that dez-media gives the same. Run it
with a Python that has NumPy 2, after a change of an input or of the code
below:

    python3 tests/dez-media/numpyOracle.py

The measurement code is that of the reference run that dez-media ports
(Opus's Python scripts beats.py, cuts.py, sync_check.py, and sfx_anchor of
build.py), nearly as it was. Each change that dez-media makes to it is marked
"dez-media:".

The small inputs are in numpy.json. The large ones (audio and frames) come
from the generators below, and testing.ts makes the same bytes in TypeScript:
both use only steps that IEEE doubles give the same in each language (+, -,
*, /, abs, and a 32-bit LCG), then round to float32 or uint8. numpy.json holds
the SHA-256 of each large input, so a test sees when the two differ.
"""
import hashlib
import json
import pathlib

import numpy as np

HERE = pathlib.Path(__file__).parent


# --- The shared generators (keep them the same as testing.ts) ---


class Lcg:
    """The 32-bit linear congruential generator of Numerical Recipes."""

    def __init__(self, seed):
        self.x = seed & 0xFFFFFFFF

    def next(self):
        self.x = (1664525 * self.x + 1013904223) & 0xFFFFFFFF
        return self.x

    def uniform(self):
        return self.next() / 4294967296.0


def click_track():
    """20 s at 22050 Hz: clicks at 123.05 BPM with a jitter of up to 9 ms,
    a louder click with a low hum on every fourth beat from the second, and
    6 loud clicks off the beat."""
    n = 22050 * 20
    r = Lcg(1)
    y = [(r.uniform() - 0.5) * 0.02 for _ in range(n)]
    k = 0
    while True:
        pos = 1000 + k * 10752 + r.next() % 401 - 200
        if pos + 3000 > n:
            break
        amp = 0.9 if k % 4 == 1 else 0.5
        env = 1.0
        for j in range(2000):
            y[pos + j] += amp * env * ((r.uniform() - 0.5) * 2)
            env *= 0.997
        if k % 4 == 1:
            env = 1.0
            for j in range(3000):
                y[pos + j] += 0.6 * env * (abs((j % 368) / 368 * 4 - 2) - 1)
                env *= 0.999
        k += 1
    for _ in range(6):
        pos = 5000 + r.next() % (n - 10000)
        env = 1.0
        for j in range(1500):
            y[pos + j] += 0.7 * env * ((r.uniform() - 0.5) * 2)
            env *= 0.996
    return np.array(y, dtype=np.float32)


def cut_frames_input():
    """48 RGB frames of 96x54: a scene with a moving square (frames 0-19),
    a cut to a second scene with one bright frame (27), and a cut to a dark
    scene (34-47)."""
    w, h, count = 96, 54, 48
    r = Lcg(2)
    out = bytearray()
    for t in range(count):
        for y in range(h):
            for x in range(w):
                if t < 20:
                    rgb = [(x * 2 + t * 3) % 256, (y * 4) % 256, 80]
                    if 20 <= y < 32 and 5 + 2 * t <= x < 17 + 2 * t:
                        rgb = [250, 250, 250]
                elif t < 34:
                    rgb = [200 - y * 2, (x + y + t) % 256, 30]
                    if t == 27:
                        rgb = [min(255, c + 120) for c in rgb]
                else:
                    rgb = [20 + x % 7, 15, 40 + y % 5]
                for c in rgb:
                    out.append(min(255, max(0, c + r.next() % 9 - 4)))
    return bytes(out)


def align_inputs():
    """At 8000 Hz: a song of 6 s (clicks at uneven gaps), a mix of 12 s with
    the song at 3.72 s under other noise and 3 bursts, and 12 s of noise."""
    r = Lcg(3)
    song = [(r.uniform() - 0.5) * 0.01 for _ in range(48000)]
    pos = 800
    while pos + 400 < 48000:
        amp = 0.3 + r.uniform() * 0.5
        env = 1.0
        for j in range(400):
            song[pos + j] += amp * env * ((r.uniform() - 0.5) * 2)
            env *= 0.99
        pos += 1500 + r.next() % 3500
    song32 = np.array(song, dtype=np.float32)
    mix = [(r.uniform() - 0.5) * 0.02 for _ in range(96000)]
    for j in range(48000):
        mix[29760 + j] += 0.7 * float(song32[j])
    for _ in range(3):
        pos = r.next() % 95000
        env = 1.0
        for j in range(800):
            mix[pos + j] += 0.6 * env * ((r.uniform() - 0.5) * 2)
            env *= 0.995
    noise = [(r.uniform() - 0.5) * 0.3 for _ in range(96000)]
    return song32, np.array(mix, dtype=np.float32), np.array(noise, dtype=np.float32)


def anchor_input():
    """1.5 s at 8000 Hz: a swell from 0.3 s to 0.5 s, a hit at 0.62 s, and
    a softer hit at 1.1 s."""
    r = Lcg(4)
    y = [(r.uniform() - 0.5) * 0.002 for _ in range(12000)]
    for i in range(2400, 4000):
        y[i] += (i - 2400) / 1600 * 0.4 * ((r.uniform() - 0.5) * 2)
    for start, amp in ((4960, 0.9), (8800, 0.5)):
        env = 1.0
        for i in range(start, start + 800):
            y[i] += amp * env * ((r.uniform() - 0.5) * 2)
            env *= 0.995
    return np.array(y, dtype=np.float32)


def sha256(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.astype("<f4").tobytes()).hexdigest()


# --- beats.py ---

SR = 22050
HOP = 256
NFFT = 2048


def stft_mag(y):
    win = np.hanning(NFFT).astype(np.float32)
    n = 1 + (len(y) - NFFT) // HOP
    idx = np.arange(NFFT)[None, :] + HOP * np.arange(n)[:, None]
    return np.abs(np.fft.rfft(y[idx] * win, axis=1))


def onset_env(mag, lo=0, hi=None):
    m = np.log1p(100 * mag[:, lo:hi])
    flux = np.maximum(0, np.diff(m, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")
    flux = np.maximum(flux, 0)
    return flux / (flux.std() + 1e-9)


def tempo(env, fps):
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    lags = np.arange(len(ac))
    bpm = 60 * fps / np.maximum(lags, 1)
    weight = np.exp(-0.5 * (np.log2(bpm / 120) / 0.9) ** 2)
    valid = (bpm > 70) & (bpm < 190)
    score = np.where(valid, ac * weight, 0)
    lag = int(np.argmax(score))
    # parabolic refinement
    a, b, c = score[lag - 1], score[lag], score[lag + 1]
    off = 0.5 * (a - c) / (a - 2 * b + c + 1e-9)
    return 60 * fps / (lag + off), lag + off


def track(env, period, tightness=100.0):
    n = len(env)
    score = env.copy()
    back = -np.ones(n, int)
    p = period
    for i in range(n):
        lo, hi = int(i - 2 * p), int(i - p / 2)
        if hi <= 0:
            continue
        lo = max(lo, 0)
        prev = np.arange(lo, hi)
        pen = -tightness * (np.log((i - prev) / p)) ** 2
        cand = score[prev] + pen
        k = int(np.argmax(cand))
        score[i] = env[i] + cand[k]
        back[i] = prev[k]
    # start from best near end
    tail = int(n - p)
    i = tail + int(np.argmax(score[tail:]))
    beats = []
    while i >= 0:
        beats.append(i)
        i = back[i]
    return np.array(beats[::-1])


def beat_grid(y):
    fps = SR / HOP
    mag = stft_mag(y)
    env = onset_env(mag)
    low = onset_env(mag, 0, int(150 / (SR / NFFT)))  # kick region
    bpm, period = tempo(env, fps)
    beats = track(env, period)
    strengths = [low[beats[ph::4]].mean() for ph in range(4)]
    phase = int(np.argmax(strengths))
    win = int(SR * 0.5)
    # dez-media: each whole 0.5 s (beats.py left out the last one when the
    # length was a multiple of 0.5 s), and no rounding.
    rms = [float(np.sqrt(np.mean(y[i:i + win] ** 2))) for i in range(0, len(y) - win + 1, win)]
    loudness = [20 * np.log10(r + 1e-9) for r in rms]
    peaks = [i for i in range(2, len(env) - 2) if env[i] == env[i - 2:i + 3].max() and env[i] > 3.0]
    peaks = sorted(peaks, key=lambda i: -env[i])[:60]
    return {
        "stftFrames": [0, 500, len(mag) - 1],
        "stftBins": list(range(0, NFFT // 2 + 1, 8)),
        "stft": mag[[0, 500, len(mag) - 1], ::8].tolist(),
        "frames": len(mag),
        "envelope": env.tolist(),
        "lowEnvelope": low.tolist(),
        "bpm": float(bpm),
        "period": float(period),
        "beats": beats.tolist(),
        "downbeatPhase": phase,
        "loudness": loudness,
        "accents": sorted(peaks),
    }


# --- cuts.py ---

W, H = 96, 54


def cut_frames(f):
    # 3x3 spatial grid of 8-bin-per-channel histograms; robust to motion, sensitive to shot changes
    feats = []
    for img in f:
        cells = []
        for gy in range(3):
            for gx in range(3):
                c = img[gy * H // 3:(gy + 1) * H // 3, gx * W // 3:(gx + 1) * W // 3]
                for ch in range(3):
                    h, _ = np.histogram(c[..., ch], bins=8, range=(0, 256))
                    cells.append(h / h.sum())
        feats.append(np.concatenate(cells))
    feats = np.array(feats)
    d = np.abs(np.diff(feats, axis=0)).sum(1) / 27  # 0..2 per cell, averaged
    pix = np.abs(np.diff(f, axis=0)).mean((1, 2, 3)) / 255
    score = d + pix
    cuts = []
    for i in range(len(score)):
        lo, hi = max(0, i - 4), min(len(score), i + 5)
        neigh = np.median(np.r_[score[lo:i], score[i + 1:hi]]) if hi - lo > 1 else 0
        if score[i] > 0.35 and score[i] > 3 * neigh + 0.08:
            cuts.append(i + 1)
    return cuts, score


# --- sync_check.py ---

ALIGN_RATE = 8000
ALIGN_HOP = 40  # 5 ms


def align_env(y):
    n = len(y) // ALIGN_HOP
    e = np.sqrt((y[:n * ALIGN_HOP].reshape(n, ALIGN_HOP) ** 2).mean(1) + 1e-12)
    d = np.maximum(0, np.diff(np.log(e + 1e-4)))
    return d - d.mean()


def align(song, mix, max_lag=6):
    song = align_env(song)
    mix = align_env(mix)
    # dez-media: sync_check.py correlated mix[:len(song) + 1200] with the whole
    # song, for offsets of 0 to 6 s. The same here when the mix is long enough
    # for that; with a shorter mix, the offsets go up to half the mix, and the
    # song is cut to fit the mix at each offset.
    lags = min(round(max_lag * ALIGN_RATE / ALIGN_HOP), len(mix) // 2)
    used = min(len(song), len(mix) - lags)
    corr = np.correlate(mix[:used + lags], song[:used], mode="valid")
    best = int(corr.argmax())
    # dez-media: the confidence is the normalized correlation at the offset.
    seg = mix[best:best + used]
    confidence = float(corr[best] / (np.sqrt(np.sum(song[:used] ** 2) * np.sum(seg ** 2)) + 1e-12))
    # dez-media: align also tries the frames of the mix from 3 more starts in
    # its first frame (`phases`, 4 by default), and keeps the best confidence.
    # The oracle is the search from the first sample only (`phases: 1`).
    return {"offset": best * ALIGN_HOP / ALIGN_RATE, "confidence": confidence}


def sync(cut_times, beat_times, delay):
    beats = np.array(beat_times) + delay
    times = np.array(cut_times)
    errs = [(t, (t - beats[np.abs(beats - t).argmin()]) * 1000) for t in times if t > delay - 0.1]
    return [{"time": float(t), "errorMs": float(e)} for t, e in errs]


# --- sfx_anchor of build.py ---


def sfx_anchor(y, anchor):
    rms = np.sqrt((y[: len(y) // 80 * 80].reshape(-1, 80) ** 2).mean(1))
    if anchor == "peak":
        return float(rms.argmax() * 0.01)
    return float(np.argmax(rms > 0.3 * rms.max()) * 0.01)


def onset_times(y, level=0.3):
    """dez-media: each onset over a level, which no script of the reference
    run had: a 10 ms frame whose RMS goes over level x the loudest frame, after
    the RMS fell to half of that."""
    rms = np.sqrt((y[: len(y) // 80 * 80].reshape(-1, 80) ** 2).mean(1))
    threshold = level * rms.max()
    onsets, armed = [], True
    for i, value in enumerate(rms):
        if armed and value > threshold:
            onsets.append(i * 0.01)
            armed = False
        elif not armed and value <= threshold / 2:
            armed = True
    return onsets


# --- The primitives ---


def primitives():
    r = Lcg(5)

    def values(n):
        return [r.uniform() * 2 - 1 for _ in range(n)]

    pairs = [(values(10), values(4)), (values(10), values(5)), (values(3), values(6)), (values(1), values(1))]
    x16, x64, x10, x9, x1000 = values(16), values(64), values(10), values(9), values(1000)
    hist = [0, 31.999, 32, 255, 256, 257, -1, 128, 64.5]
    edges = [-1, -0.6, -0.2, 0.2, 0.6, 1, 1.0000001, -1.5] + values(40)
    return {
        "hann": {str(m): np.hanning(m).tolist() for m in (0, 1, 2, 5, 16)},
        "rfft": [
            {"x": x, "n": n, "re": f.real.tolist(), "im": f.imag.tolist()}
            for x, n in ((x16, None), (x64, None), (x10, 16), (x64, 32))
            for f in [np.fft.rfft(np.array(x), n)]
        ],
        "diff": {"x": x9, "out": np.diff(x9).tolist()},
        "convolve": [
            {"a": a, "v": v, "mode": mode, "out": np.convolve(a, v, mode).tolist()}
            for a, v in pairs
            for mode in ("full", "same", "valid")
        ],
        "correlate": [
            {"a": a, "v": v, "mode": mode, "out": np.correlate(a, v, mode).tolist()}
            for a, v in pairs
            for mode in ("full", "same", "valid")
        ],
        "median": [{"x": x, "out": float(np.median(x))} for x in (x9, x10, [3.0], [2.0, 1.0])],
        "histogram": [
            {"x": hist, "bins": 8, "range": [0, 256], "counts": np.histogram(hist, 8, (0, 256))[0].tolist(),
             "edges": np.histogram(hist, 8, (0, 256))[1].tolist()},
            {"x": edges, "bins": 5, "range": [-1, 1], "counts": np.histogram(edges, 5, (-1, 1))[0].tolist(),
             "edges": np.histogram(edges, 5, (-1, 1))[1].tolist()},
            {"x": x1000, "bins": 10, "range": None, "counts": np.histogram(x1000)[0].tolist(),
             "edges": np.histogram(x1000)[1].tolist()},
            {"x": [5.0, 5.0, 5.0], "bins": 10, "range": None, "counts": np.histogram([5.0, 5.0, 5.0])[0].tolist(),
             "edges": np.histogram([5.0, 5.0, 5.0])[1].tolist()},
        ],
        "mean": {"x": x1000, "mean": float(np.mean(x1000)), "std": float(np.std(x1000))},
    }


def main():
    clicks = click_track()
    frames = cut_frames_input()
    song, mix, noise = align_inputs()
    anchors = anchor_input()
    cuts, scores = cut_frames(np.frombuffer(frames, np.uint8).reshape(-1, H, W, 3).astype(np.float32))
    sync_input = {
        "beats": [0.5 + 0.4651 * k for k in range(40)],
        "delay": 1.25,
        "cuts": [1.0, 1.18, 1.8, 2.66, 3.13, 5.0, 7.7, 30.0],
    }
    oracle = {
        "numpy": np.__version__,
        "inputs": {
            "clickTrack": sha256(clicks),
            "cutFrames": sha256(frames),
            "alignSong": sha256(song),
            "alignMix": sha256(mix),
            "alignNoise": sha256(noise),
            "anchors": sha256(anchors),
        },
        "primitives": primitives(),
        "beats": beat_grid(clicks),
        "cuts": {"cuts": cuts, "scores": scores.tolist()},
        "align": {
            "mix": align(song, mix),
            "shortMix": align(song, mix[:64000]),
            "noise": align(song, noise),
        },
        "sync": {**sync_input, "errors": sync(sync_input["cuts"], sync_input["beats"], sync_input["delay"])},
        "anchors": {
            "onset": sfx_anchor(anchors, "onset"),
            "peak": sfx_anchor(anchors, "peak"),
            "onsets": onset_times(anchors),
        },
    }
    text = json.dumps(oracle, indent=None, separators=(",", ":"), allow_nan=False)
    (HERE / "numpy.json").write_text(text + "\n")
    print(f"wrote numpy.json ({len(text)} bytes): bpm {oracle['beats']['bpm']:.3f}, "
          f"{len(oracle['beats']['beats'])} beats, cuts {cuts}, align {oracle['align']}, anchors {oracle['anchors']}")


if __name__ == "__main__":
    main()
