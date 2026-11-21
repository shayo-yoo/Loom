/**
 * Minimal DOM fixture for Loom UI unit tests.
 *
 * Node has no DOM, and the project deliberately has no build step or test
 * dependencies, so this file implements only the browser surface the view
 * engine and built-in components actually use: element trees, attributes,
 * classList, dataset, textContent, a tiny selector engine, bubbling events,
 * focus tracking and scroll offsets.
 *
 * It is a test double, not a browser: no layout, no CSS cascade, no real
 * geometry. Behaviour that depends on the browser (focus ring, media queries,
 * safe-area insets) is asserted against style.css instead of the fixture.
 */

function kebabCase(name) {
    return name.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
}

function matchesSimple(element, part) {
    const tag = part.match(/^[a-zA-Z][\w-]*/);
    if (tag && element.tagName !== tag[0].toUpperCase()) return false;

    for (const className of part.match(/\.([\w-]+)/g) ?? []) {
        if (!element.classList.contains(className.slice(1))) return false;
    }
    const id = part.match(/#([\w-]+)/);
    if (id && element.id !== id[1]) return false;

    for (const attribute of part.match(/\[[^\]]+\]/g) ?? []) {
        const inner = attribute.slice(1, -1);
        const equals = inner.indexOf('=');
        if (equals === -1) {
            if (!element.hasAttribute(inner.trim())) return false;
        } else {
            const name = inner.slice(0, equals).trim();
            const expected = inner.slice(equals + 1).trim().replace(/^["']|["']$/g, '');
            if (element.getAttribute(name) !== expected) return false;
        }
    }
    return true;
}

function matchesSelector(element, selector) {
    const parts = String(selector).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    if (!matchesSimple(element, parts[parts.length - 1])) return false;

    let index = parts.length - 2;
    let node = element.parentElement;
    while (node && index >= 0) {
        if (matchesSimple(node, parts[index])) index -= 1;
        node = node.parentElement;
    }
    return index < 0;
}

export function createEvent(type, properties = {}) {
    return {
        type,
        target: null,
        currentTarget: null,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
            this.defaultPrevented = true;
        },
        stopPropagation() {
            this.propagationStopped = true;
        },
        ...properties,
    };
}

export function createDomFixture() {
    const listenerStore = new WeakMap();

    class FakeText {
        constructor(text) {
            this.nodeType = 3;
            this.nodeName = '#text';
            this.parentNode = null;
            this._text = String(text ?? '');
        }

        get textContent() {
            return this._text;
        }

        set textContent(value) {
            this._text = String(value ?? '');
        }

        get parentElement() {
            return this.parentNode?.nodeType === 1 ? this.parentNode : null;
        }

        get isConnected() {
            let node = this;
            while (node.parentNode) node = node.parentNode;
            return node === document.documentElement;
        }

        remove() {
            this.parentNode?.removeChild(this);
        }
    }

    class FakeElement extends FakeText {
        constructor(tagName) {
            super('');
            this.nodeType = 1;
            this.nodeName = String(tagName).toUpperCase();
            this.tagName = this.nodeName;
            this.childNodes = [];
            this.ownerDocument = document;
            this._attributes = new Map();
            this._classList = null;
            this.dataset = new Proxy({}, {
                get: (_, key) => {
                    if (typeof key !== 'string') return undefined;
                    const value = this.getAttribute(`data-${kebabCase(key)}`);
                    return value === null ? undefined : value;
                },
                set: (_, key, value) => {
                    this.setAttribute(`data-${kebabCase(key)}`, value);
                    return true;
                },
                deleteProperty: (_, key) => {
                    this.removeAttribute(`data-${kebabCase(key)}`);
                    return true;
                },
                has: (_, key) => this.hasAttribute(`data-${kebabCase(key)}`),
            });
            this.style = {
                _values: new Map(),
                setProperty(name, value) {
                    this._values.set(name, String(value));
                    this[name] = String(value);
                },
                getPropertyValue(name) {
                    return this._values.get(name) ?? '';
                },
                removeProperty(name) {
                    this._values.delete(name);
                    delete this[name];
                },
            };
            this.value = '';
            this.checked = false;
            this.disabled = false;
            this.type = '';
            this.decoding = '';
            this.tabIndex = -1;
            this.selectionStart = null;
            this.selectionEnd = null;
            this.scrollTop = 0;
            this.scrollLeft = 0;
            this.scrollHeight = 0;
            this.scrollWidth = 0;
            this.clientHeight = 0;
            this.clientWidth = 0;
        }

        get children() {
            return this.childNodes.filter(node => node.nodeType === 1);
        }

        get parentElement() {
            return this.parentNode?.nodeType === 1 ? this.parentNode : null;
        }

        get isConnected() {
            let node = this;
            while (node.parentNode) node = node.parentNode;
            return node === document.documentElement;
        }

        get textContent() {
            return this.childNodes.map(child => child.textContent).join('');
        }

        set textContent(value) {
            for (const child of [...this.childNodes]) this.removeChild(child);
            if (value !== undefined && value !== null && String(value) !== '') {
                this.appendChild(new FakeText(value));
            }
        }

        get className() {
            return this.getAttribute('class') ?? '';
        }

        set className(value) {
            this.setAttribute('class', String(value ?? ''));
        }

        get id() {
            return this.getAttribute('id') ?? '';
        }

        set id(value) {
            this.setAttribute('id', String(value ?? ''));
        }

        get hidden() {
            return this.hasAttribute('hidden');
        }

        set hidden(value) {
            if (value) this.setAttribute('hidden', '');
            else this.removeAttribute('hidden');
        }

        get title() {
            return this.getAttribute('title') ?? '';
        }

        set title(value) {
            this.setAttribute('title', String(value ?? ''));
        }

        get role() {
            return this.getAttribute('role') ?? '';
        }

        set role(value) {
            this.setAttribute('role', String(value ?? ''));
        }

        get alt() {
            return this.getAttribute('alt') ?? '';
        }

        set alt(value) {
            this.setAttribute('alt', String(value ?? ''));
        }

        get src() {
            return this.getAttribute('src') ?? '';
        }

        set src(value) {
            this.setAttribute('src', String(value ?? ''));
        }

        get loading() {
            return this.getAttribute('loading') ?? '';
        }

        set loading(value) {
            this.setAttribute('loading', String(value ?? ''));
        }

        get placeholder() {
            return this.getAttribute('placeholder') ?? '';
        }

        set placeholder(value) {
            this.setAttribute('placeholder', String(value ?? ''));
        }

        get href() {
            return this.getAttribute('href') ?? '';
        }

        set href(value) {
            this.setAttribute('href', String(value ?? ''));
        }

        get classList() {
            if (!this._classList) {
                const self = this;
                const classes = () => (self.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
                this._classList = {
                    add(...names) {
                        const set = new Set(classes());
                        for (const name of names) set.add(String(name));
                        self.setAttribute('class', [...set].join(' '));
                    },
                    remove(...names) {
                        const drop = new Set(names.map(String));
                        self.setAttribute('class', classes().filter(name => !drop.has(name)).join(' '));
                    },
                    contains(name) {
                        return classes().includes(String(name));
                    },
                    toggle(name, force) {
                        const has = this.contains(name);
                        const enabled = force === undefined ? !has : Boolean(force);
                        if (enabled) this.add(name);
                        else this.remove(name);
                        return enabled;
                    },
                };
            }
            return this._classList;
        }

        setAttribute(name, value) {
            this._attributes.set(String(name).toLowerCase(), String(value));
        }

        getAttribute(name) {
            const key = String(name).toLowerCase();
            return this._attributes.has(key) ? this._attributes.get(key) : null;
        }

        hasAttribute(name) {
            return this._attributes.has(String(name).toLowerCase());
        }

        removeAttribute(name) {
            this._attributes.delete(String(name).toLowerCase());
        }

        get attributes() {
            return [...this._attributes].map(([name, value]) => ({ name, value }));
        }

        appendChild(node) {
            if (node.parentNode) node.parentNode.removeChild(node);
            node.parentNode = this;
            this.childNodes.push(node);
            return node;
        }

        insertBefore(node, reference) {
            if (node.parentNode) node.parentNode.removeChild(node);
            const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
            node.parentNode = this;
            this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
            return node;
        }

        removeChild(node) {
            const index = this.childNodes.indexOf(node);
            if (index === -1) throw new Error('removeChild: node is not a child of this element');
            this.childNodes.splice(index, 1);
            node.parentNode = null;
            if (document.activeElement
                && (document.activeElement === node
                    || (typeof node.contains === 'function' && node.contains(document.activeElement)))) {
                document.activeElement = document.body;
            }
            return node;
        }

        append(...nodes) {
            for (const node of nodes) {
                if (node === null || node === undefined) continue;
                this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
            }
        }

        replaceChildren(...nodes) {
            for (const child of [...this.childNodes]) this.removeChild(child);
            this.append(...nodes);
        }

        replaceWith(node) {
            const parent = this.parentNode;
            if (!parent) return;
            const index = parent.childNodes.indexOf(this);
            parent.removeChild(this);
            node.parentNode = parent;
            parent.childNodes.splice(index, 0, node);
        }

        remove() {
            this.parentNode?.removeChild(this);
        }

        contains(node) {
            let current = node;
            while (current) {
                if (current === this) return true;
                current = current.parentNode;
            }
            return false;
        }

        focus() {
            document.activeElement = this;
        }

        blur() {
            if (document.activeElement === this) document.activeElement = document.body;
        }

        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        }

        matches(selector) {
            return matchesSelector(this, selector);
        }

        closest(selector) {
            let node = this;
            while (node && node.nodeType === 1) {
                if (matchesSelector(node, selector)) return node;
                node = node.parentElement;
            }
            return null;
        }

        querySelector(selector) {
            return this.querySelectorAll(selector)[0] ?? null;
        }

        querySelectorAll(selector) {
            const results = [];
            const visit = node => {
                for (const child of node.childNodes) {
                    if (child.nodeType !== 1) continue;
                    if (matchesSelector(child, selector)) results.push(child);
                    visit(child);
                }
            };
            visit(this);
            return results;
        }

        addEventListener(type, handler) {
            if (!listenerStore.has(this)) listenerStore.set(this, new Map());
            const map = listenerStore.get(this);
            if (!map.has(type)) map.set(type, new Set());
            map.get(type).add(handler);
        }

        removeEventListener(type, handler) {
            listenerStore.get(this)?.get(type)?.delete(handler);
        }

        dispatchEvent(event) {
            if (!event.target) event.target = this;
            let node = this;
            while (node) {
                const handlers = listenerStore.get(node)?.get(event.type);
                if (handlers) {
                    event.currentTarget = node;
                    for (const handler of [...handlers]) {
                        if (typeof handler === 'function') handler.call(node, event);
                        else if (typeof handler?.handleEvent === 'function') handler.handleEvent(event);
                        if (event.propagationStopped) break;
                    }
                }
                if (event.propagationStopped) break;
                node = node.parentNode;
            }
            event.currentTarget = null;
            return !event.defaultPrevented;
        }
    }

    const document = {
        activeElement: null,
        createElement(tagName) {
            return new FakeElement(tagName);
        },
        createTextNode(text) {
            return new FakeText(text);
        },
        // Real documents are event targets too; components rely on this for
        // document-level listeners (Escape handling, outside clicks).
        addEventListener(type, handler) {
            if (!listenerStore.has(document)) listenerStore.set(document, new Map());
            const map = listenerStore.get(document);
            if (!map.has(type)) map.set(type, new Set());
            map.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            listenerStore.get(document)?.get(type)?.delete(handler);
        },
        dispatchEvent(event) {
            if (!event.target) event.target = document;
            const handlers = listenerStore.get(document)?.get(event.type);
            if (handlers) {
                event.currentTarget = document;
                for (const handler of [...handlers]) {
                    if (typeof handler === 'function') handler.call(document, event);
                    else if (typeof handler?.handleEvent === 'function') handler.handleEvent(event);
                    if (event.propagationStopped) break;
                }
            }
            event.currentTarget = null;
            return !event.defaultPrevented;
        },
        // Convenience for tests asserting listener hygiene.
        listenerCount(type) {
            return listenerStore.get(document)?.get(type)?.size ?? 0;
        },
        querySelector(selector) {
            return document.body.querySelector(selector);
        },
        querySelectorAll(selector) {
            return document.body.querySelectorAll(selector);
        },
    };

    const documentElement = new FakeElement('html');
    const body = new FakeElement('body');
    document.documentElement = documentElement;
    document.body = body;
    documentElement.appendChild(body);
    document.activeElement = body;

    const window = {
        document,
        scrollX: 0,
        scrollY: 0,
        scrollTo(x, y) {
            this.scrollX = Number(x) || 0;
            this.scrollY = Number(y) || 0;
        },
    };

    return { document, window, Element: FakeElement, Node: FakeText };
}

/**
 * Install a fixture on the global object, mirroring how components/views resolve
 * `document`, `window` and `Element` in a browser. Returns the fixture plus an
 * uninstall function that restores the previous globals.
 */
export function installDomFixture() {
    const fixture = createDomFixture();
    const globals = ['document', 'window', 'Element', 'Node'];
    const previous = new Map(globals.map(key => [key, {
        present: Object.hasOwn(globalThis, key),
        value: globalThis[key],
    }]));

    globalThis.document = fixture.document;
    globalThis.window = fixture.window;
    globalThis.Element = fixture.Element;
    globalThis.Node = fixture.Node;

    return {
        fixture,
        uninstall() {
            for (const key of globals) {
                const saved = previous.get(key);
                if (saved.present) globalThis[key] = saved.value;
                else delete globalThis[key];
            }
        },
    };
}
