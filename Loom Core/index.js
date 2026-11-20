const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const EVENT_NAME_PATTERN = /^[a-z0-9][a-z0-9:._-]*$/i;
const LOOM_VERSION = '0.7.0';
const capabilityRegistry = new Map();
const extensionRegistry = new Map();
const eventListeners = new Map();
const cleanupRegistry = new Map();
const stateRegistry = new Map();

const JSON_TYPES = new Set(['array', 'boolean', 'null', 'number', 'object', 'string', 'integer']);

function validateId(id, kind) {
    if (typeof id !== 'string' || !EXTENSION_ID_PATTERN.test(id)) {
        throw new TypeError(`${kind} id must contain only letters, numbers, dot, underscore, or hyphen.`);
    }
}

function validateEventName(eventName) {
    if (typeof eventName !== 'string' || !EVENT_NAME_PATTERN.test(eventName)) {
        throw new TypeError('Event name must contain only letters, numbers, colon, dot, underscore, or hyphen.');
    }
}

/**
 * Deterministic content fingerprint. This is duplicate-detection metadata, not
 * a signature or security boundary; callers may also supply their own hash.
 */
function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const entries = Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
}

export function computeContentHash(content) {
    if (content === undefined || content === null) return null;
    const text = typeof content === 'string' ? content : stableStringify(content);
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= BigInt(text.charCodeAt(index));
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function normalizeIdentityPart(value, kind, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !EXTENSION_ID_PATTERN.test(value)) {
        throw new TypeError(`${kind} must contain only letters, numbers, dot, underscore, or hyphen.`);
    }
    return value;
}

function resolveIdentity(extension) {
    const author = normalizeIdentityPart(extension.author, 'Extension author', null);
    const declaredId = normalizeIdentityPart(extension.declaredId, 'Declared extension id', extension.id);
    return {
        author,
        declaredId,
        key: `${author ?? 'anonymous'}:${declaredId}`,
    };
}

function resolveContentHash(extension) {
    const supplied = extension.contentHash;
    if (supplied !== undefined && (typeof supplied !== 'string' || supplied.trim() === '')) {
        throw new TypeError('Extension contentHash must be a non-empty string.');
    }
    const computed = computeContentHash(extension.content);
    if (supplied && computed && supplied !== computed) {
        throw new Error('Extension contentHash does not match its content.');
    }
    return supplied ?? computed;
}

function requireRegisteredExtension(extensionId, action) {
    validateId(extensionId, 'Extension');
    if (!extensionRegistry.has(extensionId)) {
        throw new Error(`Register the extension before ${action}: ${extensionId}`);
    }
}

function getJsonType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
}

function matchesType(value, expectedType) {
    const actualType = getJsonType(value);
    if (expectedType === 'number') return actualType === 'number' || actualType === 'integer';
    if (expectedType === 'integer') return actualType === 'integer';
    return actualType === expectedType;
}

function checkSchemaDefinition(schema, path = '$') {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return [`${path}: schema must be an object.`];
    }
    const errors = [];
    const allowedKeys = new Set([
        'type', 'enum', 'const', 'required', 'properties', 'items', 'additionalProperties',
        'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
    ]);
    for (const key of Object.keys(schema)) {
        if (!allowedKeys.has(key)) errors.push(`${path}: unsupported schema keyword "${key}".`);
    }
    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (types.length === 0 || types.some(type => !JSON_TYPES.has(type))) errors.push(`${path}: schema type is invalid.`);
    }
    if (schema.enum !== undefined && !Array.isArray(schema.enum)) errors.push(`${path}: enum must be an array.`);
    if (schema.required !== undefined && !Array.isArray(schema.required)) errors.push(`${path}: required must be an array.`);
    if (schema.properties !== undefined && (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
        errors.push(`${path}: properties must be an object.`);
    }
    if (schema.items !== undefined) errors.push(...checkSchemaDefinition(schema.items, `${path}[]`));
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
        for (const [key, childSchema] of Object.entries(schema.properties)) {
            errors.push(...checkSchemaDefinition(childSchema, `${path}.${key}`));
        }
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...checkSchemaDefinition(schema.additionalProperties, `${path}.*`));
    }
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
        if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || schema[key] < 0)) {
            errors.push(`${path}: ${key} must be a non-negative finite number.`);
        }
    }
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
        errors.push(`${path}: minimum cannot exceed maximum.`);
    }
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
        errors.push(`${path}: minLength cannot exceed maxLength.`);
    }
    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
        errors.push(`${path}: minItems cannot exceed maxItems.`);
    }
    return errors;
}

function validateSchema(value, schema, path = '$') {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return [`${path}: schema must be an object.`];
    }

    const errors = [];
    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (types.length === 0 || types.some(type => !JSON_TYPES.has(type))) {
            errors.push(`${path}: schema type is invalid.`);
        } else if (!types.some(type => matchesType(value, type))) {
            errors.push(`${path}: expected ${types.join(' or ')}, received ${getJsonType(value)}.`);
            return errors;
        }
    }

    if (schema.enum !== undefined) {
        if (!Array.isArray(schema.enum)) {
            errors.push(`${path}: enum must be an array.`);
        } else if (!schema.enum.some(item => Object.is(item, value))) {
            errors.push(`${path}: value is not in the allowed enum.`);
        }
    }
    if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) {
        errors.push(`${path}: value does not match the required constant.`);
    }

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}.`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}.`);
    }
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: length must be >= ${schema.minLength}.`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: length must be <= ${schema.maxLength}.`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: item count must be >= ${schema.minItems}.`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: item count must be <= ${schema.maxItems}.`);
        if (schema.items !== undefined) {
            value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
        }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const properties = schema.properties ?? {};
        if (schema.properties !== undefined && (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
            errors.push(`${path}: properties must be an object.`);
        }
        if (schema.required !== undefined && !Array.isArray(schema.required)) {
            errors.push(`${path}: required must be an array.`);
        }
        if (Array.isArray(schema.required)) {
            for (const key of schema.required) {
                if (typeof key !== 'string') {
                    errors.push(`${path}: required entries must be strings.`);
                } else if (!Object.hasOwn(value, key)) {
                    errors.push(`${path}.${key}: is required.`);
                }
            }
        }
        for (const [key, propertyValue] of Object.entries(value)) {
            if (Object.hasOwn(properties, key)) {
                errors.push(...validateSchema(propertyValue, properties[key], `${path}.${key}`));
            } else if (schema.additionalProperties === false) {
                errors.push(`${path}.${key}: additional property is not allowed.`);
            } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                errors.push(...validateSchema(propertyValue, schema.additionalProperties, `${path}.${key}`));
            }
        }
    }

    return errors;
}

function snapshotCapability(capability) {
    return {
        id: capability.id,
        name: capability.name,
        description: capability.description,
        input: capability.input === null ? null : structuredClone(capability.input),
        output: capability.output === null ? null : structuredClone(capability.output),
    };
}

export function registerExtension(extension) {
    if (!extension || typeof extension !== 'object') {
        throw new TypeError('Extension metadata must be an object.');
    }
    validateId(extension.id, 'Extension');
    if (typeof extension.name !== 'string' || extension.name.trim() === '') {
        throw new TypeError('Extension name is required.');
    }
    if (extensionRegistry.has(extension.id)) {
        throw new Error(`Extension already registered: ${extension.id}`);
    }
    if (extension.version !== undefined && (typeof extension.version !== 'string' || extension.version.trim() === '')) {
        throw new TypeError('Extension version must be a non-empty string.');
    }
    if (extension.description !== undefined && typeof extension.description !== 'string') {
        throw new TypeError('Extension description must be a string.');
    }
    const identity = resolveIdentity(extension);
    const contentHash = resolveContentHash(extension);

    const record = Object.freeze({
        id: extension.id,
        name: extension.name.trim(),
        version: typeof extension.version === 'string' ? extension.version : '0.1.0',
        description: typeof extension.description === 'string' ? extension.description : '',
        author: identity.author,
        declaredId: identity.declaredId,
        identityKey: identity.key,
        contentHash,
    });
    extensionRegistry.set(record.id, record);
    return record;
}

export function registerCapability(extensionId, capability) {
    validateId(extensionId, 'Extension');
    if (!extensionRegistry.has(extensionId)) {
        throw new Error(`Register the extension before its capabilities: ${extensionId}`);
    }
    if (!capability || typeof capability !== 'object') {
        throw new TypeError('Capability metadata must be an object.');
    }
    validateId(capability.id, 'Capability');
    if (typeof capability.name !== 'string' || capability.name.trim() === '') {
        throw new TypeError('Capability name is required.');
    }
    if (typeof capability.execute !== 'function') {
        throw new TypeError('Capability execute must be a function.');
    }
    if (capability.description !== undefined && typeof capability.description !== 'string') {
        throw new TypeError('Capability description must be a string.');
    }
    const schemaErrors = [
        ...(capability.input === undefined ? [] : checkSchemaDefinition(capability.input)),
        ...(capability.output === undefined ? [] : checkSchemaDefinition(capability.output)),
    ];
    if (schemaErrors.length) throw new TypeError(`Invalid capability schema: ${schemaErrors.join(' ')}`);

    const key = `${extensionId}:${capability.id}`;
    if (capabilityRegistry.has(key)) {
        throw new Error(`Capability already registered: ${key}`);
    }
    const record = Object.freeze({
        id: capability.id,
        name: capability.name.trim(),
        description: typeof capability.description === 'string' ? capability.description : '',
        input: capability.input === undefined ? null : structuredClone(capability.input),
        output: capability.output === undefined ? null : structuredClone(capability.output),
        execute: capability.execute,
    });
    capabilityRegistry.set(key, { extensionId, capability: record });
    return snapshotCapability(record);
}

export function listExtensions() {
    return [...extensionRegistry.values()].map(extension => ({ ...extension }));
}

function identitySummary(extension) {
    return {
        id: extension.id,
        author: extension.author,
        declaredId: extension.declaredId,
        identityKey: extension.identityKey,
        version: extension.version,
        contentHash: extension.contentHash,
    };
}

/**
 * Compare a proposed installation against registered extensions without
 * registering it. Same identity with identical content is a duplicate;
 * same identity with different (or unverifiable) content is a conflict.
 */
export function checkInstall(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        throw new TypeError('Install candidate must be an object.');
    }
    validateId(candidate.id, 'Extension');
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
        throw new TypeError('Extension name is required.');
    }
    const identity = resolveIdentity(candidate);
    const contentHash = resolveContentHash(candidate);
    const matches = [...extensionRegistry.values()].filter(extension => extension.identityKey === identity.key);

    let status = 'new';
    let reason = null;
    if (matches.length > 0) {
        const comparable = contentHash !== null && matches.every(extension => extension.contentHash !== null);
        if (comparable && matches.every(extension => extension.contentHash === contentHash)) {
            status = 'duplicate';
        } else {
            status = 'conflict';
            reason = contentHash === null || matches.some(extension => extension.contentHash === null)
                ? 'content-hash-missing'
                : 'same-identity-different-content';
        }
    }

    return {
        status,
        reason,
        identity: { author: identity.author, declaredId: identity.declaredId, key: identity.key },
        contentHash,
        idTaken: extensionRegistry.has(candidate.id),
        matches: matches.map(identitySummary),
    };
}

/**
 * Group registered extensions by declared identity. Groups with more than one
 * member are duplicate installs or content conflicts.
 */
export function listIdentityGroups() {
    const groups = new Map();
    for (const extension of extensionRegistry.values()) {
        const group = groups.get(extension.identityKey) ?? [];
        group.push(extension);
        groups.set(extension.identityKey, group);
    }

    return [...groups.entries()].map(([identityKey, members]) => {
        let status = 'single';
        if (members.length > 1) {
            const comparable = members.every(extension => extension.contentHash !== null);
            const hashes = new Set(members.map(extension => extension.contentHash));
            status = comparable && hashes.size === 1 ? 'duplicate' : 'conflict';
        }
        return {
            identityKey,
            status,
            members: members.map(identitySummary),
        };
    }).sort((a, b) => a.identityKey.localeCompare(b.identityKey));
}

export function listIdentityConflicts() {
    return listIdentityGroups().filter(group => group.status === 'conflict');
}

export function listCapabilities(extensionId) {
    if (extensionId !== undefined) validateId(extensionId, 'Extension');
    return [...capabilityRegistry.values()]
        .filter(entry => extensionId === undefined || entry.extensionId === extensionId)
        .map(entry => ({ extensionId: entry.extensionId, ...snapshotCapability(entry.capability) }));
}

/**
 * Subscribe to a Loom event. Returns an unsubscribe function.
 * The listener is owned by the subscribing extension and is removed automatically
 * when that extension is unregistered.
 */
export function subscribe(extensionId, eventName, handler, options = {}) {
    requireRegisteredExtension(extensionId, 'subscribing to events');
    validateEventName(eventName);
    if (typeof handler !== 'function') {
        throw new TypeError('Event handler must be a function.');
    }

    const record = { extensionId, handler, once: Boolean(options?.once) };
    if (!eventListeners.has(eventName)) eventListeners.set(eventName, new Set());
    eventListeners.get(eventName).add(record);

    let active = true;
    return () => {
        if (!active) return false;
        active = false;
        const listeners = eventListeners.get(eventName);
        if (!listeners) return false;
        const removed = listeners.delete(record);
        if (listeners.size === 0) eventListeners.delete(eventName);
        return removed;
    };
}

/**
 * Emit a Loom event. Each listener is awaited in subscription order; listener
 * failures are collected and never abort the remaining listeners.
 */
export async function emit(eventName, payload) {
    validateEventName(eventName);
    const listeners = eventListeners.get(eventName);
    if (!listeners) return { delivered: 0, errors: [] };

    const errors = [];
    let delivered = 0;
    for (const record of [...listeners]) {
        if (!listeners.has(record)) continue;
        if (record.once) listeners.delete(record);
        delivered += 1;
        try {
            await record.handler(payload);
        } catch (error) {
            errors.push({
                extensionId: record.extensionId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (listeners.size === 0) eventListeners.delete(eventName);
    return { delivered, errors };
}

export function listEvents() {
    return [...eventListeners.entries()]
        .map(([name, listeners]) => ({ name, count: listeners.size }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Register a disposal callback for an extension. Callbacks run before the
 * extension's capabilities and listeners are removed. Returns a remover.
 */
export function addCleanup(extensionId, cleanup) {
    requireRegisteredExtension(extensionId, 'registering cleanup');
    if (typeof cleanup !== 'function') {
        throw new TypeError('Cleanup must be a function.');
    }

    if (!cleanupRegistry.has(extensionId)) cleanupRegistry.set(extensionId, new Set());
    const cleanups = cleanupRegistry.get(extensionId);
    cleanups.add(cleanup);

    let active = true;
    return () => {
        if (!active) return false;
        active = false;
        const removed = cleanups.delete(cleanup);
        if (cleanups.size === 0) cleanupRegistry.delete(extensionId);
        return removed;
    };
}

function requireOwnedKey(extensionId, key) {
    requireRegisteredExtension(extensionId, 'using extension state');
    if (typeof key !== 'string' || key.trim() === '') {
        throw new TypeError('State key must be a non-empty string.');
    }
    return key;
}

/**
 * Read a value from the extension's own state namespace. Returns undefined when unset.
 */
export function getState(extensionId, key) {
    requireOwnedKey(extensionId, key);
    return stateRegistry.get(extensionId)?.get(key);
}

/**
 * Write a value into the extension's own state namespace. State is not shared
 * between extensions unless an extension exposes it through a capability.
 */
export function setState(extensionId, key, value) {
    requireOwnedKey(extensionId, key);
    if (!stateRegistry.has(extensionId)) stateRegistry.set(extensionId, new Map());
    stateRegistry.get(extensionId).set(key, value);
    return value;
}

export function deleteState(extensionId, key) {
    requireOwnedKey(extensionId, key);
    const state = stateRegistry.get(extensionId);
    if (!state) return false;
    const removed = state.delete(key);
    if (state.size === 0) stateRegistry.delete(extensionId);
    return removed;
}

export function listStateKeys(extensionId) {
    requireRegisteredExtension(extensionId, 'using extension state');
    return [...(stateRegistry.get(extensionId)?.keys() ?? [])].sort();
}

function createFailure(code, message, details = undefined) {
    return {
        success: false,
        error: { code, message, ...(details ? { details } : {}) },
    };
}

export async function executeCapability(extensionId, capabilityId, input) {
    try {
        validateId(extensionId, 'Extension');
        validateId(capabilityId, 'Capability');
    } catch (error) {
        return createFailure('INVALID_ID', error.message);
    }

    const entry = capabilityRegistry.get(`${extensionId}:${capabilityId}`);
    if (!entry) return createFailure('CAPABILITY_NOT_FOUND', `Capability not found: ${extensionId}:${capabilityId}`);

    const { capability } = entry;
    if (capability.input) {
        const errors = validateSchema(input, capability.input);
        if (errors.length) return createFailure('INVALID_INPUT', 'Capability input did not match its schema.', errors);
    }

    try {
        const data = await capability.execute(input);
        if (capability.output) {
            const errors = validateSchema(data, capability.output);
            if (errors.length) return createFailure('INVALID_OUTPUT', 'Capability output did not match its schema.', errors);
        }
        return { success: true, data };
    } catch (error) {
        return createFailure('EXECUTION_FAILED', error instanceof Error ? error.message : String(error));
    }
}

export function unregisterExtension(extensionId) {
    validateId(extensionId, 'Extension');
    if (!extensionRegistry.has(extensionId)) {
        return { removed: false, cleanupErrors: [] };
    }

    const cleanupErrors = [];
    const cleanups = cleanupRegistry.get(extensionId);
    if (cleanups) {
        for (const cleanup of [...cleanups]) {
            try {
                cleanup();
            } catch (error) {
                cleanupErrors.push({ message: error instanceof Error ? error.message : String(error) });
            }
        }
        cleanupRegistry.delete(extensionId);
    }

    for (const [eventName, listeners] of eventListeners) {
        for (const record of [...listeners]) {
            if (record.extensionId === extensionId) listeners.delete(record);
        }
        if (listeners.size === 0) eventListeners.delete(eventName);
    }

    extensionRegistry.delete(extensionId);
    stateRegistry.delete(extensionId);
    for (const [key, entry] of capabilityRegistry) {
        if (entry.extensionId === extensionId) capabilityRegistry.delete(key);
    }
    return { removed: true, cleanupErrors };
}

function countListeners() {
    let total = 0;
    for (const listeners of eventListeners.values()) total += listeners.size;
    return total;
}

function countStateKeys() {
    let total = 0;
    for (const state of stateRegistry.values()) total += state.size;
    return total;
}

export function getRuntimeInfo() {
    return Object.freeze({
        name: 'Loom',
        version: LOOM_VERSION,
        extensionCount: extensionRegistry.size,
        capabilityCount: capabilityRegistry.size,
        eventCount: eventListeners.size,
        listenerCount: countListeners(),
        stateKeyCount: countStateKeys(),
    });
}

const api = Object.freeze({
    registerExtension,
    registerCapability,
    listExtensions,
    checkInstall,
    listIdentityGroups,
    listIdentityConflicts,
    computeContentHash,
    listCapabilities,
    executeCapability,
    subscribe,
    emit,
    listEvents,
    addCleanup,
    getState,
    setState,
    deleteState,
    listStateKeys,
    unregisterExtension,
    getRuntimeInfo,
});

if (globalThis.Loom && globalThis.Loom !== api) {
    throw new Error('A Loom runtime is already installed on globalThis.Loom.');
}
globalThis.Loom = api;
