/**
 * Photogrammetry dense clouds (scene_dense.ply) as gaussian splats.
 *
 * Synthesizing the gaussian properties a cloud lacks turns it into an ordinary Splat.
 */

import { Column, DataTable } from '@playcanvas/splat-transform';

import { dcEncode } from '../../splat-math';

// sigmoid(8) = 0.9997 alpha - solid to the eye, and far enough from the ends of
// the curve that the editor's opacity slider still has somewhere to go.
const OPAQUE_LOGIT = 8;

const DEFAULT_COLOUR = 128;

// radius (scene units) when the cloud is too degenerate to estimate a spacing from
const FALLBACK_RADIUS = 0.01;

const POSITION_PROPS = ['x', 'y', 'z'];

const POINT_BYTES = 62;

// Share of reported system memory a promoted cloud may occupy.
const MEMORY_SHARE = 0.25;

/**
 * How many points to keep from a cloud, which has no pre-built LODs to choose from.
 *
 */
const pointCloudBudget = (deviceMemory = (globalThis.navigator as Navigator & {
    deviceMemory?: number
})?.deviceMemory ?? 4): number => {
    return Math.round(deviceMemory * MEMORY_SHARE * 1024 ** 3 / POINT_BYTES);
};

/**
 * True when the table holds positions but not gaussians. Checks one property per
 * group: a file with f_dc but no scale is a broken splat, not a cloud, and should
 * still fail validation.
 */
const isPointCloud = (dataTable: DataTable): boolean => {
    return POSITION_PROPS.every(name => dataTable.hasColumn(name)) &&
        !dataTable.hasColumn('f_dc_0') &&
        !dataTable.hasColumn('scale_0') &&
        !dataTable.hasColumn('rot_0');
};

/**
 * Point spacing estimated from the bounding box, used as the splat radius.
 * Dense-cloud points sit on surfaces rather than filling a volume, so their
 * density is points-per-area: spacing ~ sqrt(area / count) over the box faces.
 */
const estimatePointRadius = (x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>): number => {
    const n = x.length;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        if (x[i] < minX) minX = x[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i];
        if (y[i] > maxY) maxY = y[i];
        if (z[i] < minZ) minZ = z[i];
        if (z[i] > maxZ) maxZ = z[i];
    }

    const w = maxX - minX;
    const h = maxY - minY;
    const d = maxZ - minZ;
    const area = w * h + w * d + h * d;
    if (n < 2 || !(area > 0)) {
        return FALLBACK_RADIUS;
    }
    return Math.sqrt(area / n) * 0.5;
};

/**
 * Read a colour channel as linear 0..1 - uchar (OpenMVS, Open3D) or float 0..1,
 * depending on the writer.
 */
const colourReader = (column: Column | undefined): ((index: number) => number) => {
    if (!column) {
        const grey = DEFAULT_COLOUR / 255;
        return () => grey;
    }
    const { data } = column;
    const scale = data instanceof Float32Array || data instanceof Float64Array ? 1 : 1 / 255;
    return (index: number) => data[index] * scale;
};

/**
 * Give a point cloud the gaussian properties of a splat: colour from the SH
 * band-0 term, full opacity, no rotation, and a uniform radius. Returns a new
 * table; source colours and normals are dropped once baked into f_dc, and
 * positions are demoted to float32. `radius` overrides the estimate, and
 * `maxPoints` subsamples evenly on the way through.
 */
const promotePointCloud = (dataTable: DataTable, radius?: number, maxPoints = Infinity): DataTable => {
    // Promotion gives every point fourteen float32 columns, so a cloud that
    // reached here without a read-time budget (any plain PLY) has to be thinned
    // now or it is ~56 bytes per point of new allocation.
    const stride = Math.max(1, Math.ceil(dataTable.numRows / maxPoints));
    const n = Math.ceil(dataTable.numRows / stride);

    const positions = POSITION_PROPS.map((name) => {
        const source = dataTable.getColumnByName(name).data;
        if (stride === 1) {
            return new Column(name, source instanceof Float32Array ? source : Float32Array.from(source));
        }
        const kept = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            kept[i] = source[i * stride];
        }
        return new Column(name, kept);
    });

    const red = colourReader(dataTable.getColumnByName('red'));
    const green = colourReader(dataTable.getColumnByName('green'));
    const blue = colourReader(dataTable.getColumnByName('blue'));
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const source = i * stride;
        r[i] = dcEncode(red(source));
        g[i] = dcEncode(green(source));
        b[i] = dcEncode(blue(source));
    }

    // scale is stored as a log, rotation as an identity quaternion (w first)
    const logRadius = Math.log(radius ??
        estimatePointRadius(positions[0].data, positions[1].data, positions[2].data));
    const constant = (name: string, value: number) => new Column(name, new Float32Array(n).fill(value));

    return new DataTable([
        ...positions,
        new Column('f_dc_0', r),
        new Column('f_dc_1', g),
        new Column('f_dc_2', b),
        constant('opacity', OPAQUE_LOGIT),
        constant('scale_0', logRadius),
        constant('scale_1', logRadius),
        constant('scale_2', logRadius),
        constant('rot_0', 1),
        constant('rot_1', 0),
        constant('rot_2', 0),
        constant('rot_3', 0)
    ], dataTable.transform);
};

export {
    FALLBACK_RADIUS,
    OPAQUE_LOGIT,
    estimatePointRadius,
    isPointCloud,
    pointCloudBudget,
    promotePointCloud
};
