import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    describeInstalled,
    forgetInstalled,
    normalizeIndex,
    normalizeScriptRecords,
    normalizeUserSource,
    rememberInstalled,
    resolveEntryUrl,
    scriptIdFor,
    scriptSlug,
} from './installer.js';

const BASE = 'http://127.0.0.1:8100/scripts/extensions/third-party/Loom/';

test('resolves package URLs against Loom\'s own directory', () => {
    assert.equal(resolveEntryUrl('extensions/hello-loom/index.js', BASE),
        `${BASE}extensions/hello-loom/index.js`);
    assert.equal(resolveEntryUrl('https://cdn.example.com/ext.js', BASE), 'https://cdn.example.com/ext.js');
    assert.equal(resolveEntryUrl('', BASE), null);
    assert.equal(resolveEntryUrl(null, BASE), null);
});

test('normalises the bundled index and reports broken entries', () => {
    const { sources, problems } = normalizeIndex({
        version: 1,
        extensions: [
            { id: 'hello-loom', name: 'Hello Loom', version: '0.1.0', entry: 'extensions/hello-loom/index.js', manifest: 'extensions/hello-loom/manifest.json' },
            { id: 'BAD ID', entry: 'extensions/bad/index.js' },
            { id: 'no-entry' },
            null,
        ],
    }, BASE);

    assert.deepEqual(sources, [{
        id: 'hello-loom',
        name: 'Hello Loom',
        version: '0.1.0',
        description: '',
        manifest: `${BASE}extensions/hello-loom/manifest.json`,
        entry: `${BASE}extensions/hello-loom/index.js`,
        bundled: true,
    }]);
    assert.equal(problems.length, 3, 'invalid id, missing entry and non-object are all reported');
});

test('normalises a user-installed module URL', () => {
    const { source } = normalizeUserSource(null, 'extensions/hello-loom/index.js', BASE);
    assert.equal(source.entry, `${BASE}extensions/hello-loom/index.js`);
    assert.equal(source.bundled, false);
    assert.equal(source.id, null, 'the id comes from the module manifest');

    assert.deepEqual(normalizeUserSource(null, '', BASE), { error: '请输入可解析的模块地址' });
    assert.deepEqual(normalizeUserSource(null, '::not a url::', BASE), { error: '请输入可解析的模块地址' });
});

test('remembers an install without duplicating the same entry', () => {
    const source = { id: 'hello-loom', entry: `${BASE}extensions/hello-loom/index.js`, bundled: true };
    const first = rememberInstalled([], source);
    assert.deepEqual(first, [{ id: 'hello-loom', entry: source.entry, bundled: true }]);

    const renamed = { ...source, id: 'hello-loom-v2' };
    const second = rememberInstalled(first, renamed);
    assert.equal(second.length, 1, 'the same entry replaces the previous record');
    assert.equal(second[0].id, 'hello-loom-v2');

    assert.deepEqual(rememberInstalled(null, source), [{ id: 'hello-loom', entry: source.entry, bundled: true }]);
});

test('forgets an install by id or by entry URL', () => {
    const installed = [
        { id: 'a', entry: `${BASE}a/index.js` },
        { id: 'b', entry: `${BASE}b/index.js` },
    ];
    assert.deepEqual(forgetInstalled(installed, 'a').map(entry => entry.id), ['b']);
    assert.deepEqual(forgetInstalled(installed, `${BASE}b/index.js`).map(entry => entry.id), ['a']);
    assert.deepEqual(forgetInstalled(installed, 'missing'), installed, 'unknown targets change nothing');
});

test('normalises persisted scripts, defaulting old records to enabled', () => {
    const records = normalizeScriptRecords([
        { id: 'script-a', name: 'A', source: 'export default {};' },
        { id: 'script-b', name: 'B', source: 'export default {};', enabled: false },
        { id: 'broken', name: 'no source' },
        null,
        'nonsense',
    ]);
    assert.deepEqual(records.map(record => [record.id, record.enabled]), [
        ['script-a', true],
        ['script-b', false],
    ]);
    assert.deepEqual(normalizeScriptRecords(null), []);
});

test('generates stable script ids with a collision suffix', () => {
    assert.equal(scriptSlug('My Script!'), 'my-script');
    assert.equal(scriptSlug('   '), 'script', 'an empty name still yields a usable id');
    assert.equal(scriptIdFor('My Script', []), 'script-my-script');
    assert.equal(scriptIdFor('My Script', ['script-my-script']), 'script-my-script-2');
    assert.equal(scriptIdFor('My Script', ['script-my-script', 'script-my-script-2']), 'script-my-script-3');
    assert.ok(scriptIdFor('a'.repeat(80), []).length <= 48, 'the generated id stays within Core limits');
});

test('installed entries without metadata still describe cleanly', () => {
    const rows = describeInstalled([{ id: 'x', entry: 'https://example.com/x.js' }], []);
    assert.deepEqual(rows[0].permissions, []);
    assert.deepEqual(rows[0].dependencies, []);
    assert.equal(rows[0].version, '');
});

test('describes installed entries with runtime state, including failures', () => {
    const installed = [
        {
            id: 'hello-loom',
            entry: `${BASE}extensions/hello-loom/index.js`,
            bundled: true,
            version: '0.1.0',
            permissions: ['host.chat.read'],
            dependencies: ['loom-host'],
        },
        { id: 'gone', entry: 'https://example.com/gone.js', bundled: false },
    ];
    const states = [
        { id: 'hello-loom', name: 'Hello Loom', state: 'active', error: null },
        { id: 'gone', name: 'Gone', state: 'failed', error: { code: 'IMPORT_FAILED', message: 'boom' } },
    ];

    assert.deepEqual(describeInstalled(installed, states), [
        {
            id: 'hello-loom', entry: `${BASE}extensions/hello-loom/index.js`, bundled: true,
            state: 'active', name: 'Hello Loom', version: '0.1.0',
            permissions: ['host.chat.read'], dependencies: ['loom-host'], error: '',
        },
        {
            id: 'gone', entry: 'https://example.com/gone.js', bundled: false,
            state: 'failed', name: 'Gone', version: '', permissions: [], dependencies: [], error: 'boom',
        },
    ]);
    assert.equal(describeInstalled(installed, []).find(entry => entry.id === 'gone').state, 'missing',
        'a recorded id with no runtime state is reported rather than hidden');
});
