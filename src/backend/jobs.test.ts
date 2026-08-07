import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildJobConfig, isValidRunName, withRunName } from './jobs';

test('a flat run-name field is set at the top level', () => {
    assert.deepEqual(withRunName({ a: 1 }, 'run_name', 'r1'), { a: 1, run_name: 'r1' });
});

test('a nested run-name field merges rather than replacing its parent', () => {
    const config = { train: { steps: 30000, lr: 0.01 }, data_dir: 'ds1' };
    assert.deepEqual(withRunName(config, 'train.result_name', 'r1'), {
        train: { steps: 30000, lr: 0.01, result_name: 'r1' },
        data_dir: 'ds1'
    });
});

test('a nested run-name field is created when the parent is absent', () => {
    assert.deepEqual(withRunName({}, 'train.result_name', 'r1'), { train: { result_name: 'r1' } });
});

test('withRunName does not mutate its input', () => {
    const config = { train: { steps: 1 } };
    withRunName(config, 'train.result_name', 'r1');
    assert.deepEqual(config, { train: { steps: 1 } });
});

test('photogrammetry gets the upload overrides, splat does not', () => {
    const splat = buildJobConfig({
        presetConfig: { steps: 30000 },
        pipeline: 'splat',
        datasetId: 'ds1',
        runNameField: 'train.result_name',
        runName: 'standard'
    });
    assert.equal(splat.run_ortho, undefined);
    assert.equal(splat.data_dir, 'ds1');
    assert.deepEqual(splat.train, { result_name: 'standard' });

    const photogrammetry = buildJobConfig({
        presetConfig: { steps: 1 },
        pipeline: 'photogrammetry',
        datasetId: 'ds2',
        runNameField: 'run_name',
        runName: 'standard'
    });
    assert.equal(photogrammetry.run_ortho, true);
    assert.equal(photogrammetry.image_subdir, 'images_4');
    assert.equal(photogrammetry.sparse_subdir, 'sparse/0_geo');
    assert.equal(photogrammetry.run_name, 'standard');
});

test('run names are fenced to the gateway pattern', () => {
    for (const good of ['standard', 'run-1', 'a.b_c', 'A1']) {
        assert.ok(isValidRunName(good), good);
    }
    for (const bad of ['', '-leading', '.leading', 'has space', 'has/slash', '../escape']) {
        assert.ok(!isValidRunName(bad), bad);
    }
});
