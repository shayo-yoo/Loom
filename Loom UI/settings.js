/**
 * Settings-panel entry for Loom ("second entry").
 *
 * SillyTavern renders third-party extension settings inside #extensions_settings.
 * This drawer follows the host's inline-drawer convention so it looks native,
 * collapses by default, and stays usable on narrow screens (no fixed widths).
 */

import { escapeHtml } from './dom.js';

export const SETTINGS_ENTRY_ID = 'loom_settings_entry';

/**
 * Build the settings-drawer markup for the given runtime summary.
 * Pure function: no DOM access.
 */
export function buildSettingsEntryHtml(summary = {}) {
    const version = escapeHtml(summary.version ?? '0.0.0');
    const extensions = escapeHtml(summary.extensionCount ?? 0);
    const capabilities = escapeHtml(summary.capabilityCount ?? 0);
    const conflicts = escapeHtml(summary.conflictCount ?? 0);
    const host = escapeHtml(summary.hostStatus ?? '未连接');

    return `
        <div id="${SETTINGS_ENTRY_ID}" class="loom_settings_entry inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Loom</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display: none;">
                <div class="loom_settings_row"><span>运行时版本</span><strong id="loom_settings_version">${version}</strong></div>
                <div class="loom_settings_row"><span>扩展 / 能力</span><strong><span id="loom_settings_extensions">${extensions}</span> / <span id="loom_settings_capabilities">${capabilities}</span></strong></div>
                <div class="loom_settings_row"><span>身份冲突</span><strong id="loom_settings_conflicts">${conflicts}</strong></div>
                <div class="loom_settings_row"><span>宿主</span><strong id="loom_settings_host">${host}</strong></div>
                <button type="button" class="menu_button loom_settings_open" id="loom_settings_open">
                    <i class="fa-solid fa-layer-group"></i>
                    <span>打开 Loom 面板</span>
                </button>
            </div>
        </div>
    `;
}

export function summarizeForSettings(runtimeInfo, conflictCount, hostStatus) {
    return {
        version: runtimeInfo?.version ?? '0.0.0',
        extensionCount: runtimeInfo?.extensionCount ?? 0,
        capabilityCount: runtimeInfo?.capabilityCount ?? 0,
        conflictCount: conflictCount ?? 0,
        hostStatus: hostStatus ?? '未连接',
    };
}