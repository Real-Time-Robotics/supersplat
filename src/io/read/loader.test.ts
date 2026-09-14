import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryReadFileSystem, createChunkDataPool, materializeToDataTable, type ChunkSource } from '@playcanvas/splat-transform';

import { loadSplatSource } from './loader.ts';

const ply = (count: number, properties: string[], rowBytes: number, write: (view: DataView, offset: number, row: number) => void) => {
    const header = new TextEncoder().encode([
        'ply', 'format binary_little_endian 1.0', `element vertex ${count}`, ...properties, 'end_header', ''
    ].join('\n'));
    const bytes = new Uint8Array(header.length + count * rowBytes);
    bytes.set(header);
    const view = new DataView(bytes.buffer, header.length);
    for (let row = 0; row < count; row++) {
        write(view, row * rowBytes, row);
    }
    return bytes;
};

const XYZ_RGB = ['x', 'y', 'z'].map(p => `property float ${p}`)
.concat(['red', 'green', 'blue'].map(p => `property uchar ${p}`));

const writeXyzRgb = (view: DataView, offset: number, row: number) => {
    view.setFloat32(offset, row, true);
    view.setFloat32(offset + 4, row * 2, true);
    view.setFloat32(offset + 8, row * 3, true);
    view.setUint8(offset + 12, 255);
    view.setUint8(offset + 13, 128);
    view.setUint8(offset + 14, 0);
};

const GAUSSIAN = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const load = (filename: string, bytes: Uint8Array, skipReorder = true) => {
    const fileSystem = new MemoryReadFileSystem();
    fileSystem.set(filename, bytes);
    return loadSplatSource(filename, fileSystem, skipReorder);
};

const materialize = async (source: ChunkSource) => {
    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    try {
        return await materializeToDataTable(source, pool);
    } finally {
        pool.destroy();
    }
};

const assertSplatLayers = (source: ChunkSource) => {
    for (const layer of ['position', 'geometric', 'color'] as const) {
        assert.ok(source.meta.availableLayers.has(layer), layer);
    }
};

test('a plain xyz/rgb PLY loads as a promoted point cloud', async () => {
    const result = await load('cloud.ply', ply(4, XYZ_RGB, 15, writeXyzRgb));
    try {
        assert.equal(result.pointCloud, true);
        assert.equal(result.source.meta.numGaussians, 4);
        assertSplatLayers(result.source);
        const table = await materialize(result.source);
        assert.deepEqual(Array.from(table.getColumnByName('y').data), [0, 2, 4, 6]);
    } finally {
        await result.source.close();
    }
});

test('an OpenMVS dense cloud with list properties loads as a point cloud', async () => {
    const properties = [...XYZ_RGB, 'property list uchar uint view_indices'];
    const result = await load('scene_dense.ply', ply(3, properties, 20, (view, offset, row) => {
        writeXyzRgb(view, offset, row);
        view.setUint8(offset + 15, 1);
        view.setUint32(offset + 16, 7, true);
    }));
    try {
        assert.equal(result.pointCloud, true);
        assert.equal(result.source.meta.numGaussians, 3);
        assertSplatLayers(result.source);
    } finally {
        await result.source.close();
    }
});

test('morton ordering a point cloud keeps every point', async () => {
    const result = await load('cloud.ply', ply(6, XYZ_RGB, 15, writeXyzRgb), false);
    try {
        const table = await materialize(result.source);
        const xs = Array.from(table.getColumnByName('x').data).sort((a, b) => a - b);
        assert.deepEqual(xs, [0, 1, 2, 3, 4, 5]);
    } finally {
        await result.source.close();
    }
});

test('a gaussian PLY loads as a splat, not a point cloud', async () => {
    const properties = GAUSSIAN.map(p => `property float ${p}`);
    const result = await load('splat.ply', ply(2, properties, GAUSSIAN.length * 4, (view, offset, row) => {
        GAUSSIAN.forEach((name, i) => {
            view.setFloat32(offset + i * 4, name === 'rot_0' ? 1 : row, true);
        });
    }));
    try {
        assert.equal(result.pointCloud, false);
        assert.equal(result.source.meta.numGaussians, 2);
        assertSplatLayers(result.source);
    } finally {
        await result.source.close();
    }
});
