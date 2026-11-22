import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerExtension, unregisterExtension } from '../Loom%20Core/index.js';
import { getComponent, registerComponent, resetComponents } from './components.js';
import { BUILTIN_COMPONENTS } from './builtin-components.js';
import { registerCompositeComponent } from './composite.js';
import { createView, resetViews } from './views.js';
import { installDomFixture } from './dom-fixture.js';

const owner = 'composite-test-owner';
let dom;

beforeEach(() => {
    dom = installDomFixture();
    registerExtension({ id: owner, name: 'Composite Test Owner' });
    for (const component of BUILTIN_COMPONENTS) registerComponent(owner, component);
});

afterEach(() => {
    resetViews();
    unregisterExtension(owner);
    resetComponents();
    dom.uninstall();
});

test('a composite component renders its tree and keeps a stable identity', () => {
    const snapshot = registerCompositeComponent(owner, {
        id: 'greeting',
        name: 'Greeting',
        props: { name: { type: 'string', default: 'world' } },
        build: props => ({ component: 'text', props: { text: `Hello ${props.name}` } }),
    });

    assert.equal(snapshot.id, 'greeting');
    assert.equal(snapshot.container, true);
    assert.deepEqual(getComponent('greeting')?.props.map(prop => prop.name), ['name']);

    const view = createView(owner, { root: { component: 'greeting', props: { name: 'Loom' } } });
    assert.match(view.element.textContent, /Hello Loom/);
    assert.equal(view.element.dataset.composite, 'greeting');
});

test('updating a composite re-renders the nested view without leaking it', () => {
    registerCompositeComponent(owner, {
        id: 'greeting',
        name: 'Greeting',
        props: { name: { type: 'string', default: 'world' } },
        build: props => ({ component: 'text', props: { text: `Hello ${props.name}` } }),
    });
    const view = createView(owner, { root: { component: 'greeting', props: { name: 'Loom' } } });

    view.setProps([], { name: 'World' });
    assert.match(view.element.textContent, /Hello World/);
    assert.equal(view.element.children.length, 1, 'the previous nested root was replaced');

    view.destroy();
    assert.equal(document.querySelectorAll('.loom-composite').length, 0);
});

test('a composite can nest other components and be used by another extension', () => {
    registerCompositeComponent(owner, {
        id: 'card-row',
        name: 'Card row',
        props: { label: { type: 'string', default: 'x' } },
        build: props => ({
            component: 'card',
            props: { title: props.label },
            children: [{ component: 'text', props: { text: 'body' } }],
        }),
    });

    registerExtension({ id: 'composite-consumer', name: 'Consumer' });
    try {
        const view = createView('composite-consumer', { root: { component: 'card-row', props: { label: 'Nested' } } });
        assert.match(view.element.textContent, /Nested/);
        assert.match(view.element.textContent, /body/);
        view.destroy();
    } finally {
        unregisterExtension('composite-consumer');
    }
});

test('composite definitions are validated', () => {
    assert.throws(() => registerCompositeComponent(owner, { id: 'no-build', name: 'X' }), /build must be a function/);
    assert.throws(() => registerCompositeComponent(owner, null), /definition must be an object/);
    // Duplicate component ids are still refused by the component registry.
    registerComponent(owner, { id: 'taken', name: 'Taken', mount: () => document.createElement('div') });
    assert.throws(() => registerCompositeComponent(owner, {
        id: 'taken', name: 'Taken twice', build: () => ({ component: 'text', props: { text: 'x' } }),
    }), /already registered/);
});
