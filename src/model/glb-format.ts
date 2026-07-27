const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

type GltfDocument = Record<string, any>;

type ParsedGlb = {
    json: GltfDocument;
    binary: Uint8Array;
};

const align4 = (value: number) => (value + 3) & ~3;

const parseGlb = (contents: ArrayBuffer): ParsedGlb => {
    if (contents.byteLength < 20) {
        throw new Error('The GLB file is truncated.');
    }

    const view = new DataView(contents);
    if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION) {
        throw new Error('Only glTF 2.0 GLB files are supported.');
    }
    if (view.getUint32(8, true) !== contents.byteLength) {
        throw new Error('The GLB header length does not match the file size.');
    }

    let offset = 12;
    let json: GltfDocument = null;
    let binary = new Uint8Array();
    while (offset + 8 <= contents.byteLength) {
        const length = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        offset += 8;
        if (offset + length > contents.byteLength) {
            throw new Error('The GLB contains a truncated chunk.');
        }

        if (type === JSON_CHUNK && !json) {
            const text = new TextDecoder().decode(new Uint8Array(contents, offset, length)).trimEnd();
            json = JSON.parse(text);
        } else if (type === BIN_CHUNK && binary.byteLength === 0) {
            binary = new Uint8Array(contents, offset, length);
        }
        offset += length;
    }

    if (!json) {
        throw new Error('The GLB does not contain a JSON chunk.');
    }
    return { json, binary };
};

const buildGlb = (json: GltfDocument, binary: Uint8Array): ArrayBuffer => {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = align4(jsonBytes.byteLength);
    const binaryLength = align4(binary.byteLength);
    const totalLength = 12 + 8 + jsonLength + (binaryLength > 0 ? 8 + binaryLength : 0);
    const result = new ArrayBuffer(totalLength);
    const view = new DataView(result);
    const bytes = new Uint8Array(result);

    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, GLB_VERSION, true);
    view.setUint32(8, totalLength, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, JSON_CHUNK, true);
    bytes.fill(0x20, 20, 20 + jsonLength);
    bytes.set(jsonBytes, 20);

    if (binaryLength > 0) {
        const chunkOffset = 20 + jsonLength;
        view.setUint32(chunkOffset, binaryLength, true);
        view.setUint32(chunkOffset + 4, BIN_CHUNK, true);
        bytes.set(binary, chunkOffset + 8);
    }

    return result;
};

export { GltfDocument, ParsedGlb, align4, buildGlb, parseGlb };
