import {
    Asset,
    BoundingBox,
    ContainerResource,
    Entity,
    Mat4,
    Mesh,
    Quat,
    RenderComponent,
    StandardMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from '../element';
import { Serializer } from '../serializer';
import { Transform } from '../transform';
import { configureModelMaterial } from './model-material';

const inverseWorld = new Mat4();
const pivotPosition = new Vec3();

class ModelElement extends Element {
    readonly asset: Asset;
    readonly entity: Entity;
    readonly name: string;
    readonly localBound = new BoundingBox();
    readonly worldBoundStorage = new BoundingBox();

    private _visible = true;
    private ownedMaterials: StandardMaterial[] = [];

    constructor(asset: Asset, filename: string) {
        super(ElementType.model);
        this.asset = asset;
        this.name = filename;
        this.entity = (asset.resource as ContainerResource).instantiateRenderEntity({
            castShadows: false,
            receiveShadows: false
        });
        this.entity.name = filename;
    }

    add() {
        this.scene.contentRoot.addChild(this.entity);
        this.configureRenderComponents();
        this.entity.syncHierarchy();
        this.calculateLocalBound();
        this.updateWorldBound();
        this.entity.enabled = this.visible;
    }

    remove() {
        this.entity.remove();
    }

    destroy() {
        const app = this.scene?.app;
        super.destroy();
        this.entity.destroy();
        this.ownedMaterials.forEach(material => material.destroy());
        this.ownedMaterials.length = 0;
        this.asset.unload();
        app?.assets.remove(this.asset);
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.visible);
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        if (position) {
            this.entity.setLocalPosition(position);
        }
        if (rotation) {
            this.entity.setLocalRotation(rotation);
        }
        if (scale) {
            this.entity.setLocalScale(scale);
        }
        this.entity.syncHierarchy();
        this.updateWorldBound();
        this.scene?.events.fire('model.moved', this);
    }

    getPivot(result: Transform) {
        this.entity.getLocalTransform().transformPoint(this.localBound.center, pivotPosition);
        result.set(pivotPosition, this.entity.getLocalRotation(), this.entity.getLocalScale());
    }

    set visible(value: boolean) {
        if (value !== this._visible) {
            this._visible = value;
            this.entity.enabled = value;
            this.scene?.events.fire('model.visibility', this);
            if (this.scene) {
                this.scene.forceRender = true;
            }
        }
    }

    get visible() {
        return this._visible;
    }

    get worldBound() {
        return this.worldBoundStorage;
    }

    /** Deduped: one mesh drawn by several instances still owns one vertex buffer. */
    get vertexCount() {
        const meshes = new Set<Mesh>();
        for (const render of this.entity.findComponents('render') as RenderComponent[]) {
            for (const meshInstance of render.meshInstances) {
                meshes.add(meshInstance.mesh);
            }
        }
        let total = 0;
        for (const mesh of meshes) {
            total += mesh.vertexBuffer?.numVertices ?? 0;
        }
        return total;
    }

    private configureRenderComponents() {
        const renders = this.entity.findComponents('render') as RenderComponent[];
        const materialMap = new Map<StandardMaterial, StandardMaterial>();

        for (const render of renders) {
            render.layers = [this.scene.worldLayer.id];
            render.castShadows = false;
            render.receiveShadows = false;
            for (const meshInstance of render.meshInstances) {
                const source = meshInstance.material;
                if (source instanceof StandardMaterial) {
                    let material = materialMap.get(source);
                    if (!material) {
                        material = source.clone();
                        configureModelMaterial(material);
                        materialMap.set(source, material);
                        this.ownedMaterials.push(material);
                    }
                    meshInstance.material = material;
                }
            }
        }
    }

    private calculateLocalBound() {
        const renders = this.entity.findComponents('render') as RenderComponent[];
        let valid = false;
        const worldBound = new BoundingBox();
        for (const render of renders) {
            for (const meshInstance of render.meshInstances) {
                if (valid) {
                    worldBound.add(meshInstance.aabb);
                } else {
                    worldBound.copy(meshInstance.aabb);
                    valid = true;
                }
            }
        }
        if (!valid) {
            throw new Error('The glTF model does not contain renderable mesh instances.');
        }

        inverseWorld.copy(this.entity.getWorldTransform()).invert();
        this.localBound.setFromTransformedAabb(worldBound, inverseWorld);
    }

    private updateWorldBound() {
        this.worldBoundStorage.setFromTransformedAabb(this.localBound, this.entity.getWorldTransform());
        if (this.scene) {
            this.scene.boundDirty = true;
        }
    }
}

export { ModelElement };
