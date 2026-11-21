import test from 'node:test';
import assert from 'node:assert/strict';
import { afterEach, beforeEach } from 'node:test';
import {
    deleteState,
    emit,
    executeCapability,
    getState,
    grantPermission,
    listCapabilities,
    listExtensions,
    registerExtension as registerCoreExtension,
    revokePermission,
    setState,
    subscribe,
    unregisterExtension,
} from '../Loom%20Core/index.js';
import './index.js';

const EXTENSION_ID = 'loom-host';
const observerId = 'host-observer';
const consumerId = 'settings-consumer';

let reimportCount = 0;

/**
 * The host adapter installs itself on import and the bridge test unregisters it
 * to prove cleanup. Re-importing with a cache-busting query re-runs the
 * idempotent `install()`, so test order cannot leave later tests without a host.
 */
async function ensureHostRegistered() {
    if (listExtensions().some(extension => extension.id === EXTENSION_ID)) return;
    reimportCount += 1;
    await import(`./index.js?reinstall=${reimportCount}`);
    assert.ok(
        listExtensions().some(extension => extension.id === EXTENSION_ID),
        'the host adapter must be registered for the test to be meaningful',
    );
}

beforeEach(async () => {
    await ensureHostRegistered();
});

afterEach(() => {
    // Unregister before removing the host stub: unregistering flushes the
    // permission snapshot through the store and would warn if ST vanished first.
    unregisterExtension(observerId);
    unregisterExtension(consumerId);
    delete globalThis.SillyTavern;
});

function stubHost(context) {
    globalThis.SillyTavern = { getContext: () => context };
}

/**
 * Stub a host with caller-scoped extension settings and a save counter.
 * Returns the settings object so tests can assert what was written.
 */
function stubSettingsHost(initial = {}) {
    const extensionSettings = structuredClone(initial);
    let saves = 0;
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced: () => { saves += 1; },
        }),
    };
    return { extensionSettings, saves: () => saves };
}

function registerConsumer() {
    registerExtensionForTest();
    return consumerId;
}

function registerExtensionForTest() {
    if (!listExtensions().some(extension => extension.id === consumerId)) {
        globalThis.Loom.registerExtension({ id: consumerId, name: 'Settings Consumer' });
    }
}

function createEventSource() {
    const listeners = new Map();
    return {
        on(event, handler) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(handler);
        },
        removeListener(event, handler) {
            listeners.get(event)?.delete(handler);
        },
        listenerCount() {
            let total = 0;
            for (const set of listeners.values()) total += set.size;
            return total;
        },
        fire(event) {
            for (const handler of [...(listeners.get(event) ?? [])]) handler();
        },
    };
}

test('registers the host adapter and its capabilities', () => {
    assert.ok(listExtensions().some(extension => extension.id === EXTENSION_ID));
    assert.deepEqual(
        listCapabilities(EXTENSION_ID).map(capability => capability.id).sort(),
        [
            'characters.get',
            'characters.list',
            'characters.update',
            'chat.append',
            'chat.delete',
            'chat.edit',
            'chat.messages',
            'context.snapshot',
            'settings.get',
            'settings.keys',
            'settings.remove',
            'settings.set',
            'viewport.get',
            'worlds.create',
            'worlds.entries',
            'worlds.entry.create',
            'worlds.entry.remove',
            'worlds.entry.update',
            'worlds.export',
            'worlds.import',
            'worlds.list',
            'worlds.remove',
            'worlds.rename',
        ],
    );
    const snapshot = listCapabilities(EXTENSION_ID).find(capability => capability.id === 'context.snapshot');
    assert.deepEqual(snapshot.input, { type: 'null' });
    assert.ok(snapshot.output.required.includes('characterName'));
    assert.deepEqual(snapshot.permissions, [], 'read capabilities must not require a grant');
});

test('declares the write permission only on the mutating settings capabilities', () => {
    const declared = Object.fromEntries(
        listCapabilities(EXTENSION_ID).map(capability => [capability.id, capability.permissions]),
    );
    assert.deepEqual(declared['settings.get'], []);
    assert.deepEqual(declared['settings.keys'], []);
    assert.deepEqual(declared['settings.set'], ['host.settings.write']);
    assert.deepEqual(declared['settings.remove'], ['host.settings.write']);
    // Chat content is private; library assets stay ungated.
    assert.deepEqual(declared['chat.messages'], ['host.chat.read']);
    assert.deepEqual(declared['chat.append'], ['host.chat.write']);
    assert.deepEqual(declared['worlds.entries'], []);
    assert.deepEqual(declared['worlds.entry.update'], ['host.worldinfo.write']);
    assert.deepEqual(declared['worlds.entry.create'], ['host.worldinfo.write']);
    assert.deepEqual(declared['worlds.entry.remove'], ['host.worldinfo.write']);
    assert.deepEqual(declared['worlds.create'], ['host.worldinfo.manage']);
    assert.deepEqual(declared['worlds.remove'], ['host.worldinfo.manage']);
    assert.deepEqual(declared['worlds.import'], ['host.worldinfo.manage']);
    assert.deepEqual(declared['worlds.rename'], ['host.worldinfo.manage']);
    assert.deepEqual(declared['characters.update'], ['host.characters.write']);
    assert.deepEqual(declared['characters.get'], [], 'reading a card stays ungated');
    assert.deepEqual(declared['worlds.export'], [], 'export is a read');
    assert.deepEqual(declared['characters.get'], []);
});

test('reports a structured failure when the host context is unavailable', async () => {
    delete globalThis.SillyTavern;
    const result = await executeCapability(EXTENSION_ID, 'context.snapshot', null);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'EXECUTION_FAILED');
    assert.match(result.error.message, /host context is unavailable/i);
});

function stubWorldBookHost(options = {}) {
    const names = [...(options.names ?? ['Lore'])];
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (path, init) => {
        requests.push({ path, body: JSON.parse(init.body) });
        if (options.failPath === path) return { ok: false, status: 500 };
        const body = JSON.parse(init.body);
        if (path === '/api/worldinfo/edit') {
            if (!names.includes(body.name)) names.push(body.name);
            return { ok: true, status: 200 };
        }
        if (path === '/api/worldinfo/delete') {
            const index = names.indexOf(body.name);
            if (index >= 0) names.splice(index, 1);
            return { ok: true, status: 200 };
        }
        return { ok: false, status: 404 };
    };
    stubHost({
        chat: [],
        getWorldInfoNames: () => [...names],
        loadWorldInfo: async () => ({ entries: {} }),
        updateWorldInfoList: async () => {},
        getRequestHeaders: () => ({ 'X-Test': '1' }),
    });
    return {
        names,
        requests,
        restore: () => { globalThis.fetch = originalFetch; },
    };
}

test('creates a world book through the host endpoint', async () => {
    const host = stubWorldBookHost();
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const result = await executeCapability(EXTENSION_ID, 'worlds.create', { name: 'Scratch' }, { caller: consumerId });
        assert.deepEqual(result, { success: true, data: { name: 'Scratch', created: true } });
        assert.deepEqual(host.requests, [{
            path: '/api/worldinfo/edit',
            body: { name: 'Scratch', data: { entries: {} } },
        }]);
        assert.deepEqual(host.names, ['Lore', 'Scratch']);
    } finally {
        host.restore();
    }
});

test('worlds.create refuses an existing book and needs its own permission', async () => {
    const host = stubWorldBookHost();
    registerConsumer();
    try {
        const denied = await executeCapability(EXTENSION_ID, 'worlds.create', { name: 'Scratch' }, { caller: consumerId });
        assert.equal(denied.error.code, 'PERMISSION_DENIED');
        assert.deepEqual(denied.error.details.missing, ['host.worldinfo.manage']);
        assert.deepEqual(host.requests, [], 'a denied call makes no request');

        grantPermission(consumerId, 'host.worldinfo.write');
        const entryOnly = await executeCapability(EXTENSION_ID, 'worlds.create', { name: 'Scratch' }, { caller: consumerId });
        assert.equal(entryOnly.error.code, 'PERMISSION_DENIED', 'entry-write permission is not enough to create a book');

        grantPermission(consumerId, 'host.worldinfo.manage');
        const exists = await executeCapability(EXTENSION_ID, 'worlds.create', { name: 'Lore' }, { caller: consumerId });
        assert.equal(exists.error.code, 'WORLD_EXISTS');
        assert.deepEqual(host.requests, []);
    } finally {
        host.restore();
    }
});

test('removes a world book only when the name is echoed back', async () => {
    const host = stubWorldBookHost({ names: ['Lore', 'Scratch'] });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const mismatch = await executeCapability(EXTENSION_ID, 'worlds.remove',
            { name: 'Scratch', confirm: 'Other' }, { caller: consumerId });
        assert.equal(mismatch.error.code, 'CONFIRMATION_REQUIRED');
        assert.deepEqual(host.requests, [], 'a wrong confirmation must not reach the host');

        const removed = await executeCapability(EXTENSION_ID, 'worlds.remove',
            { name: 'Scratch', confirm: 'Scratch' }, { caller: consumerId });
        assert.deepEqual(removed, { success: true, data: { name: 'Scratch', removed: true } });
        assert.deepEqual(host.requests, [{ path: '/api/worldinfo/delete', body: { name: 'Scratch' } }]);
        assert.deepEqual(host.names, ['Lore']);
    } finally {
        host.restore();
    }
});

test('worlds.remove reports missing books and host rejections', async () => {
    const host = stubWorldBookHost({ names: ['Lore'], failPath: '/api/worldinfo/delete' });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const missing = await executeCapability(EXTENSION_ID, 'worlds.remove',
            { name: 'Nope', confirm: 'Nope' }, { caller: consumerId });
        assert.equal(missing.error.code, 'WORLD_NOT_FOUND');

        const failed = await executeCapability(EXTENSION_ID, 'worlds.remove',
            { name: 'Lore', confirm: 'Lore' }, { caller: consumerId });
        assert.equal(failed.error.code, 'HOST_UNSUPPORTED');
        assert.deepEqual(host.names, ['Lore'], 'a failed deletion leaves the book listed');
    } finally {
        host.restore();
    }
});

test('world-book management reports a missing loader or fetch', async () => {
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');

    stubHost({ chat: [], getWorldInfoNames: () => [] });
    const noLoader = await executeCapability(EXTENSION_ID, 'worlds.create', { name: 'X' }, { caller: consumerId });
    assert.equal(noLoader.error.code, 'HOST_UNSUPPORTED');

    const originalFetch = globalThis.fetch;
    try {
        // No fetch at all: the adapter must refuse instead of throwing.
        delete globalThis.fetch;
        stubHost({ chat: [], getWorldInfoNames: () => [], loadWorldInfo: async () => ({ entries: {} }) });
        const noFetch = await executeCapability(EXTENSION_ID, 'worlds.create', { name: 'X' }, { caller: consumerId });
        assert.equal(noFetch.error.code, 'HOST_UNSUPPORTED');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('exports a world book as detached data', async () => {
    const book = {
        entries: {
            0: { uid: 0, key: ['a'], content: 'alpha', displayIndex: 3, automationId: 'custom' },
            1: { uid: 1, key: ['b'], content: 'beta' },
        },
        originalData: { keep: true },
    };
    stubHost({ chat: [], getWorldInfoNames: () => ['Lore'], loadWorldInfo: async () => book });

    const result = await executeCapability(EXTENSION_ID, 'worlds.export', { name: 'Lore' });
    assert.equal(result.success, true);
    assert.equal(result.data.entries, 2);
    assert.deepEqual(result.data.data, book, 'every host field is preserved, not just the mapped ones');
    assert.deepEqual(Object.keys(result.data.data.entries).sort(), ['0', '1']);

    // The output must be a copy: mutating it cannot reach the host cache.
    result.data.data.entries[0].content = 'mutated';
    assert.equal(book.entries[0].content, 'alpha');
});

test('worlds.export reports missing books and unsupported hosts', async () => {
    stubHost({ chat: [], getWorldInfoNames: () => ['Other'], loadWorldInfo: async () => ({ entries: {} }) });
    const missing = await executeCapability(EXTENSION_ID, 'worlds.export', { name: 'Lore' });
    assert.equal(missing.error.code, 'WORLD_NOT_FOUND');

    stubHost({ chat: [], getWorldInfoNames: () => ['Lore'] });
    const unsupported = await executeCapability(EXTENSION_ID, 'worlds.export', { name: 'Lore' });
    assert.equal(unsupported.error.code, 'HOST_UNSUPPORTED');
});

test('imports exported data into a new world book', async () => {
    const host = stubWorldBookHost({ names: ['Lore'] });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const data = { entries: { 0: { uid: 0, key: ['a'], content: 'alpha' } }, extraField: 1 };
        const result = await executeCapability(EXTENSION_ID, 'worlds.import',
            { name: 'Copy', data }, { caller: consumerId });

        assert.deepEqual(result, { success: true, data: { name: 'Copy', entries: 1, created: true } });
        assert.deepEqual(host.requests, [{ path: '/api/worldinfo/edit', body: { name: 'Copy', data } }],
            'the payload is forwarded faithfully');
        assert.deepEqual(host.names, ['Lore', 'Copy']);
    } finally {
        host.restore();
    }
});

test('worlds.import refuses to overwrite and needs the manage permission', async () => {
    const host = stubWorldBookHost({ names: ['Lore'] });
    registerConsumer();
    try {
        const denied = await executeCapability(EXTENSION_ID, 'worlds.import',
            { name: 'Copy', data: { entries: {} } }, { caller: consumerId });
        assert.equal(denied.error.code, 'PERMISSION_DENIED');
        assert.deepEqual(host.requests, []);

        grantPermission(consumerId, 'host.worldinfo.write');
        const entryOnly = await executeCapability(EXTENSION_ID, 'worlds.import',
            { name: 'Copy', data: { entries: {} } }, { caller: consumerId });
        assert.equal(entryOnly.error.code, 'PERMISSION_DENIED', 'entry writes do not imply imports');

        grantPermission(consumerId, 'host.worldinfo.manage');
        const exists = await executeCapability(EXTENSION_ID, 'worlds.import',
            { name: 'Lore', data: { entries: {} } }, { caller: consumerId });
        assert.equal(exists.error.code, 'WORLD_EXISTS');
        assert.deepEqual(host.requests, [], 'nothing is written when the name is taken');
    } finally {
        host.restore();
    }
});

test('worlds.import validates the payload before writing', async () => {
    const host = stubWorldBookHost();
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const cases = [
            [{ entries: [] }, /"entries" object/],
            [{}, /"entries" object/],
            [{ entries: { 0: null } }, /must be an object/],
            // JSON.parse creates an own "__proto__" key; an object literal would set
            // the prototype instead, which is why the hostile shape is built this way.
            [JSON.parse('{"entries":{"__proto__":{"content":"x"}}}'), /reserved/],
        ];
        for (const [data, pattern] of cases) {
            const result = await executeCapability(EXTENSION_ID, 'worlds.import', { name: 'Bad', data }, { caller: consumerId });
            assert.equal(result.success, false);
            assert.equal(result.error.code, 'INVALID_INPUT');
            assert.match(result.error.message, pattern);
        }

        const tooMany = { entries: {} };
        for (let index = 0; index < 5001; index += 1) tooMany.entries[index] = { content: 'x' };
        const oversized = await executeCapability(EXTENSION_ID, 'worlds.import', { name: 'Bad', data: tooMany }, { caller: consumerId });
        assert.equal(oversized.error.code, 'INVALID_INPUT');
        assert.match(oversized.error.message, /exceeds 5000 entries/);

        assert.deepEqual(host.requests, [], 'a rejected payload never reaches the host');
    } finally {
        host.restore();
    }
});

test('imports empty data and reports a host that does not register the book', async () => {
    const host = stubWorldBookHost();
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    const originalFetch = globalThis.fetch;
    try {
        const empty = await executeCapability(EXTENSION_ID, 'worlds.import',
            { name: 'Empty', data: { entries: {} } }, { caller: consumerId });
        assert.deepEqual(empty, { success: true, data: { name: 'Empty', entries: 0, created: true } });

        host.restore();
        // The host accepts the request but never lists the book: that is a failure.
        globalThis.fetch = async () => ({ ok: true, status: 200 });
        stubHost({ chat: [], loadWorldInfo: async () => ({ entries: {} }), getWorldInfoNames: () => [], updateWorldInfoList: async () => {} });
        const ghost = await executeCapability(EXTENSION_ID, 'worlds.import',
            { name: 'Ghost', data: { entries: {} } }, { caller: consumerId });
        assert.equal(ghost.error.code, 'WORLD_CREATE_FAILED');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function stubRenameHost(options = {}) {
    const names = [...(options.names ?? ['Old'])];
    const requests = [];
    const chatMetadata = { ...(options.chatMetadata ?? {}) };
    const powerUserSettings = { ...(options.powerUserSettings ?? {}) };
    let metadataSaves = 0;
    let settingsSaves = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (path, init) => {
        const body = JSON.parse(init.body);
        requests.push({ path, body });
        if (path === '/api/worldinfo/edit') {
            if (!names.includes(body.name)) names.push(body.name);
            return { ok: true, status: 200 };
        }
        if (path === '/api/worldinfo/delete') {
            const index = names.indexOf(body.name);
            if (index >= 0) names.splice(index, 1);
            return { ok: true, status: 200 };
        }
        return { ok: false, status: 404 };
    };
    stubHost({
        chat: [],
        characters: options.characters ?? [],
        chatMetadata,
        powerUserSettings,
        loadWorldInfo: async () => ({ entries: { 0: { uid: 0, content: 'kept' } } }),
        getWorldInfoNames: () => [...names],
        updateWorldInfoList: async () => {},
        getRequestHeaders: () => ({}),
        saveMetadataDebounced: () => { metadataSaves += 1; },
        saveSettingsDebounced: () => { settingsSaves += 1; },
    });
    return {
        names,
        requests,
        chatMetadata,
        powerUserSettings,
        metadataSaves: () => metadataSaves,
        settingsSaves: () => settingsSaves,
        restore: () => { globalThis.fetch = originalFetch; },
    };
}

test('renames a world book and migrates the chat and persona bindings', async () => {
    const host = stubRenameHost({ chatMetadata: { world_info: 'Old' }, powerUserSettings: { persona_description_lorebook: 'Old' } });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const result = await executeCapability(EXTENSION_ID, 'worlds.rename',
            { name: 'Old', to: 'New', confirm: 'Old' }, { caller: consumerId });

        assert.deepEqual(result, { success: true, data: { from: 'Old', to: 'New', migrated: ['chat', 'persona'] } });
        assert.deepEqual(host.names, ['New']);
        assert.equal(host.chatMetadata.world_info, 'New');
        assert.equal(host.powerUserSettings.persona_description_lorebook, 'New');
        assert.equal(host.metadataSaves(), 1, 'the chat binding is persisted');
        assert.equal(host.settingsSaves(), 1, 'the persona binding is persisted');

        // Copy first, then delete: the old book is only removed after the new one exists.
        assert.deepEqual(host.requests.map(request => request.path), ['/api/worldinfo/edit', '/api/worldinfo/delete']);
        assert.equal(host.requests[0].body.name, 'New');
        assert.equal(host.requests[1].body.name, 'Old');
    } finally {
        host.restore();
    }
});

test('worlds.rename refuses to break a character card binding', async () => {
    const host = stubRenameHost({
        characters: [
            { name: 'Alice', data: { extensions: { world: 'Old' } } },
            { name: 'Bob' },
        ],
    });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const result = await executeCapability(EXTENSION_ID, 'worlds.rename',
            { name: 'Old', to: 'New', confirm: 'Old' }, { caller: consumerId });
        assert.equal(result.error.code, 'WORLD_IN_USE');
        assert.deepEqual(result.error.details.characters, ['Alice']);
        assert.deepEqual(host.requests, [], 'nothing is written when a link cannot be migrated');
        assert.deepEqual(host.names, ['Old']);
    } finally {
        host.restore();
    }
});

test('worlds.rename refuses a globally activated book before writing', async () => {
    const host = stubRenameHost();
    const originalDocument = globalThis.document;
    globalThis.document = {
        querySelector: selector => (selector === '#world_info'
            ? { options: [{ selected: true, value: 'Old' }, { selected: false, value: 'New' }] }
            : null),
    };
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const result = await executeCapability(EXTENSION_ID, 'worlds.rename',
            { name: 'Old', to: 'New', confirm: 'Old' }, { caller: consumerId });
        assert.equal(result.error.code, 'WORLD_IN_USE');
        assert.equal(result.error.details.selection, true);
        assert.deepEqual(host.requests, [], 'the host dropdown is never mutated by the adapter');
        assert.deepEqual(host.names, ['Old']);
    } finally {
        globalThis.document = originalDocument;
        host.restore();
    }
});

test('worlds.rename validates names and confirmation before writing', async () => {
    const host = stubRenameHost({ names: ['Old', 'Taken'] });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.manage');
    try {
        const cases = [
            [{ name: 'Old', to: 'New', confirm: 'Other' }, 'CONFIRMATION_REQUIRED'],
            [{ name: 'Old', to: 'OLD', confirm: 'Old' }, 'INVALID_INPUT'],
            [{ name: 'Missing', to: 'New', confirm: 'Missing' }, 'WORLD_NOT_FOUND'],
            [{ name: 'Old', to: 'Taken', confirm: 'Old' }, 'WORLD_EXISTS'],
        ];
        for (const [input, code] of cases) {
            const result = await executeCapability(EXTENSION_ID, 'worlds.rename', input, { caller: consumerId });
            assert.equal(result.error.code, code, JSON.stringify(input));
        }
        assert.deepEqual(host.requests, []);
        assert.deepEqual(host.names.sort(), ['Old', 'Taken']);
    } finally {
        host.restore();
    }
});

test('worlds.rename needs the manage permission', async () => {
    const host = stubRenameHost();
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');
    try {
        const denied = await executeCapability(EXTENSION_ID, 'worlds.rename',
            { name: 'Old', to: 'New', confirm: 'Old' }, { caller: consumerId });
        assert.equal(denied.error.code, 'PERMISSION_DENIED');
        assert.deepEqual(host.requests, []);
    } finally {
        host.restore();
    }
});

test('whole-book writes prefer the host writer so its cache stays correct', async () => {
    const writes = [];
    const names = ['Lore'];
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => { fetches += 1; return { ok: true, status: 200 }; };
    try {
        stubHost({
            chat: [],
            getWorldInfoNames: () => [...names],
            loadWorldInfo: async () => ({ entries: {} }),
            saveWorldInfo: async (name, data, immediately) => {
                writes.push({ name, data, immediately });
                if (!names.includes(name)) names.push(name);
            },
            updateWorldInfoList: async () => {},
            getRequestHeaders: () => ({}),
        });
        registerConsumer();
        grantPermission(consumerId, 'host.worldinfo.manage');

        const created = await executeCapability(EXTENSION_ID, 'worlds.create', { name: 'Scratch' }, { caller: consumerId });
        assert.equal(created.success, true);
        assert.deepEqual(writes[0], { name: 'Scratch', data: { entries: {} }, immediately: true },
            'saveWorldInfo is used so the host cache is updated, not only the file');
        assert.equal(fetches, 0, 'no raw endpoint call when the host writer exists');

        const imported = await executeCapability(EXTENSION_ID, 'worlds.import',
            { name: 'Imported', data: { entries: { 0: { content: 'x' } } } }, { caller: consumerId });
        assert.equal(imported.success, true);
        assert.equal(writes[1].name, 'Imported');
        assert.equal(writes[1].immediately, true);
        assert.equal(fetches, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function stubCharacterHost(options = {}) {
    const requests = [];
    const refreshed = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (path, init) => {
        requests.push({ path, body: JSON.parse(init.body) });
        if (options.fail) return { ok: false, status: 400 };
        return { ok: true, status: 200 };
    };
    stubHost({
        chat: [],
        characters: options.characters ?? [{ name: 'Alice', avatar: 'alice.png' }],
        getRequestHeaders: () => ({ 'X-Test': '1' }),
        getOneCharacter: async avatar => { refreshed.push(avatar); },
    });
    return { requests, refreshed, restore: () => { globalThis.fetch = originalFetch; } };
}

test('updates character card fields through merge-attributes', async () => {
    const host = stubCharacterHost();
    registerConsumer();
    grantPermission(consumerId, 'host.characters.write');
    try {
        const result = await executeCapability(EXTENSION_ID, 'characters.update', {
            name: 'Alice',
            patch: { description: 'new desc', firstMessage: 'hi', tags: ['a', 'b'] },
        }, { caller: consumerId });

        assert.deepEqual(result, {
            success: true,
            data: { avatar: 'alice.png', name: 'Alice', updated: ['description', 'firstMessage', 'tags'], refreshed: true },
        });
        assert.deepEqual(host.requests, [{
            path: '/api/characters/merge-attributes',
            body: { avatar: 'alice.png', data: { description: 'new desc', first_mes: 'hi', tags: ['a', 'b'] } },
        }], 'caller-facing names map onto the host card keys');
        assert.deepEqual(host.refreshed, ['alice.png'], 'the host memory copy is refreshed after the write');
    } finally {
        host.restore();
    }
});

test('characters.update is gated and cannot be confused with reading', async () => {
    const host = stubCharacterHost();
    registerConsumer();
    try {
        const denied = await executeCapability(EXTENSION_ID, 'characters.update',
            { name: 'Alice', patch: { description: 'x' } }, { caller: consumerId });
        assert.equal(denied.error.code, 'PERMISSION_DENIED');
        assert.deepEqual(denied.error.details.missing, ['host.characters.write']);
        assert.deepEqual(host.requests, []);
    } finally {
        host.restore();
    }
});

test('characters.update rejects unknown or empty patches before writing', async () => {
    const host = stubCharacterHost();
    registerConsumer();
    grantPermission(consumerId, 'host.characters.write');
    try {
        const empty = await executeCapability(EXTENSION_ID, 'characters.update',
            { name: 'Alice', patch: {} }, { caller: consumerId });
        assert.equal(empty.error.code, 'INVALID_INPUT');

        // Structural fields are not offered: they would rewrite the card image or
        // embedded world book.
        for (const field of ['avatar', 'name', 'extensions', 'character_book', 'data']) {
            const result = await executeCapability(EXTENSION_ID, 'characters.update',
                { name: 'Alice', patch: { [field]: 'x' } }, { caller: consumerId });
            assert.equal(result.error.code, 'INVALID_INPUT', `${field} must not be patchable`);
        }
        assert.deepEqual(host.requests, []);
    } finally {
        host.restore();
    }
});

test('characters.update reports a missing character and a rejected write', async () => {
    const host = stubCharacterHost({ fail: true });
    registerConsumer();
    grantPermission(consumerId, 'host.characters.write');
    try {
        const missing = await executeCapability(EXTENSION_ID, 'characters.update',
            { name: 'Nobody', patch: { description: 'x' } }, { caller: consumerId });
        assert.equal(missing.error.code, 'CHARACTER_NOT_FOUND');

        const rejected = await executeCapability(EXTENSION_ID, 'characters.update',
            { name: 'Alice', patch: { description: 'x' } }, { caller: consumerId });
        assert.equal(rejected.error.code, 'CHARACTER_WRITE_FAILED');
        assert.deepEqual(rejected.error.details, { avatar: 'alice.png' });
        assert.deepEqual(host.refreshed, [], 'nothing is refreshed when the host refused the write');
    } finally {
        host.restore();
    }
});

test('characters.update reports a stale memory copy when refresh fails', async () => {
    const host = stubCharacterHost();
    globalThis.SillyTavern.getContext = () => ({
        chat: [],
        characters: [{ name: 'Alice', avatar: 'alice.png' }],
        getRequestHeaders: () => ({}),
        getOneCharacter: async () => { throw new Error('refresh failed'); },
    });
    registerConsumer();
    grantPermission(consumerId, 'host.characters.write');
    try {
        const result = await executeCapability(EXTENSION_ID, 'characters.update',
            { name: 'Alice', patch: { description: 'x' } }, { caller: consumerId });
        assert.equal(result.success, true, 'the file was written even if the memory refresh failed');
        assert.equal(result.data.refreshed, false, 'the caller is told the in-memory copy is stale');
        assert.equal(host.requests.length, 1);
    } finally {
        host.restore();
    }
});

test('reads a snapshot from a stubbed SillyTavern context', async () => {
    stubHost({
        chatId: 'ignored-when-function-exists',
        getCurrentChatId: () => 'chat-1',
        name2: 'Alice',
        chat: [{}, {}],
        characters: [{ name: 'Alice', avatar: 'alice.png' }],
        getWorldInfoNames: () => ['World A', 'World B'],
    });

    assert.deepEqual(await executeCapability(EXTENSION_ID, 'context.snapshot', null), {
        success: true,
        data: {
            chatId: 'chat-1',
            hasChat: true,
            characterName: 'Alice',
            messageCount: 2,
            characterCount: 1,
            worldCount: 2,
        },
    });
});

test('falls back to the context chat id and tolerates missing optional readers', async () => {
    stubHost({ chatId: 'fallback-chat', chat: [] });
    const result = await executeCapability(EXTENSION_ID, 'context.snapshot', null);
    assert.equal(result.success, true);
    assert.equal(result.data.chatId, 'fallback-chat');
    assert.equal(result.data.hasChat, true);
    assert.equal(result.data.messageCount, 0);
    assert.equal(result.data.worldCount, 0);
    assert.equal(result.data.characterCount, 0);
});

test('lists characters and worlds through the adapter capabilities', async () => {
    stubHost({
        characters: [{ name: 'Alice', avatar: 'alice.png' }, { name: 'Bob' }, {}],
        getWorldInfoNames: () => ['Lore'],
    });

    assert.deepEqual(await executeCapability(EXTENSION_ID, 'characters.list', null), {
        success: true,
        data: [
            { name: 'Alice', avatar: 'alice.png' },
            { name: 'Bob', avatar: '' },
            { name: '', avatar: '' },
        ],
    });
    assert.deepEqual(await executeCapability(EXTENSION_ID, 'worlds.list', null), {
        success: true,
        data: ['Lore'],
    });
});

function withViewport(viewport, run) {
    const saved = {
        innerWidth: globalThis.innerWidth,
        innerHeight: globalThis.innerHeight,
        devicePixelRatio: globalThis.devicePixelRatio,
        matchMedia: globalThis.matchMedia,
    };
    globalThis.innerWidth = viewport.innerWidth;
    globalThis.innerHeight = viewport.innerHeight;
    globalThis.devicePixelRatio = viewport.devicePixelRatio;
    if (viewport.matchMedia === undefined) {
        globalThis.matchMedia = null;
    } else {
        globalThis.matchMedia = () => ({ matches: viewport.matchMedia });
    }
    return Promise.resolve(run()).finally(() => {
        globalThis.innerWidth = saved.innerWidth;
        globalThis.innerHeight = saved.innerHeight;
        globalThis.devicePixelRatio = saved.devicePixelRatio;
        globalThis.matchMedia = saved.matchMedia;
    });
}

test('reads viewport dimensions and mobile detection', async () => {
    stubHost({ chat: [] });

    const desktop = await withViewport({ innerWidth: 1365, innerHeight: 844, devicePixelRatio: 2, matchMedia: false }, async () => {
        const result = await executeCapability(EXTENSION_ID, 'viewport.get', null);
        assert.equal(result.success, true);
        assert.deepEqual(result.data, { width: 1365, height: 844, pixelRatio: 2, isMobile: false });
    });

    await desktop;

    await withViewport({ innerWidth: 390, innerHeight: 844, devicePixelRatio: 3, matchMedia: true }, async () => {
        const result = await executeCapability(EXTENSION_ID, 'viewport.get', null);
        assert.deepEqual(result.data, { width: 390, height: 844, pixelRatio: 3, isMobile: true });
    });

    // Fallback to width-only detection when matchMedia is unavailable.
    await withViewport({ innerWidth: 390, innerHeight: 844, devicePixelRatio: 1, matchMedia: undefined }, async () => {
        const result = await executeCapability(EXTENSION_ID, 'viewport.get', null);
        assert.equal(result.data.isMobile, true);
    });

    await withViewport({ innerWidth: 1365, innerHeight: 844, devicePixelRatio: 1, matchMedia: undefined }, async () => {
        const result = await executeCapability(EXTENSION_ID, 'viewport.get', null);
        assert.equal(result.data.isMobile, false);
    });
});

test('bridges allowlisted host events, avoids duplicate listeners, and detaches on unregister', async () => {
    const eventSource = createEventSource();
    const eventTypes = {
        CHAT_CHANGED: 'chat_id_changed',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
    };
    stubHost({ chatId: 'chat-1', chat: [], characters: [], eventSource, eventTypes });

    // Capability calls guarantee the bridge is attached once the host is reachable.
    await executeCapability(EXTENSION_ID, 'context.snapshot', null);
    assert.equal(eventSource.listenerCount(), 3);

    const received = [];
    globalThis.Loom.registerExtension({ id: observerId, name: 'Host Observer' });
    subscribe(observerId, 'host:chat:changed', payload => received.push(payload));
    subscribe(observerId, 'host:message:received', payload => received.push(payload));

    eventSource.fire('chat_id_changed');
    await new Promise(resolve => setTimeout(resolve, 0));
    eventSource.fire('message_received');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(received, [
        { source: 'sillytavern', event: 'CHAT_CHANGED' },
        { source: 'sillytavern', event: 'MESSAGE_RECEIVED' },
    ]);

    // Repeated capability calls must not attach duplicate host listeners.
    await executeCapability(EXTENSION_ID, 'context.snapshot', null);
    assert.equal(eventSource.listenerCount(), 3);

    const result = unregisterExtension(EXTENSION_ID);
    assert.deepEqual(result, { removed: true, cleanupErrors: [] });
    assert.equal(eventSource.listenerCount(), 0);
    assert.equal(listExtensions().some(extension => extension.id === EXTENSION_ID), false);

    eventSource.fire('chat_id_changed');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(received.length, 2, 'no further host events should be bridged after unregister');
    assert.deepEqual(await emit('host:chat:changed', null), { delivered: 1, errors: [] });
});

test('persists extension state under the reserved root and restores it on register', () => {
    const host = stubSettingsHost({});
    registerCoreExtension({ id: consumerId, name: 'State Consumer' });

    setState(consumerId, 'counter', 3);
    setState(consumerId, 'label', 'alpha');
    assert.deepEqual(host.extensionSettings.__loom.state[consumerId], { counter: 3, label: 'alpha' });

    deleteState(consumerId, 'counter');
    assert.deepEqual(host.extensionSettings.__loom.state[consumerId], { label: 'alpha' });

    deleteState(consumerId, 'label');
    assert.equal(Object.hasOwn(host.extensionSettings.__loom.state, consumerId), false,
        'removing the last key drops the namespace');

    // A fresh extension registering against a seeded store gets its state back.
    unregisterExtension(consumerId);
    stubSettingsHost({ __loom: { state: { [consumerId]: { restored: 1 } } } });
    registerCoreExtension({ id: consumerId, name: 'State Consumer' });
    assert.equal(getState(consumerId, 'restored'), 1);
    assert.deepEqual(windowStateKeys(), ['restored']);
});

function windowStateKeys() {
    return [...(globalThis.Loom.listStateKeys(consumerId))];
}

test('extension state keeps working when the host settings are unavailable', () => {
    stubHost({ chat: [] });
    registerCoreExtension({ id: consumerId, name: 'State Consumer' });
    setState(consumerId, 'key', 'value');
    assert.equal(getState(consumerId, 'key'), 'value', 'state stays in memory when nothing can be persisted');
});

test('denies settings writes until the caller holds host.settings.write', async () => {    const host = stubSettingsHost({});
    registerConsumer();

    const denied = await executeCapability(EXTENSION_ID, 'settings.set', { key: 'theme', value: 'dark' }, { caller: consumerId });
    assert.equal(denied.success, false);
    assert.equal(denied.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(denied.error.details.missing, ['host.settings.write']);
    assert.deepEqual(host.extensionSettings, {}, 'a denied write must not create a namespace');
    assert.equal(host.saves(), 0);

    grantPermission(consumerId, 'host.settings.write');
    const savesAfterGrant = host.saves();
    const allowed = await executeCapability(EXTENSION_ID, 'settings.set', { key: 'theme', value: 'dark' }, { caller: consumerId });
    assert.deepEqual(allowed, { success: true, data: { key: 'theme', written: true } });
    assert.deepEqual(host.extensionSettings[consumerId], { theme: 'dark' });
    assert.equal(host.saves(), savesAfterGrant + 1, 'a successful write saves once');

    revokePermission(consumerId, 'host.settings.write');
    const deniedAgain = await executeCapability(EXTENSION_ID, 'settings.remove', { key: 'theme' }, { caller: consumerId });
    assert.equal(deniedAgain.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(host.extensionSettings[consumerId], { theme: 'dark' }, 'a denied removal must not delete the key');
});

test('scopes settings reads and writes to the calling extension namespace', async () => {
    const host = stubSettingsHost({ 'loom-host': { own: 1 } });
    registerConsumer();

    // The consumer cannot see the host adapter's own namespace.
    const read = await executeCapability(EXTENSION_ID, 'settings.get', { key: 'own' }, { caller: consumerId });
    assert.deepEqual(read, { success: true, data: { key: 'own', present: false, value: null } });

    grantPermission(consumerId, 'host.settings.write');
    await executeCapability(EXTENSION_ID, 'settings.set', { key: 'own', value: 2 }, { caller: consumerId });

    assert.deepEqual(host.extensionSettings[consumerId], { own: 2 });
    assert.deepEqual(host.extensionSettings[EXTENSION_ID], { own: 1 }, 'the host namespace must stay untouched');
    assert.deepEqual(
        await executeCapability(EXTENSION_ID, 'settings.keys', null, { caller: consumerId }),
        { success: true, data: ['own'] },
    );
});

test('reads do not create an empty settings namespace', async () => {
    const host = stubSettingsHost({});
    registerConsumer();

    assert.deepEqual(
        await executeCapability(EXTENSION_ID, 'settings.get', { key: 'missing' }, { caller: consumerId }),
        { success: true, data: { key: 'missing', present: false, value: null } },
    );
    assert.deepEqual(
        await executeCapability(EXTENSION_ID, 'settings.keys', null, { caller: consumerId }),
        { success: true, data: [] },
    );
    assert.deepEqual(host.extensionSettings, {}, 'probing settings must not add a namespace to the user settings');
    assert.equal(host.saves(), 0);
});

test('rejects reserved, empty and oversized settings keys', async () => {
    stubSettingsHost({});
    registerConsumer();
    grantPermission(consumerId, 'host.settings.write');

    for (const key of ['__proto__', 'constructor', 'prototype', '   ', 'k'.repeat(129)]) {
        const result = await executeCapability(EXTENSION_ID, 'settings.set', { key, value: 1 }, { caller: consumerId });
        assert.equal(result.success, false, `key ${JSON.stringify(key)} should be rejected`);
        assert.equal(result.error.code, 'INVALID_INPUT');
    }
    // The schema already rejects an empty string before the handler runs.
    assert.equal(
        (await executeCapability(EXTENSION_ID, 'settings.get', { key: '' }, { caller: consumerId })).error.code,
        'INVALID_INPUT',
    );
});

test('rejects non-serializable settings values', async () => {
    const host = stubSettingsHost({});
    registerConsumer();
    grantPermission(consumerId, 'host.settings.write');
    const savesBefore = host.saves();

    const result = await executeCapability(
        EXTENSION_ID, 'settings.set', { key: 'callback', value: () => {} }, { caller: consumerId },
    );
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_INPUT');
    assert.equal(Object.hasOwn(host.extensionSettings, consumerId), false, 'a rejected write must not create a namespace');
    assert.equal(host.saves(), savesBefore, 'a rejected write must not save');
});

test('persists the grant table under the reserved root and restores it on boot', async () => {
    const host = stubSettingsHost({});
    registerConsumer();
    grantPermission(consumerId, 'host.settings.write');

    // The store lives in the host's own reserved root, not in a caller namespace.
    assert.deepEqual(host.extensionSettings.__loom.grants, [
        { extensionId: consumerId, permissions: ['host.settings.write'] },
    ]);
    assert.equal(Object.hasOwn(host.extensionSettings, consumerId), false);

    // A fresh Core boot sees the persisted grant once the extension registers.
    globalThis.Loom.setPermissionStore({
        load: () => structuredClone(host.extensionSettings.__loom.grants),
        save: () => {},
    });
    assert.equal(globalThis.Loom.getRuntimeInfo().permissionStoreAttached, true);
    assert.equal(globalThis.Loom.checkPermission(consumerId, 'host.settings.write'), true);

    // Detach so this fake store cannot leak into later tests.
    globalThis.Loom.setPermissionStore(null);
    assert.equal(globalThis.Loom.getRuntimeInfo().permissionStoreAttached, false);
});

test('fails settings calls with a structured error when the host settings are unavailable', async () => {
    stubHost({ chat: [] });
    registerConsumer();

    const result = await executeCapability(EXTENSION_ID, 'settings.keys', null, { caller: consumerId });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'HOST_UNAVAILABLE');
});

function stubChatHost(options = {}) {
    const chat = options.chat ?? [];
    const appended = [];
    const calls = [];
    let saved = 0;
    stubHost({
        // An explicit null chatId must survive the default (?? would replace it).
        chatId: Object.hasOwn(options, 'chatId') ? options.chatId : 'chat-1',
        chat,
        sendSystemMessage: (type, text) => {
            appended.push({ type, text });
            if (options.rejectType === type) {
                if (options.pushUndefined) chat.push(undefined);
                return;
            }
            chat.push({ name: 'System', is_system: true, is_user: false, mes: text, extra: { type } });
        },
        updateMessageBlock: async index => {
            calls.push(['updateMessageBlock', index]);
            if (options.failRender) throw new Error('render failed');
        },
        deleteMessage: async (index, swipeIndex, ask, deleteToolCalls) => {
            calls.push(['deleteMessage', index, swipeIndex, ask, deleteToolCalls]);
            if (options.noDelete) return;
            chat.splice(index, 1);
        },
        saveChat: async () => {
            saved += 1;
            if (options.failSave) throw new Error('save failed');
        },
    });
    return { chat, appended, calls, saved: () => saved };
}

test('appends a system message to the chat and saves it', async () => {
    const host = stubChatHost({ chat: [{ name: 'A', mes: 'hello' }] });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const result = await executeCapability(EXTENSION_ID, 'chat.append', { text: '注意：世界书已更新' }, { caller: consumerId });
    assert.deepEqual(result, { success: true, data: { appended: true, type: 'generic', index: 1 } },
        'the default type is one the host actually defines');
    assert.deepEqual(host.appended, [{ type: 'generic', text: '注意：世界书已更新' }]);
    assert.equal(host.chat.length, 2);
    assert.equal(host.saved(), 1, 'the message is persisted, not only rendered');
});

test('chat.append is gated by host.chat.write', async () => {
    const host = stubChatHost();
    registerConsumer();

    const denied = await executeCapability(EXTENSION_ID, 'chat.append', { text: 'x' }, { caller: consumerId });
    assert.equal(denied.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(denied.error.details.missing, ['host.chat.write']);
    assert.deepEqual(host.appended, []);
    assert.equal(host.saved(), 0);
});

test('chat.append refuses to write without an open chat', async () => {
    stubChatHost({ chat: [], chatId: null });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const result = await executeCapability(EXTENSION_ID, 'chat.append', { text: 'x' }, { caller: consumerId });
    assert.equal(result.error.code, 'NO_CHAT');
});

test('chat.edit rewrites a message and reports the previous text', async () => {
    const host = stubChatHost({ chat: [{ name: 'A', mes: 'old' }, { name: 'B', mes: 'second' }] });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const result = await executeCapability(EXTENSION_ID, 'chat.edit',
        { index: 0, text: 'edited' }, { caller: consumerId });
    assert.deepEqual(result.data, { index: 0, previous: 'old', saved: true, rendered: true });
    assert.equal(host.chat[0].mes, 'edited');
    assert.deepEqual(host.calls, [['updateMessageBlock', 0]], 'the message is re-rendered');
    assert.equal(host.saved(), 1, 'the edit is persisted');
});

test('chat.edit rolls the message back when the host cannot re-render', async () => {
    const host = stubChatHost({ chat: [{ name: 'A', mes: 'old' }], failRender: true });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const result = await executeCapability(EXTENSION_ID, 'chat.edit',
        { index: 0, text: 'edited' }, { caller: consumerId });
    assert.equal(result.error.code, 'MESSAGE_UPDATE_FAILED');
    assert.equal(host.chat[0].mes, 'old', 'the text is restored');
    assert.equal(host.saved(), 0, 'nothing is saved');
});

test('chat.edit reports a stale save and an out-of-range index', async () => {
    const host = stubChatHost({ chat: [{ name: 'A', mes: 'old' }], failSave: true });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const stale = await executeCapability(EXTENSION_ID, 'chat.edit',
        { index: 0, text: 'edited' }, { caller: consumerId });
    assert.equal(stale.data.saved, false, 'a failed save is not reported as saved');
    assert.equal(stale.data.rendered, true);

    const outOfRange = await executeCapability(EXTENSION_ID, 'chat.edit',
        { index: 9, text: 'edited' }, { caller: consumerId });
    assert.equal(outOfRange.error.code, 'MESSAGE_NOT_FOUND');
});

test('chat.delete requires the current text before removing a message', async () => {
    const host = stubChatHost({ chat: [{ name: 'A', mes: 'old' }, { name: 'B', mes: 'second' }] });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const guarded = await executeCapability(EXTENSION_ID, 'chat.delete',
        { index: 0, expect: 'wrong text' }, { caller: consumerId });
    assert.equal(guarded.error.code, 'CONFIRMATION_REQUIRED');
    assert.deepEqual(guarded.error.details, { index: 0, current: 'old' });
    assert.equal(host.chat.length, 2, 'nothing is deleted');
    assert.deepEqual(host.calls, []);

    const deleted = await executeCapability(EXTENSION_ID, 'chat.delete',
        { index: 0, expect: 'old' }, { caller: consumerId });
    assert.deepEqual(deleted.data, { index: 0, removed: 1, remaining: 1 });
    assert.deepEqual(host.calls, [['deleteMessage', 0, undefined, false, true]],
        'the host delete runs without its own confirmation dialog');
});

test('chat.delete reports when the host removed nothing', async () => {
    const host = stubChatHost({ chat: [{ name: 'A', mes: 'old' }], noDelete: true });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const result = await executeCapability(EXTENSION_ID, 'chat.delete',
        { index: 0, expect: 'old' }, { caller: consumerId });
    assert.equal(result.error.code, 'MESSAGE_DELETE_FAILED');
});

test('chat edit and delete are gated by host.chat.write', async () => {
    const host = stubChatHost({ chat: [{ name: 'A', mes: 'old' }] });
    registerConsumer();

    for (const [id, input] of [
        ['chat.edit', { index: 0, text: 'edited' }],
        ['chat.delete', { index: 0, expect: 'old' }],
    ]) {
        const denied = await executeCapability(EXTENSION_ID, id, input, { caller: consumerId });
        assert.equal(denied.error.code, 'PERMISSION_DENIED', id);
        assert.deepEqual(denied.error.details.missing, ['host.chat.write'], id);
    }
    assert.deepEqual(host.calls, [], 'no host mutation happens without the grant');
    assert.equal(host.chat[0].mes, 'old');
});

test('chat.append rejects unknown message types and oversized text', async () => {
    const host = stubChatHost();
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const badType = await executeCapability(EXTENSION_ID, 'chat.append', { text: 'x', type: 'html' }, { caller: consumerId });
    assert.equal(badType.error.code, 'INVALID_INPUT');
    // Types that exist in the host's enum but have no template are refused up
    // front instead of pushing `undefined` into the chat.
    const narrator = await executeCapability(EXTENSION_ID, 'chat.append', { text: 'x', type: 'narrator' }, { caller: consumerId });
    assert.equal(narrator.error.code, 'INVALID_INPUT', 'narrator has no template in SillyTavern 1.19');
    const tooLong = await executeCapability(EXTENSION_ID, 'chat.append', { text: 'x'.repeat(4001) }, { caller: consumerId });
    assert.equal(tooLong.error.code, 'INVALID_INPUT');
    assert.deepEqual(host.appended, []);
});

test('chat.append rolls back when the host rejects the message', async () => {
    // Some builds push an empty entry for an unsupported type.
    const host = stubChatHost({ chat: [{ name: 'A', mes: 'hi' }], rejectType: 'generic', pushUndefined: true });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const result = await executeCapability(EXTENSION_ID, 'chat.append', { text: 'x' }, { caller: consumerId });
    assert.equal(result.error.code, 'HOST_UNSUPPORTED');
    assert.equal(host.chat.length, 1, 'the corrupt entry was removed again');
    assert.equal(host.saved(), 0, 'nothing is saved when the write failed');
});

test('chat.append reports an unsupported host', async () => {
    stubHost({ chat: [{ mes: 'x' }], chatId: 'c1' });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.write');

    const result = await executeCapability(EXTENSION_ID, 'chat.append', { text: 'x' }, { caller: consumerId });
    assert.equal(result.error.code, 'HOST_UNSUPPORTED');
});

test('reads chat messages newest-first slicing without leaking the raw host objects', async () => {
    const chat = [
        { name: 'A', is_user: true, mes: 'one', extra: { secret: 'host-internal' } },
        { name: 'System', is_system: true, mes: 'two' },
        { name: 'B', is_user: false, mes: 'three' },
        { name: 'A', is_user: true, mes: 'four' },
        { name: 'B', is_user: false, mes: 'five' },
    ];
    stubHost({ chat });
    registerConsumer();

    // Gated: chat content is private conversation.
    const denied = await executeCapability(EXTENSION_ID, 'chat.messages', { limit: 2 }, { caller: consumerId });
    assert.equal(denied.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(denied.error.details.missing, ['host.chat.read']);

    grantPermission(consumerId, 'host.chat.read');
    const recent = await executeCapability(EXTENSION_ID, 'chat.messages', { limit: 2 }, { caller: consumerId });
    assert.equal(recent.success, true);
    assert.deepEqual(recent.data.map(message => message.text), ['four', 'five']);
    assert.deepEqual(recent.data.map(message => message.index), [3, 4], 'index is the absolute chat position');
    assert.deepEqual(recent.data[0], {
        index: 3, name: 'A', isUser: true, isSystem: false, text: 'four', truncated: false,
    });

    const offset = await executeCapability(EXTENSION_ID, 'chat.messages', { limit: 2, offset: 3 }, { caller: consumerId });
    assert.deepEqual(offset.data.map(message => message.text), ['one', 'two']);

    // Defaults: newest 20 messages when input is null.
    const all = await executeCapability(EXTENSION_ID, 'chat.messages', null, { caller: consumerId });
    assert.deepEqual(all.data.map(message => message.text), ['one', 'two', 'three', 'four', 'five']);
});

test('truncates long chat messages instead of forwarding unbounded text', async () => {
    stubHost({ chat: [{ name: 'A', is_user: false, mes: 'x'.repeat(5000) }] });
    registerConsumer();
    grantPermission(consumerId, 'host.chat.read');

    const result = await executeCapability(EXTENSION_ID, 'chat.messages', {}, { caller: consumerId });
    assert.equal(result.data[0].text.length, 2000);
    assert.equal(result.data[0].truncated, true);
});

test('reads world book entries through the host loader', async () => {
    const loaded = [];
    stubHost({
        chat: [],
        loadWorldInfo: async name => {
            loaded.push(name);
            return {
                entries: {
                    2: { uid: 2, comment: 'second', key: ['b'], keysecondary: [], content: 'B content', order: 200, disable: true },
                    1: { uid: 1, comment: 'first', key: ['a'], keysecondary: ['a2'], content: 'A content', order: 100, constant: true, selective: true },
                },
            };
        },
    });

    const result = await executeCapability(EXTENSION_ID, 'worlds.entries', { name: 'Lore' });
    assert.equal(result.success, true);
    assert.deepEqual(loaded, ['Lore']);
    assert.deepEqual(result.data, [
        {
            uid: '1', comment: 'first', keys: ['a'], secondaryKeys: ['a2'], content: 'A content',
            enabled: true, constant: true, selective: true, order: 100, truncated: false,
        },
        {
            uid: '2', comment: 'second', keys: ['b'], secondaryKeys: [], content: 'B content',
            enabled: false, constant: false, selective: false, order: 200, truncated: false,
        },
    ]);
});

test('returns no entries for a world book that has none, and reports unsupported hosts', async () => {
    stubHost({ chat: [], loadWorldInfo: async () => ({ entries: {} }) });
    assert.deepEqual(await executeCapability(EXTENSION_ID, 'worlds.entries', { name: 'Empty' }), {
        success: true, data: [],
    });

    stubHost({ chat: [], loadWorldInfo: async () => undefined });
    assert.deepEqual(await executeCapability(EXTENSION_ID, 'worlds.entries', { name: 'Missing' }), {
        success: true, data: [],
    });

    stubHost({ chat: [] });
    const unsupported = await executeCapability(EXTENSION_ID, 'worlds.entries', { name: 'Lore' });
    assert.equal(unsupported.success, false);
    assert.equal(unsupported.error.code, 'HOST_UNSUPPORTED');
});

function stubWorldBook(entries, options = {}) {
    const name = options.name ?? 'Lore';
    const saved = [];
    const book = { entries };
    stubHost({
        chat: [],
        loadWorldInfo: async () => book,
        saveWorldInfo: async (worldName, data, immediately) => { saved.push({ name: worldName, data, immediately }); },
        getWorldInfoNames: () => (options.hidden ? [] : [name]),
    });
    return { book, saved };
}

test('updates world entry fields through a read-modify-write with an immediate save', async () => {
    const { book, saved } = stubWorldBook({
        1: { uid: 1, comment: 'keep', key: ['old'], keysecondary: [], content: 'old text', order: 100, disable: true },
    });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    const result = await executeCapability(EXTENSION_ID, 'worlds.entry.update', {
        name: 'Lore',
        uid: '1',
        patch: { content: 'new text', enabled: true, keys: ['alpha', 'beta'] },
    }, { caller: consumerId });

    assert.deepEqual(result, {
        success: true,
        data: { name: 'Lore', uid: '1', updated: ['content', 'enabled', 'keys'] },
    });
    assert.equal(book.entries[1].content, 'new text');
    assert.equal(book.entries[1].disable, false, 'enabled is stored as the inverted disable flag');
    assert.deepEqual(book.entries[1].key, ['alpha', 'beta']);
    assert.equal(book.entries[1].comment, 'keep', 'fields outside the patch are untouched');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'Lore');
    assert.equal(saved[0].immediately, true, 'the write must not be debounced');
});

test('denies world entry writes without host.worldinfo.write', async () => {
    const { book, saved } = stubWorldBook({ 1: { uid: 1, content: 'original' } });
    registerConsumer();

    const denied = await executeCapability(EXTENSION_ID, 'worlds.entry.update', {
        name: 'Lore', uid: '1', patch: { content: 'changed' },
    }, { caller: consumerId });

    assert.equal(denied.success, false);
    assert.equal(denied.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(denied.error.details.missing, ['host.worldinfo.write']);
    assert.equal(book.entries[1].content, 'original');
    assert.equal(saved.length, 0);
});

test('reports missing worlds and entries instead of writing blindly', async () => {
    stubWorldBook({ 1: { uid: 1, content: 'original' } });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    const missingEntry = await executeCapability(EXTENSION_ID, 'worlds.entry.update', {
        name: 'Lore', uid: '999', patch: { content: 'x' },
    }, { caller: consumerId });
    assert.equal(missingEntry.success, false);
    assert.equal(missingEntry.error.code, 'ENTRY_NOT_FOUND');

    stubHost({ chat: [], loadWorldInfo: async () => ({ entries: {} }), saveWorldInfo: async () => {} });
    const emptyWorld = await executeCapability(EXTENSION_ID, 'worlds.entry.update', {
        name: 'Empty', uid: '1', patch: { content: 'x' },
    }, { caller: consumerId });
    assert.equal(emptyWorld.success, false);
    assert.equal(emptyWorld.error.code, 'WORLD_NOT_FOUND', 'a book with no entries is reported as missing, not as a missing entry');

    stubHost({ chat: [], loadWorldInfo: async () => undefined, saveWorldInfo: async () => {} });
    const missingWorld = await executeCapability(EXTENSION_ID, 'worlds.entry.update', {
        name: 'Nope', uid: '1', patch: { content: 'x' },
    }, { caller: consumerId });
    assert.equal(missingWorld.success, false);
    assert.equal(missingWorld.error.code, 'WORLD_NOT_FOUND');
});

test('rejects unknown patch fields and empty patches', async () => {
    const { book, saved } = stubWorldBook({ 1: { uid: 1, content: 'original' } });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    const unknownField = await executeCapability(EXTENSION_ID, 'worlds.entry.update', {
        name: 'Lore', uid: '1', patch: { contnet: 'typo' },
    }, { caller: consumerId });
    assert.equal(unknownField.success, false);
    assert.equal(unknownField.error.code, 'INVALID_INPUT');
    assert.equal(book.entries[1].content, 'original');
    assert.equal(saved.length, 0);

    const empty = await executeCapability(EXTENSION_ID, 'worlds.entry.update', {
        name: 'Lore', uid: '1', patch: {},
    }, { caller: consumerId });
    assert.deepEqual(empty, { success: true, data: { name: 'Lore', uid: '1', updated: [] } });
    assert.equal(saved.length, 0, 'an empty patch must not touch the book');
});

test('reports an unsupported host when the world book cannot be saved', async () => {
    stubHost({ chat: [], loadWorldInfo: async () => ({ entries: {} }) });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    const result = await executeCapability(EXTENSION_ID, 'worlds.entry.update', {
        name: 'Lore', uid: '1', patch: { content: 'x' },
    }, { caller: consumerId });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'HOST_UNSUPPORTED');
});

test('creates a world entry with the first free uid and host defaults', async () => {
    // SillyTavern allocates the first free uid from 0, not max+1.
    const { book, saved } = stubWorldBook({
        0: { uid: 0, content: 'zero' },
        2: { uid: 2, content: 'two' },
    });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    const result = await executeCapability(EXTENSION_ID, 'worlds.entry.create', {
        name: 'Lore',
        entry: { content: 'fresh', keys: ['k'], enabled: false },
    }, { caller: consumerId });

    assert.deepEqual(result, {
        success: true,
        data: { name: 'Lore', uid: 1, created: ['content', 'enabled', 'keys'] },
    });

    const created = book.entries[1];
    assert.equal(created.uid, 1);
    assert.equal(created.content, 'fresh');
    assert.deepEqual(created.key, ['k']);
    assert.equal(created.disable, true, 'enabled false maps onto the inverted disable flag');
    assert.equal(created.comment, '', 'defaults come from the host entry template');
    assert.deepEqual(created.keysecondary, []);
    assert.equal(created.selective, true);
    assert.equal(created.order, 100);
    assert.equal(created.depth, 4);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].immediately, true);
});

test('creates an entry with no options at all and reuses a freed uid', async () => {
    const { book } = stubWorldBook({ 0: { uid: 0, content: 'zero' }, 1: { uid: 1, content: 'one' } });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    // uid 1 removed by another editor: the next create must reuse it.
    delete book.entries[1];
    const result = await executeCapability(EXTENSION_ID, 'worlds.entry.create', { name: 'Lore' }, { caller: consumerId });
    assert.deepEqual(result, { success: true, data: { name: 'Lore', uid: 1, created: [] } });
    assert.equal(book.entries[1].content, '');
    assert.deepEqual(book.entries[1].key, []);
});

test('does not allocate a uid that an entry claims but is keyed differently', async () => {
    const { book } = stubWorldBook({ 7: { uid: 0, content: 'imported' } });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    const result = await executeCapability(EXTENSION_ID, 'worlds.entry.create', { name: 'Lore' }, { caller: consumerId });
    assert.equal(result.data.uid, 1, 'the entry uid field is reserved even when its key differs');
    assert.ok(book.entries[1]);
});

test('denies world entry create and remove without a grant', async () => {
    const { book, saved } = stubWorldBook({ 0: { uid: 0, content: 'zero' } });
    registerConsumer();

    const created = await executeCapability(EXTENSION_ID, 'worlds.entry.create', { name: 'Lore' }, { caller: consumerId });
    assert.equal(created.error.code, 'PERMISSION_DENIED');
    const removed = await executeCapability(EXTENSION_ID, 'worlds.entry.remove', { name: 'Lore', uid: '0' }, { caller: consumerId });
    assert.equal(removed.error.code, 'PERMISSION_DENIED');

    assert.deepEqual(Object.keys(book.entries), ['0'], 'a denied call must not alter the book');
    assert.equal(saved.length, 0);
});

test('removes a world entry and reports missing targets', async () => {
    const { book, saved } = stubWorldBook({
        0: { uid: 0, content: 'zero' },
        1: { uid: 1, content: 'one' },
    });
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    assert.deepEqual(await executeCapability(EXTENSION_ID, 'worlds.entry.remove', { name: 'Lore', uid: '1' }, { caller: consumerId }), {
        success: true,
        data: { name: 'Lore', uid: '1', removed: true },
    });
    assert.deepEqual(Object.keys(book.entries), ['0']);
    assert.equal(saved.length, 1);

    const again = await executeCapability(EXTENSION_ID, 'worlds.entry.remove', { name: 'Lore', uid: '1' }, { caller: consumerId });
    assert.equal(again.error.code, 'ENTRY_NOT_FOUND');

    stubHost({ chat: [], loadWorldInfo: async () => undefined, saveWorldInfo: async () => {} });
    const noWorld = await executeCapability(EXTENSION_ID, 'worlds.entry.remove', { name: 'Nope', uid: '1' }, { caller: consumerId });
    assert.equal(noWorld.error.code, 'WORLD_NOT_FOUND');
});

test('refuses to create in a missing book and reports an unsupported host', async () => {
    registerConsumer();
    grantPermission(consumerId, 'host.worldinfo.write');

    // A name outside the host's world list must not silently create a new book.
    stubWorldBook({}, { hidden: true });
    const missing = await executeCapability(EXTENSION_ID, 'worlds.entry.create', { name: 'Lore' }, { caller: consumerId });
    assert.equal(missing.error.code, 'WORLD_NOT_FOUND');

    // An existing but empty book is a valid target and gets the first uid.
    const empty = stubWorldBook({});
    const first = await executeCapability(EXTENSION_ID, 'worlds.entry.create', { name: 'Lore' }, { caller: consumerId });
    assert.deepEqual(first, { success: true, data: { name: 'Lore', uid: 0, created: [] } });
    assert.ok(empty.book.entries[0]);

    stubHost({ chat: [], saveWorldInfo: async () => {} });
    const noLoader = await executeCapability(EXTENSION_ID, 'worlds.entry.create', { name: 'Lore' }, { caller: consumerId });
    assert.equal(noLoader.error.code, 'HOST_UNSUPPORTED');
});

test('reads character card fields by name or avatar and returns null when absent', async () => {
    stubHost({
        chat: [],
        characters: [
            {
                name: 'Alice',
                avatar: 'alice.png',
                description: 'desc',
                personality: 'kind',
                scenario: 'town',
                first_mes: 'hello',
                mes_example: 'example',
                creator_notes: 'notes',
                tags: ['tag1'],
            },
        ],
    });

    assert.deepEqual(await executeCapability(EXTENSION_ID, 'characters.get', { name: 'alice' }), {
        success: true,
        data: {
            name: 'Alice',
            avatar: 'alice.png',
            description: 'desc',
            personality: 'kind',
            scenario: 'town',
            firstMessage: 'hello',
            exampleMessages: 'example',
            creatorNotes: 'notes',
            tags: ['tag1'],
        },
    });

    assert.equal(
        (await executeCapability(EXTENSION_ID, 'characters.get', { name: 'alice.png' })).data.name,
        'Alice',
    );
    assert.deepEqual(await executeCapability(EXTENSION_ID, 'characters.get', { name: 'nobody' }), {
        success: true, data: null,
    });
});
