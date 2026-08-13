/**
 * Turn an imported .svg into a live element. @rollup/plugin-image hands the import over
 * as a `data:image/svg+xml,<urlencoded>` string, so the markup has to be decoded before
 * it can be parsed.
 */
const createSvg = (svgString: string): HTMLElement => {
    const decoded = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decoded, 'image/svg+xml').documentElement;
};

export { createSvg };
