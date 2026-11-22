import test from 'node:test';
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    addCleanup,
    checkInstall,
    checkPermission,
    computeContentHash,
    deleteState,
    emit,
    executeCapability,
    getRuntimeInfo,
    getState,
    getType,
    grantPermission,
    listCapabilities,
    listEvents,
    listExtensions,
    listIdentityConflicts,
    listIdentityGroups,
    listPermissionRequests,
    listPermissions,
    listStateKeys,
    listTypes,
    registerCapability,
    registerExtension,
    registerType,
    requestPermission,
    resolvePermissionRequest,
    revokePermission,
    setPermissionStore,
    setState,
    setStateStore,
    subscribe,
    unregisterExtension,
} from './index.js';

const extensionId = 'test-suite';
const eventsId = 'test-events';
const callerId = 'test-caller';
afterEach(() => {
    unregisterExtension(extensionId);
    unregisterExtension(eventsId);
    unregisterExtension(callerId);
    unregisterExtension('valid-but-bad-perm');
});

const requestSchema = {
    type: 'object',
    required: ['text'],
    properties: {
        text: { type: 'string', minLength: 1, maxLength: 20 },
        priority: { type: 'integer', minimum: 1, maximum: 5 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    },
    additionalProperties: false,
};

function setupExtension() {
    registerExtension({ id: extensionId, name: 'Test Suite' });
    registerCapability(extensionId, {
        id: 'echo',
        name: 'Echo',
        description: 'Returns its input.',
        input: requestSchema,
        output: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        execute: async input => input,
    });
}

test('capabilities can declare their error codes and compatibility metadata', () => {
    registerExtension({ id: extensionId, name: 'Test Suite' });
    const registered = registerCapability(extensionId, {
        id: 'declared',
        name: 'Declared errors',
        errors: [
            { code: 'PERMISSION_DENIED', description: 'caller lacks a grant' },
            { code: 'NOT_FOUND' },
        ],
        compatibility: { since: '0.34.0', deprecated: false, notes: 'stable' },
        execute: () => null,
    });

    assert.deepEqual(registered.errors, [
        { code: 'PERMISSION_DENIED', description: 'caller lacks a grant' },
        { code: 'NOT_FOUND', description: '' },
    ]);
    assert.deepEqual(registered.compatibility, { since: '0.34.0', deprecated: false, notes: 'stable' });

    const listed = listCapabilities(extensionId).find(capability => capability.id === 'declared');
    assert.deepEqual(listed.errors, registered.errors, 'the snapshot keeps the declarations');
    assert.deepEqual(listed.compatibility, registered.compatibility);

    registerCapability(extensionId, { id: 'defaults', name: 'Defaults', execute: () => null });
    const plain = listCapabilities(extensionId).find(capability => capability.id === 'defaults');
    assert.deepEqual(plain.errors, []);
    assert.equal(plain.compatibility, null);
});

test('capability metadata is validated', () => {
    registerExtension({ id: extensionId, name: 'Test Suite' });
    const cases = [
        { errors: 'nope' },
        { errors: [{ code: 'lowercase' }] },
        { errors: [null] },
        { compatibility: 'v1' },
        { compatibility: { unknown: true } },
        { compatibility: { deprecated: 'yes' } },
    ];
    for (const extra of cases) {
        assert.throws(
            () => registerCapability(extensionId, { id: 'bad', name: 'Bad', ...extra, execute: () => null }),
            TypeError,
            JSON.stringify(extra),
        );
    }
});

test('registers data types with stable identities and drops them with the extension', () => {
    registerExtension({ id: extensionId, name: 'Test Suite' });
    const type = registerType(extensionId, {
        id: 'note',
        name: 'Note',
        description: 'A short note',
        schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    });
    assert.deepEqual(type, {
        extensionId,
        id: 'note',
        name: 'Note',
        description: 'A short note',
        schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    });
    assert.deepEqual(getType(extensionId, 'note'), type);
    assert.equal(getType(extensionId, 'missing'), null);
    assert.equal(listTypes(extensionId).length, 1);
    assert.throws(() => registerType(extensionId, { id: 'note', name: 'Duplicate' }), /already registered/);
    assert.throws(() => registerType('not-registered', { id: 'x', name: 'X' }), /Register the extension/);
    assert.equal(getRuntimeInfo().typeCount >= 1, true);

    unregisterExtension(extensionId);
    assert.equal(listTypes(extensionId).length, 0, 'types are removed with their owner');
});

test('records where a registration came from', () => {
    registerExtension({ id: extensionId, name: 'Managed', origin: 'managed' });
    assert.equal(listExtensions().find(entry => entry.id === extensionId).origin, 'managed');
    unregisterExtension(extensionId);

    registerExtension({ id: extensionId, name: 'External', origin: 'external' });
    assert.equal(listExtensions().find(entry => entry.id === extensionId).origin, 'external');

    assert.throws(() => registerExtension({ id: 'bad-origin', name: 'X', origin: 'plugin' }), /origin must be one of/);
});

test('a signed numeric range is a valid schema', async () => {
    // Regression: `minimum`/`maximum` were validated with the length rules, which
    // rejected `{ minimum: -9999 }` and made any signed-delta capability unregisterable.
    registerExtension({ id: extensionId, name: 'Test Suite' });
    const registered = registerCapability(extensionId, {
        id: 'signed',
        name: 'Signed delta',
        input: {
            type: 'object',
            required: ['delta'],
            properties: { delta: { type: 'integer', minimum: -9999, maximum: 9999 } },
            additionalProperties: false,
        },
        execute: input => input,
    });
    assert.deepEqual(registered.input.properties.delta, { type: 'integer', minimum: -9999, maximum: 9999 });

    assert.deepEqual(await executeCapability(extensionId, 'signed', { delta: -5 }), { success: true, data: { delta: -5 } });
    const tooLow = await executeCapability(extensionId, 'signed', { delta: -10000 });
    assert.equal(tooLow.error.code, 'INVALID_INPUT');

    // Length bounds still require a non-negative integer.
    assert.throws(() => registerCapability(extensionId, {
        id: 'bad-length',
        name: 'Bad length',
        input: { type: 'string', minLength: -1 },
        execute: () => 'x',
    }), /non-negative integer/);
});

test('registers extensions and capabilities and executes a capability', async () => {
    setupExtension();

    assert.deepEqual(listExtensions().find(extension => extension.id === extensionId), {
        id: extensionId,
        name: 'Test Suite',
        version: '0.1.0',
        description: '',
        author: null,
        declaredId: extensionId,
        identityKey: `anonymous:${extensionId}`,
        contentHash: null,
        origin: 'direct',
    });
    assert.equal(listCapabilities(extensionId)[0].id, 'echo');
    assert.deepEqual(await executeCapability(extensionId, 'echo', { text: 'hello', priority: 2, tags: ['one'] }), {
        success: true,
        data: { text: 'hello', priority: 2, tags: ['one'] },
    });
    assert.throws(() => registerExtension({ id: extensionId, name: 'Duplicate' }), /already registered/);
});

test('rejects invalid registration data and unknown capability calls with structured results', async () => {
    assert.throws(() => registerExtension({ id: 'bad id', name: 'Invalid' }), /id must/);
    assert.throws(() => registerCapability('not-registered', {
        id: 'echo', name: 'Echo', execute: () => undefined,
    }), /Register the extension/);
    registerExtension({ id: extensionId, name: 'Test Suite' });
    assert.throws(() => registerCapability(extensionId, {
        id: 'bad-schema', name: 'Bad schema', input: { unknownKeyword: true }, execute: () => undefined,
    }), /unsupported schema keyword/);
    unregisterExtension(extensionId);

    setupExtension();
    assert.deepEqual(await executeCapability(extensionId, 'missing', null), {
        success: false,
        error: { code: 'CAPABILITY_NOT_FOUND', message: `Capability not found: ${extensionId}:missing` },
    });
});

test('capability schemas are copied and cannot be altered through descriptors', async () => {
    const inputSchema = { type: 'string', minLength: 3 };
    registerExtension({ id: extensionId, name: 'Test Suite' });
    registerCapability(extensionId, {
        id: 'schema-copy', name: 'Schema copy', input: inputSchema,
        execute: input => input,
    });
    inputSchema.minLength = 0;
    const exposedSchema = listCapabilities(extensionId)[0].input;
    exposedSchema.minLength = 0;

    assert.equal((await executeCapability(extensionId, 'schema-copy', 'a')).error.code, 'INVALID_INPUT');
    assert.deepEqual(await executeCapability(extensionId, 'schema-copy', 'valid'), { success: true, data: 'valid' });
});

test('validates nested input values before executing a capability', async () => {
    setupExtension();
    const invalidCalls = [
        null,
        {},
        { text: '' },
        { text: 'valid', priority: 0 },
        { text: 'valid', tags: [1] },
        { text: 'valid', extra: true },
    ];

    for (const input of invalidCalls) {
        const result = await executeCapability(extensionId, 'echo', input);
        assert.equal(result.success, false);
        assert.equal(result.error.code, 'INVALID_INPUT');
        assert.ok(result.error.details.length > 0);
    }
});

test('returns structured execution and output validation failures', async () => {
    setupExtension();
    registerCapability(extensionId, {
        id: 'broken', name: 'Broken', input: { type: 'null' },
        execute: () => { throw new Error('boom'); },
    });
    registerCapability(extensionId, {
        id: 'wrong-output', name: 'Wrong output', input: { type: 'null' },
        output: { type: 'string' }, execute: () => 123,
    });

    assert.deepEqual(await executeCapability(extensionId, 'broken', null), {
        success: false,
        error: { code: 'EXECUTION_FAILED', message: 'boom' },
    });
    assert.equal((await executeCapability(extensionId, 'wrong-output', null)).error.code, 'INVALID_OUTPUT');
});

test('computes a deterministic content hash independent of object key order', () => {
    const first = computeContentHash({ b: 2, a: [1, { d: 4, c: 3 }] });
    const second = computeContentHash({ a: [1, { c: 3, d: 4 }], b: 2 });
    assert.equal(first, second);
    assert.match(first, /^fnv1a64:[0-9a-f]{16}$/);
    assert.notEqual(first, computeContentHash({ a: 1 }));
    assert.equal(computeContentHash(undefined), null);
    assert.notEqual(computeContentHash('content-a'), computeContentHash('content-b'));
});

test('registers declared identity and content fingerprint', () => {
    registerExtension({
        id: extensionId,
        name: 'Identity Suite',
        author: 'acme',
        declaredId: 'widget',
        version: '2.0.0',
        content: { files: ['index.js'], version: '2.0.0' },
    });
    const extension = listExtensions().find(item => item.id === extensionId);
    assert.equal(extension.author, 'acme');
    assert.equal(extension.declaredId, 'widget');
    assert.equal(extension.identityKey, 'acme:widget');
    assert.match(extension.contentHash, /^fnv1a64:/);

    assert.throws(() => registerExtension({ id: 'other', name: 'Bad author', author: 'bad author' }), /author must/);
    assert.throws(() => registerExtension({ id: 'other', name: 'Bad declared', declaredId: 'bad declared' }), /Declared extension id must/);
    assert.throws(() => registerExtension({ id: 'other', name: 'Bad hash', contentHash: '' }), /contentHash must be a non-empty string/);
    assert.throws(() => registerExtension({
        id: 'other', name: 'Mismatch', content: 'alpha', contentHash: 'fnv1a64:0000000000000000',
    }), /does not match its content/);
});

test('checks installations as new, duplicate or conflict without registering', () => {
    const content = { files: ['index.js'] };
    registerExtension({ id: extensionId, name: 'Installed', author: 'acme', declaredId: 'widget', content });

    const base = { id: 'candidate', name: 'Candidate', author: 'acme', declaredId: 'widget' };
    const fresh = checkInstall({ ...base, declaredId: 'other-widget', content });
    assert.equal(fresh.status, 'new');
    assert.equal(fresh.matches.length, 0);
    assert.equal(checkInstall({ ...base, id: extensionId, content }).idTaken, true);

    const duplicate = checkInstall({ ...base, content });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.reason, null);
    assert.equal(duplicate.matches.length, 1);
    assert.equal(duplicate.matches[0].id, extensionId);

    const conflict = checkInstall({ ...base, content: { files: ['index.js', 'extra.js'] } });
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.reason, 'same-identity-different-content');

    const unverifiable = checkInstall({ ...base });
    assert.equal(unverifiable.status, 'conflict');
    assert.equal(unverifiable.reason, 'content-hash-missing');

    assert.equal(listExtensions().length, 1, 'checkInstall must not register the candidate');
});

test('groups registered identities and reports duplicates and conflicts', () => {
    registerExtension({ id: 'dup-one', name: 'Dup One', author: 'acme', declaredId: 'widget', content: 'same' });
    registerExtension({ id: 'dup-two', name: 'Dup Two', author: 'acme', declaredId: 'widget', content: 'same' });
    registerExtension({ id: 'conflict-one', name: 'Conflict One', author: 'acme', declaredId: 'gadget', content: 'a' });
    registerExtension({ id: 'conflict-two', name: 'Conflict Two', author: 'acme', declaredId: 'gadget', content: 'b' });
    registerExtension({ id: 'solo', name: 'Solo', author: 'other', declaredId: 'widget', content: 'x' });

    try {
        const groups = listIdentityGroups();
        assert.deepEqual(groups.map(group => [group.identityKey, group.status, group.members.length]), [
            ['acme:gadget', 'conflict', 2],
            ['acme:widget', 'duplicate', 2],
            ['other:widget', 'single', 1],
        ]);
        assert.deepEqual(listIdentityConflicts().map(group => group.identityKey), ['acme:gadget']);
    } finally {
        for (const id of ['dup-one', 'dup-two', 'conflict-one', 'conflict-two', 'solo']) unregisterExtension(id);
    }
});

test('unregistering an extension removes it from identity groups', () => {
    registerExtension({ id: extensionId, name: 'Installed', author: 'acme', declaredId: 'widget', content: 'v1' });
    assert.equal(listIdentityGroups().some(group => group.identityKey === 'acme:widget'), true);
    unregisterExtension(extensionId);
    assert.equal(listIdentityGroups().some(group => group.identityKey === 'acme:widget'), false);
});

test('unregistering an extension removes its capabilities and reports cleanup errors', () => {
    setupExtension();
    assert.deepEqual(unregisterExtension(extensionId), { removed: true, cleanupErrors: [] });
    assert.equal(listCapabilities(extensionId).length, 0);
    assert.equal(listExtensions().some(extension => extension.id === extensionId), false);
    assert.equal(getRuntimeInfo().capabilityCount, 0);
    assert.match(getRuntimeInfo().version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(unregisterExtension(extensionId), { removed: false, cleanupErrors: [] });
});

test('delivers events in subscription order and supports one-shot listeners', async () => {
    registerExtension({ id: eventsId, name: 'Events' });
    const received = [];
    const unsubscribeFirst = subscribe(eventsId, 'demo:event', payload => received.push(['first', payload]));
    subscribe(eventsId, 'demo:event', payload => received.push(['once', payload]), { once: true });
    subscribe(eventsId, 'demo:event', payload => received.push(['last', payload]));

    assert.deepEqual(await emit('demo:event', { value: 1 }), { delivered: 3, errors: [] });
    assert.deepEqual(await emit('demo:event', { value: 2 }), { delivered: 2, errors: [] });
    assert.deepEqual(received, [
        ['first', { value: 1 }],
        ['once', { value: 1 }],
        ['last', { value: 1 }],
        ['first', { value: 2 }],
        ['last', { value: 2 }],
    ]);

    assert.equal(unsubscribeFirst(), true);
    assert.equal(unsubscribeFirst(), false);
    assert.deepEqual(await emit('demo:event', { value: 3 }), { delivered: 1, errors: [] });
    assert.deepEqual(listEvents().find(event => event.name === 'demo:event'), { name: 'demo:event', count: 1 });
});

test('isolates listener failures and reports them without stopping delivery', async () => {
    registerExtension({ id: eventsId, name: 'Events' });
    const received = [];
    subscribe(eventsId, 'demo:failure', () => { throw new Error('sync boom'); });
    subscribe(eventsId, 'demo:failure', async () => { throw new Error('async boom'); });
    subscribe(eventsId, 'demo:failure', () => received.push('after'));

    const result = await emit('demo:failure', null);
    assert.deepEqual(received, ['after']);
    assert.equal(result.delivered, 3);
    assert.deepEqual(result.errors, [
        { extensionId: eventsId, message: 'sync boom' },
        { extensionId: eventsId, message: 'async boom' },
    ]);
});

test('validates event subscription arguments', async () => {
    registerExtension({ id: eventsId, name: 'Events' });
    assert.throws(() => subscribe('not-registered', 'demo:event', () => {}), /Register the extension/);
    assert.throws(() => subscribe(eventsId, 'bad event', () => {}), /Event name/);
    assert.throws(() => subscribe(eventsId, 'demo:event', 'not-a-function'), /handler must be a function/);
    assert.throws(() => addCleanup('not-registered', () => {}), /Register the extension/);
    assert.throws(() => addCleanup(eventsId, 'not-a-function'), /Cleanup must be a function/);
    await assert.rejects(emit('bad event', null), /Event name/);
});

test('stores state per extension and validates ownership', () => {
    registerExtension({ id: eventsId, name: 'Events' });
    registerExtension({ id: 'other-extension', name: 'Other' });
    try {
        assert.equal(getState(eventsId, 'missing'), undefined);
        assert.equal(setState(eventsId, 'counter', 1), 1);
        setState(eventsId, 'label', 'alpha');
        setState('other-extension', 'counter', 99);

        assert.equal(getState(eventsId, 'counter'), 1);
        assert.equal(getState('other-extension', 'counter'), 99);
        assert.deepEqual(listStateKeys(eventsId), ['counter', 'label']);
        assert.equal(getRuntimeInfo().stateKeyCount, 3);

        assert.equal(deleteState(eventsId, 'counter'), true);
        assert.equal(deleteState(eventsId, 'counter'), false);
        assert.throws(() => getState('not-registered', 'key'), /Register the extension/);
        assert.throws(() => setState(eventsId, '   ', 1), /non-empty string/);
    } finally {
        unregisterExtension('other-extension');
    }
});

test('unregistering an extension drops its state', () => {
    registerExtension({ id: eventsId, name: 'Events' });
    setState(eventsId, 'key', 'value');
    assert.equal(getRuntimeInfo().stateKeyCount, 1);
    assert.deepEqual(unregisterExtension(eventsId), { removed: true, cleanupErrors: [] });
    assert.equal(getRuntimeInfo().stateKeyCount, 0);
    assert.throws(() => getState(eventsId, 'key'), /Register the extension/);
});

test('unregistering an extension removes its listeners and runs cleanups', async () => {
    registerExtension({ id: eventsId, name: 'Events' });
    const received = [];
    subscribe(eventsId, 'demo:cleanup', () => received.push('called'));
    const removeCleanup = addCleanup(eventsId, () => received.push('removed-cleanup'));
    addCleanup(eventsId, () => received.push('cleanup'));
    addCleanup(eventsId, () => { throw new Error('cleanup boom'); });

    assert.deepEqual(await emit('demo:cleanup', null), { delivered: 1, errors: [] });
    assert.equal(removeCleanup(), true);

    const result = unregisterExtension(eventsId);
    assert.equal(result.removed, true);
    assert.deepEqual(result.cleanupErrors, [{ message: 'cleanup boom' }]);
    assert.deepEqual(await emit('demo:cleanup', null), { delivered: 0, errors: [] });
    assert.deepEqual(received, ['called', 'cleanup']);
    assert.equal(getRuntimeInfo().listenerCount, 0);
});

function setupPermissionedCapability() {
    registerExtension({ id: extensionId, name: 'Permissioned Provider' });
    registerExtension({ id: callerId, name: 'Permissioned Caller' });
    registerCapability(extensionId, {
        id: 'guarded',
        name: 'Guarded',
        permissions: ['demo.read', 'demo.read', 'demo.write'],
        input: { type: 'null' },
        output: { type: 'object', required: ['caller'], properties: { caller: { type: 'string' } } },
        execute: (input, context) => ({ caller: context.caller }),
    });
    registerCapability(extensionId, {
        id: 'open',
        name: 'Open',
        input: { type: 'null' },
        execute: () => 'public',
    });
}

test('normalizes declared capability permissions and exposes them in descriptors', () => {
    setupPermissionedCapability();
    const guarded = listCapabilities(extensionId).find(capability => capability.id === 'guarded');
    assert.deepEqual(guarded.permissions, ['demo.read', 'demo.write'], 'duplicates collapse, order preserved');
    const open = listCapabilities(extensionId).find(capability => capability.id === 'open');
    assert.deepEqual(open.permissions, []);
});

test('rejects malformed permission declarations at registration time', () => {
    registerExtension({ id: extensionId, name: 'Permissioned Provider' });
    assert.throws(() => registerCapability(extensionId, {
        id: 'bad-type', name: 'Bad', permissions: 'demo.read', execute: () => undefined,
    }), /permissions must be an array/);
    assert.throws(() => registerCapability(extensionId, {
        id: 'bad-name', name: 'Bad', permissions: ['bad permission'], execute: () => undefined,
    }), /Permission must contain/);
});

test('enforces declared permissions in Core before the handler runs', async () => {
    setupPermissionedCapability();
    let executed = 0;
    registerCapability(extensionId, {
        id: 'counted',
        name: 'Counted',
        permissions: ['demo.write'],
        input: { type: 'null' },
        execute: () => { executed += 1; return null; },
    });

    const denied = await executeCapability(extensionId, 'counted', null, { caller: callerId });
    assert.equal(denied.success, false);
    assert.equal(denied.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(denied.error.details.missing, ['demo.write']);
    assert.equal(executed, 0, 'the handler must not run without the grant');

    grantPermission(callerId, 'demo.write');
    assert.deepEqual(await executeCapability(extensionId, 'counted', null, { caller: callerId }), { success: true, data: null });
    assert.equal(executed, 1);

    // Permissions are all-or-nothing: holding one of two is still a denial.
    grantPermission(callerId, 'demo.read');
    revokePermission(callerId, 'demo.write');
    const partial = await executeCapability(extensionId, 'guarded', null, { caller: callerId });
    assert.equal(partial.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(partial.error.details.missing, ['demo.write']);
});

test('permission checks apply to self-calls too', async () => {
    setupPermissionedCapability();
    const selfCall = await executeCapability(extensionId, 'guarded', null);
    assert.equal(selfCall.error.code, 'PERMISSION_DENIED');
    assert.equal(selfCall.error.details.caller, extensionId);

    grantPermission(extensionId, 'demo.read');
    grantPermission(extensionId, 'demo.write');
    assert.deepEqual(await executeCapability(extensionId, 'guarded', null), {
        success: true,
        data: { caller: extensionId },
    });
});

test('capabilities without declared permissions need no grant', async () => {
    setupPermissionedCapability();
    assert.deepEqual(await executeCapability(extensionId, 'open', null, { caller: callerId }), {
        success: true,
        data: 'public',
    });
});

test('passes caller context and a permission probe to the handler', async () => {
    registerExtension({ id: extensionId, name: 'Provider' });
    registerExtension({ id: callerId, name: 'Caller' });
    let seen = null;
    registerCapability(extensionId, {
        id: 'inspect',
        name: 'Inspect',
        input: { type: 'null' },
        execute: (input, context) => {
            seen = {
                caller: context.caller,
                target: context.target,
                capabilityId: context.capabilityId,
                permissions: context.capabilityPermissions,
                has: context.hasPermission('demo.write'),
            };
            return null;
        },
    });

    await executeCapability(extensionId, 'inspect', null, { caller: callerId });
    assert.deepEqual(seen, {
        caller: callerId,
        target: extensionId,
        capabilityId: 'inspect',
        permissions: [],
        has: false,
    });

    grantPermission(callerId, 'demo.write');
    await executeCapability(extensionId, 'inspect', null, { caller: callerId });
    assert.equal(seen.has, true, 'the probe must reflect the caller, not the owner');
});

test('rejects calls from unregistered callers', async () => {
    setupPermissionedCapability();
    const result = await executeCapability(extensionId, 'open', null, { caller: 'ghost-extension' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'CALLER_NOT_FOUND');
    assert.equal(
        (await executeCapability(extensionId, 'open', null, { caller: 'bad caller' })).error.code,
        'INVALID_ID',
    );
});

test('grants, revokes and lists permissions per extension', () => {
    registerExtension({ id: extensionId, name: 'Provider' });
    registerExtension({ id: callerId, name: 'Caller' });

    assert.deepEqual(listPermissions(callerId), []);
    assert.equal(checkPermission(callerId, 'demo.write'), false);
    assert.equal(grantPermission(callerId, 'demo.write'), true);
    grantPermission(callerId, 'demo.read');
    assert.equal(checkPermission(callerId, 'demo.write'), true);
    assert.deepEqual(listPermissions(callerId), ['demo.read', 'demo.write']);
    assert.equal(getRuntimeInfo().grantedPermissionCount, 2);

    assert.equal(revokePermission(callerId, 'demo.write'), true);
    assert.equal(revokePermission(callerId, 'demo.write'), false);
    assert.equal(checkPermission(callerId, 'demo.write'), false);

    assert.deepEqual(listPermissions().find(entry => entry.extensionId === callerId), {
        extensionId: callerId,
        permissions: ['demo.read'],
    });
    assert.throws(() => grantPermission('not-registered', 'demo.read'), /Register the extension/);
    assert.throws(() => grantPermission(callerId, 'bad permission'), /Permission must contain/);
    assert.throws(() => listPermissions('not-registered'), /Register the extension/);
});

test('declaring a permission on a capability does not grant it', async () => {
    setupPermissionedCapability();
    assert.deepEqual(listPermissions(extensionId), [], 'registration must not self-grant');
    assert.equal(checkPermission(extensionId, 'demo.read'), false);
});

test('unregistering an extension drops its grants', () => {
    registerExtension({ id: callerId, name: 'Caller' });
    grantPermission(callerId, 'demo.write');
    assert.equal(getRuntimeInfo().grantedPermissionCount, 1);
    assert.deepEqual(unregisterExtension(callerId), { removed: true, cleanupErrors: [] });
    assert.equal(getRuntimeInfo().grantedPermissionCount, 0);
    assert.equal(checkPermission(callerId, 'demo.write'), false);
});

function memoryStateStore(initial = {}) {
    const data = new Map(Object.entries(initial).map(([id, snapshot]) => [id, structuredClone(snapshot)]));
    const calls = { saves: [], removes: [] };
    return {
        data,
        calls,
        load: id => (data.has(id) ? structuredClone(data.get(id)) : null),
        save: (id, snapshot) => {
            data.set(id, structuredClone(snapshot));
            calls.saves.push(id);
        },
        remove: id => {
            data.delete(id);
            calls.removes.push(id);
        },
    };
}

test('restores persisted state when the extension registers', () => {
    const store = memoryStateStore({ [eventsId]: { counter: 7, label: 'restored' } });
    setStateStore(store);
    try {
        assert.equal(getRuntimeInfo().stateStoreAttached, true);
        registerExtension({ id: eventsId, name: 'Events' });
        assert.equal(getState(eventsId, 'counter'), 7);
        assert.equal(getState(eventsId, 'label'), 'restored');
        assert.deepEqual(listStateKeys(eventsId), ['counter', 'label']);
    } finally {
        setStateStore(null);
    }
});

test('restores state for extensions that registered before the store attached', () => {
    registerExtension({ id: eventsId, name: 'Events' });
    setState(eventsId, 'live', 'kept');
    const store = memoryStateStore({ [eventsId]: { persisted: 1, live: 'stale' } });
    setStateStore(store);
    try {
        assert.equal(getState(eventsId, 'persisted'), 1, 'persisted keys are restored');
        assert.equal(getState(eventsId, 'live'), 'kept', 'a live value is never clobbered by the snapshot');
    } finally {
        setStateStore(null);
    }
});

test('persists state on set and delete, and removes it on unregister', () => {
    registerExtension({ id: eventsId, name: 'Events' });
    const store = memoryStateStore();
    setStateStore(store);
    try {
        setState(eventsId, 'counter', 1);
        assert.deepEqual(store.data.get(eventsId), { counter: 1 });

        setState(eventsId, 'label', 'alpha');
        assert.deepEqual(store.data.get(eventsId), { counter: 1, label: 'alpha' });

        assert.equal(deleteState(eventsId, 'counter'), true);
        assert.deepEqual(store.data.get(eventsId), { label: 'alpha' });

        // Removing the last key drops the namespace instead of storing an empty one.
        deleteState(eventsId, 'label');
        assert.equal(store.data.has(eventsId), false);
        assert.equal(store.calls.removes.includes(eventsId), true);

        setState(eventsId, 'again', true);
        unregisterExtension(eventsId);
        assert.equal(store.data.has(eventsId), false, 'unregister removes the persisted namespace');
    } finally {
        setStateStore(null);
    }
});

test('state snapshots skip values that cannot be cloned', () => {
    registerExtension({ id: eventsId, name: 'Events' });
    const store = memoryStateStore();
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    setStateStore(store);
    try {
        setState(eventsId, 'fn', () => {});
        setState(eventsId, 'ok', 42);
        assert.deepEqual(store.data.get(eventsId), { ok: 42 }, 'the cloneable value is still persisted');
        assert.equal(getState(eventsId, 'fn') instanceof Function, true, 'the live value stays usable in memory');
        assert.equal(warnings.some(message => message.includes('not cloneable')), true);
    } finally {
        setStateStore(null);
        console.warn = originalWarn;
    }
});

test('rejects a malformed state store and isolates its failures', () => {
    assert.throws(() => setStateStore({ load: () => null }), /must provide load\(extensionId\)/);
    assert.throws(() => setStateStore('store'), /must provide load\(extensionId\)/);

    registerExtension({ id: eventsId, name: 'Events' });
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    setStateStore({
        load: () => { throw new Error('load boom'); },
        save: () => { throw new Error('save boom'); },
        remove: () => { throw new Error('remove boom'); },
    });
    try {
        assert.equal(setState(eventsId, 'key', 'value'), 'value');
        assert.equal(getState(eventsId, 'key'), 'value', 'in-memory state survives a broken store');
        assert.equal(warnings.some(message => message.includes('save boom')), true);
        unregisterExtension(eventsId);
        assert.equal(warnings.some(message => message.includes('remove boom')), true);
    } finally {
        setStateStore(null);
        console.warn = originalWarn;
    }
});

test('detaching the state store keeps the in-memory state', () => {
    registerExtension({ id: eventsId, name: 'Events' });
    setStateStore(memoryStateStore());
    setState(eventsId, 'key', 1);
    setStateStore(null);
    assert.equal(getRuntimeInfo().stateStoreAttached, false);
    assert.equal(getState(eventsId, 'key'), 1);
});

test('treats an omitted input argument as null, not as a schema violation', async () => {
    registerExtension({ id: extensionId, name: 'Null Input Provider' });
    registerCapability(extensionId, {
        id: 'null-input',
        name: 'Null input',
        input: { type: 'null' },
        output: { type: 'string' },
        execute: input => (input === null ? 'received-null' : `received-${typeof input}`),
    });

    assert.deepEqual(await executeCapability(extensionId, 'null-input'), {
        success: true,
        data: 'received-null',
    });
    assert.deepEqual(await executeCapability(extensionId, 'null-input', null), {
        success: true,
        data: 'received-null',
    });
});

test('typed capability errors keep their code in the failure envelope', async () => {
    registerExtension({ id: extensionId, name: 'Provider' });
    registerCapability(extensionId, {
        id: 'typed',
        name: 'Typed',
        input: { type: 'null' },
        execute: () => {
            const error = new Error('denied by handler');
            error.code = 'HANDLER_DENIED';
            error.details = { reason: 'demo' };
            throw error;
        },
    });

    assert.deepEqual(await executeCapability(extensionId, 'typed', null), {
        success: false,
        error: { code: 'HANDLER_DENIED', message: 'denied by handler', details: { reason: 'demo' } },
    });
});

function memoryStore(initial = []) {
    const state = { grants: structuredClone(initial), saves: [] };
    return {
        state,
        load: () => structuredClone(state.grants),
        save: grants => {
            state.grants = structuredClone(grants);
            state.saves.push(structuredClone(grants));
        },
    };
}

test('rejects a malformed permission store', () => {
    assert.throws(() => setPermissionStore({ load: () => [] }), /must provide load\(\) and save/);
    assert.throws(() => setPermissionStore('store'), /must provide load\(\) and save/);
    assert.equal(setPermissionStore(null), true);
    assert.equal(getRuntimeInfo().permissionStoreAttached, false);
});

test('restores persisted grants for registered and later-registered extensions', () => {
    registerExtension({ id: extensionId, name: 'Provider' });
    const store = memoryStore([
        { extensionId, permissions: ['demo.read'] },
        { extensionId: callerId, permissions: ['demo.write'] },
        { extensionId: 'not yet registered', permissions: ['demo.write'] },
        { extensionId: 'valid-but-bad-perm', permissions: ['bad perm'] },
        { extensionId: 'bad-shape', permissions: 'demo.write' },
        null,
    ]);

    setPermissionStore(store);
    try {
        assert.equal(getRuntimeInfo().permissionStoreAttached, true);
        assert.equal(checkPermission(extensionId, 'demo.read'), true, 'registered extensions restore immediately');

        registerExtension({ id: callerId, name: 'Caller' });
        assert.equal(checkPermission(callerId, 'demo.write'), true, 'pending grants apply on registration');

        registerExtension({ id: 'valid-but-bad-perm', name: 'Bad permission' });
        assert.deepEqual(listPermissions('valid-but-bad-perm'), [], 'invalid permission names are dropped');
    } finally {
        setPermissionStore(null);
    }
});

test('persists the grant table on grant, revoke and unregister', () => {
    registerExtension({ id: callerId, name: 'Caller' });
    const store = memoryStore();
    setPermissionStore(store);
    try {
        grantPermission(callerId, 'demo.write');
        assert.deepEqual(store.state.grants, [{ extensionId: callerId, permissions: ['demo.write'] }]);

        revokePermission(callerId, 'demo.write');
        assert.deepEqual(store.state.grants, []);

        grantPermission(callerId, 'demo.read');
        unregisterExtension(callerId);
        assert.deepEqual(store.state.grants, [], 'unregistering an extension persists its removal');
        assert.equal(store.state.saves.length, 4);
    } finally {
        setPermissionStore(null);
    }
});

test('requests a permission and resolves it after approval', () => {
    registerExtension({ id: callerId, name: 'Caller' });

    const result = requestPermission(callerId, 'host.settings.write', { reason: 'needs to save' });
    assert.equal(result.status, 'pending');
    assert.match(result.requestId, /^perm-\d+$/);
    assert.equal(checkPermission(callerId, 'host.settings.write'), false, 'requesting must not grant');

    assert.deepEqual(listPermissionRequests().map(request => ({
        extensionId: request.extensionId,
        permission: request.permission,
        reason: request.reason,
    })), [{ extensionId: callerId, permission: 'host.settings.write', reason: 'needs to save' }]);
    assert.equal(getRuntimeInfo().permissionRequestCount, 1);

    const resolved = resolvePermissionRequest(result.requestId, { approved: true });
    assert.deepEqual(resolved, {
        requestId: result.requestId,
        status: 'granted',
        extensionId: callerId,
        permission: 'host.settings.write',
    });
    assert.equal(checkPermission(callerId, 'host.settings.write'), true);
    assert.deepEqual(listPermissionRequests(), []);
    assert.equal(getRuntimeInfo().permissionRequestCount, 0);
});

test('emits request and resolution events with the request payload', async () => {
    registerExtension({ id: callerId, name: 'Caller' });
    const events = [];
    subscribe(callerId, 'core:permission:requested', payload => events.push(['requested', payload]));
    subscribe(callerId, 'core:permission:resolved', payload => events.push(['resolved', payload]));

    const { requestId } = requestPermission(callerId, 'host.chat.read', { reason: 'read chat' });
    await new Promise(resolve => setTimeout(resolve, 0));
    resolvePermissionRequest(requestId, { approved: false });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(events.length, 2);
    assert.deepEqual(events[0][1].request.permission, 'host.chat.read');
    assert.deepEqual(events[1][1], {
        requestId,
        extensionId: callerId,
        permission: 'host.chat.read',
        status: 'denied',
    });
    assert.equal(checkPermission(callerId, 'host.chat.read'), false, 'a denied request must not grant');
});

test('de-duplicates open requests and short-circuits already-granted permissions', () => {
    registerExtension({ id: callerId, name: 'Caller' });

    const first = requestPermission(callerId, 'host.settings.write', { reason: 'first reason' });
    const second = requestPermission(callerId, 'host.settings.write', { reason: 'second reason' });
    assert.equal(second.requestId, first.requestId, 'a repeated request reuses the open prompt');
    assert.equal(listPermissionRequests().length, 1);
    assert.equal(listPermissionRequests()[0].reason, 'first reason');

    grantPermission(callerId, 'host.settings.write');
    assert.deepEqual(requestPermission(callerId, 'host.settings.write'), {
        requestId: null,
        status: 'granted',
        extensionId: callerId,
        permission: 'host.settings.write',
    });
    assert.equal(listPermissionRequests().length, 1, 'an already-open request stays open');
});

test('answering a stale request id is reported, not thrown', () => {
    assert.deepEqual(resolvePermissionRequest('perm-does-not-exist', { approved: true }), {
        requestId: 'perm-does-not-exist',
        status: 'unknown',
    });
    assert.throws(() => resolvePermissionRequest(''), /non-empty string/);
    assert.throws(() => resolvePermissionRequest(42), /non-empty string/);
});

test('validates permission requests and drops prompts when the extension goes away', () => {
    registerExtension({ id: callerId, name: 'Caller' });
    assert.throws(() => requestPermission('not-registered', 'host.chat.read'), /Register the extension/);
    assert.throws(() => requestPermission(callerId, 'bad permission'), /Permission must contain/);

    const { requestId } = requestPermission(callerId, 'host.chat.read');
    assert.equal(listPermissionRequests().length, 1);

    unregisterExtension(callerId);
    assert.deepEqual(listPermissionRequests(), [], 'unregistering drops the open prompt');
    assert.equal(resolvePermissionRequest(requestId, { approved: true }).status, 'unknown');
});

test('approving after the extension unregistered cannot grant', () => {
    registerExtension({ id: callerId, name: 'Caller' });
    registerExtension({ id: extensionId, name: 'Other' });
    const { requestId } = requestPermission(callerId, 'host.chat.read');

    // Simulate a race: the request is still open when the extension disappears.
    unregisterExtension(callerId);
    registerExtension({ id: callerId, name: 'Caller' });
    assert.equal(resolvePermissionRequest(requestId, { approved: true }).status, 'unknown');
    assert.equal(checkPermission(callerId, 'host.chat.read'), false);
});

test('a failing store never breaks the in-memory grant table', () => {    registerExtension({ id: callerId, name: 'Caller' });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    setPermissionStore({
        load: () => { throw new Error('load boom'); },
        save: () => { throw new Error('save boom'); },
    });
    try {
        assert.equal(grantPermission(callerId, 'demo.write'), true);
        assert.equal(checkPermission(callerId, 'demo.write'), true);
        assert.equal(warnings.some(message => message.includes('load boom')), true);
        assert.equal(warnings.some(message => message.includes('save boom')), true);
    } finally {
        setPermissionStore(null);
        console.warn = originalWarn;
    }
});
