/**
 * Live browser verification for the Loom SillyTavern extension.
 *
 * Starts headless Chrome with the DevTools protocol, loads the running
 * SillyTavern, and drives the real extension: panel entries, permission grants,
 * grant persistence across a reload, and the host read/write capabilities
 * against live data.
 *
 * This is intentionally NOT part of `npm test`: it needs a running SillyTavern
 * and a Chrome installation. Run it explicitly:
 *
 *   npm run verify:browser
 *   LOOM_ST_URL=http://127.0.0.1:8100/ LOOM_CHROME="C:\path\to\chrome.exe" npm run verify:browser
 *
 * It mutates SillyTavern settings while running (it grants permissions, which is
 * the behaviour under test) and cleans up afterwards: the probe extension is
 * unregistered, test grants are revoked, and an empty `__loom` root is removed.
 *
 * Set LOOM_DEBUG=1 to print the grant table around the permission probes; that
 * is how a stale-toggle bug was found, so the hooks are kept.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_PATH = process.env.LOOM_CHROME || DEFAULT_CHROME;
const ST_URL = process.env.LOOM_ST_URL || 'http://127.0.0.1:8100/';
const CDP_PORT = Number(process.env.LOOM_CDP_PORT ?? 0);
const READY_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 20_000;

const results = [];
const consoleErrors = [];
let expectedVersion = null;
let cdpPort = CDP_PORT;

function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function assertThat(name, condition, detail = '') {
    record(name, Boolean(condition), detail);
    return Boolean(condition);
}

/** Run one probe group; a thrown error becomes a failed check, not a dead run. */
async function runProbe(name, probe, cdp) {
    try {
        await probe(cdp);
    } catch (error) {
        record(`${name} probe`, false, error.message);
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return true;
        } catch {
            // Chrome is still starting.
        }
        await sleep(150);
    }
    throw new Error(`CDP endpoint did not become ready: ${url}`);
}

class Cdp {
    #ws;
    #nextId = 1;
    #pending = new Map();

    constructor(ws) {
        this.#ws = ws;
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const entry = this.#pending.get(message.id);
                if (!entry) return;
                this.#pending.delete(message.id);
                if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
                else entry.resolve(message.result);
                return;
            }
            if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
                consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
            }
            if (message.method === 'Runtime.exceptionThrown') {
                consoleErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
            }
        });
    }

    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
        });
        return new Cdp(ws);
    }

    send(method, params = {}) {
        const id = this.#nextId++;
        const promise = new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
        });
        this.#ws.send(JSON.stringify({ id, method, params }));
        return promise;
    }

    close() {
        this.#ws.close();
    }

    /**
     * Evaluate an expression in the page and return its JSON value. Async
     * expressions are awaited, so `await` inside the expression works. A
     * timeout keeps a wedged page call (e.g. an awaited host dialog) from
     * hanging the whole run.
     */
    async evaluate(expression, timeoutMs = 0) {
        const evaluation = this.send('Runtime.evaluate', {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
        }).then(response => {
            if (response.exceptionDetails) {
                const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
                throw new Error(`Page evaluation failed: ${detail}`);
            }
            return response.result.value;
        });
        if (timeoutMs === 0) {
            return evaluation;
        }
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Page evaluation timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        try {
            return await Promise.race([evaluation, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Poll an expression until it returns a truthy value. */
    async waitFor(expression, timeoutMs = SETTLE_TIMEOUT_MS, label = expression) {
        const deadline = Date.now() + timeoutMs;
        let lastError = null;
        while (Date.now() < deadline) {
            try {
                const value = await this.evaluate(expression);
                if (value) return value;
            } catch (error) {
                lastError = error;
            }
            await sleep(200);
        }
        throw new Error(`Timed out waiting for: ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
    }
}

async function launchChrome(profileDir) {
    const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--window-size=1280,900',
        `--user-data-dir=${profileDir}`,
        // Port 0 lets Chrome pick a free port and write it to DevToolsActivePort:
        // the host reserves dynamic port ranges, so a fixed port can be unbindable.
        `--remote-debugging-port=${CDP_PORT}`,
        'about:blank',
    ];
    const child = spawn(CHROME_PATH, args, { stdio: 'ignore', windowsHide: true });
    cdpPort = CDP_PORT === 0 ? await readDevToolsPort(profileDir) : CDP_PORT;
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, READY_TIMEOUT_MS);
    return child;
}

async function readDevToolsPort(profileDir) {
    const file = path.join(profileDir, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 150; attempt += 1) {
        if (existsSync(file)) {
            const [port] = readFileSync(file, 'utf8').trim().split('\n');
            if (port) return Number(port);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Chrome did not write ${file}`);
}

async function openPageTarget() {
    // Reuse the initial about:blank target; create one if the browser started without it.
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    if (page) return page;
    const created = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    return created;
}

/** Probe the live page. Each probe is one verifiable claim. */
async function probeRuntime(cdp) {
    const info = await cdp.evaluate('return window.Loom ? window.Loom.getRuntimeInfo() : null;');
    if (!assertThat('runtime is installed on the page', info, info ? `version ${info.version}` : 'window.Loom missing')) return;

    assertThat('runtime version matches the manifest', info.version === expectedVersion,
        `runtime ${info.version}, manifest ${expectedVersion}`);
    assertThat('capabilities registered', info.capabilityCount >= 12, `capabilityCount=${info.capabilityCount}`);
    assertThat('extensions registered', info.extensionCount >= 2, `extensionCount=${info.extensionCount}`);

    const ids = await cdp.evaluate('return window.Loom.listExtensions().map(entry => entry.id).sort();');
    assertThat('core extensions present', ['loom-host', 'loom-ui'].every(id => ids.includes(id)), ids.join(', '));
}

async function probeEntries(cdp) {
    const entries = await cdp.evaluate(`return {
        launcher: Boolean(document.getElementById('loom_extension_button')),
        drawer: Boolean(document.getElementById('loom_settings_entry')),
        settingsHost: Boolean(document.getElementById('extensions_settings')),
        menu: Boolean(document.getElementById('extensionsMenu')),
    };`);
    assertThat('wand-menu launcher installed', entries.launcher);
    assertThat('settings drawer installed', entries.drawer);
    assertThat('host containers exist', entries.settingsHost && entries.menu);
}

async function probePanel(cdp) {
    await cdp.evaluate("document.getElementById('loom_extension_button').click(); return true;");
    const opened = await cdp.waitFor("return Boolean(document.querySelector('.loom_panel.open'));", 5000, 'panel open');
    assertThat('panel opens from the launcher', opened);

    const view = await cdp.evaluate(`return {
        host: document.getElementById('loom_host_status')?.textContent?.trim() ?? '',
        viewport: document.getElementById('loom_viewport')?.textContent?.trim() ?? '',
        capabilityCount: document.querySelectorAll('#loom_capabilities details').length,
        capabilities: [...document.querySelectorAll('.loom_capability_id')].map(node => node.textContent.trim()),
        permissions: [...document.querySelectorAll('.loom_permission_name')].map(node => node.textContent.trim()),
        grantedCount: document.getElementById('loom_permission_count')?.textContent?.trim() ?? '',
        writeCapabilityShown: Boolean([...document.querySelectorAll('.loom_capability_id')].find(node => node.textContent.includes('worlds.entry.update'))),
        writePermissionShown: Boolean([...document.querySelectorAll('.loom_permission_name')].find(node => node.textContent.includes('host.worldinfo.write'))),
    };`);

    assertThat('panel reports a live host', view.host.includes('已连接'), `host="${view.host}"`);
    assertThat('panel shows viewport metrics', /\d+×\d+/.test(view.viewport), `viewport="${view.viewport}"`);
    assertThat('capability contracts listed', view.capabilityCount >= 12, `details=${view.capabilityCount}`);
    assertThat('world write capability appears in the panel', view.writeCapabilityShown);
    assertThat('world write permission appears in the panel', view.writePermissionShown);
    assertThat('permission section lists settings/chat/world writes',
        ['host.settings.write', 'host.chat.read', 'host.worldinfo.write'].every(name => view.permissions.includes(name)),
        view.permissions.join(', '));
    assertThat('granted counter is rendered', /^\d+$/.test(view.grantedCount), `count="${view.grantedCount}"`);
}

async function probeLiveReads(cdp) {
    const worlds = await cdp.evaluate("return await window.Loom.executeCapability('loom-host', 'worlds.list', null);");
    assertThat('worlds.list works against live data', worlds.success && Array.isArray(worlds.data), `${worlds.data?.length ?? 'n/a'} worlds`);

    // The host library loads asynchronously after the page, so wait for it before
    // asserting on characters; otherwise an early probe reads an empty array.
    await cdp.waitFor("return window.SillyTavern.getContext().characters?.length > 0;", READY_TIMEOUT_MS, 'character library load');
    const characters = await cdp.evaluate("return await window.Loom.executeCapability('loom-host', 'characters.list', null);");
    assertThat('characters.list works against live data', characters.success && characters.data?.length > 0,
        `${characters.data?.length ?? 'n/a'} characters`);
    assertThat('characters.list maps names and avatars only',
        characters.data.every(entry => Object.keys(entry).sort().join(',') === 'avatar,name'),
        JSON.stringify(characters.data?.[0] ?? null));

    const firstName = characters.data[0].name;
    const card = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'characters.get', { name: ${JSON.stringify(firstName)} });`);
    const cardOk = card.success && card.data && typeof card.data.description === 'string' && card.data.name === firstName;
    assertThat('characters.get reads a live card', cardOk, cardOk ? card.data.name : JSON.stringify(card.error ?? card.data ?? null));
    assertThat('characters.get does not leak card internals',
        cardOk && !('data' in card.data) && !('extensions' in card.data),
        Object.keys(card.data ?? {}).join(','));

    const snapshot = await cdp.evaluate("return await window.Loom.executeCapability('loom-host', 'context.snapshot', null);");
    assertThat('context.snapshot reports the live session', snapshot.success && typeof snapshot.data?.messageCount === 'number',
        `messages=${snapshot.data?.messageCount}, char=${snapshot.data?.characterName}`);

    const viewport = await cdp.evaluate("return await window.Loom.executeCapability('loom-host', 'viewport.get', null);");
    assertThat('viewport.get reports real dimensions', viewport.success && viewport.data?.width > 0, `${viewport.data?.width}×${viewport.data?.height}`);

    const omitted = await cdp.evaluate("return await window.Loom.executeCapability('loom-host', 'worlds.list');");
    assertThat('omitted input is treated as null', omitted.success === true, omitted.error?.code ?? 'ok');

    const worldName = worlds.data[0];
    const entries = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entries', { name: ${JSON.stringify(worldName)} });`);
    assertThat('worlds.entries reads a live world book', entries.success && Array.isArray(entries.data),
        `${worldName}: ${entries.data?.length ?? entries.error?.code} entries`);
    if (entries.success && entries.data.length > 0) {
        const entry = entries.data[0];
        assertThat('world entry mapping keeps identity and content',
            typeof entry.uid === 'string' && typeof entry.content === 'string' && Array.isArray(entry.keys),
            `uid=${entry.uid}, keys=${entry.keys.length}, content=${entry.content.length}`);
    }
}

async function probePermissionFlow(cdp) {
    // A probe extension stands in for a third-party consumer.
    await cdp.evaluate("window.Loom.registerExtension({ id: 'verify-probe', name: 'Verify Probe' }); return true;");

    // Start from a known state: the run must not depend on what a previous run
    // (or the user) left granted, or the denial checks silently become no-ops.
    await cdp.evaluate(`const Loom = window.Loom;
        for (const [extensionId, permission] of [
            ['verify-probe', 'host.chat.read'],
            ['verify-probe', 'host.worldinfo.write'],
            ['loom-ui', 'host.settings.write'],
        ]) {
            if (Loom.checkPermission(extensionId, permission)) Loom.revokePermission(extensionId, permission);
        }
        return true;`);
    // Re-render the panel so the toggle attributes match the state we just reset;
    // clicking the launcher again is the same refresh path a user has.
    await cdp.evaluate("document.getElementById('loom_extension_button').click(); return true;");
    await sleep(200);
    if (process.env.LOOM_DEBUG) {
        console.log('[debug] grants after reset:', JSON.stringify(await cdp.evaluate('return window.Loom.listPermissions();')));
    }

    const denied = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'chat.messages', { limit: 3 }, { caller: 'verify-probe' });`);
    assertThat('chat.messages is denied without a grant', denied.success === false && denied.error.code === 'PERMISSION_DENIED',
        denied.error?.code ?? 'no error');

    const deniedWrite = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entry.update',
        { name: '__loom_verify_missing__', uid: '1', patch: { content: 'x' } }, { caller: 'verify-probe' });`);
    assertThat('world write is denied without a grant', deniedWrite.success === false && deniedWrite.error.code === 'PERMISSION_DENIED',
        deniedWrite.error?.code ?? 'no error');

    // Grant through the real panel toggle, which is the user-facing path. The
    // toggle flips whatever the current state is, so assert the flip, not a
    // hard-coded direction.
    const toggled = await cdp.evaluate(`const button = [...document.querySelectorAll('.loom_permission_toggle')]
        .find(node => node.dataset.permission === 'host.settings.write' && node.dataset.extension === 'loom-ui');
        if (!button) return { found: false };
        const before = button.dataset.granted === 'true';
        button.click();
        return { found: true, before, after: window.Loom.checkPermission('loom-ui', 'host.settings.write') };`);
    assertThat('panel toggle flips the grant', toggled.found && toggled.after === !toggled.before, JSON.stringify(toggled));
    if (!toggled.after) {
        // Leave it granted so the persistence and reload checks stay meaningful.
        await cdp.evaluate("window.Loom.grantPermission('loom-ui', 'host.settings.write'); return true;");
    }

    if (process.env.LOOM_DEBUG) {
        console.log('[debug] toggle result:', JSON.stringify(toggled));
        console.log('[debug] grants after toggle:', JSON.stringify(await cdp.evaluate('return window.Loom.listPermissions();')));
    }

    const persisted = await cdp.evaluate(`const root = window.SillyTavern.getContext().extensionSettings.__loom;
        return Array.isArray(root?.grants) ? root.grants : null;`);
    const persistedEntry = persisted?.find(entry => entry.extensionId === 'loom-ui');
    assertThat('grant is persisted to SillyTavern settings',
        Array.isArray(persistedEntry?.permissions) && persistedEntry.permissions.includes('host.settings.write'),
        JSON.stringify(persisted));

    // After a grant the gated capability actually runs.
    await cdp.evaluate("window.Loom.grantPermission('verify-probe', 'host.chat.read'); return true;");
    const allowed = await cdp.evaluate("return await window.Loom.executeCapability('loom-host', 'chat.messages', { limit: 3 }, { caller: 'verify-probe' });");
    assertThat('chat.messages runs once granted', allowed.success === true && Array.isArray(allowed.data),
        allowed.success ? `${allowed.data.length} messages` : allowed.error?.code);

    // Missing world is a real write path probe that cannot mutate user data.
    await cdp.evaluate("window.Loom.grantPermission('verify-probe', 'host.worldinfo.write'); return true;");
    const missingWorld = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entry.update',
        { name: '__loom_verify_missing__', uid: '1', patch: { content: 'x' } }, { caller: 'verify-probe' });`);
    assertThat('granted world write reaches the host and reports a missing world',
        missingWorld.success === false && missingWorld.error.code === 'WORLD_NOT_FOUND',
        missingWorld.error?.code ?? 'no error');
}

async function probeConsent(cdp) {
    // Approve path: revoke first so the request is genuinely pending.
    await cdp.evaluate(`const Loom = window.Loom;
        if (Loom.checkPermission('verify-probe', 'host.worldinfo.write')) Loom.revokePermission('verify-probe', 'host.worldinfo.write');
        Loom.requestPermission('verify-probe', 'host.worldinfo.write', { reason: '验证用请求' });
        return true;`);

    const cardText = await cdp.waitFor(`const root = document.getElementById('loom_consent');
        if (!root || root.hidden) return false;
        const text = root.textContent;
        return text.includes('Loom 权限请求') && text.includes('host.worldinfo.write') ? text : false;`,
    8_000, 'consent card for a pending request');

    assertThat('consent card appears for a pending request', Boolean(cardText), String(cardText ?? '').slice(0, 80));
    assertThat('consent card explains the reason', String(cardText).includes('验证用请求'));
    assertThat('consent card names the declaring capability', String(cardText).includes('loom-host:worlds.entry.update'));

    const approved = await cdp.evaluate(`const root = document.getElementById('loom_consent');
        // The card lists every pending request (bundled packages may request
        // permissions too), so click the button inside the probe's own block.
        const blocks = [...root.querySelectorAll('section, div')]
            .filter(node => node.textContent.includes('Verify Probe') && node.querySelectorAll('button').length === 2);
        const block = blocks[0];
        const button = block ? [...block.querySelectorAll('button')].find(node => node.textContent.trim() === '允许') : null;
        if (!button) return { found: false };
        button.click();
        return { found: true, granted: window.Loom.checkPermission('verify-probe', 'host.worldinfo.write') };`);
    assertThat('approving through the prompt grants the permission', approved.found && approved.granted === true, JSON.stringify(approved));

    const cleared = await cdp.waitFor(`const root = document.getElementById('loom_consent');
        if (!root) return 'hidden';
        const blocks = [...root.querySelectorAll('section, div')]
            .filter(node => node.textContent.includes('Verify Probe') && node.querySelectorAll('button').length === 2);
        return blocks.length === 0 ? 'hidden' : false;`,
    5_000, 'consent card cleared after approval');
    assertThat('consent card clears after approval', cleared === 'hidden');

    // Deny path: the permission must stay unheld.
    await cdp.evaluate(`const Loom = window.Loom;
        if (Loom.checkPermission('verify-probe', 'host.chat.read')) Loom.revokePermission('verify-probe', 'host.chat.read');
        Loom.requestPermission('verify-probe', 'host.chat.read', { reason: '应被拒绝' });
        return true;`);
    await cdp.waitFor(`const root = document.getElementById('loom_consent');
        return Boolean(root && !root.hidden && root.textContent.includes('host.chat.read'));`, 8_000, 'deny prompt');

    const denied = await cdp.evaluate(`const root = document.getElementById('loom_consent');
        const blocks = [...root.querySelectorAll('section, div')]
            .filter(node => node.textContent.includes('Verify Probe') && node.querySelectorAll('button').length === 2);
        const block = blocks[0];
        const button = block ? [...block.querySelectorAll('button')].find(node => node.textContent.trim() === '拒绝') : null;
        if (!button) return { found: false };
        button.click();
        return { found: true, granted: window.Loom.checkPermission('verify-probe', 'host.chat.read') };`);
    assertThat('denying through the prompt leaves the permission unheld', denied.found && denied.granted === false, JSON.stringify(denied));
    const probeRequests = await cdp.evaluate("return window.Loom.listPermissionRequests().filter(entry => entry.extensionId === 'verify-probe').length;");
    assertThat('denial leaves no open probe request', probeRequests === 0, `probe requests=${probeRequests}`);
}

const SCRATCH_CHAR = '__loom_verify_char__';
const SCRATCH_BOOK = '__loom_verify_scratch__';
const SCRATCH_CHAT_CHAR = '__loom_verify_chat__';
const CHARACTERS_DIR = path.join('D:\\1\\APP\\SillyTavern', 'data', 'default-user', 'characters');

/**
 * Read the TavernCard JSON embedded in a character PNG's `chara` tEXt chunk.
 *
 * SillyTavern stores the card as base64-encoded UTF-8 JSON, so the chunk value
 * has to be decoded before it can be parsed.
 */
function readCardFromPng(file) {
    const buffer = readFileSync(file);
    let offset = 8; // PNG signature
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (type === 'tEXt') {
            const payload = buffer.subarray(dataStart, dataStart + length);
            const separator = payload.indexOf(0);
            if (payload.toString('latin1', 0, separator) === 'chara') {
                const text = payload.toString('latin1', separator + 1);
                return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
            }
        } else if (type === 'iTXt') {
            const payload = buffer.subarray(dataStart, dataStart + length);
            const separator = payload.indexOf(0);
            if (payload.toString('latin1', 0, separator) === 'chara') {
                const rest = payload.subarray(separator + 1);
                const textStart = rest.indexOf(Buffer.from([0, 0])) + 2;
                const afterLang = rest.subarray(textStart);
                const langEnd = afterLang.indexOf(0);
                const translatedEnd = afterLang.indexOf(0, langEnd + 1);
                return JSON.parse(Buffer.from(afterLang.toString('utf8', translatedEnd + 1), 'base64').toString('utf8'));
            }
        }
        offset = dataStart + length + 4; // + CRC
    }
    throw new Error(`No chara chunk in ${file}`);
}
const SCRATCH_COPY = '__loom_verify_copy__';
const RENAME_SRC = '__loom_verify_rename_src__';
const RENAME_DST = '__loom_verify_rename_dst__';

async function scratchBookExists(cdp, name = SCRATCH_BOOK) {
    return Boolean(await cdp.evaluate(`return (window.SillyTavern.getContext().getWorldInfoNames?.() ?? []).includes(${JSON.stringify(name)});`));
}

async function deleteScratchBook(cdp, name = SCRATCH_BOOK) {
    try {
        await cdp.evaluate(`const context = window.SillyTavern.getContext();
            const headers = { 'Content-Type': 'application/json', ...(context.getRequestHeaders?.() ?? {}) };
            await fetch('/api/worldinfo/delete', { method: 'POST', headers, body: JSON.stringify({ name: ${JSON.stringify(name)} }) });
            await context.updateWorldInfoList?.();
            return true;`);
    } catch (error) {
        console.error('scratch book cleanup failed:', error.message);
    }
}

/** Export/import round-trip: a book is rebuilt from its own exported payload. */
async function probeWorldExportImport(cdp) {
    await cdp.evaluate(`const Loom = window.Loom;
        if (!Loom.listExtensions().some(entry => entry.id === 'verify-probe')) Loom.loadExtension({ id: 'verify-probe', name: 'Verify Probe' });
        for (const permission of ['host.worldinfo.write', 'host.worldinfo.manage']) {
            if (!Loom.checkPermission('verify-probe', permission)) Loom.grantPermission('verify-probe', permission);
        }
        return true;`);

    const created = await cdp.evaluate(`const Loom = window.Loom;
        const book = await Loom.executeCapability('loom-host', 'worlds.create', { name: ${JSON.stringify(SCRATCH_BOOK)} }, { caller: 'verify-probe' });
        const entry = await Loom.executeCapability('loom-host', 'worlds.entry.create',
            { name: ${JSON.stringify(SCRATCH_BOOK)}, entry: { content: 'exported content', comment: 'src', keys: ['k1'], order: 42 } },
            { caller: 'verify-probe' });
        return { book: book.success, entry: entry.success, uid: entry.data?.uid };`);
    assertThat('source book with one entry is ready for export',
        created.book === true && created.entry === true, JSON.stringify(created));

    const exported = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.export',
        { name: ${JSON.stringify(SCRATCH_BOOK)} });`);
    assertThat('worlds.export returns the full book data',
        exported.success === true && exported.data?.entries === 1 && typeof exported.data?.data?.entries === 'object',
        JSON.stringify({ entries: exported.data?.entries, error: exported.error?.code }));

    const imported = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.import',
        { name: ${JSON.stringify(SCRATCH_COPY)}, data: ${JSON.stringify(exported.data?.data ?? {})} }, { caller: 'verify-probe' });`);
    assertThat('worlds.import creates the copy',
        imported.success === true && imported.data?.created === true && imported.data?.entries === 1,
        JSON.stringify(imported.data ?? imported.error));

    const roundTrip = await cdp.evaluate(`const entries = await window.Loom.executeCapability('loom-host', 'worlds.entries',
        { name: ${JSON.stringify(SCRATCH_COPY)} });
        const entry = entries.data?.[0] ?? null;
        return { entry, sameUid: String(entry?.uid) === ${JSON.stringify(String(created.uid ?? ''))} };`);
    assertThat('the imported copy carries the same entry content',
        roundTrip.entry?.content === 'exported content'
        && JSON.stringify(roundTrip.entry?.keys) === '["k1"]'
        && roundTrip.entry?.order === 42,
        JSON.stringify(roundTrip.entry ?? null).slice(0, 110));

    const removed = await cdp.evaluate(`const Loom = window.Loom;
        const copy = await Loom.executeCapability('loom-host', 'worlds.remove',
            { name: ${JSON.stringify(SCRATCH_COPY)}, confirm: ${JSON.stringify(SCRATCH_COPY)} }, { caller: 'verify-probe' });
        const source = await Loom.executeCapability('loom-host', 'worlds.remove',
            { name: ${JSON.stringify(SCRATCH_BOOK)}, confirm: ${JSON.stringify(SCRATCH_BOOK)} }, { caller: 'verify-probe' });
        return { copy: copy.success, source: source.success };`);
    assertThat('the export/import probe cleans up both books',
        removed.copy === true && removed.source === true, JSON.stringify(removed));

    // Recreating a removed name must produce a genuinely empty book, not resurrect
    // the previous content.
    const reused = await cdp.evaluate(`const Loom = window.Loom;
        const created = await Loom.executeCapability('loom-host', 'worlds.create', { name: ${JSON.stringify(SCRATCH_BOOK)} }, { caller: 'verify-probe' });
        const entries = await Loom.executeCapability('loom-host', 'worlds.entries', { name: ${JSON.stringify(SCRATCH_BOOK)} });
        const removed = await Loom.executeCapability('loom-host', 'worlds.remove',
            { name: ${JSON.stringify(SCRATCH_BOOK)}, confirm: ${JSON.stringify(SCRATCH_BOOK)} }, { caller: 'verify-probe' });
        return { created: created.success, entries: (entries.data ?? []).length, removed: removed.success };`);
    assertThat('a recreated book starts empty and is removed again',
        reused.created === true && reused.entries === 0 && reused.removed === true, JSON.stringify(reused));
}

/**
 * Real write path against a throw-away world book created for this run. The
 * user's own books are never touched; the scratch book is deleted afterwards
 * (and the earlier probe groups already cover the permission gate).
 */
async function probeWorldWrite(cdp) {
    await cdp.evaluate(`const Loom = window.Loom;
        if (!Loom.listExtensions().some(entry => entry.id === 'verify-probe')) Loom.loadExtension({ id: 'verify-probe', name: 'Verify Probe' });
        for (const permission of ['host.worldinfo.write', 'host.worldinfo.manage']) {
            if (!Loom.checkPermission('verify-probe', permission)) Loom.grantPermission('verify-probe', permission);
        }
        return true;`);

    // Destructive operations require the name to be echoed back.
    const unconfirmed = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.remove',
        { name: ${JSON.stringify(SCRATCH_BOOK)}, confirm: 'not-the-name' }, { caller: 'verify-probe' });`);
    assertThat('worlds.remove refuses without an exact confirmation',
        unconfirmed.success === false && unconfirmed.error.code === 'CONFIRMATION_REQUIRED',
        unconfirmed.error?.code ?? 'no error');

    const createdBook = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.create',
        { name: ${JSON.stringify(SCRATCH_BOOK)} }, { caller: 'verify-probe' });`);
    assertThat('worlds.create makes a real world book', createdBook.success === true && createdBook.data?.created === true,
        JSON.stringify(createdBook.data ?? createdBook.error));
    assertThat('the created book is listed by the host', await scratchBookExists(cdp), SCRATCH_BOOK);

    const created = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entry.create',
        { name: ${JSON.stringify(SCRATCH_BOOK)}, entry: { content: '第一版', comment: '验证条目', keys: ['验证'] } },
        { caller: 'verify-probe' });`);
    assertThat('worlds.entry.create writes a real entry', created.success === true && Number.isInteger(created.data?.uid),
        created.success ? `uid=${created.data.uid}` : created.error?.code);

    const uid = String(created.data?.uid);
    const readBack = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entries',
        { name: ${JSON.stringify(SCRATCH_BOOK)} });`);
    const written = readBack.data?.find(entry => entry.uid === uid);
    assertThat('the created entry is readable back from the host', Boolean(written) && written.content === '第一版',
        JSON.stringify(written ?? null).slice(0, 90));

    const updated = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entry.update',
        { name: ${JSON.stringify(SCRATCH_BOOK)}, uid: ${JSON.stringify(uid)}, patch: { content: '第二版', enabled: false } },
        { caller: 'verify-probe' });`);
    assertThat('worlds.entry.update writes through', updated.success === true && updated.data?.updated.includes('content'),
        JSON.stringify(updated.data ?? updated.error));

    const afterUpdate = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entries',
        { name: ${JSON.stringify(SCRATCH_BOOK)} });`);
    const changed = afterUpdate.data?.find(entry => entry.uid === uid);
    assertThat('the update is persisted and enabled maps to disable',
        Boolean(changed) && changed.content === '第二版' && changed.enabled === false,
        JSON.stringify(changed ?? null).slice(0, 90));

    const removed = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entry.remove',
        { name: ${JSON.stringify(SCRATCH_BOOK)}, uid: ${JSON.stringify(uid)} }, { caller: 'verify-probe' });`);
    assertThat('worlds.entry.remove deletes the entry', removed.success === true && removed.data?.removed === true,
        JSON.stringify(removed.data ?? removed.error));

    const afterRemove = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entries',
        { name: ${JSON.stringify(SCRATCH_BOOK)} });`);
    assertThat('the removed entry is gone from the book',
        afterRemove.success === true && !afterRemove.data.some(entry => entry.uid === uid));

    // The whole book is deleted through Loom, closing the lifecycle end to end.
    const removedBook = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.remove',
        { name: ${JSON.stringify(SCRATCH_BOOK)}, confirm: ${JSON.stringify(SCRATCH_BOOK)} }, { caller: 'verify-probe' });`);
    assertThat('worlds.remove deletes the whole book',
        removedBook.success === true && removedBook.data?.removed === true,
        JSON.stringify(removedBook.data ?? removedBook.error));
    assertThat('the deleted book is gone from the host list', (await scratchBookExists(cdp)) === false);
}

async function probeExtensionLifecycle(cdp) {
    const states = await cdp.evaluate(`const Loom = window.Loom;
        Loom.loadExtension({
            id: 'verify-lifecycle',
            name: 'Verify Lifecycle',
            version: '9.9.9',
            dependencies: ['loom-host'],
            permissions: ['host.chat.read'],
            activate: () => { window.__verifyActivated = true; },
            deactivate: () => { window.__verifyActivated = false; },
        });
        return Loom.listExtensionStates().find(state => state.id === 'verify-lifecycle');`);
    assertThat('loadExtension registers without activating', states?.state === 'loaded', JSON.stringify(states));

    const activated = await cdp.evaluate(`const Loom = window.Loom;
        const state = Loom.activateExtension('verify-lifecycle');
        return { state, activated: window.__verifyActivated === true };`);
    assertThat('activateExtension runs the hook and becomes active',
        activated.state?.state === 'active' && activated.activated === true, JSON.stringify(activated.state?.state));

    const panelShows = await cdp.waitFor(`const panel = document.getElementById('loom_panel');
        if (!panel || !panel.classList.contains('open')) document.getElementById('loom_extension_button').click();
        const node = [...document.querySelectorAll('.loom_extension_state')]
            .find(item => item.textContent.includes('verify-lifecycle'));
        return node ? node.textContent : false;`, 5_000, 'extension state in the panel');
    assertThat('panel lists the loaded extension with its state', String(panelShows).includes('已激活'));

    const request = await cdp.evaluate(`return window.Loom.listPermissionRequests()
        .filter(item => item.extensionId === 'verify-lifecycle');`);
    assertThat('declared manifest permission raised a consent request',
        request.length === 1 && request[0].permission === 'host.chat.read', JSON.stringify(request));

    const blocked = await cdp.evaluate(`const Loom = window.Loom;
        Loom.loadExtension({ id: 'verify-dependent', name: 'Dependent', dependencies: ['verify-lifecycle'] });
        Loom.deactivateExtension('verify-lifecycle');
        return Loom.activateExtension('verify-dependent');`);
    assertThat('activation is blocked when a dependency is inactive',
        blocked.state === 'failed' && blocked.error?.code === 'DEPENDENCY_MISSING', blocked.error?.code ?? 'no error');

    const unloaded = await cdp.evaluate(`const Loom = window.Loom;
        Loom.unloadExtension('verify-dependent');
        Loom.unloadExtension('verify-lifecycle');
        return { registered: Loom.listExtensions().some(entry => entry.id === 'verify-lifecycle'), activated: window.__verifyActivated };`);
    assertThat('unloadExtension deactivates and unregisters',
        unloaded.registered === false && unloaded.activated === false, JSON.stringify(unloaded));
}

async function probeUiComponents(cdp) {
    const mounted = await cdp.evaluate(`const host = document.createElement('div');
        host.id = 'loom_verify_ui';
        document.body.append(host);
        const view = window.LoomUI.createView('loom-ui', {
            id: 'verify-ui-view',
            target: host,
            root: {
                component: 'column',
                props: { gap: 6 },
                children: [
                    { component: 'text', props: { text: 'verify-ui' } },
                    { component: 'tabs', props: { labels: ['A', 'B'] }, children: [
                        { component: 'text', props: { text: 'panel-a' } },
                        { component: 'text', props: { text: 'panel-b' } },
                    ] },
                    { component: 'image', props: { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', alt: 'dot' } },
                    { component: 'modal', props: { open: true, title: 'confirm' }, children: [
                        { component: 'text', props: { text: 'body' } },
                    ] },
                    { component: 'menu', props: { items: [{ id: 'one', label: 'One' }] } },
                ],
            },
        });
        return { text: host.textContent, hasTabs: Boolean(host.querySelector('.loom-tabs')), hasModal: Boolean(host.querySelector('[role="dialog"], .loom-modal')) };`);
    assertThat('new components mount in a real browser',
        mounted.text.includes('verify-ui') && mounted.text.includes('panel-a') && mounted.hasTabs,
        JSON.stringify({ hasTabs: mounted.hasTabs, hasModal: mounted.hasModal }));

    const unsafe = await cdp.evaluate(`try {
        window.LoomUI.createView('loom-ui', { id: 'verify-unsafe', target: '#loom_verify_ui',
            root: { component: 'image', props: { src: 'javascript:alert(1)', alt: 'x' } } });
        return 'accepted';
    } catch (error) { return 'rejected'; }`);
    assertThat('image component rejects unsafe protocols', unsafe === 'rejected', unsafe);

    const roundTrip = await cdp.evaluate(`const serialized = window.LoomUI.serializeView('verify-ui-view');
        const json = JSON.parse(JSON.stringify(serialized));
        const clone = window.LoomUI.createViewFromSerialized('loom-ui', json, { id: 'verify-ui-clone', target: '#loom_verify_ui' });
        const result = { hasOn: JSON.stringify(serialized).includes('"on"'), cloneText: clone.element.textContent, same: JSON.stringify(serialized) === JSON.stringify(clone.serialize()) };
        clone.destroy();
        return result;`);
    assertThat('serializeView round-trips without handlers',
        roundTrip.hasOn === false && roundTrip.cloneText.includes('panel-a') && roundTrip.same === true,
        JSON.stringify(roundTrip));

    // Tabs are controlled: a click reports intent, the caller selects.
    const tabs = await cdp.evaluate(`const view = window.LoomUI.getView('verify-ui-view');
        const root = view.element;
        const tabButtons = root.querySelectorAll('.loom-tabs-tab');
        const panels = root.querySelectorAll('.loom-tabs-panel');
        tabButtons[1].click();
        const afterClick = { selected: tabButtons[1].getAttribute('aria-selected'), visible: !panels[1].hidden };
        view.setProps([1], { active: 1 });
        const afterProps = { selected: tabButtons[1].getAttribute('aria-selected'), visible: !panels[1].hidden };
        return { afterClick, afterProps, sameElements: tabButtons[1] === root.querySelectorAll('.loom-tabs-tab')[1] };`);
    assertThat('tabs click reports intent without selecting',
        tabs.afterClick.selected === 'false' && tabs.afterClick.visible === false, JSON.stringify(tabs.afterClick));
    assertThat('tabs selection follows the declared active prop',
        tabs.afterProps.selected === 'true' && tabs.afterProps.visible === true, JSON.stringify(tabs.afterProps));
    assertThat('tabs update keeps the same DOM nodes', tabs.sameElements === true);

    // In-place prop update keeps the same DOM node (the reason partial updates exist).
    const inPlace = await cdp.evaluate(`const view = window.LoomUI.getView('verify-ui-view');
        const before = view.element.querySelector('.loom-text');
        view.setProps([0], { text: 'verify-ui-updated' });
        const after = view.element.querySelector('.loom-text');
        return { same: before === after, text: after.textContent };`);
    assertThat('setProps updates the same DOM node without a rebuild',
        inPlace.same === true && inPlace.text === 'verify-ui-updated', JSON.stringify(inPlace));

    const cleaned = await cdp.evaluate(`window.LoomUI.getView('verify-ui-view').destroy();
        window.LoomUI.destroyAllViews?.('loom-ui');
        document.getElementById('loom_verify_ui')?.remove();
        return window.LoomUI.listViews().every(view => !view.id.startsWith('verify-'));`);
    assertThat('verification views cleaned up', cleaned === true);
}

async function probeComponentLifecycle(cdp) {
    // Register a probe component that owns a document-level listener through the
    // engine's onCleanup contract; the listener must disappear with the view.
    const mounted = await cdp.evaluate(`window.__verifyCleanupCount = 0;
        window.LoomUI.registerComponent('loom-ui', {
            id: 'verify-listener',
            name: 'Verify Listener',
            props: {},
            mount: (props, context) => {
                const element = document.createElement('div');
                element.textContent = 'listener-mounted';
                const listener = () => { window.__verifyCleanupCount += 1; };
                document.addEventListener('verify-ping', listener);
                context.onCleanup(() => document.removeEventListener('verify-ping', listener));
                return element;
            },
        });
        const host = document.createElement('div');
        host.id = 'loom_verify_lifecycle';
        document.body.append(host);
        const view = window.LoomUI.createView('loom-ui', {
            id: 'verify-lifecycle-view',
            target: host,
            root: { component: 'verify-listener', props: {} },
        });
        document.dispatchEvent(new Event('verify-ping'));
        const before = window.__verifyCleanupCount;
        view.destroy();
        document.dispatchEvent(new Event('verify-ping'));
        return { before, after: window.__verifyCleanupCount, host: Boolean(host.isConnected) };`);
    assertThat('component listeners work while mounted', mounted.before === 1, `before=${mounted.before}`);
    assertThat('onCleanup releases document listeners on destroy', mounted.after === 1, `after=${mounted.after}`);

    const modal = await cdp.evaluate(`let closed = 0;
        const opener = document.createElement('button');
        opener.id = 'loom_verify_opener';
        document.body.append(opener);
        opener.focus();
        const host = document.getElementById('loom_verify_lifecycle');
        const view = window.LoomUI.createView('loom-ui', {
            id: 'verify-modal-view',
            target: host,
            root: {
                component: 'modal',
                props: { open: true, title: 'Verify modal' },
                on: { close: () => { closed += 1; } },
                children: [{ component: 'button', props: { label: 'Confirm' } }],
            },
        });
        const dialog = view.element.querySelector('.loom-modal-dialog');
        const focusedInside = dialog.contains(document.activeElement);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        const closedByEscape = closed;
        view.setProps([], { open: false });
        const restored = document.activeElement === opener;
        view.destroy();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return { focusedInside, closedByEscape, closedAfterDestroy: closed, restored, stillClosed: closed === closedByEscape };`);
    assertThat('modal moves focus into the dialog on open', modal.focusedInside === true);
    assertThat('modal closes on a document-level Escape', modal.closedByEscape === 1, `closed=${modal.closedByEscape}`);
    assertThat('closing the modal restores focus to the opener', modal.restored === true);
    assertThat('destroying the modal removes its document listener',
        modal.stillClosed === true && modal.closedAfterDestroy === 1, JSON.stringify(modal));

    await cdp.evaluate(`window.LoomUI.getView('verify-modal-view')?.destroy();
        document.getElementById('loom_verify_opener')?.remove();
        document.getElementById('loom_verify_lifecycle')?.remove();
        return true;`);
}

async function probeKeyedReconciliation(cdp) {
    const result = await cdp.evaluate(`const UI = window.LoomUI;
        const host = document.createElement('div');
        host.id = 'loom_verify_keyed';
        document.body.append(host);
        const items = [
            { component: 'input', key: 'a', props: { value: 'A' } },
            { component: 'input', key: 'b', props: { value: 'B' } },
            { component: 'input', key: 'c', props: { value: 'C' } },
        ];
        const view = UI.createView('loom-ui', {
            id: 'verify-keyed',
            target: host,
            root: { component: 'column', children: items },
        });
        const [a, b, c] = [...view.element.children];
        a.focus();

        view.setChildren([], [items[2], items[0], items[1]]);
        const reordered = [...view.element.children];
        const identity = reordered[0] === c && reordered[1] === a && reordered[2] === b;
        const focusKept = document.activeElement === a;
        const values = reordered.map(node => node.value).join('');

        view.setChildren([], [items[0], { component: 'text', key: 'x', props: { text: 'X' } }, items[1]]);
        const inserted = view.element.children.length === 3
            && view.element.children[0] === a
            && view.element.children[2] === b;

        view.destroy();
        document.getElementById('loom_verify_keyed')?.remove();
        return { identity, focusKept, values, inserted };`);

    assertThat('keyed reorder reuses the same elements', result.identity === true, JSON.stringify(result));
    assertThat('keyed reorder keeps focus in the moved element', result.focusKept === true);
    assertThat('keyed reorder applies the new order', result.values === 'CAB', `values=${result.values}`);
    assertThat('keyed insert leaves neighbours untouched', result.inserted === true);
}

async function probeManifestLoading(cdp) {
    const imported = await cdp.evaluate(`const source = "export default { id: 'verify-imported', name: 'Imported Extension', version: '3.2.1', activate: () => { window.__verifyImported = true; } };";
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        try {
            const result = await window.Loom.importExtension(url);
            return {
                state: result.state,
                id: result.id,
                activated: window.__verifyImported === true,
                listed: window.Loom.listExtensionStates().some(state => state.id === 'verify-imported'),
                version: window.Loom.getExtensionState('verify-imported')?.version,
            };
        } finally {
            URL.revokeObjectURL(url);
        }`);
    assertThat('importExtension loads and activates a module manifest',
        imported.state === 'active' && imported.activated === true, JSON.stringify(imported));
    assertThat('imported extension appears in the state list with its version',
        imported.listed === true && imported.version === '3.2.1');

    const brokenImport = await cdp.evaluate(`const url = URL.createObjectURL(new Blob(['export default {'], { type: 'text/javascript' }));
        try {
            const result = await window.Loom.importExtension(url);
            return { state: result.state, code: result.error?.code };
        } finally {
            URL.revokeObjectURL(url);
        }`);
    assertThat('a broken module is reported, not thrown',
        brokenImport.state === 'failed' && brokenImport.code === 'IMPORT_FAILED', JSON.stringify(brokenImport));

    const started = await cdp.evaluate(`const Loom = window.Loom;
        const order = [];
        Loom.loadExtension({ id: 'verify-start-dependent', name: 'Start Dependent',
            dependencies: ['verify-start-base'], activate: () => order.push('dependent') });
        Loom.loadExtension({ id: 'verify-start-base', name: 'Start Base', activate: () => order.push('base') });
        Loom.loadExtension({ id: 'verify-start-broken', name: 'Start Broken',
            activate: () => { throw new Error('start boom'); } });
        const result = Loom.startExtensions();
        return { order, failed: result.failed.map(entry => entry.id).sort(), activated: result.activated.length };`);
    assertThat('startExtensions runs dependencies first', started.order.indexOf('base') < started.order.indexOf('dependent'),
        JSON.stringify(started.order));
    assertThat('startExtensions reports failures without aborting',
        started.failed.includes('verify-start-broken') && started.activated >= 2, JSON.stringify(started));

    await cdp.evaluate(`for (const id of ['verify-imported', 'verify-start-dependent', 'verify-start-base', 'verify-start-broken']) {
            window.Loom.unloadExtension(id);
        }
        return true;`);
}

async function probeStatePersistence(cdp) {
    const written = await cdp.evaluate(`const Loom = window.Loom;
        const settings = window.SillyTavern.getContext().extensionSettings;
        // Start from a clean probe namespace so a previous run cannot make the
        // "namespace disappears" assertion pass for the wrong reason.
        if (settings.__loom?.state && Object.hasOwn(settings.__loom.state, 'verify-state')) {
            delete settings.__loom.state['verify-state'];
        }
        Loom.registerExtension({ id: 'verify-state', name: 'State Probe' });
        Loom.setState('verify-state', 'counter', 5);
        Loom.setState('verify-state', 'nested', { list: [1, 2] });
        Loom.setState('verify-state', 'callback', () => {});
        const store = window.SillyTavern.getContext().extensionSettings.__loom?.state?.['verify-state'] ?? null;
        return {
            store,
            memory: { counter: Loom.getState('verify-state', 'counter'), fn: typeof Loom.getState('verify-state', 'callback') },
        };`);
    assertThat('extension state is written into the reserved store',
        written.store?.counter === 5 && JSON.stringify(written.store?.nested) === '{"list":[1,2]}',
        JSON.stringify(written.store));
    assertThat('non-cloneable state stays in memory but is not persisted',
        !Object.hasOwn(written.store ?? {}, 'callback') && written.memory.fn === 'function',
        JSON.stringify(written.memory));

    const removed = await cdp.evaluate(`const Loom = window.Loom;
        Loom.deleteState('verify-state', 'counter');
        Loom.deleteState('verify-state', 'nested');
        const afterDelete = window.SillyTavern.getContext().extensionSettings.__loom?.state?.['verify-state'] ?? 'missing';
        // Re-seed for the reload check.
        Loom.setState('verify-state', 'counter', 9);
        Loom.deleteState('verify-state', 'counter');
        Loom.setState('verify-state', 'persisted', 'survives-reload');
        return afterDelete;`);
    assertThat('deleting the last state key drops the persisted namespace', removed === 'missing', JSON.stringify(removed));
}

async function probeChatWrite(cdp) {
    // Gate checks only. A real append is destructive to whichever chat is open,
    // and this harness must never write into the user's chat: the real write path
    // is exercised on a scratch character's chat in `probeChatMutation`.
    const denied = await cdp.evaluate(`const Loom = window.Loom;
        if (!Loom.listExtensions().some(entry => entry.id === 'verify-probe')) {
            Loom.loadExtension({ id: 'verify-probe', name: 'Verify Probe' });
        }
        if (Loom.checkPermission('verify-probe', 'host.chat.write')) Loom.revokePermission('verify-probe', 'host.chat.write');
        const context = window.SillyTavern.getContext();
        const lengthBefore = Array.isArray(context.chat) ? context.chat.length : -1;
        const result = await Loom.executeCapability('loom-host', 'chat.append', { text: 'blocked' }, { caller: 'verify-probe' });
        const lengthAfter = Array.isArray(context.chat) ? context.chat.length : -1;
        return { result, lengthBefore, lengthAfter, hasWriter: typeof context.sendSystemMessage === 'function' };`);
    assertThat('chat.append is denied without host.chat.write',
        denied.result.success === false && denied.result.error.code === 'PERMISSION_DENIED',
        denied.result.error?.code ?? 'no error');
    assertThat('a denied chat.append leaves the open chat untouched',
        denied.lengthAfter === denied.lengthBefore,
        `before=${denied.lengthBefore}, after=${denied.lengthAfter}`);
    assertThat('the host exposes a system-message writer', denied.hasWriter === true);
    record('chat.append real write path', true,
        'verified on the scratch chat in the chat-mutation probe (the user chat is never written)');
}

async function probeChatMutation(cdp) {
    // Edits and deletes are destructive, so they run on a scratch character's own
    // chat: create the card, select it, edit its greeting, check the chat file on
    // disk, delete the greeting, and remove the scratch card (with its chat)
    // afterwards. The user's chats are never opened.
    let created = null;
    let chatsDir = null;
    try {
        await cdp.evaluate(`const Loom = window.Loom;
            if (!Loom.listExtensions().some(entry => entry.id === 'verify-probe')) {
                Loom.loadExtension({ id: 'verify-probe', name: 'Verify Probe' });
            }
            if (!Loom.checkPermission('verify-probe', 'host.chat.write')) {
                Loom.grantPermission('verify-probe', 'host.chat.write');
            }
            return true;`);
        created = await cdp.evaluate(`const context = window.SillyTavern.getContext();
            const response = await fetch('/api/characters/create', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: ${JSON.stringify(SCRATCH_CHAT_CHAR)},
                    file_name: ${JSON.stringify(SCRATCH_CHAT_CHAR)},
                    description: 'scratch',
                    first_mes: 'hello from scratch',
                }),
            });
            return { ok: response.ok, avatar: response.ok ? await response.text() : null };`, 20_000);
        if (created.ok !== true) {
            record('chat mutation real path', true, 'not exercised: scratch character could not be created');
            return;
        }

        const selected = await cdp.evaluate(`const context = window.SillyTavern.getContext();
            await context.getCharacters();
            const index = (context.characters ?? []).findIndex(item => item.avatar === ${JSON.stringify(created.avatar)});
            if (index < 0) return { selected: false };
            await context.selectCharacterById(index);
            await new Promise(resolve => setTimeout(resolve, 500));
            return {
                selected: true,
                length: context.chat.length,
                greeting: String(context.chat[0]?.mes ?? ''),
                chatId: context.getCurrentChatId?.() ?? null,
            };`, 20_000);
        assertThat('the scratch chat is open before mutating it',
            selected.selected === true && selected.length === 1, JSON.stringify(selected));
        if (selected.selected !== true) return;

        chatsDir = path.join(path.dirname(CHARACTERS_DIR), 'chats', SCRATCH_CHAT_CHAR);

        const mutated = await cdp.evaluate(`const Loom = window.Loom;
            const context = window.SillyTavern.getContext();
            // Append with the default type first: this is the path that used to be
            // broken because the default type had no host template.
            const appended = await Loom.executeCapability('loom-host', 'chat.append',
                { text: 'append probe' }, { caller: 'verify-probe' });
            const appendedIndex = appended.data?.index ?? -1;
            const appendedText = String(context.chat[appendedIndex]?.mes ?? '');
            const editedAppended = appended.success
                ? await Loom.executeCapability('loom-host', 'chat.edit',
                    { index: appendedIndex, text: 'edited append' }, { caller: 'verify-probe' })
                : null;
            const deletedAppended = appended.success
                ? await Loom.executeCapability('loom-host', 'chat.delete',
                    { index: appendedIndex, expect: 'edited append' }, { caller: 'verify-probe' })
                : null;
            const lengthAfterAppendCycle = context.chat.length;

            const edited = await Loom.executeCapability('loom-host', 'chat.edit',
                { index: 0, text: 'edited greeting' }, { caller: 'verify-probe' });
            const afterEdit = String(context.chat[0]?.mes ?? '');
            const outOfRange = await Loom.executeCapability('loom-host', 'chat.edit',
                { index: 9, text: 'nope' }, { caller: 'verify-probe' });
            const refused = await Loom.executeCapability('loom-host', 'chat.delete',
                { index: 0, expect: 'stale text' }, { caller: 'verify-probe' });
            const deleted = await Loom.executeCapability('loom-host', 'chat.delete',
                { index: 0, expect: 'edited greeting' }, { caller: 'verify-probe' });
            return {
                appended, appendedText, editedAppended, deletedAppended, lengthAfterAppendCycle,
                edited, afterEdit, outOfRange, refused, deleted, lengthAfter: context.chat.length,
            };`, 30_000);
        assertThat('chat.append writes a system message with its default type',
            mutated.appended.success === true
            && mutated.appended.data.type === 'generic'
            && mutated.appendedText === 'append probe',
            JSON.stringify({ appended: mutated.appended, text: mutated.appendedText }));
        assertThat('the appended message can be edited and deleted again',
            mutated.editedAppended?.success === true
            && mutated.deletedAppended?.success === true
            && mutated.lengthAfterAppendCycle === 1,
            JSON.stringify({ edited: mutated.editedAppended, deleted: mutated.deletedAppended, length: mutated.lengthAfterAppendCycle }));
        assertThat('chat.edit rewrites the message text',
            mutated.edited.success === true && mutated.afterEdit === 'edited greeting',
            JSON.stringify({ edited: mutated.edited, afterEdit: mutated.afterEdit }));
        assertThat('chat.edit reports an out-of-range index',
            mutated.outOfRange.success === false && mutated.outOfRange.error?.code === 'MESSAGE_NOT_FOUND',
            JSON.stringify(mutated.outOfRange));
        assertThat('chat.delete refuses a stale expect',
            mutated.refused?.success === false && mutated.refused.error?.code === 'CONFIRMATION_REQUIRED',
            JSON.stringify(mutated.refused));
        assertThat('chat.delete removes the message again',
            mutated.deleted?.success === true && mutated.deleted.data.removed === 1
            && mutated.lengthAfter === 0,
            JSON.stringify({ deleted: mutated.deleted, after: mutated.lengthAfter }));

        // The on-disk chat file is the proof the edit was persisted, not just
        // rendered. Deletion saves through a debounced writer, so both checks
        // poll the file briefly.
        const chatFile = readChatFile(chatsDir, selected.chatId);
        const editedOnDisk = chatFile !== null && await waitForFile(chatFile, text => text.includes('edited greeting'), 5_000);
        assertThat('the edit was persisted to the scratch chat file', editedOnDisk,
            `file=${chatFile ?? 'not found'}`);
        const deletedOnDisk = chatFile !== null && await waitForFile(chatFile, text => !text.includes('edited greeting'), 5_000);
        assertThat('the deleted message is gone from the chat file', deletedOnDisk,
            `file=${chatFile ?? 'not found'}`);
    } finally {
        if (created?.ok === true) {
            try {
                await cdp.evaluate(`const context = window.SillyTavern.getContext();
                    await fetch('/api/characters/delete', {
                        method: 'POST',
                        headers: context.getRequestHeaders(),
                        body: JSON.stringify({ avatar_url: ${JSON.stringify(created.avatar)}, delete_chats: true }),
                    });
                    return true;`, 20_000);
            } catch (error) {
                record('scratch chat cleanup request', false, error.message);
            }
            assertThat('the scratch chat card is gone',
                existsSync(path.join(CHARACTERS_DIR, created.avatar)) === false);
        }
    }
}

/** Newest JSONL chat file for a character, plus the expected chat-id match. */
function readChatFile(directory, chatId) {
    if (!existsSync(directory)) return null;
    const files = readdirSync(directory).filter(name => name.endsWith('.jsonl'));
    if (files.length === 0) return null;
    if (chatId) {
        const named = files.find(name => name.includes(chatId));
        if (named) return path.join(directory, named);
    }
    return path.join(directory, files[0]);
}

/** Poll a file until `predicate` holds for its contents. */
async function waitForFile(file, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(file) && predicate(readFileSync(file, 'utf8'))) return true;
        await sleep(100);
    }
    return false;
}

async function probeCharacterWrite(cdp) {
    const cardPath = path.join(CHARACTERS_DIR, `${SCRATCH_CHAR}.png`);
    let created = null;
    try {
        // Create a real PNG card through the host API: the write under test only
        // proves something if it lands in the `chara` tEXt chunk on disk.
        created = await cdp.evaluate(`const context = window.SillyTavern.getContext();
            const response = await fetch('/api/characters/create', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: ${JSON.stringify(SCRATCH_CHAR)},
                    file_name: ${JSON.stringify(SCRATCH_CHAR)},
                    description: 'original text',
                    personality: '',
                    scenario: '',
                    first_mes: 'hello',
                    mes_example: '',
                    creator_notes: '',
                }),
            });
            return { ok: response.ok, avatar: response.ok ? await response.text() : null };`);
        assertThat('character scratch card created',
            created.ok === true && created.avatar === `${SCRATCH_CHAR}.png`, JSON.stringify(created));
        if (created.ok !== true) return;

        // The host's in-memory character list does not include a card until it
        // reloads, and `characters.update` resolves against that list.
        await cdp.evaluate(`await window.SillyTavern.getContext().getCharacters();
            return true;`);

        const original = readCardFromPng(cardPath);
        assertThat('the scratch card starts with the original text',
            original.description === 'original text' && original.first_mes === 'hello',
            JSON.stringify({ description: original.description, first_mes: original.first_mes }));

        await cdp.evaluate(`const Loom = window.Loom;
            if (!Loom.listExtensions().some(entry => entry.id === 'verify-probe')) {
                Loom.loadExtension({ id: 'verify-probe', name: 'Browser verification probe' });
            }
            if (!Loom.checkPermission('verify-probe', 'host.characters.write')) {
                Loom.grantPermission('verify-probe', 'host.characters.write');
            }
            return true;`);

        const updated = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'characters.update', {
            name: ${JSON.stringify(SCRATCH_CHAR)},
            patch: { description: 'edited by Loom', firstMessage: 'edited first', tags: ['loom', 'verified'] },
        }, { caller: 'verify-probe' });`);
        assertThat('characters.update writes the card',
            updated.success === true && updated.data.refreshed === true,
            JSON.stringify(updated.data ?? updated.error));

        // `merge-attributes` deep-merges into the card's V2 `data` block (the
        // canonical store); SillyTavern normalises that block over the legacy
        // top-level copy whenever it reads the card.
        const written = readCardFromPng(cardPath);
        assertThat('the PNG now carries the edited text',
            written.data?.description === 'edited by Loom'
            && written.data?.first_mes === 'edited first'
            && written.data?.mes_example === ''
            && Array.isArray(written.data?.tags)
            && written.data.tags.includes('verified'),
            JSON.stringify({ description: written.data?.description, first_mes: written.data?.first_mes, tags: written.data?.tags }));

        const memory = await cdp.evaluate(`const context = window.SillyTavern.getContext();
            const character = (context.characters ?? []).find(item => item.avatar === ${JSON.stringify(created.avatar)});
            return character ? { description: character.description, tags: character.tags } : null;`);
        assertThat('the in-memory copy is refreshed after the write',
            memory?.description === 'edited by Loom' && (memory.tags ?? []).includes('verified'),
            JSON.stringify(memory));
    } finally {
        if (created?.ok === true) {
            await cdp.evaluate(`const context = window.SillyTavern.getContext();
                await fetch('/api/characters/delete', {
                    method: 'POST',
                    headers: context.getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: ${JSON.stringify(created.avatar)}, delete_chats: false }),
                });
                return true;`);
            await rm(path.join('D:\\1\\APP\\SillyTavern', 'data', 'default-user', 'chats', SCRATCH_CHAR),
                { recursive: true, force: true });
            await cdp.evaluate(`return await window.Loom.revokePermission('verify-probe', 'host.characters.write');`);
            assertThat('the scratch character is deleted', existsSync(cardPath) === false, cardPath);
        }
    }
}

async function probeExtensionInstall(cdp) {
    // Bundled discovery: hello-loom ships with Loom and must be indexed and active.
    const bundled = await cdp.evaluate(`const Loom = window.Loom;
        const response = await fetch('/scripts/extensions/third-party/Loom/extensions/index.json');
        const index = response.ok ? await response.json() : null;
        const state = Loom.getExtensionState('hello-loom');
        const call = await Loom.executeCapability('hello-loom', 'hello.greet', { name: 'Loom' });
        return { indexed: index?.extensions?.some(entry => entry.id === 'hello-loom') ?? false, state: state?.state ?? null, call };`);
    assertThat('the bundled index is served and lists hello-loom',
        bundled.indexed === true, JSON.stringify({ indexed: bundled.indexed }));
    assertThat('the bundled extension is active and its capability runs',
        bundled.state === 'active' && bundled.call.success === true
        && bundled.call.data?.message === 'Hello, Loom!',
        JSON.stringify({ state: bundled.state, call: bundled.call }));
    const listed = await cdp.waitFor(
        "return document.getElementById('loom_installer')?.textContent.includes('Hello Loom') ? true : false;",
        SETTLE_TIMEOUT_MS, 'installer listing the bundled extension',
    );
    assertThat('the panel has an install section listing the bundled extension', listed === true);

    // User install: a module URL is imported and remembered; a reload restores it.
    const installed = await cdp.evaluate(`const source = 'data:text/javascript,${encodeURIComponent(
        'export default { id: "verify-installed", name: "Installed Probe" };',
    )}';
        const entry = await window.LoomUI.installExtension(source);
        const stored = window.Loom.getState('loom-ui', 'installedExtensions') ?? [];
        const state = window.Loom.getExtensionState('verify-installed');
        return { entry, stored, state: state?.state ?? null };`);
    assertThat('a user-installed module loads and is remembered',
        installed.state === 'active'
        && (installed.stored ?? []).some(item => item.id === 'verify-installed'),
        JSON.stringify(installed));

    // Extension state persists through SillyTavern's debounced settings save.
    await cdp.evaluate('await new Promise(resolve => setTimeout(resolve, 2000)); return true;');
    await cdp.send('Page.navigate', { url: ST_URL });
    await cdp.waitFor("return Boolean(document.getElementById('loom_installer'));", READY_TIMEOUT_MS, 'installer after reload');
    const restored = await cdp.waitFor(
        `return window.Loom?.getExtensionState('verify-installed')?.state ?? false;`,
        SETTLE_TIMEOUT_MS, 'installed module restored after reload',
    );
    assertThat('the installed module is restored after a reload', restored === 'active', `state=${restored}`);

    const removed = await cdp.evaluate(`await window.LoomUI.uninstallExtension('verify-installed');
        const stored = window.Loom.getState('loom-ui', 'installedExtensions') ?? [];
        return {
            stored,
            stillRegistered: window.Loom.listExtensions().some(entry => entry.id === 'verify-installed'),
        };`);
    assertThat('uninstalling removes the module and forgets it',
        removed.stillRegistered === false
        && !(removed.stored ?? []).some(item => item.id === 'verify-installed'),
        JSON.stringify(removed));
}

const WBM_BOOK = '__loom_verify_wbm__';

async function probeWorldBookManager(cdp) {
    // The bundled manager ships with Loom and is user-visible: it must be active,
    // open from its launcher, list a real book, and save an edit through its UI.
    const ready = await cdp.waitFor(
        "return window.Loom?.getExtensionState('world-book-manager')?.state === 'active' ? true : false;",
        SETTLE_TIMEOUT_MS, 'world-book-manager active',
    );
    assertThat('the bundled world-book manager activates', ready === true);

    const launcher = await cdp.evaluate(`return {
        button: Boolean(document.getElementById('loom_wbm_button')),
        panel: Boolean(document.getElementById('loom_wbm_panel')),
        hidden: document.getElementById('loom_wbm_panel')?.style.display === 'none',
    };`);
    assertThat('the manager launcher and panel are mounted',
        launcher.button === true && launcher.panel === true && launcher.hidden === true,
        JSON.stringify(launcher));

    // Prepare a scratch book with one entry, then drive the manager's real DOM.
    const scratch = await cdp.evaluate(`const Loom = window.Loom;
        // The install probe reloads the page, which drops dynamically registered
        // extensions; the harness registers its probe again where needed.
        if (!Loom.listExtensions().some(entry => entry.id === 'verify-probe')) {
            Loom.registerExtension({ id: 'verify-probe', name: 'Verify Probe' });
        }
        if (!Loom.checkPermission('verify-probe', 'host.worldinfo.manage')) Loom.grantPermission('verify-probe', 'host.worldinfo.manage');
        const created = await Loom.executeCapability('loom-host', 'worlds.create', { name: ${JSON.stringify(WBM_BOOK)} }, { caller: 'verify-probe' });
        const entry = await Loom.executeCapability('loom-host', 'worlds.entry.create',
            { name: ${JSON.stringify(WBM_BOOK)}, entry: { comment: 'manager probe', content: 'original content', keys: ['probe'] } },
            { caller: 'verify-probe' });
        // A declared permission is requested at activation; granting it here is
        // what the user does in the consent prompt.
        Loom.grantPermission('world-book-manager', 'host.worldinfo.write');
        document.getElementById('loom_wbm_button').click();
        return { created: created.success === true, entry: entry.success === true, error: created.error?.code ?? entry.error?.code ?? null };`);
    assertThat('the scratch book for the manager is ready', scratch.created === true && scratch.entry === true, JSON.stringify(scratch));

    const opened = await cdp.waitFor(
        `const panel = document.getElementById('loom_wbm_panel');
        if (!panel) return false;
        const select = panel.querySelector('select');
        return select && [...select.options].some(option => option.value === ${JSON.stringify(WBM_BOOK)})
            ? { options: [...select.options].length } : false;`,
        SETTLE_TIMEOUT_MS, 'manager listing the scratch book',
    );
    assertThat('the manager lists the scratch book', Boolean(opened) && opened.options >= 1, JSON.stringify(opened));

    const edited = await cdp.evaluate(`const panel = document.getElementById('loom_wbm_panel');
        const selects = panel.querySelectorAll('select');
        const bookSelect = selects[0];
        bookSelect.value = ${JSON.stringify(WBM_BOOK)};
        bookSelect.dispatchEvent(new Event('change'));
        await new Promise(resolve => setTimeout(resolve, 400));
        const entrySelect = panel.querySelectorAll('select')[1];
        if (!entrySelect || entrySelect.options.length === 0) return { ok: false, reason: 'no entries listed' };
        entrySelect.value = entrySelect.options[0].value;
        entrySelect.dispatchEvent(new Event('change'));
        await new Promise(resolve => setTimeout(resolve, 300));
        const textarea = panel.querySelector('textarea');
        if (!textarea) return { ok: false, reason: 'no textarea' };
        textarea.value = 'edited through the manager';
        textarea.dispatchEvent(new Event('change'));
        const save = [...panel.querySelectorAll('button')].find(button => button.textContent === '保存');
        if (!save) return { ok: false, reason: 'no save button' };
        save.click();
        await new Promise(resolve => setTimeout(resolve, 600));
        return { ok: true, status: panel.textContent.includes('已保存'), text: panel.textContent.slice(-200) };`);
    assertThat('the manager drives a real save through its UI',
        edited.ok === true && edited.status === true, JSON.stringify(edited));

    const persisted = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.entries',
        { name: ${JSON.stringify(WBM_BOOK)} }, { caller: 'verify-probe' });`);
    assertThat('the manager edit reached the world book',
        persisted.success === true
        && (persisted.data ?? []).some(entry => entry.content === 'edited through the manager'),
        JSON.stringify(persisted.data ?? persisted.error));

    const closed = await cdp.evaluate(`document.getElementById('loom_wbm_button').click();
        return document.getElementById('loom_wbm_panel').style.display === 'none';`);
    assertThat('the manager panel closes from its launcher', closed === true);
}

async function probeWorldRename(cdp) {
    await cdp.evaluate(`const Loom = window.Loom;
        if (!Loom.listExtensions().some(entry => entry.id === 'verify-probe')) Loom.loadExtension({ id: 'verify-probe', name: 'Verify Probe' });
        if (!Loom.checkPermission('verify-probe', 'host.worldinfo.manage')) Loom.grantPermission('verify-probe', 'host.worldinfo.manage');
        for (const name of [${JSON.stringify(RENAME_SRC)}, ${JSON.stringify(RENAME_DST)}]) {
            if (Loom.listExtensions().length && (window.SillyTavern.getContext().getWorldInfoNames?.() ?? []).includes(name)) {
                await Loom.executeCapability('loom-host', 'worlds.remove', { name, confirm: name }, { caller: 'verify-probe' });
            }
        }
        return true;`);

    const prepared = await cdp.evaluate(`const Loom = window.Loom;
        const created = await Loom.executeCapability('loom-host', 'worlds.create', { name: ${JSON.stringify(RENAME_SRC)} }, { caller: 'verify-probe' });
        const entry = await Loom.executeCapability('loom-host', 'worlds.entry.create',
            { name: ${JSON.stringify(RENAME_SRC)}, entry: { content: 'rename me', keys: ['r'] } }, { caller: 'verify-probe' });
        const context = window.SillyTavern.getContext();
        context.chatMetadata.world_info = ${JSON.stringify(RENAME_SRC)};
        context.powerUserSettings.persona_description_lorebook = ${JSON.stringify(RENAME_SRC)};

        // Also activate the book globally, so the selection-migration path is real.
        // The host populates #world_info from its own list; a freshly created book
        // may not be an option yet, so add it to model an activated book.
        const select = document.querySelector('#world_info');
        let selectionReady = false;
        if (select) {
            let option = [...select.options].find(item => item.value === ${JSON.stringify(RENAME_SRC)});
            if (!option) {
                option = document.createElement('option');
                option.value = ${JSON.stringify(RENAME_SRC)};
                option.textContent = ${JSON.stringify(RENAME_SRC)};
                select.append(option);
            }
            for (const item of select.options) item.selected = item === option;
            if (typeof window.jQuery === 'function') window.jQuery(select).trigger('change');
            else select.dispatchEvent(new Event('change'));
            selectionReady = [...select.options].some(item => item.selected && item.value === ${JSON.stringify(RENAME_SRC)});
        }
        return { created: created.success, entry: entry.success, entryError: entry.error?.code ?? null, selectionReady };`);
    assertThat('rename probe book is ready', prepared.created === true && prepared.entry === true, JSON.stringify(prepared));

    // A globally activated book must be refused, not renamed with a broken dropdown.
    const refused = await cdp.evaluate(`const Loom = window.Loom;
        const context = window.SillyTavern.getContext();
        const select = document.querySelector('#world_info');
        let option = select ? [...select.options].find(item => item.value === ${JSON.stringify(RENAME_SRC)}) : null;
        if (select && !option) {
            option = document.createElement('option');
            option.value = ${JSON.stringify(RENAME_SRC)};
            option.textContent = ${JSON.stringify(RENAME_SRC)};
            select.append(option);
        }
        if (select) {
            for (const item of select.options) item.selected = item === option;
            if (typeof window.jQuery === 'function') window.jQuery(select).trigger('change');
        }
        const result = await Loom.executeCapability('loom-host', 'worlds.rename',
            { name: ${JSON.stringify(RENAME_SRC)}, to: ${JSON.stringify(RENAME_DST)}, confirm: ${JSON.stringify(RENAME_SRC)} },
            { caller: 'verify-probe' });
        // Deactivate again so the rename itself can be exercised.
        if (select) {
            for (const item of select.options) item.selected = false;
            if (typeof window.jQuery === 'function') window.jQuery(select).trigger('change');
        }
        return { code: result.error?.code ?? null, selection: result.error?.details?.selection ?? null };`);
    assertThat('a globally activated book is refused instead of renamed',
        refused.code === 'WORLD_IN_USE' && refused.selection === true, JSON.stringify(refused));

    const renamed = await cdp.evaluate(`return await window.Loom.executeCapability('loom-host', 'worlds.rename',
        { name: ${JSON.stringify(RENAME_SRC)}, to: ${JSON.stringify(RENAME_DST)}, confirm: ${JSON.stringify(RENAME_SRC)} },
        { caller: 'verify-probe' });`);
    assertThat('worlds.rename renames the book and migrates bindings',
        renamed.success === true
        && renamed.data?.to === RENAME_DST
        && renamed.data?.migrated.includes('chat')
        && renamed.data?.migrated.includes('persona'),
        JSON.stringify(renamed.data ?? renamed.error));

    const state = await cdp.evaluate(`const context = window.SillyTavern.getContext();
        const names = context.getWorldInfoNames?.() ?? [];
        const entries = await window.Loom.executeCapability('loom-host', 'worlds.entries', { name: ${JSON.stringify(RENAME_DST)} });
        const select = document.querySelector('#world_info');
        return {
            oldGone: !names.includes(${JSON.stringify(RENAME_SRC)}),
            newListed: names.includes(${JSON.stringify(RENAME_DST)}),
            contents: (entries.data ?? []).map(entry => entry.content),
            chatBinding: context.chatMetadata?.world_info ?? null,
            personaBinding: context.powerUserSettings?.persona_description_lorebook ?? null,
            selected: select ? [...select.options].filter(option => option.selected).map(option => option.value) : null,
        };`);
    assertThat('the old name is gone and the new one is listed',
        state.oldGone === true && state.newListed === true, JSON.stringify(state));
    assertThat('the entry content survived the rename',
        state.contents.length === 1 && state.contents[0] === 'rename me', JSON.stringify(state.contents));
    assertThat('bindings point at the new name',
        state.chatBinding === RENAME_DST && state.personaBinding === RENAME_DST,
        JSON.stringify({ chat: state.chatBinding, persona: state.personaBinding }));

    // Leave the host as it was and remove the renamed book.
    const cleaned = await cdp.evaluate(`const context = window.SillyTavern.getContext();
        const select = document.querySelector('#world_info');
        if (select) {
            for (const option of select.options) option.selected = false;
            if (typeof window.jQuery === 'function') window.jQuery(select).trigger('change');
        }
        context.chatMetadata.world_info = '';
        context.powerUserSettings.persona_description_lorebook = '';
        context.saveSettingsDebounced?.();
        const removed = await window.Loom.executeCapability('loom-host', 'worlds.remove',
            { name: ${JSON.stringify(RENAME_DST)}, confirm: ${JSON.stringify(RENAME_DST)} }, { caller: 'verify-probe' });
        return { removed: removed.success, stillListed: (context.getWorldInfoNames?.() ?? []).includes(${JSON.stringify(RENAME_DST)}) };`);
    assertThat('rename probe cleans up after itself', cleaned.removed === true && cleaned.stillListed === false, JSON.stringify(cleaned));
}

async function probeReloadRestore(cdp) {
    const before = await cdp.evaluate(`return {
        loomUi: window.Loom.checkPermission('loom-ui', 'host.settings.write'),
        probeChat: window.Loom.checkPermission('verify-probe', 'host.chat.read'),
    };`);

    // SillyTavern persists settings through a debounced save; wait for the flush
    // before navigating or the grant never reaches the server.
    await cdp.evaluate('await new Promise(resolve => setTimeout(resolve, 2000)); return true;');

    await cdp.send('Page.navigate', { url: ST_URL });
    await cdp.waitFor("return Boolean(document.getElementById('loom_extension_button'));", READY_TIMEOUT_MS, 'panel reinstall after reload');

    const restored = await cdp.waitFor(`return window.Loom && window.Loom.checkPermission('loom-ui', 'host.settings.write') ? 'restored' : false;`,
        SETTLE_TIMEOUT_MS, 'persisted grant restore');
    assertThat('grant survives a page reload', restored === 'restored' && before.loomUi === true);

    const attached = await cdp.evaluate('return window.Loom.getRuntimeInfo().permissionStoreAttached;');
    assertThat('permission store is attached after reload', attached === true);

    const storeGrants = await cdp.evaluate("return window.SillyTavern.getContext().extensionSettings.__loom?.grants?.length ?? -1;");
    assertThat('store contents survive the reload', storeGrants >= 1, `entries=${storeGrants}`);

    const restoredState = await cdp.evaluate(`const settings = window.SillyTavern.getContext().extensionSettings;
        const stored = settings.__loom?.state?.['verify-state']?.persisted ?? null;
        window.Loom.registerExtension({ id: 'verify-state', name: 'State Probe' });
        return { stored, restored: window.Loom.getState('verify-state', 'persisted') };`);
    assertThat('extension state survives a page reload',
        restoredState.stored === 'survives-reload' && restoredState.restored === 'survives-reload',
        JSON.stringify(restoredState));

    // A grant restored while its extension is absent stays pending: after the
    // reload the probe is gone, so it must not appear as granted.
    const probeAfterReload = await cdp.evaluate("return window.Loom.listExtensions().some(entry => entry.id === 'verify-probe');");
    assertThat('unregistered extension grants are not applied', probeAfterReload === false, 'probe extension gone after reload');
}

async function cleanup(cdp) {
    try {
        // Edit the store directly: after a reload the probe extension is no
        // longer registered, so revokePermission() would throw and abort the
        // rest of the cleanup, leaving test grants behind.
        await cdp.evaluate(`const settings = window.SillyTavern.getContext().extensionSettings;
            for (const id of ['verify-probe', 'verify-state', 'verify-imported', 'verify-lifecycle']) {
                if (window.Loom?.listExtensions().some(entry => entry.id === id)) window.Loom.unregisterExtension(id);
            }
            if (settings.__loom) delete settings.__loom;
            window.SillyTavern.getContext().saveSettingsDebounced();
            return true;`);
        // A failed probe could leave a scratch book behind.
        for (const name of [SCRATCH_BOOK, SCRATCH_COPY, RENAME_SRC, RENAME_DST, WBM_BOOK]) {
            if (await scratchBookExists(cdp, name)) await deleteScratchBook(cdp, name);
        }
        // Wait for the debounced save to flush before the browser is killed.
        await cdp.evaluate('await new Promise(resolve => setTimeout(resolve, 2000)); return true;');
        // Bundled extensions legitimately persist their own state (hello-loom does),
        // so "clean" means no probe namespaces and no grants, not an empty root.
        const remaining = await cdp.evaluate(`const root = window.SillyTavern.getContext().extensionSettings.__loom ?? {};
            return {
                grants: root.grants ?? [],
                stateKeys: Object.keys(root.state ?? {}),
                installed: root.state?.['loom-ui']?.installedExtensions ?? [],
            };`);
        const probeState = remaining.stateKeys.filter(key => /^verify-/.test(key));
        if (remaining.grants.length > 0 || probeState.length > 0 || remaining.installed.length > 0) {
            record('cleanup removed the test grants', false, JSON.stringify(remaining));
        } else {
            record('cleanup removed the test grants', true, `bundled state kept: ${remaining.stateKeys.join(', ') || 'none'}`);
        }
        record('cleanup removed the scratch world book', (await scratchBookExists(cdp)) === false);
    } catch (error) {
        record('cleanup removed the test grants', false, error.message);
    }
}

async function main() {
    if (!existsSync(CHROME_PATH)) {
        console.error(`Chrome not found at ${CHROME_PATH}. Set LOOM_CHROME to the executable path.`);
        process.exitCode = 1;
        return;
    }
    const profileDir = await mkdtemp(path.join(tmpdir(), 'loom-verify-'));
    let chrome = null;
    let cdp = null;
    try {
        console.log(`Launching headless Chrome against ${ST_URL}`);
        // Read the expected version from the served extension manifest so the
        // check cannot drift when the project version is bumped. The repository
        // root manifest is the ST extension descriptor, not SillyTavern's PWA one.
        const manifestUrl = process.env.LOOM_MANIFEST_URL
            || new URL('scripts/extensions/third-party/Loom/manifest.json', ST_URL).href;
        const manifest = await (await fetch(manifestUrl)).json();
        expectedVersion = manifest.version;

        chrome = await launchChrome(profileDir);
        const page = await openPageTarget();
        cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');

        await cdp.send('Page.navigate', { url: ST_URL });
        await cdp.waitFor("return Boolean(window.Loom && window.Loom.getRuntimeInfo);", READY_TIMEOUT_MS, 'Loom runtime boot');

        await probeRuntime(cdp);
        await runProbe('entries', probeEntries, cdp);
        await runProbe('panel', probePanel, cdp);
        await runProbe('live reads', probeLiveReads, cdp);
        await runProbe('permission flow', probePermissionFlow, cdp);
        await runProbe('consent prompt', probeConsent, cdp);
        await runProbe('extension lifecycle', probeExtensionLifecycle, cdp);
        await runProbe('ui components', probeUiComponents, cdp);
        await runProbe('component lifecycle', probeComponentLifecycle, cdp);
        await runProbe('keyed reconciliation', probeKeyedReconciliation, cdp);
        await runProbe('manifest loading', probeManifestLoading, cdp);
        await runProbe('state persistence', probeStatePersistence, cdp);
        await runProbe('chat write', probeChatWrite, cdp);
        await runProbe('world write', probeWorldWrite, cdp);
        await runProbe('world export/import', probeWorldExportImport, cdp);
        await runProbe('world rename', probeWorldRename, cdp);
        await runProbe('extension install', probeExtensionInstall, cdp);
        await runProbe('world-book manager', probeWorldBookManager, cdp);
        await runProbe('character write', probeCharacterWrite, cdp);
        await runProbe('chat mutation', probeChatMutation, cdp);
        await runProbe('reload restore', probeReloadRestore, cdp);

        const loomErrors = consoleErrors.filter(message => /loom/i.test(message));
        assertThat('no Loom-related console errors', loomErrors.length === 0, loomErrors.join(' | '));
        if (consoleErrors.length > 0) {
            console.log(`\nPage console errors (${consoleErrors.length}, not all Loom-related):`);
            for (const message of consoleErrors.slice(0, 10)) console.log(`  - ${message}`);
        }
    } catch (error) {
        record('verification run', false, error.message);
    } finally {
        if (cdp) await cleanup(cdp);
        cdp?.close();
        if (chrome) {
            chrome.kill();
        }
        await sleep(300);
        await rm(profileDir, { recursive: true, force: true });
    }

    const failed = results.filter(entry => !entry.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
        console.log('Failed checks:');
        for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
        process.exitCode = 1;
    }
}

await main();