import test from 'node:test';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import {
    activateExtension,
    deactivateExtension,
    emit,
    getExtensionState,
    getRuntimeInfo,
    importExtension,
    listExtensionStates,
    listExtensions,
    listPermissionRequests,
    loadExtension,
    registerExtension,
    startExtensions,
    subscribe,
    unloadExtension,
    unregisterExtension,
} from './index.js';

const prefix = 'loader-test';
const ids = {
    base: `${prefix}-base`,
    dependent: `${prefix}-dependent`,
    broken: `${prefix}-broken`,
    plain: `${prefix}-plain`,
};

afterEach(() => {
    for (const id of Object.values(ids)) unregisterExtension(id);
});

function manifest(overrides = {}) {
    return { id: ids.base, name: 'Loader Base', version: '1.0.0', ...overrides };
}

test('loads a manifest, registers identity, and activates it', () => {
    const calls = [];
    const loaded = loadExtension(manifest({
        entry: 'extensions/base/index.js',
        activate: event => calls.push(['activate', event.id]),
        deactivate: event => calls.push(['deactivate', event.id]),
    }));

    assert.deepEqual(loaded, {
        id: ids.base,
        name: 'Loader Base',
        version: '1.0.0',
        state: 'loaded',
        entry: 'extensions/base/index.js',
        dependencies: [],
        permissions: [],
        error: null,
    });
    assert.ok(listExtensions().some(extension => extension.id === ids.base), 'identity is registered on load');
    assert.deepEqual(calls, [], 'loading must not run extension code');

    const active = activateExtension(ids.base);
    assert.equal(active.state, 'active');
    assert.deepEqual(calls, [['activate', ids.base]]);

    const inactive = deactivateExtension(ids.base);
    assert.equal(inactive.state, 'inactive');
    assert.deepEqual(calls, [['activate', ids.base], ['deactivate', ids.base]]);
});

test('validates manifests and rejects duplicates', () => {
    assert.throws(() => loadExtension(), /must be an object/);
    assert.throws(() => loadExtension({ name: 'No id' }), /Manifest id must/);
    assert.throws(() => loadExtension({ id: ids.base }), /Manifest name is required/);
    assert.throws(() => loadExtension(manifest({ version: '' })), /version must be a non-empty string/);
    assert.throws(() => loadExtension(manifest({ entry: '' })), /entry must be a non-empty string/);
    assert.throws(() => loadExtension(manifest({ activate: 'nope' })), /activate must be a function/);
    assert.throws(() => loadExtension(manifest({ dependencies: 'x' })), /dependencies must be an array/);
    assert.throws(() => loadExtension(manifest({ dependencies: ['bad id'] })), /dependencies entries/);
    assert.throws(() => loadExtension(manifest({ dependencies: [ids.base] })), /must not include the extension itself/);
    assert.throws(() => loadExtension(manifest({ permissions: ['bad permission'] })), /permissions must be valid permission names/);

    loadExtension(manifest());
    assert.throws(() => loadExtension(manifest({ name: 'Duplicate' })), /already loaded/);
});

test('refuses to activate an extension that was never loaded', () => {
    assert.throws(() => activateExtension('never-loaded'), /not loaded/);
    assert.throws(() => deactivateExtension('never-loaded'), /not loaded/);
    assert.deepEqual(unloadExtension('never-loaded'), { removed: false, cleanupErrors: [] });
});

test('blocks activation on missing dependencies without running the hook', () => {
    const calls = [];
    loadExtension(manifest({ id: ids.base, name: 'Base' }));
    loadExtension(manifest({
        id: ids.dependent,
        name: 'Dependent',
        dependencies: [ids.base],
        activate: () => calls.push('dependent-activate'),
    }));

    const blocked = activateExtension(ids.dependent);
    assert.equal(blocked.state, 'failed');
    assert.equal(blocked.error.code, 'DEPENDENCY_MISSING');
    assert.deepEqual(blocked.error.details.missing, [ids.base]);
    assert.deepEqual(calls, [], 'a blocked extension must not run its hook');

    // Only an *active* dependency unblocks it.
    activateExtension(ids.base);
    const activated = activateExtension(ids.dependent);
    assert.equal(activated.state, 'active');
    assert.deepEqual(calls, ['dependent-activate']);
});

test('treats a deactivated dependency as unmet', () => {
    loadExtension(manifest({ id: ids.base, name: 'Base' }));
    loadExtension(manifest({ id: ids.dependent, name: 'Dependent', dependencies: [ids.base] }));
    activateExtension(ids.base);
    activateExtension(ids.dependent);
    deactivateExtension(ids.base);

    // Re-activation is rejected while the dependency is inactive.
    deactivateExtension(ids.dependent);
    const blocked = activateExtension(ids.dependent);
    assert.equal(blocked.state, 'failed');
    assert.equal(blocked.error.code, 'DEPENDENCY_MISSING');
});

test('accepts an unmanaged bootstrap extension as a satisfied dependency', () => {
    // Extensions registered directly (the host adapter, the UI) ran their setup
    // already; they can never become `active` through the loader, so requiring
    // that state would make them unusable as dependencies.
    registerExtension({ id: ids.plain, name: 'Bootstrap' });
    loadExtension(manifest({ id: ids.dependent, name: 'Dependent', dependencies: [ids.plain] }));

    const state = activateExtension(ids.dependent);
    assert.equal(state.state, 'active');
});

test('reports an unknown dependency as unmet', () => {
    loadExtension(manifest({ id: ids.dependent, name: 'Dependent', dependencies: ['never-registered'] }));
    const blocked = activateExtension(ids.dependent);
    assert.equal(blocked.error.code, 'DEPENDENCY_MISSING');
    assert.deepEqual(blocked.error.details.missing, ['never-registered']);
});

test('isolates activation failures and keeps other extensions usable', () => {
    loadExtension(manifest({ id: ids.broken, name: 'Broken', activate: () => { throw new Error('hook exploded'); } }));
    loadExtension(manifest({ id: ids.base, name: 'Base' }));

    const failed = activateExtension(ids.broken);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error.code, 'ACTIVATION_FAILED');
    assert.equal(failed.error.message, 'hook exploded');

    const ok = activateExtension(ids.base);
    assert.equal(ok.state, 'active', 'a failed neighbour must not block others');
    assert.equal(activateExtension(ids.base).state, 'active', 'activating twice is idempotent');
    assert.equal(getRuntimeInfo().failedExtensionCount, 1);
    assert.equal(getRuntimeInfo().activeExtensionCount, 1);
});

test('a failed activation can be retried and clear the error', () => {
    let attempts = 0;
    loadExtension(manifest({
        id: ids.broken,
        name: 'Flaky',
        activate: () => {
            attempts += 1;
            if (attempts === 1) throw new Error('first attempt failed');
        },
    }));

    assert.equal(activateExtension(ids.broken).state, 'failed');
    const retried = activateExtension(ids.broken);
    assert.equal(retried.state, 'active');
    assert.equal(retried.error, null);
    assert.equal(attempts, 2);
});

test('requests declared permissions instead of granting them', () => {
    loadExtension(manifest({
        id: ids.base,
        name: 'Permission Seeker',
        permissions: ['host.chat.read', 'host.chat.read'],
    }));
    assert.deepEqual(listPermissionRequests(), [], 'loading must not raise prompts');

    const state = activateExtension(ids.base);
    assert.equal(state.state, 'active');
    const requests = listPermissionRequests().filter(request => request.extensionId === ids.base);
    assert.equal(requests.length, 1, 'duplicate declarations collapse');
    assert.equal(requests[0].permission, 'host.chat.read');
    assert.match(requests[0].reason, /清单/);
    assert.equal(getRuntimeInfo().grantedPermissionCount, 0, 'activation never grants');
});

test('records a deactivation hook failure but still deactivates', () => {
    let calls = 0;
    loadExtension(manifest({
        id: ids.base,
        name: 'Base',
        deactivate: () => {
            calls += 1;
            throw new Error('teardown failed');
        },
    }));
    activateExtension(ids.base);

    const state = deactivateExtension(ids.base);
    assert.equal(state.state, 'inactive');
    assert.equal(state.error.code, 'DEACTIVATION_FAILED');
    assert.equal(state.error.message, 'teardown failed');

    // A repeated deactivate is a no-op: no hook call, and the recorded failure
    // is still reported rather than silently cleared.
    const again = deactivateExtension(ids.base);
    assert.equal(calls, 1, 'the hook must not run twice');
    assert.equal(again.error.code, 'DEACTIVATION_FAILED');
});

test('unloads an active extension and releases its registration', () => {
    loadExtension(manifest({ id: ids.base, name: 'Base' }));
    activateExtension(ids.base);

    const result = unloadExtension(ids.base);
    assert.deepEqual(result, { removed: true, cleanupErrors: [] });
    assert.equal(listExtensions().some(extension => extension.id === ids.base), false);
    assert.equal(getExtensionState(ids.base), null);
});

test('reports unmanaged extensions alongside loaded ones', () => {
    registerExtension({ id: ids.plain, name: 'Registered Directly' });
    loadExtension(manifest({ id: ids.base, name: 'Managed' }));

    const states = listExtensionStates();
    const plain = states.find(state => state.id === ids.plain);
    const managed = states.find(state => state.id === ids.base);
    assert.equal(plain.state, 'unmanaged');
    assert.deepEqual(plain.dependencies, []);
    assert.equal(managed.state, 'loaded');
    assert.deepEqual(getExtensionState(ids.plain).state, 'unmanaged');
});

test('emits lifecycle events for load, activate, fail, deactivate and unload', async () => {
    registerExtension({ id: ids.plain, name: 'Observer' });
    const events = [];
    for (const name of [
        'core:extension:loaded',
        'core:extension:activated',
        'core:extension:failed',
        'core:extension:deactivated',
        'core:extension:unloaded',
    ]) {
        subscribe(ids.plain, name, payload => events.push([name, payload.id, payload.state ?? null]));
    }

    loadExtension(manifest({ id: ids.base, name: 'Base' }));
    activateExtension(ids.base);
    deactivateExtension(ids.base);
    activateExtension(ids.base);
    loadExtension(manifest({ id: ids.broken, name: 'Broken', activate: () => { throw new Error('boom'); } }));
    activateExtension(ids.broken);
    unloadExtension(ids.base);

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(events.map(([name]) => name), [
        'core:extension:loaded',
        'core:extension:activated',
        'core:extension:deactivated',
        'core:extension:activated',
        'core:extension:loaded',
        'core:extension:failed',
        // Unloading an active extension deactivates it first.
        'core:extension:deactivated',
        'core:extension:unloaded',
    ]);
    // The lifecycle channel is a normal Loom event: listeners receive the payload
    // and a failing listener is reported without breaking delivery.
    assert.deepEqual(await emit('core:extension:loaded', { id: ids.plain, state: 'loaded' }), {
        delivered: 1,
        errors: [],
    });
});

test('starts every loaded extension in dependency order', () => {
    const order = [];
    loadExtension(manifest({
        id: ids.base,
        name: 'Base',
        activate: () => order.push('base'),
    }));
    loadExtension(manifest({
        id: ids.dependent,
        name: 'Dependent',
        dependencies: [ids.base],
        activate: () => order.push('dependent'),
    }));
    // Declared before its dependency to prove the order is computed, not declarative.
    loadExtension(manifest({
        id: ids.plain,
        name: 'Plain',
        activate: () => order.push('plain'),
    }));

    const result = startExtensions();
    // Only the dependency constraint is guaranteed; independent extensions start
    // in load order.
    assert.deepEqual(order.slice().sort(), ['base', 'dependent', 'plain']);
    assert.ok(order.indexOf('base') < order.indexOf('dependent'), 'the dependency started first');
    assert.deepEqual(result.activated.slice().sort(), [ids.base, ids.dependent, ids.plain].sort());
    assert.deepEqual(result.failed, []);
});

test('a dependent starts after its dependency even when it loads first', () => {
    let dependencyWasActive = null;
    loadExtension(manifest({
        id: ids.dependent,
        name: 'Dependent',
        dependencies: [ids.base],
        activate: () => {
            dependencyWasActive = getExtensionState(ids.base).state === 'active';
        },
    }));
    loadExtension(manifest({ id: ids.base, name: 'Base' }));

    startExtensions();
    assert.equal(dependencyWasActive, true, 'the hook saw its dependency already active');
});

test('startExtensions reports failures instead of throwing, and blocks dependents', () => {
    loadExtension(manifest({
        id: ids.broken,
        name: 'Broken',
        activate: () => { throw new Error('nope'); },
    }));
    loadExtension(manifest({ id: ids.dependent, name: 'Dependent', dependencies: [ids.broken] }));

    const result = startExtensions();
    const failedIds = result.failed.map(entry => entry.id);
    assert.deepEqual(failedIds.sort(), [ids.broken, ids.dependent].sort());
    assert.equal(result.failed.find(entry => entry.id === ids.broken).error.code, 'ACTIVATION_FAILED');
    assert.equal(result.failed.find(entry => entry.id === ids.dependent).error.code, 'DEPENDENCY_MISSING');
});

test('a dependency cycle fails both members rather than hanging', () => {
    loadExtension(manifest({ id: ids.base, name: 'A', dependencies: [ids.dependent] }));
    loadExtension(manifest({ id: ids.dependent, name: 'B', dependencies: [ids.base] }));

    const result = startExtensions();
    assert.deepEqual(result.activated, []);
    assert.deepEqual(result.failed.map(entry => entry.error.code).sort(), ['DEPENDENCY_MISSING', 'DEPENDENCY_MISSING']);
});

test('startExtensions is idempotent for already active extensions', () => {
    loadExtension(manifest({ id: ids.base, name: 'Base' }));
    activateExtension(ids.base);

    const result = startExtensions();
    assert.deepEqual(result.activated, [ids.base]);
    assert.deepEqual(result.failed, []);
});

test('imports an extension module and activates it', async () => {
    const source = `export default { id: '${ids.plain}', name: 'Imported', version: '2.1.0',
        activate: () => { globalThis.__loomImportedActivated = true; } };`;
    const result = await importExtension(`data:text/javascript,${encodeURIComponent(source)}`);

    assert.equal(result.id, ids.plain);
    assert.equal(result.state, 'active');
    assert.equal(globalThis.__loomImportedActivated, true);
    assert.equal(getExtensionState(ids.plain).version, '2.1.0');
    delete globalThis.__loomImportedActivated;
});

test('imports a manifest exported as a function or via options', async () => {
    const asFunction = await importExtension(
        `data:text/javascript,${encodeURIComponent(`export default () => ({ id: '${ids.base}', name: 'From factory' });`)}`,
    );
    assert.equal(asFunction.state, 'active');

    const viaOptions = await importExtension(
        `data:text/javascript,${encodeURIComponent('export const other = 1;')}`,
        { manifest: { id: ids.dependent, name: 'From options' } },
    );
    assert.equal(viaOptions.state, 'active');
});

test('imports can stop at load without activating', async () => {
    const result = await importExtension(
        `data:text/javascript,${encodeURIComponent(`export default { id: '${ids.plain}', name: 'Loaded only' };`)}`,
        { activate: false },
    );
    assert.equal(result.state, 'loaded');
    assert.equal(getExtensionState(ids.plain).state, 'loaded');
});

test('import failures are reported, never thrown', async () => {
    const broken = await importExtension('data:text/javascript,this is not javascript');
    assert.equal(broken.state, 'failed');
    assert.equal(broken.error.code, 'IMPORT_FAILED');

    const noManifest = await importExtension(`data:text/javascript,${encodeURIComponent('export const x = 1;')}`);
    assert.equal(noManifest.state, 'failed');
    assert.equal(noManifest.error.code, 'MANIFEST_MISSING');

    const invalidManifest = await importExtension(
        `data:text/javascript,${encodeURIComponent('export default { name: "No id" };')}`,
    );
    assert.equal(invalidManifest.state, 'failed');
    assert.equal(invalidManifest.error.code, 'MANIFEST_INVALID');

    const factoryThrows = await importExtension(
        `data:text/javascript,${encodeURIComponent('export default () => { throw new Error("factory boom"); };')}`,
    );
    assert.equal(factoryThrows.state, 'failed');
    assert.equal(factoryThrows.error.code, 'MANIFEST_FAILED');

    await assert.rejects(() => importExtension(''), /non-empty string/);
});
