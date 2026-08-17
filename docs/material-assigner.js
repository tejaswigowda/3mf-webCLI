/**
 * Material Assignment Module
 * 
 * Assigns faces to materials based on color proximity.
 * Handles optional merging of tiny islands.
 */

class MaterialAssigner {
  /**
   * Assign faces to materials based on clustering
   * @param {Array} faces - Face data
   * @param {Array<number>} clusterAssignments - Material index for each color
   * @param {Object} options - Configuration
   * @returns {Array<number>} Material assignment per face
   */
  static assign(faces, clusterAssignments, options = {}) {
    if (!faces || !clusterAssignments) {
      throw new Error('Missing faces or cluster assignments');
    }

    const faceAssignments = new Array(faces.length);

    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      
      // Determine which cluster this face's color belongs to
      if (face.textureData) {
        // TODO: Implement texture sampling
        faceAssignments[i] = 0;
      } else if (face.color) {
        // Find nearest cluster center
        const colorIdx = clusterAssignments.indexOf(face.colorClusterId || 0);
        faceAssignments[i] = colorIdx >= 0 ? colorIdx : 0;
      } else {
        faceAssignments[i] = 0;
      }
    }

    // Optional: merge tiny islands
    if (options.mergeTinyIslands) {
      this._mergeTinyIslands(faceAssignments, options.minIslandSize || 3);
    }

    return faceAssignments;
  }

  /**
   * Merge small disconnected regions into nearest neighbor material
   * @private
   */
  static _mergeTinyIslands(assignments, minSize) {
    // Count connected components per material
    const materialRegions = this._findConnectedComponents(assignments);

    // Merge tiny regions
    for (const [materialIdx, regions] of Object.entries(materialRegions)) {
      for (const region of regions) {
        if (region.size < minSize) {
          // Find nearest neighbor material
          const neighbors = this._findNeighborMaterials(region.faces, assignments);
          const bestNeighbor = neighbors[0];

          if (bestNeighbor !== undefined) {
            for (const faceIdx of region.faces) {
              assignments[faceIdx] = bestNeighbor;
            }
          }
        }
      }
    }
  }

  /**
   * Find connected components per material
   * @private
   */
  static _findConnectedComponents(assignments) {
    const visited = new Set();
    const components = {};

    for (let i = 0; i < assignments.length; i++) {
      if (!visited.has(i)) {
        const material = assignments[i];
        const region = { faces: [], size: 0 };

        this._dfs(i, material, assignments, visited, region.faces);
        region.size = region.faces.length;

        if (!components[material]) {
          components[material] = [];
        }
        components[material].push(region);
      }
    }

    return components;
  }

  /**
   * Depth-first search for connected faces
   * @private
   */
  static _dfs(faceIdx, material, assignments, visited, region) {
    if (visited.has(faceIdx) || assignments[faceIdx] !== material) {
      return;
    }

    visited.add(faceIdx);
    region.push(faceIdx);
  }

  /**
   * Find neighbor materials adjacent to a region
   * @private
   */
  static _findNeighborMaterials(regionFaces, assignments) {
    const neighbors = {};

    for (const faceIdx of regionFaces) {
      // Check adjacent faces (simplified: just count all other materials)
      for (let i = 0; i < assignments.length; i++) {
        if (!regionFaces.includes(i) && assignments[i] !== assignments[faceIdx]) {
          const material = assignments[i];
          neighbors[material] = (neighbors[material] || 0) + 1;
        }
      }
    }

    // Sort by adjacency count
    return Object.entries(neighbors)
      .sort((a, b) => b[1] - a[1])
      .map(([mat]) => parseInt(mat));
  }
}

export default MaterialAssigner;
