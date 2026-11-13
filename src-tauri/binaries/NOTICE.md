# ffmpeg and ffprobe in Dez

<!-- Written by scripts/update-ffmpeg.js. Do not edit it by hand. -->

Dez ships two programs of the [FFmpeg](https://ffmpeg.org/) project next to its own program: `dez-ffmpeg` (ffmpeg) and `dez-ffprobe` (ffprobe). Dez runs them as separate programs. They are not a part of the Dez program, and the license of Dez does not apply to them.

- FFmpeg version: n8.1.2
- Builder: the Shaka Project, [shaka-project/static-ffmpeg-binaries](https://github.com/shaka-project/static-ffmpeg-binaries)
- Release: [n8.1.2-2](https://github.com/shaka-project/static-ffmpeg-binaries/releases/tag/n8.1.2-2)

The files of this folder are the files of that release, not changed. `manifest.json` has the release file, the size, and the SHA-256 of each one. This file is for the Dez version of this branch or tag: for another Dez version, read it at the tag of that version.

## License

The programs have the [GNU General Public License, version 3](https://www.gnu.org/licenses/gpl-3.0.html) or later: the builds are configured with `--enable-gpl --enable-version3`, and without `--enable-nonfree`. `dez-ffmpeg -L` prints the license terms, and `dez-ffmpeg -version` prints the configuration.

## Source code

- FFmpeg n8.1.2: <https://git.ffmpeg.org/gitweb/ffmpeg.git/tag/refs/tags/n8.1.2> (a copy: <https://github.com/FFmpeg/FFmpeg/tree/n8.1.2>)
- The build scripts, and the versions of the libraries that the builds hold (`versions.txt`): <https://github.com/shaka-project/static-ffmpeg-binaries/tree/n8.1.2-2>

## Another version

`node scripts/update-ffmpeg.js <release tag>` gets the files of another release, checks them, and writes them, `manifest.json`, and this file.
