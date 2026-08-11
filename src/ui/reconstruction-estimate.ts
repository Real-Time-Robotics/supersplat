/** How many images are decoded to stand in for the whole folder. */
const SAMPLE_SIZE = 3;

type Measured = { width: number; height: number };

type Decode = (file: File) => Promise<Measured>;

const decodeInBrowser: Decode = async (file) => {
    const bitmap = await createImageBitmap(file);
    try {
        return { width: bitmap.width, height: bitmap.height };
    } finally {
        bitmap.close();
    }
};

/** `count` indices spread evenly across `length`, so a folder is not judged by its head. */
const spread = (length: number, count: number): number[] => {
    const taken = Math.min(length, count);
    if (taken <= 0) return [];
    if (taken === 1) return [0];
    const step = (length - 1) / (taken - 1);
    return Array.from({ length: taken }, (_, index) => Math.round(index * step));
};

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ?
        sorted[middle] :
        (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Pixels the folder is likely to bill for, extrapolated from a decoded sample.
 */
const estimateTotalPixels = async (files: File[], decode: Decode = decodeInBrowser,
    sample = SAMPLE_SIZE): Promise<number | null> => {
    const measured: number[] = [];
    for (const index of spread(files.length, sample)) {
        try {
            const { width, height } = await decode(files[index]);
            if (width > 0 && height > 0) measured.push(width * height);
        } catch {
            // Undecodable here says nothing about whether the pipeline can read it.
        }
    }
    if (measured.length === 0) return null;
    return Math.round(median(measured) * files.length);
};

/**
 * What to tell someone whose balance will not cover the folder they just picked, or null when it will.
 */
const shortfallNote = (required: number, balance: number, measured: boolean): string | null => {
    const missing = Math.ceil(required - balance);
    if (missing <= 0) return null;
    const basis = measured ? 'Ước tính' : 'Ước tính thô (không đọc được kích thước ảnh)';
    return `${basis}: cần khoảng ${required.toLocaleString()} credit, số dư ` +
        `${balance.toLocaleString()} — thiếu khoảng ${missing.toLocaleString()}. Vẫn tải ` +
        'lên được; giá chính thức chỉ chốt sau khi ảnh lên xong.';
};

export { estimateTotalPixels, shortfallNote };
export type { Decode, Measured };
