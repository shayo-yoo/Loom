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
    return {
        component: node.component,
        props: node.props ?? {},
        children: node.children ?? [],
        on: node.on ?? {},
    };
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
    const props = resolveProps(definition, normalized.props);
    validateEvents(definition, normalized.on, path);

    if (!Array.isArray(normalized.children)) {
        throw new TypeError(`Node ${path} children must be an array.`);
    }
    if (normalized.children.length > 0 && !definition.container) {
        throw new TypeError(`Component ${definition.id} is not a container and cannot have children.`);
    }
    const children = normalized.children.map((child, index) => validateNode(child, `${path}[${index}]`));

    return { component: definition.id, props, children, on: normalized.on };
}

export function describeNode(node) {
    const normalized = normalizeNode(node);
    return {
        component: normalized.component,
        props: normalized.props,
        children: normalized.children.map(describeNode),
    };
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
    return node;
}

export function appendNodeChild(tree, path, child) {
    const node = locateNode(tree, path);
    const definition = getComponent(node.component);
    if (!definition?.container) {
        throw new TypeError(`Component ${node.component} is not a container and cannot have children.`);
    }
    node.children.push(validateNode(child));
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