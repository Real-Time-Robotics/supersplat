import { buildGlb, GltfDocument } from './glb-format';
import { inspectGlbBlob, usesMeshopt } from './glb-inspect';

type ModelImportFile = {
    filename: string;
    url?: string;
    contents?: File;
};

type ModelSource = {
    filename: string;
    contents: Blob | ArrayBuffer;
    json: GltfDocument;
    meshopt: boolean;
};

const decodeDataUri = (uri: string): Uint8Array => {
    const match = /^data:([^,]*),(.*)$/s.exec(uri);
    if (!match) {
        throw new Error('The glTF buffer URI is not a valid data URI.');
    }

    if (match[1].split(';').includes('base64')) {
        const decoded = atob(match[2]);
        const result = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) {
            result[i] = decoded.charCodeAt(i);
        }
        return result;
    }
    const encoded = match[2];
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i++) {
        if (encoded[i] === '%' && /^[0-9a-f]{2}$/i.test(encoded.substring(i + 1, i + 3))) {
            bytes.push(parseInt(encoded.substring(i + 1, i + 3), 16));
            i += 2;
        } else {
            bytes.push(encoded.charCodeAt(i) & 0xff);
        }
    }
    return new Uint8Array(bytes);
};

const assertSingleFile = (json: GltfDocument, isGlb: boolean) => {
    const externalBuffer = (json.buffers ?? []).find((buffer: any, index: number) => {
        if (isGlb && index === 0 && !buffer.uri) {
            return false;
        }
        return !buffer.uri || !buffer.uri.startsWith('data:');
    });
    const externalImage = (json.images ?? []).find((image: any) => image.uri && !image.uri.startsWith('data:'));

    if (externalBuffer || externalImage) {
        throw new Error('This glTF references external files. Please use a single-file GLB or a glTF with embedded data URIs.');
    }
};

const assertMeshModel = (json: GltfDocument) => {
    if ((json.extensionsUsed ?? []).includes('KHR_gaussian_splatting')) {
        throw new Error('This GLB contains Gaussian splats, not a photogrammetry mesh.');
    }
    if (!Array.isArray(json.meshes) || json.meshes.length === 0) {
        throw new Error('The file does not contain a renderable glTF mesh.');
    }
};

const readFile = async (file: ModelImportFile): Promise<Blob> => {
    if (file.contents) {
        return file.contents;
    }
    if (file.url) {
        const response = await fetch(file.url);
        if (!response.ok) {
            throw new Error(`Unable to download the model (${response.status} ${response.statusText}).`);
        }
        return response.blob();
    }
    throw new Error('The model has no file contents or URL.');
};

const inspectModelSource = async (file: ModelImportFile): Promise<ModelSource> => {
    const extension = file.filename.split('.').pop()?.toLowerCase();
    if (extension === 'bin') {
        throw new Error('A .bin file is only glTF binary data and cannot be opened without its .gltf manifest.');
    }
    if (extension !== 'glb' && extension !== 'gltf') {
        throw new Error('Only .glb and .gltf photogrammetry models are supported.');
    }

    const contents = await readFile(file);
    if (extension === 'glb') {
        const json = await inspectGlbBlob(contents);
        assertSingleFile(json, true);
        assertMeshModel(json);
        return {
            filename: file.filename,
            contents,
            json,
            meshopt: usesMeshopt(json)
        };
    }

    let json: GltfDocument;
    try {
        json = JSON.parse(await contents.text());
    } catch {
        throw new Error('The glTF manifest is not valid JSON.');
    }
    if (json.asset?.version !== '2.0') {
        throw new Error('Only glTF 2.0 models are supported.');
    }
    assertSingleFile(json, false);
    assertMeshModel(json);

    const buffers = json.buffers ?? [];
    if (buffers.length !== 1 || !buffers[0].uri?.startsWith('data:')) {
        throw new Error('A single-file glTF must contain exactly one embedded binary buffer.');
    }

    const binary = decodeDataUri(buffers[0].uri);
    const glbJson = structuredClone(json);
    delete glbJson.buffers[0].uri;
    glbJson.buffers[0].byteLength = binary.byteLength;
    return {
        filename: file.filename.replace(/\.gltf$/i, '.glb'),
        contents: buildGlb(glbJson, binary),
        json: glbJson,
        meshopt: usesMeshopt(glbJson)
    };
};

export { ModelImportFile, ModelSource, inspectModelSource };
