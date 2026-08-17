# Implementation Roadmap & Architecture

## Project Status

**Current State:** Feature-complete
- ✅ GLB parsing (vertex color, textured, material color, monochrome)
- ✅ k-means clustering in Lab color space + auto material detection (inertia elbow)
- ✅ 3MF authoring (multi-mesh, one object per material + Bambu extruder config)
- ✅ Client-side blob download (3MF + segmented GLB)
- ✅ PWA (offline support)
- ✅ Matches webCLI line UI/UX
- ✅ **Textured GLB support** — in-browser decode + per-face UV sampling
- ✅ **3D viewer** — three.js preview, segment picking
- ✅ **Cluster merging** — merge materials post-segmentation
- ⏳ **Material color editor** — planned (color picker / reassignment brush)

---

## Phase 1 (MVP - Current)

**Goal:** Core segmentation pipeline + slicer validation

### Completed

- [x] **File I/O**
  - Drag-drop GLB input
  - Client-side blob download
  - No network calls

- [x] **GLB Parsing**
  - Binary GLB format (magic, version, chunks)
  - Extract geometry (positions, indices, normals)
  - Detect color mode (vertex / material / monochrome)
  - Per-vertex color sampling (COLOR_0 attribute)

- [x] **Color Clustering**
  - k-means in Lab color space (perceptually uniform)
  - Seeded RNG for determinism (same input → same output)
  - Configurable N (2–8 materials)
  - Lab ↔ RGB color space conversions (sRGB gamma, D65 illuminant)

- [x] **3MF Authoring**
  - Valid ZIP container structure
  - Multi-mesh model: one `<object>` per material (`pid="1"`, unique `pindex`), assembled as components of a root object; production namespace + UUIDs
  - `Metadata/model_settings.config` maps each part to a distinct extruder (filament slot)
  - Correct `[Content_Types].xml` and `_rels/.rels`

- [x] **UI/UX**
  - Three-panel layout (input | viewer | output)
  - Dark theme matching ffmpeg/whisper webCLI line
  - Material swatch display
  - Status messages (info/success/error/warning)
  - Responsive grid layout

- [x] **PWA**
  - Service worker for offline caching
  - `manifest.json` with icons, shortcuts, share_target
  - COOP/COEP headers via `server.js`

### Testing Needed

- **Bambu Studio import:**
  - ✓ GLB from Pythia (vertex color) → 3MF → Bambu Studio
  - ✓ Material colors appear in object tree
  - ✓ Per-face assignments preserved
  - ✓ Mesh remains watertight
  
- **PrusaSlicer import:**
  - ✓ Same GLB → 3MF → PrusaSlicer
  - ✓ Material assignments persist
  - ✓ No faces lost or duplicated

- **Edge cases:**
  - ✓ Monochrome GLB (single color)
  - ✓ Large GLB (>100K faces)
  - ✓ Offline workflow (load app, cache service worker, go offline, convert)

---

## Phase 2 (Texture Support) — ✅ Done

**Goal:** Handle textured GLBs (baseColorTexture + UVs)

### Tasks

- [x] **UV → Pixel Sampling**
  - Extract `baseColorTexture` and UV coordinates (TEXCOORD_0)
  - Decode embedded image via `createImageBitmap` + `OffscreenCanvas` (downscaled to ≤1024)
  - Sample texture at face centroid UV (repeat wrap), multiply by `baseColorFactor`
  - Missing/failed textures fall back gracefully to material/monochrome

- [x] **Texture Image Loading**
  - Inline PNG/JPEG in the GLB binary chunk
  - Async decode with graceful failure

- [x] **Updated Color Detection**
  - Priority: textured > vertex > material > monochrome
  - Reports the detected mode accurately

- [ ] **Testing**
  - Pythia baked-texture export
  - Blender baked mesh
  - High-res textures (2K, 4K)
  - Missing texture gracefully falls back

### Implementation Hints

```javascript
// Sketch for texture sampling
const texture = await loadImageFromGLB(textureIdx);
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
ctx.drawImage(texture, 0, 0);

for (const face of faces) {
  const uvCentroid = getUVCentroid(face); // [0-1, 0-1]
  const pixelX = uvCentroid[0] * texture.width;
  const pixelY = uvCentroid[1] * texture.height;
  const imageData = ctx.getImageData(pixelX, pixelY, 1, 1);
  face.color = [imageData.data[0]/255, imageData.data[1]/255, imageData.data[2]/255];
}
```

---

## Phase 3 (3D Viewer & Material Editor)

**Goal:** Visual feedback + interactive material labeling

### Tasks

- [x] **3D Viewer** (`viewer.js`, three.js from CDN)
  - Load and display the GLB in the center panel
  - Segmented preview: one mesh per cluster with its material color
  - Raycast click-to-select a segment (highlight + fade others)
  - Orbit/zoom/pan controls

- [x] **Cluster Merging** (in lieu of a full editor)
  - Merge any material into another from the swatch list or 3D view
  - Dense relabel + median-RGB recolor; palette/viewer/exports update live

- [ ] **Material Editor UI** (planned)
  - Editable material names
  - Color picker (hex input or click to adjust)
  - Manual per-face reassignment brush

---

## Phase 4 (Advanced Features)

**Goal:** Mesh quality checks + optional repair hints

### Tasks

- [x] **Small-Region Cleanup**
  - Tiny clusters (< 2% of faces) merged into nearest by mean color
  - Small connected components (< 1% of faces) dissolved into dominant border label

- [x] **Multi-Mesh Support**
  - All meshes/primitives in the GLB are processed and merged into one vertex list

- [x] **Segmented GLB Export**
  - Binary glTF with one mesh per material (via `GLTFExporter`)

- [ ] **Reconstruction Quality Report** (planned)
  - Detect spikes, thin features, non-manifold edges and warn (do not fix)

- [ ] **Auto boundary re-tessellation** (planned) for crisper color edges

---

## Testing Strategy

### Unit Tests (Planned)

```javascript
// glb-parser.test.js
test('parses vertex-colored GLB', async () => {
  const buffer = fs.readFileSync('test-vertex-color.glb');
  const result = GLBParser.parse(buffer);
  expect(result.metadata.colorMode).toBe('vertex');
  expect(result.faces.length).toBeGreaterThan(0);
});

// color-clusterer.test.js
test('deterministic k-means clustering', () => {
  const colors = [[1,0,0], [1,0.5,0], [0,1,0]];
  const result1 = ColorClusterer.cluster(colors, 2, { seed: 42 });
  const result2 = ColorClusterer.cluster(colors, 2, { seed: 42 });
  expect(result1.assignments).toEqual(result2.assignments);
});

// 3mf-authorer.test.js
test('creates valid 3MF ZIP structure', async () => {
  const buffer = await ThreeMFAuthorer.author(faces, positions, colors, assignments);
  const zip = await JSZip.loadAsync(buffer);
  expect(zip.file('3D/3dmodel.model')).toBeDefined();
  expect(zip.file('[Content_Types].xml')).toBeDefined();
});
```

### Integration Tests (Planned)

```javascript
// e2e.test.js
test('end-to-end: load GLB → cluster → download 3MF', async () => {
  const glbFile = fs.readFileSync('test-model.glb');
  const glbData = await GLBParser.parse(glbFile.buffer);
  const clusters = ColorClusterer.cluster(glbData.faceColors, 4);
  const 3mf = await ThreeMFAuthorer.author(
    glbData.faces, glbData.positions, 
    clusters.centroids, clusters.assignments
  );
  expect(3mf.byteLength).toBeGreaterThan(0);
  // Validate ZIP structure
  const zip = await JSZip.loadAsync(3mf);
  expect(zip.file('3D/3dmodel.model')).toBeDefined();
});
```

### Manual Slicer Tests

1. **Bambu Studio**
   - Load test GLB (vertex, textured, monochrome)
   - Convert to 3MF
   - Import into Bambu Studio
   - Verify colors appear
   - Bind filaments
   - Slice and inspect preview

2. **PrusaSlicer**
   - Same workflow
   - Check material assignments per face

3. **Edge Cases**
   - Large mesh (>500K faces)
   - Many materials (N=8)
   - Monochrome → 1 material
   - Offline mode

---

## Architecture Decisions

### Why Lab Color Space?

- **RGB** is device-specific; doesn't match human perception
- **Lab** (CIELAB) is perceptually uniform: distances in Lab ≈ perceived color difference
- **Cost:** Extra math (sRGB gamma, XYZ conversion) but worth it for quality

### Why k-means (not median-cut)?

- **Simpler to implement** (no tree structure)
- **Faster** on Web Workers
- **Deterministic seeding** ensures reproducibility
- Could swap for median-cut later if quality improves

### Why Per-Face Assignment (not re-tessellation)?

- **Preserves watertightness** — no cracks at cluster boundaries
- **Simpler** — just change material IDs, not geometry
- **Faster** — no re-meshing
- **Trade-off:** Geometry stays as-is; reconstruction artifacts (spikes, thin features) remain visible. This is by design.

### Why One CDN Dependency (three.js)?

- **App logic stays dependency-free:** parser, clusterer, and authorer are pure browser APIs
- **three.js** powers only the 3D viewer + segmented GLB export; loaded via an import map from CDN and cached by the service worker for offline use
- **No build step:** serve `docs/` directly; no bundler or npm install needed to run
- **Draw from webCLI line:** ffmpeg-webCLI and whisper-webCLI keep the same lean, static-PWA shape

### Why GPL-3.0?

- **Consistent** with ffmpeg-webCLI and whisper-webCLI
- **Copyleft** — derivative works must also be open
- **Compatible** with LGPL (ffmpeg.wasm), MIT (three.js), etc.

---

## File Size & Performance

### Current Bundle Size

```
docs/ (app code, excluding three.js which loads from CDN)
├── index.html
├── style.css
├── app.js                   controller + orchestration
├── glb-parser.js            parsing + color extraction + texture sampling
├── color-clusterer.js       Lab k-means pipeline + auto-detect
├── 3mf-authorer.js          multi-mesh 3MF + Bambu config
├── viewer.js                three.js viewer + GLB export
├── download-handler.js      blob download
└── service-worker.js        offline caching
```

App code is small and ships uncompressed; three.js is fetched once from CDN and cached by the service worker.

### Performance Targets

- **Load time:** <2s (first load), <500ms (cached)
- **Parse GLB:** <500ms for 100K faces
- **Cluster colors:** <2s for 1M faces (k-means 50 iterations)
- **Author 3MF:** <1s for 500K faces
- **Total pipeline:** <5s for typical GLB (50K faces)

Use Web Workers if clustering becomes a bottleneck.

---

## Future Integration Points

### Strata-Editor Integration

`strata-editor` is a 3D scene editor with three.js + selectors + AI. Future paths:

- **Import 3MF result** into strata-editor for mesh cleanup (future `mesh-webCLI`)
- **Material labeling** via strata's selector language
- **Reuse three.js viewer** from strata (not isolated yet)

### Pythia Integration

Pythia is the origin of the segmentation technique. Future paths:

- **Pythia export→3mf-webCLI import** — test suite
- **Shared clustering logic** — maybe extract into standalone npm package
- **Documentation** — link both projects

### Mesh-webCLI (Future Sibling)

Clean/repair mesh artifacts before segmentation:

```
GLB → mesh-webCLI (repair spikes, thin features) → 3mf-webCLI (segment) → 3MF
```

---

## Resources

- **3MF Spec:** https://3mf.io/specification/
- **glTF Spec:** https://www.khronos.org/registry/glTF/specs/2.0/glTF-2.0.html
- **Lab Color Space:** https://en.wikipedia.org/wiki/CIELAB_color_space
- **k-means:** https://en.wikipedia.org/wiki/K-means_clustering
- **Three.js:** https://threejs.org/ (powers the 3D viewer + segmented GLB export; loaded from CDN)
- **Pythia (Reference):** https://github.com/FoxyNinjaStudios/pythia

---

## Contributing Guidelines

1. **Keep modules small & focused** — one job per file
2. **No heavy dependencies** — stick to browser APIs
3. **Test locally** — `node server.js` then open http://127.0.0.1:8008
4. **Validate slicer compatibility** — test in Bambu Studio and PrusaSlicer
5. **Document changes** — update README if user-facing
6. **Match webCLI line style** — dark theme, CLI UX, privacy-first messaging

---

**Questions?** See [QUICKSTART.md](QUICKSTART.md) or open an [issue](https://github.com/tejaswigowda/3mf-webCLI/issues).
