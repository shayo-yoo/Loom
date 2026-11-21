/**
 * Built-in Loom UI components. Components never inject HTML strings from
 * props; text is assigned through textContent so extension-provided values
 * cannot become markup.
 */

function applyTone(element, tone) {
    for (const value of ['default', 'muted', 'info', 'success', 'warning', 'error']) {
        element.classList.toggle(`loom-tone-${value}`, value === tone);
    }
}

function createText(props) {
    const element = document.createElement('div');
    element.className = `loom-text loom-text-${props.variant}`;
    applyTone(element, props.tone);
    element.textContent = props.text;
    return element;
}

function updateText(element, props) {
    element.className = `loom-text loom-text-${props.variant}`;
    applyTone(element, props.tone);
    element.textContent = props.text;
}

function createButton(props, context) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `loom-button loom-button-${props.variant}`;
    element.textContent = props.label;
    element.disabled = props.disabled;
    element.addEventListener('click', () => context.emit('click', {}));
    return element;
}

function updateButton(element, props) {
    element.className = `loom-button loom-button-${props.variant}`;
    element.textContent = props.label;
    element.disabled = props.disabled;
}

function createInput(props, context) {
    const element = document.createElement('input');
    element.className = 'loom-input text_pole';
    element.type = props.type;
    element.value = props.value;
    element.placeholder = props.placeholder;
    element.disabled = props.disabled;
    element.addEventListener('change', () => context.emit('change', { value: element.value }));
    return element;
}

function updateInput(element, props) {
    if (element.value !== props.value) element.value = props.value;
    element.type = props.type;
    element.placeholder = props.placeholder;
    element.disabled = props.disabled;
}

function createToggle(props, context) {
    const label = document.createElement('label');
    label.className = 'loom-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = props.checked;
    input.addEventListener('change', () => context.emit('change', { checked: input.checked }));
    const span = document.createElement('span');
    span.textContent = props.label;
    label.append(input, span);
    return label;
}

function updateToggle(element, props) {
    const input = element.querySelector('input');
    if (input) input.checked = props.checked;
    const span = element.querySelector('span');
    if (span) span.textContent = props.label;
}

function createSelect(props, context) {
    const element = document.createElement('select');
    element.className = 'loom-select text_pole';
    for (const option of props.options) {
        const item = document.createElement('option');
        item.value = String(option);
        item.textContent = String(option);
        element.append(item);
    }
    element.value = props.value;
    element.addEventListener('change', () => context.emit('change', { value: element.value }));
    return element;
}

function updateSelect(element, props) {
    element.replaceChildren();
    for (const option of props.options) {
        const item = document.createElement('option');
        item.value = String(option);
        item.textContent = String(option);
        element.append(item);
    }
    element.value = props.value;
}

function createCard(props) {
    const element = document.createElement('section');
    element.className = 'loom-card';
    if (props.title) {
        const title = document.createElement('h3');
        title.className = 'loom-card-title';
        title.textContent = props.title;
        element.append(title);
    }
    if (props.subtitle) {
        const subtitle = document.createElement('p');
        subtitle.className = 'loom-card-subtitle';
        subtitle.textContent = props.subtitle;
        element.append(subtitle);
    }
    const content = document.createElement('div');
    content.className = 'loom-card-content';
    element.append(content);
    return { element, content };
}

function updateCard(element, props) {
    const title = element.querySelector('.loom-card-title');
    if (title) {
        title.textContent = props.title ?? '';
        // An empty heading must not leave a blank line in the layout.
        title.hidden = !props.title;
    }
    const subtitle = element.querySelector('.loom-card-subtitle');
    if (subtitle) {
        subtitle.textContent = props.subtitle ?? '';
        subtitle.hidden = !props.subtitle;
    }
}

function createLayout(className) {
    return props => {
        const element = document.createElement('div');
        element.className = className;
        if (className === 'loom-grid' && props.responsive) {
            element.classList.add('loom-grid-responsive');
        }
        if (props.gap !== undefined) element.style.gap = `${props.gap}px`;
        if (className === 'loom-grid' && props.columns !== undefined) {
            // Use a CSS variable so the stylesheet can collapse columns on narrow
            // screens; an inline grid-template-columns would always win.
            element.style.setProperty('--loom-columns', String(props.columns));
        }
        return { element, content: element };
    };
}

function updateLayout(element, props) {
    if (props.gap !== undefined) element.style.gap = `${props.gap}px`;
    if (element.classList.contains('loom-grid') && props.columns !== undefined) {
        element.style.setProperty('--loom-columns', String(props.columns));
    }
}

const gapProp = { type: 'number', default: 8, description: '子元素间距（像素）。' };

/* ------------------------------------------------------------------------- */
/* image                                                                      */
/* ------------------------------------------------------------------------- */

const IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:)/i;
const imageState = new WeakMap();

/**
 * Image sources are restricted to fetchable schemes so a prop can never become
 * a `javascript:`/`file:` navigation vector. `data:` and `blob:` are allowed
 * because they are self-contained image payloads, not navigation.
 */
export function isSafeImageSource(src) {
    if (typeof src !== 'string') return false;
    return IMAGE_SOURCE_PATTERN.test(src.trim());
}

function requireSafeImageSource(src) {
    if (!isSafeImageSource(src)) {
        throw new TypeError('Image src must start with http:, https:, data:, or blob:.');
    }
    return src.trim();
}

function applyImageFit(img, fit) {
    const normalized = fit === 'contain' ? 'contain' : 'cover';
    img.classList.toggle('loom-image-fit-cover', normalized === 'cover');
    img.classList.toggle('loom-image-fit-contain', normalized === 'contain');
    img.dataset.fit = normalized;
}

function createImage(props, context) {
    const source = requireSafeImageSource(props.src);
    const figure = document.createElement('figure');
    figure.className = 'loom-image';

    const img = document.createElement('img');
    img.className = 'loom-image-media';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = source;
    img.alt = props.alt;
    img.addEventListener('load', () => context.emit('load', { src: img.src }));
    img.addEventListener('error', () => context.emit('error', { src: img.src }));

    const caption = document.createElement('figcaption');
    caption.className = 'loom-image-caption';
    caption.textContent = props.caption;
    caption.hidden = !props.caption;

    figure.append(img, caption);
    imageState.set(figure, { img, caption });
    applyImageFit(img, props.fit);
    return figure;
}

function updateImage(element, props) {
    const source = requireSafeImageSource(props.src);
    const state = imageState.get(element);
    if (!state) return;
    state.img.src = source;
    state.img.alt = props.alt;
    state.caption.textContent = props.caption;
    state.caption.hidden = !props.caption;
    applyImageFit(state.img, props.fit);
}

/* ------------------------------------------------------------------------- */
/* tabs                                                                       */
/* ------------------------------------------------------------------------- */

const tabsState = new WeakMap();
let tabsCounter = 0;

function clampTabsIndex(value, count) {
    if (count <= 0) return 0;
    const index = Number.isInteger(value) ? value : 0;
    return Math.min(Math.max(index, 0), count - 1);
}

function applyTabsActive(element) {
    const state = tabsState.get(element);
    if (!state) return;
    const count = state.labels.length;
    const active = clampTabsIndex(state.active, count);
    state.active = active;
    const tabs = [...state.strip.querySelectorAll('.loom-tabs-tab')];
    tabs.forEach((tab, index) => {
        const selected = index === active;
        tab.classList.toggle('loom-tabs-tab-active', selected);
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
    });
    for (const [index, panel] of state.panels) {
        panel.hidden = index >= count || index !== active;
    }
}

function buildTabStrip(element, state) {
    state.strip.replaceChildren();
    state.labels.forEach((label, index) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'loom-tabs-tab';
        tab.setAttribute('role', 'tab');
        tab.id = `${state.base}-tab-${index}`;
        tab.setAttribute('aria-controls', `${state.base}-panel-${index}`);
        tab.textContent = label;
        tab.dataset.index = String(index);
        tab.addEventListener('click', () => activateTab(element, index, true));
        state.strip.append(tab);
    });
}

function ensureTabPanel(element, index) {
    const state = tabsState.get(element);
    const existing = state.panels.get(index);
    if (existing) return existing;

    const panel = document.createElement('section');
    panel.className = 'loom-tabs-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.id = `${state.base}-panel-${index}`;
    panel.dataset.index = String(index);
    if (state.labels[index] !== undefined) {
        panel.setAttribute('aria-labelledby', `${state.base}-tab-${index}`);
    }
    panel.hidden = true;
    state.panels.set(index, panel);
    state.body.append(panel);
    applyTabsActive(element);
    return panel;
}

/**
 * Controlled, like `modal`: a click or arrow key emits `change` and moves focus,
 * but the selected panel only changes when the caller passes a new `active`.
 * That keeps `describe()`/`serialize()` truthful about what is on screen and
 * avoids a local selection that silently diverges from the declared tree.
 */
function activateTab(element, index, notify) {
    const state = tabsState.get(element);
    if (!state || state.labels.length === 0) return;
    const target = clampTabsIndex(index, state.labels.length);
    const tabs = [...state.strip.querySelectorAll('.loom-tabs-tab')];
    tabs[target]?.focus?.();
    if (notify) state.context?.emit('change', { index: target });
}

function handleTabsKeydown(element, event) {
    const state = tabsState.get(element);
    if (!state) return;
    const tabs = [...state.strip.querySelectorAll('.loom-tabs-tab')];
    if (tabs.length === 0) return;
    const current = tabs.indexOf(event.target);
    let next = null;
    if (event.key === 'ArrowRight') next = (current + 1 + tabs.length) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault?.();
    activateTab(element, next, true);
    tabs[next]?.focus?.();
}

function renderTabs(element, props, context) {
    const state = tabsState.get(element);
    if (!state) return;
    if (context) state.context = context;
    const labels = props.labels.map(label => String(label));
    const changed = labels.length !== state.labels.length
        || labels.some((label, index) => label !== state.labels[index]);
    if (changed) {
        state.labels = labels;
        buildTabStrip(element, state);
    }
    // Controlled: the declared `active` is authoritative on every update.
    state.active = clampTabsIndex(props.active, state.labels.length);
    applyTabsActive(element);
}

function createTabs(props, context) {
    const element = document.createElement('div');
    element.className = 'loom-tabs';
    const strip = document.createElement('div');
    strip.className = 'loom-tabs-strip';
    strip.setAttribute('role', 'tablist');
    const body = document.createElement('div');
    body.className = 'loom-tabs-panels';
    element.append(strip, body);

    const state = {
        base: `loom-tabs-${++tabsCounter}`,
        strip,
        body,
        panels: new Map(),
        labels: [],
        active: 0,
        context,
    };
    tabsState.set(element, state);
    renderTabs(element, props, context);
    strip.addEventListener('keydown', event => handleTabsKeydown(element, event));

    return { element, content: index => ensureTabPanel(element, Number(index)) };
}

function updateTabs(element, props, context) {
    renderTabs(element, props, context);
}

/* ------------------------------------------------------------------------- */
/* modal                                                                      */
/* ------------------------------------------------------------------------- */

const modalState = new WeakMap();

// Queried one selector at a time rather than as a comma list: the unit-test DOM
// stand-in does not split selector lists, and separate queries are equivalent in
// a browser. Disabled controls are filtered in code instead of with `:not()`.
const MODAL_FOCUSABLE_SELECTORS = Object.freeze(['button', 'input', 'select', 'textarea', 'a[href]', '[tabindex]']);

function modalFocusables(dialog) {
    const seen = new Set();
    const focusables = [];
    for (const selector of MODAL_FOCUSABLE_SELECTORS) {
        for (const element of dialog.querySelectorAll(selector)) {
            if (seen.has(element)) continue;
            seen.add(element);
            if (element.disabled || element.hidden) continue;
            // Check the attribute rather than the `tabIndex` property: the
            // property defaults differ between browsers and the test DOM stand-in.
            if (element.getAttribute?.('tabindex') === '-1') continue;
            focusables.push(element);
        }
    }
    return focusables;
}

/**
 * One document-level listener per modal instance, registered through the view
 * engine's `onCleanup` so it cannot outlive the view. It is a no-op while the
 * dialog is closed, which avoids add/remove churn on every open/close.
 */
function handleModalKeydown(element, event) {
    const state = modalState.get(element);
    if (!state || !state.open) return;

    if (event.key === 'Escape') {
        requestModalClose(element);
        return;
    }
    if (event.key !== 'Tab') return;

    const focusables = modalFocusables(state.dialog);
    if (focusables.length === 0) {
        state.dialog.focus?.();
        event.preventDefault?.();
        return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = state.document?.activeElement ?? null;
    const inside = Boolean(active) && state.dialog.contains(active);

    if (event.shiftKey && (active === first || !inside)) {
        last.focus?.();
        event.preventDefault?.();
    } else if (!event.shiftKey && (active === last || !inside)) {
        first.focus?.();
        event.preventDefault?.();
    }
}

function applyModal(element, props, { initial = false } = {}) {
    const state = modalState.get(element);
    if (!state) return;
    const wasOpen = state.open;
    state.props = props;
    state.open = Boolean(props.open);
    element.hidden = !state.open;
    element.classList.toggle('loom-modal-open', state.open);
    state.dialog.setAttribute('aria-label', props.title || '对话框');
    state.title.textContent = props.title;
    state.title.hidden = !props.title;
    state.close.hidden = !props.closable;
    state.header.hidden = !props.title && !props.closable;

    if (!initial && state.open && !wasOpen) {
        // Remember where focus came from so closing can put it back.
        const active = state.document?.activeElement;
        state.restoreFocus = active && active !== state.document.body ? active : null;
        state.dialog.focus?.();
    }
    if (!initial && !state.open && wasOpen) {
        restoreModalFocus(state);
    }
}

function restoreModalFocus(state) {
    const target = state.restoreFocus;
    state.restoreFocus = null;
    if (!target) return;
    if (typeof target.isConnected === 'boolean' && !target.isConnected) return;
    target.focus?.();
}

function requestModalClose(element) {
    const state = modalState.get(element);
    if (!state || !state.props.closable) return;
    state.context?.emit('close', {});
}

function createModal(props, context) {
    const element = document.createElement('div');
    element.className = 'loom-modal';
    element.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'loom-modal-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;

    const header = document.createElement('header');
    header.className = 'loom-modal-header';
    const title = document.createElement('h2');
    title.className = 'loom-modal-title';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'loom-modal-close';
    close.setAttribute('aria-label', '关闭对话框');
    close.textContent = '\u00d7';
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'loom-modal-body';
    dialog.append(header, body);
    element.append(dialog);

    const ownerDocument = element.ownerDocument ?? (typeof document === 'undefined' ? null : document);
    modalState.set(element, {
        dialog, header, title, close, body, context, props,
        open: false,
        restoreFocus: null,
        document: ownerDocument,
    });
    applyModal(element, props, { initial: true });

    close.addEventListener('click', () => requestModalClose(element));
    element.addEventListener('click', event => {
        if (event.target === element) requestModalClose(element);
    });

    if (ownerDocument) {
        const listener = event => handleModalKeydown(element, event);
        ownerDocument.addEventListener('keydown', listener);
        context?.onCleanup?.(() => ownerDocument.removeEventListener('keydown', listener));

        // Focus can only move once the tree is attached, so the initial open is
        // handled after the engine reports the mount.
        context?.onMount?.(() => {
            const state = modalState.get(element);
            if (!state || !state.open) return;
            const active = ownerDocument.activeElement;
            state.restoreFocus = active && active !== ownerDocument.body ? active : null;
            state.dialog.focus?.();
        });
    }

    return { element, content: body };
}

function updateModal(element, props, context) {
    const state = modalState.get(element);
    if (!state) return;
    if (context) state.context = context;
    applyModal(element, props);
}

function unmountModal(element) {
    const state = modalState.get(element);
    if (!state) return;
    restoreModalFocus(state);
    modalState.delete(element);
}

/* ------------------------------------------------------------------------- */
/* menu                                                                       */
/* ------------------------------------------------------------------------- */

function normalizeMenuItems(items) {
    return items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || typeof item.id !== 'string' || item.id === ''
            || typeof item.label !== 'string') {
            throw new TypeError(`Menu item ${index} requires a non-empty string id and a string label.`);
        }
        return { id: item.id, label: item.label };
    });
}

function renderMenu(element, props, context) {
    const items = normalizeMenuItems(props.items);
    element.replaceChildren();
    for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'loom-menu-item';
        button.setAttribute('role', 'menuitem');
        button.dataset.itemId = item.id;
        button.textContent = item.label;
        button.addEventListener('click', () => context?.emit('select', { id: item.id }));
        element.append(button);
    }
}

function createMenu(props, context) {
    const element = document.createElement('div');
    element.className = 'loom-menu';
    element.setAttribute('role', 'menu');
    renderMenu(element, props, context);
    return element;
}

function updateMenu(element, props, context) {
    renderMenu(element, props, context);
}

export const BUILTIN_COMPONENTS = Object.freeze([
    {
        id: 'text',
        name: '文本',
        description: '显示静态文本，可选排版变体与色调。',
        props: {
            text: { type: 'string', required: true },
            variant: { type: 'string', default: 'body', description: 'body / title / heading / caption' },
            tone: { type: 'string', default: 'default', description: 'default / muted / info / success / warning / error' },
        },
        mount: createText,
        update: updateText,
    },
    {
        id: 'button',
        name: '按钮',
        description: '可点击按钮，触发 click 事件。',
        events: ['click'],
        props: {
            label: { type: 'string', required: true },
            variant: { type: 'string', default: 'secondary', description: 'secondary / primary' },
            disabled: { type: 'boolean', default: false },
        },
        mount: createButton,
        update: updateButton,
    },
    {
        id: 'input',
        name: '输入框',
        description: '单行输入框，触发 change 事件。',
        events: ['change'],
        props: {
            value: { type: 'string', default: '' },
            placeholder: { type: 'string', default: '' },
            type: { type: 'string', default: 'text', description: 'text / password / number' },
            disabled: { type: 'boolean', default: false },
        },
        mount: createInput,
        update: updateInput,
    },
    {
        id: 'toggle',
        name: '开关',
        description: '布尔开关，触发 change 事件。',
        events: ['change'],
        props: {
            checked: { type: 'boolean', default: false },
            label: { type: 'string', default: '' },
        },
        mount: createToggle,
        update: updateToggle,
    },
    {
        id: 'select',
        name: '选择器',
        description: '下拉选择框，触发 change 事件。',
        events: ['change'],
        props: {
            options: { type: 'array', required: true },
            value: { type: 'string', default: '' },
        },
        mount: createSelect,
        update: updateSelect,
    },
    {
        id: 'card',
        name: '卡片',
        description: '带标题的内容容器，可嵌套其他组件。',
        container: true,
        props: {
            title: { type: 'string', default: '' },
            subtitle: { type: 'string', default: '' },
        },
        mount: createCard,
        update: updateCard,
    },
    {
        id: 'row',
        name: '水平布局',
        description: '水平排列子组件。',
        container: true,
        props: { gap: gapProp },
        mount: createLayout('loom-row'),
        update: updateLayout,
    },
    {
        id: 'column',
        name: '垂直布局',
        description: '垂直排列子组件。',
        container: true,
        props: { gap: gapProp },
        mount: createLayout('loom-column'),
        update: updateLayout,
    },
    {
        id: 'grid',
        name: '网格布局',
        description: '按列数排列子组件，开启响应式后在窄屏自动折叠为单列。',
        container: true,
        props: {
            columns: { type: 'number', default: 2, description: '列数。' },
            responsive: { type: 'boolean', default: true, description: '窄屏是否自动折叠为单列。' },
            gap: gapProp,
        },
        mount: createLayout('loom-grid'),
        update: updateLayout,
    },
    {
        id: 'divider',
        name: '分隔线',
        description: '水平分隔线。',
        props: {},
        mount: () => {
            const element = document.createElement('hr');
            element.className = 'loom-divider';
            return element;
        },
    },
    {
        id: 'list',
        name: '列表',
        description: '有序或无序列表。',
        props: {
            items: { type: 'array', required: true },
            ordered: { type: 'boolean', default: false },
        },
        mount: props => {
            const element = document.createElement(props.ordered ? 'ol' : 'ul');
            element.className = 'loom-list';
            for (const item of props.items) {
                const entry = document.createElement('li');
                entry.textContent = String(item);
                element.append(entry);
            }
            return element;
        },
        update: (element, props) => {
            element.replaceChildren();
            for (const item of props.items) {
                const entry = document.createElement('li');
                entry.textContent = String(item);
                element.append(entry);
            }
        },
    },
    {
        id: 'badge',
        name: '徽标',
        description: '简短状态标签。',
        props: {
            text: { type: 'string', required: true },
            tone: { type: 'string', default: 'default', description: 'default / muted / info / success / warning / error' },
        },
        mount: props => {
            const element = document.createElement('span');
            element.className = 'loom-badge';
            applyTone(element, props.tone);
            element.textContent = props.text;
            return element;
        },
        update: (element, props) => {
            applyTone(element, props.tone);
            element.textContent = props.text;
        },
    },
    {
        id: 'image',
        name: '图片',
        description: '内置短名组件（与 text/button 一致，不加命名空间前缀）。显示图片和可选说明；src 只接受 http/https/data/blob，alt 必填。',
        events: ['load', 'error'],
        props: {
            src: { type: 'string', required: true, description: '图片地址，仅允许 http: / https: / data: / blob: 前缀。' },
            alt: { type: 'string', required: true, description: '替代文本，必填。' },
            caption: { type: 'string', default: '', description: '图片下方说明。' },
            fit: { type: 'string', default: 'cover', description: 'cover / contain' },
        },
        mount: createImage,
        update: updateImage,
    },
    {
        id: 'tabs',
        name: '标签页',
        description: '内置短名组件。按 labels 顺序把子节点放进对应标签页，点击标签切换并触发 change；支持方向键。',
        container: true,
        events: ['change'],
        props: {
            labels: { type: 'array', required: true, description: '标签文本数组，索引与子节点顺序对应。' },
            active: { type: 'number', default: 0, description: '当前标签索引。' },
        },
        mount: createTabs,
        update: updateTabs,
    },
    {
        id: 'modal',
        name: '对话框',
        description: '内置短名组件。受控对话框：open 决定显示；关闭按钮、遮罩和 Escape 触发 close，调用方负责把 open 设回 false。',
        container: true,
        events: ['close'],
        props: {
            open: { type: 'boolean', default: false },
            title: { type: 'string', default: '' },
            closable: { type: 'boolean', default: true },
        },
        mount: createModal,
        update: updateModal,
        unmount: unmountModal,
    },
    {
        id: 'menu',
        name: '菜单',
        description: '内置短名组件。渲染一组菜单项，点击某项触发 select。',
        events: ['select'],
        props: {
            items: { type: 'array', required: true, description: '菜单项数组：[{ id, label }]。' },
        },
        mount: createMenu,
        update: updateMenu,
    },
]);