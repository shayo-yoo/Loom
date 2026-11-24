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
import { registerCompositeComponent } from './composite.js';
import {
    disposeMessageBlocks,
    listBlocks,
    refreshBlocks,
    registerBlock,
    rerenderBlocks,
} from './blocks.js';
import { SLOTS, listSlotMounts, mountToSlot, unmountFromSlot } from './slots.js';
import {
    describeExternal,
    findExternal,
    forgetExternal,
    normalizeExternalManifest,
    rememberExternal,
    setExternalStatus,
} from './external.js';
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
    normalizeScriptRecords,
    normalizeUserSource,
    rememberInstalled,
    scriptIdFor,
    scriptSlug,
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
const SCRIPT_SECTION_ID = 'loom_scripts';
const INSTALL_STATE_KEY = 'installedExtensions';
const DISABLED_STATE_KEY = 'disabledExtensions';
const SCRIPTS_STATE_KEY = 'scripts';
const LOOM_ROOT = new URL('../', import.meta.url);
const SECTION_STATE_KEY = 'panelSections';
const EXTERNAL_STATE_KEY = 'externalExtensions';
const EXTERNAL_SECTION_ID = 'loom_external';
const EXTERNAL_CONSENT_ID = 'loom_external_consent';
const SECTION_DEFAULTS = Object.freeze({ installer: true, scripts: true });
const bundledSources = [];
const installProblems = [];
let installedEntries = [];
let disabledIds = [];
let scripts = [];
let sectionState = {};
let editingScriptId = null;
let externalRecords = [];

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
let installerReady = false;

function readInstalledEntries() {
    const stored = runtime?.getState?.(EXTENSION_ID, INSTALL_STATE_KEY);
    return Array.isArray(stored) ? stored.filter(entry => entry && typeof entry.entry === 'string') : [];
}

function persistInstalledEntries(list) {
    installedEntries = list;
    runtime?.setState?.(EXTENSION_ID, INSTALL_STATE_KEY, list);
}

function readDisabledIds() {
    const stored = runtime?.getState?.(EXTENSION_ID, DISABLED_STATE_KEY);
    return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : [];
}

function persistDisabledIds(list) {
    disabledIds = [...new Set(list)];
    runtime?.setState?.(EXTENSION_ID, DISABLED_STATE_KEY, disabledIds);
}

function readScripts() {
    return normalizeScriptRecords(runtime?.getState?.(EXTENSION_ID, SCRIPTS_STATE_KEY));
}

function persistScripts(list) {
    scripts = list;
    runtime?.setState?.(EXTENSION_ID, SCRIPTS_STATE_KEY, list);
}

/** Merged, de-duplicated view of bundled and manually installed packages. */
function allSources() {
    const sources = [];
    const seen = new Set();
    for (const source of [...bundledSources, ...installedEntries]) {
        if (!source?.entry || seen.has(source.entry)) continue;
        seen.add(source.entry);
        sources.push(source);
    }
    return sources;
}

function findSource(identity) {
    return allSources().find(source => source.id === identity || source.entry === identity) ?? null;
}

function isDisabled(identity) {
    return disabledIds.includes(identity);
}

/** Section open/closed state is part of the panel's persisted UI state. */
function readSectionState() {
    const stored = runtime?.getState?.(EXTENSION_ID, SECTION_STATE_KEY);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
}

function persistSectionState() {
    runtime?.setState?.(EXTENSION_ID, SECTION_STATE_KEY, { ...sectionState });
}

/**
 * Apply the persisted open/closed state to every section and bind its toggle once.
 * Mounted sections (installer, scripts) create their own `<details>` elements, so
 * this runs again after they mount.
 */
function applySectionState() {
    sectionState = readSectionState();
    for (const details of document.querySelectorAll(`#${PANEL_ID} details.loom_section`)) {
        const id = details.dataset.section;
        details.open = sectionState[id] ?? (SECTION_DEFAULTS[id] === true);
        if (details.dataset.bound === '1') continue;
        details.dataset.bound = '1';
        details.addEventListener('toggle', () => {
            sectionState[id] = details.open;
            persistSectionState();
        });
    }
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

/**
 * Append the package content hash to an entry URL.
 *
 * Browsers cache ES modules per URL, so an edited package kept its old code until the
 * page cache was cleared (or the hash changed in a way the URL saw). The index already
 * carries a hash of the package, so using it here is both cheap and correct: editing a
 * package changes its URL, and reloading picks it up.
 */
function cacheBustedEntry(entry, contentHash) {
    if (typeof entry !== 'string' || !entry) return entry;
    const hash = typeof contentHash === 'string' && contentHash.trim() !== '' ? contentHash : '';
    const [base, fragment] = entry.split('#');
    const url = new URL(base, globalThis.location?.href ?? 'http://localhost/');
    if (hash) url.searchParams.set('v', hash.replace(/^fnv1a64:/, '').slice(0, 16));
    else return entry;
    return `${url.pathname}${url.search}${fragment ? `#${fragment}` : ''}`;
}

async function importSource(source) {
    const manifest = source.manifest ? await fetchManifest(source.manifest) : null;
    // The generated index owns the package fingerprint (manifest + entry source);
    // pass it through so Core registers the real content identity instead of
    // falling back to whatever the module claims.
    const manifestWithHash = manifest || source.contentHash
        ? {
            ...(manifest ?? {}),
            ...(source.author ? { author: source.author } : {}),
            ...(source.contentHash ? { contentHash: source.contentHash } : {}),
        }
        : null;
    const options = manifestWithHash ? { manifest: manifestWithHash } : {};
    let result;
    try {
        result = await runtime.importExtension(cacheBustedEntry(source.entry, source.contentHash), options);
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
    disabledIds = readDisabledIds();
    scripts = readScripts();

    const index = await loadBundledIndex();
    bundledSources.push(...index.sources);
    installProblems.push(...index.problems);

    for (const source of allSources()) {
        if (source.id && isDisabled(source.id)) continue;
        await importSource(source);
    }
    for (const script of scripts) {
        if (script.enabled !== false) await runScript(script);
    }

    installerReady = true;
    renderInstaller();
    renderScripts();
    renderExtensionStates();
    renderExternalConsent();
    renderExternalSection();
}

/** Enable or disable an installed package without touching its files. */
async function setExtensionEnabled(identity, enabled) {
    const source = findSource(identity);
    if (!source) throw new Error(`未找到扩展：${identity}`);
    const state = source.id ? runtime?.getExtensionState?.(source.id) : null;

    if (!enabled) {
        // Idempotent: disabling something that is already unloaded only records
        // the choice, so a double click cannot reach the host.
        if (state) runtime?.unloadExtension?.(source.id);
        persistDisabledIds([...disabledIds, source.id ?? identity]);
    } else {
        persistDisabledIds(disabledIds.filter(id => id !== (source.id ?? identity)));
        // Enabling must work whether the extension is unregistered, inactive, or
        // failed: unload first (idempotent) so a stale loader record cannot make
        // the re-import fail with "already loaded", then import from the source.
        if (source.id) runtime?.unloadExtension?.(source.id);
        await importSource(source);
    }
    renderInstaller();
    renderExtensionStates();
    return Boolean(enabled);
}

/**
 * Reload a package from its source.
 *
 * Browser modules cannot be unloaded, so the dynamic import is cache-busted for
 * manual installs: editing a module file and reloading actually picks up the new
 * code instead of the module the page already holds.
 */
async function reloadExtension(identity) {
    const source = findSource(identity);
    if (!source) throw new Error(`未找到扩展：${identity}`);
    if (source.id) runtime?.unloadExtension?.(source.id);
    persistDisabledIds(disabledIds.filter(id => id !== (source.id ?? identity)));

    const entry = source.bundled
        ? source.entry
        : `${source.entry}${source.entry.includes('?') ? '&' : '?'}loomReload=${Date.now()}`;
    await importSource({ ...source, entry });
    renderInstaller();
    renderExtensionStates();
    return entry;
}

/**
 * Re-read `extensions/index.json` and import anything new or not yet active.
 *
 * This is the "I dropped a package in the folder" button: no page reload, no
 * reinstalling, and disabled packages stay skipped.
 */
async function rescanExtensions() {
    installProblems.length = 0;
    installedEntries = readInstalledEntries();
    disabledIds = readDisabledIds();
    scripts = readScripts();
    externalRecords = readExternalRecords();
    const index = await loadBundledIndex();
    bundledSources.length = 0;
    bundledSources.push(...index.sources);
    installProblems.push(...index.problems);

    for (const source of allSources()) {
        if (source.id && isDisabled(source.id)) continue;
        if (source.id && runtime?.getExtensionState?.(source.id)?.state === 'active') continue;
        await importSource(source);
    }
    renderInstaller();
    renderScripts();
    renderExtensionStates();
    return allSources().map(source => source.id).filter(Boolean);
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
        name: result?.name ?? source.name ?? null,
        version: result?.version ?? '',
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
    persistDisabledIds(disabledIds.filter(id => id !== target));
    renderInstaller();
    renderExtensionStates();
    return entry.entry;
}

/**
 * Scripts — the lightweight form of an extension.
 *
 * A script is a module source kept in Loom's own state and imported through a
 * Blob URL: no package directory, no manifest file. It still gets a real
 * extension id (so permissions, state, errors and unload behave like any other
 * extension), but the author only writes hooks. No sandbox is implied: this is a
 * local loader, not a hostile-code boundary.
 */
function slugFor(name) {
    return scriptSlug(name);
}

function nextScriptId(name) {
    return scriptIdFor(name, scripts.map(script => script.id));
}

async function runScript(record) {
    if (typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
        installProblems.push(`${record.name ?? record.id}: 当前环境不支持 Blob 模块`);
        return null;
    }
    const url = URL.createObjectURL(new Blob([record.source], { type: 'text/javascript' }));
    try {
        const result = await runtime.importExtension(url, {
            // Identity comes from the script record, so the source only needs hooks.
            // `content` lets Core fingerprint the actual source text.
            manifest: {
                id: record.id,
                name: record.name || record.id,
                version: '0.0.0',
                dependencies: [],
                permissions: [],
                content: record.source,
            },
        });
        if (result?.state === 'failed' || result?.error) {
            installProblems.push(`${record.name ?? record.id}: ${result?.error?.message ?? '脚本运行失败'}`);
        }
        return result;
    } catch (error) {
        installProblems.push(`${record.name ?? record.id}: ${error instanceof Error ? error.message : String(error)}`);
        return { state: 'failed', error: { message: error instanceof Error ? error.message : String(error) } };
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function saveScript(name, source) {
    const trimmed = String(source ?? '').trim();
    if (!trimmed) throw new Error('脚本内容为空。');
    const record = { id: nextScriptId(name), name: String(name ?? '').trim() || '未命名脚本', source: trimmed, enabled: true };
    const result = await runScript(record);
    if (result?.state === 'failed' || result?.error) {
        throw new Error(`脚本运行失败：${result?.error?.message ?? '未知错误'}`);
    }
    persistScripts([...scripts, record]);
    renderScripts();
    renderInstaller();
    return record.id;
}

/** Enable or disable a saved script; the source is kept either way. */
async function setScriptEnabled(id, enabled) {
    const index = scripts.findIndex(script => script.id === id);
    if (index < 0) throw new Error(`未找到脚本：${id}`);
    const next = { ...scripts[index], enabled: Boolean(enabled) };
    if (next.enabled) {
        // Enabling must work whether the script is unregistered, inactive or failed.
        // Without the unload a stale registration makes the import fail with
        // "Extension is already loaded" (same class of bug as re-enabling a package).
        runtime?.unloadExtension?.(id);
        const result = await runScript(next);
        if (result?.state === 'failed' || result?.error) {
            throw new Error(`脚本运行失败：${result?.error?.message ?? '未知错误'}`);
        }
    } else {
        runtime?.unloadExtension?.(id);
    }
    const list = [...scripts];
    list[index] = next;
    persistScripts(list);
    renderScripts();
    return Boolean(enabled);
}

async function updateScript(id, source) {
    const index = scripts.findIndex(script => script.id === id);
    if (index < 0) throw new Error(`未找到脚本：${id}`);
    const previous = scripts[index];
    const next = { ...previous, source: String(source ?? '').trim() };
    if (!next.source) throw new Error('脚本内容为空。');
    runtime?.unloadExtension?.(id);
    const result = await runScript(next);
    if (result?.state === 'failed' || result?.error) {
        // Keep the known-good source running and report the failure.
        await runScript(previous);
        throw new Error(`脚本运行失败：${result?.error?.message ?? '未知错误'}`);
    }
    const list = [...scripts];
    list[index] = next;
    persistScripts(list);
    renderScripts();
    return id;
}

async function deleteScript(id) {
    if (!scripts.some(script => script.id === id)) throw new Error(`未找到脚本：${id}`);
    runtime?.unloadExtension?.(id);
    persistScripts(scripts.filter(script => script.id !== id));
    renderScripts();
    renderInstaller();
    return id;
}

function renderScripts() {
    const list = document.getElementById(`${SCRIPT_SECTION_ID}_list`);
    if (!list) return;
    list.innerHTML = scripts.length === 0
        ? '<p class="loom_hint">还没有脚本。写一个小模块即可，不必建扩展目录。</p>'
        : scripts.map(script => {
            const state = runtime?.getExtensionState?.(script.id);
            const status = script.enabled === false ? '已停用' : (state?.state ?? '未运行');
            const error = state?.error?.message ?? '';
            return `
                <div class="loom_install_row">
                    <div class="loom_install_main">
                        <strong>${escapeHtml(script.name)}</strong>
                        <span class="loom_hint">${escapeHtml(script.id)} · ${escapeHtml(status)}</span>
                        ${error ? `<span class="loom_install_error">${escapeHtml(error)}</span>` : ''}
                    </div>
                    <button type="button" class="menu_button" data-script-toggle="${escapeHtml(script.id)}" data-enabled="${script.enabled !== false}">${script.enabled === false ? '启用' : '停用'}</button>
                    <button type="button" class="menu_button" data-script-edit="${escapeHtml(script.id)}">编辑</button>
                    <button type="button" class="menu_button" data-script-run="${escapeHtml(script.id)}">重新运行</button>
                    <button type="button" class="menu_button" data-script-delete="${escapeHtml(script.id)}">删除</button>
                </div>`;
        }).join('');
}

function renderInstaller() {
    const list = document.getElementById(`${INSTALLER_SECTION_ID}_list`);
    const problems = document.getElementById(`${INSTALLER_SECTION_ID}_problems`);
    if (!list) return;

    const sources = allSources();
    const states = sources.map(source => (source.id ? runtime?.getExtensionState?.(source.id) : null)).filter(Boolean);
    const rows = describeInstalled(sources, states);

    list.innerHTML = rows.length === 0
        ? '<p class="loom_hint">还没有扩展。把扩展目录放进 extensions/ 并运行 npm run extensions:index，或粘贴模块地址手动安装。</p>'
        : rows.map(row => {
            const disabled = isDisabled(row.id);
            const detail = [
                row.author ? `作者：${row.author}` : '',
                row.version ? `v${row.version}` : '',
                row.bundled ? '内置' : '手动安装',
                disabled ? '已停用' : row.state,
                row.permissions.length ? `权限：${row.permissions.join('、')}` : '',
                row.dependencies.length ? `依赖：${row.dependencies.join('、')}` : '',
            ].filter(Boolean).join(' · ');
            const toggle = row.id
                ? `<button type="button" class="menu_button" data-loom-toggle="${escapeHtml(row.id)}" data-enabled="${!disabled}">${disabled ? '启用' : '停用'}</button>`
                : '';
            const reload = row.id
                ? `<button type="button" class="menu_button" data-loom-reload="${escapeHtml(row.id)}">重新加载</button>`
                : '';
            const remove = row.bundled
                ? ''
                : `<button type="button" class="menu_button" data-loom-uninstall="${escapeHtml(row.id || row.entry)}">移除</button>`;
            return `
                <div class="loom_install_row">
                    <div class="loom_install_main">
                        <strong>${escapeHtml(row.name || row.id || row.entry)}</strong>
                        <span class="loom_hint">${escapeHtml(detail)}</span>
                        ${row.error ? `<span class="loom_install_error">${escapeHtml(row.error)}</span>` : ''}
                    </div>
                    ${toggle}${reload}${remove}
                </div>`;
        }).join('');

    if (problems) {
        problems.innerHTML = installProblems.length === 0
            ? ''
            : `<p class="loom_hint">安装问题：</p>${installProblems.map(problem => `<p class="loom_install_error">${escapeHtml(problem)}</p>`).join('')}`;
    }
}

/**
 * Turn a mounted section into a collapsible one without rewriting its markup:
 * the existing children move into a body and the heading becomes the summary.
 */
function wrapMountedSection(details, title) {
    const body = document.createElement('div');
    body.className = 'loom_section_body';
    while (details.firstChild) body.append(details.firstChild);
    const heading = body.querySelector('h3');
    if (heading) heading.remove();
    const summary = document.createElement('summary');
    summary.textContent = title;
    details.append(summary, body);
}

function mountInstallerSection() {
    if (document.getElementById(INSTALLER_SECTION_ID)) return;
    const content = document.querySelector(`#${PANEL_ID} .loom_panel_content`);
    if (!content) return;

    const section = document.createElement('details');
    section.className = 'loom_section';
    section.dataset.section = 'installer';
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
    wrapMountedSection(section, '安装与扩展');
    content.append(section);

    const rescanButton = document.createElement('button');
    rescanButton.type = 'button';
    rescanButton.className = 'menu_button';
    rescanButton.textContent = '重新扫描';
    rescanButton.title = '重新读取 extensions/index.json 并导入新增的扩展';
    rescanButton.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await rescanExtensions();
        } catch (error) {
            installProblems.push(error instanceof Error ? error.message : String(error));
            renderInstaller();
        } finally {
            button.disabled = false;
        }
    });
    section.querySelector('.loom_installer_controls')?.append(rescanButton);

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
        const uninstall = event.target.closest('[data-loom-uninstall]');
        const toggle = event.target.closest('[data-loom-toggle]');
        const reload = event.target.closest('[data-loom-reload]');
        try {
            if (uninstall) {
                uninstall.disabled = true;
                await uninstallExtension(uninstall.dataset.loomUninstall);
            } else if (toggle) {
                toggle.disabled = true;
                await setExtensionEnabled(toggle.dataset.loomToggle, toggle.dataset.enabled !== 'true');
            } else if (reload) {
                reload.disabled = true;
                await reloadExtension(reload.dataset.loomReload);
            }
        } catch (error) {
            installProblems.push(error instanceof Error ? error.message : String(error));
            renderInstaller();
        }
    });
}

function mountExternalSection() {
    if (document.getElementById(EXTERNAL_SECTION_ID)) return;
    const content = document.querySelector(`#${PANEL_ID} .loom_panel_content`);
    if (!content) return;

    const section = document.createElement('details');
    section.className = 'loom_section';
    section.dataset.section = 'external';
    section.id = EXTERNAL_SECTION_ID;
    section.innerHTML = `
        <h3>第三方扩展</h3>
        <p class="loom_hint">运行时自行注册的扩展（不在 extensions 索引里）。首次出现需要用户确认；确认结果会被记住。</p>
        <div id="${EXTERNAL_SECTION_ID}_list"></div>
    `;
    wrapMountedSection(section, '第三方扩展');
    content.append(section);

    section.addEventListener('click', event => {
        const approve = event.target.closest('[data-external-approve]');
        const remove = event.target.closest('[data-external-remove]');
        try {
            if (approve) approveExternal(approve.dataset.externalApprove);
            else if (remove) removeExternal(remove.dataset.externalRemove);
        } catch (error) {
            installProblems.push(error instanceof Error ? error.message : String(error));
            renderExternalSection();
        }
    });
}

function mountExternalConsent() {
    if (document.getElementById(EXTERNAL_CONSENT_ID)) return;
    const container = document.createElement('div');
    container.id = EXTERNAL_CONSENT_ID;
    container.className = 'loom_external';
    container.hidden = true;
    document.body.append(container);
    container.addEventListener('click', event => {
        const approve = event.target.closest('[data-external-approve]');
        const deny = event.target.closest('[data-external-deny]');
        try {
            if (approve) approveExternal(approve.dataset.externalApprove);
            else if (deny) denyExternal(deny.dataset.externalDeny);
        } catch (error) {
            installProblems.push(error instanceof Error ? error.message : String(error));
            renderExternalConsent();
        }
    });
}

function mountScriptSection() {
    if (document.getElementById(SCRIPT_SECTION_ID)) return;
    const content = document.querySelector(`#${PANEL_ID} .loom_panel_content`);
    if (!content) return;

    const section = document.createElement('details');
    section.className = 'loom_section';
    section.dataset.section = 'scripts';
    section.id = SCRIPT_SECTION_ID;
    section.innerHTML = `
        <h3>脚本</h3>
        <p class="loom_hint">一个文件就是一个功能：module 默认导出 activate/deactivate 即可，无需扩展目录与清单。运行后拥有自己的扩展身份。</p>
        <div class="loom_installer_controls">
            <input type="text" id="${SCRIPT_SECTION_ID}_name" placeholder="脚本名称" />
        </div>
        <textarea id="${SCRIPT_SECTION_ID}_source" class="loom-textarea" rows="6" placeholder="export default { activate({ id }) { Loom.setState(id, 'ran', true); } };"></textarea>
        <div class="loom_installer_controls">
            <button type="button" class="menu_button" id="${SCRIPT_SECTION_ID}_save">保存并运行</button>
            <span class="loom_hint" id="${SCRIPT_SECTION_ID}_status"></span>
        </div>
        <div id="${SCRIPT_SECTION_ID}_list"></div>
    `;
    wrapMountedSection(section, '脚本');
    content.append(section);

    section.querySelector(`#${SCRIPT_SECTION_ID}_save`)?.addEventListener('click', async event => {
        const button = event.currentTarget;
        const name = section.querySelector(`#${SCRIPT_SECTION_ID}_name`)?.value ?? '';
        const source = section.querySelector(`#${SCRIPT_SECTION_ID}_source`)?.value ?? '';
        const status = section.querySelector(`#${SCRIPT_SECTION_ID}_status`);
        button.disabled = true;
        try {
            if (editingScriptId) {
                await updateScript(editingScriptId, source);
                if (status) status.textContent = '已保存修改并重新运行。';
                editingScriptId = null;
                button.textContent = '保存并运行';
                const nameField = section.querySelector(`#${SCRIPT_SECTION_ID}_name`);
                if (nameField) nameField.value = '';
            } else {
                await saveScript(name, source);
                if (status) status.textContent = '已保存并运行。';
            }
            const sourceField = section.querySelector(`#${SCRIPT_SECTION_ID}_source`);
            if (sourceField) sourceField.value = '';
        } catch (error) {
            if (status) status.textContent = error instanceof Error ? error.message : String(error);
        } finally {
            button.disabled = false;
        }
    });

    section.addEventListener('click', async event => {
        const run = event.target.closest('[data-script-run]');
        const toggle = event.target.closest('[data-script-toggle]');
        const edit = event.target.closest('[data-script-edit]');
        const remove = event.target.closest('[data-script-delete]');
        try {
            if (run) {
                run.disabled = true;
                const record = scripts.find(script => script.id === run.dataset.scriptRun);
                if (record) {
                    runtime?.unloadExtension?.(record.id);
                    const result = await runScript(record);
                    if (result?.state === 'failed') throw new Error(result.error?.message ?? '运行失败');
                }
                renderScripts();
                renderInstaller();
            } else if (toggle) {
                toggle.disabled = true;
                await setScriptEnabled(toggle.dataset.scriptToggle, toggle.dataset.enabled !== 'true');
            } else if (edit) {
                const record = scripts.find(script => script.id === edit.dataset.scriptEdit);
                if (record) {
                    editingScriptId = record.id;
                    const nameField = section.querySelector(`#${SCRIPT_SECTION_ID}_name`);
                    const sourceField = section.querySelector(`#${SCRIPT_SECTION_ID}_source`);
                    const saveButton = section.querySelector(`#${SCRIPT_SECTION_ID}_save`);
                    const status = section.querySelector(`#${SCRIPT_SECTION_ID}_status`);
                    if (nameField) nameField.value = record.name;
                    if (sourceField) sourceField.value = record.source;
                    if (saveButton) saveButton.textContent = '保存修改';
                    if (status) status.textContent = `正在编辑 ${record.id}`;
                }
            } else if (remove) {
                remove.disabled = true;
                if (remove.dataset.scriptDelete === editingScriptId) {
                    editingScriptId = null;
                    const saveButton = section.querySelector(`#${SCRIPT_SECTION_ID}_save`);
                    if (saveButton) saveButton.textContent = '保存并运行';
                }
                await deleteScript(remove.dataset.scriptDelete);
            }
        } catch (error) {
            const status = section.querySelector(`#${SCRIPT_SECTION_ID}_status`);
            if (status) status.textContent = error instanceof Error ? error.message : String(error);
            renderScripts();
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
        registerCompositeComponent: (extensionIdOrDefinition, maybeDefinition) => (
            typeof extensionIdOrDefinition === 'string'
                ? registerCompositeComponent(extensionIdOrDefinition, maybeDefinition)
                : registerCompositeComponent(EXTENSION_ID, extensionIdOrDefinition)
        ),
        slots: Object.freeze({ ...SLOTS }),
        registerBlock: (extensionIdOrDefinition, maybeDefinition) => (
            typeof extensionIdOrDefinition === 'string'
                ? registerBlock(extensionIdOrDefinition, maybeDefinition)
                : registerBlock(EXTENSION_ID, extensionIdOrDefinition)
        ),
        listBlocks: (extensionId) => listBlocks(extensionId),
        refreshBlocks: (root) => refreshBlocks(root),
        rerenderBlocks: (extensionId) => rerenderBlocks(extensionId),
        disposeMessageBlocks: (messageId) => disposeMessageBlocks(messageId),
        mountToSlot: (extensionIdOrSlot, slotOrOptions, maybeOptions) => (
            typeof extensionIdOrSlot === 'string' && Object.hasOwn(SLOTS, extensionIdOrSlot)
                ? mountToSlot(EXTENSION_ID, extensionIdOrSlot, slotOrOptions)
                : mountToSlot(extensionIdOrSlot, slotOrOptions, maybeOptions)
        ),
        unmountFromSlot: (extensionIdOrSlot, maybeSlot) => (
            maybeSlot === undefined ? unmountFromSlot(EXTENSION_ID, extensionIdOrSlot) : unmountFromSlot(extensionIdOrSlot, maybeSlot)
        ),
        listSlotMounts: (extensionId) => listSlotMounts(extensionId),
        registerExternal: (manifest) => registerExternal(manifest),
        approveExternal: (id) => approveExternal(id),
        denyExternal: (id) => denyExternal(id),
        removeExternal: (id) => removeExternal(id),
        listExternalExtensions: () => describeExternal(externalRecords, runtime.listExtensionStates()),
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
            allSources(),
            allSources().map(source => runtime?.getExtensionState?.(source.id)).filter(Boolean),
        ),
        setExtensionEnabled: (id, enabled) => setExtensionEnabled(id, enabled),
        reloadExtension: (id) => reloadExtension(id),
        saveScript: (name, source) => saveScript(name, source),
        setScriptEnabled: (id, enabled) => setScriptEnabled(id, enabled),
        updateScript: (id, source) => updateScript(id, source),
        deleteScript: (id) => deleteScript(id),
        listScripts: () => scripts.map(script => ({ id: script.id, name: script.name, length: script.source.length })),
        getInstallProblems: () => [...installProblems],
        isReady: () => installerReady,
        rescanExtensions: () => rescanExtensions(),
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

/**
 * External (self-registering) extension consent.
 *
 * A third party calls `LoomUI.registerExternal(manifest)`; until the user approves
 * the record nothing is registered. The prompt lives in the same container the
 * permission consent uses, below it, so a user answers both in one place.
 */
function readExternalRecords() {
    const stored = runtime?.getState?.(EXTENSION_ID, EXTERNAL_STATE_KEY);
    return Array.isArray(stored) ? stored.filter(record => record && typeof record.id === 'string') : [];
}

function persistExternalRecords(list) {
    externalRecords = list;
    runtime?.setState?.(EXTENSION_ID, EXTERNAL_STATE_KEY, list);
}

function renderExternalConsent() {
    const container = document.getElementById(EXTERNAL_CONSENT_ID);
    if (!container) return;
    const pending = externalRecords.filter(record => record.status === 'pending');
    if (pending.length === 0) {
        container.hidden = true;
        container.replaceChildren();
        return;
    }

    container.hidden = false;
    container.innerHTML = `
        <div class="loom-card loom_external_consent">
            <strong>第三方扩展请求注册</strong>
            <p class="loom_hint">这些代码不在 Loom 的扩展索引中，是运行时自行注册的。批准后才会生效，选择会被记住。</p>
            ${pending.map(record => `
                <div class="loom_external_item" data-external="${escapeHtml(record.id)}">
                    <div class="loom_install_main">
                        <strong>${escapeHtml(record.name)}</strong>
                        <span class="loom_hint">${escapeHtml(record.id)} · v${escapeHtml(record.version)}${record.author ? ` · ${escapeHtml(record.author)}` : ''}</span>
                        ${record.description ? `<span class="loom_hint">${escapeHtml(record.description)}</span>` : ''}
                        <span class="loom_hint">权限：${record.permissions.length ? escapeHtml(record.permissions.join('、')) : '无'}</span>
                    </div>
                    <button type="button" class="menu_button" data-external-approve="${escapeHtml(record.id)}">允许</button>
                    <button type="button" class="menu_button" data-external-deny="${escapeHtml(record.id)}">拒绝</button>
                </div>
            `).join('')}
        </div>
    `;
}

/**
 * Request registration of an external extension.
 *
 * Returns `{ id, status }`. `pending` means the user must answer; `approved`
 * means the record was already approved and the caller may register now.
 */
function registerExternal(manifest) {
    const normalized = normalizeExternalManifest(manifest);
    const existing = findExternal(externalRecords, normalized.id);
    if (existing?.status === 'denied') {
        throw new Error(`外部扩展 ${normalized.id} 已被拒绝；先在面板中清除记录再重试。`);
    }
    persistExternalRecords(rememberExternal(externalRecords, normalized));
    const record = findExternal(externalRecords, normalized.id);
    renderExternalConsent();
    renderExternalSection();
    return { id: normalized.id, status: record.status };
}

/** Approve a pending record and register it with Core. */
function approveExternal(id) {
    const record = findExternal(externalRecords, id);
    if (!record) throw new Error(`未找到外部扩展：${id}`);
    persistExternalRecords(setExternalStatus(externalRecords, id, 'approved'));
    if (!runtime.listExtensions().some(entry => entry.id === id)) {
        runtime.registerExtension({
            id: record.id,
            name: record.name,
            version: record.version,
            author: record.author || undefined,
            description: record.description,
            origin: 'external',
        });
    }
    for (const permission of record.permissions) {
        try {
            runtime.requestPermission(id, permission, { reason: `第三方扩展 ${record.name} 声明了该权限` });
        } catch {
            // A permission request must never block approval.
        }
    }
    renderExternalConsent();
    renderExternalSection();
    renderExtensionStates();
    return true;
}

function denyExternal(id) {
    if (!findExternal(externalRecords, id)) throw new Error(`未找到外部扩展：${id}`);
    persistExternalRecords(setExternalStatus(externalRecords, id, 'denied'));
    if (runtime.listExtensions().some(entry => entry.id === id)) runtime.unregisterExtension(id);
    renderExternalConsent();
    renderExternalSection();
    return true;
}

/** Forget a record entirely (the extension will have to ask again). */
function removeExternal(id) {
    if (runtime.listExtensions().some(entry => entry.id === id)) runtime.unregisterExtension(id);
    persistExternalRecords(forgetExternal(externalRecords, id));
    renderExternalConsent();
    renderExternalSection();
    return true;
}

function renderExternalSection() {
    const list = document.getElementById(`${EXTERNAL_SECTION_ID}_list`);
    if (!list) return;
    const rows = describeExternal(externalRecords, runtime.listExtensionStates());
    list.innerHTML = rows.length === 0
        ? '<p class="loom_hint">没有第三方自注册扩展。扩展可以通过 LoomUI.registerExternal 请求注册。</p>'
        : rows.map(row => {
            const statusLabel = { pending: '待确认', approved: '已允许', denied: '已拒绝' }[row.status] ?? row.status;
            const detail = [
                `v${row.version}`, statusLabel, row.registered ? '运行中' : '未运行',
                row.permissions.length ? `权限：${row.permissions.join('、')}` : '',
            ].filter(Boolean).join(' · ');
            return `
                <div class="loom_install_row">
                    <div class="loom_install_main">
                        <strong>${escapeHtml(row.name)}</strong>
                        <span class="loom_hint">${escapeHtml(row.id)}${row.author ? ` · ${escapeHtml(row.author)}` : ''}</span>
                        <span class="loom_hint">${escapeHtml(detail)}</span>
                        ${row.error ? `<span class="loom_install_error">${escapeHtml(row.error)}</span>` : ''}
                    </div>
                    ${row.status === 'denied' ? `<button type="button" class="menu_button" data-external-approve="${escapeHtml(row.id)}">改判允许</button>` : ''}
                    <button type="button" class="menu_button" data-external-remove="${escapeHtml(row.id)}">清除记录</button>
                </div>`;
        }).join('');
}

function togglePermission(button) {    const permission = button.dataset.permission;
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
    renderExternalSection();
    renderExternalConsent();
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
                <details class="loom_section" data-section="extensions">
                    <summary>扩展状态</summary>
                    <div class="loom_section_body"><div id="loom_extensions"></div></div>
                </details>
                <details class="loom_section" data-section="host">
                    <summary>宿主环境</summary>
                    <div class="loom_section_body">
                        <p class="loom_host" id="loom_host_status">未连接</p>
                        <div class="loom_status"><span>当前角色</span><strong id="loom_host_character">—</strong></div>
                        <div class="loom_status"><span>当前聊天</span><strong id="loom_host_chat">—</strong></div>
                        <div class="loom_status"><span>消息数量</span><strong id="loom_host_messages">—</strong></div>
                    </div>
                </details>
                <details class="loom_section" data-section="permissions">
                    <summary>权限</summary>
                    <div class="loom_section_body"><div id="${PERMISSION_SECTION_ID}"></div></div>
                </details>
                <details class="loom_section" data-section="events">
                    <summary>事件监听</summary>
                    <div class="loom_section_body"><div id="loom_events"></div></div>
                </details>
                <details class="loom_section" data-section="capabilities">
                    <summary>公开能力</summary>
                    <div class="loom_section_body"><div id="loom_capabilities"></div></div>
                </details>
            </div>
        </div>
    `;
    document.body.append(panel);
    mountInstallerSection();
    mountScriptSection();
    mountExternalSection();
    mountExternalConsent();
    applySectionState();
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
    // Display blocks are drawn from message text, so a new or changed message needs
    // a re-render. Both events are already bridged; refreshing is proportional to the
    // messages that actually contain a block.
    for (const eventName of ['host:message:received', 'host:chat:changed']) {
        runtime.subscribe(EXTENSION_ID, eventName, () => {
            setTimeout(() => {
                try {
                    refreshBlocks();
                } catch (error) {
                    console.error('[Loom] Block refresh failed:', error);
                }
            }, 0);
        });
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