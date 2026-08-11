import assert from 'node:assert/strict';
import { test } from 'node:test';

import { folderFingerprint, newRunName, normalizeObjectName } from './reconstruction-names.ts';

test('normalizeObjectName flattens a relative path and strips unsafe characters', () => {
    assert.equal(normalizeObjectName('set a/DJI_0001.JPG', 0), 'set_a__DJI_0001.JPG');
    assert.equal(normalizeObjectName('deep\\win\\path.png', 0), 'deep__win__path.png');
    assert.equal(normalizeObjectName('', 7), 'image-7.jpg');
    assert.equal(normalizeObjectName('///', 3), 'image-3.jpg');
});

test('folderFingerprint ignores ordering but not content', () => {
    const a = [{ name: 'b.jpg', size: 2 }, { name: 'a.jpg', size: 1 }];
    const b = [{ name: 'a.jpg', size: 1 }, { name: 'b.jpg', size: 2 }];
    assert.equal(folderFingerprint(a), folderFingerprint(b));
    assert.notEqual(folderFingerprint(a), folderFingerprint([{ name: 'a.jpg', size: 9 }]));
    assert.notEqual(folderFingerprint(a), folderFingerprint([...a, { name: 'c.jpg', size: 3 }]));
});

test('newRunName stays inside the server pattern and keeps the preset readable', () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;   // gateway state._RUN_NAME_RE
    const name = newRunName('standard');
    assert.ok(pattern.test(name), name);
    assert.ok(name.startsWith('standard-'), name);
});

test('newRunName never repeats, so a failed run cannot reserve its own retry', () => {
    // Small: past a handful this only re-tests crypto.randomUUID
    const names = new Set(Array.from({ length: 50 }, () => newRunName('standard')));
    assert.equal(names.size, 50);
});
