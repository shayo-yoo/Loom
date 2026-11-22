/**
 * External (self-registering) extensions — the "partly unmanaged" tier.
 *
 * A package has an id, a manifest file and an index entry; Loom can therefore
 * show it, version it and reload it. Third-party code may instead register itself
 * at runtime, which is convenient but means the user never chose to install it.
 * This module makes that visible and consensual:
 *
 * - the first request creates a **pending** record and asks the user;
 * - only an approved record may call `registerExtension`, so a well-behaved
 *   external extension cannot become active before the user says yes;
 * - the decision is persisted, so a reload does not re-prompt;
 * - a denied extension stays denied until the user clears the record.
 *
 * As everywhere else in Loom this is a cooperative gate, not a sandbox: code that
 * bypasses this module and calls the Core registry directly is not stopped. That
 * boundary is deliberate (the project targets a local, trusted host).
 */

const STATE_KEY = 'externalExtensions';
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;
const STATUSES = Object.freeze(['pending', 'approved', 'denied']);

/** Validate a manifest handed in by third-party code. */
export function normalizeExternalManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('External extension manifest must be an object.');
    }
    const id = typeof manifest.id === 'string' ? manifest.id.trim() : '';
    if (!ID_PATTERN.test(id)) {
        throw new Error('External extension id must be an identifier.');
    }
    const name = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : id;
    // A malformed permission list must fail loudly: silently dropping it would make
    // the consent prompt under-report what the extension asked for.
    if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) {
        throw new Error('External extension permissions must be an array.');
    }
    const permissions = manifest.permissions ?? [];
    for (const permission of permissions) {
        if (typeof permission !== 'string' || !PERMISSION_PATTERN.test(permission)) {
            throw new Error(`Invalid permission name: ${JSON.stringify(permission)}`);
        }
    }
    return {
        id,
        name,
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        author: typeof manifest.author === 'string' ? manifest.author : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        permissions: [...new Set(permissions)],
    };
}

/** Merge a new request into the persisted list, keeping any earlier decision. */
export function rememberExternal(records, manifest) {
    const list = Array.isArray(records) ? records.filter(record => record && typeof record.id === 'string') : [];
    const existing = list.find(record => record.id === manifest.id);
    if (existing) {
        // A re-request must not silently reset a denial or re-prompt an approval,
        // but it may update the descriptive fields.
        return list.map(record => (record.id === manifest.id ? { ...record, ...manifest, status: record.status } : record));
    }
    return [...list, { ...manifest, status: 'pending' }];
}

export function setExternalStatus(records, id, status) {
    if (!STATUSES.includes(status)) throw new Error(`Unknown external status: ${status}`);
    const list = Array.isArray(records) ? records : [];
    return list.map(record => (record.id === id ? { ...record, status } : record));
}

export function forgetExternal(records, id) {
    return (Array.isArray(records) ? records : []).filter(record => record.id !== id);
}

export function findExternal(records, id) {
    return (Array.isArray(records) ? records : []).find(record => record.id === id) ?? null;
}

/** Rows for the panel: the persisted decision joined with the live runtime state. */
export function describeExternal(records, states) {
    const byId = new Map((states ?? []).map(state => [state.id, state]));
    return (Array.isArray(records) ? records : []).map(record => ({
        id: record.id,
        name: record.name ?? record.id,
        version: record.version ?? '',
        author: record.author ?? '',
        description: record.description ?? '',
        permissions: Array.isArray(record.permissions) ? record.permissions : [],
        status: STATUSES.includes(record.status) ? record.status : 'pending',
        registered: byId.get(record.id)?.state === 'active',
        error: byId.get(record.id)?.error?.message ?? '',
    }));
}
