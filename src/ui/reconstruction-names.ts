/**
 * The object's key in the store.
 */
const normalizeObjectName = (name: string, index: number): string => {
    const cleaned = String(name || `image-${index}.jpg`)
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .join('__')
    .replace(/[^\w.-]/g, '_');
    return cleaned || `image-${index}.jpg`;
};

/**
 * Identity of a picked folder, used to recognise a re-pick of a folder that already has an open session.
 */
const folderFingerprint = (files: { name: string; size: number }[]): string => {
    const parts = files.map(file => `${file.name}:${file.size}`).sort();
    return `${parts.length}:${parts.join('|')}`;
};

/**
 * A run's own path segment under datasets/{id}/artifacts/{pipeline}/.
 */
const newRunName = (preset: string): string => (
    `${preset}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
);

export { folderFingerprint, newRunName, normalizeObjectName };
