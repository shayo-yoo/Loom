import test from 'node:test';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { emit, executeCapability, listCapabilities, listExtensions, subscribe, unregisterExtension } from '../Loom%20Core/index.js';
import './index.js';

const EXTENSION_ID = 'loom-host';
const observerId = 'host-observer';

afterEach(() => {
    delete globalThis.SillyTavern;
    unregisterExtension(observerId);
});

function stubHost(context) {
    globalThis.SillyTavern = { getContext: () => context };
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

test('registers the host adapter and its read-only capabilities', () => {
    assert.ok(listExtensions().some(extension => extension.id === EXTENSION_ID));
    assert.deepEqual(
        listCapabilities(EXTENSION_ID).map(capability => capability.id).sort(),
        ['characters.list', 'context.snapshot', 'viewport.get', 'worlds.list'],
    );
    const snapshot = listCapabilities(EXTENSION_ID).find(capability => capability.id === 'context.snapshot');
    assert.deepEqual(snapshot.input, { type: 'null' });
    assert.ok(snapshot.output.required.includes('characterName'));
});

test('reports a structured failure when the host context is unavailable', async () => {
    delete globalThis.SillyTavern;
    const result = await executeCapability(EXTENSION_ID, 'context.snapshot', null);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'EXECUTION_FAILED');
    assert.match(result.error.message, /host context is unavailable/i);
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
