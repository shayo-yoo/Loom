/**
 * Loom UI entry point.
 *
 * Loads Core and the SillyTavern host adapter, registers Loom UI as an
 * extension, installs the built-in components, exposes the public UI facade
 * on `globalThis.Loom.ui`, and adds the ST panel/launcher.
 */

import '../Loom%20Core/index.js';
import '../Loom%20Host/index.js';
import { registerComponent, listComponents } from './components.js';
import { BUILTIN_COMPONENTS } from './builtin-components.js';
import {
    createView,
    createViewFromSerialized,
    destroyAllViews,
    getView,
    listViews,
    serializeView,
} from './views.js';
import { serializeNode } from './view-tree.js';
import { escapeHtml } from './dom.js';
import { SETTINGS_ENTRY_ID, buildSettingsEntryHtml, summarizeForSettings } from './settings.js';
import {
    PERMISSION_SECTION_ID,
    PERMISSION_TOGGLE_CLASS,
    buildPermissionSectionHtml,
    countGranted,
    summarizePermissions,
} from './permissions.js';
import {
    CONSENT_CONTAINER_ID,
    CONSENT_VIEW_ID,
    buildConsentNodes,
    summarizeRequests,
} from './consent.js';
import {
    describeInstalled,
    forgetInstalled,
    normalizeIndex,
    normalizeUserSource,
    rememberInstalled,
} from './installer.js';

const PANEL_ID = 'loom_panel';
const EXTENSION_BUTTON_ID = 'loom_extension_button';
const EXTENSION_ID = 'loom-ui';
const runtime = globalThis.Loom;
const HOST_EVENTS = Object.freeze([
    'host:chat:changed',
    'host:message:sent',
    'host:message:received',
    'host:character:edited',
    'host:worldinfo:updated',
    'host:generation:started',
    'host:generation:ended',
]);

let eventsWired = false;
let consentView = null;

/**
 * Extension installer.
 *
 * Bundled packages (`extensions/index.json`) load on every boot. User-installed
 * modules are remembered in this extension's persisted state and re-imported on
 * the next boot. Both go through `runtime.importExtension`, so Core keeps
 * identity, dependency and failure handling in one place.
 */
const INSTALLER_SECTION_ID = 'loom_installer';
const INSTALL_STATE_KEY = 'installedExtensions';
const LOOM_ROOT = new URL('../', import.meta.url);
const bundledSources = [];
const installProblems = [];
let installedEntries = [];

function ensureExtension() {
    if (!runtime?.registerExtension || runtime.listExtensions().some(extension => extension.id === EXTENSION_ID)) {
        return;
    }
    runtime.registerExtension({
        id: EXTENSION_ID,
        name: 'Loom UI',
        author: 'loom',
        declaredId: 'ui',
        version: runtime.getRuntimeInfo().version,
        description: 'SillyTavern 面板与 Loom 通用界面系统。',
        content: `loom-ui@${runtime.getRuntimeInfo().version}:panel,components,views,host-snapshot,event-subscriptions,permission-grants`,
    });
}

function installBuiltinComponents() {
    if (listComponents(EXTENSION_ID).length > 0) return;
    for (const component of BUILTIN_COMPONENTS) {
        registerComponent(EXTENSION_ID, component);
    }
}

let installerBooted = false;

function readInstalledEntries() {
    const stored = runtime?.getState?.(EXTENSION_ID, INSTALL_STATE_KEY);
    return Array.isArray(stored) ? stored.filter(entry => entry && typeof entry.entry === 'string') : [];
}

function persistInstalledEntries(list) {
    installedEntries = list;
    runtime?.setState?.(EXTENSION_ID, INSTALL_STATE_KEY, list);
}

async function loadBundledIndex() {
    const url = new URL('extensions/index.json', LOOM_ROOT);
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Package paths in the index are relative to Loom's root, not to the
        // index file itself (`extensions/foo/index.js`, not `foo/index.js`).
        return normalizeIndex(await response.json(), LOOM_ROOT.href);
    } catch {
        // No index is a valid install: Loom can run with bundled packages only.
        return { sources: [], problems: [] };
    }
}

async function fetchManifest(url) {
    if (!url) return null;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const parsed = await response.json();
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

async function importSource(source) {
    const manifest = source.manifest ? await fetchManifest(source.manifest) : null;
    const options = manifest ? { manifest } : {};
    let result;
    try {
        result = await runtime.importExtension(source.entry, options);
    } catch (error) {
        result = { state: 'failed', error: { message: error instanceof Error ? error.message : String(error) } };
    }
    if (result?.state === 'failed' || result?.error) {
        installProblems.push(`${source.id ?? source.entry}: ${result?.error?.message ?? '导入失败'}`);
    }
    return result;
}

async function bootExtensions() {
    if (installerBooted) return;
    installerBooted = true;

    installProblems.length = 0;
    installedEntries = readInstalledEntries();

    const index = await loadBundledIndex();
    bundledSources.push(...index.sources);
    installProblems.push(...index.problems);

    for (const source of bundledSources) {
        await importSource(source);
    }
    for (const entry of installedEntries) {
        if (bundledSources.some(source => source.entry === entry.entry)) continue;
        await importSource({ ...entry, manifest: entry.manifest ?? '', bundled: false });
    }

    renderInstaller();
    renderExtensionStates();
}

async function installExtension(url) {
    const { source, error } = normalizeUserSource(null, url, LOOM_ROOT.href);
    if (error) throw new Error(error);

    const already = installedEntries.find(entry => entry.entry === source.entry);
    if (already?.id && runtime?.getExtensionState?.(already.id)?.state === 'active') {
        return already.entry;
    }

    const result = await importSource({ ...source, manifest: source.manifest ?? '' });
    if (result?.state === 'failed' || result?.error) {
        throw new Error(result?.error?.message ?? '导入失败');
    }
    persistInstalledEntries(rememberInstalled(installedEntries, {
        id: result?.id ?? source.id ?? null,
        entry: source.entry,
        bundled: false,
    }));
    renderInstaller();
    renderExtensionStates();
    return source.entry;
}

async function uninstallExtension(target) {
    const entry = installedEntries.find(item => item.id === target || item.entry === target);
    if (!entry) throw new Error(`未找到已安装扩展：${target}`);
    if (entry.id) runtime?.unloadExtension?.(entry.id);
    persistInstalledEntries(forgetInstalled(installedEntries, target));
    renderInstaller();
    renderExtensionStates();
    return entry.entry;
}

function renderInstaller() {
    const list = document.getElementById(`${INSTALLER_SECTION_ID}_list`);
    const problems = document.getElementById(`${INSTALLER_SECTION_ID}_problems`);
    if (!list) return;

    const sources = [];
    const seen = new Set();
    for (const source of [...bundledSources, ...installedEntries]) {
        if (!source?.entry || seen.has(source.entry)) continue;
        seen.add(source.entry);
        sources.push(source);
    }
    const states = sources.map(source => (source.id ? runtime?.getExtensionState?.(source.id) : null)).filter(Boolean);
    const rows = describeInstalled(sources, states);

    list.innerHTML = rows.length === 0
        ? '<p class="loom_hint">还没有扩展。把扩展目录放进 extensions/ 并运行 npm run extensions:index，或粘贴模块地址手动安装。</p>'
        : rows.map(row => {
            const meta = [row.bundled ? '内置' : '手动安装', row.state].filter(Boolean).join(' · ');
            const remove = row.bundled
                ? ''
                : `<button type="button" class="menu_button" data-loom-uninstall="${escapeHtml(row.id || row.entry)}">移除</button>`;
            return `
                <div class="loom_install_row">
                    <div class="loom_install_main">
                        <strong>${escapeHtml(row.name || row.id || row.entry)}</strong>
                        <span class="loom_hint">${escapeHtml(meta)}</span>
                        ${row.error ? `<span class="loom_install_error">${escapeHtml(row.error)}</span>` : ''}
                    </div>
                    ${remove}
                </div>`;
        }).join('');

    if (problems) {
        problems.innerHTML = installProblems.length === 0
            ? ''
            : `<p class="loom_hint">安装问题：</p>${installProblems.map(problem => `<p class="loom_install_error">${escapeHtml(problem)}</p>`).join('')}`;
    }
}

function mountInstallerSection() {
    if (document.getElementById(INSTALLER_SECTION_ID)) return;
    const content = document.querySelector(`#${PANEL_ID} .loom_panel_content`);
    if (!content) return;

    const section = document.createElement('section');
    section.id = INSTALLER_SECTION_ID;
    section.innerHTML = `
        <h3>扩展安装</h3>
        <div class="loom_installer_controls">
            <input type="text" id="${INSTALLER_SECTION_ID}_url" placeholder="模块地址，例如 extensions/hello-loom/index.js" />
            <button type="button" class="menu_button" id="${INSTALLER_SECTION_ID}_button">安装</button>
        </div>
        <p class="loom_hint">内置扩展随 Loom 加载；手动安装的模块记在本扩展状态里，刷新后自动恢复。</p>
        <div id="${INSTALLER_SECTION_ID}_list"></div>
        <div id="${INSTALLER_SECTION_ID}_problems"></div>
    `;
    content.append(section);

    section.querySelector(`#${INSTALLER_SECTION_ID}_button`)?.addEventListener('click', async event => {
        const input = section.querySelector(`#${INSTALLER_SECTION_ID}_url`);
        const button = event.currentTarget;
        const value = input?.value?.trim() ?? '';
        if (!value) return;
        button.disabled = true;
        try {
            await installExtension(value);
            if (input) input.value = '';
        } catch (error) {
            installProblems.push(error instanceof Error ? error.message : String(error));
            renderInstaller();
        } finally {
            button.disabled = false;
        }
    });
    section.addEventListener('click', async event => {
        const button = event.target.closest('[data-loom-uninstall]');
        if (!button) return;
        button.disabled = true;
        try {
            await uninstallExtension(button.dataset.loomUninstall);
        } catch (error) {
            installProblems.push(error instanceof Error ? error.message : String(error));
            renderInstaller();
        }
    });
}

function installUiApi() {
    if (globalThis.LoomUI) return;
    const ui = Object.freeze({
        ExtensionId: EXTENSION_ID,
        registerComponent: (extensionIdOrComponent, maybeComponent) => (
            typeof extensionIdOrComponent === 'string'
                ? registerComponent(extensionIdOrComponent, maybeComponent)
                : registerComponent(EXTENSION_ID, extensionIdOrComponent)
        ),
        listComponents: (extensionId) => listComponents(extensionId),
        createView: (extensionIdOrOptions, maybeOptions) => (
            typeof extensionIdOrOptions === 'string'
                ? createView(extensionIdOrOptions, maybeOptions)
                : createView(EXTENSION_ID, extensionIdOrOptions)
        ),
        createViewFromSerialized: (extensionIdOrSerialized, serializedOrOptions, maybeOptions) => (
            typeof extensionIdOrSerialized === 'string'
                ? createViewFromSerialized(extensionIdOrSerialized, serializedOrOptions, maybeOptions)
                : createViewFromSerialized(EXTENSION_ID, extensionIdOrSerialized, serializedOrOptions)
        ),
        getView,
        listViews: (extensionId) => listViews(extensionId),
        serializeView: (viewId) => serializeView(viewId),
        serializeNode: (node) => serializeNode(node),
        destroyAllViews: (extensionId) => destroyAllViews(extensionId),
        installExtension: (url) => installExtension(url),
        uninstallExtension: (target) => uninstallExtension(target),
        getInstalledExtensions: () => describeInstalled(
            [...bundledSources, ...installedEntries],
            bundledSources.map(source => runtime?.getExtensionState?.(source.id)).filter(Boolean),
        ),
    });
    globalThis.LoomUI = ui;
    runtime.registerCapability(EXTENSION_ID, {
        id: 'ui.components',
        name: '界面组件目录',
        description: '列出 Loom UI 已注册的组件描述（含属性与事件）。',
        input: { type: 'null' },
        output: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'extensionId', 'name', 'container', 'props', 'events'],
                properties: {
                    id: { type: 'string' },
                    extensionId: { type: 'string' },
                    name: { type: 'string' },
                    container: { type: 'boolean' },
                    props: { type: 'array' },
                    events: { type: 'array' },
                },
            },
        },
        execute: () => listComponents(),
    });
    runtime.registerCapability(EXTENSION_ID, {
        id: 'ui.views',
        name: '活动视图',
        description: '列出当前由 Loom UI 承载的视图及其声明式结构。',
        input: { type: 'null' },
        output: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'extensionId', 'root'],
                properties: {
                    id: { type: 'string' },
                    extensionId: { type: 'string' },
                    root: { type: 'object' },
                },
            },
        },
        execute: () => listViews(),
    });
}

function renderExtensionStates() {
    const container = document.getElementById('loom_extensions');
    if (!container) return;

    const states = runtime?.listExtensionStates?.() ?? [];
    const count = document.getElementById('loom_extension_state_count');
    if (count) {
        const active = states.filter(state => state.state === 'active').length;
        const failed = states.filter(state => state.state === 'failed').length;
        count.textContent = `${active} 激活 · ${failed} 失败`;
    }

    if (states.length === 0) {
        container.innerHTML = '<p class="loom_empty">当前没有已注册扩展。</p>';
        return;
    }

    const stateLabel = {
        loaded: '已装载',
        active: '已激活',
        inactive: '已停用',
        failed: '失败',
        unmanaged: '直接注册',
    };

    container.innerHTML = states.map(state => `
        <div class="loom_extension_state" data-state="${escapeHtml(state.state)}">
            <div class="loom_extension_head">
                <strong>${escapeHtml(state.name)}</strong>
                <span class="loom_extension_id">${escapeHtml(state.id)} · v${escapeHtml(state.version)}</span>
                <span class="loom_extension_badge loom_tone_${state.state === 'failed' ? 'error' : state.state === 'active' ? 'success' : 'muted'}">${escapeHtml(stateLabel[state.state] ?? state.state)}</span>
            </div>
            ${state.dependencies.length > 0 ? `<div class="loom_extension_meta">依赖：${state.dependencies.map(dependency => `<code>${escapeHtml(dependency)}</code>`).join('、')}</div>` : ''}
            ${state.permissions.length > 0 ? `<div class="loom_extension_meta">声明权限：${state.permissions.map(permission => `<code>${escapeHtml(permission)}</code>`).join('、')}</div>` : ''}
            ${state.error ? `<div class="loom_extension_error"><code>${escapeHtml(state.error.code)}</code> ${escapeHtml(state.error.message)}</div>` : ''}
        </div>
    `).join('');
}

function renderCapabilities() {
    const container = document.getElementById('loom_capabilities');
    if (!container) return;

    const capabilities = runtime?.listCapabilities?.() ?? [];
    if (capabilities.length === 0) {
        container.innerHTML = '<p class="loom_empty">当前没有已注册能力。</p>';
        return;
    }

    container.innerHTML = capabilities.map(capability => {
        const permissions = capability.permissions ?? [];
        const permissionLine = permissions.length > 0
            ? `<p class="loom_capability_permissions">需要授权：${permissions.map(permission => `<code>${escapeHtml(permission)}</code>`).join('、')}</p>`
            : '';
        return `
        <details class="loom_capability">
            <summary>
                <span class="loom_capability_title">${escapeHtml(capability.name)}</span>
                <span class="loom_capability_id">${escapeHtml(capability.extensionId)}:${escapeHtml(capability.id)}</span>
            </summary>
            <p>${escapeHtml(capability.description || '暂无说明')}</p>
            ${permissionLine}
            <div class="loom_contracts">
                <div><strong>输入契约</strong><pre>${escapeHtml(JSON.stringify(capability.input, null, 2) ?? 'null')}</pre></div>
                <div><strong>输出契约</strong><pre>${escapeHtml(JSON.stringify(capability.output, null, 2) ?? 'null')}</pre></div>
            </div>
        </details>
    `;
    }).join('');
}

function permissionRows() {
    return summarizePermissions({
        capabilities: runtime?.listCapabilities?.() ?? [],
        extensions: runtime?.listExtensions?.() ?? [],
        granted: runtime?.listPermissions?.() ?? [],
    });
}

function renderPermissions() {
    const container = document.getElementById(PERMISSION_SECTION_ID);
    if (!container) return;

    const rows = permissionRows();
    container.innerHTML = buildPermissionSectionHtml(rows);
    const count = document.getElementById('loom_permission_count');
    if (count) count.textContent = String(countGranted(rows));
}

function ensureConsentContainer() {
    const existing = document.getElementById(CONSENT_CONTAINER_ID);
    if (existing) return existing;
    const container = document.createElement('div');
    container.id = CONSENT_CONTAINER_ID;
    container.className = 'loom_consent';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Loom 权限请求');
    document.body.append(container);
    return container;
}

function resolvePermissionRequest(requestId, approved) {
    try {
        runtime.resolvePermissionRequest(requestId, { approved });
    } catch (error) {
        console.error('[Loom] Failed to resolve permission request:', error);
        return;
    }
    renderConsent();
    renderPermissions();
    updateSettingsEntry();
}

/**
 * Render open permission requests through the Loom UI view engine, so the
 * consent prompt is itself a consumer of the framework instead of hand-written
 * markup. Requests are re-read from Core every time: the prompt never owns state.
 */
function renderConsent() {
    if (!runtime?.listPermissionRequests) return;
    const container = ensureConsentContainer();
    const summaries = summarizeRequests({
        requests: runtime.listPermissionRequests(),
        extensions: runtime.listExtensions(),
        capabilities: runtime.listCapabilities(),
    });
    const root = buildConsentNodes(summaries, {
        approve: requestId => resolvePermissionRequest(requestId, true),
        deny: requestId => resolvePermissionRequest(requestId, false),
    });

    if (!root) {
        consentView?.destroy();
        consentView = null;
        container.hidden = true;
        return;
    }

    container.hidden = false;
    if (consentView) {
        consentView.setRoot(root);
    } else {
        consentView = createView(EXTENSION_ID, { id: CONSENT_VIEW_ID, target: container, root });
    }
}

function togglePermission(button) {
    const permission = button.dataset.permission;
    const extensionId = button.dataset.extension;
    if (!permission || !extensionId || !runtime) return;

    // Read the live grant state from Core instead of the rendered attribute: the
    // DOM can be stale when a grant changed elsewhere (consent prompt, another
    // surface), and a stale attribute would flip the toggle the wrong way.
    const granted = runtime.checkPermission(extensionId, permission);
    try {
        if (granted) runtime.revokePermission(extensionId, permission);
        else runtime.grantPermission(extensionId, permission);
    } catch (error) {
        console.error('[Loom] Failed to change permission grant:', error);
        return;
    }
    renderPermissions();
    updateSettingsEntry();
}

function renderEvents() {
    const container = document.getElementById('loom_events');
    if (!container) return;

    const events = runtime?.listEvents?.() ?? [];
    if (events.length === 0) {
        container.innerHTML = '<p class="loom_empty">暂无事件监听。</p>';
        return;
    }

    container.innerHTML = events.map(event => `
        <div class="loom_event">
            <code>${escapeHtml(event.name)}</code>
            <span>${escapeHtml(event.count)}</span>
        </div>
    `).join('');
}

function renderIdentityConflicts() {
    const count = document.getElementById('loom_identity_conflict_count');
    const container = document.getElementById('loom_identity_conflicts');
    if (!count || !container) return;

    const conflicts = runtime?.listIdentityConflicts?.() ?? [];
    count.textContent = String(conflicts.length);
    if (conflicts.length === 0) {
        container.innerHTML = '<p class="loom_empty">未发现身份冲突。</p>';
        return;
    }

    container.innerHTML = conflicts.map(group => `
        <div class="loom_identity_conflict">
            <strong>${escapeHtml(group.identityKey)}</strong>
            <div class="loom_identity_members">${group.members.map(member => `
                <div class="loom_identity_member">
                    <code>${escapeHtml(member.id)}</code>
                    <span>v${escapeHtml(member.version)}</span>
                    <span>${escapeHtml(member.contentHash || '无内容指纹')}</span>
                </div>
            `).join('')}</div>
        </div>
    `).join('');
}

async function refreshHostSnapshot() {
    const status = document.getElementById('loom_host_status');
    const character = document.getElementById('loom_host_character');
    const chat = document.getElementById('loom_host_chat');
    const messages = document.getElementById('loom_host_messages');
    if (!status || !character || !chat || !messages || !runtime?.executeCapability) return;

    status.textContent = '正在读取宿主环境…';
    const result = await runtime.executeCapability('loom-host', 'context.snapshot', null, { caller: EXTENSION_ID });

    if (!result.success) {
        status.textContent = `宿主不可用：${result.error.message}`;
        character.textContent = '—';
        chat.textContent = '—';
        messages.textContent = '—';
        return;
    }

    const data = result.data;
    status.textContent = '已连接 SillyTavern';
    character.textContent = data.characterName || '未选择角色';
    chat.textContent = data.chatId || '未打开聊天';
    messages.textContent = String(data.messageCount);
}

function renderUiSummary() {
    const container = document.getElementById('loom_ui_summary');
    if (!container) return;
    const components = listComponents();
    const views = listViews();
    container.textContent = `${components.length} 个组件 · ${views.length} 个活动视图`;
}

function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const info = runtime?.getRuntimeInfo?.() ?? {
        name: 'Loom', version: '0.0.0', extensionCount: 0, capabilityCount: 0,
    };
    document.getElementById('loom_version').textContent = info.version;
    document.getElementById('loom_extension_count').textContent = String(info.extensionCount);
    document.getElementById('loom_capability_count').textContent = String(info.capabilityCount);
    const eventCount = document.getElementById('loom_event_count');
    if (eventCount) eventCount.textContent = String(info.eventCount ?? 0);
    renderCapabilities();
    renderEvents();
    renderPermissions();
    renderExtensionStates();
    renderInstaller();
    renderUiSummary();
    renderIdentityConflicts();
    updateSettingsEntry();
    void refreshHostSnapshot().then(updateSettingsEntry);
    void refreshViewport().then(updateSettingsEntry);
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
}

function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
}

async function refreshViewport() {
    const target = document.getElementById('loom_viewport');
    if (!target || !runtime?.executeCapability) return;

    const result = await runtime.executeCapability('loom-host', 'viewport.get', null, { caller: EXTENSION_ID });
    if (!result.success) {
        target.textContent = '—';
        return;
    }
    const { width, height, isMobile } = result.data;
    target.textContent = `${width}×${height}${isMobile ? ' · 移动' : ' · 桌面'}`;
}

function updateSettingsEntry() {
    const entry = document.getElementById(SETTINGS_ENTRY_ID);
    if (!entry) return;

    const info = runtime?.getRuntimeInfo?.() ?? null;
    const conflicts = runtime?.listIdentityConflicts?.() ?? [];
    const panelStatus = document.getElementById('loom_host_status')?.textContent;
    const summary = summarizeForSettings(info, conflicts.length, panelStatus || '未连接');

    const setText = (id, value) => {
        const element = entry.querySelector(`#${id}`);
        if (element) element.textContent = String(value);
    };
    setText('loom_settings_version', summary.version);
    setText('loom_settings_extensions', summary.extensionCount);
    setText('loom_settings_capabilities', summary.capabilityCount);
    setText('loom_settings_conflicts', summary.conflictCount);
    setText('loom_settings_host', summary.hostStatus);
}

function installSettingsEntry() {
    const holder = document.getElementById('extensions_settings');
    if (!holder || document.getElementById(SETTINGS_ENTRY_ID)) return;

    const template = document.createElement('div');
    template.innerHTML = buildSettingsEntryHtml();
    const entry = template.firstElementChild;
    if (!entry) return;
    holder.append(entry);

    // SillyTavern binds a global click handler for .inline-drawer-toggle
    // (script.js), so adding our own would toggle twice.
    entry.querySelector('#loom_settings_open')?.addEventListener('click', renderPanel);
    updateSettingsEntry();
}

function installPanel() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(EXTENSION_BUTTON_ID)) return;

    const container = document.createElement('div');
    container.className = 'extension_container interactable';
    container.innerHTML = `
        <div id="${EXTENSION_BUTTON_ID}" class="list-group-item flex-container flexGap5 interactable" title="Loom">
            <div class="fa-fw fa-solid fa-layer-group extensionsMenuExtensionButton"></div>
            <span>Loom</span>
        </div>
    `;
    const button = container.querySelector(`#${EXTENSION_BUTTON_ID}`);
    button.addEventListener('click', renderPanel);
    menu.append(container);

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = 'loom_panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
        <div class="loom_panel_body">
            <header class="loom_panel_header">
                <div><strong>Loom</strong><span class="loom_subtitle">能力注册表</span></div>
                <div class="loom_panel_actions">
                    <button type="button" class="menu_button" id="loom_refresh" aria-label="刷新 Loom 状态">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                    <button type="button" class="menu_button" id="loom_close" aria-label="关闭 Loom 面板">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </header>
            <div class="loom_panel_content">
                <div class="loom_status"><span>运行时版本</span><strong id="loom_version">0.0.0</strong></div>
                <div class="loom_status"><span>已注册扩展</span><strong id="loom_extension_count">0</strong></div>
                <div class="loom_status"><span>扩展状态</span><strong id="loom_extension_state_count">—</strong></div>
                <div class="loom_status"><span>已注册能力</span><strong id="loom_capability_count">0</strong></div>
                <div class="loom_status"><span>事件监听</span><strong id="loom_event_count">0</strong></div>
                <div class="loom_status"><span>界面系统</span><strong id="loom_ui_summary">—</strong></div>
                <div class="loom_status"><span>视口</span><strong id="loom_viewport">—</strong></div>
                <div class="loom_status"><span>已授权权限</span><strong id="loom_permission_count">0</strong></div>
                <div class="loom_status"><span>身份冲突</span><strong id="loom_identity_conflict_count">0</strong></div>
                <div id="loom_identity_conflicts"></div>
                <h3>扩展</h3>
                <div id="loom_extensions"></div>
                <h3>宿主环境</h3>
                <p class="loom_host" id="loom_host_status">未连接</p>
                <div class="loom_status"><span>当前角色</span><strong id="loom_host_character">—</strong></div>
                <div class="loom_status"><span>当前聊天</span><strong id="loom_host_chat">—</strong></div>
                <div class="loom_status"><span>消息数量</span><strong id="loom_host_messages">—</strong></div>
                <h3>权限</h3>
                <div id="${PERMISSION_SECTION_ID}"></div>
                <h3>事件监听</h3>
                <div id="loom_events"></div>
                <h3>公开能力</h3>
                <div id="loom_capabilities"></div>
            </div>
        </div>
    `;
    document.body.append(panel);
    mountInstallerSection();
    document.getElementById('loom_close').addEventListener('click', closePanel);
    document.getElementById('loom_refresh').addEventListener('click', renderPanel);
    // Delegated: the permission list is re-rendered on every toggle, so bind to
    // the stable container instead of the buttons themselves.
    document.getElementById(PERMISSION_SECTION_ID)?.addEventListener('click', event => {
        const toggle = event.target.closest(`.${PERMISSION_TOGGLE_CLASS}`);
        if (toggle) togglePermission(toggle);
    });
    panel.addEventListener('click', event => {
        if (event.target === panel) closePanel();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closePanel();
    });
}

function wireEvents() {
    if (eventsWired || !runtime?.subscribe) return;
    eventsWired = true;
    const refresh = () => {
        const panel = document.getElementById(PANEL_ID);
        if (panel?.classList.contains('open')) void refreshHostSnapshot();
    };
    for (const eventName of HOST_EVENTS) {
        runtime.subscribe(EXTENSION_ID, eventName, refresh);
    }
    // Consent prompts are driven by Core, not by polling.
    runtime.subscribe(EXTENSION_ID, 'core:permission:requested', () => renderConsent());
    runtime.subscribe(EXTENSION_ID, 'core:permission:resolved', () => {
        renderConsent();
        renderPermissions();
        updateSettingsEntry();
    });
    // Extension lifecycle changes must show up without reopening the panel.
    for (const eventName of [
        'core:extension:loaded',
        'core:extension:activated',
        'core:extension:failed',
        'core:extension:deactivated',
        'core:extension:unloaded',
    ]) {
        runtime.subscribe(EXTENSION_ID, eventName, () => {
            renderExtensionStates();
            updateSettingsEntry();
        });
    }
}

function initialize() {
    ensureExtension();
    installBuiltinComponents();
    installUiApi();
    wireEvents();
    installPanel();
    installSettingsEntry();
    // Catches requests raised before this entry subscribed to the event.
    renderConsent();
    void bootExtensions();
    const settingsReady = document.getElementById(SETTINGS_ENTRY_ID);
    if (!document.getElementById(EXTENSION_BUTTON_ID) || !settingsReady) {
        setTimeout(initialize, 500);
    }
}

jQuery(initialize);