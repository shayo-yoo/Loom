/**
 * Loom UI view engine: mounts validated declarative trees into the DOM and
 * exposes create/update/destroy operations. View records are owned by an
 * extension and released automatically when that extension is unregistered.
 */

import { addCleanup, listExtensions } from '../Loom%20Core/index.js';
import { getComponent, resolveProps } from './components.js';
import {
    appendNodeChild,
    describeNode,
    emitNodeEvent,
    normalizeNode,
    removeNodeAt,
    updateNodeChildren,
    updateNodeProps,
    validateNode,
} from './view-tree.js';

const views = new Map();
const cleanupBound = new Set();
let idCounter = 0;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function requireRegisteredExtension(extensionId) {
    if (typeof extensionId !== 'string' || !ID_PATTERN.test(extensionId)) {
        throw new TypeError('View extension id must contain only letters, numbers, dot, underscore, or hyphen.');
    }
    if (!listExtensions().some(extension => extension.id === extensionId)) {
        throw new Error(`Register the extension before creating views: ${extensionId}`);
    }
}

function renderNode(node, context, path) {
    const normalized = normalizeNode(node);
    const definition = getComponent(normalized.component);
    if (!definition) throw new Error(`Unknown component: ${normalized.component}`);
    const props = resolveProps(definition, normalized.props);

    const mounted = definition.mount(props, {
        emit: (eventName, payload) => emitNodeEvent(definition, normalized.on, context, path, eventName, payload),
        path: [...path],
        extensionId: context.extensionId,
    });
    const element = mounted?.element ?? mounted;
    if (!(element instanceof Element)) {
        throw new TypeError(`Component ${definition.id} did not return a DOM element.`);
    }
    element.dataset.loomComponent = definition.id;

    if (definition.container) {
        const content = mounted?.content ?? element;
        normalized.children.forEach((child, index) => {
            content.append(renderNode(child, context, [...path, index]));
        });
    }
    return element;
}

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

function renderRecord(record) {
    const previous = record.element;
    const element = renderNode(record.tree, { extensionId: record.extensionId, viewId: record.id }, []);
    previous.replaceWith(element);
    record.element = element;
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
            record.tree = validateNode(node);
            renderRecord(record);
            return this;
        },
        setProps(path, props) {
            assertAlive();
            updateNodeProps(record.tree, path, props);
            renderRecord(record);
            return this;
        },
        setChildren(path, children) {
            assertAlive();
            updateNodeChildren(record.tree, path, children);
            renderRecord(record);
            return this;
        },
        appendChild(path, child) {
            assertAlive();
            appendNodeChild(record.tree, path, child);
            renderRecord(record);
            return this;
        },
        remove(path) {
            assertAlive();
            removeNodeAt(record.tree, path);
            renderRecord(record);
            return this;
        },
        describe() {
            assertAlive();
            return describeNode(record.tree);
        },
        destroy() {
            if (record.destroyed) return false;
            record.destroyed = true;
            record.element.remove();
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
    const element = renderNode(tree, { extensionId, viewId: id }, []);
    target.append(element);

    const record = { id, extensionId, target, tree, element, destroyed: false };
    views.set(id, record);
    bindCleanup(extensionId);
    return viewApi(record);
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
            record.element.remove();
            record.destroyed = true;
            views.delete(record.id);
            destroyed += 1;
        }
    }
    if (extensionId !== undefined) cleanupBound.delete(extensionId);
    return destroyed;
}

export function resetViews() {
    for (const record of views.values()) record.element.remove();
    views.clear();
    cleanupBound.clear();
    idCounter = 0;
}