const RECONSTRUCTION_PIPELINES = new Set(['splat', 'photogrammetry']);

const PHOTOGRAMMETRY_UPLOAD_OVERRIDES = {
    run_downscale: true,
    run_feature: true,
    run_matching: true,
    run_mapper: true,
    run_sor: true,
    downscale_factor: 4,
    image_subdir: 'images_4',
    sparse_subdir: 'sparse/0_geo',
    geo_register: true,
    run_georef: true,
    run_ortho: true
};

const RUN_NAME_PATTERN = /^[a-z0-9][\w.-]*$/i;

const isValidRunName = (name: string): boolean => RUN_NAME_PATTERN.test(name);

const withRunName = (config: Record<string, any>, runNameField: string,
    runName: string): Record<string, any> => {
    const [head, ...rest] = runNameField.split('.');
    if (rest.length === 0) return { ...config, [head]: runName };
    return { ...config, [head]: withRunName(config[head] ?? {}, rest.join('.'), runName) };
};

const buildJobConfig = (input: {
    presetConfig: Record<string, any>;
    pipeline: string;
    datasetId: string;
    runNameField: string;
    runName: string;
}): Record<string, any> => withRunName({
    ...input.presetConfig,
    ...(input.pipeline === 'photogrammetry' ? PHOTOGRAMMETRY_UPLOAD_OVERRIDES : {}),
    data_dir: input.datasetId
}, input.runNameField, input.runName);

export {
    PHOTOGRAMMETRY_UPLOAD_OVERRIDES,
    RECONSTRUCTION_PIPELINES,
    buildJobConfig,
    isValidRunName,
    withRunName
};
