import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UploadError } from 'genesis-recon';

import { classOf, describeFailure } from './failure.ts';

test('a classified SDK error keeps its class and maps to an action', () => {
    const throttled = new UploadError('store asked for less load', 429, 'peer-unavailable');
    assert.equal(classOf(throttled), 'peer-unavailable');
    assert.equal(describeFailure(throttled).action, 'retrying');

    const stopped = new UploadError('user pressed stop', undefined, 'cancelled');
    assert.equal(describeFailure(stopped).action, 'resume');

    const expired = new UploadError('session invalid', 401, 'unauthenticated');
    assert.equal(describeFailure(expired).action, 'sign-in');

    const over = new UploadError('over quota', 413, 'quota-exceeded');
    assert.equal(describeFailure(over).action, 'fail');
});

test('an unclassified error is reported as permanent with its message as detail', () => {
    const described = describeFailure(new Error('something odd'));
    assert.equal(described.failureClass, 'permanent');
    assert.equal(described.action, 'fail');
    assert.match(described.detail, /something odd/);
});

test('every class has copy', () => {
    const classes = [
        'network-interrupted', 'deadline-exceeded', 'credential-expired', 'peer-unavailable',
        'quota-exceeded', 'unauthenticated', 'cancelled', 'permanent'
    ];
    for (const failureClass of classes) {
        const described = describeFailure(new UploadError('x', undefined, failureClass as never));
        assert.ok(described.title.length > 0, `${failureClass} has no title`);
    }
});
