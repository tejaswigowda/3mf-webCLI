/**
 * Color Clustering Module
 * 
 * Clusters colors into N material groups using k-means in Lab color space.
 * Deterministic (seeded) so same input + same N = same output.
 */

class ColorClusterer {
  /**
   * Cluster colors into N groups using k-means
   * @param {Array<Array<number>>} colors - RGB colors [[r,g,b], ...]
   * @param {number} k - Number of clusters (materials)
   * @param {Object} options - Configuration
   * @returns {Object} {clusters, centroids, assignments}
   */
  static cluster(colors, k = 4, options = {}) {
    if (!colors || colors.length === 0) {
      throw new Error('No colors to cluster');
    }

    const maxIterations = options.maxIterations || 50;
    const seed = options.seed || 42;
    const luminanceWeight = options.luminanceWeight ?? 1.0;
    const restarts = options.restarts || 1;

    // Convert RGB to chroma-weighted Lab (down-weighting L makes hue dominate,
    // so baked-in shading doesn't split one part into light/dark bands)
    const labColors = colors.map(rgb => {
      const lab = this._rgbToLab(rgb);
      return [lab[0] * luminanceWeight, lab[1], lab[2]];
    });

    // Multiple seeded restarts, keep the run with the best (lowest) inertia
    let best = null;
    for (let r = 0; r < restarts; r++) {
      const run = this._kmeansRun(labColors, k, seed + r, maxIterations);
      if (!best || run.inertia < best.inertia) best = run;
    }

    const { assignments, centroids, iterations } = best;

    // Convert centroids back to RGB (undo luminance weighting)
    const rgbCentroids = centroids.map(lab =>
      this._labToRgb([lab[0] / (luminanceWeight || 1), lab[1], lab[2]]));

    // Build clusters
    const clusters = Array.from({ length: k }, () => []);
    assignments.forEach((clusterIdx, colorIdx) => {
      clusters[clusterIdx].push(colorIdx);
    });

    return {
      clusters,
      centroids: rgbCentroids,
      assignments,
      iterations,
      inertia: best.inertia,
    };
  }

  /**
   * One seeded k-means run. Returns {assignments, centroids, inertia, iterations}.
   * @private
   */
  static _kmeansRun(labColors, k, seed, maxIterations) {
    const centroids = this._initializeCentroids(labColors, k, seed);
    let assignments = new Array(labColors.length);
    let previousAssignments = null;
    let converged = false;
    let iteration = 0;

    while (!converged && iteration < maxIterations) {
      for (let i = 0; i < labColors.length; i++) {
        let minDist = Infinity;
        let nearestCluster = 0;
        for (let c = 0; c < centroids.length; c++) {
          const dist = this._euclideanDistance(labColors[i], centroids[c]);
          if (dist < minDist) {
            minDist = dist;
            nearestCluster = c;
          }
        }
        assignments[i] = nearestCluster;
      }

      converged = this._assignmentsEqual(assignments, previousAssignments);
      previousAssignments = [...assignments];

      for (let c = 0; c < centroids.length; c++) {
        const clusterColors = labColors.filter((_, i) => assignments[i] === c);
        if (clusterColors.length > 0) {
          centroids[c] = this._meanVector(clusterColors);
        }
      }
      iteration++;
    }

    let inertia = 0;
    for (let i = 0; i < labColors.length; i++) {
      const d = this._euclideanDistance(labColors[i], centroids[assignments[i]]);
      inertia += d * d;
    }

    return { assignments, centroids, inertia, iterations: iteration };
  }

  /**
   * Auto-detect the natural number of materials from a model's colors
   * (no ML — a simple inertia elbow heuristic). Runs chroma-weighted Lab k-means
   * for k = 1..maxK, then picks the "elbow" of the inertia curve (the point of
   * maximum perpendicular distance from the line joining the first and last
   * points). Distinct near-flat palettes resolve to few materials; rich models
   * resolve to more.
   *
   * @param {Array} faces - faces with .color [r,g,b] 0-1
   * @param {Object} options - {minK=2, maxK=8, luminanceWeight=0.35}
   * @returns {number} detected material count, clamped to [minK, maxK]
   */
  static autoDetectK(faces, options = {}) {
    const minK = options.minK ?? 2;
    const maxK = options.maxK ?? 8;
    const luminanceWeight = options.luminanceWeight ?? 0.35;

    let colors = faces.map(f => f.color || [0.5, 0.5, 0.5]);
    if (colors.length === 0) return minK;

    // Downsample for speed (elbow search runs k-means maxK times)
    const MAX_SAMPLES = 4000;
    if (colors.length > MAX_SAMPLES) {
      const step = colors.length / MAX_SAMPLES;
      const sampled = [];
      for (let i = 0; i < colors.length; i += step) sampled.push(colors[Math.floor(i)]);
      colors = sampled;
    }

    // Not enough samples to split meaningfully
    if (colors.length <= minK) return Math.max(minK, Math.min(colors.length, maxK));

    // Inertia curve for k = 1..maxK
    const upper = Math.min(maxK, colors.length);
    const ks = [];
    const inertias = [];
    for (let k = 1; k <= upper; k++) {
      const res = this.cluster(colors, k, { luminanceWeight, restarts: 2, seed: 42 });
      ks.push(k);
      inertias.push(res.inertia);
    }

    // Effectively single-colored model: k=1 already explains almost everything
    if (inertias[0] < 1e-6) return minK;
    const dropFrac = (inertias[0] - inertias[inertias.length - 1]) / inertias[0];
    if (dropFrac < 0.15) return minK; // adding materials barely helps → single color

    // Normalize axes to [0,1] so scale differences don't skew the geometry
    const kMin = ks[0], kMax = ks[ks.length - 1];
    const iMax = Math.max(...inertias), iMin = Math.min(...inertias);
    const kSpan = (kMax - kMin) || 1;
    const iSpan = (iMax - iMin) || 1;
    const nx = ks.map(k => (k - kMin) / kSpan);
    const ny = inertias.map(v => (v - iMin) / iSpan);

    // Line from first to last normalized point
    const x1 = nx[0], y1 = ny[0];
    const x2 = nx[nx.length - 1], y2 = ny[ny.length - 1];
    const dx = x2 - x1, dy = y2 - y1;
    const lineLen = Math.hypot(dx, dy) || 1;

    // Elbow = max perpendicular distance to that line
    let bestK = minK, bestDist = -1;
    for (let i = 0; i < ks.length; i++) {
      const dist = Math.abs(dy * nx[i] - dx * ny[i] + x2 * y1 - y2 * x1) / lineLen;
      if (dist > bestDist) { bestDist = dist; bestK = ks[i]; }
    }

    return Math.max(minK, Math.min(bestK, maxK));
  }

  /**
   *  1. chroma-weighted Lab k-means (3 restarts, best inertia)
   *  2. edge-aware label smoothing over the face-adjacency graph
   *  3. MRF/ICM refinement (color data term − λ · neighbor agreement)
   *  4. merge tiny clusters (< minPartFrac of faces)
   *  5. dissolve small connected components into their dominant border label
   *
   * @param {Array} faces - faces with .color [r,g,b] 0-1 and .indices [a,b,c]
   * @param {Array<number>} positions - flat vertex positions (for welding)
   * @param {number} k - target number of materials
   * @returns {Object} {clusters, centroids, assignments}
   */
  static segmentFaces(faces, positions, k = 4, options = {}) {
    const luminanceWeight = options.luminanceWeight ?? 0.35;
    const n = faces.length;
    if (n === 0) throw new Error('No faces to segment');

    const faceColors = faces.map(f => f.color || [0.5, 0.5, 0.5]);
    const faceLab = faceColors.map(rgb => {
      const lab = this._rgbToLab(rgb);
      return [lab[0] * luminanceWeight, lab[1], lab[2]];
    });

    // 1. Base clustering (3 restarts)
    const base = this.cluster(faceColors, k, { luminanceWeight, restarts: 3, seed: 42 });
    let labels = base.assignments.slice();

    // Face adjacency (vertices welded by position so non-indexed meshes work)
    const adjacency = this._buildFaceAdjacency(faces, positions);

    // 2. Edge-aware smoothing
    labels = this._smoothFaceLabels(labels, k, adjacency, faceLab,
      { iters: 8, edgeSigma: 18.0, edgeFloor: 0.6 });

    // 3. MRF/ICM refinement
    labels = this._mrfRefineLabels(labels, k, adjacency, faceLab,
      { lam: 24.0, edgeSigma: 14.0, edgeFloor: 0.6, iters: 20 });

    // 4. Merge tiny clusters into the nearest remaining cluster by mean color
    labels = this._mergeTinyClusters(labels, k, faceLab, options.minPartFrac ?? 0.02);

    // 5. Dissolve small connected components
    labels = this._mergeSmallComponents(labels, adjacency,
      Math.max(1, Math.round((options.minCompFrac ?? 0.01) * n)));

    // Dense renumbering
    const remap = new Map();
    for (const l of labels) if (!remap.has(l)) remap.set(l, remap.size);
    labels = labels.map(l => remap.get(l));
    const finalK = remap.size;

    // Final cluster colors: per-channel median RGB (robust dominant color)
    const clusters = Array.from({ length: finalK }, () => []);
    labels.forEach((l, i) => clusters[l].push(i));
    const centroids = clusters.map(idxs => {
      if (idxs.length === 0) return [0.5, 0.5, 0.5];
      return [0, 1, 2].map(ch => {
        const vals = idxs.map(i => faceColors[i][ch]).sort((a, b) => a - b);
        return vals[Math.floor(vals.length / 2)];
      });
    });

    return { clusters, centroids, assignments: labels };
  }

  /**
   * Build face adjacency from shared edges. Vertices are welded by quantized
   * position so duplicated vertices (non-indexed / textured meshes) still connect.
   * @private
   * @returns {Array<Array<number>>} adjacency[faceIdx] = [neighborFaceIdx, ...]
   */
  static _buildFaceAdjacency(faces, positions) {
    const weld = new Map(); // quantized position -> canonical id
    const canonical = new Map(); // original vertex idx -> canonical id
    const canonOf = (vi) => {
      let c = canonical.get(vi);
      if (c !== undefined) return c;
      const key = `${Math.round(positions[vi * 3] * 1e5)},${Math.round(positions[vi * 3 + 1] * 1e5)},${Math.round(positions[vi * 3 + 2] * 1e5)}`;
      c = weld.get(key);
      if (c === undefined) {
        c = weld.size;
        weld.set(key, c);
      }
      canonical.set(vi, c);
      return c;
    };

    const edgeToFaces = new Map();
    for (let f = 0; f < faces.length; f++) {
      const [a, b, c] = faces[f].indices.map(canonOf);
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = u < v ? u * 4294967296 + v : v * 4294967296 + u;
        let list = edgeToFaces.get(key);
        if (!list) edgeToFaces.set(key, (list = []));
        list.push(f);
      }
    }

    const adjacency = Array.from({ length: faces.length }, () => []);
    for (const list of edgeToFaces.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          adjacency[list[i]].push(list[j]);
          adjacency[list[j]].push(list[i]);
        }
      }
    }
    return adjacency;
  }

  /**
   * Edge-aware contrast weight between two face colors.
   * @private
   */
  static _edgeWeight(labA, labB, sigma, floor) {
    const d = this._euclideanDistance(labA, labB);
    return floor + (1 - floor) * Math.exp(-((d / sigma) ** 2));
  }

  /**
   * Iterated edge-aware majority vote over the face-adjacency graph.
   * @private
   */
  static _smoothFaceLabels(labels, nLabels, adjacency, faceLab, { iters, edgeSigma, edgeFloor }) {
    let cur = labels.slice();
    for (let it = 0; it < iters; it++) {
      const next = cur.slice();
      let changed = false;
      for (let f = 0; f < cur.length; f++) {
        const votes = new Float64Array(nLabels);
        votes[cur[f]] += 1.0;
        for (const nb of adjacency[f]) {
          const w = this._edgeWeight(faceLab[f], faceLab[nb], edgeSigma, edgeFloor);
          votes[cur[nb]] += w;
        }
        let bestL = cur[f], bestV = -1;
        for (let l = 0; l < nLabels; l++) {
          if (votes[l] > bestV) { bestV = votes[l]; bestL = l; }
        }
        if (bestL !== cur[f]) { next[f] = bestL; changed = true; }
      }
      cur = next;
      if (!changed) break;
    }
    return cur;
  }

  /**
   * ICM energy minimization: data cost (Lab distance to part mean color)
   * minus λ × contrast-weighted neighbor agreement.
   * @private
   */
  static _mrfRefineLabels(labels, nLabels, adjacency, faceLab, { lam, edgeSigma, edgeFloor, iters }) {
    // Part mean colors from initial labels (computed once)
    const sums = Array.from({ length: nLabels }, () => [0, 0, 0]);
    const counts = new Array(nLabels).fill(0);
    for (let f = 0; f < labels.length; f++) {
      const l = labels[f];
      counts[l]++;
      sums[l][0] += faceLab[f][0];
      sums[l][1] += faceLab[f][1];
      sums[l][2] += faceLab[f][2];
    }
    const means = sums.map((s, l) => counts[l] > 0 ? s.map(v => v / counts[l]) : null);

    let cur = labels.slice();
    for (let it = 0; it < iters; it++) {
      let changed = false;
      for (let f = 0; f < cur.length; f++) {
        // Neighbor agreement per label
        const agree = new Float64Array(nLabels);
        for (const nb of adjacency[f]) {
          const w = this._edgeWeight(faceLab[f], faceLab[nb], edgeSigma, edgeFloor);
          agree[cur[nb]] += w;
        }
        let bestL = cur[f], bestE = Infinity;
        for (let l = 0; l < nLabels; l++) {
          if (!means[l]) continue;
          const data = this._euclideanDistance(faceLab[f], means[l]);
          const e = data - lam * agree[l];
          if (e < bestE) { bestE = e; bestL = l; }
        }
        if (bestL !== cur[f]) { cur[f] = bestL; changed = true; }
      }
      if (!changed) break;
    }
    return cur;
  }

  /**
   * Merge clusters smaller than minFrac of all faces into the nearest
   * remaining cluster by mean Lab color.
   * @private
   */
  static _mergeTinyClusters(labels, nLabels, faceLab, minFrac) {
    const n = labels.length;
    const minCount = Math.max(1, Math.round(minFrac * n));

    const counts = new Array(nLabels).fill(0);
    const sums = Array.from({ length: nLabels }, () => [0, 0, 0]);
    for (let f = 0; f < n; f++) {
      const l = labels[f];
      counts[l]++;
      sums[l][0] += faceLab[f][0];
      sums[l][1] += faceLab[f][1];
      sums[l][2] += faceLab[f][2];
    }
    const means = sums.map((s, l) => counts[l] > 0 ? s.map(v => v / counts[l]) : null);

    const keep = [];
    const tiny = [];
    for (let l = 0; l < nLabels; l++) {
      if (counts[l] === 0) continue;
      (counts[l] < minCount ? tiny : keep).push(l);
    }
    if (tiny.length === 0 || keep.length === 0) return labels;

    const mapTo = new Map();
    for (const t of tiny) {
      let best = keep[0], bestD = Infinity;
      for (const kl of keep) {
        const d = this._euclideanDistance(means[t], means[kl]);
        if (d < bestD) { bestD = d; best = kl; }
      }
      mapTo.set(t, best);
    }
    return labels.map(l => mapTo.get(l) ?? l);
  }

  /**
   * Dissolve connected same-label components smaller than minCompFaces into
   * the label they share the most boundary edges with. Repeats until stable.
   * @private
   */
  static _mergeSmallComponents(labels, adjacency, minCompFaces, maxPasses = 8) {
    const n = labels.length;
    let cur = labels.slice();

    for (let pass = 0; pass < maxPasses; pass++) {
      // Connected components over same-label adjacency
      const comp = new Int32Array(n).fill(-1);
      let nComps = 0;
      for (let f = 0; f < n; f++) {
        if (comp[f] !== -1) continue;
        const stack = [f];
        comp[f] = nComps;
        while (stack.length) {
          const x = stack.pop();
          for (const nb of adjacency[x]) {
            if (comp[nb] === -1 && cur[nb] === cur[x]) {
              comp[nb] = nComps;
              stack.push(nb);
            }
          }
        }
        nComps++;
      }

      const compSize = new Array(nComps).fill(0);
      for (let f = 0; f < n; f++) compSize[comp[f]]++;

      // For each small component: vote on border labels
      let changed = false;
      const borderVotes = new Map(); // compId -> Map(label -> count)
      for (let f = 0; f < n; f++) {
        if (compSize[comp[f]] >= minCompFaces) continue;
        for (const nb of adjacency[f]) {
          if (comp[nb] === comp[f]) continue;
          let votes = borderVotes.get(comp[f]);
          if (!votes) borderVotes.set(comp[f], (votes = new Map()));
          votes.set(cur[nb], (votes.get(cur[nb]) || 0) + 1);
        }
      }

      const compNewLabel = new Map();
      for (const [cid, votes] of borderVotes) {
        let bestL = -1, bestV = -1;
        for (const [l, v] of votes) {
          if (v > bestV) { bestV = v; bestL = l; }
        }
        if (bestL !== -1) compNewLabel.set(cid, bestL);
      }

      for (let f = 0; f < n; f++) {
        const nl = compNewLabel.get(comp[f]);
        if (nl !== undefined && nl !== cur[f]) {
          cur[f] = nl;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return cur;
  }

  /**
   * Convert RGB [0-1] to Lab color space
   * @private
   */
  static _rgbToLab(rgb) {
    // Normalize to [0, 1]
    let [r, g, b] = rgb.map(c => c > 1 ? c / 255 : c);

    // Apply gamma correction (sRGB)
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    // RGB to XYZ (using D65 illuminant)
    const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = r * 0.0193 + g * 0.1192 + b * 0.9505;

    // XYZ to Lab
    const xn = 0.95047;
    const yn = 1.0;
    const zn = 1.08883;

    let fx = x / xn;
    let fy = y / yn;
    let fz = z / zn;

    const delta = 6 / 29;
    fx = fx > delta * delta * delta ? Math.pow(fx, 1 / 3) : fx / (3 * delta * delta) + 4 / 29;
    fy = fy > delta * delta * delta ? Math.pow(fy, 1 / 3) : fy / (3 * delta * delta) + 4 / 29;
    fz = fz > delta * delta * delta ? Math.pow(fz, 1 / 3) : fz / (3 * delta * delta) + 4 / 29;

    const l = 116 * fy - 16;
    const a = 500 * (fx - fy);
    const lab_b = 200 * (fy - fz);

    return [l, a, lab_b];
  }

  /**
   * Convert Lab to RGB [0-1]
   * @private
   */
  static _labToRgb(lab) {
    const [l, a, lab_b] = lab;

    // Lab to XYZ
    const xn = 0.95047;
    const yn = 1.0;
    const zn = 1.08883;

    const fy = (l + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - lab_b / 200;

    const delta = 6 / 29;
    const fx3 = fx * fx * fx;
    const fy3 = fy * fy * fy;
    const fz3 = fz * fz * fz;

    const x = xn * (fx3 > delta * delta * delta ? fx3 : (fx - 4 / 29) * 3 * delta * delta);
    const y = yn * (fy3 > delta * delta * delta ? fy3 : (fy - 4 / 29) * 3 * delta * delta);
    const z = zn * (fz3 > delta * delta * delta ? fz3 : (fz - 4 / 29) * 3 * delta * delta);

    // XYZ to RGB (inverse of D65 matrix)
    let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
    let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
    let b = x * 0.0557 + y * -0.2040 + z * 1.0570;

    // Inverse gamma correction (sRGB)
    r = r > 0.0031308 ? 1.055 * Math.pow(r, 1 / 2.4) - 0.055 : 12.92 * r;
    g = g > 0.0031308 ? 1.055 * Math.pow(g, 1 / 2.4) - 0.055 : 12.92 * g;
    b = b > 0.0031308 ? 1.055 * Math.pow(b, 1 / 2.4) - 0.055 : 12.92 * b;

    // Clamp to [0, 1]
    r = Math.max(0, Math.min(1, r));
    g = Math.max(0, Math.min(1, g));
    b = Math.max(0, Math.min(1, b));

    return [r, g, b];
  }

  /**
   * Euclidean distance in Lab space
   * @private
   */
  static _euclideanDistance(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
  }

  /**
   * Calculate mean vector
   * @private
   */
  static _meanVector(vectors) {
    const sum = vectors[0].map(() => 0);
    for (const v of vectors) {
      for (let i = 0; i < v.length; i++) {
        sum[i] += v[i];
      }
    }
    return sum.map(s => s / vectors.length);
  }

  /**
   * Check if two assignment arrays are equal
   * @private
   */
  static _assignmentsEqual(a, b) {
    if (!b) return false;
    return a.every((val, idx) => val === b[idx]);
  }

  /**
   * Initialize k-means++ centroids deterministically
   * @private
   */
  static _initializeCentroids(labColors, k, seed) {
    const rng = this._seededRandom(seed);
    const centroids = [];

    // First centroid: random color
    const firstIdx = Math.floor(rng() * labColors.length);
    centroids.push([...labColors[firstIdx]]);

    // Remaining centroids: k-means++ selection
    for (let i = 1; i < k; i++) {
      const distances = labColors.map(color => {
        let minDist = Infinity;
        for (const centroid of centroids) {
          const dist = this._euclideanDistance(color, centroid);
          minDist = Math.min(minDist, dist);
        }
        return minDist;
      });

      const totalDist = distances.reduce((a, b) => a + b, 0);
      let r = rng() * totalDist;
      for (let j = 0; j < labColors.length; j++) {
        r -= distances[j];
        if (r <= 0) {
          centroids.push([...labColors[j]]);
          break;
        }
      }
    }

    return centroids;
  }

  /**
   * Seeded random number generator
   * @private
   */
  static _seededRandom(seed) {
    return function () {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }
}

export default ColorClusterer;
