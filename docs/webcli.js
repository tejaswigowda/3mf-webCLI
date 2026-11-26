export function parseRunParams(search, hash) {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ''));
  const get = key => fragment.has(key) ? fragment.get(key) : query.get(key);
  if (!fragment.has('run') && !query.has('run')) return null;

  const run = get('run');
  if (run !== 'convert') throw new Error(`Unknown run=${run}. Supported: convert.`);
  const src = get('src');
  if (!src) throw new Error('run=convert needs src=<GLB URL>.');
  const materials = get('materials');
  if (materials !== null && !/^[2-8]$/.test(materials)) {
    throw new Error('materials must be an integer from 2 to 8.');
  }
  const download = get('download');
  if (download !== null && download !== '1') throw new Error('download must be 1 when specified.');
  return { run, src, materials: materials === null ? null : Number(materials), download: download === '1' };
}

export async function fetchInput(src, base, fetchImpl = fetch) {
  const url = new URL(src, base);
  if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) {
    throw new Error('src must be an HTTP(S), data, or blob URL.');
  }
  const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit' });
  if (!response.ok) throw new Error(`Input GET failed: ${response.status} ${response.statusText}`.trim());
  const buffer = await response.arrayBuffer();
  const name = ['http:', 'https:'].includes(url.protocol)
    ? decodeURIComponent(url.pathname.split('/').pop() || '')
    : '';
  return { buffer, name: /\.glb$/i.test(name) ? name : 'model.glb' };
}

export function makeArtifact(buffer, name) {
  const mime = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
  const artifact = { mime, name, size: buffer.byteLength };
  let dataUrl;
  Object.defineProperty(artifact, 'dataUrl', {
    enumerable: true,
    get() {
      if (!dataUrl) {
        const bytes = new Uint8Array(buffer);
        const parts = [];
        for (let i = 0; i < bytes.length; i += 0x8000) {
          parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
        }
        dataUrl = `data:${mime};base64,${btoa(parts.join(''))}`;
      }
      return dataUrl;
    },
  });
  return artifact;
}
