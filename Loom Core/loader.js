/**
 * Manifest-driven extension loading and lifecycle.
 *
 * Core's `registerExtension` only records an identity; this module adds the
 * missing layer: a declarative manifest, an activation lifecycle, dependency
 * ordering, permission declarations, and load-failure isolation.
 *
 * It is created with the Core functions it needs instead of importing Core, so
 * `index.js` can own the public API without a circular import.
 *
 * State machine: `loaded` -> `active` -> `inactive`, with `failed` reachable
 * from any activation attempt. Failures are recorded on the extension and never
 * thrown at the caller: one broken extension must not stop the others.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function validateIdList(list, field) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new TypeError(`Manifest ${field} must be an array.`);
    for (const value of list) {
        if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
            throw new TypeError(`Manifest ${field} entries must be valid extension ids.`);
        }
    }
    return [...new Set(list)];
}

function validatePermissionList(list) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new TypeError('Manifest permissions must be an array.');
    for (const value of list) {
        if (typeof value !== 'string' || !PERMISSION_PATTERN.test(value)) {
            throw new TypeError('Manifest permissions must be valid permission names.');
        }
    }
    return [...new Set(list)];
}

/**
 * Merge a code-exported manifest with one supplied by the caller (usually parsed
 * from a package's `manifest.json`). The explicit manifest wins field by field,
 * but `activate`/`deactivate` are only defined in code, so they are kept when the
 * explicit manifest has none.
 */
function mergeManifests(moduleManifest, explicitManifest) {
    if (!moduleManifest && !explicitManifest) return null;
    if (!moduleManifest) return explicitManifest;

    const merged = { ...moduleManifest };
    if (explicitManifest && typeof explicitManifest === 'object') {
        for (const [key, value] of Object.entries(explicitManifest)) {
            if (value !== undefined) merged[key] = value;
        }
        merged.activate = explicitManifest.activate ?? moduleManifest.activate;
        merged.deactivate = explicitManifest.deactivate ?? moduleManifest.deactivate;
    }
    return merged;
}

/**
 * @param {object} core The Core functions this loader drives.
 * @returns {object} loader API, spread into `globalThis.Loom`.
 */
export function createExtensionLoader(core) {
    const required = ['registerExtension', 'unregisterExtension', 'listExtensions', 'requestPermission', 'emit'];
    for (const name of required) {
        if (typeof core?.[name] !== 'function') {
            throw new TypeError(`Extension loader requires core.${name}().`);
        }
    }

    /** @type {Map<string, object>} manifest records by extension id */
    const records = new Map();

    function isRegistered(id) {
        return core.listExtensions().some(extension => extension.id === id);
    }

    /**
     * Drop records whose identity is gone. `unregisterExtension` is public API
     * and can be called directly, so the loader reconciles lazily instead of
     * assuming it is the only path that removes an extension.
     */
    function pruneRecords() {
        for (const id of [...records.keys()]) {
            if (!isRegistered(id)) records.delete(id);
        }
    }

    function snapshot(record) {
        return {
            id: record.id,
            name: record.name,
            version: record.version,
            state: record.state,
            entry: record.entry,
            dependencies: [...record.dependencies],
            permissions: [...record.permissions],
            error: record.error,
        };
    }

    function describeUnmanaged(extension) {
        return {
            id: extension.id,
            name: extension.name,
            version: extension.version,
            state: 'unmanaged',
            entry: null,
            dependencies: [],
            permissions: [],
            error: null,
        };
    }

    function normalizeManifest(manifest) {
        if (!manifest || typeof manifest !== 'object') {
            throw new TypeError('Extension manifest must be an object.');
        }
        if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
            throw new TypeError('Manifest id must contain only letters, numbers, dot, underscore, or hyphen.');
        }
        if (!isNonEmptyString(manifest.name)) throw new TypeError('Manifest name is required.');
        if (manifest.version !== undefined && !isNonEmptyString(manifest.version)) {
            throw new TypeError('Manifest version must be a non-empty string.');
        }
        if (manifest.entry !== undefined && !isNonEmptyString(manifest.entry)) {
            throw new TypeError('Manifest entry must be a non-empty string when provided.');
        }
        for (const hook of ['activate', 'deactivate']) {
            if (manifest[hook] !== undefined && typeof manifest[hook] !== 'function') {
                throw new TypeError(`Manifest ${hook} must be a function.`);
            }
        }

        const dependencies = validateIdList(manifest.dependencies, 'dependencies');
        if (dependencies.includes(manifest.id)) {
            throw new TypeError('Manifest dependencies must not include the extension itself.');
        }

        return {
            id: manifest.id,
            name: manifest.name.trim(),
            version: typeof manifest.version === 'string' ? manifest.version : '0.1.0',
            entry: typeof manifest.entry === 'string' ? manifest.entry : null,
            dependencies,
            permissions: validatePermissionList(manifest.permissions),
            activate: manifest.activate ?? null,
            deactivate: manifest.deactivate ?? null,
            metadata: {
                description: typeof manifest.description === 'string' ? manifest.description : '',
                author: typeof manifest.author === 'string' ? manifest.author : undefined,
                declaredId: typeof manifest.declaredId === 'string' ? manifest.declaredId : undefined,
                content: manifest.content,
                contentHash: typeof manifest.contentHash === 'string' ? manifest.contentHash : undefined,
            },
        };
    }

    function emitEvent(name, payload) {
        // Listener failures are already isolated by emit(); awaiting is pointless
        // here because loading is synchronous from the caller's perspective.
        void core.emit(name, payload);
    }

    /**
     * Validate a manifest and register its identity. Does not run any extension
     * code yet: activation is a separate, explicit step.
     */
    function loadExtension(manifest) {
        pruneRecords();
        const normalized = normalizeManifest(manifest);
        if (records.has(normalized.id)) {
            throw new Error(`Extension is already loaded: ${normalized.id}`);
        }

        core.registerExtension({
            id: normalized.id,
            name: normalized.name,
            version: normalized.version,
            ...normalized.metadata,
        });

        const record = {
            ...normalized,
            state: 'loaded',
            error: null,
        };
        records.set(normalized.id, record);
        emitEvent('core:extension:loaded', snapshot(record));
        return snapshot(record);
    }

    function fail(record, code, message, details = undefined) {
        record.state = 'failed';
        record.error = { code, message, ...(details ? { details } : {}) };
        emitEvent('core:extension:failed', { ...snapshot(record), error: record.error });
        return snapshot(record);
    }

    /**
     * A dependency is satisfied when it is `active`, or when it is `unmanaged`.
     * `unmanaged` means the extension was registered by bootstrap code
     * (`registerExtension` directly, as the host adapter and UI do), so its setup
     * already ran — treating it as unmet would make every extension that depends
     * on the host impossible to activate. Managed dependencies must be active:
     * `loaded`/`inactive`/`failed` are all unmet.
     */
    function isDependencySatisfied(state) {
        return state === 'active' || state === 'unmanaged';
    }

    /**
     * Activate a loaded (or previously deactivated/failed) extension.
     *
     * Dependencies must already be satisfied — otherwise the extension is marked
     * failed with `DEPENDENCY_MISSING` and its hook never runs. Declared
     * permissions are *requested* (raising consent prompts), never granted.
     */
    function activateExtension(id) {
        pruneRecords();
        const record = records.get(id);
        if (!record) throw new Error(`Extension is not loaded: ${id}`);
        if (record.state === 'active') return snapshot(record);

        const states = new Map(listExtensionStates().map(state => [state.id, state.state]));
        const missing = record.dependencies.filter(dependency => !isDependencySatisfied(states.get(dependency)));
        if (missing.length > 0) {
            return fail(
                record,
                'DEPENDENCY_MISSING',
                `Extension "${id}" requires active dependencies: ${missing.join(', ')}.`,
                { missing },
            );
        }

        record.error = null;
        for (const permission of record.permissions) {
            try {
                core.requestPermission(id, permission, { reason: `扩展 ${record.name} 在清单中声明了该权限` });
            } catch (error) {
                // A permission request must never block activation.
                record.error = {
                    code: 'PERMISSION_REQUEST_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        }

        if (record.activate) {
            try {
                record.activate({ id: record.id, name: record.name, version: record.version });
            } catch (error) {
                return fail(
                    record,
                    'ACTIVATION_FAILED',
                    error instanceof Error ? error.message : String(error),
                );
            }
        }

        record.state = 'active';
        emitEvent('core:extension:activated', snapshot(record));
        return snapshot(record);
    }

    /**
     * Run the deactivation hook and mark the extension inactive. The extension
     * stays registered (its capabilities remain callable); use `unloadExtension`
     * to remove it entirely.
     */
    function deactivateExtension(id) {
        pruneRecords();
        const record = records.get(id);
        if (!record) throw new Error(`Extension is not loaded: ${id}`);
        if (record.state === 'inactive') return snapshot(record);

        record.error = null;
        if (record.deactivate) {
            try {
                record.deactivate({ id: record.id, name: record.name, version: record.version });
            } catch (error) {
                record.error = {
                    code: 'DEACTIVATION_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        }

        record.state = 'inactive';
        emitEvent('core:extension:deactivated', snapshot(record));
        return snapshot(record);
    }

    /**
     * Deactivate (best effort) and fully unregister: cleanups run, capabilities,
     * grants, state and listeners are dropped by Core.
     */
    function unloadExtension(id) {
        pruneRecords();
        const record = records.get(id);
        if (!record) return core.unregisterExtension(id);

        if (record.state === 'active') deactivateExtension(id);
        records.delete(id);
        const result = core.unregisterExtension(id);
        emitEvent('core:extension:unloaded', { id, name: record.name, removed: result.removed });
        return result;
    }

    /** All registered extensions, with managed lifecycle state where available. */
    function listExtensionStates() {
        pruneRecords();
        return core.listExtensions()
            .map(extension => {
                const record = records.get(extension.id);
                return record ? snapshot(record) : describeUnmanaged(extension);
            })
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    function getExtensionState(id) {
        pruneRecords();
        const record = records.get(id);
        if (record) return snapshot(record);
        const extension = core.listExtensions().find(item => item.id === id);
        return extension ? describeUnmanaged(extension) : null;
    }

    /**
     * Order loaded extensions so dependencies come first (Kahn). Nodes left in a
     * cycle are appended at the end: activating them will fail with
     * `DEPENDENCY_MISSING`, which is the correct outcome for a cycle.
     */
    function activationOrder() {
        pruneRecords();
        const managed = [...records.keys()];
        const managedSet = new Set(managed);
        const remaining = new Map(managed.map(id => [id, new Set(records.get(id).dependencies.filter(dep => managedSet.has(dep))) ]));
        const order = [];

        let progressed = true;
        while (progressed) {
            progressed = false;
            for (const [id, deps] of [...remaining]) {
                if (deps.size > 0) continue;
                order.push(id);
                remaining.delete(id);
                progressed = true;
                for (const [, otherDeps] of remaining) otherDeps.delete(id);
            }
        }
        // Cycles (and their dependents) are left over; keep a stable order.
        return [...order, ...remaining.keys()];
    }

    /**
     * Activate every loaded extension in dependency order. Returns what became
     * active and what failed, so a host can report a boot summary instead of
     * parsing exceptions.
     */
    function startExtensions() {
        const activated = [];
        const failed = [];
        for (const id of activationOrder()) {
            const state = activateExtension(id);
            if (state.state === 'active') activated.push(id);
            else failed.push({ id, error: state.error });
        }
        return { activated, failed };
    }

    /**
     * Import an extension module and load it.
     *
     * The module must export a manifest as its default export (an object, or a
     * function returning one) or as `manifest`. Import and manifest problems are
     * reported as a structured failure rather than thrown, because a broken
     * package must not take the boot sequence down with it.
     *
     * @param {string} specifier Module specifier (URL, path or data:/blob: URL).
     * @param {{ activate?: boolean, manifest?: object }} [options]
     */
    async function importExtension(specifier, options = {}) {
        if (typeof specifier !== 'string' || specifier.trim() === '') {
            throw new TypeError('Extension specifier must be a non-empty string.');
        }

        let module;
        try {
            module = await import(specifier);
        } catch (error) {
            return {
                id: null,
                specifier,
                state: 'failed',
                error: { code: 'IMPORT_FAILED', message: error instanceof Error ? error.message : String(error) },
            };
        }

        let moduleManifest = null;
        try {
            const candidate = typeof module.default === 'function' ? await module.default() : module.default;
            moduleManifest = candidate ?? module.manifest ?? null;
        } catch (error) {
            return {
                id: null,
                specifier,
                state: 'failed',
                error: { code: 'MANIFEST_FAILED', message: error instanceof Error ? error.message : String(error) },
            };
        }

        // A package ships identity/dependencies/permissions in `manifest.json`
        // while the hooks (`activate`/`deactivate`) can only live in code. Merge
        // both, with the module's hooks kept when the JSON manifest omits them.
        const manifest = mergeManifests(moduleManifest, options.manifest);
        if (!manifest || typeof manifest !== 'object') {
            return {
                id: null,
                specifier,
                state: 'failed',
                error: { code: 'MANIFEST_MISSING', message: 'Imported module did not export a manifest.' },
            };
        }

        let loaded;
        try {
            loaded = loadExtension(manifest);
        } catch (error) {
            return {
                id: manifest.id ?? null,
                specifier,
                state: 'failed',
                error: { code: 'MANIFEST_INVALID', message: error instanceof Error ? error.message : String(error) },
            };
        }

        if (options.activate === false) {
            return { ...loaded, specifier };
        }
        return { ...activateExtension(loaded.id), specifier };
    }

    return {
        loadExtension,
        activateExtension,
        deactivateExtension,
        unloadExtension,
        listExtensionStates,
        getExtensionState,
        startExtensions,
        importExtension,
    };
}
