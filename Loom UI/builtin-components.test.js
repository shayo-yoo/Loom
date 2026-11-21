import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerExtension, unregisterExtension } from '../Loom%20Core/index.js';
import { registerComponent, resetComponents } from './components.js';
import { BUILTIN_COMPONENTS, isSafeImageSource } from './builtin-components.js';
import { createEvent, installDomFixture } from './dom-fixture.js';
import { createView, resetViews } from './views.js';

const owner = 'builtin-components-test-owner';
const styleSheet = readFileSync(new URL('./style.css', import.meta.url), 'utf8');

let dom;

beforeEach(() => {
    dom = installDomFixture();
    registerExtension({ id: owner, name: 'Builtin Components Test Owner' });
    for (const component of BUILTIN_COMPONENTS) registerComponent(owner, component);
});

afterEach(() => {
    resetViews();
    unregisterExtension(owner);
    resetComponents();
    dom.uninstall();
});

test('new components are registered as short names with props, containers and events', () => {
    const byId = new Map(BUILTIN_COMPONENTS.map(component => [component.id, component]));

    for (const id of ['image', 'tabs', 'modal', 'menu']) {
        assert.ok(byId.has(id), `${id} is a built-in component`);
        assert.equal(id.includes('.'), false, `${id} keeps the built-in short-name convention`);
    }

    const image = byId.get('image');
    assert.equal(image.props.src.required, true);
    assert.equal(image.props.alt.required, true);
    assert.equal(image.props.fit.default, 'cover');
    assert.deepEqual(image.events, ['load', 'error']);

    const tabs = byId.get('tabs');
    assert.equal(tabs.container, true);
    assert.deepEqual(tabs.events, ['change']);
    assert.equal(tabs.props.active.default, 0);
    assert.equal(tabs.props.labels.required, true);

    const modal = byId.get('modal');
    assert.equal(modal.container, true);
    assert.deepEqual(modal.events, ['close']);
    assert.equal(modal.props.open.default, false);
    assert.equal(modal.props.closable.default, true);

    const menu = byId.get('menu');
    assert.deepEqual(menu.events, ['select']);
    assert.equal(menu.props.items.required, true);
});

test('image mounts a lazy image with alt, caption and fit class', () => {
    const view = createView(owner, {
        id: 'image-view',
        root: {
            component: 'image',
            props: {
                src: 'https://example.com/picture.png',
                alt: 'A picture',
                caption: 'Caption text',
            },
        },
    });

    const figure = view.element;
    const img = figure.querySelector('img');
    const caption = figure.querySelector('figcaption');

    assert.equal(img.getAttribute('loading'), 'lazy');
    assert.equal(img.getAttribute('src'), 'https://example.com/picture.png');
    assert.equal(img.alt, 'A picture');
    assert.equal(caption.textContent, 'Caption text');
    assert.equal(caption.hidden, false);
    assert.equal(img.classList.contains('loom-image-fit-cover'), true);
    assert.equal(img.getAttribute('data-fit'), 'cover');
});

test('image update reuses the img element and applies contain fit', () => {
    const view = createView(owner, {
        root: {
            component: 'image',
            props: { src: 'https://example.com/a.png', alt: 'A', caption: 'Old' },
        },
    });

    const figure = view.element;
    const img = figure.querySelector('img');

    view.setProps([], {
        src: 'data:image/png;base64,AAAA',
        alt: 'B',
        caption: 'New',
        fit: 'contain',
    });

    assert.equal(view.element, figure, 'image has update, so the root was not rebuilt');
    assert.equal(figure.querySelector('img'), img, 'the img element was reused');
    assert.equal(img.getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.equal(img.alt, 'B');
    assert.equal(figure.querySelector('figcaption').textContent, 'New');
    assert.equal(img.classList.contains('loom-image-fit-contain'), true);
    assert.equal(img.getAttribute('data-fit'), 'contain');

    view.setProps([], { caption: '' });
    assert.equal(figure.querySelector('figcaption').hidden, true);
});

test('image emits load and error events with its source', () => {
    const seen = [];
    const view = createView(owner, {
        root: {
            component: 'image',
            props: { src: 'https://example.com/a.png', alt: 'A' },
            on: {
                load: event => seen.push(['load', event.payload]),
                error: event => seen.push(['error', event.payload]),
            },
        },
    });

    const img = view.element.querySelector('img');
    img.dispatchEvent(createEvent('load'));
    img.dispatchEvent(createEvent('error'));

    assert.deepEqual(seen, [
        ['load', { src: 'https://example.com/a.png' }],
        ['error', { src: 'https://example.com/a.png' }],
    ]);
});

test('image rejects unsafe schemes at validation and mount time', () => {
    for (const source of [
        'https://example.com/a.png',
        'http://example.com/a.png',
        'data:image/png;base64,AAAA',
        'blob:https://example.com/1234',
    ]) {
        assert.equal(isSafeImageSource(source), true, `${source} is allowed`);
    }
    for (const source of [
        'javascript:alert(1)',
        'file:///C:/a.png',
        'ftp://example.com/a.png',
        '//example.com/a.png',
        'relative.png',
        '',
        undefined,
        null,
    ]) {
        assert.equal(isSafeImageSource(source), false, `${String(source)} is rejected`);
    }

    assert.throws(
        () => createView(owner, { root: { component: 'image', props: { src: 'javascript:alert(1)', alt: 'x' } } }),
        /Image src must start with/,
    );
    assert.throws(
        () => createView(owner, { root: { component: 'image', props: { src: 'https://example.com/a.png' } } }),
        /"alt" is required/,
        'alt is required',
    );
});

test('a rejected image update leaves the mounted tree and DOM unchanged', () => {
    const view = createView(owner, {
        root: { component: 'image', props: { src: 'https://example.com/a.png', alt: 'A' } },
    });
    const before = view.describe();
    const img = view.element.querySelector('img');

    assert.throws(() => view.setProps([], { src: 'javascript:alert(1)' }), /Image src must start with/);
    assert.deepEqual(view.describe(), before, 'the tree was rolled back');
    assert.equal(img.getAttribute('src'), 'https://example.com/a.png', 'the DOM kept the previous source');
});

test('tabs is controlled: click and keyboard emit change, the caller selects', () => {
    const changes = [];
    const view = createView(owner, {
        id: 'tabs-view',
        root: {
            component: 'tabs',
            props: { labels: ['One', 'Two', 'Three'] },
            on: { change: event => changes.push(event.payload) },
            children: ['first', 'second', 'third'],
        },
    });

    const element = view.element;
    const tabs = element.querySelectorAll('.loom-tabs-tab');
    const panels = element.querySelectorAll('.loom-tabs-panel');

    assert.equal(tabs.length, 3);
    assert.deepEqual(tabs.map(tab => tab.textContent), ['One', 'Two', 'Three']);
    assert.equal(tabs[0].getAttribute('role'), 'tab');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(panels.length, 3);
    assert.deepEqual(panels.map(panel => panel.textContent), ['first', 'second', 'third']);
    assert.equal(panels[0].hidden, false);
    assert.equal(panels[1].hidden, true);
    assert.equal(panels[2].hidden, true);

    // A click reports intent but does not select: the declared tree stays true.
    tabs[1].dispatchEvent(createEvent('click'));
    assert.deepEqual(changes, [{ index: 1 }]);
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(panels[0].hidden, false, 'the controlled component did not switch on its own');
    assert.equal(panels[1].hidden, true);

    view.setProps([], { active: 1 });
    assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(panels[0].hidden, true);
    assert.equal(panels[1].hidden, false);

    tabs[1].dispatchEvent(createEvent('keydown', { key: 'ArrowRight' }));
    assert.deepEqual(changes, [{ index: 1 }, { index: 2 }]);
    view.setProps([], { active: 2 });
    assert.equal(panels[2].hidden, false);

    tabs[2].dispatchEvent(createEvent('keydown', { key: 'Home' }));
    assert.deepEqual(changes, [{ index: 1 }, { index: 2 }, { index: 0 }]);
    view.setProps([], { active: 0 });
    assert.equal(panels[0].hidden, false);
});

test('tabs update changes labels and active without rebuilding panels or children', () => {
    const view = createView(owner, {
        root: {
            component: 'tabs',
            props: { labels: ['A', 'B'], active: 0 },
            children: ['alpha', 'beta'],
        },
    });

    const element = view.element;
    const [panelA, panelB] = element.querySelectorAll('.loom-tabs-panel');

    view.setProps([], { labels: ['A2', 'B2'], active: 1 });

    assert.equal(view.element, element, 'tabs has update, so the root was not rebuilt');
    assert.deepEqual(element.querySelectorAll('.loom-tabs-tab').map(tab => tab.textContent), ['A2', 'B2']);
    assert.equal(element.querySelectorAll('.loom-tabs-panel')[0], panelA);
    assert.equal(element.querySelectorAll('.loom-tabs-panel')[1], panelB);
    assert.deepEqual(element.querySelectorAll('.loom-tabs-panel').map(panel => panel.textContent), ['alpha', 'beta']);
    assert.equal(panelA.hidden, true);
    assert.equal(panelB.hidden, false);
    assert.equal(view.describe().props.active, 1);
});

test('modal renders a dialog, controls visibility and emits close', () => {
    let closed = 0;
    const view = createView(owner, {
        id: 'modal-view',
        root: {
            component: 'modal',
            props: { open: true, title: 'Hello' },
            on: { close: () => { closed += 1; } },
            children: ['body text'],
        },
    });

    const element = view.element;
    const dialog = element.querySelector('.loom-modal-dialog');

    assert.equal(element.hidden, false);
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.getAttribute('aria-label'), 'Hello');
    assert.equal(element.querySelector('.loom-modal-title').textContent, 'Hello');
    assert.equal(element.querySelector('.loom-modal-body').textContent, 'body text');
    assert.equal(element.querySelector('.loom-modal-close').hidden, false);

    element.querySelector('.loom-modal-close').dispatchEvent(createEvent('click'));
    assert.equal(closed, 1, 'close button emitted close');

    element.dispatchEvent(createEvent('click'));
    assert.equal(closed, 2, 'overlay click emitted close');

    // Escape is handled at the document level (the way a keydown reaches a real
    // page: target focused element, bubble to document).
    globalThis.document.dispatchEvent(createEvent('keydown', { key: 'Escape' }));
    assert.equal(closed, 3, 'Escape emitted close');

    // Controlled component: the parent owns `open`.
    assert.equal(element.hidden, false);
    view.setProps([], { open: false });
    assert.equal(element.hidden, true);
    assert.equal(view.element, element, 'modal has update, so the root was not rebuilt');

    view.setProps([], { open: true });
    assert.equal(element.hidden, false);
    assert.equal(globalThis.document.activeElement, dialog, 'opening moves focus into the dialog');
});

test('modal honors closable=false', () => {
    let closed = 0;
    const view = createView(owner, {
        root: {
            component: 'modal',
            props: { open: true, closable: false },
            on: { close: () => { closed += 1; } },
            children: ['x'],
        },
    });

    const closeButton = view.element.querySelector('.loom-modal-close');
    assert.equal(closeButton.hidden, true);

    view.element.dispatchEvent(createEvent('click'));
    globalThis.document.dispatchEvent(createEvent('keydown', { key: 'Escape' }));
    assert.equal(closed, 0, 'not closable means no close event');
});

test('menu renders items and emits select, including after an update', () => {
    const selected = [];
    const view = createView(owner, {
        root: {
            component: 'menu',
            props: { items: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
            on: { select: event => selected.push(event.payload) },
        },
    });

    const items = view.element.querySelectorAll('.loom-menu-item');
    assert.deepEqual(items.map(item => item.textContent), ['Alpha', 'Beta']);
    assert.equal(items[0].getAttribute('role'), 'menuitem');
    assert.equal(items[1].dataset.itemId, 'b');

    items[1].dispatchEvent(createEvent('click'));
    assert.deepEqual(selected, [{ id: 'b' }]);

    view.setProps([], { items: [{ id: 'c', label: 'Gamma' }] });
    assert.equal(view.element.querySelectorAll('.loom-menu-item').length, 1);
    view.element.querySelector('.loom-menu-item').dispatchEvent(createEvent('click'));
    assert.deepEqual(selected, [{ id: 'b' }, { id: 'c' }], 'selection still works after the item list changed');
});

test('menu rejects malformed items', () => {
    assert.throws(
        () => createView(owner, { root: { component: 'menu', props: { items: [{ id: '', label: 'x' }] } } }),
        /Menu item 0 requires/,
    );
    assert.throws(
        () => createView(owner, { root: { component: 'menu', props: { items: ['x'] } } }),
        /Menu item 0 requires/,
    );
    assert.throws(
        () => createView(owner, { root: { component: 'menu', props: { items: [{ id: 'a' }] } } }),
        /Menu item 0 requires/,
    );
});

test('new component styles use theme variables, safe areas and 44px touch targets', () => {
    const section = styleSheet.slice(styleSheet.indexOf('/* Loom image / tabs / modal / menu.'));
    assert.ok(section.length > 0, 'the new style section exists');

    assert.match(section, /var\(--SmartTheme/);
    assert.doesNotMatch(section, /background(-color)?:\s*(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i,
        'backgrounds use theme variables, not hard-coded page colours');
    assert.match(section, /env\(safe-area-inset-top/);
    assert.match(section, /@media \(max-width: 600px\)/);
    assert.match(section, /@media \(max-width: 600px\) \{[\s\S]*?\.loom-modal-dialog\s*\{[^}]*width:\s*100%/,
        'the mobile dialog fills the width');
    assert.match(section, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(section, /\.loom-tabs-tab\s*{[^}]*min-height:\s*44px/);
    assert.match(section, /\.loom-tabs-tab\s*{[^}]*min-width:\s*44px/);
    assert.match(section, /\.loom-modal-close\s*{[^}]*min-height:\s*44px/);
    assert.match(section, /\.loom-menu-item\s*{[^}]*min-height:\s*44px/);
    assert.match(section, /\.loom-modal\[hidden\]\s*{\s*display:\s*none/,
        'hidden modals stay hidden despite display:flex');
    assert.match(section, /\.loom-tabs-panel\[hidden\]\s*{\s*display:\s*none/,
        'hidden tab panels stay hidden despite display:flex');
});

test('modal handles Escape at the document level and removes the listener on destroy', () => {
    let closed = 0;
    const view = createView(owner, {
        id: 'modal-escape',
        root: {
            component: 'modal',
            props: { open: true, title: 'Escape' },
            on: { close: () => { closed += 1; } },
            children: ['x'],
        },
    });
    assert.equal(globalThis.document.listenerCount('keydown'), 1, 'one document listener while mounted');

    globalThis.document.dispatchEvent(createEvent('keydown', { key: 'Enter' }));
    assert.equal(closed, 0, 'other keys are ignored');
    globalThis.document.dispatchEvent(createEvent('keydown', { key: 'Escape' }));
    assert.equal(closed, 1);

    view.destroy();
    assert.equal(globalThis.document.listenerCount('keydown'), 0, 'the document listener is released with the view');
    globalThis.document.dispatchEvent(createEvent('keydown', { key: 'Escape' }));
    assert.equal(closed, 1, 'a destroyed modal must not react to document keys');
});

test('modal traps Tab inside the dialog and restores focus when closed', () => {
    const before = globalThis.document.createElement('button');
    globalThis.document.body.append(before);
    before.focus();

    let closed = 0;
    const view = createView(owner, {
        id: 'modal-focus',
        root: {
            component: 'modal',
            props: { open: true, title: 'Focus' },
            on: { close: () => { closed += 1; } },
            children: [{ component: 'button', props: { label: 'Confirm' } }],
        },
    });

    const dialog = view.element.querySelector('.loom-modal-dialog');
    assert.equal(globalThis.document.activeElement, dialog, 'opening moves focus into the dialog');

    const focusables = dialog.querySelectorAll('button');
    assert.ok(focusables.length >= 2, 'dialog has the close button and the child button');

    // Tab from the last focusable wraps to the first.
    focusables[focusables.length - 1].focus();
    globalThis.document.dispatchEvent(createEvent('keydown', { key: 'Tab' }));
    assert.equal(globalThis.document.activeElement, focusables[0], 'Tab wraps to the first control');

    // Shift+Tab from the first wraps to the last.
    focusables[0].focus();
    globalThis.document.dispatchEvent(createEvent('keydown', { key: 'Tab', shiftKey: true }));
    assert.equal(globalThis.document.activeElement, focusables[focusables.length - 1], 'Shift+Tab wraps backwards');

    view.setProps([], { open: false });
    assert.equal(globalThis.document.activeElement, before, 'closing returns focus to the opener');
    assert.equal(closed, 0, 'closing is controlled by the caller, not emitted here');
});

test('restoring modal focus is avoided when the opener is gone', () => {
    const before = globalThis.document.createElement('button');
    globalThis.document.body.append(before);
    before.focus();

    const view = createView(owner, {
        id: 'modal-focus-gone',
        root: { component: 'modal', props: { open: true }, children: ['x'] },
    });

    before.remove();
    view.setProps([], { open: false });
    assert.notEqual(globalThis.document.activeElement, before, 'a detached opener is not refocused');
});

test('card hides empty title and subtitle instead of leaving blank nodes', () => {
    const view = createView(owner, {
        id: 'card-empty',
        root: { component: 'card', props: { title: 'Title', subtitle: 'Sub' }, children: ['body'] },
    });

    const title = view.element.querySelector('.loom-card-title');
    const subtitle = view.element.querySelector('.loom-card-subtitle');
    assert.equal(title.hidden, false);

    view.setProps([], { title: '', subtitle: '' });
    assert.equal(title.hidden, true, 'an empty title is hidden');
    assert.equal(subtitle.hidden, true, 'an empty subtitle is hidden');

    view.setProps([], { title: 'Again' });
    assert.equal(title.hidden, false);
    assert.equal(title.textContent, 'Again');
});
