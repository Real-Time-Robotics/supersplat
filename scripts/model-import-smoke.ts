import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { StandardMaterial } from 'playcanvas';

import { buildGlb, parseGlb } from '../src/model/glb-format';
import { decodeMeshoptGlb } from '../src/model/meshopt-decode';
import { configureModelMaterial } from '../src/model/model-material';
import { inspectModelSource } from '../src/model/model-source';
import { getContentConflict } from '../src/scene-content-policy';

await MeshoptEncoder.ready;

const equal = (actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
};

const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
]);
const raw = new Uint8Array(positions.buffer);
const compressed = MeshoptEncoder.encodeGltfBuffer(raw, 3, 12, 'ATTRIBUTES');
const json: any = {
    asset: { version: '2.0' },
    extensionsUsed: ['EXT_meshopt_compression'],
    extensionsRequired: ['EXT_meshopt_compression'],
    buffers: [{ byteLength: compressed.byteLength }],
    bufferViews: [{
        buffer: 0,
        byteOffset: 0,
        byteLength: raw.byteLength,
        byteStride: 12,
        extensions: {
            EXT_meshopt_compression: {
                buffer: 0,
                byteOffset: 0,
                byteLength: compressed.byteLength,
                byteStride: 12,
                count: 3,
                mode: 'ATTRIBUTES',
                filter: 'NONE'
            }
        }
    }],
    accessors: [{
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0]
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0
};

const decoded = await decodeMeshoptGlb(buildGlb(json, compressed));
const parsed = parseGlb(decoded);
equal(parsed.json.bufferViews[0].extensions, undefined);
equal(parsed.json.extensionsRequired.length, 0);
const decodedOffset = parsed.json.bufferViews[0].byteOffset;
equal(
    [...parsed.binary.subarray(decodedOffset, decodedOffset + raw.byteLength)],
    [...raw]
);

// gltfpack -cc GLBs put compressed bytes in buffer 0 and describe a URI-less
// fallback buffer for the decoded views. This remains a self-contained GLB and
// must be flattened to the single BIN buffer before PlayCanvas parses it.
const fallbackJson = structuredClone(json);
fallbackJson.buffers = [
    { byteLength: compressed.byteLength },
    {
        byteLength: raw.byteLength,
        extensions: { EXT_meshopt_compression: { fallback: true } }
    }
];
fallbackJson.bufferViews[0].buffer = 1;
const fallbackGlb = buildGlb(fallbackJson, compressed);
const fallbackSource = await inspectModelSource({
    filename: 'gltfpack.glb',
    contents: new Blob([fallbackGlb]) as File
});
equal(fallbackSource.meshopt, true);
const decodedFallback = parseGlb(await decodeMeshoptGlb(await (fallbackSource.contents as Blob).arrayBuffer()));
equal(decodedFallback.json.buffers.length, 1);
equal(decodedFallback.json.bufferViews[0].buffer, 0);
equal(decodedFallback.json.bufferViews[0].extensions, undefined);
const decodedFallbackOffset = decodedFallback.json.bufferViews[0].byteOffset;
equal(
    [...decodedFallback.binary.subarray(decodedFallbackOffset, decodedFallbackOffset + raw.byteLength)],
    [...raw]
);

const embedded = structuredClone(json);
embedded.extensionsUsed = [];
embedded.extensionsRequired = [];
embedded.bufferViews[0] = {
    buffer: 0,
    byteOffset: 0,
    byteLength: raw.byteLength,
    byteStride: 12
};
embedded.buffers[0] = {
    byteLength: raw.byteLength,
    uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...raw))}`
};
const source = await inspectModelSource({
    filename: 'triangle.gltf',
    contents: new Blob([JSON.stringify(embedded)]) as File
});
equal(source.filename, 'triangle.glb');
equal(source.meshopt, false);
equal([...parseGlb(source.contents as ArrayBuffer).binary.subarray(0, raw.byteLength)], [...raw]);

const vertexColorMaterial = new StandardMaterial();
vertexColorMaterial.diffuse.set(0.25, 0.5, 0.75);
vertexColorMaterial.diffuseVertexColor = true;
configureModelMaterial(vertexColorMaterial);
equal(vertexColorMaterial.useLighting, false);
equal(
    [vertexColorMaterial.emissive.r, vertexColorMaterial.emissive.g, vertexColorMaterial.emissive.b],
    [0.25, 0.5, 0.75]
);
equal(vertexColorMaterial.emissiveVertexColor, true);
equal(vertexColorMaterial.diffuseVertexColor, false);

const alreadyUnlitMaterial = new StandardMaterial();
alreadyUnlitMaterial.useLighting = false;
alreadyUnlitMaterial.emissive.set(0.1, 0.2, 0.3);
alreadyUnlitMaterial.emissiveVertexColor = true;
configureModelMaterial(alreadyUnlitMaterial);
equal(
    [alreadyUnlitMaterial.emissive.r, alreadyUnlitMaterial.emissive.g, alreadyUnlitMaterial.emissive.b],
    [0.1, 0.2, 0.3]
);
equal(alreadyUnlitMaterial.emissiveVertexColor, true);

equal(getContentConflict({
    photogrammetry: 0,
    gaussianSplats: 1
}, 'photogrammetry') !== null, true);
equal(getContentConflict({
    photogrammetry: 1,
    gaussianSplats: 0
}, 'gaussian-splat') !== null, true);
equal(getContentConflict({
    photogrammetry: 1,
    gaussianSplats: 0
}, 'photogrammetry'), null);

console.log('model import smoke tests passed');
