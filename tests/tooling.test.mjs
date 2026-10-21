import test from 'node:test';
import assert from 'node:assert/strict';

import { createZip } from '../tools/zip.mjs';
import { encodePng } from '../tools/png.mjs';

test('createZip writes a readable archive', () => {
  const zip = createZip([
    { name: 'php-simple-check/manifest.json', data: JSON.stringify({ a: 1 }) },
    { name: 'php-simple-check/background.js', data: 'console.log(1);\n' }
  ]);

  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local file header signature');

  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, 'end of central directory signature');
  assert.equal(zip.readUInt16LE(eocd + 10), 2, 'entry count');

  const centralOffset = zip.readUInt32LE(eocd + 16);
  let offset = centralOffset;
  const names = [];
  for (let i = 0; i < 2; i += 1) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, 'central directory header signature');
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.deepEqual(names, ['php-simple-check/manifest.json', 'php-simple-check/background.js']);
});

test('encodePng writes a 8-bit RGBA PNG header', () => {
  const png = encodePng(2, 2, new Uint8Array(16).fill(255));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 2);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 6, 'colour type RGBA');
});
