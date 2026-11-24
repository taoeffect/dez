# three.js

3D math, scenes, geometry, loaders, and exporters (npm `three` 0.187.0, MIT).

## Import

```js
import * as THREE from "three"
import { OBJExporter } from "three/addons/exporters/OBJExporter.js"
```

`js_eval` imports it with a literal name: `const THREE = await import("three")`.

`three/addons/` is the folder `examples/jsm/` of the package. Dez ships the addons of these folders: animation,
controls, curves, environments, exporters, geometries, helpers, lines, loaders, math, modifiers, postprocessing,
shaders, utils. `apps ls` of `/libs/three/examples/jsm/<folder>` lists the files.

## Where it works

- The page of a UI app: all of three.js, with `THREE.WebGLRenderer` on a `<canvas>` of the page. The import map of
  `index.html` gives the names.
- A script app and `js_eval` (Deno): no renderer. Deno has no `document`, no WebGL, and no WebGPU, so
  `new THREE.WebGLRenderer()` throws "document is not defined". These work: the math (vectors, matrices,
  `Box3`, `Raycaster`), the geometries and `BufferGeometryUtils`, scenes, cameras, and the exporters
  `OBJExporter`, `STLExporter`, and `GLTFExporter` (`parseAsync(scene, { binary: true })` gives a GLB
  `ArrayBuffer`).

There is no network. Load a file from its bytes, not from a URL:
`await new GLTFLoader().parseAsync((await Deno.readFile(path)).buffer, "")`.

Dez keeps no 3D file as an image or a clip. Write an OBJ, STL, or GLB file into the work folder of the conversation
(`${dez.workFolder}/model.glb`, which the `apps` tool names `/work/model.glb`).

## A picture of a scene in a script app

Project each vertex, then fill the triangles with skia-canvas (read `/libs/skia-canvas/SKILL.md`):

```ts
camera.updateMatrixWorld()
const p = new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld).project(camera) // x, y, z from -1 to 1
const px = ((p.x + 1) / 2) * width
const py = ((1 - p.y) / 2) * height
```

Draw the far triangles first (sort by `p.z`, the largest first). Shade each one from its normal and a light
direction. For a clip, draw each frame on a canvas and give it to `FrameWriter` of `dez-media/frames`.

## Not shipped

- The addons that import `three/webgpu` or `three/tsl`, the MaterialX loader, and `TTFLoader` (it loads
  opentype.js from a CDN). update-libs left out 20 such modules.
- The DRACO and KTX2/Basis decoders: `DRACOLoader` and `KTX2Loader` cannot decode.
