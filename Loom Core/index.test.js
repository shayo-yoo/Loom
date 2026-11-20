import test from 'node:test';
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    addCleanup,
    checkInstall,
    computeContentHash,
    deleteState,
    emit,
    executeCapability,
    getRuntimeInfo,
    getState,
    listCapabilities,
    listEvents,
    listExtensions,
    listIdentityConflicts,
    listIdentityGroups,
    listStateKeys,
    registerCapability,
    registerExtension,
    setState,
    subscribe,
    unregisterExtension,
} from './index.js';

const extensionId = 'test-suite';
const eventsId = 'test-events';
afterEach(() => {
    unregisterExtension(extensionId);
    unregisterExtension(eventsId);
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
