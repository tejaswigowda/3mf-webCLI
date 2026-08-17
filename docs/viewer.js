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
   * Build the segmented preview: one flat-shaded mesh PER material cluster,
   * so segments can be individually picked and exported.
   * @param {Array<number>} positions - flat [x,y,z,...] vertex array
   * @param {Array} faces - [{indices:[a,b,c]}, ...]
   * @param {Array<number>} faceAssignments - material index per face
   * @param {Array<Array<number>>} materialColors - RGB 0-1 per material
   */
  showSegmentation(positions, faces, faceAssignments, materialColors) {
    this._disposeSegmented();

    // Bucket faces by material index
    const buckets = materialColors.map(() => []);
    for (let f = 0; f < faces.length; f++) {
      const m = faceAssignments[f];
      if (buckets[m]) buckets[m].push(f);
    }

    this.segmentedGroup = new THREE.Group();
    this.segmentedGroup.name = 'SegmentedModel';

    for (let m = 0; m < buckets.length; m++) {
      const bucket = buckets[m];
      if (bucket.length === 0) continue;

      const verts = new Float32Array(bucket.length * 9);
      for (let bi = 0; bi < bucket.length; bi++) {
        const [a, b, c] = faces[bucket[bi]].indices;
        const idxs = [a, b, c];
        for (let v = 0; v < 3; v++) {
          const o = bi * 9 + v * 3;
          const p = idxs[v] * 3;
          verts[o] = positions[p] || 0;
          verts[o + 1] = positions[p + 1] || 0;
          verts[o + 2] = positions[p + 2] || 0;
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.computeVertexNormals();

      const col = materialColors[m] || [0.5, 0.5, 0.5];
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(col[0], col[1], col[2]),
        flatShading: true,
        roughness: 0.65,
        metalness: 0.05,
      });
      mat.name = `Material_${m + 1}`;

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `Segment_${m + 1}`;
      mesh.userData.materialIndex = m;
      this.segmentedGroup.add(mesh);
    }

    this.scene.add(this.segmentedGroup);
    this.selectedSegment = null;
    this.setMode('segmented');
    if (!this.originalGroup) this._frame(this.segmentedGroup);
  }

  /**
   * Highlight one segment (dim the others). Pass null to clear selection.
   */
  selectSegment(index) {
    this.selectedSegment = index;
    if (!this.segmentedGroup) return;
    for (const mesh of this.segmentedGroup.children) {
      const mat = mesh.material;
      const isSel = mesh.userData.materialIndex === index;
      if (index === null) {
        mat.transparent = false;
        mat.opacity = 1;
        mat.emissive.setRGB(0, 0, 0);
      } else if (isSel) {
        mat.transparent = false;
        mat.opacity = 1;
        mat.emissive.copy(mat.color).multiplyScalar(0.45);
      } else {
        mat.transparent = true;
        mat.opacity = 0.12;
        mat.emissive.setRGB(0, 0, 0);
      }
      mat.needsUpdate = true;
    }
  }

  /**
   * Export the segmented model as a binary GLB (one mesh + material per segment).
   * @returns {Promise<ArrayBuffer>}
   */
  async exportSegmentedGLB() {
    if (!this.segmentedGroup) throw new Error('No segmented model to export');
    const prevSelection = this.selectedSegment;
    this.selectSegment(null); // export with clean materials
    try {
      const exporter = new GLTFExporter();
      return await exporter.parseAsync(this.segmentedGroup, { binary: true });
    } finally {
      this.selectSegment(prevSelection);
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
    for (const mesh of this.segmentedGroup.children) {
      mesh.geometry.dispose();
      mesh.material.dispose();
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
    const hits = this._raycaster.intersectObjects(this.segmentedGroup.children, false);

    let next = null;
    if (hits.length > 0) {
      const idx = hits[0].object.userData.materialIndex;
      next = idx === this.selectedSegment ? null : idx; // click again to deselect
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
