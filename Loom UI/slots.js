/**
 * Native panel slots — render a Loom view into a SillyTavern container.
 *
 * Extensions normally own their own container. This module exists for the cases
 * where a feature must appear **inside** an existing SillyTavern panel (the
 * extension-settings column, the wand menu) instead of floating on the page.
 *
 * Design constraints:
 * - Slots are an allowlist, not a CSS selector: an extension cannot ask Loom to
 *   render into an arbitrary host element, and a host upgrade that renames a
 *   container is a one-line change here.
 * - Each mount owns a wrapper element; unmounting removes it. Every mount is
 *   registered as an extension cleanup, so unloading an extension never leaves
 *   orphaned UI inside SillyTavern's own panels.
 * - A missing container is a normal condition (the panel may not be rendered on
 *   every screen), so mounting retries lazily instead of throwing.
 */
import { addCleanup } from '../Loom%20Core/index.js';
import { createView, destroyAllViews } from './views.js';

export const SLOTS = Object.freeze({
    settings: '#extensions_settings',
    settings2: '#extensions_settings2',
    menu: '#extensionsMenu',
    leftNav: '#left-nav-panel',
});

const mounted = new Map();

function requireSlot(slot) {
    const selector = SLOTS[slot];
    if (!selector) {
        throw new Error(`Unknown UI slot "${slot}". Known slots: ${Object.keys(SLOTS).join(', ')}`);
    }
    return selector;
}

function keyFor(extensionId, slot) {
    return `${extensionId}::${slot}`;
}

function bindCleanup(extensionId) {
    if (mounted.has(`__bound::${extensionId}`)) return;
    mounted.set(`__bound::${extensionId}`, true);
    addCleanup(extensionId, () => {
        for (const [key, record] of [...mounted]) {
            if (!key.startsWith(`${extensionId}::`)) continue;
            try {
                record.view?.destroy?.();
            } catch {
                // A failed teardown must not block the remaining cleanups.
            }
            record.wrapper?.remove?.();
            mounted.delete(key);
        }
    });
}

/**
 * Mount a view into a host slot. Returns the view, or null when the container is
 * not in the document yet (call again once the panel exists).
 */
export function mountToSlot(extensionId, slot, options = {}) {
    const selector = requireSlot(slot);
    const container = document.querySelector(selector);
    if (!container) return null;

    const key = keyFor(extensionId, slot);
    unmountFromSlot(extensionId, slot);
    bindCleanup(extensionId);

    const wrapper = document.createElement('div');
    wrapper.className = 'loom-slot';
    wrapper.dataset.slot = slot;
    wrapper.dataset.extension = extensionId;
    container.append(wrapper);

    const view = createView(extensionId, {
        ...options,
        id: options.id ?? `loom-slot-${extensionId}-${slot}`,
        target: wrapper,
    });
    mounted.set(key, { wrapper, view, selector });
    return view;
}

/** Remove a previously mounted slot view; a no-op when nothing is mounted. */
export function unmountFromSlot(extensionId, slot) {
    requireSlot(slot);
    const key = keyFor(extensionId, slot);
    const record = mounted.get(key);
    if (!record) return false;
    try {
        record.view?.destroy?.();
    } finally {
        record.wrapper?.remove?.();
        mounted.delete(key);
    }
    return true;
}

export function listSlotMounts(extensionId) {
    return [...mounted.entries()]
        .filter(([key, value]) => !key.startsWith('__bound::') && (extensionId === undefined || key.startsWith(`${extensionId}::`)))
        .map(([key, record]) => ({
            extensionId: key.split('::')[0],
            slot: key.split('::')[1],
            selector: record.selector,
        }));
}

/** Drop every slot mount (used by tests and by a full UI teardown). */
export function resetSlotMounts() {
    for (const [key, record] of [...mounted]) {
        if (key.startsWith('__bound::')) continue;
        try {
            record.view?.destroy?.();
        } finally {
            record.wrapper?.remove?.();
        }
    }
    mounted.clear();
    destroyAllViews();
}
