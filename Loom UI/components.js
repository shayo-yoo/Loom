/**
 * Loom UI component registry.
 *
 * A component describes a node type: how to create it, how to update its
 * props, which props it accepts, and which interaction events it emits.
 * Components are owned by the extension that registered them and are removed
 * automatically when that extension is unregistered from Loom Core.
 */

import { addCleanup, listExtensions } from '../Loom%20Core/index.js';

const componentRegistry = new Map();
const cleanupBound = new Set();

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PROP_TYPES = new Set(['array', 'boolean', 'number', 'object', 'string']);

function validateComponentId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        throw new TypeError('Component id must contain only letters, numbers, dot, underscore, or hyphen.');
    }
}

function requireRegisteredExtension(extensionId) {
    if (typeof extensionId !== 'string' || !ID_PATTERN.test(extensionId)) {
        throw new TypeError('Component extension id must contain only letters, numbers, dot, underscore, or hyphen.');
    }
    if (!listExtensions().some(extension => extension.id === extensionId)) {
        throw new Error(`Register the extension before registering components: ${extensionId}`);
    }
}

function normalizeProp(name, definition, componentId) {
    if (typeof definition === 'string') {
        if (!PROP_TYPES.has(definition)) {
            throw new TypeError(`Component ${componentId} prop "${name}" has unsupported type "${definition}".`);
        }
        return Object.freeze({ name, type: definition, required: false, default: undefined, description: '' });
    }
    if (!definition || typeof definition !== 'object') {
        throw new TypeError(`Component ${componentId} prop "${name}" must be a type string or an object.`);
    }
    const type = definition.type ?? 'string';
    if (!PROP_TYPES.has(type)) {
        throw new TypeError(`Component ${componentId} prop "${name}" has unsupported type "${type}".`);
    }
    return Object.freeze({
        name,
        type,
        required: Boolean(definition.required),
        default: definition.default,
        description: typeof definition.description === 'string' ? definition.description : '',
    });
}

function snapshotComponent(component) {
    return {
        id: component.id,
        extensionId: component.extensionId,
        name: component.name,
        description: component.description,
        container: component.container,
        props: component.props.map(prop => ({ ...prop })),
        events: [...component.events],
    };
}

function bindCleanup(extensionId) {
    if (cleanupBound.has(extensionId)) return;
    cleanupBound.add(extensionId);
    addCleanup(extensionId, () => {
        for (const [id, component] of [...componentRegistry]) {
            if (component.extensionId === extensionId) componentRegistry.delete(id);
        }
        cleanupBound.delete(extensionId);
    });
}

/**
 * Register a UI component type owned by an extension.
 */
export function registerComponent(extensionId, component) {
    requireRegisteredExtension(extensionId);
    if (!component || typeof component !== 'object') {
        throw new TypeError('Component definition must be an object.');
    }
    validateComponentId(component.id);
    if (componentRegistry.has(component.id)) {
        throw new Error(`Component already registered: ${component.id}`);
    }
    if (typeof component.name !== 'string' || component.name.trim() === '') {
        throw new TypeError('Component name is required.');
    }
    if (typeof component.mount !== 'function') {
        throw new TypeError('Component mount must be a function.');
    }
    if (component.update !== undefined && typeof component.update !== 'function') {
        throw new TypeError('Component update must be a function.');
    }
    if (component.unmount !== undefined && typeof component.unmount !== 'function') {
        throw new TypeError('Component unmount must be a function.');
    }

    const props = component.props && typeof component.props === 'object' && !Array.isArray(component.props)
        ? Object.entries(component.props).map(([name, definition]) => normalizeProp(name, definition, component.id))
        : [];
    const events = Array.isArray(component.events) ? component.events.map(String) : [];

    const record = Object.freeze({
        id: component.id,
        extensionId,
        name: component.name.trim(),
        description: typeof component.description === 'string' ? component.description : '',
        container: Boolean(component.container),
        props,
        events,
        mount: component.mount,
        update: component.update,
        unmount: component.unmount,
    });
    componentRegistry.set(record.id, record);
    bindCleanup(extensionId);
    return snapshotComponent(record);
}

export function getComponent(componentId) {
    validateComponentId(componentId);
    return componentRegistry.get(componentId) ?? null;
}

export function listComponents(extensionId) {
    if (extensionId !== undefined && (typeof extensionId !== 'string' || !ID_PATTERN.test(extensionId))) {
        throw new TypeError('Component extension id must contain only letters, numbers, dot, underscore, or hyphen.');
    }
    return [...componentRegistry.values()]
        .filter(component => extensionId === undefined || component.extensionId === extensionId)
        .map(snapshotComponent);
}

export function unregisterComponent(componentId) {
    validateComponentId(componentId);
    return componentRegistry.delete(componentId);
}

/**
 * Validate a props object against a component's declared props.
 * Unknown props and missing required props are rejected; defaults are applied.
 */
export function resolveProps(component, props = {}) {
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
        throw new TypeError(`Component ${component.id} props must be an object.`);
    }
    const resolved = {};
    const declared = new Map(component.props.map(prop => [prop.name, prop]));

    for (const [name, value] of Object.entries(props)) {
        const definition = declared.get(name);
        if (!definition) {
            throw new TypeError(`Component ${component.id} does not accept prop "${name}".`);
        }
        if (value === undefined) continue;
        const actual = Array.isArray(value) ? 'array' : typeof value;
        if (actual !== definition.type) {
            throw new TypeError(`Component ${component.id} prop "${name}" expects ${definition.type}, received ${actual}.`);
        }
        resolved[name] = value;
    }

    for (const definition of component.props) {
        if (!Object.hasOwn(resolved, definition.name) && definition.default !== undefined) {
            resolved[definition.name] = definition.default;
        }
        if (definition.required && resolved[definition.name] === undefined) {
            throw new TypeError(`Component ${component.id} prop "${definition.name}" is required.`);
        }
    }
    return resolved;
}

export function resetComponents() {
    componentRegistry.clear();
    cleanupBound.clear();
}