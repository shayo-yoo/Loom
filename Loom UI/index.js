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
import { createView, getView, listViews, destroyAllViews } from './views.js';
import { escapeHtml } from './dom.js';
import { SETTINGS_ENTRY_ID, buildSettingsEntryHtml, summarizeForSettings } from './settings.js';

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
        content: `loom-ui@${runtime.getRuntimeInfo().version}:panel,components,views,host-snapshot,event-subscriptions`,
    });
}

function installBuiltinComponents() {
    if (listComponents(EXTENSION_ID).length > 0) return;
    for (const component of BUILTIN_COMPONENTS) {
        registerComponent(EXTENSION_ID, component);
    }
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
        getView,
        listViews: (extensionId) => listViews(extensionId),
        destroyAllViews: (extensionId) => destroyAllViews(extensionId),
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

function renderCapabilities() {
    const container = document.getElementById('loom_capabilities');
    if (!container) return;

    const capabilities = runtime?.listCapabilities?.() ?? [];
    if (capabilities.length === 0) {
        container.innerHTML = '<p class="loom_empty">当前没有已注册能力。</p>';
        return;
    }

    container.innerHTML = capabilities.map(capability => `
        <details class="loom_capability">
            <summary>
                <span class="loom_capability_title">${escapeHtml(capability.name)}</span>
                <span class="loom_capability_id">${escapeHtml(capability.extensionId)}:${escapeHtml(capability.id)}</span>
            </summary>
            <p>${escapeHtml(capability.description || '暂无说明')}</p>
            <div class="loom_contracts">
                <div><strong>输入契约</strong><pre>${escapeHtml(JSON.stringify(capability.input, null, 2) ?? 'null')}</pre></div>
                <div><strong>输出契约</strong><pre>${escapeHtml(JSON.stringify(capability.output, null, 2) ?? 'null')}</pre></div>
            </div>
        </details>
    `).join('');
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
    const result = await runtime.executeCapability('loom-host', 'context.snapshot', null);

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

    const result = await runtime.executeCapability('loom-host', 'viewport.get', null);
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
                <div class="loom_status"><span>已注册能力</span><strong id="loom_capability_count">0</strong></div>
                <div class="loom_status"><span>事件监听</span><strong id="loom_event_count">0</strong></div>
                <div class="loom_status"><span>界面系统</span><strong id="loom_ui_summary">—</strong></div>
                <div class="loom_status"><span>视口</span><strong id="loom_viewport">—</strong></div>
                <div class="loom_status"><span>身份冲突</span><strong id="loom_identity_conflict_count">0</strong></div>
                <div id="loom_identity_conflicts"></div>
                <h3>宿主环境</h3>
                <p class="loom_host" id="loom_host_status">未连接</p>
                <div class="loom_status"><span>当前角色</span><strong id="loom_host_character">—</strong></div>
                <div class="loom_status"><span>当前聊天</span><strong id="loom_host_chat">—</strong></div>
                <div class="loom_status"><span>消息数量</span><strong id="loom_host_messages">—</strong></div>
                <h3>事件监听</h3>
                <div id="loom_events"></div>
                <h3>公开能力</h3>
                <div id="loom_capabilities"></div>
            </div>
        </div>
    `;
    document.body.append(panel);
    document.getElementById('loom_close').addEventListener('click', closePanel);
    document.getElementById('loom_refresh').addEventListener('click', renderPanel);
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
}

function initialize() {
    ensureExtension();
    installBuiltinComponents();
    installUiApi();
    wireEvents();
    installPanel();
    installSettingsEntry();
    const settingsReady = document.getElementById(SETTINGS_ENTRY_ID);
    if (!document.getElementById(EXTENSION_BUTTON_ID) || !settingsReady) {
        setTimeout(initialize, 500);
    }
}

jQuery(initialize);