import { GltfDocument } from './glb-format';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;

const inspectGlbBlob = async (blob: Blob): Promise<GltfDocument> => {
    if (blob.size < 20) {
        throw new Error('The GLB file is truncated.');
    }

    const header = new DataView(await blob.slice(0, 20).arrayBuffer());
    if (header.getUint32(0, true) !== GLB_MAGIC || header.getUint32(4, true) !== GLB_VERSION) {
        throw new Error('Only glTF 2.0 GLB files are supported.');
    }
    if (header.getUint32(8, true) !== blob.size) {
        throw new Error('The GLB header length does not match the file size.');
    }

    const jsonLength = header.getUint32(12, true);
    if (header.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > blob.size) {
        throw new Error('The GLB does not contain a valid JSON chunk.');
    }

    const jsonBytes = await blob.slice(20, 20 + jsonLength).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(jsonBytes).trimEnd());
};

const usesMeshopt = (json: GltfDocument) => {
    return (json.bufferViews ?? []).some((view: any) => view.extensions?.EXT_meshopt_compression);
};

export { inspectGlbBlob, usesMeshopt };
