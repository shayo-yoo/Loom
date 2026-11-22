/**
 * Composite components — a named, reusable UI unit defined by a view tree.
 *
 * A composite is registered like any other component (stable id, props, events),
 * so callers reference it by identity and can serialize it like an atomic
 * component. Its implementation is a nested view, which means it composes the
 * same engines instead of introducing a parallel one:
 *
 *   registerCompositeComponent('my-ext', {
 *       id: 'greeting',
 *       name: 'Greeting',
 *       props: { name: { type: 'string', default: 'world' } },
 *       build: props => ({ component: 'text', props: { text: `Hello ${props.name}` } }),
 *   });
 *
 * The nested view is destroyed on update and on unmount, so a composite cannot
 * leak views when the parent tree changes or the owning extension unloads.
 */
import { registerComponent } from './components.js';
import { createView } from './views.js';

export function registerCompositeComponent(extensionId, definition) {
    if (!definition || typeof definition !== 'object') {
        throw new TypeError('Composite component definition must be an object.');
    }
    if (typeof definition.build !== 'function') {
        throw new TypeError('Composite component build must be a function returning a view node.');
    }

    const childViews = new WeakMap();
    const render = (source, element, props, context) => {
        childViews.get(element)?.destroy?.();
        element.replaceChildren();
        const view = createView(source, { root: definition.build(props, context), target: element });
        childViews.set(element, view);
        return view;
    };

    return registerComponent(extensionId, {
        id: definition.id,
        name: definition.name,
        description: definition.description ?? 'Composite component',
        container: true,
        props: definition.props ?? {},
        mount: (props, context) => {
            const element = document.createElement('div');
            element.className = 'loom-composite';
            element.dataset.composite = definition.id;
            render(extensionId, element, props, context);
            return element;
        },
        update: (element, props, context) => {
            render(extensionId, element, props, context);
        },
        unmount: element => {
            childViews.get(element)?.destroy?.();
            childViews.delete(element);
        },
    });
}
