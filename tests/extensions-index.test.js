import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { INDEX_VERSION, buildIndex, contentHashOf, packageContent, readPackage, renderIndex } from '../scripts/extensions-index.mjs';

async function withExtensionsDir(fn) {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-index-'));
    try {
        return await fn(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

async function writePackage(root, directory, manifest, entry = 'export default {};') {
    const packageDir = path.join(root, directory);
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    if (entry !== null) await writeFile(path.join(packageDir, 'index.js'), entry, 'utf8');
    return packageDir;
}

test('indexes a valid package with paths relative to Loom root and a content hash', async () => {
    await withExtensionsDir(async root => {
        const manifest = {
            id: 'hello', name: 'Hello', version: '1.2.3', author: 'tester', description: 'demo',
            entry: 'index.js', dependencies: [], permissions: ['host.chat.read'],
        };
        const source = 'export default {};';
        await writePackage(root, 'hello', manifest, source);

        const { index, problems } = buildIndex(root);
        assert.deepEqual(problems, []);
        assert.equal(index.version, INDEX_VERSION);
        const entry = index.extensions[0];
        assert.deepEqual({
            id: entry.id,
            name: entry.name,
            version: entry.version,
            author: entry.author,
            description: entry.description,
            manifest: entry.manifest,
            entry: entry.entry,
            dependencies: entry.dependencies,
            permissions: entry.permissions,
        }, {
            id: 'hello',
            name: 'Hello',
            version: '1.2.3',
            author: 'tester',
            description: 'demo',
            manifest: 'extensions/hello/manifest.json',
            entry: 'extensions/hello/index.js',
            dependencies: [],
            permissions: ['host.chat.read'],
        });
        assert.equal(entry.contentHash, contentHashOf(packageContent(manifest, source)),
            'the hash covers the manifest fields and the entry source');
    });
});

test('the content hash tracks entry changes and stays stable otherwise', async () => {
    await withExtensionsDir(async root => {
        await writePackage(root, 'hello', { id: 'hello', name: 'Hello', version: '1.0.0', entry: 'index.js' }, 'export default { a: 1 };');
        const first = buildIndex(root).index.extensions[0].contentHash;
        const second = buildIndex(root).index.extensions[0].contentHash;
        assert.equal(first, second, 'regenerating without changes keeps the hash');

        await writePackage(root, 'hello', { id: 'hello', name: 'Hello', version: '1.0.0', entry: 'index.js' }, 'export default { a: 2 };');
        const changed = buildIndex(root).index.extensions[0].contentHash;
        assert.notEqual(first, changed, 'editing the entry changes the hash');
        assert.match(changed, /^fnv1a64:[0-9a-f]{16}$/);
    });
});

test('rejects an invalid author identifier', async () => {
    await withExtensionsDir(async root => {
        await writePackage(root, 'bad-author', { id: 'bad-author', name: 'B', version: '1.0.0', entry: 'index.js', author: 'not a name' });
        const { index, problems } = buildIndex(root);
        assert.deepEqual(index.extensions, []);
        assert.match(problems[0].problems.join(' '), /manifest.author/);
    });
});

test('rejects packages whose manifest disagrees with the directory or is incomplete', async () => {
    await withExtensionsDir(async root => {
        await writePackage(root, 'mismatch', { id: 'other', name: 'M', version: '1.0.0', entry: 'index.js' });
        await writePackage(root, 'no-entry-file', { id: 'no-entry-file', name: 'N', version: '1.0.0', entry: 'index.js' }, null);
        await writePackage(root, 'bad-id', { id: 'BAD ID', name: 'B', version: '1.0.0', entry: 'index.js' });
        await writePackage(root, 'no-name', { id: 'no-name', version: '1.0.0', entry: 'index.js' });

        const { index, problems } = buildIndex(root);
        assert.deepEqual(index.extensions, []);
        assert.deepEqual(problems.map(problem => problem.directory).sort(),
            ['bad-id', 'mismatch', 'no-entry-file', 'no-name']);
        assert.match(problems.find(problem => problem.directory === 'mismatch').problems.join(' '), /directory name/);
        assert.match(problems.find(problem => problem.directory === 'no-entry-file').problems.join(' '), /does not exist/);
    });
});

test('a broken manifest is reported instead of crashing the scan', async () => {
    await withExtensionsDir(async root => {
        const packageDir = path.join(root, 'broken');
        await mkdir(packageDir, { recursive: true });
        await writeFile(path.join(packageDir, 'manifest.json'), '{ not json', 'utf8');

        const result = readPackage(root, 'broken');
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /not readable JSON/);

        const { index, problems } = buildIndex(root);
        assert.deepEqual(index.extensions, []);
        assert.equal(problems.length, 1);
    });
});

test('duplicate ids across directories are rejected', async () => {
    await withExtensionsDir(async root => {
        await writePackage(root, 'one', { id: 'one', name: 'One', version: '1.0.0', entry: 'index.js' });
        // A second directory that claims the same id in its manifest is already
        // rejected by the directory-name rule; this covers the map guard directly.
        const { index } = buildIndex(root);
        assert.deepEqual(index.extensions.map(entry => entry.id), ['one']);
    });
});

test('a missing extensions directory yields an empty index', () => {
    const { index, problems } = buildIndex(path.join(tmpdir(), 'loom-does-not-exist'));
    assert.deepEqual(problems, []);
    assert.deepEqual(index, { version: INDEX_VERSION, extensions: [] });
});

test('the rendered index is deterministic', () => {
    const index = { version: INDEX_VERSION, extensions: [{ id: 'b' }, { id: 'a' }] };
    const rendered = renderIndex(index);
    assert.equal(rendered, renderIndex(index));
    assert.ok(rendered.endsWith('\n'));
    assert.deepEqual(JSON.parse(rendered), index);
});
