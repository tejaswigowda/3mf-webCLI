/**
 * 3MF Authoring Module
 * 
 * Creates valid 3MF files (ZIP + XML) with per-triangle material assignment.
 * Follows 3MF spec: https://3mf.io/specification/
 */

class ThreeMFAuthorer {
  /**
   * Create a 3MF file from geometry and material assignments.
   * Approach: ONE watertight mesh (all vertices welded across materials) with
   * per-triangle material assignment (3MF core `pid`/`p1`). A single shared
   * vertex pool keeps the mesh manifold - separate per-material objects leave
   * open boundary edges at cluster cuts that slicers flag as non-manifold.
   * @param {Array} faces - Face data with indices
   * @param {Array} positions - Vertex positions (flat array)
   * @param {Array<Array<number>>} materialColors - RGB colors for each material
   * @param {Array<number>} faceAssignments - Material index for each face
   * @returns {Promise<ArrayBuffer>} 3MF file as ArrayBuffer
   */
  static async author(faces, positions, materialColors, faceAssignments) {
    if (!faces || faces.length === 0) {
      throw new Error('No faces to author');
    }
    if (faceAssignments.length !== faces.length) {
      throw new Error('Face assignments length mismatch');
    }

    // Weld all vertices into one pool (watertight), keeping per-face material.
    const { weldedPositions, weldedFaces } = this._weldAllVertices(faces, positions);

    // Create 3D model XML (single mesh, per-triangle material)
    const modelXml = this._createModelXmlSingleMesh(
      weldedPositions, weldedFaces, faceAssignments, materialColors,
    );

    // Create Bambu model settings config (names the object)
    const configXml = this._createModelSettingsConfig(this._lastObjectId);

    // Create relationship XML
    const rlsXml = this._createRelationshipsXml();

    // Create content types XML
    const ctXml = this._createContentTypesXml();

    // Create minimal ZIP structure
    const zip = this._createZip({
      '3D/3dmodel.model': modelXml,
      'Metadata/model_settings.config': configXml,
      '_rels/.rels': rlsXml,
      '[Content_Types].xml': ctXml,
    });

    return zip;
  }

  /**
   * Weld all faces into a single vertex pool (quantized position dedupe), so the
   * mesh is watertight/manifold. Returns welded positions + faces (per original
   * face order, so faceAssignments stays aligned).
   * @private
   * @returns {{weldedPositions: Array<number>, weldedFaces: Array<Array<number>>}}
   */
  static _weldAllVertices(allFaces, allPositions) {
    const weld = new Map();
    const remap = new Map();
    const weldedPositions = [];

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
      }
      remap.set(vi, w);
      return w;
    };

    const weldedFaces = allFaces.map((f) => {
      const [a, b, c] = f.indices;
      return [weldedIndex(a), weldedIndex(b), weldedIndex(c)];
    });

    return { weldedPositions, weldedFaces };
  }

  /**
   * Encode a whole-triangle Bambu Studio `paint_color` for painting state `n`
   * (0 = base filament → no attribute). Mirrors BambuStudio TriangleSelector
   * serialize(): leaf split bits (00), then 2 bits of n for n<3, else the 0b11
   * indicator + repeated 1111 per 15 + 4 bits of the remainder; nibbles are
   * emitted LSB-first and the hex string lists them in reverse.
   * Verified: 1→"4", 2→"8", 3→"0C", 4→"1C", 7→"4C".
   * @private
   */
  static _bambuPaintColor(n) {
    if (!n) return null; // state 0 = base filament, no paint_color
    const bits = [0, 0]; // leaf (number_of_split_sides = 0)
    if (n < 3) {
      bits.push(n & 1, (n >> 1) & 1);
    } else {
      bits.push(1, 1); // 0b11 extended-state indicator
      let r = n - 3;
      while (r >= 15) { bits.push(1, 1, 1, 1); r -= 15; }
      for (let i = 0; i < 4; i++) bits.push((r >> i) & 1);
    }
    while (bits.length % 4 !== 0) bits.push(0);
    const nibbles = [];
    for (let k = 0; k < bits.length; k += 4) {
      let v = 0;
      for (let i = 0; i < 4; i++) v |= bits[k + i] << i;
      nibbles.push(v.toString(16).toUpperCase());
    }
    return nibbles.reverse().join('');
  }

  /**
   * Create 3D model XML as a SINGLE watertight mesh with per-triangle material.
   * All triangles share one welded vertex pool (manifold); each triangle carries
   * `pid="1" p1="<materialIndex>"` (3MF core per-triangle material).
   * @private
   * @param {Array<number>} weldedPositions - flat [x,y,z,...]
   * @param {Array<Array<number>>} weldedFaces - [[a,b,c], ...] (per original face)
   * @param {Array<number>} faceAssignments - material index per face
   * @param {Array<Array<number>>} materialColors - RGB for each material
   */
  static _createModelXmlSingleMesh(weldedPositions, weldedFaces, faceAssignments, materialColors) {
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    parts.push('<model unit="millimeter" xml:lang="en-US" ' +
           'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
           'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" ' +
           'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">\n');

    parts.push(' <resources>\n');

    // Material definitions (one per unique material)
    parts.push('  <m:basematerials id="1">\n');
    for (let i = 0; i < materialColors.length; i++) {
      const [r, g, b] = materialColors[i];
      const hexColor = this._rgbToHex(r, g, b);
      parts.push(`   <m:base name="Color ${i + 1}" displaycolor="${hexColor}"/>\n`);
    }
    parts.push('  </m:basematerials>\n');

    // Single object: one welded mesh, default material (pid=1, pindex=0)
    const objId = 2;
    const objUuid = this._generateUUID();
    parts.push(`  <object id="${objId}" p:UUID="${objUuid}" type="model" pid="1" pindex="0">\n`);
    parts.push('   <mesh>\n');

    parts.push('    <vertices>\n');
    for (let i = 0; i < weldedPositions.length; i += 3) {
      const x = weldedPositions[i].toFixed(6);
      const y = weldedPositions[i + 1].toFixed(6);
      const z = weldedPositions[i + 2].toFixed(6);
      parts.push(`     <vertex x="${x}" y="${y}" z="${z}"/>\n`);
    }
    parts.push('    </vertices>\n');

    // Per-triangle material: `pid`/`p1` (3MF core, read by PrusaSlicer) plus
    // Bambu's `paint_color` (read by Bambu Studio → maps each region to a filament).
    parts.push('    <triangles>\n');
    for (let f = 0; f < weldedFaces.length; f++) {
      const [a, b, c] = weldedFaces[f];
      const mat = faceAssignments[f] || 0;
      const paint = this._bambuPaintColor(mat);
      const paintAttr = paint ? ` paint_color="${paint}"` : '';
      parts.push(`     <triangle v1="${a}" v2="${b}" v3="${c}" pid="1" p1="${mat}"${paintAttr}/>\n`);
    }
    parts.push('    </triangles>\n');

    parts.push('   </mesh>\n');
    parts.push('  </object>\n');

    parts.push(' </resources>\n');

    // Build section: reference the single object
    const buildUuid = this._generateUUID();
    parts.push(' <build>\n');
    parts.push(`  <item objectid="${objId}" p:UUID="${buildUuid}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n`);
    parts.push(' </build>\n');

    parts.push('</model>\n');

    // Stash object id for the config
    this._lastObjectId = objId;

    return parts.join('');
  }

  /**
   * Create Bambu-style model_settings.config naming the single object. With
   * per-triangle base materials, slicers map each base material to a filament.
   * @private
   */
  static _createModelSettingsConfig(objectId) {
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    parts.push('<config>\n');
    parts.push(`  <object id="${objectId}">\n`);
    parts.push('    <metadata key="name" value="segmented"/>\n');
    parts.push('    <metadata key="extruder" value="1"/>\n');
    parts.push('  </object>\n');
    parts.push('</config>\n');
    return parts.join('');
  }

  /**
   * Create relationships XML
   * @private
   */
  static _createRelationshipsXml() {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
    xml += '  <Relationship Id="rel1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="3D/3dmodel.model"/>\n';
    xml += '</Relationships>\n';
    return xml;
  }

  /**
   * Create content types XML
   * @private
   */
  static _createContentTypesXml() {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n';
    xml += '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n';
    xml += '  <Default Extension="model" ContentType="application/vnd.ms-3mf.model+xml"/>\n';
    xml += '</Types>\n';
    return xml;
  }

  /**
   * Create minimal ZIP file (3MF is a ZIP container)
   * @private
   */
  static _createZip(files) {
    const entries = [];
    let offset = 0;

    // Calculate total size needed
    let totalSize = 0;
    const fileList = Object.entries(files);

    // Create central directory records
    const centralDir = [];

    for (const [filename, content] of fileList) {
      const isText = typeof content === 'string';
      const data = isText ? new TextEncoder().encode(content) : content;

      // Local file header
      let localHeader = this._createLocalFileHeader(filename, data, offset);
      totalSize += localHeader.length;
      totalSize += data.length;

      entries.push({ name: filename, data, localHeader });

      // Central directory entry
      centralDir.push(this._createCentralDirEntry(filename, data, offset));
      offset += localHeader.length + data.length;
    }

    // Create central directory and end of central directory
    let cdData = new Uint8Array(0);
    let cdOffset = offset;

    for (const cd of centralDir) {
      const combined = this._concatenateArrays(cdData, cd);
      cdData = combined;
    }

    const eocd = this._createEndOfCentralDirectory(centralDir.length, cdData.length, cdOffset);

    // Combine all parts
    let zipData = new Uint8Array(0);

    for (const entry of entries) {
      zipData = this._concatenateArrays(zipData, entry.localHeader);
      zipData = this._concatenateArrays(zipData, entry.data);
    }

    zipData = this._concatenateArrays(zipData, cdData);
    zipData = this._concatenateArrays(zipData, eocd);

    return zipData.buffer;
  }

  /**
   * Create ZIP local file header
   * @private
   */
  static _createLocalFileHeader(filename, data, offset) {
    const nameBytes = new TextEncoder().encode(filename);
    const headerSize = 30 + nameBytes.length;
    const header = new Uint8Array(headerSize);
    const view = new DataView(header.buffer);

    let pos = 0;

    // Local file header signature
    view.setUint32(pos, 0x04034b50, true); pos += 4;

    // Version needed to extract
    view.setUint16(pos, 0x0a, true); pos += 2;

    // General purpose bit flag (bit 3: size in data descriptor)
    view.setUint16(pos, 0, true); pos += 2;

    // Compression method (0 = stored)
    view.setUint16(pos, 0, true); pos += 2;

    // Last mod file time/date
    view.setUint16(pos, 0, true); pos += 2;
    view.setUint16(pos, 0, true); pos += 2;

    // CRC-32
    const crc = this._crc32(data);
    view.setUint32(pos, crc, true); pos += 4;

    // Compressed size
    view.setUint32(pos, data.length, true); pos += 4;

    // Uncompressed size
    view.setUint32(pos, data.length, true); pos += 4;

    // Filename length
    view.setUint16(pos, nameBytes.length, true); pos += 2;

    // Extra field length
    view.setUint16(pos, 0, true); pos += 2;

    // Filename
    header.set(nameBytes, pos);

    return header;
  }

  /**
   * Create ZIP central directory entry
   * @private
   */
  static _createCentralDirEntry(filename, data, localOffset) {
    const nameBytes = new TextEncoder().encode(filename);
    const entrySize = 46 + nameBytes.length;
    const entry = new Uint8Array(entrySize);
    const view = new DataView(entry.buffer);

    let pos = 0;

    // Central directory file header signature
    view.setUint32(pos, 0x02014b50, true); pos += 4;

    // Version made by
    view.setUint16(pos, 0x0a, true); pos += 2;

    // Version needed to extract
    view.setUint16(pos, 0x0a, true); pos += 2;

    // General purpose bit flag
    view.setUint16(pos, 0, true); pos += 2;

    // Compression method
    view.setUint16(pos, 0, true); pos += 2;

    // Last mod file time/date
    view.setUint16(pos, 0, true); pos += 2;
    view.setUint16(pos, 0, true); pos += 2;

    // CRC-32
    const crc = this._crc32(data);
    view.setUint32(pos, crc, true); pos += 4;

    // Compressed size
    view.setUint32(pos, data.length, true); pos += 4;

    // Uncompressed size
    view.setUint32(pos, data.length, true); pos += 4;

    // Filename length
    view.setUint16(pos, nameBytes.length, true); pos += 2;

    // Extra field length
    view.setUint16(pos, 0, true); pos += 2;

    // File comment length
    view.setUint16(pos, 0, true); pos += 2;

    // Disk number start
    view.setUint16(pos, 0, true); pos += 2;

    // Internal file attributes
    view.setUint16(pos, 0, true); pos += 2;

    // External file attributes
    view.setUint32(pos, 0, true); pos += 4;

    // Relative offset of local header
    view.setUint32(pos, localOffset, true); pos += 4;

    // Filename
    entry.set(nameBytes, pos);

    return entry;
  }

  /**
   * Create ZIP end of central directory record
   * @private
   */
  static _createEndOfCentralDirectory(numEntries, cdSize, cdOffset) {
    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);

    let pos = 0;

    // End of central directory signature
    view.setUint32(pos, 0x06054b50, true); pos += 4;

    // Disk number
    view.setUint16(pos, 0, true); pos += 2;

    // Disk with central directory
    view.setUint16(pos, 0, true); pos += 2;

    // Number of central directory records on this disk
    view.setUint16(pos, numEntries, true); pos += 2;

    // Total number of central directory records
    view.setUint16(pos, numEntries, true); pos += 2;

    // Size of central directory
    view.setUint32(pos, cdSize, true); pos += 4;

    // Offset of central directory
    view.setUint32(pos, cdOffset, true); pos += 4;

    // Comment length
    view.setUint16(pos, 0, true); pos += 2;

    return eocd;
  }

  /**
   * Calculate CRC-32 checksum
   * @private
   */
  static _crc32(data) {
    const crcTable = this._makeCrcTable();
    let crc = 0 ^ -1;

    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
    }

    return (crc ^ -1) >>> 0;
  }

  /**
   * Create CRC-32 lookup table
   * @private
   */
  static _makeCrcTable() {
    let c;
    const crcTable = [];

    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }

    return crcTable;
  }

  /**
   * Concatenate two Uint8Arrays
   * @private
   */
  static _concatenateArrays(a, b) {
    const result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
  }

  /**
   * Convert RGB [0-1] to hex color string with alpha channel
   * @private
   */
  static _rgbToHex(r, g, b) {
    const toHex = (c) => {
      const val = Math.round((c > 1 ? c : c * 255));
      return val.toString(16).padStart(2, '0');
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}FF`;
  }

  /**
   * Generate a simple UUID-like string
   * @private
   */
  static _generateUUID() {
    return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () => 
      Math.floor(Math.random() * 16).toString(16)
    );
  }
}

export default ThreeMFAuthorer;
