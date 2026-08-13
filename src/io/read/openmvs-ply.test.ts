import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BlobReadSource } from './file-systems.ts';
import { isDenseCloud, parsePlyHeader, probeDenseCloud, readVertexTable } from './openmvs-ply.ts';

const OPENMVS_HEADER = [
    'ply',
    'format binary_little_endian 1.0',
    'element vertex 4',
    'property float32 x',
    'property float32 y',
    'property float32 z',
    'property uint8 red',
    'property uint8 green',
    'property uint8 blue',
    'property float32 nx',
    'property float32 ny',
    'property float32 nz',
    'property list uint8 uint32 view_indices',
    'property list uint8 float32 view_weights',
    'end_header',
    ''
].join('\n');

// fixed position/colour/normal fields, then two view lists of varying length
const openmvsPly = (points: number[][], viewCounts: number[]) => {
    const header = new TextEncoder().encode(OPENMVS_HEADER);
    const rows = points.map((p, i) => {
        const views = viewCounts[i];
        const bytes = new Uint8Array(27 + 1 + views * 4 + 1 + views * 4);
        const view = new DataView(bytes.buffer);
        view.setFloat32(0, p[0], true);
        view.setFloat32(4, p[1], true);
        view.setFloat32(8, p[2], true);
        view.setUint8(12, p[3]);
        view.setUint8(13, p[4]);
        view.setUint8(14, p[5]);
        view.setFloat32(15, 0, true);            // nx
        view.setFloat32(19, 0, true);            // ny
        view.setFloat32(23, 1, true);            // nz
        view.setUint8(27, views);
        for (let v = 0; v < views; v++) {
            view.setUint32(28 + v * 4, v, true);
        }
        view.setUint8(28 + views * 4, views);
        for (let v = 0; v < views; v++) {
            view.setFloat32(29 + views * 4 + v * 4, 1, true);
        }
        return bytes;
    });
    return new Blob([header, ...rows]);
};

const POINTS = [
    [1, 2, 3, 10, 20, 30],
    [4, 5, 6, 40, 50, 60],
    [7, 8, 9, 70, 80, 90],
    [10, 11, 12, 100, 110, 120]
];

const column = (table: any, name: string) => Array.from(table.getColumnByName(name).data);

test('parsePlyHeader reads the list properties splat-transform rejects', () => {
    const header = parsePlyHeader(new TextEncoder().encode(OPENMVS_HEADER));
    assert.equal(header.format, 'binary_little_endian');
    assert.equal(header.headerBytes, OPENMVS_HEADER.length);
    assert.equal(header.elements.length, 1);

    const props = header.elements[0].properties;
    assert.equal(props.length, 11);
    assert.deepEqual(props[0], { name: 'x', type: 'float32' });
    assert.deepEqual(props[9], { name: 'view_indices', type: 'uint32', countType: 'uint8' });
    assert.equal(isDenseCloud(header), true);
});

test('parsePlyHeader declines anything that is not a terminated PLY header', () => {
    assert.equal(parsePlyHeader(new TextEncoder().encode('not a ply at all')), null);
    assert.equal(parsePlyHeader(new TextEncoder().encode('ply\nformat binary_little_endian 1.0\n')), null);
});

test('isDenseCloud is false for a plain cloud, which splat-transform can read itself', () => {
    const plain = parsePlyHeader(new TextEncoder().encode([
        'ply', 'format binary_little_endian 1.0', 'element vertex 1',
        'property double x', 'property double y', 'property double z',
        'property uchar red', 'property uchar green', 'property uchar blue',
        'end_header', ''
    ].join('\n')));
    assert.equal(isDenseCloud(plain), false);
});

test('isDenseCloud is false for a mesh, which must keep failing rather than load as its vertices', () => {
    const mesh = parsePlyHeader(new TextEncoder().encode([
        'ply', 'format binary_little_endian 1.0', 'element vertex 3',
        'property float x', 'property float y', 'property float z',
        'element face 1', 'property list uchar int vertex_indices',
        'end_header', ''
    ].join('\n')));
    assert.equal(isDenseCloud(mesh), false);
});

test('isDenseCloud is false when something precedes the vertices', () => {
    const camerasFirst = parsePlyHeader(new TextEncoder().encode([
        'ply', 'format binary_little_endian 1.0', 'element camera 1',
        'property float view_px', 'element vertex 1',
        'property float x', 'property float y', 'property float z',
        'property list uchar uint view_indices', 'end_header', ''
    ].join('\n')));
    assert.equal(isDenseCloud(camerasFirst), false);
});

test('readVertexTable keeps float colours as floats rather than truncating them to zero', async () => {
    const text = [
        'ply', 'format binary_little_endian 1.0', 'element vertex 1',
        'property float x', 'property float y', 'property float z',
        'property float red', 'property float green', 'property float blue',
        'property list uchar uint view_indices', 'end_header', ''
    ].join('\n');
    const row = new Uint8Array(25);
    const view = new DataView(row.buffer);
    [1, 2, 3, 0.25, 0.5, 0.75].forEach((v, i) => view.setFloat32(i * 4, v, true));
    view.setUint8(24, 0);                                    // no views
    const blob = new Blob([new TextEncoder().encode(text), row]);

    const header = parsePlyHeader(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
    const table = await readVertexTable(new BlobReadSource(blob), header, 100);
    assert.ok(table.getColumnByName('red').data instanceof Float32Array);
    assert.deepEqual(column(table, 'red'), [0.25]);
});

test('probeDenseCloud answers off an open source, leaving it usable', async () => {
    const blob = openmvsPly(POINTS, [2, 0, 5, 1]);
    const source = new BlobReadSource(blob);

    const header = await probeDenseCloud(source);
    assert.equal(header.elements[0].count, 4);
    // the same source still reads, so the caller never opens a second one
    const table = await readVertexTable(source, header, 100);
    assert.deepEqual(column(table, 'x'), [1, 4, 7, 10]);

    assert.equal(await probeDenseCloud(new BlobReadSource(new Blob([
        new TextEncoder().encode('not a ply')
    ]))), null);
});

test('readVertexTable walks variable-length rows and keeps position + colour', async () => {
    const blob = openmvsPly(POINTS, [2, 0, 5, 1]);
    const source = new BlobReadSource(blob);
    const header = parsePlyHeader(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));

    const table = await readVertexTable(source, header, 100);
    assert.equal(table.numRows, 4);
    assert.deepEqual(column(table, 'x'), [1, 4, 7, 10]);
    assert.deepEqual(column(table, 'z'), [3, 6, 9, 12]);
    assert.deepEqual(column(table, 'green'), [20, 50, 80, 110]);
});

test('readVertexTable subsamples evenly down to the point budget', async () => {
    const blob = openmvsPly(POINTS, [3, 1, 4, 1]);
    const header = parsePlyHeader(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));

    const table = await readVertexTable(new BlobReadSource(blob), header, 2);
    assert.equal(table.numRows, 2);
    assert.deepEqual(column(table, 'x'), [1, 7]);          // stride 2: rows 0 and 2
});

test('readVertexTable reports a truncated file rather than returning short data', async () => {
    const full = openmvsPly(POINTS, [2, 2, 2, 2]);
    const cut = full.slice(0, full.size - 8);
    const header = parsePlyHeader(new Uint8Array(await cut.slice(0, 1024).arrayBuffer()));

    await assert.rejects(
        () => readVertexTable(new BlobReadSource(cut), header, 100),
        /truncated/
    );
});

test('readVertexTable refuses formats it would silently misread', async () => {
    const header = parsePlyHeader(new TextEncoder().encode([
        'ply', 'format ascii 1.0', 'element vertex 1',
        'property float x', 'property float y', 'property float z',
        'property list uchar int views', 'end_header', ''
    ].join('\n')));
    await assert.rejects(
        () => readVertexTable(new BlobReadSource(new Blob([])), header, 100),
        /binary_little_endian/
    );
});
