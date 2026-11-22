import test from 'node:test';
import assert from 'node:assert/strict';

import {
    describeExternal,
    findExternal,
    forgetExternal,
    normalizeExternalManifest,
    rememberExternal,
    setExternalStatus,
} from './external.js';

const manifest = {
    id: 'third-party',
    name: 'Third Party',
    version: '1.2.0',
    author: 'someone',
    description: 'does things',
    permissions: ['host.chat.read', 'host.chat.read', 'host.worldinfo.write'],
};

test('normalises an external manifest and de-duplicates permissions', () => {
    assert.deepEqual(normalizeExternalManifest(manifest), {
        id: 'third-party',
        name: 'Third Party',
        version: '1.2.0',
        author: 'someone',
        description: 'does things',
        permissions: ['host.chat.read', 'host.worldinfo.write'],
    });
    assert.deepEqual(normalizeExternalManifest({ id: 'tiny' }), {
        id: 'tiny', name: 'tiny', version: '0.0.0', author: '', description: '', permissions: [],
    });
});

test('rejects manifests that cannot be identified or describe bad permissions', () => {
    for (const bad of [null, {}, { id: 'bad id' }, { id: 'ok', permissions: 'host.chat.read' }, { id: 'ok', permissions: ['bad perm'] }]) {
        assert.throws(() => normalizeExternalManifest(bad), Error, JSON.stringify(bad));
    }
});

test('a first request is pending and a repeat keeps the recorded decision', () => {
    const first = rememberExternal([], normalizeExternalManifest(manifest));
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'pending');

    const approved = setExternalStatus(first, 'third-party', 'approved');
    const again = rememberExternal(approved, normalizeExternalManifest({ ...manifest, name: 'Renamed', permissions: [] }));
    assert.equal(again[0].status, 'approved', 'a repeat request must not re-prompt');
    assert.equal(again[0].name, 'Renamed', 'descriptive fields still update');
    assert.deepEqual(again[0].permissions, [], 'the new permission list replaces the old one');

    const denied = setExternalStatus(approved, 'third-party', 'denied');
    const afterDenial = rememberExternal(denied, normalizeExternalManifest(manifest));
    assert.equal(afterDenial[0].status, 'denied', 'a denial survives a repeat request');
});

test('status changes are validated and records can be forgotten', () => {
    const list = rememberExternal([], normalizeExternalManifest(manifest));
    assert.throws(() => setExternalStatus(list, 'third-party', 'maybe'), /Unknown external status/);
    assert.equal(setExternalStatus(list, 'missing', 'approved')[0].status, 'pending', 'an unknown id changes nothing');

    assert.equal(findExternal(list, 'third-party')?.id, 'third-party');
    assert.equal(findExternal(list, 'nope'), null);
    assert.deepEqual(forgetExternal(list, 'third-party'), []);
    assert.deepEqual(forgetExternal(null, 'x'), []);
});

test('describes external records with the live registration state', () => {
    const list = setExternalStatus(rememberExternal([], normalizeExternalManifest(manifest)), 'third-party', 'approved');
    const rows = describeExternal(list, [{ id: 'third-party', state: 'active', error: null }]);
    assert.deepEqual(rows, [{
        id: 'third-party',
        name: 'Third Party',
        version: '1.2.0',
        author: 'someone',
        description: 'does things',
        permissions: ['host.chat.read', 'host.worldinfo.write'],
        status: 'approved',
        registered: true,
        error: '',
    }]);

    const notRunning = describeExternal(list, []);
    assert.equal(notRunning[0].registered, false, 'approved but not registered is reported honestly');

    const failed = describeExternal(list, [{ id: 'third-party', state: 'failed', error: { message: 'boom' } }]);
    assert.equal(failed[0].error, 'boom');
    assert.equal(failed[0].registered, false, 'a failed extension is not "registered"');
});
