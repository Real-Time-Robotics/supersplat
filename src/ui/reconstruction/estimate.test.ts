import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateTotalPixels, shortfallNote, type Decode } from './estimate.ts';

const folder = (count: number): File[] => Array.from(
    { length: count }, (_, index) => new File([], `img-${index}.jpg`));

/** Decodes each file to the size at its index, so a test controls exactly what is sampled. */
const decoder = (sizes: [number, number][]): Decode => async (file) => {
    const index = Number(/img-(\d+)/.exec(file.name)?.[1]);
    const [width, height] = sizes[index];
    return { width, height };
};

test('the folder is priced at its sampled size times its file count', async () => {
    const sizes: [number, number][] = Array.from({ length: 50 }, () => [4000, 3000]);
    assert.equal(await estimateTotalPixels(folder(50), decoder(sizes)), 4000 * 3000 * 50);
});

test('one odd image among the photos does not drag the estimate with it', async () => {
    const sizes: [number, number][] = Array.from({ length: 41 }, () => [4000, 3000]);
    sizes[20] = [640, 480];
    assert.equal(await estimateTotalPixels(folder(41), decoder(sizes)), 4000 * 3000 * 41);
});

test('the sample is spread across the folder, not taken off the front', async () => {
    const seen: string[] = [];
    const decode: Decode = async (file) => {
        seen.push(file.name);
        return { width: 100, height: 100 };
    };
    await estimateTotalPixels(folder(9), decode);
    assert.deepEqual(seen, ['img-0.jpg', 'img-4.jpg', 'img-8.jpg']);
});

test('a folder the browser cannot decode prices off the server instead', async () => {
    const decode: Decode = () => Promise.reject(new Error('TIFF is not decodable here'));
    assert.equal(await estimateTotalPixels(folder(30), decode), null);
});

test('one unreadable image does not throw the whole estimate away', async () => {
    const decode: Decode = async (file) => {
        if (file.name === 'img-0.jpg') throw new Error('corrupt');
        return { width: 1000, height: 1000 };
    };
    assert.equal(await estimateTotalPixels(folder(3), decode), 1_000_000 * 3);
});

test('an empty folder has nothing to sample', async () => {
    assert.equal(await estimateTotalPixels([], decoder([])), null);
});

test('a balance that covers the folder produces no note at all', () => {
    assert.equal(shortfallNote(100, 100, true), null);
    assert.equal(shortfallNote(100, 250, true), null);
});

test('a shortfall says how much is missing and that the upload may still go', () => {
    const note = shortfallNote(900, 250, true) as string;
    assert.match(note, /900/);
    assert.match(note, /250/);
    assert.match(note, /650/);
    assert.match(note, /Vẫn tải lên được/);
});

test('an unmeasured folder says so, so nobody reads the number as a price', () => {
    assert.match(shortfallNote(900, 0, false) as string, /thô/);
    assert.doesNotMatch(shortfallNote(900, 0, true) as string, /thô/);
});
