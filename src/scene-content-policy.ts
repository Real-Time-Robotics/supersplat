type SceneContentKind = 'photogrammetry' | 'gaussian-splat';

type SceneContentCounts = {
    photogrammetry: number;
    gaussianSplats: number;
};

const getContentConflict = (
    counts: SceneContentCounts,
    incoming: SceneContentKind
) => {
    if (incoming === 'photogrammetry' && counts.gaussianSplats > 0) {
        return 'Photogrammetry and Gaussian Splat models cannot share one scene. Use File > Open to replace the current scene, or remove the loaded Gaussian Splat first.';
    }

    if (incoming === 'gaussian-splat' && counts.photogrammetry > 0) {
        return 'Gaussian Splat and photogrammetry models cannot share one scene. Use File > Open to replace the current scene, or remove the loaded photogrammetry model first.';
    }

    return null;
};

export { getContentConflict, SceneContentCounts, SceneContentKind };
