import '../Loom%20Core/index.js';

const EXTENSION_ID = 'loom-host';
const HOST_VERSION = '0.4.0';
const runtime = globalThis.Loom;

const nullInput = { type: 'null' };

/**
 * Host event bridge allowlist: SillyTavern event key -> Loom event name.
 * Only event names are forwarded, never raw host payloads.
 */
const HOST_EVENT_BRIDGE = Object.freeze([
    ['CHAT_CHANGED', 'host:chat:changed'],
    ['MESSAGE_SENT', 'host:message:sent'],
    ['MESSAGE_RECEIVED', 'host:message:received'],
    ['CHARACTER_EDITED', 'host:character:edited'],
    ['WORLDINFO_UPDATED', 'host:worldinfo:updated'],
    ['GENERATION_STARTED', 'host:generation:started'],
    ['GENERATION_ENDED', 'host:generation:ended'],
]);

let bridge = null;

function isRegistered() {
    return Boolean(runtime?.listExtensions?.().some(extension => extension.id === EXTENSION_ID));
}

/**
 * Attach the SillyTavern event listeners once, when the host is available.
 * Registration is idempotent and is undone by the extension cleanup hook.
 */
function ensureBridge() {
    if (bridge || !isRegistered()) return;
    const context = globalThis.SillyTavern?.getContext?.();
    const eventSource = context?.eventSource;
    if (typeof eventSource?.on !== 'function' || typeof eventSource?.removeListener !== 'function') return;

    const hostEvents = context.eventTypes ?? {};
    const attached = new Map();
    try {
        for (const [hostKey, loomEvent] of HOST_EVENT_BRIDGE) {
            const hostEventName = hostEvents[hostKey];
            if (typeof hostEventName !== 'string') continue;
            const handler = () => {
                void runtime.emit(loomEvent, { source: 'sillytavern', event: hostKey });
            };
            eventSource.on(hostEventName, handler);
            attached.set(hostEventName, handler);
        }
    } catch (error) {
        for (const [hostEventName, handler] of attached) eventSource.removeListener(hostEventName, handler);
        throw error;
    }

    bridge = { eventSource, attached };
    runtime.addCleanup(EXTENSION_ID, () => {
        for (const [hostEventName, handler] of attached) eventSource.removeListener(hostEventName, handler);
        bridge = null;
    });
}

function tryEnsureBridge() {
    try {
        ensureBridge();
    } catch (error) {
        console.error('[Loom Host] Failed to attach host event bridge:', error);
    }
}

function getHostContext() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context || typeof context !== 'object') {
        throw new Error('SillyTavern host context is unavailable.');
    }
    return context;
}

function getChatId(context) {
    try {
        if (typeof context.getCurrentChatId === 'function') {
            return context.getCurrentChatId() ?? null;
        }
    } catch {
        // Fall through to the context-provided chat id.
    }
    return context.chatId ?? null;
}

function toCount(value) {
    return Array.isArray(value) ? value.length : 0;
}

function getWorldNames(context) {
    if (typeof context.getWorldInfoNames === 'function') {
        const names = context.getWorldInfoNames();
        return Array.isArray(names) ? names.map(String) : [];
    }
    return [];
}

const snapshotCapability = {
    id: 'context.snapshot',
    name: '宿主快照',
    description: '读取当前角色、聊天和基础环境的只读快照。',
    input: nullInput,
    output: {
        type: 'object',
        required: ['chatId', 'hasChat', 'characterName', 'messageCount', 'characterCount', 'worldCount'],
        properties: {
            chatId: { type: ['string', 'null'] },
            hasChat: { type: 'boolean' },
            characterName: { type: 'string' },
            messageCount: { type: 'integer', minimum: 0 },
            characterCount: { type: 'integer', minimum: 0 },
            worldCount: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
    },
    execute: () => {
        tryEnsureBridge();
        const context = getHostContext();
        const chatId = getChatId(context);
        return {
            chatId,
            hasChat: Boolean(chatId),
            characterName: String(context.name2 ?? ''),
            messageCount: toCount(context.chat),
            characterCount: toCount(context.characters),
            worldCount: getWorldNames(context).length,
        };
    },
};

const charactersCapability = {
    id: 'characters.list',
    name: '角色列表',
    description: '读取 SillyTavern 角色名称与头像文件名的只读列表。',
    input: nullInput,
    output: {
        type: 'array',
        items: {
            type: 'object',
            required: ['name', 'avatar'],
            properties: {
                name: { type: 'string' },
                avatar: { type: 'string' },
            },
            additionalProperties: false,
        },
    },
    execute: () => {
        tryEnsureBridge();
        const characters = getHostContext().characters;
        if (!Array.isArray(characters)) return [];
        return characters.map(character => ({
            name: String(character?.name ?? ''),
            avatar: String(character?.avatar ?? ''),
        }));
    },
};

const worldsCapability = {
    id: 'worlds.list',
    name: '世界书列表',
    description: '读取 SillyTavern 当前用户可用的世界书名称。',
    input: nullInput,
    output: { type: 'array', items: { type: 'string' } },
    execute: () => {
        tryEnsureBridge();
        return getWorldNames(getHostContext());
    },
};

const viewportCapability = {
    id: 'viewport.get',
    name: '视口信息',
    description: '读取宿主窗口尺寸与移动端判定，供界面系统做响应式布局。',
    input: nullInput,
    output: {
        type: 'object',
        required: ['width', 'height', 'pixelRatio', 'isMobile'],
        properties: {
            width: { type: 'integer', minimum: 0 },
            height: { type: 'integer', minimum: 0 },
            pixelRatio: { type: 'number' },
            isMobile: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    execute: () => {
        const width = Number(globalThis.innerWidth ?? 0) || 0;
        const height = Number(globalThis.innerHeight ?? 0) || 0;
        const ratio = Number(globalThis.devicePixelRatio ?? 1);
        const media = typeof globalThis.matchMedia === 'function'
            ? globalThis.matchMedia('(max-width: 768px)')
            : null;
        const isMobile = media ? Boolean(media.matches) : width > 0 && width <= 768;
        return {
            width: Math.max(0, Math.trunc(width)),
            height: Math.max(0, Math.trunc(height)),
            pixelRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
            isMobile,
        };
    },
};

function install() {
    if (!runtime?.registerExtension) {
        throw new Error('Loom runtime is unavailable.');
    }
    if (runtime.listExtensions().some(extension => extension.id === EXTENSION_ID)) {
        return;
    }

    runtime.registerExtension({
        id: EXTENSION_ID,
        name: 'Loom Host Adapter',
        author: 'loom',
        declaredId: 'host',
        version: HOST_VERSION,
        description: 'SillyTavern 只读宿主适配器。',
        content: `loom-host@${HOST_VERSION}:context.snapshot,characters.list,worlds.list,event-bridge`,
    });

    for (const capability of [snapshotCapability, charactersCapability, worldsCapability, viewportCapability]) {
        runtime.registerCapability(EXTENSION_ID, capability);
    }

    tryEnsureBridge();
    globalThis.jQuery?.(() => tryEnsureBridge());
}

install();