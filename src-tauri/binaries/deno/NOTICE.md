# Deno in Dez

<!-- Written by scripts/update-deno.js. Do not edit it by hand. -->

Dez ships the program of the [Deno](https://deno.com/) project next to its own program, as `dez-deno`. Dez runs it as a separate program. It is not a part of the Dez program, and the license of Dez does not apply to it.

- Deno version: 2.9.8
- Release: [v2.9.8](https://github.com/denoland/deno/releases/tag/v2.9.8)

The program is the file `deno` of a zip file of that release. `manifest.json` of the folder above this one has, for each platform, the zip file with its size and its SHA-256, and the size and the SHA-256 of the program. Dez does not change the code of the program. The tools that build a Dez bundle can change other parts of its file: in the AppImage, the program has one more library search path. This file is for the Dez version of this branch or tag: for another Dez version, read it at the tag of that version.

## License

Deno has the [MIT License](https://github.com/denoland/deno/blob/v2.9.8/LICENSE.md).

The program also holds code of other projects, each with its own license: the V8 JavaScript engine and the libraries that V8 is built with (ICU is one), and the Rust crates that Deno is built with.

## License texts

`LICENSES.txt` has the license texts. The Deno project publishes no list of the code in the program, so the texts come from a rule, not from a list of names. The rule takes each file with the name of a license file (`LICENSE`, `COPYING`, `NOTICE`, and the like) of these sources, but not the files of their tests:

- The Deno source of the release (`deno_src.tar.gz`).
- [rusty_v8](https://github.com/denoland/rusty_v8) at the version of the `v8` crate of the release (150.4.0), and each Git submodule of it at the commit that it pins: all of the V8 source, and the top folder of each other one (ICU, Abseil, libc++, and more).
- Each Rust crate that `Cargo.lock` of the Deno source names, from the crate file of crates.io that the lock pins.

The head of each text names the files that have it, each with its source. The end of `LICENSES.txt` lists each crate with the license that it states: some crates have no license file of their own.

The rule takes more than the program holds: a crate that only another platform uses, a tool of the build, or a part of a source that is not compiled into the program. So a text in `LICENSES.txt` does not tell that the program holds the code of that text.

The Dez bundle ships `LICENSES.txt` and this file in the `deno` folder of its resources.

## Source code

- Deno 2.9.8: <https://github.com/denoland/deno/tree/v2.9.8>
- The Rust crates: <https://crates.io/>, each at the version that [`Cargo.lock`](https://github.com/denoland/deno/blob/v2.9.8/Cargo.lock) names
- V8, as Deno builds it: <https://github.com/denoland/rusty_v8/tree/v150.4.0>

## Another version

`node scripts/update-deno.js <version>` gets the programs of another release, checks them, and writes them, their part of `manifest.json`, `LICENSES.txt`, and this file.
