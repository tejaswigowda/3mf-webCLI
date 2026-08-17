/**
 * 3mf-webCLI Application Controller
 *
 * Orchestrates GLB parsing, color clustering, 3MF authoring, download,
 * and the three.js viewer. UI patterned after ffmpeg-webCLI.
 */

import GLBParser from './glb-parser.js';
import ColorClusterer from './color-clusterer.js';
import ThreeMFAuthorer from './3mf-authorer.js';
import DownloadHandler from './download-handler.js';
import Viewer from './viewer.js';

const $ = (id) => document.getElementById(id);

/* ── helpers ── */

function fmtBytes(b) {
  if (b === 0) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function addLog(msg, type = '', icon = '') {
  const log = $('log');
  const line = document.createElement('div');
  line.className = `log-line ${type}`.trim();
  line.textContent = `${icon ? icon + ' ' : ''}${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function rgbToHex([r, g, b]) {
  const h = (c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function setStatus(text, dotState = '') {
  $('statusText').textContent = text;
  $('statusDot').className = `dot ${dotState}`.trim();
}

function setProgress(show, label = '', pct = 0) {
  $('progWrap').classList.toggle('hidden', !show);
  if (show) {
    $('progLabel').textContent = label;
    $('progPct').textContent = `${Math.round(pct)}%`;
    $('progFill').style.width = `${pct}%`;
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/* ── app ── */

class App {
  constructor() {
    this.state = {
      fileName: null,
      fileSize: 0,
      glbData: null,        // { faces, metadata, positions, bin }
      clusterResult: null,  // { clusters, centroids, assignments }
      materialColors: [],
      faceAssignments: null,
    };

    this.viewer = new Viewer($('viewerShell'));
    this.viewer.onSegmentSelect = (idx) => {
      if (this._mergeSource !== null && idx !== null) {
        this.mergeClusters(this._mergeSource, idx);
        return;
      }
      this._syncSwatchSelection(idx);
    };
    this._selectedSegment = null;
    this._mergeSource = null;

    this._bindUI();
    this._registerServiceWorker();
  }

  _bindUI() {
    const dz = $('dropZone');
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('over');
      const file = e.dataTransfer?.files?.[0];
      if (file) this._handleFile(file);
    });

    $('fileInput').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) this._handleFile(file);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancelMerge();
    });
  }

  async _registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
      addLog('Service worker registered - app works offline', 'ok');
      setInterval(() => reg.update().catch(() => {}), 60000);
    } catch (err) {
      addLog(`Service worker registration failed: ${err.message}`, 'warn');
    }
  }

  /* ── input ── */

  async _handleFile(file) {
    if (!/\.glb$/i.test(file.name)) {
      addLog(`"${file.name}" is not a .glb file`, 'err');
      return;
    }

    setStatus(`Parsing ${file.name}…`, 'loading');
    addLog(`Loading ${file.name} (${fmtBytes(file.size)})`);

    try {
      const buffer = await file.arrayBuffer();
      this.state.glbData = await GLBParser.parse(buffer);
      this.state.fileName = file.name;
      this.state.fileSize = file.size;
      this.state.clusterResult = null;
      this.state.faceAssignments = null;

      const { faces, metadata } = this.state.glbData;

      // Show file details
      $('inputWrap').classList.remove('hidden');
      $('fileProps').innerHTML =
        `<strong>File:</strong> ${file.name}<br>` +
        `<strong>Faces:</strong> ${faces.length.toLocaleString()}<br>` +
        `<strong>Color mode:</strong> ${metadata.colorMode}`;
      $('inputMeta').textContent = fmtBytes(file.size);

      $('segmentBtn').disabled = false;
      $('downloadBtn').disabled = true;
      $('downloadGlbBtn').disabled = true;
      $('matTag').style.display = 'none';
      $('swatches').innerHTML = '<div class="swatch-empty">Segment a model to see its material palette here</div>';
      $('outMeta').textContent = '';
      this._selectedSegment = null;

      // 3D preview
      $('viewerEmpty').classList.add('hidden');
      await this.viewer.loadGLB(buffer);
      this._setViewButtons('original', false);

      setStatus(`Loaded ${file.name} - ${faces.length.toLocaleString()} faces (${metadata.colorMode})`, 'loaded');
      addLog(`Parsed ${faces.length.toLocaleString()} faces - color mode: ${metadata.colorMode}`, 'ok');
    } catch (err) {
      setStatus(`Failed to load ${file.name}`, '');
      addLog(`Parse error: ${err.message}`, 'err');
      console.error(err);
    }
  }

  clearInput() {
    this.state = { fileName: null, fileSize: 0, glbData: null, clusterResult: null, materialColors: [], faceAssignments: null };
    this._selectedSegment = null;
    this._mergeSource = null;
    $('swatches').classList.remove('merging');
    $('fileInput').value = '';
    $('inputWrap').classList.add('hidden');
    $('segmentBtn').disabled = true;
    $('downloadBtn').disabled = true;
    $('downloadGlbBtn').disabled = true;
    $('matTag').style.display = 'none';
    $('swatches').innerHTML = '<div class="swatch-empty">Segment a model to see its material palette here</div>';
    $('outMeta').textContent = '';
    $('viewerEmpty').classList.remove('hidden');
    this.viewer.clear();
    this._setViewButtons('original', true);
    setStatus('Drop a GLB file to begin - everything runs locally in your browser');
    addLog('Input cleared');
  }

  /* ── segmentation ── */

  async segment() {
    if (!this.state.glbData) return;

    const { faces, positions } = this.state.glbData;
    const auto = $('autoDetect')?.checked;
    let k = parseInt($('matCount').value, 10);

    if (auto) {
      k = ColorClusterer.autoDetectK(faces, { minK: 2, maxK: 8 });
      $('matCount').value = k;
      $('matCountVal').textContent = k;
      addLog(`Auto-detected ${k} material${k === 1 ? '' : 's'} from color distribution (inertia elbow)`);
    }

    $('segmentBtn').disabled = true;
    setStatus(`Segmenting ${faces.length.toLocaleString()} faces into ${k} materials…`, 'loading');
    addLog(`Pythia-style segmentation (k=${k}): chroma-weighted Lab k-means ×3 restarts + edge-aware smoothing + MRF refinement…`);
    setProgress(true, 'Clustering & refining…', 15);
    await nextFrame();

    try {
      const result = ColorClusterer.segmentFaces(faces, positions, k);

      setProgress(true, 'Building preview…', 70);
      await nextFrame();

      this.state.clusterResult = result;
      this.state.materialColors = result.centroids;
      this.state.faceAssignments = result.assignments;
      const finalK = result.centroids.length;

      // Swatches (clickable - selects the segment in the 3D viewer)
      this._selectedSegment = null;
      this._mergeSource = null;
      this._renderSwatches();

      // Segmented 3D preview
      this.viewer.showSegmentation(positions, faces, this.state.faceAssignments, this.state.materialColors);
      this._setViewButtons('segmented', false);

      setProgress(true, 'Done', 100);
      await nextFrame();
      setProgress(false);

      $('downloadBtn').disabled = false;
      $('downloadGlbBtn').disabled = false;
      setStatus(`Segmented into ${finalK} materials - click a segment to inspect it, or download`, 'loaded');
      addLog(`Segmentation complete - ${finalK} materials assigned across ${faces.length.toLocaleString()} faces`, 'ok');
      if (finalK < k) addLog(`Note: ${k - finalK} cluster(s) merged away (too small or too similar)`, 'warn');
    } catch (err) {
      setProgress(false);
      setStatus('Segmentation failed', '');
      addLog(`Clustering error: ${err.message}`, 'err');
      console.error(err);
    } finally {
      $('segmentBtn').disabled = !this.state.glbData;
    }
  }

  /* ── output ── */

  async download() {
    const { glbData, materialColors, faceAssignments, fileName } = this.state;
    if (!glbData || !faceAssignments) return;

    setStatus('Authoring 3MF…', 'loading');
    addLog('Building 3MF (ZIP + 3D/3dmodel.model XML)…');
    
    // Debug: log material info
    const matCounts = Array.from({ length: materialColors.length }, () => 0);
    faceAssignments.forEach(mat => matCounts[mat]++);
    materialColors.forEach((rgb, i) => {
      const hex = rgbToHex(rgb);
      addLog(`  Material ${i}: ${hex} (${matCounts[i] || 0} faces)`);
    });
    
    await nextFrame();

    try {
      const threeMF = await ThreeMFAuthorer.author(
        glbData.faces,
        glbData.positions,
        materialColors,
        faceAssignments,
      );

      const outName = (fileName || 'model').replace(/\.glb$/i, '') + '.3mf';
      DownloadHandler.download(threeMF, outName, 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');

      $('outMeta').textContent = `${outName} - ${fmtBytes(threeMF.byteLength)}`;
      setStatus(`Downloaded ${outName}`, 'loaded');
      addLog(`Downloaded ${outName} (${fmtBytes(threeMF.byteLength)})`, 'ok');
    } catch (err) {
      setStatus('3MF authoring failed', '');
      addLog(`3MF error: ${err.message}`, 'err');
      console.error(err);
    }
  }

  /* ── viewer ── */

  /**
   * Render material swatch rows (with per-row merge buttons) and the tag.
   */
  _renderSwatches() {
    const { materialColors, clusterResult } = this.state;
    const k = materialColors.length;
    $('swatches').innerHTML = materialColors.map((rgb, i) => {
      const hex = rgbToHex(rgb);
      const count = clusterResult.clusters[i]?.length ?? 0;
      const mergeBtn = k > 1
        ? `<button class="swatch-merge" title="Merge this material into another" onclick="event.stopPropagation(); app.startMerge(${i})"><i class="fa-solid fa-code-merge"></i></button>`
        : '';
      return `<div class="swatch-row" data-idx="${i}" onclick="app.selectSegment(${i})" title="Click to highlight this segment">
        <span class="swatch-idx">${i + 1}</span>
        <span class="swatch-color" style="background:${hex}"></span>
        <span class="swatch-hex">${hex}</span>
        <span class="swatch-count">${count.toLocaleString()} faces</span>
        ${mergeBtn}
      </div>`;
    }).join('');
    $('matTag').textContent = `${k} cluster${k === 1 ? '' : 's'}`;
    $('matTag').style.display = '';
  }

  /* ── cluster merging ── */

  /**
   * Enter merge mode: the next clicked material (swatch or viewer segment)
   * becomes the merge target for cluster `idx`.
   */
  startMerge(idx) {
    if (this._mergeSource === idx) { this.cancelMerge(); return; }
    this._mergeSource = idx;
    $('swatches').classList.add('merging');
    document.querySelectorAll('.swatch-row').forEach((row) => {
      row.classList.toggle('merge-source', Number(row.dataset.idx) === idx);
    });
    this.viewer.selectSegment(idx);
    this.setView('segmented');
    setStatus(`Merging material ${idx + 1} - click the material to merge it into (Esc to cancel)`, 'loading');
    addLog(`Merge mode: pick a target for material ${idx + 1} (Esc cancels)`);
  }

  cancelMerge() {
    if (this._mergeSource === null) return;
    this._mergeSource = null;
    $('swatches').classList.remove('merging');
    document.querySelectorAll('.swatch-row').forEach((row) => row.classList.remove('merge-source'));
    this.viewer.selectSegment(null);
    this._selectedSegment = null;
    setStatus('Merge cancelled', 'loaded');
    addLog('Merge cancelled');
  }

  /**
   * Merge cluster `src` into cluster `dst`: reassign faces, renumber labels
   * densely, recompute the target's dominant color, rebuild UI + viewer.
   */
  mergeClusters(src, dst) {
    if (src === dst) { this.cancelMerge(); return; }
    const { glbData, faceAssignments, materialColors } = this.state;
    if (!glbData || !faceAssignments) return;

    const srcHex = rgbToHex(materialColors[src]);
    const dstHex = rgbToHex(materialColors[dst]);

    // Reassign src → dst, then drop src by decrementing higher labels
    const assignments = faceAssignments.map((l) => {
      if (l === src) l = dst;
      return l > src ? l - 1 : l;
    });
    const newDst = dst > src ? dst - 1 : dst;

    const newColors = materialColors.filter((_, i) => i !== src);

    // Rebuild clusters and recompute merged cluster's dominant color (median RGB)
    const clusters = Array.from({ length: newColors.length }, () => []);
    assignments.forEach((l, f) => clusters[l].push(f));
    const faces = glbData.faces;
    newColors[newDst] = [0, 1, 2].map((ch) => {
      const vals = clusters[newDst].map((f) => (faces[f].color || [0.5, 0.5, 0.5])[ch]).sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)];
    });

    this.state.faceAssignments = assignments;
    this.state.materialColors = newColors;
    this.state.clusterResult = { clusters, centroids: newColors, assignments };

    this._mergeSource = null;
    this._selectedSegment = null;
    $('swatches').classList.remove('merging');

    this._renderSwatches();
    this.viewer.showSegmentation(glbData.positions, faces, assignments, newColors);
    this._setViewButtons('segmented', false);

    const k = newColors.length;
    setStatus(`Merged ${srcHex} into ${dstHex} - ${k} material${k === 1 ? '' : 's'} remaining`, 'loaded');
    addLog(`Merged material ${srcHex} into ${dstHex} - ${k} material${k === 1 ? '' : 's'} remaining`, 'ok');
  }

  /**
   * Toggle selection of a segment (from swatch click or viewer raycast).
   */
  selectSegment(idx) {
    if (this._mergeSource !== null) {
      this.mergeClusters(this._mergeSource, idx);
      return;
    }
    const next = this._selectedSegment === idx ? null : idx;
    this.viewer.selectSegment(next);
    this.setView('segmented');
    this._syncSwatchSelection(next);
  }

  _syncSwatchSelection(idx) {
    this._selectedSegment = idx;
    document.querySelectorAll('.swatch-row').forEach((row) => {
      row.classList.toggle('selected', Number(row.dataset.idx) === idx);
    });
    if (idx !== null && this.state.clusterResult) {
      const count = this.state.clusterResult.clusters[idx]?.length ?? 0;
      setStatus(`Segment ${idx + 1} selected - ${count.toLocaleString()} faces (click again to deselect)`, 'loaded');
    }
  }

  /**
   * Export the segmented model as a binary GLB (one mesh per material).
   */
  async downloadGLB() {
    if (!this.viewer.segmentedGroup) return;

    setStatus('Exporting segmented GLB…', 'loading');
    addLog('Exporting segmented GLB (one mesh per material)…');
    await nextFrame();

    try {
      const glb = await this.viewer.exportSegmentedGLB();
      const outName = (this.state.fileName || 'model').replace(/\.glb$/i, '') + '-segmented.glb';
      DownloadHandler.download(glb, outName, 'model/gltf-binary');

      setStatus(`Downloaded ${outName}`, 'loaded');
      addLog(`Downloaded ${outName} (${fmtBytes(glb.byteLength)})`, 'ok');
    } catch (err) {
      setStatus('GLB export failed', '');
      addLog(`GLB export error: ${err.message}`, 'err');
      console.error(err);
    }
  }

  setView(mode) {
    this.viewer.setMode(mode);
    $('viewOriginal').classList.toggle('active', mode === 'original');
    $('viewSegmented').classList.toggle('active', mode === 'segmented');
  }

  _setViewButtons(mode, disableAll) {
    $('viewOriginal').disabled = disableAll;
    $('viewSegmented').disabled = disableAll || !this.state.clusterResult;
    this.setView(mode);
  }

  clearLog() {
    $('log').innerHTML = '';
  }
}

window.app = new App();
