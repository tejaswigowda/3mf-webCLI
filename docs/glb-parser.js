/**
 * GLB Parser Module
 * 
 * Parses GLB/GLTF files and extracts:
 * - Geometry (positions, indices, normals)
 * - Color data (per-vertex, textured, or material-based)
 * - Metadata
 */

class GLBParser {
  /**
   * Parse a GLB buffer
   * @param {ArrayBuffer} arrayBuffer - GLB file data
   * @returns {Promise<Object>} Parsed geometry and color data
   */
  static async parse(arrayBuffer) {
    // Basic GLB header parsing
    const view = new DataView(arrayBuffer);
    
    // Check GLB magic number (0x46546C67)
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546c67) {
      throw new Error('Invalid GLB file: magic number mismatch');
    }

    const version = view.getUint32(4, true);
    if (version !== 2) {
      throw new Error(`GLB version ${version} not supported`);
    }

    const length = view.getUint32(8, true);

    // Parse chunks
    let chunkOffset = 12;
    let jsonChunk = null;
    let binChunk = null;

    while (chunkOffset < length) {
      const chunkLength = view.getUint32(chunkOffset, true);
      const chunkType = view.getUint32(chunkOffset + 4, true);
      const chunkData = arrayBuffer.slice(chunkOffset + 8, chunkOffset + 8 + chunkLength);

      if (chunkType === 0x4e4f534a) { // 'JSON'
        const decoder = new TextDecoder();
        jsonChunk = JSON.parse(decoder.decode(chunkData));
      } else if (chunkType === 0x004e4942) { // 'BIN\0'
        binChunk = new Uint8Array(chunkData);
      }

      chunkOffset += 8 + chunkLength;
    }

    if (!jsonChunk || !binChunk) {
      throw new Error('Missing JSON or BIN chunk in GLB');
    }

    // Extract mesh data
    const meshData = await this._extractMeshData(jsonChunk, binChunk);
    return meshData;
  }

  /**
   * Extract geometry and color from GLTF JSON + binary
   * @private
   */
  static async _extractMeshData(json, bin) {
    const bufferViews = json.bufferViews || [];
    const accessors = json.accessors || [];
    const meshes = json.meshes || [];

    // Compressed geometry needs a decoder we don't ship — fail clearly instead
    // of reading compressed bufferViews as raw floats (which yields garbage).
    const required = json.extensionsRequired || [];
    const unsupported = required.filter(e =>
      e === 'KHR_draco_mesh_compression' || e === 'EXT_meshopt_compression');
    if (unsupported.length > 0) {
      throw new Error(`Compressed GLB not supported (${unsupported.join(', ')}). Re-export without Draco/meshopt compression.`);
    }

    if (meshes.length === 0) {
      throw new Error('No meshes found in GLB');
    }

    // Gather primitives from ALL meshes
    const primitives = meshes.flatMap((m) => m.primitives || []);

    if (primitives.length === 0) {
      throw new Error('No primitives found in mesh');
    }

    // Collect all faces and their colors
    const faces = [];
    const colors = [];
    const metadata = {};
    const allPositions = [];
    const imageCache = new Map(); // image index -> decoded {data, width, height} | null
    let sawTextured = false;
    let sawVertex = false;
    let sawMaterial = false;

    for (const prim of primitives) {
      // Only triangle primitives (mode 4 is the default when omitted)
      if (prim.mode !== undefined && prim.mode !== 4) {
        console.warn(`Skipping primitive with non-triangle mode ${prim.mode}`);
        continue;
      }

      // Ensure primitive has required attributes
      if (!prim.attributes || prim.attributes.POSITION === undefined) {
        console.warn('Skipping primitive without POSITION attribute');
        continue;
      }

      const positions = this._getAccessorData(prim.attributes.POSITION, accessors, bufferViews, bin);
      if (!positions || positions.length === 0) {
        console.warn('Skipping primitive with no positions');
        continue;
      }

      // Indexed or non-indexed geometry
      let indices = this._getAccessorData(prim.indices, accessors, bufferViews, bin);
      if (!indices || indices.length === 0) {
        // Non-indexed: vertices are laid out as consecutive triangles
        const vertexCount = Math.floor(positions.length / 3);
        indices = Array.from({ length: vertexCount - (vertexCount % 3) }, (_, i) => i);
        if (indices.length === 0) {
          console.warn('Skipping primitive with no triangles');
          continue;
        }
      }

      // Offset face indices so all primitives share one vertex list
      const vertexOffset = allPositions.length / 3;
      for (let p = 0; p < positions.length; p++) allPositions.push(positions[p]);

      // Detect color mode
      let vertexColors = null;
      let colorStride = 3;
      let textureData = null;
      let materialColor = null;

      if (prim.attributes.COLOR_0 !== undefined) {
        // Per-vertex color (VEC3 or VEC4)
        vertexColors = this._getAccessorData(prim.attributes.COLOR_0, accessors, bufferViews, bin);
        const colorAccessor = accessors[prim.attributes.COLOR_0];
        colorStride = colorAccessor?.type === 'VEC4' ? 4 : 3;
        if (vertexColors) sawVertex = true;
      }
      if (!vertexColors && prim.attributes.TEXCOORD_0 !== undefined && json.textures && json.images) {
        // Textured mesh: resolve material -> baseColorTexture -> image, decode & sample
        const material = prim.material !== undefined ? json.materials?.[prim.material] : null;
        const texInfo = material?.pbrMetallicRoughness?.baseColorTexture;
        const texture = texInfo ? json.textures[texInfo.index] : json.textures[0];
        const imageIdx = texture?.source;
        if (imageIdx !== undefined) {
          if (!imageCache.has(imageIdx)) {
            imageCache.set(imageIdx, await this._decodeGlbImage(json, bin, imageIdx, bufferViews));
          }
          const image = imageCache.get(imageIdx);
          if (image) {
            const uvs = this._getAccessorData(prim.attributes.TEXCOORD_0, accessors, bufferViews, bin);
            const baseColorFactor = material?.pbrMetallicRoughness?.baseColorFactor || null;
            if (uvs) textureData = { uvs, image, baseColorFactor };
          }
        }
        if (textureData) sawTextured = true;
      }
      if (!vertexColors && !textureData && prim.material !== undefined && json.materials) {
        // Material-based color
        const material = json.materials[prim.material];
        if (material?.pbrMetallicRoughness?.baseColorFactor) {
          materialColor = material.pbrMetallicRoughness.baseColorFactor;
          sawMaterial = true;
        }
      }

      // Extract faces
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        const face = {
          indices: [a + vertexOffset, b + vertexOffset, c + vertexOffset],
          color: null,
        };

        // Sample face color based on detection mode
        if (vertexColors) {
          // Average vertex colors
          const c0 = this._getColor(vertexColors, a, colorStride);
          const c1 = this._getColor(vertexColors, b, colorStride);
          const c2 = this._getColor(vertexColors, c, colorStride);
          face.vertexColors = [c0, c1, c2];
          face.color = [
            (c0[0] + c1[0] + c2[0]) / 3,
            (c0[1] + c1[1] + c2[1]) / 3,
            (c0[2] + c1[2] + c2[2]) / 3,
          ];
        } else if (textureData) {
          // Sample the base color texture at each vertex UV (preserves gradient)
          const { uvs, image, baseColorFactor } = textureData;
          const sample = (vi) => {
            const rgb = this._sampleTexture(image, uvs[vi * 2], uvs[vi * 2 + 1]);
            return baseColorFactor
              ? [rgb[0] * baseColorFactor[0], rgb[1] * baseColorFactor[1], rgb[2] * baseColorFactor[2]]
              : rgb;
          };
          const c0 = sample(a), c1 = sample(b), c2 = sample(c);
          face.vertexColors = [c0, c1, c2];
          face.color = [
            (c0[0] + c1[0] + c2[0]) / 3,
            (c0[1] + c1[1] + c2[1]) / 3,
            (c0[2] + c1[2] + c2[2]) / 3,
          ];
        } else if (materialColor) {
          face.color = materialColor.slice(0, 3);
        } else {
          // Default gray for monochrome
          face.color = [0.5, 0.5, 0.5];
        }

        faces.push(face);
      }
    }

    if (faces.length === 0) {
      throw new Error('No triangle geometry could be extracted from this GLB (all primitives were skipped - see console warnings)');
    }

    metadata.colorMode = sawTextured ? 'textured'
                          : sawVertex ? 'vertex'
                          : sawMaterial ? 'material'
                          : 'monochrome';

    return { faces, metadata, positions: allPositions, bin };
  }

  /**
   * Decode an embedded glTF image (PNG/JPEG in a bufferView) to raw RGBA pixels.
   * @private
   * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}|null>}
   */
  static async _decodeGlbImage(json, bin, imageIdx, bufferViews) {
    try {
      const image = json.images?.[imageIdx];
      if (!image || image.bufferView === undefined) return null;
      const bv = bufferViews[image.bufferView];
      if (!bv) return null;
      const start = bv.byteOffset || 0;
      const bytes = bin.subarray(start, start + bv.byteLength);
      const blob = new Blob([bytes], { type: image.mimeType || 'image/png' });
      const bitmap = await createImageBitmap(blob);

      // Downscale very large textures - we only sample face centroids
      const maxDim = 1024;
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));

      let canvas;
      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(w, h);
      } else {
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
      const { data } = ctx.getImageData(0, 0, w, h);
      return { data, width: w, height: h };
    } catch (err) {
      console.warn(`Failed to decode GLB image ${imageIdx}:`, err);
      return null;
    }
  }

  /**
   * Sample decoded texture at UV (repeat wrap), returns RGB in [0,1].
   * @private
   */
  static _sampleTexture(image, u, v) {
    // Repeat wrap
    let uu = u - Math.floor(u);
    let vv = v - Math.floor(v);
    const x = Math.min(image.width - 1, Math.floor(uu * image.width));
    const y = Math.min(image.height - 1, Math.floor(vv * image.height));
    const idx = (y * image.width + x) * 4;
    return [image.data[idx] / 255, image.data[idx + 1] / 255, image.data[idx + 2] / 255];
  }

  /**
   * Get accessor data from buffer views
   * @private
   */
  static _getAccessorData(accessorIdx, accessors, bufferViews, bin) {
    if (accessorIdx === undefined || accessorIdx === null) return null;

    const accessor = accessors[accessorIdx];
    if (!accessor) {
      console.warn(`Accessor ${accessorIdx} not found`);
      return null;
    }

    const bufferView = bufferViews[accessor.bufferView];
    if (!bufferView) {
      console.warn(`BufferView ${accessor.bufferView} not found`);
      return null;
    }

    const offset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    const count = accessor.count;
    const itemSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type] || 1;

    // componentType → [TypedArray, bytes, max value for normalization]
    const compInfo = {
      5120: [Int8Array, 1, 127],
      5121: [Uint8Array, 1, 255],
      5122: [Int16Array, 2, 32767],
      5123: [Uint16Array, 2, 65535],
      5125: [Uint32Array, 4, 4294967295],
      5126: [Float32Array, 4, 1],
    }[accessor.componentType];

    if (!compInfo) {
      console.warn(`Unsupported componentType ${accessor.componentType}`);
      return null;
    }

    const [TypedArray, bytesPer, maxVal] = compInfo;
    const tightBytes = itemSize * bytesPer;
    const stride = bufferView.byteStride || tightBytes;

    try {
      const out = new Array(count * itemSize);

      if (stride === tightBytes && (bin.byteOffset + offset) % bytesPer === 0) {
        // Tightly packed and aligned: view directly
        const array = new TypedArray(bin.buffer, bin.byteOffset + offset, count * itemSize);
        for (let i = 0; i < out.length; i++) out[i] = array[i];
      } else {
        // Interleaved or unaligned: read element-by-element via DataView
        const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
        const readers = {
          5120: (o) => dv.getInt8(o),
          5121: (o) => dv.getUint8(o),
          5122: (o) => dv.getInt16(o, true),
          5123: (o) => dv.getUint16(o, true),
          5125: (o) => dv.getUint32(o, true),
          5126: (o) => dv.getFloat32(o, true),
        };
        const read = readers[accessor.componentType];
        for (let i = 0; i < count; i++) {
          const base = offset + i * stride;
          for (let c = 0; c < itemSize; c++) {
            out[i * itemSize + c] = read(base + c * bytesPer);
          }
        }
      }

      // Normalized integer attributes (e.g. u8/u16 vertex colors) → 0..1 floats
      if (accessor.normalized && maxVal !== 1) {
        for (let i = 0; i < out.length; i++) out[i] = out[i] / maxVal;
      }

      return out;
    } catch (err) {
      console.warn(`Failed to read accessor ${accessorIdx}: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract RGB color from vertex color buffer
   * @private
   */
  static _getColor(vertexColors, vertexIdx, stride = 3) {
    const start = vertexIdx * stride;
    return [vertexColors[start], vertexColors[start + 1], vertexColors[start + 2]];
  }

  /**
   * Calculate face centroid for texture sampling
   * @private
   */
  static _getFaceCentroid(positions, indices) {
    const v0 = this._getVertex(positions, indices[0]);
    const v1 = this._getVertex(positions, indices[1]);
    const v2 = this._getVertex(positions, indices[2]);
    return [
      (v0[0] + v1[0] + v2[0]) / 3,
      (v0[1] + v1[1] + v2[1]) / 3,
      (v0[2] + v1[2] + v2[2]) / 3,
    ];
  }

  /**
   * Extract 3D vertex from position array
   * @private
   */
  static _getVertex(positions, vertexIdx) {
    const start = vertexIdx * 3;
    return [positions[start], positions[start + 1], positions[start + 2]];
  }
}

export default GLBParser;
