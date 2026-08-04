import { MeshoptDecoder } from 'meshoptimizer/decoder';

import { align4, buildGlb, parseGlb } from './glb-format';

const EXTENSION = 'EXT_meshopt_compression';
const MAX_DECODED_BYTES = 1536 * 1024 * 1024;

let workersInitialized = false;

const requireInteger = (value: unknown, label: string) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`Invalid ${EXTENSION} ${label}.`);
    }
    return value as number;
};

const removeExtension = (list: string[] | undefined) => {
    if (!list) {
        return;
    }
    const index = list.indexOf(EXTENSION);
    if (index !== -1) {
        list.splice(index, 1);
    }
};

const decodeMeshoptGlb = async (contents: ArrayBuffer): Promise<ArrayBuffer> => {
    const { json, binary } = parseGlb(contents);
    const compressedViews = (json.bufferViews ?? [])
    .map((view: any, index: number) => ({ view, index, extension: view.extensions?.[EXTENSION] }))
    .filter((entry: any) => entry.extension);

    if (compressedViews.length === 0) {
        return contents;
    }
    if (!Array.isArray(json.buffers) || json.buffers.length === 0) {
        throw new Error('The Meshopt model does not define a source buffer.');
    }

    if (!workersInitialized && typeof Worker !== 'undefined') {
        const workerCount = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
        MeshoptDecoder.useWorkers(workerCount);
        workersInitialized = true;
    }
    await MeshoptDecoder.ready;

    let decodedBytes = 0;
    const decodedViews: Array<{ index: number; bytes: Uint8Array; mode: string; stride: number }> = [];
    for (const { index, extension } of compressedViews) {
        if (extension.buffer !== 0) {
            throw new Error('Meshopt data must use the embedded GLB buffer.');
        }

        const byteOffset = requireInteger(extension.byteOffset ?? 0, 'byteOffset');
        const byteLength = requireInteger(extension.byteLength, 'byteLength');
        const count = requireInteger(extension.count, 'count');
        const stride = requireInteger(extension.byteStride, 'byteStride');
        const outputLength = count * stride;
        if (!Number.isSafeInteger(outputLength) || outputLength > MAX_DECODED_BYTES - decodedBytes) {
            throw new Error('The decoded model exceeds the 1.5 GiB browser memory safety limit.');
        }
        if (byteOffset + byteLength > binary.byteLength) {
            throw new Error('The Meshopt compressed bufferView is truncated.');
        }

        const source = binary.subarray(byteOffset, byteOffset + byteLength);
        const bytes = await MeshoptDecoder.decodeGltfBufferAsync(
            count,
            stride,
            source,
            extension.mode,
            extension.filter ?? 'NONE'
        );
        decodedBytes += bytes.byteLength;
        decodedViews.push({ index, bytes, mode: extension.mode, stride });
    }

    const compressedIndices = new Set(decodedViews.map(entry => entry.index));
    const unsupportedView = (json.bufferViews ?? []).find((view: any, index: number) => (
        view.buffer !== 0 && !compressedIndices.has(index)
    ));
    if (unsupportedView) {
        throw new Error('Meshopt models with non-fallback secondary buffers are not supported.');
    }

    const originalLength = binary.byteLength;
    let outputLength = align4(originalLength);
    for (const entry of decodedViews) {
        outputLength += align4(entry.bytes.byteLength);
    }
    if (outputLength > MAX_DECODED_BYTES) {
        throw new Error('The expanded model exceeds the 1.5 GiB browser memory safety limit.');
    }

    const output = new Uint8Array(outputLength);
    output.set(binary);
    let offset = align4(originalLength);
    for (const entry of decodedViews) {
        output.set(entry.bytes, offset);
        const view = json.bufferViews[entry.index];
        view.buffer = 0;
        view.byteOffset = offset;
        view.byteLength = entry.bytes.byteLength;
        if (entry.mode === 'ATTRIBUTES') {
            view.byteStride = entry.stride;
        } else {
            delete view.byteStride;
        }
        delete view.extensions[EXTENSION];
        if (Object.keys(view.extensions).length === 0) {
            delete view.extensions;
        }
        offset += align4(entry.bytes.byteLength);
    }

    json.buffers = [{ ...json.buffers[0], byteLength: output.byteLength }];
    delete json.buffers[0].extensions?.[EXTENSION];
    if (json.buffers[0].extensions && Object.keys(json.buffers[0].extensions).length === 0) {
        delete json.buffers[0].extensions;
    }
    removeExtension(json.extensionsUsed);
    removeExtension(json.extensionsRequired);
    return buildGlb(json, output);
};

export { decodeMeshoptGlb };
