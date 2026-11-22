import '../Loom%20Core/index.js';

const EXTENSION_ID = 'loom-host';
const HOST_VERSION = '0.32.1';
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

/**
 * Whole-book lifecycle.
 *
 * These are the only capabilities that can create or destroy a user's world book,
 * so they are deliberately harder to reach than entry writes:
 * - a separate permission (`host.worldinfo.manage`), so granting "edit an entry"
 *   never implies "delete a book";
 * - removal requires the caller to echo the book name in `confirm`, which turns a
 *   wiring mistake (wrong variable, undefined name) into a typed error instead of
 *   a deletion;
 * - SillyTavern exposes no context function for either operation, so the adapter
 *   calls its own `/api/worldinfo` endpoints through the shared request headers.
 *   That is a deliberate, documented exception to "use getContext() only".
 */
const WORLDS_MANAGE_SCOPE = 'host.worldinfo.manage';

async function postWorldRequest(context, path, body) {
    if (typeof globalThis.fetch !== 'function') {
        throw typedError('HOST_UNSUPPORTED', 'This environment has no fetch() for world-book management.');
    }
    const headers = { 'Content-Type': 'application/json', ...(context.getRequestHeaders?.() ?? {}) };
    let response;
    try {
        response = await globalThis.fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (error) {
        throw typedError('HOST_UNSUPPORTED', `World-book request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response || response.ok === false) {
        throw typedError('HOST_UNSUPPORTED', `SillyTavern rejected ${path} (status ${response?.status ?? 'unknown'}).`);
    }
    return response;
}

/**
 * Persist a whole book through the host's own writer when it exists.
 *
 * `saveWorldInfo` updates SillyTavern's in-memory world cache as well as the file;
 * posting to `/api/worldinfo/edit` directly would leave the cache holding the old
 * content, so a book deleted and recreated under the same name would still read
 * back its previous entries. The endpoint stays only as a fallback for builds
 * without `saveWorldInfo`.
 */
async function writeWorldBook(context, name, data) {
    if (typeof context.saveWorldInfo === 'function') {
        await context.saveWorldInfo(name, data, true);
        return;
    }
    await postWorldRequest(context, '/api/worldinfo/edit', { name, data });
}

const worldsCreateCapability = {
    id: 'worlds.create',
    name: '新建世界书',
    description: '新建一本空世界书；需要 host.worldinfo.manage 授权。同名世界书已存在时会拒绝。',
    permissions: [WORLDS_MANAGE_SCOPE],
    input: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 128 } },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['name', 'created'],
        properties: { name: { type: 'string' }, created: { type: 'boolean' } },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof context.loadWorldInfo !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose world-book loading.');
        }
        if (getWorldNames(context).includes(input.name)) {
            throw typedError('WORLD_EXISTS', `World book already exists: ${input.name}`);
        }

        await writeWorldBook(context, input.name, { entries: {} });
        await context.updateWorldInfoList?.();

        if (!getWorldNames(context).includes(input.name)) {
            throw typedError('WORLD_CREATE_FAILED', `The host did not register the new world book: ${input.name}`);
        }
        return { name: input.name, created: true };
    },
};

const worldsRemoveCapability = {
    id: 'worlds.remove',
    name: '删除世界书',
    description: '删除整本世界书（破坏性）；需要 host.worldinfo.manage 授权，且必须在 confirm 中原样回写书名。',
    permissions: [WORLDS_MANAGE_SCOPE],
    input: {
        type: 'object',
        required: ['name', 'confirm'],
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            confirm: { type: 'string', minLength: 1, maxLength: 128 },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['name', 'removed'],
        properties: { name: { type: 'string' }, removed: { type: 'boolean' } },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (input.confirm !== input.name) {
            throw typedError('CONFIRMATION_REQUIRED', 'Deleting a world book requires confirm to repeat its name exactly.', {
                name: input.name,
            });
        }
        if (!getWorldNames(context).includes(input.name)) {
            throw typedError('WORLD_NOT_FOUND', `World book not found: ${input.name}`);
        }

        await postWorldRequest(context, '/api/worldinfo/delete', { name: input.name });
        await context.updateWorldInfoList?.();

        if (getWorldNames(context).includes(input.name)) {
            throw typedError('WORLD_REMOVE_FAILED', `The host still lists the world book after deletion: ${input.name}`);
        }
        return { name: input.name, removed: true };
    },
};

const WORLD_DATA_MAX_ENTRIES = 5000;
const WORLD_DATA_MAX_BYTES = 5_000_000;
const WORLD_ENTRY_RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Validate a world-book payload handed in by a caller. Import restores data that
 * came out of `worlds.export`, so fidelity matters, but a malformed or hostile
 * payload must be rejected before it reaches the host's file.
 */
function assertWorldBookData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw typedError('INVALID_INPUT', 'World book data must be an object.');
    }
    const entries = data.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        throw typedError('INVALID_INPUT', 'World book data requires an "entries" object.');
    }
    const keys = Object.keys(entries);
    if (keys.length > WORLD_DATA_MAX_ENTRIES) {
        throw typedError('INVALID_INPUT', `World book data exceeds ${WORLD_DATA_MAX_ENTRIES} entries.`);
    }
    for (const key of keys) {
        if (WORLD_ENTRY_RESERVED_KEYS.has(key)) {
            throw typedError('INVALID_INPUT', `World entry uid "${key}" is reserved.`);
        }
        const entry = entries[key];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw typedError('INVALID_INPUT', `World entry "${key}" must be an object.`);
        }
    }
    let json;
    try {
        json = JSON.stringify(data);
    } catch (error) {
        throw typedError('INVALID_INPUT', `World book data is not serializable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof json !== 'string') throw typedError('INVALID_INPUT', 'World book data is not serializable.');
    if (json.length > WORLD_DATA_MAX_BYTES) {
        throw typedError('INVALID_INPUT', `World book data exceeds ${WORLD_DATA_MAX_BYTES} bytes.`);
    }
    return JSON.parse(json);
}

const worldsExportCapability = {
    id: 'worlds.export',
    name: '导出世界书',
    description: '导出整本世界书的原始数据（含宿主字段），只读；输出与宿主缓存相互隔离。',
    input: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 128 } },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['name', 'entries', 'data'],
        properties: {
            name: { type: 'string' },
            entries: { type: 'integer', minimum: 0 },
            data: { type: 'object' },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof context.loadWorldInfo !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose world-book loading.');
        }
        if (!getWorldNames(context).includes(input.name)) {
            throw typedError('WORLD_NOT_FOUND', `World book not found: ${input.name}`);
        }

        const data = await context.loadWorldInfo(input.name);
        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
            throw typedError('WORLD_NOT_FOUND', `World book has no readable entries: ${input.name}`);
        }
        // Hand back a detached copy: the host caches this object, so returning it
        // directly would let a caller mutate live host state.
        let detached;
        try {
            detached = structuredClone(data);
        } catch {
            detached = JSON.parse(JSON.stringify(data));
        }
        return { name: input.name, entries: Object.keys(data.entries).length, data: detached };
    },
};

const worldsImportCapability = {
    id: 'worlds.import',
    name: '导入世界书',
    description: '用导出的数据新建一本世界书（不会覆盖同名书）；需要 host.worldinfo.manage 授权。',
    permissions: [WORLDS_MANAGE_SCOPE],
    input: {
        type: 'object',
        required: ['name', 'data'],
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            data: { type: 'object' },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['name', 'entries', 'created'],
        properties: {
            name: { type: 'string' },
            entries: { type: 'integer', minimum: 0 },
            created: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof context.loadWorldInfo !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose world-book loading.');
        }
        if (getWorldNames(context).includes(input.name)) {
            throw typedError('WORLD_EXISTS', `World book already exists: ${input.name}`);
        }

        const payload = assertWorldBookData(input.data);
        const entries = Object.keys(payload.entries).length;

        await writeWorldBook(context, input.name, payload);
        await context.updateWorldInfoList?.();

        if (!getWorldNames(context).includes(input.name)) {
            throw typedError('WORLD_CREATE_FAILED', `The host did not register the imported world book: ${input.name}`);
        }
        return { name: input.name, entries, created: true };
    },
};

/**
 * Rename is copy-then-delete plus reference migration.
 *
 * SillyTavern's own rename flow also retargets character lore links, which means
 * rewriting character card files — not something the adapter can do. So the
 * capability refuses (`WORLD_IN_USE`) when a character card points at the book,
 * instead of renaming and silently unbinding it. References it *can* migrate are
 * migrated explicitly: the current chat's `world_info` binding, the persona
 * lorebook, and the global activation selection.
 */
/**
 * Cards that reference a world book, split by whether the reference is movable.
 *
 * `extensions.world` is a link: it can be rewritten through the host's merge
 * endpoint (this is what SillyTavern's own rename does). A card's embedded
 * `character_book.name` is a copy inside the card, not a link — renaming the
 * world book does not rename it, so such a card still blocks the rename.
 */
function characterReferences(context, worldName) {
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const bound = [];
    const embedded = [];
    for (const character of characters) {
        const card = character?.data;
        const boundWorld = card?.extensions?.world ?? character?.world ?? null;
        const bookName = card?.character_book?.name ?? null;
        const name = String(character?.name ?? character?.avatar ?? 'unknown');
        if (boundWorld === worldName) bound.push({ name, avatar: String(character?.avatar ?? '') });
        else if (bookName === worldName) embedded.push(name);
    }
    return { bound, embedded };
}

function isWorldGloballySelected(worldName) {
    const select = globalThis.document?.querySelector?.('#world_info');
    if (!select) return false;
    return [...(select.options ?? [])].some(option => option.selected && option.value === worldName);
}

const worldsRenameCapability = {
    id: 'worlds.rename',
    name: '重命名世界书',
    description: '重命名世界书并迁移聊天绑定、persona 绑定与全局选中；角色卡绑定时拒绝；需要 host.worldinfo.manage 授权。',
    permissions: [WORLDS_MANAGE_SCOPE],
    input: {
        type: 'object',
        required: ['name', 'to', 'confirm'],
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 128 },
            to: { type: 'string', minLength: 1, maxLength: 128 },
            confirm: { type: 'string', minLength: 1, maxLength: 128 },
            migrateCards: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['from', 'to', 'migrated'],
        properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            migrated: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
    },
    execute: async (input, contextInfo) => {
        const context = getHostContext();
        if (typeof context.loadWorldInfo !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose world-book loading.');
        }
        const from = input.name;
        const to = input.to;
        if (input.confirm !== from) {
            throw typedError('CONFIRMATION_REQUIRED', 'Renaming a world book requires confirm to repeat the current name exactly.', { name: from });
        }
        if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
            throw typedError('INVALID_INPUT', 'The new name must differ from the current name.');
        }
        const names = getWorldNames(context);
        if (!names.includes(from)) {
            throw typedError('WORLD_NOT_FOUND', `World book not found: ${from}`);
        }
        if (names.includes(to)) {
            throw typedError('WORLD_EXISTS', `World book already exists: ${to}`);
        }

        // Everything that could block the rename is checked before any write.
        const references = characterReferences(context, from);
        // An embedded world book is a copy inside the card, not a link: renaming
        // the world book cannot move it, so it always blocks.
        if (references.embedded.length > 0) {
            throw typedError('WORLD_IN_USE', 'A character card embeds a world book with this name; renaming the book would not rename the embedded copy.', {
                embeddedBooks: references.embedded,
            });
        }
        const migrateCards = input.migrateCards === true;
        if (references.bound.length > 0) {
            if (!migrateCards) {
                throw typedError('WORLD_IN_USE', 'A character card is bound to this world book; pass migrateCards: true to rewrite those links.', {
                    characters: references.bound.map(character => character.name),
                    hint: 'migrateCards',
                });
            }
            // Rewriting cards is a card write, not a world-book write: it needs its
            // own grant even though the rename itself is already authorised.
            if (contextInfo?.hasPermission?.('host.characters.write') !== true) {
                throw typedError('PERMISSION_DENIED', 'Migrating character-card links requires host.characters.write.', {
                    missing: ['host.characters.write'],
                });
            }
        }
        // A globally activated book cannot be retargeted reliably: the host rebuilds
        // its activation dropdown without guaranteeing the renamed entry exists, so
        // the safe choice is to refuse and let the user deactivate first.
        if (isWorldGloballySelected(from)) {
            throw typedError('WORLD_IN_USE', 'The world book is activated globally; deactivate it in SillyTavern before renaming.', {
                selection: true,
            });
        }

        const data = await context.loadWorldInfo(from);
        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
            throw typedError('WORLD_NOT_FOUND', `World book has no readable entries: ${from}`);
        }

        const migrated = [];

        // Copy first: the old book survives until the new one is registered.
        await writeWorldBook(context, to, structuredClone(data));
        await context.updateWorldInfoList?.();
        if (!getWorldNames(context).includes(to)) {
            throw typedError('WORLD_CREATE_FAILED', `The host did not register the renamed world book: ${to}`);
        }

        // Deletion is deliberately the last write: card links and chat bindings
        // must be moved while the old book still exists, so a failure leaves every
        // reference resolving to the old name.

        const metadata = context.chatMetadata;
        if (metadata && typeof metadata === 'object' && metadata.world_info === from) {
            metadata.world_info = to;
            context.saveMetadataDebounced?.() ?? context.saveMetadata?.();
            migrated.push('chat');
        }
        const persona = context.powerUserSettings;
        if (persona && typeof persona === 'object' && persona.persona_description_lorebook === from) {
            persona.persona_description_lorebook = to;
            context.saveSettingsDebounced?.();
            migrated.push('persona');
        }
        // Card links are rewritten before the old book is deleted: a failure
        // leaves the old book in place, so every card still resolves.
        if (migrateCards && references.bound.length > 0) {
            if (typeof globalThis.fetch !== 'function') {
                throw typedError('HOST_UNSUPPORTED', 'This environment has no fetch() for card-link migration.');
            }
            const failed = [];
            for (const character of references.bound) {
                try {
                    const response = await globalThis.fetch('/api/characters/merge-attributes', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(context.getRequestHeaders?.() ?? {}) },
                        body: JSON.stringify({ avatar: character.avatar, data: { extensions: { world: to } } }),
                    });
                    if (!response || response.ok === false) {
                        throw new Error(`status ${response?.status ?? 'unknown'}`);
                    }
                    await context.getOneCharacter?.(character.avatar);
                } catch (error) {
                    failed.push({
                        avatar: character.avatar,
                        name: character.name,
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            if (failed.length > 0) {
                throw typedError('CARD_LINK_MIGRATION_FAILED', 'Some character cards could not be re-pointed; the old world book was kept.', {
                    failed,
                    migrated: [...migrated],
                });
            }
            migrated.push('cards');
        }

        await postWorldRequest(context, '/api/worldinfo/delete', { name: from });
        await context.updateWorldInfoList?.();
        if (getWorldNames(context).includes(from)) {
            throw typedError('WORLD_REMOVE_FAILED', `The host still lists the old world book: ${from}`);
        }
        return { from, to, migrated };
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

const MESSAGE_TEXT_LIMIT = 2000;
const ENTRY_TEXT_LIMIT = 2000;

function truncate(text, limit) {
    const value = typeof text === 'string' ? text : String(text ?? '');
    if (value.length <= limit) return { text: value, truncated: false };
    return { text: value.slice(0, limit), truncated: true };
}

function toChatMessage(message, index) {
    const { text, truncated } = truncate(message?.mes, MESSAGE_TEXT_LIMIT);
    return {
        index,
        name: String(message?.name ?? ''),
        isUser: Boolean(message?.is_user),
        isSystem: Boolean(message?.is_system),
        text,
        truncated,
    };
}

/**
 * Chat content is the user's private conversation, so it is the one read
 * capability gated behind a grant. Library assets (world books, character
 * cards) stay ungated: SillyTavern already shows them in its own UI.
 */
const chatMessagesCapability = {
    id: 'chat.messages',
    name: '聊天消息',
    description: '读取当前聊天最近的消息文本（只读，需要 host.chat.read 授权）。',
    permissions: ['host.chat.read'],
    input: {
        type: ['object', 'null'],
        properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
    },
    output: {
        type: 'array',
        items: {
            type: 'object',
            required: ['index', 'name', 'isUser', 'isSystem', 'text', 'truncated'],
            properties: {
                index: { type: 'integer', minimum: 0 },
                name: { type: 'string' },
                isUser: { type: 'boolean' },
                isSystem: { type: 'boolean' },
                text: { type: 'string' },
                truncated: { type: 'boolean' },
            },
            additionalProperties: false,
        },
    },
    execute: (input) => {
        tryEnsureBridge();
        const options = input ?? {};
        const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
        const offset = Math.max(options.offset ?? 0, 0);
        const messages = getHostContext().chat;
        if (!Array.isArray(messages)) return [];

        // offset counts backwards from the newest message; the result is still
        // returned oldest-first so callers can render it in reading order.
        const end = Math.max(0, messages.length - offset);
        const start = Math.max(0, end - limit);
        return messages.slice(start, end).map((message, position) => toChatMessage(message, start + position));
    },
};

const worldsEntriesCapability = {
    id: 'worlds.entries',
    name: '世界书条目',
    description: '分页读取指定世界书的条目（只读），可按子串搜索备注/关键词/内容。',
    input: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
            query: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['name', 'total', 'offset', 'limit', 'hasMore', 'entries'],
        properties: {
            name: { type: 'string' },
            total: { type: 'integer', minimum: 0 },
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 0 },
            hasMore: { type: 'boolean' },
            entries: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['uid', 'comment', 'keys', 'secondaryKeys', 'content', 'enabled', 'constant', 'selective', 'order', 'truncated'],
                    properties: {
                        uid: { type: 'string' },
                        comment: { type: 'string' },
                        keys: { type: 'array', items: { type: 'string' } },
                        secondaryKeys: { type: 'array', items: { type: 'string' } },
                        content: { type: 'string' },
                        enabled: { type: 'boolean' },
                        constant: { type: 'boolean' },
                        selective: { type: 'boolean' },
                        order: { type: 'integer' },
                        truncated: { type: 'boolean' },
                    },
                    additionalProperties: false,
                },
            },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof context.loadWorldInfo !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose loadWorldInfo().');
        }
        const data = await context.loadWorldInfo(input.name);
        const entries = data?.entries;
        const limit = Math.min(Math.max(input.limit ?? 200, 1), 200);
        const offset = Math.max(input.offset ?? 0, 0);
        const empty = { name: input.name, total: 0, offset, limit, hasMore: false, entries: [] };
        if (!entries || typeof entries !== 'object') return empty;

        const mapped = Object.entries(entries).map(([key, entry]) => {
            const { text, truncated } = truncate(entry?.content, ENTRY_TEXT_LIMIT);
            return {
                uid: String(entry?.uid ?? key),
                comment: String(entry?.comment ?? ''),
                keys: Array.isArray(entry?.key) ? entry.key.map(String) : [],
                secondaryKeys: Array.isArray(entry?.keysecondary) ? entry.keysecondary.map(String) : [],
                content: text,
                enabled: !entry?.disable,
                constant: Boolean(entry?.constant),
                selective: Boolean(entry?.selective),
                order: Number.isFinite(entry?.order) ? Math.trunc(entry.order) : 0,
                truncated,
            };
        }).sort((left, right) => left.order - right.order || left.uid.localeCompare(right.uid));

        // Search runs over the mapped fields (comment, keys, visible content), so a
        // query behaves the same as what the caller can see.
        const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
        const matched = query === ''
            ? mapped
            : mapped.filter(entry => [entry.comment, ...entry.keys, ...entry.secondaryKeys, entry.content]
                .some(value => value.toLowerCase().includes(query)));
        const page = matched.slice(offset, offset + limit);
        return {
            name: input.name,
            total: matched.length,
            offset,
            limit,
            hasMore: offset + page.length < matched.length,
            entries: page,
        };
    },
};

/**
 * World-entry write contract (entry-level patch):
 * - the caller patches fields, never supplies a whole book;
 * - the adapter re-reads, applies the patch and writes immediately, so a
 *   resolved success means SillyTavern accepted the write (no debounce loss);
 * - last write wins: there are no version tokens yet, so a concurrent editor
 *   can overwrite a field the caller did not patch;
 * - unknown patch fields are rejected by the schema instead of silently ignored;
 * - `enabled` maps onto SillyTavern's inverted `disable` flag.
 */
const WORLDS_ENTRY_UPDATE_FIELDS = Object.freeze({
    content: { write: (entry, value) => { entry.content = value; } },
    comment: { write: (entry, value) => { entry.comment = value; } },
    keys: { write: (entry, value) => { entry.key = [...value]; } },
    secondaryKeys: { write: (entry, value) => { entry.keysecondary = [...value]; } },
    enabled: { write: (entry, value) => { entry.disable = !value; } },
    constant: { write: (entry, value) => { entry.constant = value; } },
    selective: { write: (entry, value) => { entry.selective = value; } },
    order: { write: (entry, value) => { entry.order = value; } },
});

const worldsEntryUpdateCapability = {
    id: 'worlds.entry.update',
    name: '更新世界书条目',
    description: '按条目 uid 更新世界书条目字段（读改写，立即保存）；需要 host.worldinfo.write 授权。',
    permissions: ['host.worldinfo.write'],
    input: {
        type: 'object',
        required: ['name', 'uid', 'patch'],
        properties: {
            name: { type: 'string', minLength: 1 },
            uid: { type: 'string', minLength: 1 },
            patch: {
                type: 'object',
                required: [],
                properties: {
                    content: { type: 'string' },
                    comment: { type: 'string' },
                    keys: { type: 'array', items: { type: 'string' } },
                    secondaryKeys: { type: 'array', items: { type: 'string' } },
                    enabled: { type: 'boolean' },
                    constant: { type: 'boolean' },
                    selective: { type: 'boolean' },
                    order: { type: 'integer' },
                },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['name', 'uid', 'updated'],
        properties: {
            name: { type: 'string' },
            uid: { type: 'string' },
            updated: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof context.loadWorldInfo !== 'function' || typeof context.saveWorldInfo !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose loadWorldInfo()/saveWorldInfo().');
        }

        const updated = Object.keys(input.patch ?? {});
        if (updated.length === 0) return { name: input.name, uid: input.uid, updated: [] };

        const data = await context.loadWorldInfo(input.name);
        const entries = data?.entries;
        // SillyTavern answers a missing book with no entries at all; treat that
        // as "world not found" rather than "entry not found" so the caller can
        // tell a typo in the world name from a typo in the uid.
        if (!entries || typeof entries !== 'object' || Object.keys(entries).length === 0) {
            throw typedError('WORLD_NOT_FOUND', `World book not found or empty: ${input.name}`);
        }

        const match = Object.entries(entries).find(([key, entry]) => String(entry?.uid ?? key) === input.uid);
        if (!match) {
            throw typedError('ENTRY_NOT_FOUND', `World entry not found: ${input.uid}`);
        }

        const [key, entry] = match;
        for (const field of updated) {
            WORLDS_ENTRY_UPDATE_FIELDS[field].write(entry, input.patch[field]);
        }

        // `immediately` bypasses the host's debounce so success means persisted.
        await context.saveWorldInfo(input.name, data, true);
        return { name: input.name, uid: String(entry.uid ?? key), updated: updated.sort() };
    },
};

/**
 * Default field values for a newly created world entry.
 *
 * Mirrors SillyTavern 1.19.0 `newWorldInfoEntryTemplate` (fields excluded from
 * that template are excluded here too). This is deliberate duplication: the
 * adapter does not import SillyTavern internals, so the table must be revisited
 * when the host changes its entry model. Values that ST derives at runtime
 * (DEFAULT_DEPTH = 4, DEFAULT_WEIGHT = 100, selectiveLogic AND_ANY = 0) are
 * inlined with that note.
 */
const WORLD_ENTRY_DEFAULTS = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
});

const WORLD_UID_LIMIT = 1_000_000;

/**
 * Allocate the first free integer uid, mirroring SillyTavern's
 * `getFreeWorldEntryUid` (first free slot from 0), which is what the host's own
 * "new entry" button does. Both the object key and the entry's `uid` field are
 * checked, because imported books are not guaranteed to keep them in sync.
 */
function allocateWorldUid(entries) {
    const used = new Set();
    for (const [key, entry] of Object.entries(entries)) {
        if (/^\d+$/.test(key)) used.add(Number(key));
        const entryUid = Number(entry?.uid);
        if (Number.isInteger(entryUid) && entryUid >= 0) used.add(entryUid);
    }
    for (let uid = 0; uid < WORLD_UID_LIMIT; uid += 1) {
        if (!used.has(uid)) return uid;
    }
    return null;
}

const worldsEntryCreateCapability = {
    id: 'worlds.entry.create',
    name: '新建世界书条目',
    description: '在已有世界书中新建条目（自动分配未被占用的 uid，立即保存）；需要 host.worldinfo.write 授权。',
    permissions: ['host.worldinfo.write'],
    input: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', minLength: 1 },
            entry: {
                type: 'object',
                properties: {
                    content: { type: 'string' },
                    comment: { type: 'string' },
                    keys: { type: 'array', items: { type: 'string' } },
                    secondaryKeys: { type: 'array', items: { type: 'string' } },
                    enabled: { type: 'boolean' },
                    constant: { type: 'boolean' },
                    selective: { type: 'boolean' },
                    order: { type: 'integer' },
                },
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['name', 'uid', 'created'],
        properties: {
            name: { type: 'string' },
            uid: { type: 'integer', minimum: 0 },
            created: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof context.loadWorldInfo !== 'function' || typeof context.saveWorldInfo !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose loadWorldInfo()/saveWorldInfo().');
        }

        // Membership in the host's list is the only reliable way to tell "book
        // exists but is empty" from "typo in the name": saving into an unknown
        // name would silently create a new book file.
        if (!getWorldNames(context).includes(input.name)) {
            throw typedError('WORLD_NOT_FOUND', `World book not found: ${input.name}`);
        }

        const data = await context.loadWorldInfo(input.name);
        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
            throw typedError('WORLD_NOT_FOUND', `World book not found: ${input.name}`);
        }

        const uid = allocateWorldUid(data.entries);
        if (uid === null) {
            throw typedError('UID_EXHAUSTED', `No free uid in world book: ${input.name}`);
        }

        const patch = input.entry ?? {};
        const entry = { uid, ...structuredClone(WORLD_ENTRY_DEFAULTS) };
        for (const field of Object.keys(patch)) {
            WORLDS_ENTRY_UPDATE_FIELDS[field].write(entry, patch[field]);
        }
        data.entries[uid] = entry;
        await context.saveWorldInfo(input.name, data, true);
        return { name: input.name, uid, created: Object.keys(patch).sort() };
    },
};

const worldsEntryRemoveCapability = {
    id: 'worlds.entry.remove',
    name: '删除世界书条目',
    description: '按 uid 删除世界书条目（立即保存）；需要 host.worldinfo.write 授权。',
    permissions: ['host.worldinfo.write'],
    input: {
        type: 'object',
        required: ['name', 'uid'],
        properties: {
            name: { type: 'string', minLength: 1 },
            uid: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['name', 'uid', 'removed'],
        properties: {
            name: { type: 'string' },
            uid: { type: 'string' },
            removed: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof context.loadWorldInfo !== 'function' || typeof context.saveWorldInfo !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose loadWorldInfo()/saveWorldInfo().');
        }

        const data = await context.loadWorldInfo(input.name);
        const entries = data?.entries;
        if (!entries || typeof entries !== 'object' || Object.keys(entries).length === 0) {
            throw typedError('WORLD_NOT_FOUND', `World book not found or empty: ${input.name}`);
        }

        const match = Object.entries(entries).find(([key, entry]) => String(entry?.uid ?? key) === input.uid);
        if (!match) {
            throw typedError('ENTRY_NOT_FOUND', `World entry not found: ${input.uid}`);
        }

        delete entries[match[0]];
        await context.saveWorldInfo(input.name, data, true);
        return { name: input.name, uid: input.uid, removed: true };
    },
};

const characterCardCapability = {
    id: 'characters.get',
    name: '角色卡详情',
    description: '按角色名或头像文件名读取角色卡字段（只读）；未找到时返回 null。',
    input: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } },
        additionalProperties: false,
    },
    output: {
        type: ['object', 'null'],
        required: ['name', 'avatar', 'description', 'personality', 'scenario', 'firstMessage', 'exampleMessages', 'creatorNotes', 'tags'],
        properties: {
            name: { type: 'string' },
            avatar: { type: 'string' },
            description: { type: 'string' },
            personality: { type: 'string' },
            scenario: { type: 'string' },
            firstMessage: { type: 'string' },
            exampleMessages: { type: 'string' },
            creatorNotes: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
    },
    execute: (input) => {
        tryEnsureBridge();
        const characters = getHostContext().characters;
        if (!Array.isArray(characters)) return null;
        const wanted = input.name.trim().toLowerCase();
        const character = characters.find(item => (
            String(item?.name ?? '').toLowerCase() === wanted
            || String(item?.avatar ?? '').toLowerCase() === wanted
        ));
        if (!character) return null;
        return {
            name: String(character.name ?? ''),
            avatar: String(character.avatar ?? ''),
            description: String(character.description ?? ''),
            personality: String(character.personality ?? ''),
            scenario: String(character.scenario ?? ''),
            firstMessage: String(character.first_mes ?? ''),
            exampleMessages: String(character.mes_example ?? ''),
            creatorNotes: String(character.creator_notes ?? ''),
            tags: Array.isArray(character.tags) ? character.tags.map(String) : [],
        };
    },
};

const CHARACTERS_WRITE_SCOPE = 'host.characters.write';
const CHARACTERS_MANAGE_SCOPE = 'host.characters.manage';
const CHARACTER_FIELD_LIMIT = 100_000;
const CHARACTER_TAG_LIMIT = 50;

/**
 * Caller-facing field names → SillyTavern card keys.
 *
 * The list is a whitelist on purpose: `merge-attributes` deep-merges whatever it
 * is given into the card, so an unvetted field could rewrite `avatar`, the
 * `extensions` block or the embedded `character_book`. Renaming a card and
 * editing its image are separate operations that Loom does not offer.
 */
const CHARACTER_PATCH_FIELDS = Object.freeze({
    description: 'description',
    personality: 'personality',
    scenario: 'scenario',
    firstMessage: 'first_mes',
    exampleMessages: 'mes_example',
    creatorNotes: 'creator_notes',
    systemPrompt: 'system_prompt',
    postHistoryInstructions: 'post_history_instructions',
});

const characterPatchProperties = Object.freeze({
    description: { type: 'string', maxLength: CHARACTER_FIELD_LIMIT },
    personality: { type: 'string', maxLength: CHARACTER_FIELD_LIMIT },
    scenario: { type: 'string', maxLength: CHARACTER_FIELD_LIMIT },
    firstMessage: { type: 'string', maxLength: CHARACTER_FIELD_LIMIT },
    exampleMessages: { type: 'string', maxLength: CHARACTER_FIELD_LIMIT },
    creatorNotes: { type: 'string', maxLength: CHARACTER_FIELD_LIMIT },
    systemPrompt: { type: 'string', maxLength: CHARACTER_FIELD_LIMIT },
    postHistoryInstructions: { type: 'string', maxLength: CHARACTER_FIELD_LIMIT },
    tags: {
        type: 'array',
        maxItems: CHARACTER_TAG_LIMIT,
        items: { type: 'string', minLength: 1, maxLength: 100 },
    },
});

function findCharacter(context, name) {
    const characters = context.characters;
    if (!Array.isArray(characters)) return null;
    const wanted = String(name).trim().toLowerCase();
    return characters.find(item => (
        String(item?.name ?? '').toLowerCase() === wanted
        || String(item?.avatar ?? '').toLowerCase() === wanted
    )) ?? null;
}

/**
 * Write character-card fields.
 *
 * The card lives inside the PNG's `chara` chunk; SillyTavern's
 * `/api/characters/merge-attributes` is the only writing path it offers (a deep
 * merge that validates the result against the TavernCard V2 spec and refuses to
 * write an invalid card), so the adapter uses it and then refreshes the host's
 * in-memory copy with `getOneCharacter`. Without that refresh the UI would keep
 * showing the old text while the file already changed.
 */
const charactersUpdateCapability = {
    id: 'characters.update',
    name: '更新角色卡',
    description: '按角色名或头像文件名更新角色卡文本字段与标签（写入 PNG，需要 host.characters.write 授权）。',
    permissions: [CHARACTERS_WRITE_SCOPE],
    input: {
        type: 'object',
        required: ['name', 'patch'],
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            patch: {
                type: 'object',
                required: [],
                properties: characterPatchProperties,
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['avatar', 'name', 'updated', 'refreshed'],
        properties: {
            avatar: { type: 'string' },
            name: { type: 'string' },
            updated: { type: 'array', items: { type: 'string' } },
            refreshed: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        const character = findCharacter(context, input.name);
        if (!character) {
            throw typedError('CHARACTER_NOT_FOUND', `Character not found: ${input.name}`);
        }
        const avatar = String(character.avatar ?? '');
        if (!avatar) {
            throw typedError('CHARACTER_NOT_FOUND', `Character has no avatar file: ${input.name}`);
        }

        const patch = input.patch ?? {};
        const updated = Object.keys(patch);
        if (updated.length === 0) {
            throw typedError('INVALID_INPUT', 'Character patch must contain at least one field.');
        }
        if (typeof globalThis.fetch !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This environment has no fetch() for character writes.');
        }

        const data = {};
        for (const field of updated) {
            if (field === 'tags') data.tags = [...patch.tags];
            else data[CHARACTER_PATCH_FIELDS[field]] = patch[field];
        }

        const headers = { 'Content-Type': 'application/json', ...(context.getRequestHeaders?.() ?? {}) };
        let response;
        try {
            response = await globalThis.fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers,
                body: JSON.stringify({ avatar, data }),
            });
        } catch (error) {
            throw typedError('HOST_UNSUPPORTED', `Character write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response || response.ok === false) {
            // The host refuses to write a card that fails V2 validation; the file is
            // untouched, so this is a rejection rather than a partial write.
            throw typedError('CHARACTER_WRITE_FAILED', `SillyTavern rejected the character write (status ${response?.status ?? 'unknown'}).`, {
                avatar,
            });
        }

        let refreshed = false;
        if (typeof context.getOneCharacter === 'function') {
            try {
                await context.getOneCharacter(avatar);
                refreshed = true;
            } catch {
                refreshed = false;
            }
        }
        return { avatar, name: String(character.name ?? ''), updated: updated.sort(), refreshed };
    },
};

/**
 * Card lifecycle.
 *
 * Creating and destroying a character card are the only operations that change the
 * user's library itself, so they sit behind their own permission
 * (`host.characters.manage`) and deletion requires the caller to echo the avatar
 * filename, turning a stale variable into a typed error instead of a lost card.
 *
 * SillyTavern exposes no `getContext()` function for either operation, so the
 * adapter uses its own `/api/characters/{create,delete}` endpoints — the same
 * documented exception the world-book lifecycle uses.
 */
function assertCharacterName(name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw typedError('INVALID_INPUT', 'Character name must be a non-empty string.');
    }
    if (name.length > 80) {
        throw typedError('INVALID_INPUT', 'Character name is longer than 80 characters.');
    }
    if (/[\\/:*?"<>|\u0000]/.test(name)) {
        throw typedError('INVALID_INPUT', 'Character name must not contain path or filename characters.', {
            characters: '\\ / : * ? " < > |',
        });
    }
}

function findCharacterIndex(context, identity) {
    const characters = context.characters;
    if (!Array.isArray(characters)) return -1;
    const wanted = String(identity).trim().toLowerCase();
    return characters.findIndex(item => (
        String(item?.name ?? '').toLowerCase() === wanted
        || String(item?.avatar ?? '').toLowerCase() === wanted
    ));
}

const charactersCreateCapability = {
    id: 'characters.create',
    name: '创建角色卡',
    description: '新建一张角色卡（可选初始字段）；需要 host.characters.manage 授权。同名角色已存在时拒绝。',
    permissions: [CHARACTERS_MANAGE_SCOPE],
    input: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            fields: {
                type: 'object',
                required: [],
                properties: characterPatchProperties,
                additionalProperties: false,
            },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['avatar', 'name', 'created'],
        properties: {
            avatar: { type: 'string' },
            name: { type: 'string' },
            created: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof globalThis.fetch !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This environment has no fetch() for character creation.');
        }
        assertCharacterName(input.name);
        const existing = findCharacter(context, input.name);
        if (existing) {
            throw typedError('CHARACTER_EXISTS', `A character with that name already exists: ${input.name}`, {
                avatar: String(existing.avatar ?? ''),
            });
        }

        const body = { ch_name: input.name };
        for (const [field, value] of Object.entries(input.fields ?? {})) {
            // `tags` is the one field that is not a plain text→host-key mapping.
            if (field === 'tags') body.tags = [...value];
            else body[CHARACTER_PATCH_FIELDS[field]] = value;
        }

        const headers = { 'Content-Type': 'application/json', ...(context.getRequestHeaders?.() ?? {}) };
        let response;
        try {
            response = await globalThis.fetch('/api/characters/create', {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (error) {
            throw typedError('CHARACTER_CREATE_FAILED', `Character creation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response || response.ok === false) {
            throw typedError('CHARACTER_CREATE_FAILED', `SillyTavern rejected the character (status ${response?.status ?? 'unknown'}).`);
        }
        const avatar = String(await response.text()).trim();
        if (!avatar) {
            throw typedError('CHARACTER_CREATE_FAILED', 'SillyTavern did not return an avatar filename.');
        }

        await context.getCharacters?.();
        const registered = Array.isArray(context.characters)
            && context.characters.some(item => String(item?.avatar ?? '') === avatar);
        if (!registered) {
            throw typedError('CHARACTER_CREATE_FAILED', `The host did not register the new character: ${avatar}`, { avatar });
        }
        return { avatar, name: input.name, created: true };
    },
};

const charactersRemoveCapability = {
    id: 'characters.remove',
    name: '删除角色卡',
    description: '按头像文件名删除角色卡（破坏性）；必须在 confirm 中回写头像文件名或角色名；需要 host.characters.manage 授权。',
    permissions: [CHARACTERS_MANAGE_SCOPE],
    input: {
        type: 'object',
        required: ['avatar', 'confirm'],
        properties: {
            avatar: { type: 'string', minLength: 1, maxLength: 200 },
            confirm: { type: 'string', minLength: 1, maxLength: 200 },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['avatar', 'removed'],
        properties: {
            avatar: { type: 'string' },
            removed: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof globalThis.fetch !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This environment has no fetch() for character deletion.');
        }
        const character = findCharacter(context, input.avatar);
        if (!character) {
            throw typedError('CHARACTER_NOT_FOUND', `Character not found: ${input.avatar}`);
        }
        const avatar = String(character.avatar ?? '');
        const name = String(character.name ?? '');
        if (input.confirm !== avatar && input.confirm !== name) {
            throw typedError('CONFIRMATION_REQUIRED', 'Deleting a character requires confirm to repeat its avatar filename or name exactly.', {
                avatar,
                name,
            });
        }

        // Deleting the open character makes SillyTavern reload the chat area
        // mid-call; the user can switch away first and retry.
        const index = findCharacterIndex(context, avatar);
        if (index >= 0 && String(context.characterId) === String(index)) {
            throw typedError('CHARACTER_IN_USE', 'The character is currently open; switch to another character before deleting it.', {
                avatar,
            });
        }

        let response;
        try {
            response = await globalThis.fetch('/api/characters/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(context.getRequestHeaders?.() ?? {}) },
                // The chat directory is user data; deletion of the card must not
                // silently take the conversations with it.
                body: JSON.stringify({ avatar_url: avatar, delete_chats: false }),
            });
        } catch (error) {
            throw typedError('CHARACTER_REMOVE_FAILED', `Character deletion failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response || response.ok === false) {
            throw typedError('CHARACTER_REMOVE_FAILED', `SillyTavern rejected the deletion (status ${response?.status ?? 'unknown'}).`, { avatar });
        }

        await context.getCharacters?.();
        if (Array.isArray(context.characters) && context.characters.some(item => String(item?.avatar ?? '') === avatar)) {
            throw typedError('CHARACTER_REMOVE_FAILED', `The host still lists the character after deletion: ${avatar}`, { avatar });
        }
        return { avatar, removed: true };
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

const CALLER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const RESERVED_SETTINGS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SETTINGS_KEY_MAX_LENGTH = 128;
/**
 * Reserved root for Loom's own bookkeeping inside SillyTavern's extension
 * settings. Extension ids must start with a letter or digit, so a leading
 * underscore can never collide with a caller namespace.
 */
const LOOM_ROOT_KEY = '__loom';

function typedError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details) error.details = details;
    return error;
}

/**
 * Every settings capability is caller-scoped: the caller's own id becomes the
 * SillyTavern extension_settings namespace. Core always supplies a caller
 * (defaulting to the capability owner), but the value is validated here too
 * because it is used as an object key.
 */
function requireCaller(context) {
    const caller = context?.caller;
    if (typeof caller !== 'string' || !CALLER_PATTERN.test(caller)) {
        throw typedError('CALLER_REQUIRED', 'A valid caller extension id is required for settings access.');
    }
    return caller;
}

function assertSettingsKey(key) {
    if (typeof key !== 'string' || key.trim() === '') {
        throw typedError('INVALID_INPUT', 'Settings key must be a non-empty string.');
    }
    if (key.length > SETTINGS_KEY_MAX_LENGTH) {
        throw typedError('INVALID_INPUT', `Settings key must be at most ${SETTINGS_KEY_MAX_LENGTH} characters.`);
    }
    if (RESERVED_SETTINGS_KEYS.has(key)) {
        throw typedError('INVALID_INPUT', `Settings key "${key}" is reserved.`);
    }
    return key;
}

function extensionSettings() {
    const settings = globalThis.SillyTavern?.getContext?.()?.extensionSettings;
    if (!settings || typeof settings !== 'object') {
        throw typedError('HOST_UNAVAILABLE', 'SillyTavern extension settings are unavailable.');
    }
    return settings;
}

/**
 * Resolve the caller's namespace. Reads must not create the namespace: probing
 * for a key should not add empty objects to the user's SillyTavern settings.
 */
function callerSettingsRoot(caller, { create }) {
    const settings = extensionSettings();
    const existing = settings[caller];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
    if (!create) return null;
    const created = {};
    settings[caller] = created;
    return created;
}

function saveSettings() {
    globalThis.SillyTavern?.getContext?.()?.saveSettingsDebounced?.();
}

function assertSerializable(value) {
    try {
        structuredClone(value);
    } catch {
        throw typedError('INVALID_INPUT', 'Settings values must be structured-cloneable (no functions or DOM nodes).');
    }
}

/**
 * Permission-store adapter: Core owns the grant table, the host owns where it
 * lives. Grants are stored under the reserved `__loom` root so they do not mix
 * with any extension's caller-scoped settings namespace.
 *
 * A missing host is not an error: it means there is nothing persisted yet, so
 * load reports an empty table and save is a no-op. Genuine write failures still
 * throw and are reported by Core.
 */
function loomSettingsRoot({ create }) {
    const settings = globalThis.SillyTavern?.getContext?.()?.extensionSettings;
    if (!settings || typeof settings !== 'object') return null;
    const existing = settings[LOOM_ROOT_KEY];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
    if (!create) return null;
    const root = {};
    settings[LOOM_ROOT_KEY] = root;
    return root;
}

function createPermissionStore() {
    return {
        load: () => {
            const root = loomSettingsRoot({ create: false });
            return Array.isArray(root?.grants) ? structuredClone(root.grants) : [];
        },
        save: grants => {
            const root = loomSettingsRoot({ create: true });
            if (!root) return;
            root.grants = structuredClone(grants);
            saveSettings();
        },
    };
}

/**
 * State-store adapter: Core keeps namespace isolation, the host owns storage.
 * Snapshots live under `__loom.state[extensionId]`, separate from the grant
 * table and from any extension's caller-scoped settings.
 */
function createStateStore() {
    const stateRoot = ({ create, extensionId }) => {
        const root = loomSettingsRoot({ create });
        if (!root) return null;
        if (!root.state || typeof root.state !== 'object' || Array.isArray(root.state)) {
            if (!create) return null;
            root.state = {};
        }
        if (extensionId === undefined) return root.state;
        const existing = root.state[extensionId];
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
        return null;
    };

    return {
        load: extensionId => {
            const snapshot = stateRoot({ create: false, extensionId });
            return snapshot ? structuredClone(snapshot) : null;
        },
        save: (extensionId, snapshot) => {
            const root = loomSettingsRoot({ create: true });
            if (!root) return;
            const state = stateRoot({ create: true });
            state[extensionId] = structuredClone(snapshot);
            saveSettings();
        },
        remove: extensionId => {
            const state = stateRoot({ create: false });
            if (!state || !Object.hasOwn(state, extensionId)) return;
            delete state[extensionId];
            saveSettings();
        },
    };
}

const settingsGetCapability = {
    id: 'settings.get',
    name: '读取扩展设置',
    description: '读取调用方扩展在酒馆扩展设置中的自有命名空间。',
    input: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string', minLength: 1, maxLength: SETTINGS_KEY_MAX_LENGTH } },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['key', 'present', 'value'],
        properties: {
            key: { type: 'string' },
            present: { type: 'boolean' },
            value: {},
        },
    },
    execute: (input, context) => {
        const key = assertSettingsKey(input.key);
        const root = callerSettingsRoot(requireCaller(context), { create: false });
        return { key, present: root !== null && Object.hasOwn(root, key), value: root?.[key] ?? null };
    },
};

const settingsSetCapability = {
    id: 'settings.set',
    name: '写入扩展设置',
    description: '把值写入调用方扩展的自有设置命名空间；需要 host.settings.write 授权。',
    permissions: ['host.settings.write'],
    input: {
        type: 'object',
        required: ['key', 'value'],
        properties: { key: { type: 'string', minLength: 1, maxLength: SETTINGS_KEY_MAX_LENGTH }, value: {} },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['key', 'written'],
        properties: { key: { type: 'string' }, written: { type: 'boolean' } },
    },
    execute: (input, context) => {
        const caller = requireCaller(context);
        const key = assertSettingsKey(input.key);
        assertSerializable(input.value);
        const root = callerSettingsRoot(caller, { create: true });
        root[key] = structuredClone(input.value);
        saveSettings();
        return { key, written: true };
    },
};

const settingsRemoveCapability = {
    id: 'settings.remove',
    name: '删除扩展设置',
    description: '删除调用方扩展自有设置命名空间中的键；需要 host.settings.write 授权。',
    permissions: ['host.settings.write'],
    input: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string', minLength: 1, maxLength: SETTINGS_KEY_MAX_LENGTH } },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['key', 'removed'],
        properties: { key: { type: 'string' }, removed: { type: 'boolean' } },
    },
    execute: (input, context) => {
        const caller = requireCaller(context);
        const key = assertSettingsKey(input.key);
        const root = callerSettingsRoot(caller, { create: false });
        const removed = root !== null && Object.hasOwn(root, key);
        if (removed) {
            delete root[key];
            saveSettings();
        }
        return { key, removed };
    },
};

const settingsListCapability = {
    id: 'settings.keys',
    name: '列出扩展设置键',
    description: '列出调用方扩展自有设置命名空间中的键。',
    input: nullInput,
    output: { type: 'array', items: { type: 'string' } },
    execute: (input, context) => {
        const root = callerSettingsRoot(requireCaller(context), { create: false });
        return root === null ? [] : Object.keys(root).sort();
    },
};

/**
 * Message injection.
 *
 * Only SillyTavern's own system-message types are used, because they are the one
 * writing path the host exposes as a stable function (`sendSystemMessage`); a
 * fabricated chat entry would bypass its rendering and bookkeeping.
 *
 * If the host rejects the type (unknown type pushes nothing, or pushes an empty
 * entry on some builds), the damage is undone by popping what was added and the
 * call fails with `HOST_UNSUPPORTED` instead of leaving a corrupt chat.
 */
/**
 * Only types that SillyTavern 1.19 actually defines in `system_messages`.
 *
 * `narrator` and `comment` exist in the host's type enum but have **no template**
 * in this version: `sendSystemMessage` then returns `undefined`, pushes it into
 * the chat and throws while rendering. Offering them would mean shipping a
 * default that always fails, so the allowlist follows the templates, not the
 * enum, and `generic` is the default (it always has a template).
 */
const CHAT_MESSAGE_TYPES = Object.freeze(['generic', 'assistant_note']);
const DEFAULT_CHAT_MESSAGE_TYPE = 'generic';
const CHAT_TEXT_LIMIT = 4000;

const chatAppendCapability = {
    id: 'chat.append',
    name: '写入聊天消息',
    description: '向当前聊天追加一条系统消息（generic / assistant_note，默认 generic）；需要 host.chat.write 授权。',
    permissions: ['host.chat.write'],
    input: {
        type: 'object',
        required: ['text'],
        properties: {
            text: { type: 'string', minLength: 1, maxLength: CHAT_TEXT_LIMIT },
            type: { type: 'string', enum: [...CHAT_MESSAGE_TYPES] },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['appended', 'type', 'index'],
        properties: {
            appended: { type: 'boolean' },
            type: { type: 'string' },
            index: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        if (typeof context.sendSystemMessage !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose sendSystemMessage().');
        }
        const chatId = getChatId(context);
        const chat = context.chat;
        if (!chatId && (!Array.isArray(chat) || chat.length === 0)) {
            throw typedError('NO_CHAT', 'No chat is open; open a chat before appending a message.');
        }

        const type = input.type ?? DEFAULT_CHAT_MESSAGE_TYPE;
        const before = Array.isArray(chat) ? chat.length : 0;
        const undo = () => {
            while (Array.isArray(context.chat) && context.chat.length > before) context.chat.pop();
        };

        try {
            context.sendSystemMessage(type, input.text);
        } catch (error) {
            // SillyTavern pushes the message before rendering it, so a render
            // failure can leave a half-written entry behind. Never keep it.
            undo();
            throw typedError(
                'HOST_UNSUPPORTED',
                `The host failed to append a "${type}" message: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        const after = Array.isArray(context.chat) ? context.chat.length : 0;
        const appendedEntry = after > before ? context.chat[after - 1] : null;
        if (!appendedEntry) {
            undo();
            throw typedError('HOST_UNSUPPORTED', `The host did not accept a "${type}" system message.`);
        }

        // sendSystemMessage renders but does not save; persist explicitly so the
        // message survives a reload.
        await context.saveChat?.();
        return { appended: true, type, index: after - 1 };
    },
};

/**
 * Existing-message mutation.
 *
 * Editing and deleting go through SillyTavern's own functions rather than
 * splicing `context.chat` directly: `updateMessageBlock` keeps the rendered
 * element in step with the data, and `deleteMessage` performs the bookkeeping
 * (swipe/tool-call cascade, prompt-item cleanup, debounced save) that a raw
 * splice would skip. Both are destructive, so:
 * - `chat.edit` reports the previous text, which is what an undo needs;
 * - `chat.delete` requires the caller to echo the current text in `expect`, so a
 *   stale index cannot silently destroy an unrelated message.
 */
const chatEditCapability = {
    id: 'chat.edit',
    name: '编辑聊天消息',
    description: '按索引修改已有消息文本并保存；需要 host.chat.write 授权。返回原文以便撤销。',
    permissions: ['host.chat.write'],
    input: {
        type: 'object',
        required: ['index', 'text'],
        properties: {
            index: { type: 'integer', minimum: 0 },
            text: { type: 'string', minLength: 1, maxLength: CHAT_TEXT_LIMIT },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['index', 'previous', 'saved', 'rendered'],
        properties: {
            index: { type: 'integer', minimum: 0 },
            previous: { type: 'string' },
            saved: { type: 'boolean' },
            rendered: { type: 'boolean' },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        const chat = context.chat;
        if (!Array.isArray(chat) || chat.length === 0) {
            throw typedError('NO_CHAT', 'No chat is open; open a chat before editing a message.');
        }
        if (input.index >= chat.length) {
            throw typedError('MESSAGE_NOT_FOUND', `Message index out of range: ${input.index}`, {
                index: input.index,
                length: chat.length,
            });
        }

        const message = chat[input.index];
        const previous = String(message.mes ?? '');
        context.chat[input.index] = { ...message, mes: input.text };

        let rendered = false;
        if (typeof context.updateMessageBlock === 'function') {
            try {
                await context.updateMessageBlock(input.index, context.chat[input.index]);
                rendered = true;
            } catch (error) {
                context.chat[input.index] = message;
                throw typedError('MESSAGE_UPDATE_FAILED', `The host could not re-render message ${input.index}: ${error instanceof Error ? error.message : String(error)}`, {
                    index: input.index,
                });
            }
        }

        let saved = false;
        if (typeof context.saveChat === 'function') {
            try {
                await context.saveChat();
                saved = true;
            } catch {
                saved = false;
            }
        }
        return { index: input.index, previous, saved, rendered };
    },
};

const chatDeleteCapability = {
    id: 'chat.delete',
    name: '删除聊天消息',
    description: '按索引删除一条消息（破坏性）；必须在 expect 中回写当前消息原文；需要 host.chat.write 授权。',
    permissions: ['host.chat.write'],
    input: {
        type: 'object',
        required: ['index', 'expect'],
        properties: {
            index: { type: 'integer', minimum: 0 },
            expect: { type: 'string', minLength: 1, maxLength: CHAT_TEXT_LIMIT },
        },
        additionalProperties: false,
    },
    output: {
        type: 'object',
        required: ['index', 'removed', 'remaining'],
        properties: {
            index: { type: 'integer', minimum: 0 },
            removed: { type: 'integer', minimum: 0 },
            remaining: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
    },
    execute: async (input) => {
        const context = getHostContext();
        const chat = context.chat;
        if (!Array.isArray(chat) || chat.length === 0) {
            throw typedError('NO_CHAT', 'No chat is open; open a chat before deleting a message.');
        }
        if (input.index >= chat.length) {
            throw typedError('MESSAGE_NOT_FOUND', `Message index out of range: ${input.index}`, {
                index: input.index,
                length: chat.length,
            });
        }
        const current = String(chat[input.index].mes ?? '');
        if (current !== input.expect) {
            throw typedError('CONFIRMATION_REQUIRED', 'Deleting a message requires expect to repeat its current text exactly.', {
                index: input.index,
                current: current.slice(0, 200),
            });
        }
        if (typeof context.deleteMessage !== 'function') {
            throw typedError('HOST_UNSUPPORTED', 'This SillyTavern version does not expose deleteMessage().');
        }

        const before = chat.length;
        // `askConfirmation` stays false: consent is Loom's permission gate plus the
        // `expect` echo, and the host dialog cannot be driven from here.
        await context.deleteMessage(input.index, undefined, false, true);
        const remaining = Array.isArray(context.chat) ? context.chat.length : chat.length;
        const removed = Math.max(0, before - remaining);
        if (removed === 0) {
            throw typedError('MESSAGE_DELETE_FAILED', `The host did not remove message ${input.index}.`, {
                index: input.index,
            });
        }
        return { index: input.index, removed, remaining };
    },
};

const CAPABILITIES = Object.freeze([
    snapshotCapability,
    charactersCapability,
    characterCardCapability,
    charactersUpdateCapability,
    charactersCreateCapability,
    charactersRemoveCapability,
    worldsCapability,
    worldsCreateCapability,
    worldsRemoveCapability,
    worldsExportCapability,
    worldsImportCapability,
    worldsRenameCapability,
    worldsEntriesCapability,
    worldsEntryUpdateCapability,
    worldsEntryCreateCapability,
    worldsEntryRemoveCapability,
    viewportCapability,
    chatMessagesCapability,
    chatAppendCapability,
    chatEditCapability,
    chatDeleteCapability,
    settingsGetCapability,
    settingsSetCapability,
    settingsRemoveCapability,
    settingsListCapability,
]);

/**
 * Content fingerprint input for duplicate detection. Derived from the capability
 * list so it cannot silently drift when a capability is added or re-gated.
 */
function describeContent() {
    const ids = CAPABILITIES.map(capability => capability.id).join(',');
    const permissions = [...new Set(CAPABILITIES.flatMap(capability => capability.permissions ?? []))].sort().join(',');
    return `loom-host@${HOST_VERSION}:${ids}|permissions:${permissions}`;
}

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
        description: 'SillyTavern 宿主适配器：只读宿主数据与调用方自有设置读写。',
        content: describeContent(),
    });

    for (const capability of CAPABILITIES) {
        runtime.registerCapability(EXTENSION_ID, capability);
    }

    // Persist the permission grant table in SillyTavern settings so consent
    // survives a reload. Core keeps enforcing; this only decides where the
    // snapshot lives. The store stays attached for the page lifetime, so a
    // removal still reaches storage during unregister.
    if (typeof runtime.setPermissionStore === 'function') {
        runtime.setPermissionStore(createPermissionStore());
    }
    // Extension state persistence shares the same reserved root, so a single
    // SillyTavern settings save covers grants and state.
    if (typeof runtime.setStateStore === 'function') {
        runtime.setStateStore(createStateStore());
    }

    tryEnsureBridge();
    globalThis.jQuery?.(() => tryEnsureBridge());
}

install();