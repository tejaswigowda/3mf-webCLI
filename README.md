# 3mf webCLI

[![GitHub stars](https://img.shields.io/github/stars/tejaswigowda/3mf-webCLI?style=social)](https://github.com/tejaswigowda/3mf-webCLI/stargazers)

A browser-based GLB-to-3MF converter with **color-based material segmentation** for multi-material 3D printing.
<b><ins>No uploads, no servers - all processing happens locally</ins></b> in your browser. Pure ES modules - no build step, no npm dependencies (three.js loaded from CDN and cached for offline use).

▶ **Live app:** https://tejaswigowda.com/3mf-webCLI/

> Third member of the **webCLI** family, alongside [**ffmpeg-webCLI**](https://github.com/tejaswigowda/ffmpeg-webCLI) (video) and [**whisper-webCLI**](https://github.com/tejaswigowda/whisper-webCLI) (audio). Same philosophy: sovereign, offline-first, client-side. Your file never leaves your machine.

---

## Key Features

✓ **No Server Uploads** : All 3D processing happens entirely on your device

✓ **Works on Any GLB** : Designed for any source - Blender, Meshy, Tripo, Sketchfab, photogrammetry, or anywhere

✓ **Four Color Inputs** : Detects and segments whatever the GLB carries:
  - Per-vertex color (`COLOR_0`, VEC3/VEC4, all glTF component types incl. normalized integers)
  - Textured meshes (`baseColorTexture` sampled at each face's UV centroid)
  - Material base-color factors (untextured, per-primitive colors)
  - Monochrome (graceful degrade to a single material)

✓ **Perceptual Color Segmentation** : chroma-weighted Lab k-means with multi-restart, edge-aware label smoothing, MRF refinement, and small-region cleanup (see [Segmentation Pipeline](#segmentation-pipeline))

✓ **Interactive 3D Viewer** : three.js preview of the original and segmented model - click a segment (or its swatch) to highlight it in isolation

✓ **Cluster Merging** : Combine any two materials after segmentation with two clicks - no need to re-run

✓ **Auto Material Detection** : Finds the natural number of materials straight from the model's colors (no ML - a simple inertia-elbow heuristic). On by default; toggle off for a fixed count

✓ **User-Selectable Material Count** : Or cluster down to a fixed 2-8 materials to match your printer's slot count (e.g., 4 for Bambu AMS, MMU for Prusa)

✓ **Two Export Formats** : Multi-material **3MF** for slicers, plus a **segmented GLB** (one mesh per material) for further editing

✓ **Deterministic** : Seeded clustering - same GLB + same N always produces the same result

✓ **Watertight Preservation** : Geometry untouched; material assignment is per-face without re-tessellation

✓ **Offline-First PWA** : Works completely offline after first use; install as a native app

✓ **Privacy First** : Zero data collection; works with your files locally

---

## When to use this instead of external tools

Cloud tools like Bambu Studio's model library or online mesh converters handle these tasks but upload your file to a server. Some are free with ads, some charge, but all of them see your file.

**3mf-webCLI** does color-based material segmentation and multi-material 3MF export **all in your browser, for free**. Reach for it when:

- Your 3D model is private or commercial
- You can't install software
- You'd rather not upload
- You want watertight-clean 3MF output tested in your slicer

Your file never leaves your device.

---

## How It Works

### Step 1: Load GLB

Drag & drop or select a `.glb` (binary glTF 2.0) file. The app parses every mesh and primitive, then detects which color representation the model carries:

- **Per-vertex color** (`COLOR_0`) - hand-painted vertex color or engine/reconstruction export
- **Textured** (`baseColorTexture` + UVs) - most DCC / photogrammetry / AI-reconstruction output. The embedded texture is decoded in-browser and sampled at each face's UV centroid.
- **Material-based** (untextured per-primitive `baseColorFactor`)

If the model is monochrome (one color), the app degrades gracefully to a single-material 3MF. The original model appears in the 3D viewer immediately.

### Step 2: Configure Material Count

Leave **Auto-detect material count** checked (default) to let the app pick the natural palette size from the model's colors, or uncheck it and set **N** (2-8) manually to match your printer's slot count:
- **4** for Bambu AMS (CMYK-style)
- **2-5** for Prusa MMU (2-5 slot configurations)

### Step 3: Segment

Click **Cluster & Segment**. The app runs the [segmentation pipeline](#segmentation-pipeline): perceptual clustering plus spatial regularization over the face-adjacency graph. Clusters that end up too small or too similar are merged automatically, so the final count can be lower than N.

### Step 4: Inspect & Refine

- **Click a swatch** - or a region in the 3D viewer - to highlight that segment in isolation (other segments fade out).
- **Merge materials**: press the merge button on a swatch, then click the target material (swatch or 3D region). The face assignments, palette, and viewer update instantly. Press **Esc** to cancel.

### Step 5: Download

- **Download 3MF** - a valid 3MF package with N materials (hex colors) and per-triangle material assignment; geometry and watertightness preserved.
- **Download segmented GLB** - a binary glTF with one mesh per material (`Segment_N` / `Material_N`), handy for further editing in Blender etc.

Both are client-side blob downloads. No round-trip.

---

## Usage

### 1. Open the App

Visit https://tejaswigowda.com/3mf-webCLI/ in a modern browser (Chrome, Edge, Firefox, Safari).

### 2. Load Your GLB

- **Drag & drop** a `.glb` file into the input zone
- Or click the drop zone to browse

The app displays the detected color mode (vertex / textured / material / monochrome), face count, and a live 3D preview (drag to rotate, scroll to zoom, right-drag to pan).

### 3. Choose Material Count

Keep **Auto-detect material count** on (default) to detect the palette size automatically, or uncheck it and adjust the **Materials** slider (2-8) to match your printer's configuration.

### 4. Segment

Click **Cluster & Segment**. The material palette appears with a hex color and face count per cluster, and the viewer switches to the segmented preview.

### 5. Inspect & Merge

- Click any **swatch** or any **region of the 3D model** to highlight that segment (click again to deselect).
- Click a swatch's **merge button**, then click the material to fold it into - in the palette or directly in the 3D view. **Esc** cancels.

### 6. Download

- **Download 3MF** → `<name>.3mf`
- **Download segmented GLB** → `<name>-segmented.glb`

### 7. Import into Your Slicer

#### Bambu Studio

1. File → Import Model
2. Select the `.3mf`
3. The model loads with color regions assigned to materials
4. Configure each material to your loaded filaments
5. Slice and print

#### PrusaSlicer

1. File → Open Project/Model
2. Select the `.3mf`
3. The model loads with per-face material assignments
4. Configure each material to your nozzle/slot
5. Slice and print

---

## Technical Details

### Color Extraction

| Mode | Input | Sampling Method |
|------|-------|-----------------|
| **Per-vertex (`COLOR_0`)** | RGB or RGBA vertex attribute (float / normalized u8 / u16) | Average of three face vertices |
| **Textured** | `baseColorTexture` (embedded PNG/JPEG) + `TEXCOORD_0` | Texture decoded in-browser (`createImageBitmap`, downscaled to ≤1024), sampled at the face's UV centroid with repeat wrap, multiplied by `baseColorFactor` |
| **Material-based** | `pbrMetallicRoughness.baseColorFactor` | Direct per-primitive color |
| **Monochrome** | Single color or missing data | Graceful degrade to 1-material 3MF |

The parser handles all glTF component types, interleaved/strided buffer views, non-indexed primitives, and multiple meshes/primitives per file.

### Segmentation Pipeline

An independent implementation of a perceptual color-segmentation pipeline. Plain k-means on face colors falls apart on real-world models - baked lighting splits one part into light/dark bands and photographic noise produces speckle. The pipeline counters both:

1. **Chroma-weighted Lab** - colors are converted to Lab and the lightness channel is scaled by **0.35**, so hue drives the clustering and baked shading doesn't create brightness bands.
2. **k-means++ × 3 restarts** - three seeded runs; the one with the lowest inertia wins. Deterministic: same input + same N ⇒ same output.
3. **Edge-aware label smoothing** - up to 8 rounds of weighted majority voting over the face-adjacency graph. Neighbor votes are weighted by color similarity (`w = 0.6 + 0.4·exp(−(ΔLab/18)²)`), so smoothing doesn't bleed across real color boundaries.
4. **MRF refinement (ICM)** - each face minimizes `dataCost − 24 · neighborAgreement`, where the data cost is the Lab distance to each part's mean color. Up to 20 sweeps.
5. **Tiny-cluster merge** - clusters holding < 2 % of faces are folded into the nearest remaining cluster by mean color.
6. **Small-island dissolve** - connected same-label components smaller than 1 % of faces are reassigned to the label they share the most boundary edges with (≤ 8 passes).

Face adjacency is built by welding vertices at quantized positions, so meshes with duplicated vertices (non-indexed / textured) still form a proper adjacency graph. Final material colors are the per-channel **median RGB** of each cluster's faces. The final cluster count can be lower than the requested N (merged-away clusters are reported in the log).

#### Auto Material Detection

When **Auto-detect material count** is on, the app first estimates the natural palette size before running the pipeline above - no ML, just a simple **inertia elbow** heuristic:

1. Sample up to 4,000 face colors (for speed) and run chroma-weighted Lab k-means for **k = 1..8**, recording each run's inertia (within-cluster sum of squares).
2. If k = 1 already explains the colors (total drop < 15 %), the model is treated as effectively single-color and clamps to the 2-material minimum.
3. Otherwise the inertia curve is normalized to `[0,1]` on both axes, and the detected k is the **elbow** - the point of maximum perpendicular distance from the line joining the first and last points. This is the classic "knee of the curve" where adding more materials stops paying off.

The detected count is written back to the Materials slider and logged, then the normal segmentation pipeline runs with that N.

### Interactive Editing

- **Segment selection** - the segmented preview is one three.js mesh per cluster; raycast picking highlights the clicked segment (emissive boost) and fades the rest. Swatch list and viewer stay in sync.
- **Cluster merging** - any material can be merged into another after segmentation: labels are reassigned and renumbered densely, the target's dominant color is recomputed (median RGB), and palette/viewer/exports all reflect the merge immediately.

### 3MF Format

Output is a ZIP file containing:

```
3mf-file.3mf
├── 3D/3dmodel.model                # XML: geometry + basematerials + component assembly
├── Metadata/model_settings.config  # Bambu part→extruder (filament slot) mapping
├── _rels/.rels                     # Package relationships
└── [Content_Types].xml             # Content type declarations
```

**Material Assignment:** multi-mesh approach: one `<object>` per material, each with `pid="1"` and unique `pindex` (0..N-1). All material objects are assembled as `<components>` of a root object (highest id), which is referenced in the `<build>` section. The model tag declares the production namespace (`xmlns:p`) and every object/component/build item carries a `p:UUID`. This structure is **natively supported** by modern slicers (Bambu Studio, PrusaSlicer) without per-triangle ambiguity.

**Filament mapping:** `Metadata/model_settings.config` lists each material mesh as a `part` bound to a distinct `extruder` (1..N). Without this file Bambu Studio treats the whole assembly as a single filament — it is what makes each color land in its own AMS slot on import.

**Watertightness:** Preserved because faces stay intact; only geometry bucketing changes.

### Slicer Compatibility

**Tested & Working:**
- ✓ **Bambu Studio** - Each material mesh imports as a separate part pre-bound to its own filament slot (via `model_settings.config`); adjust the filament colors/types to taste
- ✓ **PrusaSlicer** - Imports the multi-object assembly; materials resolve to nozzle/slot config

**Known Quirks:**
- Filament *type* is not set (only the slot mapping); pick the actual filament for each slot in the slicer.
- If you delete or reorder parts in the slicer, the extruder mapping changes accordingly - re-export to reset.

---

## Architecture

```
docs/
├── index.html          UI (inline styles, ffmpeg-webCLI design language)
├── app.js              Controller - orchestrates the pipeline, swatches, merging
├── glb-parser.js       GLB/glTF parsing + color extraction + texture sampling
├── color-clusterer.js  Perceptual color segmentation pipeline
├── 3mf-authorer.js     3MF ZIP/XML authoring with per-face material assignment
├── viewer.js           three.js viewer - preview, segment picking, GLB export
├── download-handler.js Client-side blob download
└── service-worker.js   PWA caching for offline support
```

**`glb-parser.js`** - Parses the GLB container and every mesh/primitive; extracts positions, faces, and per-face colors (vertex color, texture samples, or material factors)

**`color-clusterer.js`** - `segmentFaces()`: chroma-weighted Lab k-means (×3 restarts) + face-adjacency smoothing + MRF refinement + small-region cleanup. `autoDetectK()`: inertia-elbow auto material count. Seeded and deterministic

**`3mf-authorer.js`** - Authors a valid 3MF ZIP/XML: one mesh per material, each as a separate object with `pid="1"` and unique `pindex`, all assembled as components of a root object

**`viewer.js`** - three.js scene: original + segmented previews, raycast segment picking, binary GLB export via `GLTFExporter`

**`app.js`** - Controller; orchestrates the pipeline, renders the material palette, and implements cluster merging

**`service-worker.js`** - PWA caching (app files + three.js CDN modules) for offline support

### Browser APIs

- **File API** - Local file selection & drag-drop
- **createImageBitmap / OffscreenCanvas** - In-browser texture decoding & sampling
- **WebGL (three.js)** - 3D preview and segment picking
- **Blob & URL.createObjectURL** - Client-side download
- **Service Worker** - Offline caching & PWA install

### No Build Step

Pure browser APIs + ES modules. No npm packages, no bundler. three.js is loaded via an import map from CDN and cached by the service worker for offline use. Static PWA served as-is from GitHub Pages.

---

## Known Limitations & Future Work

### Limitations

1. **Texture sampling is per-face** (UV centroid). Faces spanning multiple texture colors get one representative sample; densely tessellated models are unaffected.

2. **No boundary re-tessellation.** Material boundaries follow existing face edges; faces are never split. This preserves watertightness at the cost of boundary precision on coarse meshes. Single-material output is geometry-clean; multi-material output follows existing faces and does not add speckle at cluster boundaries (small stray regions are dissolved by the small-region cleanup pass, which runs before both the 3MF and GLB exports).

3. **Reconstruction artifacts:** If the input GLB has roughness (spikes, thin features), those stay visible after segmentation. This is by design - the tool surfaces input quality; it does not repair mesh.

4. **Embedded textures only.** `.glb` with textures in the binary chunk is supported; external `.gltf` + separate image files are not.

5. **Uncompressed geometry only.** GLBs that require `KHR_draco_mesh_compression` or `EXT_meshopt_compression` are rejected with a clear message - re-export without compression.

### Next

- [x] Auto material count (inertia-elbow detection - no ML)
- [ ] Material color picker & manual reassignment brush
- [ ] Optional boundary re-tessellation for crisper color edges
- [ ] Mesh repair hints

---

## Running Locally

### Prerequisites

- Node.js 14+ (only for the dev server - the app itself has no dependencies)
- A modern browser (Chrome, Edge, Firefox, Safari 15+)

### Setup

```bash
git clone https://github.com/tejaswigowda/3mf-webCLI.git
cd 3mf-webCLI

# Start the development server
node server.js

# Open http://127.0.0.1:8008 in your browser
```

The app itself needs no special HTTP headers. The bundled dev server also sets
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`, but these are optional
and not required for any current feature.

### Deployment

Deploy the `docs/` folder to any static host:

- **GitHub Pages** - Enable in repo settings; serve from `docs/`
- **Vercel / Netlify / Cloudflare Pages** - Drag & drop the `docs/` folder
- **Traditional web server** - Copy `docs/` to the web root

No special HTTP headers are required - the app runs from any plain static host.

---

## Privacy & Security

**Zero-egress verification:**

1. Open DevTools (F12) → Network tab
2. Load the app and convert any GLB
3. Observe **zero outbound requests during conversion** - only initial asset loads. No telemetry, no analytics, no external API calls

**Data storage:**

- Service worker caches static assets for offline use
- No user data is transmitted or stored server-side
- No persistent local storage (files don't survive a browser clear)

---

## License

This project is licensed under the **GNU General Public License v3.0** (GPL-3.0).

### License Summary

You are free to:

✓ Use this software for any purpose

✓ Study and modify the source code

✓ Distribute copies of the software

✓ Distribute modified versions

With the requirement that you:

▢ Include a copy of the license

✎ Document changes made to the code

◆ Make source code available when distributing

See [LICENSE](LICENSE) for full details.

---

## Related Projects

- [**ffmpeg-webCLI**](https://github.com/tejaswigowda/ffmpeg-webCLI) - Browser-based video editor. Video processing pipeline for the webCLI family.
- [**whisper-webCLI**](https://github.com/tejaswigowda/whisper-webCLI) - Browser-based speech-to-text transcriber. Audio processing pipeline for the webCLI family.
- [**strata-editor**](https://github.com/tejaswigowda/strata-editor) - Browser-based 3D scene editor with deterministic selector language. Future basis for advanced mesh editing in 3mf-webCLI.

---

## Acknowledgments

- **Segmentation:** an independent implementation of a chroma-weighted Lab clustering + edge-aware smoothing + MRF refinement pipeline.
- **Design inspiration:** [ffmpeg-webCLI](https://github.com/tejaswigowda/ffmpeg-webCLI) and [whisper-webCLI](https://github.com/tejaswigowda/whisper-webCLI) - the coherent webCLI line's pattern and ethos.
- **3MF Spec:** https://3mf.io/specification/
- **Feedback & testing:** Community contributions and slicer validation (Bambu Studio, PrusaSlicer).

---

**Questions?** Open an [issue](https://github.com/tejaswigowda/3mf-webCLI/issues) or submit a PR.