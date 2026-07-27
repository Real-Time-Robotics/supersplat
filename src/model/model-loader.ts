import { Asset } from 'playcanvas';

import { fitCameraToBound } from '../camera-fit';
import { Events } from '../events';
import { Scene } from '../scene';
import { decodeMeshoptGlb } from './meshopt-decode';
import { ModelElement } from './model-element';
import { inspectModelSource, ModelImportFile } from './model-source';

class ModelLoader {
    constructor(private scene: Scene, private events: Events) {}

    async load(file: ModelImportFile) {
        this.events.fire('startSpinner');
        try {
            const source = await inspectModelSource(file);
            let contents = source.contents;
            if (source.meshopt) {
                const buffer = contents instanceof Blob ? await contents.arrayBuffer() : contents;
                contents = await decodeMeshoptGlb(buffer);
            }
            const blob = contents instanceof Blob ?
                contents :
                new Blob([contents], { type: 'model/gltf-binary' });
            const blobUrl = URL.createObjectURL(blob);
            let asset: Asset;
            try {
                asset = await new Promise<Asset>((resolve, reject) => {
                    this.scene.app.assets.loadFromUrlAndFilename(blobUrl, source.filename, 'container', (error, loadedAsset) => {
                        if (error) {
                            reject(new Error(String(error)));
                        } else {
                            resolve(loadedAsset);
                        }
                    });
                });
            } finally {
                URL.revokeObjectURL(blobUrl);
            }

            let model: ModelElement;
            try {
                model = new ModelElement(asset, file.filename);
                await this.scene.add(model);
            } catch (error) {
                if (model) {
                    model.destroy();
                } else {
                    asset.unload();
                    this.scene.app.assets.remove(asset);
                }
                throw error;
            }
            fitCameraToBound(this.scene.camera, model.worldBound);
            this.scene.camera.setAzimElev(0, 0, 0);
            this.scene.camera.ortho = true;
            return model;
        } finally {
            this.events.fire('stopSpinner');
        }
    }
}

export { ModelLoader };
