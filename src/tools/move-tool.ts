import { TranslateGizmo } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { TransformTool } from './transform-tool';

class MoveTool extends TransformTool {
    constructor(events: Events, scene: Scene) {
        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);

        super(gizmo, events, scene);
    }
}

export { MoveTool };
