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
   * Export the segmented model as a binary GLB (one mesh per cluster).
   * Each mesh uses vertex colors based on original face colors.
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

    // Build per-cluster meshes with original face colors
    const exportGroup = new THREE.Group();
    
    // Group faces by cluster
    const facesByCluster = Array.from({ length: materialColors.length }, () => []);
    for (let f = 0; f < faceAssignments.length; f++) {
      const m = faceAssignments[f];
      facesByCluster[m].push(f);
    }

    // Create mesh for each cluster
    for (let m = 0; m < facesByCluster.length; m++) {
      const clusterFaces = facesByCluster[m];
      if (clusterFaces.length === 0) continue;

      // Weld vertices and compute colors from original face colors
      const weld = new Map();
      const remap = new Map();
      const weldedPositions = [];
      const vertexColorCounts = new Map();
      const vertexColorSums = new Map();

      const weldedIndex = (vi) => {
        let w = remap.get(vi);
        if (w !== undefined) return w;
        const x = allPositions[vi * 3] || 0;
        const y = allPositions[vi * 3 + 1] || 0;
        const z = allPositions[vi * 3 + 2] || 0;
        const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
        w = weld.get(key);
        if (w === undefined) {
          w = weldedPositions.length / 3;
          weld.set(key, w);
          weldedPositions.push(x, y, z);
          vertexColorCounts.set(w, 0);
          vertexColorSums.set(w, [0, 0, 0]);
        }
        remap.set(vi, w);
        return w;
      };

      const indices = [];

      // First pass: collect all welded indices and accumulate colors
      for (const fIdx of clusterFaces) {
        const face = faces[fIdx];
        const [a, b, c] = face.indices;
        const faceColor = face.color || materialColors[m] || [0.5, 0.5, 0.5];

        const idxs = [a, b, c];
        for (let i = 0; i < 3; i++) {
          const wi = weldedIndex(idxs[i]);
          indices.push(wi);
          
          // Accumulate color for this welded vertex
          const count = vertexColorCounts.get(wi);
          const vCol = vertexColorSums.get(wi);
          vCol[0] += faceColor[0];
          vCol[1] += faceColor[1];
          vCol[2] += faceColor[2];
          vertexColorCounts.set(wi, count + 1);
        }
      }

      // Compute averaged vertex colors
      const vertexColors = new Uint8Array((weldedPositions.length / 3) * 3);
      for (let w = 0; w < (weldedPositions.length / 3); w++) {
        const count = vertexColorCounts.get(w) || 1;
        const vCol = vertexColorSums.get(w) || [0.5, 0.5, 0.5];
        vertexColors[w * 3] = Math.round((vCol[0] / count) * 255);
        vertexColors[w * 3 + 1] = Math.round((vCol[1] / count) * 255);
        vertexColors[w * 3 + 2] = Math.round((vCol[2] / count) * 255);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(weldedPositions), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3, true));
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.65,
        metalness: 0.05,
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
        if (obj.material) obj.material.dispose();
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
