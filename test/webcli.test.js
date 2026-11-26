import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunParams, fetchInput, makeArtifact } from '../docs/webcli.js';

test('parses fragment and query runs with fragment precedence', () => {
  assert.equal(parseRunParams('', ''), null);
  assert.deepEqual(
    parseRunParams('?src=old.glb&materials=2&run=convert', '#&src=new.glb&materials=4&download=1'),
    { run: 'convert', src: 'new.glb', materials: 4, download: true },
  );
  assert.equal(parseRunParams('', '#&src=model.glb&run=convert').materials, null);
});

test('rejects invalid runs and options rather than silently proceeding', () => {
  for (const [hash, error] of [
    ['#&run=', /Unknown run/],
    ['#&run=bad', /Unknown run/],
    ['#&run=convert', /needs src/],
    ['#&src=a.glb&run=convert&materials=9', /materials/],
    ['#&src=a.glb&run=convert&materials=2.5', /materials/],
    ['#&src=a.glb&run=convert&download=0', /download/],
  ]) assert.throws(() => parseRunParams('', hash), error);
});

test('fetches input without credentials and surfaces failures', async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const input = await fetchInput('models/test.glb', 'https://example.test/app/', fetcher);
  assert.deepEqual(request, { url: 'https://example.test/app/models/test.glb', options: { method: 'GET', credentials: 'omit' } });
  assert.equal(input.name, 'test.glb');
  assert.deepEqual([...new Uint8Array(input.buffer)], [1, 2, 3]);
  assert.equal((await fetchInput('data:application/octet-stream;base64,AQID', 'https://example.test/', fetcher)).name, 'model.glb');
  await assert.rejects(fetchInput('file:///secret.glb', 'https://example.test/', fetcher), /src must be/);
  await assert.rejects(fetchInput('/missing.glb', 'https://example.test/', async () => new Response('', { status: 404 })), /404/);
});

test('artifact exposes the actual bytes as a lazy data URL', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
  const artifact = makeArtifact(bytes.buffer, 'model.3mf');
  assert.equal(artifact.name, 'model.3mf');
  assert.equal(artifact.size, bytes.length);
  assert.deepEqual(Buffer.from(artifact.dataUrl.split(',')[1], 'base64'), Buffer.from(bytes));
});
