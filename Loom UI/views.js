/**
 * Loom UI view engine.
 *
 * A mounted view is an entry tree: every rendered node keeps its element, its
 * resolved props, its child entries and its lifecycle registrations. That is
 * what makes incremental updates possible — `setProps` reuses the element,
 * `setChildren` reconciles children by key or by index+component instead of
 * rebuilding the view, and only nodes that genuinely disappeared are disposed.
 *
 * Views are owned by an extension and released automatically when it is
 * unregistered from Core.
 */

import { addCleanup, listExtensions } from '../Loom%20Core/index.js';
import { getComponent, resolveProps } from './components.js';
import {
    appendNodeChild,
    describeNode,
    emitNodeEvent,
    locateNode,
    removeNodeAt,
    serializeNode,
    updateNodeChildren,
    updateNodeProps,
    validateNode,
} from './view-tree.js';

const views = new Map();
const cleanupBound = new Set();
let idCounter = 0;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function pathKey(path) {
    return path.join('.');
}

function requireRegisteredExtension(extensionId) {
    if (typeof extensionId !== 'string' || !ID_PATTERN.test(extensionId)) {
        throw new TypeError('View extension id must contain only letters, numbers, dot, underscore, or hyphen.');
    }
    if (!listExtensions().some(extension => extension.id === extensionId)) {
        throw new Error(`Register the extension before creating views: ${extensionId}`);
    }
}

/* ------------------------------------------------------------------------- */
/* entry tree                                                                 */
/* ------------------------------------------------------------------------- */

function pathOf(entry) {
    const path = [];
    let cursor = entry;
    while (cursor && cursor.parent) {
        path.unshift(cursor.index);
        cursor = cursor.parent;
    }
    return path;
}

function hostFor(entry, index) {
    const content = entry.content;
    if (typeof content === 'function') {
        const host = content(index);
        if (!(host instanceof Element)) {
            throw new TypeError(`Component ${entry.definition.id} did not provide a container for child ${index}.`);
        }
        return host;
    }
    return content;
}

/**
 * Mount a validated node and its subtree. Cleanups and mount callbacks are
 * registered through the context so components never have to know when the tree
 * is attached or torn down.
 */
function mountNode(node, context, parent) {
    const definition = getComponent(node.component);
    if (!definition) throw new Error(`Unknown component: ${node.component}`);
    const props = resolveProps(definition, node.props);

    const cleanups = [];
    const mountCallbacks = [];
    let entry = null;

    const mountContext = {
        // Read the node through the entry so a reconciled update (which swaps
        // `entry.node`) also swaps the event handlers, not just props.
        emit: (eventName, payload) => emitNodeEvent(
            definition,
            entry?.node?.on ?? node.on,
            context,
            pathOf(entry),
            eventName,
            payload,
        ),
        get path() {
            return pathOf(entry);
        },
        extensionId: context.extensionId,
        /**
         * Teardown for when this node leaves the DOM (view destroyed, root
         * replaced, subtree removed or rebuilt). Runs before `unmount`.
         */
        onCleanup(cleanup) {
            if (typeof cleanup !== 'function') {
                throw new TypeError(`Component ${definition.id} onCleanup expects a function.`);
            }
            cleanups.push(cleanup);
        },
        /** Work that needs a connected element: focus moves, measurement. */
        onMount(callback) {
            if (typeof callback !== 'function') {
                throw new TypeError(`Component ${definition.id} onMount expects a function.`);
            }
            mountCallbacks.push(callback);
        },
    };

    const mounted = definition.mount(props, mountContext);
    const element = mounted?.element ?? mounted;
    if (!(element instanceof Element)) {
        throw new TypeError(`Component ${definition.id} did not return a DOM element.`);
    }
    element.dataset.loomComponent = definition.id;

    entry = {
        element,
        definition,
        context: mountContext,
        node,
        props,
        content: mounted?.content ?? element,
        children: [],
        cleanups,
        mountCallbacks,
        mountRan: false,
        disposed: false,
        parent: parent ?? null,
        index: parent ? -1 : 0,
    };

    if (definition.container) {
        entry.children = node.children.map((childNode, index) => {
            const childEntry = mountNode(childNode, context, entry);
            hostFor(entry, index).append(childEntry.element);
            return childEntry;
        });
    }
    return entry;
}

/**
 * Release one entry and its subtree: leaves first, then cleanups (most recent
 * first), then the component's `unmount` while the element still exists.
 */
function disposeEntry(entry) {
    if (!entry || entry.disposed) return;
    entry.disposed = true;

    for (let index = entry.children.length - 1; index >= 0; index -= 1) {
        disposeEntry(entry.children[index]);
    }
    for (let index = entry.cleanups.length - 1; index >= 0; index -= 1) {
        try {
            entry.cleanups[index]();
        } catch (error) {
            console.error('[Loom UI] Component cleanup failed:', error);
        }
    }
    if (typeof entry.definition?.unmount === 'function') {
        try {
            entry.definition.unmount(entry.element, entry.props, entry.context);
        } catch (error) {
            console.error('[Loom UI] Component unmount failed:', error);
        }
    }
}

/** Rebuild the path -> entry index and refresh `data-loom-path` markers. */
function reindex(record) {
    const mounts = new Map();
    const visit = (entry, path) => {
        entry.index = path.length > 0 ? path[path.length - 1] : 0;
        const key = pathKey(path);
        if (entry.element?.dataset) entry.element.dataset.loomPath = key;
        mounts.set(key, entry);
        entry.children.forEach((child, index) => visit(child, [...path, index]));
    };
    visit(record.root, []);
    record.mounts = mounts;
}

/** Run `onMount` callbacks once per mount, parent-first, after attachment. */
function runMountCallbacks(record) {
    const visit = entry => {
        if (!entry.mountRan) {
            entry.mountRan = true;
            for (const callback of entry.mountCallbacks) {
                try {
                    callback(entry.element, entry.props, entry.context);
                } catch (error) {
                    console.error('[Loom UI] Component mount callback failed:', error);
                }
            }
        }
        entry.children.forEach(visit);
    };
    visit(record.root);
}

/* ------------------------------------------------------------------------- */
/* reconciliation                                                             */
/* ------------------------------------------------------------------------- */

function entryKey(node, index) {
    return node.key === undefined ? `index:${index}:${node.component}` : `key:${String(node.key)}`;
}

function shallowEqual(left, right) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => {
        if (!Object.hasOwn(right, key)) return false;
        if (Object.is(left[key], right[key])) return true;
        // Props may carry arrays/objects (menu items, options). Fall back to a
        // structural comparison rather than treating any object as changed.
        if (left[key] && right[key] && typeof left[key] === 'object' && typeof right[key] === 'object') {
            try {
                return JSON.stringify(left[key]) === JSON.stringify(right[key]);
            } catch {
                return false;
            }
        }
        return false;
    });
}

/**
 * Bring an existing entry in line with a new validated node.
 *
 * Returns the entry to use: the same one when it was patched in place, or a
 * freshly mounted replacement (whose old element the caller must swap out).
 */
function patchEntry(record, entry, node, context) {
    const definition = getComponent(node.component);
    if (!definition || definition.id !== entry.definition.id) {
        return { entry: mountNode(node, context, entry.parent), replaced: true };
    }

    const props = resolveProps(definition, node.props);
    if (!shallowEqual(entry.props, props)) {
        if (typeof definition.update !== 'function') {
            // No way to change this component in place: rebuild just this subtree.
            return { entry: mountNode(node, context, entry.parent), replaced: true };
        }
        definition.update(entry.element, props, entry.context);
        entry.props = props;
    }

    if (definition.container) {
        const sameShape = node.children.length === entry.children.length
            && node.children.every((childNode, index) => (
                entryKey(childNode, index) === entryKey(entry.children[index].node, index)
                && childNode.component === entry.children[index].node.component
            ));
        if (sameShape) {
            node.children.forEach((childNode, index) => {
                const result = patchEntry(record, entry.children[index], childNode, context);
                if (result.replaced) {
                    const previous = entry.children[index];
                    previous.element.replaceWith(result.entry.element);
                    disposeEntry(previous);
                    result.entry.parent = entry;
                    entry.children[index] = result.entry;
                }
            });
        } else {
            reconcileChildren(record, entry, node.children, context);
        }
    }

    entry.node = node;
    return { entry, replaced: false };
}

/**
 * Reconcile a container's children against a new node list. Matching children
 * keep their element, state and listeners; new ones are mounted; removed ones
 * are disposed. Order is applied by re-appending in the new sequence.
 *
 * Re-appending moves a node in the DOM, which blurs a focused element even when
 * the element object is reused, so focus is captured by *element identity* and
 * restored afterwards (keyed reuse keeps the object, a rebuild does not).
 */
function reconcileChildren(record, entry, childNodes, context) {
    const rootElement = record.element;
    const activeElement = typeof document !== 'undefined' && rootElement?.contains(document.activeElement)
        ? document.activeElement
        : null;
    const selection = activeElement && typeof activeElement.selectionStart === 'number'
        ? { start: activeElement.selectionStart, end: activeElement.selectionEnd }
        : null;

    const previous = entry.children;
    const byKey = new Map();
    previous.forEach((child, index) => byKey.set(entryKey(child.node, index), child));

    const used = new Set();
    const next = [];
    childNodes.forEach((childNode, index) => {
        const key = entryKey(childNode, index);
        const match = byKey.get(key);
        if (match && !used.has(match)) {
            used.add(match);
            const result = patchEntry(record, match, childNode, context);
            let childEntry = result.entry;
            if (result.replaced) {
                match.element.replaceWith(childEntry.element);
                disposeEntry(match);
                childEntry.parent = entry;
            }
            childEntry.parent = entry;
            next.push(childEntry);
            return;
        }
        const childEntry = mountNode(childNode, context, entry);
        next.push(childEntry);
    });

    for (const child of previous) {
        if (used.has(child)) continue;
        child.element.remove();
        disposeEntry(child);
    }

    entry.children = next;
    next.forEach((child, index) => {
        hostFor(entry, index).append(child.element);
        child.index = index;
    });
    entry.node.children = childNodes;

    if (activeElement && typeof rootElement?.contains === 'function' && rootElement.contains(activeElement)) {
        activeElement.focus?.();
        if (selection && typeof activeElement.setSelectionRange === 'function') {
            const length = typeof activeElement.value === 'string' ? activeElement.value.length : 0;
            activeElement.setSelectionRange(
                Math.min(selection.start, length),
                Math.min(selection.end, length),
            );
        }
    }
}

/* ------------------------------------------------------------------------- */
/* render state (focus / selection / scroll)                                  */
/* ------------------------------------------------------------------------- */

function captureRenderState(record) {
    const state = { focus: null, scroll: [], windowScroll: null };
    if (typeof document === 'undefined') return state;

    const active = document.activeElement;
    if (record.element && active && typeof record.element.contains === 'function' && record.element.contains(active)) {
        let node = active;
        let path = null;
        while (node) {
            const value = node.dataset?.loomPath;
            if (typeof value === 'string') {
                path = value;
                break;
            }
            node = node.parentNode;
        }
        if (path !== null) {
            const hasSelection = typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number';
            state.focus = {
                path,
                selection: hasSelection ? { start: active.selectionStart, end: active.selectionEnd } : null,
            };
        }
    }

    for (const [path, entry] of record.mounts) {
        if (entry.element?.scrollTop > 0) state.scroll.push({ path, top: entry.element.scrollTop });
    }
    if (typeof window !== 'undefined' && (window.scrollY || window.scrollX)) {
        state.windowScroll = { x: window.scrollX, y: window.scrollY };
    }
    return state;
}

function restoreRenderState(record, state) {
    if (state.windowScroll && typeof window !== 'undefined') {
        window.scrollTo?.(state.windowScroll.x, state.windowScroll.y);
    }
    for (const item of state.scroll) {
        const entry = record.mounts.get(item.path);
        if (entry) entry.element.scrollTop = item.top;
    }

    if (!state.focus) return;
    const entry = record.mounts.get(state.focus.path);
    if (!entry || typeof entry.element.focus !== 'function') return;
    entry.element.focus();
    if (state.focus.selection && typeof entry.element.setSelectionRange === 'function') {
        const length = typeof entry.element.value === 'string' ? entry.element.value.length : 0;
        entry.element.setSelectionRange(
            Math.min(state.focus.selection.start, length),
            Math.min(state.focus.selection.end, length),
        );
    }
}

/* ------------------------------------------------------------------------- */
/* view API                                                                   */
/* ------------------------------------------------------------------------- */

function resolveTarget(target) {
    if (target === undefined) return document.body;
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!(element instanceof Element)) {
        throw new Error(`View target not found: ${String(target)}`);
    }
    return element;
}

function bindCleanup(extensionId) {
    if (cleanupBound.has(extensionId)) return;
    cleanupBound.add(extensionId);
    addCleanup(extensionId, () => destroyAllViews(extensionId));
}

function entryAt(record, path) {
    const key = pathKey(path);
    const entry = record.mounts.get(key);
    if (!entry) throw new Error(`View path not found: [${path.join(', ')}]`);
    return entry;
}

/** Mount a subtree in place of `previous`, then reindex and run pending mount callbacks. */
function replaceEntry(record, previous, node) {
    const state = captureRenderState(record);
    const context = { extensionId: record.extensionId, viewId: record.id };
    const parentEntry = previous?.parent ?? null;
    const nextEntry = mountNode(node, context, parentEntry);

    if (previous) {
        nextEntry.index = previous.index;
        previous.element.replaceWith(nextEntry.element);
        disposeEntry(previous);
        if (parentEntry) parentEntry.children[previous.index] = nextEntry;
    }
    reindex(record);
    restoreRenderState(record, state);
    runMountCallbacks(record);
    return nextEntry;
}

function viewApi(record) {
    const assertAlive = () => {
        if (record.destroyed) throw new Error(`View has been destroyed: ${record.id}`);
    };

    return {
        id: record.id,
        extensionId: record.extensionId,
        get element() {
            return record.element;
        },
        setRoot(node) {
            assertAlive();
            const tree = validateNode(node);
            const state = captureRenderState(record);
            const previous = record.root;
            const oldElement = record.element;

            // Mount detached, swap, then reindex and run mount callbacks: a
            // callback that focuses or measures needs a connected element.
            const nextRoot = mountNode(tree, { extensionId: record.extensionId, viewId: record.id }, null);
            oldElement.replaceWith(nextRoot.element);
            disposeEntry(previous);

            record.tree = tree;
            record.root = nextRoot;
            record.element = nextRoot.element;
            reindex(record);
            restoreRenderState(record, state);
            runMountCallbacks(record);
            return this;
        },
        setProps(path, props) {
            assertAlive();
            const entry = entryAt(record, path);
            const previousProps = { ...locateNode(record.tree, path).props };
            updateNodeProps(record.tree, path, props);
            const target = locateNode(record.tree, path);
            const definition = getComponent(target.component);

            if (typeof definition?.update === 'function') {
                const resolved = resolveProps(definition, target.props);
                try {
                    definition.update(entry.element, resolved, entry.context);
                } catch (error) {
                    // The component rejected the new props (for example an unsafe
                    // image src): keep the tree consistent with the DOM.
                    target.props = previousProps;
                    throw error;
                }
                entry.props = resolved;
                entry.node = target;
                return this;
            }

            // No in-place update: rebuild only this subtree, not the whole view.
            replaceEntry(record, entry, target);
            return this;
        },
        setChildren(path, children) {
            assertAlive();
            const node = updateNodeChildren(record.tree, path, children);
            const entry = entryAt(record, path);
            reconcileChildren(record, entry, node.children, { extensionId: record.extensionId, viewId: record.id });
            reindex(record);
            runMountCallbacks(record);
            return this;
        },
        appendChild(path, child) {
            assertAlive();
            const node = appendNodeChild(record.tree, path, child);
            const entry = entryAt(record, path);
            const index = node.children.length - 1;
            const childEntry = mountNode(node.children[index], { extensionId: record.extensionId, viewId: record.id }, entry);
            entry.children.push(childEntry);
            hostFor(entry, index).append(childEntry.element);
            reindex(record);
            runMountCallbacks(record);
            return this;
        },
        remove(path) {
            assertAlive();
            if (!Array.isArray(path) || path.length === 0) {
                throw new Error('Cannot remove the root node; destroy the view instead.');
            }
            const entry = entryAt(record, path);
            removeNodeAt(record.tree, path);
            const parent = entry.parent;
            entry.element.remove();
            disposeEntry(entry);
            if (parent) parent.children.splice(entry.index, 1);
            reindex(record);
            return this;
        },
        describe() {
            assertAlive();
            return describeNode(record.tree);
        },
        serialize() {
            assertAlive();
            return serializeNode(record.tree);
        },
        destroy() {
            if (record.destroyed) return false;
            record.destroyed = true;
            disposeEntry(record.root);
            record.element.remove();
            record.mounts = new Map();
            views.delete(record.id);
            return true;
        },
    };
}

/**
 * Create a view from a declarative node tree.
 * @param {string} extensionId Owning extension (must be registered with Core).
 * @param {{ id?: string, target?: Element|string, root: object|string }} options
 */
export function createView(extensionId, options = {}) {
    requireRegisteredExtension(extensionId);
    if (!options || typeof options !== 'object') throw new TypeError('View options must be an object.');
    if (options.root === undefined) throw new TypeError('View options require a root node.');

    const id = options.id ?? `loom-view-${++idCounter}`;
    if (typeof id !== 'string' || id.trim() === '') throw new TypeError('View id must be a non-empty string.');
    if (views.has(id)) throw new Error(`View already exists: ${id}`);

    const tree = validateNode(options.root);
    const target = resolveTarget(options.target);
    const root = mountNode(tree, { extensionId, viewId: id }, null);
    target.append(root.element);

    const record = {
        id,
        extensionId,
        target,
        tree,
        root,
        element: root.element,
        mounts: new Map(),
        destroyed: false,
    };
    views.set(id, record);
    reindex(record);
    bindCleanup(extensionId);
    runMountCallbacks(record);
    return viewApi(record);
}

/**
 * Serialize a mounted view into plain JSON-compatible data (no event handlers).
 * The result can be passed to `createView` / `createViewFromSerialized`.
 */
export function serializeView(viewId) {
    const record = views.get(viewId);
    if (!record) throw new Error(`View not found: ${viewId}`);
    return serializeNode(record.tree);
}

function assertSerializedTree(node, path = 'root') {
    if (typeof node === 'string') return;
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new TypeError(`Serialized view node must be a string or an object (at ${path}).`);
    }
    if (node.on !== undefined) {
        throw new TypeError(`Serialized view cannot contain event handlers (at ${path}).`);
    }
    if (node.children !== undefined) {
        if (!Array.isArray(node.children)) {
            throw new TypeError(`Serialized view children must be an array (at ${path}).`);
        }
        node.children.forEach((child, index) => assertSerializedTree(child, `${path}[${index}]`));
    }
}

/**
 * Mount a view from a tree produced by `serializeView` (or any handler-free tree).
 *
 * @param {string} extensionId Owning extension (must be registered with Core).
 * @param {object|string} serialized Handler-free node tree.
 * @param {{ id?: string, target?: Element|string }} [options]
 */
export function createViewFromSerialized(extensionId, serialized, options = {}) {
    assertSerializedTree(serialized);
    return createView(extensionId, { ...options, root: serialized });
}

export function getView(viewId) {
    const record = views.get(viewId);
    return record ? viewApi(record) : null;
}

export function listViews(extensionId) {
    return [...views.values()]
        .filter(record => extensionId === undefined || record.extensionId === extensionId)
        .map(record => ({ id: record.id, extensionId: record.extensionId, root: describeNode(record.tree) }));
}

export function destroyAllViews(extensionId) {
    let destroyed = 0;
    for (const record of [...views.values()]) {
        if (extensionId === undefined || record.extensionId === extensionId) {
            disposeEntry(record.root);
            record.element.remove();
            record.destroyed = true;
            record.mounts = new Map();
            views.delete(record.id);
            destroyed += 1;
        }
    }
    if (extensionId !== undefined) cleanupBound.delete(extensionId);
    return destroyed;
}

export function resetViews() {
    for (const record of views.values()) {
        disposeEntry(record.root);
        record.element.remove();
    }
    views.clear();
    cleanupBound.clear();
    idCounter = 0;
}