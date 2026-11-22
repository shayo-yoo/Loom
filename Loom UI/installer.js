/**
 * Extension installation bookkeeping.
 *
 * Two sources feed the runtime:
 * - **bundled packages** listed in `extensions/index.json` (shipped with Loom);
 * - **user-installed modules** whose entry URL the user pasted, persisted in the
 *   UI extension's own state.
 *
 * This module is deliberately pure: it validates/normalises descriptions and the
 * persisted list. The runtime calls (`importExtension`, `unloadExtension`) stay in
 * `index.js` so this file can be tested without a DOM or SillyTavern.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Resolve an index/install URL against Loom's own directory. */
export function resolveEntryUrl(entry, baseUrl) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    // Whitespace means a pasted sentence, not a path; `new URL` would happily
    // percent-encode it into a path under Loom.
    if (trimmed === '' || /\s/.test(trimmed)) return null;
    try {
        return new URL(trimmed, baseUrl).href;
    } catch {
        return null;
    }
}

/**
 * Normalise `extensions/index.json`.
 *
 * Returns the valid sources plus a per-entry problem list, so a broken package is
 * reported in the panel instead of silently disappearing.
 */
export function normalizeIndex(payload, baseUrl) {
    const sources = [];
    const problems = [];
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.extensions)) {
        return { sources, problems: ['主索引缺少 extensions 数组'] };
    }

    for (const raw of payload.extensions) {
        if (!raw || typeof raw !== 'object') {
            problems.push('索引条目不是对象');
            continue;
        }
        const id = typeof raw.id === 'string' ? raw.id : '';
        const url = resolveEntryUrl(raw.entry, baseUrl);
        if (!ID_PATTERN.test(id)) {
            problems.push(`索引条目 id 无效：${JSON.stringify(raw.id)}`);
            continue;
        }
        if (!url) {
            problems.push(`索引条目 ${id} 缺少可用的 entry`);
            continue;
        }
        sources.push({
            id,
            name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : id,
            version: typeof raw.version === 'string' ? raw.version : '',
            description: typeof raw.description === 'string' ? raw.description : '',
            manifest: typeof raw.manifest === 'string' ? resolveEntryUrl(raw.manifest, baseUrl) ?? raw.manifest : '',
            entry: url,
            bundled: true,
        });
    }
    return { sources, problems };
}

/** Normalise a user-supplied module URL (the manifest comes from the module). */
export function normalizeUserSource(id, url, baseUrl) {
    const resolved = resolveEntryUrl(url, baseUrl);
    if (!resolved) {
        return { error: '请输入可解析的模块地址' };
    }
    return {
        source: {
            id: ID_PATTERN.test(id ?? '') ? id : null,
            name: null,
            version: '',
            description: '',
            manifest: '',
            entry: resolved,
            bundled: false,
        },
    };
}

/** Merge a source into the persisted install list, de-duplicated by entry URL. */
export function rememberInstalled(installed, source) {
    const list = Array.isArray(installed) ? installed.filter(entry => entry && typeof entry.entry === 'string') : [];
    const rest = list.filter(entry => entry.entry !== source.entry);
    return [...rest, { id: source.id ?? null, entry: source.entry, bundled: Boolean(source.bundled) }];
}

/** Remove an installed entry by runtime id or entry URL. */
export function forgetInstalled(installed, target) {
    const list = Array.isArray(installed) ? installed : [];
    return list.filter(entry => entry && entry.id !== target && entry.entry !== target);
}

/** Describe one installed extension for the panel (state comes from the runtime). */
export function describeInstalled(installed, states) {
    const byId = new Map((states ?? []).map(state => [state.id, state]));
    return (Array.isArray(installed) ? installed : []).map(entry => {
        const state = entry.id ? byId.get(entry.id) ?? null : null;
        return {
            id: entry.id ?? state?.id ?? '',
            entry: entry.entry,
            bundled: Boolean(entry.bundled),
            state: state?.state ?? (entry.id ? 'missing' : 'unknown'),
            name: state?.name ?? entry.id ?? entry.entry,
            version: entry.version ?? state?.version ?? '',
            permissions: Array.isArray(entry.permissions) ? entry.permissions : [],
            dependencies: Array.isArray(entry.dependencies) ? entry.dependencies : [],
            error: state?.error?.message ?? '',
        };
    });
}

/** Slug used for generated script ids; keeps Core's id pattern. */
export function scriptSlug(name) {
    const base = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || 'script';
}

/** Pick a script id that does not collide with the existing ones. */
export function scriptIdFor(name, existingIds = []) {
    const taken = new Set(existingIds);
    const base = `script-${scriptSlug(name)}`.slice(0, 48);
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
    }
    return candidate;
}

/**
 * Normalise persisted script records.
 *
 * Older records predate the enable flag, so "missing" means enabled; a record
 * without an id or source cannot be run and is dropped.
 */
export function normalizeScriptRecords(records) {
    if (!Array.isArray(records)) return [];
    return records
        .filter(record => record && typeof record.id === 'string' && typeof record.source === 'string')
        .map(record => ({ ...record, enabled: record.enabled !== false }));
}
