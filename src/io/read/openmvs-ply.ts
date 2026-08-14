/**
 * Fallback PLY reader for dense clouds that carry list properties.
 *
 * OpenMVS writes scene_dense.ply with per-point visibility as
 * `property list uint8 uint32 view_indices` (+ view_weights); splat-transform's
 * reader accepts only three-word `property <type> <name>` lines and throws on
 * sight of those. Points are subsampled during the walk rather than after:
 * materializing tens of millions of points to then discard most of them needs
 * the memory the subsample exists to avoid.
 */

import { Column, DataTable, ReadStream, type ReadSource } from '@playcanvas/splat-transform';

const HEADER_PROBE_BYTES = 128 * 1024;

// Larger than BLOB_CHUNK_SIZE so refills can use the stream's direct-read path.
const BUFFER_BYTES = 8 * 1024 * 1024;

type PlyType = {
    size: number;
    read: (view: DataView, offset: number) => number;
};

const PLY_TYPES: Record<string, PlyType> = {
    int8: { size: 1, read: (v, o) => v.getInt8(o) },
    uint8: { size: 1, read: (v, o) => v.getUint8(o) },
    int16: { size: 2, read: (v, o) => v.getInt16(o, true) },
    uint16: { size: 2, read: (v, o) => v.getUint16(o, true) },
    int32: { size: 4, read: (v, o) => v.getInt32(o, true) },
    uint32: { size: 4, read: (v, o) => v.getUint32(o, true) },
    float32: { size: 4, read: (v, o) => v.getFloat32(o, true) },
    float64: { size: 8, read: (v, o) => v.getFloat64(o, true) }
};

const PLY_ALIASES: Record<string, string> = {
    char: 'int8',
    uchar: 'uint8',
    short: 'int16',
    ushort: 'uint16',
    int: 'int32',
    uint: 'uint32',
    float: 'float32',
    double: 'float64'
};

const plyType = (name: string): PlyType | undefined => PLY_TYPES[PLY_ALIASES[name] ?? name];

const isFloatType = (name: string): boolean => (PLY_ALIASES[name] ?? name).startsWith('float');

// Columns worth keeping; the index into the output arrays.
const WANTED = ['x', 'y', 'z', 'red', 'green', 'blue'];

type PlyProperty = {
    name: string;
    type: string;
    countType?: string;         // present only on `property list <countType> <type> <name>`
};

type PlyElement = {
    name: string;
    count: number;
    properties: PlyProperty[];
};

type PlyHeader = {
    format: string;
    elements: PlyElement[];
    headerBytes: number;
};

/**
 * Parse a PLY header out of the first bytes of a file. Returns null when the
 * bytes are not a PLY, or the header does not end within the probe, so the
 * caller can report the original failure instead.
 */
const parsePlyHeader = (bytes: Uint8Array): PlyHeader | null => {
    const text = new TextDecoder('ascii').decode(bytes);
    const end = text.indexOf('\nend_header\n');
    if (!text.startsWith('ply') || end < 0) {
        return null;
    }

    const headerBytes = end + '\nend_header\n'.length;
    const elements: PlyElement[] = [];
    let format = '';
    let current: PlyElement = null;

    for (const line of text.substring(0, end).split('\n')) {
        const words = line.trim().split(/\s+/).filter(Boolean);
        switch (words[0]) {
            case 'format':
                format = words[1] ?? '';
                break;
            case 'element':
                current = { name: words[1], count: parseInt(words[2], 10), properties: [] };
                elements.push(current);
                break;
            case 'property':
                if (!current) {
                    return null;
                }
                if (words[1] === 'list') {
                    current.properties.push({ name: words[4], type: words[3], countType: words[2] });
                } else {
                    current.properties.push({ name: words[2], type: words[1] });
                }
                break;
            default:
                break;
        }
    }

    return { format, elements, headerBytes };
};

/**
 * An OpenMVS dense cloud: list properties on the vertices themselves, which is
 * what splat-transform rejects, and no faces. A mesh also carries a list
 * property (its face indices) but must remain rejected rather than load as a
 * subset. Vertices must come
 * first, since the walk starts at the end of the header.
 */
const isDenseCloud = (header: PlyHeader): boolean => {
    const vertex = header.elements[0];
    return vertex?.name === 'vertex' &&
        vertex.properties.some(p => p.countType !== undefined) &&
        !header.elements.some(e => e.name === 'face');
};

/**
 * Buffered window over a stream. Rows are variable length, so the row loop
 * decodes synchronously out of this window rather than paying an await per field.
 */
class WindowReader {
    stream: ReadStream;
    buffer: Uint8Array;
    view: DataView;
    head = 0;
    tail = 0;
    eof = false;

    constructor(stream: ReadStream, capacity: number) {
        this.stream = stream;
        this.buffer = new Uint8Array(capacity);
        this.view = new DataView(this.buffer.buffer);
    }

    async refill(): Promise<void> {
        if (this.head > 0) {
            this.buffer.copyWithin(0, this.head, this.tail);
            this.tail -= this.head;
            this.head = 0;
        }
        while (!this.eof && this.tail < this.buffer.length) {
            const n = await this.stream.pull(this.buffer.subarray(this.tail));
            if (n === 0) {
                this.eof = true;
                break;
            }
            this.tail += n;
        }
    }
}

type Pick = {
    offset: number;
    out: Float32Array | Uint8Array;
    read: (view: DataView, offset: number) => number;
};

// A run of fixed-size properties collapses to one bounds check and a set of
// reads at known offsets; only a list breaks the run, since its length is in the
// data. OpenMVS' 11 properties become three steps.
type Step =
    | { kind: 'run'; len: number; picks: Pick[] }
    | { kind: 'list'; countSize: number; countRead: (view: DataView, offset: number) => number; itemSize: number };

const planRow = (properties: PlyProperty[], out: (Float32Array | Uint8Array)[]) => {
    const steps: Step[] = [];
    const found = new Set<number>();
    let run: Extract<Step, { kind: 'run' }> | null = null;

    for (const p of properties) {
        const type = plyType(p.type);
        if (!type) {
            throw new Error(`The PLY property '${p.name}' has an unsupported type.`);
        }
        if (p.countType !== undefined) {
            const countType = plyType(p.countType);
            if (!countType) {
                throw new Error(`The PLY property '${p.name}' has an unsupported list count type.`);
            }
            steps.push({ kind: 'list', countSize: countType.size, countRead: countType.read, itemSize: type.size });
            run = null;
            continue;
        }
        if (!run) {
            run = { kind: 'run', len: 0, picks: [] };
            steps.push(run);
        }
        const target = WANTED.indexOf(p.name);
        if (target >= 0) {
            found.add(target);
            run.picks.push({ offset: run.len, out: out[target], read: type.read });
        }
        run.len += type.size;
    }

    return { steps, found };
};

/**
 * Decode one row out of the window, writing the wanted properties to `index`
 * (negative to walk the row without keeping it). False when the row runs past
 * what is buffered, leaving the window position untouched so the caller can
 * refill and retry.
 */
const decodeRow = (reader: WindowReader, steps: Step[], index: number): boolean => {
    const { view, tail } = reader;
    let cursor = reader.head;

    for (const step of steps) {
        if (step.kind === 'list') {
            if (cursor + step.countSize > tail) {
                return false;
            }
            cursor += step.countSize + step.countRead(view, cursor) * step.itemSize;
            if (cursor > tail) {
                return false;
            }
        } else {
            if (cursor + step.len > tail) {
                return false;
            }
            if (index >= 0) {
                for (const pick of step.picks) {
                    pick.out[index] = pick.read(view, cursor + pick.offset);
                }
            }
            cursor += step.len;
        }
    }

    reader.head = cursor;
    return true;
};

/**
 * Decode the vertex element into a position + colour table, keeping at most
 * `maxPoints` evenly spaced points. Every row is still walked, since a list
 * property makes the row length unknowable without reading it.
 */
const readVertexTable = async (source: ReadSource, header: PlyHeader, maxPoints: number): Promise<DataTable> => {
    if (header.format !== 'binary_little_endian') {
        throw new Error(`This PLY is '${header.format}'; only binary_little_endian point clouds are supported.`);
    }

    // The walk starts at the end of the header, so anything before the vertices
    // would be decoded as if it were a vertex.
    const element = header.elements[0];
    if (element?.name !== 'vertex') {
        throw new Error('The PLY does not begin with its vertex element.');
    }
    if (element.count === 0) {
        throw new Error('The PLY contains no vertices.');
    }

    const stride = Math.max(1, Math.ceil(element.count / maxPoints));
    const kept = Math.ceil(element.count / stride);
    // Colour is uchar (OpenMVS, Open3D) or float 0..1; keep whichever the file
    // declares, since promotePointCloud picks its scale from the storage type.
    const colour = (name: string) => {
        const p = element.properties.find(q => q.name === name && q.countType === undefined);
        return p && isFloatType(p.type) ? new Float32Array(kept) : new Uint8Array(kept);
    };
    const out = [
        new Float32Array(kept), new Float32Array(kept), new Float32Array(kept),
        colour('red'), colour('green'), colour('blue')
    ];
    const { steps, found } = planRow(element.properties, out);
    const hasGroup = (from: number, to: number) => {
        for (let i = from; i < to; i++) {
            if (!found.has(i)) {
                return false;
            }
        }
        return true;
    };
    if (!hasGroup(0, 3)) {
        throw new Error('The PLY has no x/y/z vertex positions.');
    }

    const stream = source.read(header.headerBytes);
    const reader = new WindowReader(stream, BUFFER_BYTES);
    try {
        let written = 0;
        let nextKept = 0;
        for (let row = 0; row < element.count; row++) {
            const index = row === nextKept ? written : -1;
            if (!decodeRow(reader, steps, index)) {
                await reader.refill();
                if (!decodeRow(reader, steps, index)) {
                    throw new Error(reader.eof ?
                        'The PLY ends mid-vertex; the file looks truncated.' :
                        'A PLY vertex is larger than the read buffer.');
                }
            }
            if (index >= 0) {
                written++;
                nextKept += stride;
            }
        }

        // A partly-coloured cloud would read back with two channels of zeroes;
        // leave the columns out so promotePointCloud falls back to its grey.
        const columns = [new Column('x', out[0]), new Column('y', out[1]), new Column('z', out[2])];
        if (hasGroup(3, 6)) {
            columns.push(new Column('red', out[3]), new Column('green', out[4]), new Column('blue', out[5]));
        }
        return new DataTable(columns);
    } finally {
        stream.close();
    }
};

/**
 * The header of an open PLY when it is an OpenMVS dense cloud, null otherwise.
 * Takes the source rather than a filename so the caller can hand the same one to
 * whichever reader wins - opening a second one costs a Range probe and, when the
 * server or CORS hides Content-Range, a whole extra download.
 */
const probeDenseCloud = async (source: ReadSource): Promise<PlyHeader | null> => {
    const probe = source.read(0, Math.min(HEADER_PROBE_BYTES, source.size ?? HEADER_PROBE_BYTES));
    let head: Uint8Array;
    try {
        head = await probe.readAll();
    } finally {
        probe.close();
    }

    const header = parsePlyHeader(head);
    return header && isDenseCloud(header) ? header : null;
};

export {
    isDenseCloud,
    parsePlyHeader,
    probeDenseCloud,
    readVertexTable
};

export type { PlyHeader };
