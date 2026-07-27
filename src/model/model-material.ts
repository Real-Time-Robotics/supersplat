import { StandardMaterial } from 'playcanvas';

// SuperSplat's world layer does not provide the lighting environment expected
// by glTF PBR materials. Convert their base color path to an unlit emissive path
// so photogrammetry vertex colors and base-color textures remain visible.
const configureModelMaterial = (material: StandardMaterial) => {
    if (material.useLighting) {
        material.emissive.copy(material.diffuse);
        material.emissiveMap = material.diffuseMap;
        material.emissiveMapUv = material.diffuseMapUv;
        material.emissiveMapTiling.copy(material.diffuseMapTiling);
        material.emissiveMapOffset.copy(material.diffuseMapOffset);
        material.emissiveMapRotation = material.diffuseMapRotation;
        material.emissiveMapChannel = material.diffuseMapChannel;
        material.emissiveVertexColor = material.diffuseVertexColor;
        material.emissiveVertexColorChannel = material.diffuseVertexColorChannel;

        material.diffuse.set(1, 1, 1);
        material.diffuseMap = null;
        material.diffuseVertexColor = false;
    }

    material.useLighting = false;
    material.useSkybox = false;
    material.update();
};

export { configureModelMaterial };
