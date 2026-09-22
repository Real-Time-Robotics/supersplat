import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_SITE, SiteMalformed, SiteRequired, siteChoice, siteTags } from './site.ts';

const options = (restricted: string[] | undefined, inUse: string[] = []) => ({
    keys: ['eyrie:genesis:site'],
    values: { 'eyrie:genesis:site': restricted ?? inUse },
    restricted_to: restricted ? { 'eyrie:genesis:site': restricted } : {}
});

describe('site choice', () => {
    it('hides the field when the server names no site key or cannot be reached', () => {
        assert.deepEqual(siteChoice(null), NO_SITE);
        assert.deepEqual(siteChoice({ keys: [], values: {}, restricted_to: {} }), NO_SITE);
        assert.equal(siteTags(NO_SITE, 'tayninh'), undefined);
    });

    it('fixes the only site a restricted member holds', () => {
        const choice = siteChoice(options(['tayninh']));
        assert.deepEqual(choice, { mode: 'fixed', value: 'tayninh' });
        assert.deepEqual(siteTags(choice, ''), { 'eyrie:genesis:site': 'tayninh' });
    });

    it('makes a member with several sites pick one of theirs', () => {
        const choice = siteChoice(options(['binhduong', 'tayninh']));
        assert.deepEqual(choice, { mode: 'choose', values: ['binhduong', 'tayninh'] });
        assert.deepEqual(siteTags(choice, ' BinhDuong '), { 'eyrie:genesis:site': 'binhduong' });
        assert.throws(() => siteTags(choice, ''), SiteRequired);
        assert.throws(() => siteTags(choice, 'hanoi'), SiteRequired);
    });

    it('lets an unrestricted member leave it empty or type any site code', () => {
        const choice = siteChoice(options(undefined, ['tayninh']));
        assert.deepEqual(choice, { mode: 'free', suggestions: ['tayninh'] });
        assert.equal(siteTags(choice, '  '), undefined);
        assert.deepEqual(siteTags(choice, ' HaNoi-Lo2 '), { 'eyrie:genesis:site': 'hanoi-lo2' });
        for (const bad of ['Hà Nội', 'ha_noi', 'ha--noi', '-hanoi', 'x'.repeat(64)]) {
            assert.throws(() => siteTags(choice, bad), SiteMalformed, bad);
        }
    });
});
