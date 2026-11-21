/**
 * Pure declarative view-tree logic: normalization, validation, description and
 * structural mutation. No DOM access, so it can be unit tested outside a
 * browser; `views.js` performs the actual rendering.
 */

import { getComponent, resolveProps } from './components.js';

export function normalizeNode(node) {
    if (typeof node === 'string') {
        return { component: 'text', props: { text: node }, children: [], on: {} };
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new TypeError('View node must be a string or a { component, props, children } object.');
    }
    if (typeof node.component !== 'string' || node.component.trim() === '') {
        throw new TypeError('View node requires a component id.');
    }
    const normalized = {
        component: node.component,
        props: node.props ?? {},
        children: node.children ?? [],
        on: node.on ?? {},
    };
    // Omitted entirely when absent so unkeyed trees keep their existing shape.
    if (node.key !== undefined) normalized.key = node.key;
    return normalized;
}

function validateKey(key, path) {
    if (key === undefined) return;
    if (typeof key === 'string' && key !== '') return;
    if (typeof key === 'number' && Number.isFinite(key)) return;
    throw new TypeError(`Node ${path} key must be a non-empty string or a finite number.`);
}

/**
 * Sibling keys must be unique: the reconciler matches old and new children by
 * key, so a duplicate would silently move the wrong element.
 */
function validateSiblingKeys(children, path) {
    const seen = new Set();
    children.forEach((child, index) => {
        if (child.key === undefined) return;
        const key = String(child.key);
        if (seen.has(key)) {
            throw new TypeError(`Duplicate node key "${key}" among siblings (at ${path}[${index}]).`);
        }
        seen.add(key);
    });
}

function validateEvents(definition, on, path) {
    if (!on || typeof on !== 'object' || Array.isArray(on)) {
        throw new TypeError(`Node ${path} events must be an object.`);
    }
    for (const [eventName, handler] of Object.entries(on)) {
        if (!definition.events.includes(eventName)) {
            throw new TypeError(`Component ${definition.id} does not emit event "${eventName}".`);
        }
        if (typeof handler !== 'function') {
            throw new TypeError(`Node ${path} event "${eventName}" handler must be a function.`);
        }
    }
}

/**
 * Validate a node tree and return a normalized copy with resolved props.
 */
export function validateNode(node, path = 'root') {
    const normalized = normalizeNode(node);
    const definition = getComponent(normalized.component);
    if (!definition) {
        throw new Error(`Unknown component: ${normalized.component} (at ${path}).`);
    }
    validateKey(normalized.key, path);
    const props = resolveProps(definition, normalized.props);
    validateEvents(definition, normalized.on, path);

    if (!Array.isArray(normalized.children)) {
        throw new TypeError(`Node ${path} children must be an array.`);
    }
    if (normalized.children.length > 0 && !definition.container) {
        throw new TypeError(`Component ${definition.id} is not a container and cannot have children.`);
    }
    const children = normalized.children.map((child, index) => validateNode(child, `${path}[${index}]`));
    validateSiblingKeys(children, path);

    const validated = { component: definition.id, props, children, on: normalized.on };
    if (normalized.key !== undefined) validated.key = normalized.key;
    return validated;
}

export function describeNode(node) {
    const normalized = normalizeNode(node);
    const description = {
        component: normalized.component,
        props: normalized.props,
        children: normalized.children.map(describeNode),
    };
    // Only surfaced when present, so unkeyed trees keep their existing shape.
    if (normalized.key !== undefined) description.key = normalized.key;
    return description;
}

function serializeValue(value) {
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value === 'bigint') {
        throw new TypeError('View props must be JSON-serializable; bigint is not supported.');
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        return value.map(item => serializeValue(item) ?? null);
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        const serialized = serializeValue(item);
        if (serialized !== undefined) result[key] = serialized;
    }
    return result;
}

/**
 * Turn a node tree into plain JSON-compatible data.
 *
 * Event handlers (`on`) are dropped because they are behaviour, not structure;
 * this is what makes a view round-trippable through `JSON.stringify` for a
 * future visual editor. Props are deep-copied so editing the serialized output
 * cannot mutate the mounted tree.
 */
export function serializeNode(node) {
    const normalized = normalizeNode(node);
    if (!Array.isArray(normalized.children)) {
        throw new TypeError('View node children must be an array.');
    }
    const serialized = {
        component: normalized.component,
        props: serializeValue(normalized.props) ?? {},
        children: normalized.children.map(serializeNode),
    };
    // Keys are structure, not behaviour: they survive serialization so a
    // re-mounted list keeps its identity semantics.
    if (normalized.key !== undefined) serialized.key = serializeValue(normalized.key);
    return serialized;
}

export function locateNode(tree, path) {
    if (!Array.isArray(path)) throw new TypeError('View path must be an array of child indexes.');
    let node = tree;
    for (const index of path) {
        if (!Number.isInteger(index) || index < 0) {
            throw new TypeError('View path indexes must be non-negative integers.');
        }
        if (!Array.isArray(node.children) || index >= node.children.length) {
            throw new Error(`View path not found: [${path.join(', ')}]`);
        }
        node = node.children[index];
    }
    return node;
}

export function updateNodeProps(tree, path, props) {
    const node = locateNode(tree, path);
    const definition = getComponent(node.component);
    if (!definition) throw new Error(`Unknown component: ${node.component}`);
    node.props = resolveProps(definition, { ...node.props, ...props });
    return node;
}

export function updateNodeChildren(tree, path, children) {
    if (!Array.isArray(children)) throw new TypeError('View children must be an array.');
    const node = locateNode(tree, path);
    const definition = getComponent(node.component);
    if (children.length > 0 && !definition?.container) {
        throw new TypeError(`Component ${node.component} is not a container and cannot have children.`);
    }
    node.children = children.map(child => validateNode(child));
    validateSiblingKeys(node.children, `path[${path.join(',')}]`);
    return node;
}

export function appendNodeChild(tree, path, child) {
    const node = locateNode(tree, path);
    const definition = getComponent(node.component);
    if (!definition?.container) {
        throw new TypeError(`Component ${node.component} is not a container and cannot have children.`);
    }
    node.children.push(validateNode(child));
    validateSiblingKeys(node.children, `path[${path.join(',')}]`);
    return node;
}

export function removeNodeAt(tree, path) {
    if (!Array.isArray(path) || path.length === 0) {
        throw new Error('Cannot remove the root node; destroy the view instead.');
    }
    const parent = locateNode(tree, path.slice(0, -1));
    const index = path[path.length - 1];
    if (!Number.isInteger(index) || index < 0 || index >= parent.children.length) {
        throw new Error(`View path not found: [${path.join(', ')}]`);
    }
    return parent.children.splice(index, 1)[0];
}

export function emitNodeEvent(definition, on, context, path, eventName, payload) {
    const handler = on?.[eventName];
    if (typeof handler !== 'function') return;
    try {
        const result = handler({
            event: eventName,
            payload,
            path: [...path],
            viewId: context.viewId,
            extensionId: context.extensionId,
        });
        if (result && typeof result.catch === 'function') {
            result.catch(error => console.error(`[Loom UI] ${definition.id} handler failed:`, error));
        }
    } catch (error) {
        console.error(`[Loom UI] ${definition.id} handler failed:`, error);
    }
}