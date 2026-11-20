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
    if (title) title.textContent = props.title ?? '';
    const subtitle = element.querySelector('.loom-card-subtitle');
    if (subtitle) subtitle.textContent = props.subtitle ?? '';
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
]);