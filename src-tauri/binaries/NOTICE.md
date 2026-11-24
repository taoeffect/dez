# ffmpeg and ffprobe in Dez

<!-- Written by scripts/update-ffmpeg.js. Do not edit it by hand. -->

Dez ships two programs of the [FFmpeg](https://ffmpeg.org/) project next to its own program: `dez-ffmpeg` (ffmpeg) and `dez-ffprobe` (ffprobe). Dez runs them as separate programs. They are not a part of the Dez program, and the license of Dez does not apply to them.

- FFmpeg version: n9.0.2
- Builder: Dez, [taoeffect/dez-ffmpeg](https://github.com/taoeffect/dez-ffmpeg), from the build scripts of the Shaka Project, [shaka-project/static-ffmpeg-binaries](https://github.com/shaka-project/static-ffmpeg-binaries)
- Release: [n9.0.2-6](https://github.com/taoeffect/dez-ffmpeg/releases/tag/n9.0.2-6)

The programs and `LICENSES.txt` are files of that release, not changed. `manifest.json` has the release file, the size, and the SHA-256 of each one. This file is for the Dez version of this branch or tag: for another Dez version, read it at the tag of that version.

## License

The programs have the [GNU General Public License, version 3](https://www.gnu.org/licenses/gpl-3.0.html) or later: the builds are configured with `--enable-gpl --enable-version3`, and without `--enable-nonfree`. `dez-ffmpeg -L` prints the license terms, and `dez-ffmpeg -version` prints the configuration.

## Libraries

The programs hold these libraries. Their versions are in [`versions.txt`](https://github.com/taoeffect/dez-ffmpeg/blob/n9.0.2-6/versions.txt) of the release.

- [libvpx](https://chromium.googlesource.com/webm/libvpx): the BSD 3-Clause License
- [SVT-AV1](https://gitlab.com/AOMediaCodec/SVT-AV1): the BSD 3-Clause Clear License
- [x264](https://code.videolan.org/videolan/x264): the GNU General Public License, version 2 or later
- [x265](https://bitbucket.org/multicoreware/x265_git): the GNU General Public License, version 2 or later
- [LAME](https://lame.sourceforge.io/): the GNU Library General Public License, version 2 or later
- [Opus](https://opus-codec.org/): the BSD 3-Clause License
- [zlib](https://zlib.net/): the zlib License
- [FreeType](https://freetype.org/): the FreeType License (FTL)
- [HarfBuzz](https://github.com/harfbuzz/harfbuzz): the MIT License ("Old MIT")
- [FriBidi](https://github.com/fribidi/fribidi): the GNU Lesser General Public License, version 2.1 or later
- [libass](https://github.com/libass/libass): the ISC License
- [Rubber Band Library](https://breakfastquay.com/rubberband/): the GNU General Public License, version 2 or later
- [vid.stab](https://github.com/georgmartius/vid.stab): the GNU General Public License, version 2 or later; its sse2neon part (only in the macOS files): the MIT License
- [musl (only in the Linux files)](https://musl.libc.org/): the MIT License

FreeType: Portions of this software are copyright © The FreeType Project (https://freetype.org). All rights reserved.

## License texts

`LICENSES.txt` has the license texts of FFmpeg and of each library, copied from the source code of the build. The Dez bundle ships it and this file in the `ffmpeg` folder of its resources.

## Source code

- FFmpeg n9.0.2: <https://git.ffmpeg.org/gitweb/ffmpeg.git/tag/refs/tags/n9.0.2> (a copy: <https://github.com/FFmpeg/FFmpeg/tree/n9.0.2>)
- The build scripts, which get the source of each library at the version of `versions.txt`: <https://github.com/taoeffect/dez-ffmpeg/tree/n9.0.2-6>

## Another version

`node scripts/update-ffmpeg.js <release tag>` gets the files of another release, checks them, and writes them, `manifest.json`, and this file.
