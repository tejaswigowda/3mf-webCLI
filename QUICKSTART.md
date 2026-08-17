# Quick Start Guide

## For Users

### 1. Open the App

Visit: **https://tejaswigowda.com/3mf-webCLI/**

Or install as a PWA:
- Click the **Install** button in your browser (address bar or menu)
- The app works offline after first load

### 2. Load a GLB

- **Drag & drop** a `.glb` file onto the input zone
- Or click **Select File** to browse

Supported formats:
- `.glb` (binary glTF — recommended, smaller file size)
- `.gltf` (text glTF) + external buffers (`.bin` files in same folder — NOT supported for drag-drop; use `.glb`)

### 3. Choose Material Count

Leave **Auto-detect material count** checked (default) and the app picks the natural palette size from the model's colors. Or uncheck it and set the slider to match your printer:
- **Bambu AMS**: 4 materials
- **Prusa MMU2S**: 5 materials
- **Custom**: 2–8 as needed

### 4. Segment

Click **⚡ Cluster & Segment** to run the pythia-style pipeline (chroma-weighted Lab k-means + edge-aware smoothing + MRF refinement).

The material palette appears with a hex color and face count per cluster, and the 3D viewer switches to the segmented preview.

### 5. Inspect & Refine (optional)

- **Click a swatch** or a region in the 3D viewer to highlight that segment in isolation.
- **Merge materials**: click a swatch's merge button, then click the target material (swatch or 3D region). **Esc** cancels.

### 6. Download

- **⬇ Download 3MF** → `<name>.3mf` for your slicer
- **⬇ Download segmented GLB** → `<name>-segmented.glb` (one mesh per material, for further editing)

### 7. Import into Your Slicer

#### Bambu Studio
```
File → Import Model → select .3mf
```
Materials appear in the object tree. Map each to your loaded filaments.

#### PrusaSlicer
```
File → Open Project/Model → select .3mf
```
Materials appear with per-face assignments. Configure nozzle/slot mapping.

---

## For Developers

### Local Development

```bash
# Clone
git clone https://github.com/tejaswigowda/3mf-webCLI.git
cd 3mf-webCLI

# Install (optional; only needed if you add npm dependencies)
npm install

# Dev server (serves docs/ with COOP/COEP headers)
node server.js

# Open http://127.0.0.1:8008
```

### Project Structure

```
docs/                          # Static PWA assets (served by GitHub Pages)
├── index.html                 # Main UI
├── style.css                  # Dark theme styles
├── manifest.json              # PWA metadata
├── service-worker.js          # Offline caching
├── app.js                     # Controller & orchestration
├── glb-parser.js              # GLB binary parsing + color extraction + texture sampling
├── color-clusterer.js         # Lab k-means pipeline + auto material detection
├── 3mf-authorer.js            # 3MF ZIP/XML generation (multi-mesh + Bambu config)
├── viewer.js                  # three.js viewer + segmented GLB export
└── download-handler.js        # Client-side download

server.js                       # Node.js dev server (COOP/COEP headers)
package.json                    # Metadata + scripts
LICENSE                         # GPL-3.0
.gitignore                      # Git ignore rules
.github/workflows/deploy.yml    # GitHub Pages deployment
```

### Adding Features

**Modules are intentionally minimal and independent:**

- **GLB Parser** → Color detection (vertex / texture / material / monochrome) + texture sampling
- **Color Clusterer** → Lab k-means pipeline + inertia-elbow auto material detection; deterministic via seeded RNG
- **3MF Authorer** → Valid ZIP + XML; multi-mesh (one object per material) + Bambu extruder config
- **Viewer** → three.js preview, segment picking, segmented GLB export
- **Download Handler** → Blob download

To extend:

1. Add a new `.js` module in `docs/`
2. Import it in `app.js` 
3. Call it in the conversion pipeline
4. Test locally via `node server.js`

### Deploying Updates

Push to `main`:

```bash
git add .
git commit -m "Feature: Add texture sampling"
git push origin main
```

The GitHub Actions workflow (`.github/workflows/deploy.yml`) automatically:
1. Verifies all required files exist
2. Deploys `docs/` to GitHub Pages

Live at: https://tejaswigowda.com/3mf-webCLI/ (usually within 1–2 minutes)

### Testing

No automated tests yet (TODO). Manual testing:

1. **Vertex color GLB** — From Pythia or hand-painted vertex color
2. **Textured GLB** — From a 3D generation tool with baked textures (texture is decoded in-browser and sampled per face)
3. **Material color GLB** — From Blender untextured export
4. **Monochrome GLB** — Plain single-color mesh (degrades to one material)

For each:
- Verify color mode detection
- Try N=2, 4, 8 materials (and Auto-detect)
- Import into Bambu Studio and PrusaSlicer
- Confirm each color lands in its own filament slot and prints correctly

---

## Troubleshooting

### "Invalid GLB file"

- Ensure the file is a valid `.glb` (binary glTF)
- Check file size > 0 bytes
- Try downloading a test GLB from https://github.com/FoxyNinjaStudios/pythia/tree/main/samples

### Material colors don't match input

- Clustering in Lab space is perceptually uniform, not exact RGB
- Same GLB + same N always produces the same result (seeded k-means)
- If result looks wrong, file an issue with a test case

### Downloaded 3MF doesn't import into slicer

- Verify 3MF is valid: rename to `.zip` and check structure:
  ```
  3D/3dmodel.model
  Metadata/model_settings.config
  _rels/.rels
  [Content_Types].xml
  ```
- Check slicer version (old versions may not support per-face material)
- Open DevTools, check browser console for errors

### Service Worker not working offline

- First load must happen online (to cache assets)
- Clear cache: DevTools → Application → Storage → Clear site data
- Reload page
- Go offline and retry

---

## Known Limitations

1. **Texture sampling is per-face** (UV centroid) — faces spanning multiple texel colors get one representative sample.
2. **Embedded textures only** — external `.gltf` + separate image files are not supported; use `.glb`.
3. **Uncompressed geometry only** — Draco / meshopt compressed GLBs are rejected with a clear message; re-export without compression.
4. **No boundary re-tessellation** — material edges follow existing faces (preserves watertightness).

---

## Contributing

Issues and PRs welcome!

- **Bug reports** — Include GLB file (if shareable) and browser DevTools console
- **Feature requests** — See roadmap in main README
- **Code contributions** — Keep it lean; no heavy dependencies

---

## License

GPL-3.0 — See [LICENSE](LICENSE)

---

**Questions?** Open an [issue](https://github.com/tejaswigowda/3mf-webCLI/issues) or check the [main README](README.md).
