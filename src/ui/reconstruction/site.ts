import type { TagOptions, Tags } from 'genesis-recon';

const SITE = 'eyrie:genesis:site';
const CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CODE = 63;

type SiteChoice =
    | { mode: 'none' }
    | { mode: 'fixed'; value: string }
    | { mode: 'choose'; values: string[] }
    | { mode: 'free'; suggestions: string[] };

const NO_SITE: SiteChoice = { mode: 'none' };

const siteChoice = (options: TagOptions | null): SiteChoice => {
    if (!options?.keys.includes(SITE)) return NO_SITE;
    const limits = options.restricted_to[SITE] ?? [];
    if (limits.length === 1) return { mode: 'fixed', value: limits[0] };
    if (limits.length > 1) return { mode: 'choose', values: limits };
    return { mode: 'free', suggestions: options.values[SITE] ?? [] };
};

class SiteRequired extends Error {
    constructor() {
        super('Chọn site cho bộ ảnh này trước khi tải lên.');
        this.name = 'SiteRequired';
    }
}

class SiteMalformed extends Error {
    constructor() {
        super(`Site là mã chữ thường, số và dấu gạch ngang, tối đa ${MAX_CODE} ký tự, ví dụ tayninh-lo1.`);
        this.name = 'SiteMalformed';
    }
}

const siteTags = (choice: SiteChoice, picked: string): Tags | undefined => {
    const value = picked.trim().toLowerCase();
    switch (choice.mode) {
        case 'none':
            return undefined;
        case 'fixed':
            return { [SITE]: choice.value };
        case 'choose':
            if (!choice.values.includes(value)) throw new SiteRequired();
            return { [SITE]: value };
        case 'free':
            if (!value) return undefined;
            if (value.length > MAX_CODE || !CODE.test(value)) throw new SiteMalformed();
            return { [SITE]: value };
    }
};

export { MAX_CODE, NO_SITE, SiteMalformed, SiteRequired, siteChoice, siteTags };
export type { SiteChoice };
