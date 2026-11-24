import { createExtensionLoader } from './loader.js';

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;
const EVENT_NAME_PATTERN = /^[a-z0-9][a-z0-9:._-]*$/i;
const LOOM_VERSION = '0.42.0';
const capabilityRegistry = new Map();
const extensionRegistry = new Map();
const eventListeners = new Map();
const cleanupRegistry = new Map();
const stateRegistry = new Map();
const permissionRegistry = new Map();
/** Grants loaded from a persistent store, waiting for their extension to register. */
const pendingGrants = new Map();
/** Open permission requests by request id, plus a pair index for de-duplication. */
const permissionRequests = new Map();
const requestIndexByPair = new Map();
let permissionRequestCounter = 0;
let permissionStore = null;
let stateStore = null;

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

function validatePermission(permission) {
    if (typeof permission !== 'string' || !PERMISSION_PATTERN.test(permission)) {
        throw new TypeError('Permission must contain only letters, numbers, dot, colon, underscore, or hyphen.');
    }
}

function normalizePermissionList(permissions) {
    if (permissions === undefined) return Object.freeze([]);
    if (!Array.isArray(permissions)) throw new TypeError('Capability permissions must be an array.');
    const unique = [...new Set(permissions.map(permission => {
        validatePermission(permission);
        return permission;
    }))];
    return Object.freeze(unique);
}

/**
 * Declared error codes. The interface contract asks an interface to describe the
 * errors it may produce; this is metadata for callers and tooling, not a runtime
 * guarantee (a handler can still fail with any code).
 */
function normalizeErrorDeclarations(errors) {
    if (errors === undefined) return Object.freeze([]);
    if (!Array.isArray(errors)) throw new TypeError('Capability errors must be an array.');
    const normalized = errors.map(entry => {
        if (!entry || typeof entry !== 'object') throw new TypeError('Each capability error must be an object.');
        if (typeof entry.code !== 'string' || !/^[A-Z0-9_]+$/.test(entry.code)) {
            throw new TypeError('Capability error code must be UPPER_SNAKE_CASE.');
        }
        if (entry.description !== undefined && typeof entry.description !== 'string') {
            throw new TypeError('Capability error description must be a string.');
        }
        return Object.freeze({ code: entry.code, description: entry.description ?? '' });
    });
    return Object.freeze(normalized);
}

/** Compatibility metadata: when an interface appeared, and whether it is deprecated. */
function normalizeCompatibility(compatibility) {
    if (compatibility === undefined) return null;
    if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)) {
        throw new TypeError('Capability compatibility must be an object.');
    }
    const allowed = ['since', 'deprecated', 'notes'];
    for (const key of Object.keys(compatibility)) {
        if (!allowed.includes(key)) throw new TypeError(`Unknown capability compatibility field: ${key}`);
    }
    if (compatibility.since !== undefined && typeof compatibility.since !== 'string') {
        throw new TypeError('Capability compatibility.since must be a string.');
    }
    if (compatibility.deprecated !== undefined && typeof compatibility.deprecated !== 'boolean') {
        throw new TypeError('Capability compatibility.deprecated must be a boolean.');
    }
    if (compatibility.notes !== undefined && typeof compatibility.notes !== 'string') {
        throw new TypeError('Capability compatibility.notes must be a string.');
    }
    return Object.freeze({
        since: compatibility.since ?? null,
        deprecated: compatibility.deprecated ?? false,
        notes: compatibility.notes ?? '',
    });
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

const EXTENSION_ORIGINS = Object.freeze(['managed', 'external', 'direct']);

/** Registration origin; unknown values are rejected rather than silently coerced. */
function normalizeOrigin(origin) {
    if (origin === undefined) return 'direct';
    if (typeof origin !== 'string' || !EXTENSION_ORIGINS.includes(origin)) {
        throw new TypeError(`Extension origin must be one of: ${EXTENSION_ORIGINS.join(', ')}`);
    }
    return origin;
}

function normalizeIdentityPart(value, kind, fallback) {    if (value === undefined) return fallback;
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
    // `minimum`/`maximum` bound a number and may be negative; the length/count
    // bounds cannot. Grouping them together rejected legitimate schemas such as a
    // signed delta `{ minimum: -9999 }`.
    for (const key of ['minimum', 'maximum']) {
        if (schema[key] !== undefined && !Number.isFinite(schema[key])) {
            errors.push(`${path}: ${key} must be a finite number.`);
        }
    }
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
        if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
            errors.push(`${path}: ${key} must be a non-negative integer.`);
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
        permissions: [...capability.permissions],
        errors: structuredClone(capability.errors ?? []),
        compatibility: capability.compatibility === null || capability.compatibility === undefined
            ? null
            : structuredClone(capability.compatibility),
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
        // Where the registration came from. `managed` = a package loaded through the
        // loader, `external` = a third party that registered itself, `direct` =
        // bootstrap code (the host adapter and Loom UI). Surfaced so a UI can ask the
        // user about external code instead of treating every extension alike.
        origin: normalizeOrigin(extension.origin),
    });
    extensionRegistry.set(record.id, record);
    // Grants persisted before this extension registered are applied now, so the
    // store can be installed at any point in the boot sequence.
    const pending = pendingGrants.get(record.id);
    if (pending) {
        pendingGrants.delete(record.id);
        applyGrants(record.id, pending);
    }
    // State persisted before this extension registered applies now, so the store
    // can be attached at any point in the boot sequence.
    if (stateStore) {
        try {
            restoreStateSnapshot(record.id, stateStore.load(record.id));
        } catch (error) {
            console.warn(`[Loom] Failed to load state for "${record.id}":`, error);
        }
    }
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
    const errors = normalizeErrorDeclarations(capability.errors);
    const compatibility = normalizeCompatibility(capability.compatibility);

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
        permissions: normalizePermissionList(capability.permissions),
        errors,
        compatibility,
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
 * Data-type registry.
 *
 * Extensions define their own data shapes; this registry gives those shapes a
 * stable identity (`extensionId:typeId`) so an interface can name the types it
 * exchanges, per the interface contract. Loom does not interpret the schema; it
 * only validates that it is a JSON-Schema-subset definition.
 */
const typeRegistry = new Map();

function snapshotType(entry) {
    return {
        extensionId: entry.extensionId,
        id: entry.type.id,
        name: entry.type.name,
        description: entry.type.description,
        schema: entry.type.schema === null ? null : structuredClone(entry.type.schema),
    };
}

export function registerType(extensionId, definition) {
    requireRegisteredExtension(extensionId, 'registering a type');
    if (!definition || typeof definition !== 'object') {
        throw new TypeError('Type metadata must be an object.');
    }
    validateId(definition.id, 'Type');
    if (typeof definition.name !== 'string' || definition.name.trim() === '') {
        throw new TypeError('Type name is required.');
    }
    if (definition.description !== undefined && typeof definition.description !== 'string') {
        throw new TypeError('Type description must be a string.');
    }
    if (definition.schema !== undefined) {
        const errors = checkSchemaDefinition(definition.schema);
        if (errors.length) throw new TypeError(`Invalid type schema: ${errors.join(' ')}`);
    }
    const key = `${extensionId}:${definition.id}`;
    if (typeRegistry.has(key)) throw new Error(`Type already registered: ${key}`);
    const entry = {
        extensionId,
        type: Object.freeze({
            id: definition.id,
            name: definition.name.trim(),
            description: typeof definition.description === 'string' ? definition.description : '',
            schema: definition.schema === undefined ? null : structuredClone(definition.schema),
        }),
    };
    typeRegistry.set(key, entry);
    return snapshotType(entry);
}

export function listTypes(extensionId) {
    if (extensionId !== undefined) validateId(extensionId, 'Extension');
    return [...typeRegistry.values()]
        .filter(entry => extensionId === undefined || entry.extensionId === extensionId)
        .map(snapshotType);
}

export function getType(extensionId, typeId) {
    validateId(extensionId, 'Extension');
    validateId(typeId, 'Type');
    const entry = typeRegistry.get(`${extensionId}:${typeId}`);
    return entry ? snapshotType(entry) : null;
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
    saveStateSnapshot(extensionId);
    return value;
}

export function deleteState(extensionId, key) {
    requireOwnedKey(extensionId, key);
    const state = stateRegistry.get(extensionId);
    if (!state) return false;
    const removed = state.delete(key);
    if (state.size === 0) stateRegistry.delete(extensionId);
    if (removed) saveStateSnapshot(extensionId);
    return removed;
}

export function listStateKeys(extensionId) {
    requireRegisteredExtension(extensionId, 'using extension state');
    return [...(stateRegistry.get(extensionId)?.keys() ?? [])].sort();
}

/**
 * The persistable view of an extension's state: a plain object of the entries
 * that survive `structuredClone`. Functions, DOM nodes and other live objects
 * stay usable in memory but are reported and skipped, because persisting them
 * would either throw or silently change them on the next load.
 */
function stateSnapshot(extensionId) {
    const state = stateRegistry.get(extensionId);
    if (!state || state.size === 0) return null;
    const snapshot = {};
    let skipped = 0;
    for (const [key, value] of state) {
        try {
            snapshot[key] = structuredClone(value);
        } catch {
            skipped += 1;
        }
    }
    if (skipped > 0) {
        console.warn(`[Loom] ${skipped} state value(s) of "${extensionId}" are not cloneable and were not persisted.`);
    }
    return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function saveStateSnapshot(extensionId) {
    if (!stateStore) return;
    try {
        const snapshot = stateSnapshot(extensionId);
        if (snapshot === null) stateStore.remove(extensionId);
        else stateStore.save(extensionId, snapshot);
    } catch (error) {
        console.warn(`[Loom] Failed to persist state for "${extensionId}":`, error);
    }
}

function restoreStateSnapshot(extensionId, snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    const existing = stateRegistry.get(extensionId);
    const target = existing ?? new Map();
    for (const [key, value] of Object.entries(snapshot)) {
        // Never clobber a value that was written after the snapshot was taken.
        if (target.has(key)) continue;
        target.set(key, value);
    }
    if (target.size > 0) stateRegistry.set(extensionId, target);
}

/**
 * Install an optional persistent store for extension state.
 *
 * Core owns the namespace isolation; the store only reads and writes one
 * extension's snapshot, so the host decides where it lives. Without a store,
 * state is page-scoped exactly as before.
 *
 * @param {{ load: (extensionId: string) => object|null, save: (extensionId: string, snapshot: object) => void, remove: (extensionId: string) => void } | null} store
 */
export function setStateStore(store) {
    if (store !== null && store !== undefined) {
        const methods = ['load', 'save', 'remove'];
        if (typeof store !== 'object' || methods.some(method => typeof store[method] !== 'function')) {
            throw new TypeError('State store must provide load(extensionId), save(extensionId, snapshot) and remove(extensionId).');
        }
    }
    stateStore = store ?? null;
    if (!stateStore) return true;

    for (const extensionId of extensionRegistry.keys()) {
        try {
            restoreStateSnapshot(extensionId, stateStore.load(extensionId));
        } catch (error) {
            console.warn(`[Loom] Failed to load state for "${extensionId}":`, error);
        }
    }
    return true;
}

function createFailure(code, message, details = undefined) {
    return {
        success: false,
        error: { code, message, ...(details ? { details } : {}) },
    };
}

/**
 * Normalize a persisted grant snapshot into `[{ extensionId, permissions }]`.
 * Anything malformed is dropped rather than throwing: a corrupted store must not
 * stop the runtime from booting.
 */
function normalizeGrantSnapshot(raw) {
    if (!Array.isArray(raw)) return [];
    const snapshot = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.extensionId !== 'string' || !EXTENSION_ID_PATTERN.test(entry.extensionId)) continue;
        if (!Array.isArray(entry.permissions)) continue;
        const permissions = entry.permissions.filter(permission => (
            typeof permission === 'string' && PERMISSION_PATTERN.test(permission)
        ));
        if (permissions.length > 0) snapshot.push({ extensionId: entry.extensionId, permissions });
    }
    return snapshot;
}

function applyGrants(extensionId, permissions) {
    if (permissions.length === 0) return;
    if (!permissionRegistry.has(extensionId)) permissionRegistry.set(extensionId, new Set());
    const granted = permissionRegistry.get(extensionId);
    for (const permission of permissions) granted.add(permission);
}

/**
 * Write the grant table through the store. Storage failures are reported but
 * never abort the grant itself: the in-memory table stays authoritative.
 */
function savePermissionSnapshot() {
    if (!permissionStore) return;
    try {
        permissionStore.save(listPermissions());
    } catch (error) {
        console.warn('[Loom] Failed to persist permission grants:', error);
    }
}

function loadGrantSnapshot() {
    if (!permissionStore) return [];
    try {
        return normalizeGrantSnapshot(permissionStore.load());
    } catch (error) {
        console.warn('[Loom] Failed to load permission grants:', error);
        return [];
    }
}

/**
 * Install an optional persistent store for the permission grant table.
 *
 * Core owns the table; the store only reads and writes a serializable snapshot,
 * so the host (or any embedding) stays the storage owner. Without a store,
 * grants live for the page lifetime only.
 *
 * @param {{ load: () => Array, save: (grants: Array<{ extensionId: string, permissions: string[] }>) => void } | null} store
 */
export function setPermissionStore(store) {
    if (store !== null && store !== undefined) {
        if (typeof store !== 'object' || typeof store.load !== 'function' || typeof store.save !== 'function') {
            throw new TypeError('Permission store must provide load() and save(grants).');
        }
    }
    permissionStore = store ?? null;
    pendingGrants.clear();
    if (!permissionStore) return true;

    for (const { extensionId, permissions } of loadGrantSnapshot()) {
        // Registered extensions get their grants immediately; the rest are
        // applied when they register, so boot order does not matter.
        if (extensionRegistry.has(extensionId)) applyGrants(extensionId, permissions);
        else pendingGrants.set(extensionId, permissions);
    }
    return true;
}

/**
 * Grant a permission to a registered extension. Permissions are explicit:
 * declaring them on a capability does not grant them; the caller must hold
 * every permission its capability declares or the call is rejected.
 *
 * Grant and revoke are the operator-facing consent API (Loom UI exposes them in
 * its panel). This is a cooperative access constraint, not a sandbox: every
 * Loom script shares the page realm and can call this API directly.
 */
export function grantPermission(extensionId, permission) {
    requireRegisteredExtension(extensionId, 'granting permissions');
    validatePermission(permission);
    if (!permissionRegistry.has(extensionId)) permissionRegistry.set(extensionId, new Set());
    permissionRegistry.get(extensionId).add(permission);
    savePermissionSnapshot();
    return true;
}

export function revokePermission(extensionId, permission) {
    requireRegisteredExtension(extensionId, 'revoking permissions');
    validatePermission(permission);
    const granted = permissionRegistry.get(extensionId);
    if (!granted) return false;
    const removed = granted.delete(permission);
    if (granted.size === 0) permissionRegistry.delete(extensionId);
    if (removed) savePermissionSnapshot();
    return removed;
}

export function checkPermission(extensionId, permission) {
    validateId(extensionId, 'Extension');
    validatePermission(permission);
    return permissionRegistry.get(extensionId)?.has(permission) === true;
}

export function listPermissions(extensionId) {
    if (extensionId !== undefined) {
        requireRegisteredExtension(extensionId, 'listing permissions');
        return [...(permissionRegistry.get(extensionId) ?? [])].sort();
    }
    return [...permissionRegistry.entries()]
        .map(([id, permissions]) => ({ extensionId: id, permissions: [...permissions].sort() }))
        .sort((a, b) => a.extensionId.localeCompare(b.extensionId));
}

function requestPairKey(extensionId, permission) {
    return `${extensionId}::${permission}`;
}

/**
 * Ask the user to grant a permission instead of failing silently.
 *
 * A request is an explicit, visible question: asking never grants anything, and
 * the answer arrives through `resolvePermissionRequest` (normally a UI consent
 * surface). Requesting an already-held permission resolves immediately; asking
 * twice for the same pair returns the open request instead of stacking prompts.
 * Undeclared permission names are allowed on purpose — a capability may register
 * after the request.
 *
 * Emits `core:permission:requested` with `{ request }`.
 */
export function requestPermission(extensionId, permission, options = {}) {
    requireRegisteredExtension(extensionId, 'requesting permissions');
    validatePermission(permission);
    const reason = typeof options?.reason === 'string' ? options.reason.slice(0, 500) : '';

    if (checkPermission(extensionId, permission)) {
        return { requestId: null, status: 'granted', extensionId, permission };
    }

    const openId = requestIndexByPair.get(requestPairKey(extensionId, permission));
    if (openId) {
        return { requestId: openId, status: 'pending', extensionId, permission };
    }

    const request = {
        id: `perm-${++permissionRequestCounter}`,
        extensionId,
        permission,
        reason,
        requestedAt: Date.now(),
    };
    permissionRequests.set(request.id, request);
    requestIndexByPair.set(requestPairKey(extensionId, permission), request.id);
    void emit('core:permission:requested', { request: { ...request } });
    return { requestId: request.id, status: 'pending', extensionId, permission };
}

export function listPermissionRequests() {
    return [...permissionRequests.values()]
        .map(request => ({ ...request }))
        .sort((a, b) => a.extensionId.localeCompare(b.extensionId) || a.permission.localeCompare(b.permission));
}

/**
 * Answer a permission request. `{ approved: true }` grants it; anything else
 * denies and leaves the permission unheld. A stale request id resolves to
 * `status: 'unknown'` instead of throwing, because a UI may race another surface.
 *
 * Emits `core:permission:resolved` with `{ requestId, extensionId, permission, status }`.
 */
export function resolvePermissionRequest(requestId, options = {}) {
    if (typeof requestId !== 'string' || requestId.trim() === '') {
        throw new TypeError('Permission request id must be a non-empty string.');
    }
    const request = permissionRequests.get(requestId);
    if (!request) return { requestId, status: 'unknown' };

    const approved = Boolean(options?.approved);
    permissionRequests.delete(requestId);
    requestIndexByPair.delete(requestPairKey(request.extensionId, request.permission));

    // An extension that unregistered while the prompt was open cannot be granted.
    const status = approved && extensionRegistry.has(request.extensionId) ? 'granted' : 'denied';
    if (status === 'granted') grantPermission(request.extensionId, request.permission);

    void emit('core:permission:resolved', {
        requestId,
        extensionId: request.extensionId,
        permission: request.permission,
        status,
    });
    return { requestId, status, extensionId: request.extensionId, permission: request.permission };
}

/**
 * Execute a capability through its public contract.
 *
 * `options.caller` names the extension making the call; it defaults to the
 * capability owner (a self-call). Cross-extension calls should pass an explicit
 * caller so permission checks and caller-scoped behaviour attribute correctly.
 *
 * Order of checks: ids -> capability lookup -> caller registration -> input
 * schema -> declared permissions -> handler -> output schema. Declared
 * permissions are enforced here rather than inside each handler, so a capability
 * cannot accidentally run without the grant it advertised.
 */
export async function executeCapability(extensionId, capabilityId, input, options = {}) {
    try {
        validateId(extensionId, 'Extension');
        validateId(capabilityId, 'Capability');
    } catch (error) {
        return createFailure('INVALID_ID', error.message);
    }

    const caller = options?.caller ?? extensionId;
    try {
        validateId(caller, 'Caller extension');
    } catch (error) {
        return createFailure('INVALID_ID', error.message);
    }

    const entry = capabilityRegistry.get(`${extensionId}:${capabilityId}`);
    if (!entry) return createFailure('CAPABILITY_NOT_FOUND', `Capability not found: ${extensionId}:${capabilityId}`);

    const { capability } = entry;
    if (!extensionRegistry.has(caller)) {
        return createFailure('CALLER_NOT_FOUND', `Caller extension is not registered: ${caller}`);
    }
    // Capability contracts are JSON, and JSON has no `undefined`: a call that
    // omits the input argument means "no input", which is `null`. Without this,
    // `executeCapability('host', 'worlds.list')` failed on a null-input schema.
    const capabilityInput = input === undefined ? null : input;
    if (capability.input) {
        const errors = validateSchema(capabilityInput, capability.input);
        if (errors.length) return createFailure('INVALID_INPUT', 'Capability input did not match its schema.', errors);
    }

    if (capability.permissions.length > 0) {
        const missing = capability.permissions.filter(permission => !checkPermission(caller, permission));
        if (missing.length > 0) {
            return createFailure(
                'PERMISSION_DENIED',
                `Extension "${caller}" does not hold the permissions required by ${extensionId}:${capabilityId}.`,
                { caller, target: extensionId, capabilityId, missing },
            );
        }
    }

    try {
        const data = await capability.execute(capabilityInput, {
            caller,
            target: extensionId,
            capabilityId,
            capabilityPermissions: [...capability.permissions],
            hasPermission: permission => checkPermission(caller, permission),
        });
        if (capability.output) {
            const errors = validateSchema(data, capability.output);
            if (errors.length) return createFailure('INVALID_OUTPUT', 'Capability output did not match its schema.', errors);
        }
        return { success: true, data };
    } catch (error) {
        // Capabilities may raise typed errors to keep a stable error code in the envelope.
        if (error && typeof error === 'object' && typeof error.code === 'string') {
            return createFailure(error.code, error.message || error.code, error.details);
        }
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
    permissionRegistry.delete(extensionId);
    pendingGrants.delete(extensionId);
    if (stateStore) {
        try {
            stateStore.remove(extensionId);
        } catch (error) {
            console.warn(`[Loom] Failed to remove persisted state for "${extensionId}":`, error);
        }
    }
    // Drop open prompts for the extension that just went away; answering them
    // would grant a permission nothing can use.
    for (const [requestId, request] of [...permissionRequests]) {
        if (request.extensionId !== extensionId) continue;
        permissionRequests.delete(requestId);
        requestIndexByPair.delete(requestPairKey(extensionId, request.permission));
    }
    for (const [key, entry] of capabilityRegistry) {
        if (entry.extensionId === extensionId) capabilityRegistry.delete(key);
    }
    for (const [key, entry] of typeRegistry) {
        if (entry.extensionId === extensionId) typeRegistry.delete(key);
    }
    savePermissionSnapshot();
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
    const states = extensionLoader.listExtensionStates();
    return Object.freeze({
        name: 'Loom',
        version: LOOM_VERSION,
        extensionCount: extensionRegistry.size,
        activeExtensionCount: states.filter(state => state.state === 'active').length,
        failedExtensionCount: states.filter(state => state.state === 'failed').length,
        capabilityCount: capabilityRegistry.size,
        typeCount: typeRegistry.size,
        eventCount: eventListeners.size,
        listenerCount: countListeners(),
        stateKeyCount: countStateKeys(),
        grantedPermissionCount: [...permissionRegistry.values()].reduce((total, set) => total + set.size, 0),
        permissionRequestCount: permissionRequests.size,
        permissionStoreAttached: permissionStore !== null,
        stateStoreAttached: stateStore !== null,
    });
}

const extensionLoader = createExtensionLoader({
    registerExtension,
    unregisterExtension,
    listExtensions,
    requestPermission,
    emit,
});

// Named exports so tests and other modules can reach the lifecycle API directly;
// the same functions are spread onto `globalThis.Loom` below.
export const {
    loadExtension,
    activateExtension,
    deactivateExtension,
    unloadExtension,
    listExtensionStates,
    getExtensionState,
    startExtensions,
    importExtension,
} = extensionLoader;

const api = Object.freeze({
    registerExtension,
    registerCapability,
    listExtensions,
    checkInstall,
    listIdentityGroups,
    listIdentityConflicts,
    computeContentHash,
    listCapabilities,
    registerType,
    listTypes,
    getType,
    executeCapability,
    subscribe,
    emit,
    listEvents,
    addCleanup,
    getState,
    setState,
    deleteState,
    listStateKeys,
    grantPermission,
    revokePermission,
    checkPermission,
    listPermissions,
    requestPermission,
    listPermissionRequests,
    resolvePermissionRequest,
    setPermissionStore,
    setStateStore,
    ...extensionLoader,
    unregisterExtension,
    getRuntimeInfo,
});

if (globalThis.Loom && globalThis.Loom !== api) {
    throw new Error('A Loom runtime is already installed on globalThis.Loom.');
}
globalThis.Loom = api;
