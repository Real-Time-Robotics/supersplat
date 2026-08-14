import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Column, DataTable } from '@playcanvas/splat-transform';

import { FALLBACK_RADIUS, OPAQUE_LOGIT, estimatePointRadius, isPointCloud, pointCloudBudget, promotePointCloud } from './point-cloud.ts';
import { dcDecode } from '../../splat-math.ts';

const cloud = (positions: number[][], colours?: number[][]) => {
    const columns = [
        new Column('x', Float64Array.from(positions.map(p => p[0]))),
        new Column('y', Float64Array.from(positions.map(p => p[1]))),
        new Column('z', Float64Array.from(positions.map(p => p[2])))
    ];
    if (colours) {
        columns.push(
            new Column('red', Uint8Array.from(colours.map(c => c[0]))),
            new Column('green', Uint8Array.from(colours.map(c => c[1]))),
            new Column('blue', Uint8Array.from(colours.map(c => c[2])))
        );
    }
    return new DataTable(columns);
};

const column = (table: DataTable, name: string) => table.getColumnByName(name).data;

test('isPointCloud separates a dense cloud from a splat file', () => {
    assert.equal(isPointCloud(cloud([[0, 0, 0]], [[10, 20, 30]])), true);
    assert.equal(isPointCloud(cloud([[0, 0, 0]])), true);

    const splat = cloud([[0, 0, 0]]);
    splat.addColumn(new Column('f_dc_0', new Float32Array(1)));
    splat.addColumn(new Column('scale_0', new Float32Array(1)));
    splat.addColumn(new Column('rot_0', new Float32Array(1)));
    assert.equal(isPointCloud(splat), false);

    // half a splat is a broken splat, not a cloud - it must still fail validation
    const partial = cloud([[0, 0, 0]]);
    partial.addColumn(new Column('scale_0', new Float32Array(1)));
    assert.equal(isPointCloud(partial), false);
});

test('promotePointCloud emits every property validateGSplatData requires', () => {
    const table = promotePointCloud(cloud([[1, 2, 3], [4, 5, 6]], [[0, 0, 0], [255, 255, 255]]));
    for (const name of ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2',
        'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity']) {
        assert.ok(table.hasColumn(name), name);
    }
    assert.equal(table.numRows, 2);
    assert.equal(table.hasColumn('red'), false);
});

test('promotePointCloud round-trips colour through the SH band-0 term', () => {
    const table = promotePointCloud(cloud([[0, 0, 0], [1, 1, 1]], [[0, 128, 255], [255, 128, 0]]));
    assert.ok(Math.abs(dcDecode(column(table, 'f_dc_0')[0]) - 0) < 1e-6);
    assert.ok(Math.abs(dcDecode(column(table, 'f_dc_1')[0]) - 128 / 255) < 1e-6);
    assert.ok(Math.abs(dcDecode(column(table, 'f_dc_2')[0]) - 1) < 1e-6);
    assert.ok(Math.abs(dcDecode(column(table, 'f_dc_0')[1]) - 1) < 1e-6);
});

test('promotePointCloud makes points solid, unrotated and float32', () => {
    const table = promotePointCloud(cloud([[1, 2, 3], [4, 5, 6]]));
    assert.deepEqual(Array.from(column(table, 'opacity')), [OPAQUE_LOGIT, OPAQUE_LOGIT]);
    assert.deepEqual(Array.from(column(table, 'rot_0')), [1, 1]);      // w first: identity
    assert.deepEqual(Array.from(column(table, 'rot_1')), [0, 0]);
    assert.ok(column(table, 'x') instanceof Float32Array);
    assert.deepEqual(Array.from(column(table, 'x')), [1, 4]);
});

test('promotePointCloud stores the radius as a log, and takes an override', () => {
    const table = promotePointCloud(cloud([[0, 0, 0], [1, 1, 1]]), 0.25);
    assert.ok(Math.abs(column(table, 'scale_0')[0] - Math.log(0.25)) < 1e-6);
    assert.equal(column(table, 'scale_0')[0], column(table, 'scale_2')[1]);
});

test('promotePointCloud keeps an uncoloured cloud visible rather than black', () => {
    const table = promotePointCloud(cloud([[0, 0, 0]]));
    const grey = dcDecode(column(table, 'f_dc_0')[0]);
    assert.ok(grey > 0.4 && grey < 0.6, String(grey));
});

test('pointCloudBudget scales with memory, and holds the promoted cloud under a quarter of it', () => {
    const gib = 1024 ** 3;
    assert.ok(Math.abs(pointCloudBudget(8) * 62 - 2 * gib) < 0.05 * gib);
    assert.ok(Math.abs(pointCloudBudget(8) / pointCloudBudget(4) - 2) < 1e-6);
    assert.equal(pointCloudBudget(), pointCloudBudget(4));
});

test('promotePointCloud subsamples evenly to the budget it is given', () => {
    const positions = Array.from({ length: 8 }, (_, i) => [i, 0, 0]);
    const table = promotePointCloud(cloud(positions), 1, 4);
    assert.equal(table.numRows, 4);
    assert.deepEqual(Array.from(column(table, 'x')), [0, 2, 4, 6]);
    assert.equal(promotePointCloud(cloud(positions), 1, 100).numRows, 8);
});

test('estimatePointRadius scales with the cloud, and falls back when it cannot', () => {
    // 4 points on a 10x10 face -> spacing ~5, radius ~2.5
    const spread = estimatePointRadius([0, 10, 0, 10], [0, 0, 10, 10], [0, 0, 0, 0]);
    assert.ok(spread > 2 && spread < 3, String(spread));
    const bigger = estimatePointRadius([0, 100, 0, 100], [0, 0, 100, 100], [0, 0, 0, 0]);
    assert.ok(Math.abs(bigger / spread - 10) < 1e-6);

    assert.equal(estimatePointRadius([1], [1], [1]), FALLBACK_RADIUS);
    assert.equal(estimatePointRadius([1, 1], [1, 1], [1, 1]), FALLBACK_RADIUS);
});
