/**
 * 3D Viewer Module (three.js)
 *
 * Renders the loaded GLB and a color-segmented preview using per-face
 * cluster colors. three.js is loaded from CDN via the import map in index.html.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export default class Viewer {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080a10);

    const w = container.clientWidth || 600;
    const h = container.clientHeight || 520;

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 5000);
    this.camera.position.set(2, 1.5, 3);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Lighting
    this.scene.add(new THREE.HemisphereLight(0xdde7ff, 0x1a1d2e, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(3, 5, 4);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x8899ff, 0.5);
    dir2.position.set(-4, -2, -3);
    this.scene.add(dir2);

    // Subtle grid
    this.grid = new THREE.GridHelper(10, 20, 0x252a42, 0x1e2236);
    this.grid.position.y = -0.001;
    this.scene.add(this.grid);

    this.originalGroup = null;    // gltf.scene
    this.segmentedGroup = null;   // one mesh per material cluster
    this.mode = 'original';
    this.selectedSegment = null;  // material index or null
    this.onSegmentSelect = null;  // callback(index|null)

    // Segment picking (click without drag)
    this._raycaster = new THREE.Raycaster();
    this._downPos = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this._downPos = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!this._downPos) return;
      const moved = Math.hypot(e.clientX - this._downPos[0], e.clientY - this._downPos[1]);
      this._downPos = null;
      if (moved < 5) this._pick(e);
    });

    // Resize handling
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);

    this._animate = this._animate.bind(this);
    this._animate();
  }

  /**
   * Load and display a GLB from an ArrayBuffer (original view).
   */
  async loadGLB(arrayBuffer) {
    this.clear();
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(arrayBuffer.slice(0), '');
    this.originalGroup = gltf.scene;
    this.scene.add(this.originalGroup);
    this.setMode('original');
    this._frame(this.originalGroup);
  }

  /**
   * Build the segmented preview with smooth shading.
   * @param {Array<number>} positions - flat [x,y,z,...] vertex array
   * @param {Array} faces - [{indices:[a,b,c]}, ...]
   * @param {Array<number>} faceAssignments - material index per face
   * @param {Array<Array<number>>} materialColors - RGB 0-1 per material
   */
  showSegmentation(positions, faces, faceAssignments, materialColors) {
    this._disposeSegmented();

    // Use indexed geometry with SHARED vertices so normals interpolate smoothly
    const indices = new Uint32Array(faces.length * 3);
    for (let f = 0; f < faces.length; f++) {
      const [a, b, c] = faces[f].indices;
      indices[f * 3] = a;
      indices[f * 3 + 1] = b;
      indices[f * 3 + 2] = c;
    }

    // Compute per-vertex colors by averaging cluster colors of adjacent faces
    const vertexColorCounts = new Map();
    const vertexColorSums = new Map();

    for (let f = 0; f < faces.length; f++) {
      const [a, b, c] = faces[f].indices;
      const m = faceAssignments[f];
      const col = materialColors[m] || [0.5, 0.5, 0.5];

      for (const v of [a, b, c]) {
        if (!vertexColorCounts.has(v)) {
          vertexColorCounts.set(v, 0);
          vertexColorSums.set(v, [0, 0, 0]);
        }
        const count = vertexColorCounts.get(v);
        const vCol = vertexColorSums.get(v);
        vCol[0] += col[0];
        vCol[1] += col[1];
        vCol[2] += col[2];
        vertexColorCounts.set(v, count + 1);
      }
    }

    // Average the colors
    const vertexColors = new Uint8Array((positions.length / 3) * 3);
    for (let v = 0; v < (positions.length / 3); v++) {
      const count = vertexColorCounts.get(v) || 1;
      const vCol = vertexColorSums.get(v) || [0.5, 0.5, 0.5];
      vertexColors[v * 3] = Math.round((vCol[0] / count) * 255);
      vertexColors[v * 3 + 1] = Math.round((vCol[1] / count) * 255);
      vertexColors[v * 3 + 2] = Math.round((vCol[2] / count) * 255);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3, true));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.65,
      metalness: 0.05,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'SegmentedModel';
    mesh.userData.faceAssignments = faceAssignments;
    mesh.userData.materialColors = materialColors;
    mesh.userData.faces = faces;
    mesh.userData.positions = positions;
    mesh.userData.vertexColorCounts = vertexColorCounts;
    mesh.userData.vertexColorSums = vertexColorSums;

    this.segmentedGroup = new THREE.Group();
    this.segmentedGroup.name = 'SegmentedModel';
    this.segmentedGroup.add(mesh);
    this.segmentedGroup.userData.mesh = mesh;

    this.scene.add(this.segmentedGroup);
    this.selectedSegment = null;
    this.setMode('segmented');
    this._frame(this.segmentedGroup);
  }

  /**
   * Highlight one segment (dim the others). Pass null to clear selection.
   */
  selectSegment(index) {
    this.selectedSegment = index;
    const mesh = this.segmentedGroup?.userData.mesh;
    if (!mesh) return;

    const faceAssignments = mesh.userData.faceAssignments;
    const faces = mesh.userData.faces;
    const materialColors = mesh.userData.materialColors;
    const vertexColors = mesh.geometry.attributes.color.array;
    const vertexColorCounts = mesh.userData.vertexColorCounts;
    const vertexColorSums = mesh.userData.vertexColorSums;

    if (index === null) {
      // Restore original colors (average of adjacent faces)
      for (let v = 0; v < (mesh.userData.positions.length / 3); v++) {
        const count = vertexColorCounts.get(v) || 1;
        const vCol = vertexColorSums.get(v) || [0.5, 0.5, 0.5];
        vertexColors[v * 3] = Math.round((vCol[0] / count) * 255);
        vertexColors[v * 3 + 1] = Math.round((vCol[1] / count) * 255);
        vertexColors[v * 3 + 2] = Math.round((vCol[2] / count) * 255);
      }
    } else {
      // Dim non-selected, brighten selected
      const selectedVerts = new Set();
      for (let f = 0; f < faceAssignments.length; f++) {
        if (faceAssignments[f] === index) {
          const [a, b, c] = faces[f].indices;
          selectedVerts.add(a);
          selectedVerts.add(b);
          selectedVerts.add(c);
        }
      }

      for (let v = 0; v < (mesh.userData.positions.length / 3); v++) {
        const count = vertexColorCounts.get(v) || 1;
        const vCol = vertexColorSums.get(v) || [0.5, 0.5, 0.5];
        const avgCol = [
          (vCol[0] / count) * 255,
          (vCol[1] / count) * 255,
          (vCol[2] / count) * 255,
        ];

        if (selectedVerts.has(v)) {
          vertexColors[v * 3] = Math.round(avgCol[0]);
          vertexColors[v * 3 + 1] = Math.round(avgCol[1]);
          vertexColors[v * 3 + 2] = Math.round(avgCol[2]);
        } else {
          vertexColors[v * 3] = Math.round(avgCol[0] * 0.12);
          vertexColors[v * 3 + 1] = Math.round(avgCol[1] * 0.12);
          vertexColors[v * 3 + 2] = Math.round(avgCol[2] * 0.12);
        }
      }
    }
    mesh.geometry.attributes.color.needsUpdate = true;
  }

  /**
   * Smooth per-vertex normals over the whole model: weld vertices by quantized
   * position, sum area-weighted face normals, normalize. Returns a Float32Array
   * parallel to `positions` (one normal per original vertex).
   * @private
   */
  _computeSmoothNormals(positions, faces) {
    const vertCount = positions.length / 3;
    const weld = new Map();          // quantized key -> welded id
    const vertKey = new Int32Array(vertCount); // original vertex -> welded id
    for (let v = 0; v < vertCount; v++) {
      const x = positions[v * 3] || 0, y = positions[v * 3 + 1] || 0, z = positions[v * 3 + 2] || 0;
      const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
      let w = weld.get(key);
      if (w === undefined) { w = weld.size; weld.set(key, w); }
      vertKey[v] = w;
    }

    const weldedNormals = new Float64Array(weld.size * 3);
    const ab = [0, 0, 0], ac = [0, 0, 0];
    for (const face of faces) {
      const [a, b, c] = face.indices;
      const pa = a * 3, pb = b * 3, pc = c * 3;
      ab[0] = positions[pb] - positions[pa]; ab[1] = positions[pb + 1] - positions[pa + 1]; ab[2] = positions[pb + 2] - positions[pa + 2];
      ac[0] = positions[pc] - positions[pa]; ac[1] = positions[pc + 1] - positions[pa + 1]; ac[2] = positions[pc + 2] - positions[pa + 2];
      // cross(ab, ac) = area-weighted face normal
      const nx = ab[1] * ac[2] - ab[2] * ac[1];
      const ny = ab[2] * ac[0] - ab[0] * ac[2];
      const nz = ab[0] * ac[1] - ab[1] * ac[0];
      for (const vi of [a, b, c]) {
        const w = vertKey[vi] * 3;
        weldedNormals[w] += nx; weldedNormals[w + 1] += ny; weldedNormals[w + 2] += nz;
      }
    }

    // Normalize welded normals, then scatter back to per-original-vertex array
    const out = new Float32Array(vertCount * 3);
    for (let v = 0; v < vertCount; v++) {
      const w = vertKey[v] * 3;
      let nx = weldedNormals[w], ny = weldedNormals[w + 1], nz = weldedNormals[w + 2];
      const len = Math.hypot(nx, ny, nz) || 1;
      out[v * 3] = nx / len; out[v * 3 + 1] = ny / len; out[v * 3 + 2] = nz / len;
    }
    return out;
  }

  /**
   * Smooth per-vertex colors: weld vertices by quantized position and average the
   * original colors of adjacent faces. Returns a Float32Array (0-1 RGB) parallel
   * to `positions`, giving a continuous color gradient across the surface.
   * @private
   */
  _computeSmoothVertexColors(positions, faces, faceAssignments, materialColors) {
    const vertCount = positions.length / 3;
    const weld = new Map();
    const vertKey = new Int32Array(vertCount);
    for (let v = 0; v < vertCount; v++) {
      const x = positions[v * 3] || 0, y = positions[v * 3 + 1] || 0, z = positions[v * 3 + 2] || 0;
      const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
      let w = weld.get(key);
      if (w === undefined) { w = weld.size; weld.set(key, w); }
      vertKey[v] = w;
    }

    const sums = new Float64Array(weld.size * 3);
    const counts = new Float64Array(weld.size);
    for (let f = 0; f < faces.length; f++) {
      const col = faces[f].color || materialColors[faceAssignments[f]] || [0.5, 0.5, 0.5];
      for (const vi of faces[f].indices) {
        const w = vertKey[vi];
        sums[w * 3] += col[0]; sums[w * 3 + 1] += col[1]; sums[w * 3 + 2] += col[2];
        counts[w] += 1;
      }
    }

    const out = new Float32Array(vertCount * 3);
    for (let v = 0; v < vertCount; v++) {
      const w = vertKey[v];
      const n = counts[w] || 1;
      out[v * 3] = sums[w * 3] / n; out[v * 3 + 1] = sums[w * 3 + 1] / n; out[v * 3 + 2] = sums[w * 3 + 2] / n;
    }
    return out;
  }

  /**
   * Export the segmented model as a binary GLB (one mesh per cluster).
   * Each cluster bakes its original per-face colors into a per-triangle grid
   * texture atlas (pythia's texture-bake path), so the color map renders in
   * every viewer including macOS Quick Look / Preview.
   * @returns {Promise<ArrayBuffer>}
   */
  async exportSegmentedGLB() {
    if (!this.segmentedGroup) throw new Error('No segmented model to export');
    const mesh = this.segmentedGroup.userData.mesh;
    if (!mesh) throw new Error('No segmented mesh data');

    const allPositions = mesh.userData.positions;
    const faceAssignments = mesh.userData.faceAssignments;
    const materialColors = mesh.userData.materialColors;
    const faces = mesh.userData.faces;

    const exportGroup = new THREE.Group();

    // Smooth normals: weld positions across the whole model and average face
    // normals per welded vertex, so shading interpolates (no faceted/tiled look).
    const smoothNormals = this._computeSmoothNormals(allPositions, faces);
    // Smooth per-vertex colors so each triangle bakes a color gradient (not flat).
    const vertColors = this._computeSmoothVertexColors(allPositions, faces, faceAssignments, materialColors);

    // Group faces by cluster
    const facesByCluster = Array.from({ length: materialColors.length }, () => []);
    for (let f = 0; f < faceAssignments.length; f++) {
      const m = faceAssignments[f];
      facesByCluster[m].push(f);
    }

    for (let m = 0; m < facesByCluster.length; m++) {
      const clusterFaces = facesByCluster[m];
      if (clusterFaces.length === 0) continue;

      const triCount = clusterFaces.length;

      // Grid atlas: one cell per triangle. The triangle's 3 verts map to 3 corners
      // of the cell and the cell is filled with a barycentric gradient of the 3
      // vertex colors, so the original color gradient is preserved per triangle.
      const gridDim = Math.ceil(Math.sqrt(triCount));
      let cell = 8;                                  // texels per cell side
      if (gridDim * cell > 2048) cell = Math.max(3, Math.floor(2048 / gridDim));
      const texSize = gridDim * cell;

      const canvas = document.createElement('canvas');
      canvas.width = texSize;
      canvas.height = texSize;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(texSize, texSize);
      const data = imgData.data;

      // Non-indexed geometry: each triangle gets its own 3 vertices + UVs
      const positions = new Float32Array(triCount * 9);
      const normals = new Float32Array(triCount * 9);
      const uvs = new Float32Array(triCount * 6);

      for (let t = 0; t < triCount; t++) {
        const face = faces[clusterFaces[t]];
        const idxs = face.indices;
        const cx = (t % gridDim) * cell;
        const cy = Math.floor(t / gridDim) * cell;

        // 3 vertex colors (fall back to cluster color if missing)
        const vc = [0, 1, 2].map((k) => {
          const p = idxs[k] * 3;
          return [vertColors[p], vertColors[p + 1], vertColors[p + 2]];
        });

        // Fill the cell with a clamped barycentric gradient: corner (0,0)=v0,
        // (C-1,0)=v1, (0,C-1)=v2. Extrapolated texels are clamped (no gaps/bleed).
        const D = cell - 1 || 1;
        for (let j = 0; j < cell; j++) {
          for (let i = 0; i < cell; i++) {
            const bA = i / D, bB = j / D, bC = 1 - bA - bB;
            let r = (vc[0][0] * bC + vc[1][0] * bA + vc[2][0] * bB) * 255;
            let gg = (vc[0][1] * bC + vc[1][1] * bA + vc[2][1] * bB) * 255;
            let b = (vc[0][2] * bC + vc[1][2] * bA + vc[2][2] * bB) * 255;
            const o = ((cy + j) * texSize + (cx + i)) * 4;
            data[o] = r < 0 ? 0 : r > 255 ? 255 : r;
            data[o + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg;
            data[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
            data[o + 3] = 255;
          }
        }

        // UVs at the 3 cell-corner texel centers (matches v0/v1/v2 mapping)
        const uv0 = [(cx + 0.5) / texSize, (cy + 0.5) / texSize];
        const uv1 = [(cx + cell - 0.5) / texSize, (cy + 0.5) / texSize];
        const uv2 = [(cx + 0.5) / texSize, (cy + cell - 0.5) / texSize];
        const cornerUV = [uv0, uv1, uv2];

        for (let k = 0; k < 3; k++) {
          const p = idxs[k] * 3;
          const o = t * 9 + k * 3;
          positions[o] = allPositions[p] || 0;
          positions[o + 1] = allPositions[p + 1] || 0;
          positions[o + 2] = allPositions[p + 2] || 0;
          normals[o] = smoothNormals[p] || 0;
          normals[o + 1] = smoothNormals[p + 1] || 0;
          normals[o + 2] = smoothNormals[p + 2] || 0;
          uvs[t * 6 + k * 2] = cornerUV[k][0];
          uvs[t * 6 + k * 2 + 1] = cornerUV[k][1];
        }
      }

      ctx.putImageData(imgData, 0, 0);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;

      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 1,
        metalness: 0,
      });
      mat.name = `Material_${m + 1}`;

      const meshObject = new THREE.Mesh(geo, mat);
      meshObject.name = `Segment_${m + 1}`;
      exportGroup.add(meshObject);
    }

    try {
      const exporter = new GLTFExporter();
      return await exporter.parseAsync(exportGroup, { binary: true });
    } finally {
      exportGroup.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      });
    }
  }

  /**
   * Toggle between 'original' and 'segmented' display.
   */
  setMode(mode) {
    this.mode = mode;
    if (this.originalGroup) this.originalGroup.visible = mode === 'original';
    if (this.segmentedGroup) this.segmentedGroup.visible = mode === 'segmented';
  }

  /**
   * Remove all loaded content.
   */
  clear() {
    if (this.originalGroup) {
      this.scene.remove(this.originalGroup);
      this.originalGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
      this.originalGroup = null;
    }
    this._disposeSegmented();
  }

  /** @private */
  _disposeSegmented() {
    if (!this.segmentedGroup) return;
    this.scene.remove(this.segmentedGroup);
    const mesh = this.segmentedGroup.userData.mesh;
    if (mesh) {
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    }
    this.segmentedGroup = null;
    this.selectedSegment = null;
  }

  /**
   * Raycast pick a segment on click (segmented mode only).
   * @private
   */
  _pick(event) {
    if (this.mode !== 'segmented' || !this.segmentedGroup) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(ndc, this.camera);
    const mesh = this.segmentedGroup.userData.mesh;
    if (!mesh) return;

    const hits = this._raycaster.intersectObject(mesh, false);
    let next = null;
    if (hits.length > 0) {
      const faceIndex = hits[0].faceIndex;
      const faceAssignments = mesh.userData.faceAssignments;
      const materialIndex = faceAssignments[faceIndex];
      next = materialIndex === this.selectedSegment ? null : materialIndex; // click again to deselect
    }
    this.selectSegment(next);
    if (this.onSegmentSelect) this.onSegmentSelect(next);
  }

  /**
   * Fit camera to an object's bounding sphere.
   * @private
   */
  _frame(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = sphere.radius / Math.tan((this.camera.fov * Math.PI) / 360);

    this.controls.target.copy(sphere.center);
    this.camera.position
      .copy(sphere.center)
      .add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(dist * 1.35));
    this.camera.near = Math.max(sphere.radius / 100, 0.001);
    this.camera.far = sphere.radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // Scale grid to model size
    const gridSize = Math.max(2, sphere.radius * 4);
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(gridSize, 20, 0x252a42, 0x1e2236);
    this.grid.position.y = box.min.y;
    this.scene.add(this.grid);
  }

  /** @private */
  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** @private */
  _animate() {
    requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
