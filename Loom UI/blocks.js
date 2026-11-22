/**
 * Block rendering — the interaction layer for display-only regions.
 *
 * A Loom block (`⟦loom:kind⟧…⟦/loom⟧`, see `Loom Core/markers.js`) is stripped from
 * the prompt by the host adapter, so whatever is drawn in its place is invisible to
 * the model. This module is the other half: it replaces the marker text in a
 * rendered message with a live Loom view.
 *
 * Boundaries, deliberately:
 * - **Interaction and rendering live here**, in Loom UI, because UI owns exactly
 *   that. What may live elsewhere is an authoring tool (a visual builder) or a
 *   concrete widget set — not the capability to render.
 * - Widget *kinds* are registered by extensions; an unregistered kind is removed
 *   from the display (never left as a raw marker) so a missing renderer degrades to
 *   "nothing" instead of visible syntax.
 * - Rendering only touches text nodes inside the message body, so SillyTavern's own
 *   markup (avatars, buttons, swipe controls) is left alone.
 * - Mounts are tracked per message and destroyed before re-rendering; a message
 *   that SillyTavern rebuilds therefore gets a fresh, single instance rather than a
 *   duplicate.
 */
import { addCleanup } from '../Loom%20Core/index.js';
import { parseBlocks } from '../Loom%20Core/markers.js';
import { createView } from './views.js';

const BLOCK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const blockRegistry = new Map();
const mounts = new Map();
const placeholders = new Map();
const boundCleanups = new Set();

/** Registry entry for one widget kind, owned by an extension. */
export function registerBlock(extensionId, definition) {
    if (!definition || typeof definition !== 'object') {
        throw new TypeError('Block definition must be an object.');
    }
    const id = definition.id;
    if (typeof id !== 'string' || !BLOCK_ID_PATTERN.test(id)) {
        throw new TypeError('Block id must be an identifier.');
    }
    if (typeof definition.build !== 'function') {
        throw new TypeError('Block build must be a function returning a view node.');
    }
    if (blockRegistry.has(id)) {
        throw new Error(`Block already registered: ${id}`);
    }
    blockRegistry.set(id, {
        id,
        extensionId,
        name: typeof definition.name === 'string' && definition.name.trim() !== '' ? definition.name.trim() : id,
        build: definition.build,
        unmount: typeof definition.unmount === 'function' ? definition.unmount : null,
    });
    bindCleanup(extensionId);
    return { id, extensionId, name: definition.name ?? id };
}

export function getBlock(id) {
    return blockRegistry.get(id) ?? null;
}

export function listBlocks(extensionId) {
    return [...blockRegistry.values()]
        .filter(entry => extensionId === undefined || entry.extensionId === extensionId)
        .map(entry => ({ id: entry.id, extensionId: entry.extensionId, name: entry.name }));
}

/** Drop every mount an extension owns; called automatically when it unregisters. */
export function unregisterBlocks(extensionId) {
    for (const [id, entry] of [...blockRegistry]) {
        if (entry.extensionId === extensionId) blockRegistry.delete(id);
    }
    for (const [messageId, records] of [...mounts]) {
        const remaining = records.filter(record => record.extensionId !== extensionId);
        for (const record of records) {
            if (record.extensionId === extensionId) disposeMount(record);
        }
        if (remaining.length === 0) mounts.delete(messageId);
        else mounts.set(messageId, remaining);
    }
}

function bindCleanup(extensionId) {
    if (boundCleanups.has(extensionId)) return;
    boundCleanups.add(extensionId);
    addCleanup(extensionId, () => unregisterBlocks(extensionId));
}

function disposeMount(record) {
    try {
        record.view?.destroy?.();
    } catch {
        // A failed teardown must not block the remaining mounts.
    }
    try {
        record.host?.remove?.();
    } catch {
        // The element may already be detached with its message.
    }
}

/** Tear down the mounts for one message (before re-rendering it). */
export function disposeMessageBlocks(messageId) {
    const key = String(messageId);
    let removed = 0;
    const records = mounts.get(key);
    if (records) {
        for (const record of records) disposeMount(record);
        mounts.delete(key);
        removed += records.length;
    }
    // Hidden placeholders for kinds without a renderer are not mounts, but they must
    // not accumulate either: they belong to the message that is being re-rendered.
    for (const host of placeholders.get(key) ?? []) {
        try {
            host.remove?.();
        } catch {
            // Already detached with its message.
        }
    }
    placeholders.delete(key);
    return removed;
}

/** Tear down every mount (used by tests and by a full UI reset). */
export function resetBlockMounts() {
    for (const records of [...mounts.values()]) {
        for (const record of records) disposeMount(record);
    }
    mounts.clear();
    for (const hosts of [...placeholders.values()]) {
        for (const host of hosts) {
            try {
                host.remove?.();
            } catch {
                // Already detached.
            }
        }
    }
    placeholders.clear();
    blockRegistry.clear();
    boundCleanups.clear();
}

export function listBlockMounts(messageId) {
    if (messageId !== undefined) {
        return [...(mounts.get(String(messageId)) ?? [])].map(record => ({ kind: record.kind, extensionId: record.extensionId }));
    }
    return [...mounts.entries()].flatMap(([id, records]) => records.map(record => ({ messageId: id, kind: record.kind, extensionId: record.extensionId })));
}

/**
 * Replace the blocks inside one rendered message body.
 *
 * `body` is the element that holds the message text (`.mes_text` in SillyTavern).
 * Returns the number of blocks found, including kinds that had no renderer.
 */
export function renderBlocksIn(body, { messageId, message } = {}) {
    if (!body) return 0;
    const text = body.textContent ?? '';
    const blocks = parseBlocks(text);
    if (blocks.length === 0) return 0;

    disposeMessageBlocks(messageId);
    const records = [];
    // Work from the last block backwards so earlier offsets stay valid as text
    // nodes are split.
    for (const block of [...blocks].reverse()) {
        const host = document.createElement('div');
        host.className = 'loom-block';
        host.dataset.loomBlock = block.kind;
        if (messageId !== undefined) host.dataset.loomMesid = String(messageId);

        const entry = blockRegistry.get(block.kind);
        if (!entry) {
            // No renderer: hide the marker rather than showing raw syntax.
            host.hidden = true;
            host.dataset.loomUnrendered = 'true';
            const key = String(messageId);
            if (!placeholders.has(key)) placeholders.set(key, []);
            placeholders.get(key).push(host);
        }
        replaceRangeWithElement(body, block.from, block.to, host);

        if (!entry) continue;
        try {
            const view = createView(entry.extensionId, {
                target: host,
                root: entry.build({
                    kind: block.kind,
                    inner: block.inner,
                    messageId,
                    message: message ?? null,
                }),
            });
            records.push({ kind: block.kind, extensionId: entry.extensionId, view, host, inner: block.inner, messageId });
        } catch (error) {
            host.hidden = true;
            host.dataset.loomError = error instanceof Error ? error.message : 'render failed';
        }
    }
    if (records.length > 0) mounts.set(String(messageId), records);
    return blocks.length;
}

function collectTextNodes(root) {
    const nodes = [];
    const walk = node => {
        for (const child of node.childNodes ?? []) {
            // Text nodes are nodeType 3 in a real DOM and in the test fixture. A
            // text node also has an (empty) childNodes list, so "has no children"
            // is not a usable test.
            if (child.nodeType === 3) nodes.push(child);
            else if (child.nodeType === 1) walk(child);
        }
    };
    walk(root);
    return nodes;
}

/**
 * Walk the text nodes of `root` and replace the character range `[from, to)` with
 * `element`.
 *
 * Only text nodes are touched: SillyTavern's rendered markup (avatars, buttons,
 * swipes) keeps its structure, and no innerHTML is parsed from message content.
 */
function replaceRangeWithElement(root, from, to, element) {
    let offset = 0;
    const targets = [];
    for (const node of collectTextNodes(root)) {
        const start = offset;
        const end = offset + node.textContent.length;
        if (end > from && start < to) targets.push({ node, start, end });
        offset = end;
        if (start >= to) break;
    }
    if (targets.length === 0) return false;

    let inserted = false;
    for (const target of targets) {
        const localFrom = Math.max(0, from - target.start);
        const localTo = Math.min(target.node.textContent.length, to - target.start);
        const before = target.node.textContent.slice(0, localFrom);
        const after = target.node.textContent.slice(localTo);
        const parent = target.node.parentNode;
        if (!parent) continue;
        if (before) parent.insertBefore(document.createTextNode(before), target.node);
        if (!inserted) {
            parent.insertBefore(element, target.node);
            inserted = true;
        }
        if (after) parent.insertBefore(document.createTextNode(after), target.node);
        parent.removeChild(target.node);
    }
    return inserted;
}

/**
 * Rebuild the *views* of blocks that are already mounted.
 *
 * `refreshBlocks` needs the marker to still be in the message text, but rendering
 * replaces it with the widget container — so a state change could never update an
 * already-rendered panel. This walks the live mounts instead and re-runs each
 * builder in place, which is what an interactive widget needs after it mutates its
 * own data.
 */
export function rerenderBlocks(extensionId = null) {
    let count = 0;
    for (const records of mounts.values()) {
        for (const record of records) {
            if (extensionId !== null && record.extensionId !== extensionId) continue;
            const entry = blockRegistry.get(record.kind);
            if (!entry) continue;
            try {
                record.view?.destroy?.();
            } catch {
                // A failed teardown must not stop the rebuild.
            }
            try {
                record.view = createView(entry.extensionId, {
                    target: record.host,
                    root: entry.build({
                        kind: record.kind,
                        inner: record.inner,
                        messageId: record.messageId,
                        message: null,
                    }),
                });
                count += 1;
            } catch (error) {
                record.host.hidden = true;
                record.host.dataset.loomError = error instanceof Error ? error.message : 'render failed';
            }
        }
    }
    return count;
}

/**
 * Render the blocks of every message under `root` (defaults to the chat log).
 *
 * Messages without blocks are skipped, so the cost is proportional to the messages
 * that actually contain a widget, not to the length of the chat.
 */
export function refreshBlocks(root = null) {
    const scope = root ?? document.querySelector?.('#chat') ?? document.body;
    if (!scope?.querySelectorAll) return 0;
    let rendered = 0;
    for (const messageElement of scope.querySelectorAll('.mes[mesid]')) {
        const messageId = messageElement.getAttribute('mesid');
        const body = messageElement.querySelector('.mes_text');
        if (!body) continue;
        if (!(body.textContent ?? '').includes('\u27E6loom:')) {
            // The message no longer holds a block (edited, re-rendered without it):
            // drop any stale mounts for it.
            disposeMessageBlocks(messageId);
            continue;
        }
        rendered += renderBlocksIn(body, {
            messageId,
            message: {
                index: Number(messageId),
                isUser: messageElement.getAttribute('is_user') === 'true',
                isSystem: messageElement.getAttribute('is_system') === 'true',
                name: messageElement.getAttribute('ch_name') ?? '',
            },
        });
    }
    return rendered;
}
