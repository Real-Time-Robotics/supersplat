import { BoundingBox } from 'playcanvas';

import { Camera } from './camera';

const fitCameraToBound = (camera: Camera, bound: BoundingBox, speed = 0) => {
    camera.focus({
        focalPoint: bound.center,
        radius: Math.max(bound.halfExtents.length(), 0.001),
        speed
    });
};

export { fitCameraToBound };
