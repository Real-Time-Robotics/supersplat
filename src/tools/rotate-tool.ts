import { RotateGizmo } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { TransformTool } from './transform-tool';

class RotateTool extends TransformTool {
    constructor(events: Events, scene: Scene) {
        const gizmo = new RotateGizmo(scene.camera.camera, scene.gizmoLayer);
        gizmo.rotationMode = 'orbit';

        super(gizmo, events, scene);
    }
}

export { RotateTool };
