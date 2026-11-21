/**
 * Permission section for the Loom panel.
 *
 * Core enforces the permissions a capability declares. This module only turns
 * the registry state into a reviewable list, so a user can see which capability
 * needs which permission and toggle a grant per extension. The builders are pure
 * functions: no DOM access, so they stay unit testable outside a browser.
 */

import { escapeHtml } from './dom.js';

export const PERMISSION_SECTION_ID = 'loom_permissions';
export const PERMISSION_TOGGLE_CLASS = 'loom_permission_toggle';

/**
 * Group declared capability permissions and join them with current grants.
 *
 * @param {{ capabilities?: Array, extensions?: Array, granted?: Array }} state
 *   capabilities: `listCapabilities()` output; extensions: `listExtensions()`
 *   output; granted: `listPermissions()` output (`[{ extensionId, permissions }]`).
 * @returns {Array<{ permission: string, requiredBy: string[], holders: Array<{ extensionId: string, name: string, granted: boolean }> }>}
 */
export function summarizePermissions({ capabilities = [], extensions = [], granted = [] } = {}) {
    const grants = new Map(
        granted.map(entry => [entry.extensionId, new Set(entry.permissions ?? [])]),
    );
    const required = new Map();
    for (const capability of capabilities) {
        for (const permission of capability.permissions ?? []) {
            if (!required.has(permission)) required.set(permission, new Set());
            required.get(permission).add(`${capability.extensionId}:${capability.id}`);
        }
    }

    return [...required.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([permission, requiredBy]) => ({
            permission,
            requiredBy: [...requiredBy].sort(),
            holders: extensions
                .map(extension => ({
                    extensionId: extension.id,
                    name: extension.name || extension.id,
                    granted: grants.get(extension.id)?.has(permission) === true,
                }))
                .sort((left, right) => left.extensionId.localeCompare(right.extensionId)),
        }));
}

/**
 * Build the permission section markup. Returns an empty-state paragraph when no
 * capability declares a permission.
 */
export function buildPermissionSectionHtml(rows = []) {
    if (rows.length === 0) {
        return '<p class="loom_empty">没有能力声明额外权限。</p>';
    }

    return rows.map(row => {
        const requiredBy = row.requiredBy
            .map(provider => `<code>${escapeHtml(provider)}</code>`)
            .join('、');
        const holders = row.holders.map(holder => {
            const label = `${holder.name} · ${holder.granted ? '已授权' : '未授权'}`;
            return `
                <button type="button" class="menu_button ${PERMISSION_TOGGLE_CLASS}" data-permission="${escapeHtml(row.permission)}" data-extension="${escapeHtml(holder.extensionId)}" data-granted="${holder.granted}" aria-pressed="${holder.granted}" title="切换 ${escapeHtml(row.permission)} 授权">
                    ${escapeHtml(label)}
                </button>
            `;
        }).join('');

        return `
            <div class="loom_permission">
                <div class="loom_permission_head">
                    <code class="loom_permission_name">${escapeHtml(row.permission)}</code>
                </div>
                <p class="loom_permission_required">所需能力：${requiredBy}</p>
                <div class="loom_permission_holders">${holders}</div>
            </div>
        `;
    }).join('');
}

/** Count granted permission pairs, matching Core's `grantedPermissionCount`. */
export function countGranted(rows = []) {
    return rows.reduce((total, row) => total + row.holders.filter(holder => holder.granted).length, 0);
}
