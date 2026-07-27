import { BoundingBox, Entity, Quat, Vec3 } from 'playcanvas';

import { Element } from '../element';
import { Transform } from '../transform';

interface TransformableElement extends Element {
    entity: Entity;
    name: string;
    visible: boolean;
    localBound: BoundingBox;
    worldBound: BoundingBox;

    getPivot(result: Transform): void;
    move(position?: Vec3, rotation?: Quat, scale?: Vec3): void;
}

export { TransformableElement };
