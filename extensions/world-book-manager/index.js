/**
 * 世界书管理器 —— 一个用户可见的 Loom 扩展示例。
 *
 * 演示：
 * - 激活时声明 `host.worldinfo.write`（加载器会先征求用户同意）；
 * - 用 `worlds.list` / `worlds.export` 读取，用 `worlds.entry.update` 写回；
 * - 用 LoomUI 声明式视图渲染界面，事件处理器更新状态后重建视图；
 * - 把权限被拒等真实结果如实显示给用户。
 *
 * 读取用 `worlds.export` 而不是 `worlds.entries`：后者为了展示会把内容截断到
 * 2000 字，拿截断的内容回写会毁数据。
 */

const HOST = 'loom-host';
const PANEL_ID = 'loom_wbm_panel';
const BUTTON_ID = 'loom_wbm_button';

const state = {
    books: [],
    book: '',
    entries: [],
    fullEntries: {},
    uid: null,
    comment: '',
    enabled: true,
    content: '',
    status: '选择一本世界书开始。',
};

let extensionId = null;
let view = null;

export default {
    activate({ id }) {
        if (!globalThis.Loom?.executeCapability || !globalThis.LoomUI?.createView) return;
        extensionId = id;
        mountLauncher();
        renderPanel();
    },

    deactivate() {
        view?.destroy?.();
        view = null;
        document.getElementById(PANEL_ID)?.remove();
        document.getElementById(BUTTON_ID)?.remove();
        extensionId = null;
    },
};

function mountLauncher() {
    document.getElementById(BUTTON_ID)?.remove();
    const button = document.createElement('button');
    button.type = 'button';
    button.id = BUTTON_ID;
    button.title = '世界书管理器';
    button.textContent = '世界书';
    button.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:30000;padding:8px 12px;border-radius:999px;';
    button.addEventListener('click', () => {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const hidden = panel.style.display === 'none';
        panel.style.display = hidden ? '' : 'none';
        if (hidden) void loadBooks();
    });
    document.body.append(button);
}

function renderPanel() {
    document.getElementById(PANEL_ID)?.remove();
    const container = document.createElement('div');
    container.id = PANEL_ID;
    container.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:72px', 'width:380px', 'max-height:70vh',
        'overflow:auto', 'z-index:30000', 'padding:12px', 'border-radius:8px',
        'border:1px solid var(--SmartThemeBorderColor, #777)',
        'background:var(--SmartThemeBlurTintColor, #1e1e1e)',
        'display:none', 'box-shadow:0 4px 16px rgba(0,0,0,.4)',
    ].join(';');
    document.body.append(container);

    view = globalThis.LoomUI.createView(extensionId, { target: container, root: buildTree() });
}

/** Rebuild the whole tree: every interaction already went through `change`/click. */
function refresh() {
    try {
        view?.setRoot(buildTree());
    } catch {
        // A destroyed view must not break the extension.
    }
}

function buildTree() {
    return {
        component: 'card',
        props: { title: '世界书管理器', subtitle: '读取完整条目，保存后显示真实结果' },
        children: [
            {
                component: 'column',
                props: { gap: 6 },
                children: [
                    {
                        component: 'select',
                        props: {
                            options: state.books.map(name => ({ value: name, label: name })),
                            value: state.book,
                        },
                        on: { change: event => void selectBook(event.payload.value) },
                    },
                    {
                        component: 'select',
                        props: {
                            options: state.entries.map(entry => ({
                                value: String(entry.uid),
                                label: `${entry.uid} · ${entry.comment || '(无备注)'}`,
                            })),
                            value: state.uid === null ? '' : String(state.uid),
                        },
                        on: { change: event => void selectEntry(event.payload.value) },
                    },
                    {
                        component: 'row',
                        props: { gap: 6 },
                        children: [
                            {
                                component: 'input',
                                props: { value: state.comment, placeholder: '备注（comment）' },
                                on: { change: event => { state.comment = event.payload.value; } },
                            },
                            {
                                component: 'toggle',
                                props: { checked: state.enabled, label: '启用' },
                                on: { change: event => { state.enabled = event.payload.checked; } },
                            },
                        ],
                    },
                    {
                        component: 'textarea',
                        props: { value: state.content, placeholder: '条目内容（content）', rows: 10 },
                        on: { change: event => { state.content = event.payload.value; } },
                    },
                    {
                        component: 'row',
                        props: { gap: 6 },
                        children: [
                            { component: 'text', props: { text: state.status } },
                            { component: 'button', props: { label: '保存' }, on: { click: () => void saveEntry() } },
                        ],
                    },
                ],
            },
        ],
    };
}

async function callHost(capabilityId, input) {
    const result = await globalThis.Loom.executeCapability(HOST, capabilityId, input, { caller: extensionId });
    if (!result.success) {
        const error = result.error ?? {};
        if (error.code === 'PERMISSION_DENIED') {
            throw new Error('没有写入权限：请先在 Loom 面板授权 host.worldinfo.write。');
        }
        throw new Error(`${error.code ?? 'ERROR'}: ${error.message ?? '调用失败'}`);
    }
    return result.data;
}

async function loadBooks() {
    try {
        state.books = await callHost('worlds.list', null);
        state.status = state.books.length ? `共 ${state.books.length} 本世界书。` : '没有世界书。';
    } catch (error) {
        state.status = error.message;
    }
    refresh();
}

async function selectBook(name) {
    state.book = name;
    state.uid = null;
    state.entries = [];
    state.fullEntries = {};
    state.content = '';
    state.comment = '';
    if (name) {
        try {
            // `worlds.export` returns the raw book: entries are complete, unlike the
            // 2000-character preview `worlds.entries` exposes.
            const exported = await callHost('worlds.export', { name });
            state.fullEntries = exported.data?.entries ?? {};
            state.entries = Object.entries(state.fullEntries)
                .map(([uid, entry]) => ({ uid: Number(entry?.uid ?? uid), comment: String(entry?.comment ?? '') }))
                .sort((left, right) => left.uid - right.uid);
            state.status = `已载入 ${state.entries.length} 个条目。`;
        } catch (error) {
            state.status = error.message;
        }
    }
    refresh();
}

async function selectEntry(value) {
    const uid = Number(value);
    state.uid = Number.isFinite(uid) ? uid : null;
    const entry = state.uid === null ? null : state.fullEntries[String(state.uid)];
    if (entry) {
        state.content = String(entry.content ?? '');
        state.comment = String(entry.comment ?? '');
        state.enabled = entry.disable !== true;
        state.status = `条目 ${state.uid} 已载入。`;
    }
    refresh();
}

async function saveEntry() {
    if (state.uid === null) {
        state.status = '先选择一个条目。';
        refresh();
        return;
    }
    try {
        await callHost('worlds.entry.update', {
            name: state.book,
            // The capability contract uses string uids (`worlds.entry.create`
            // returns one), so the numeric selection is converted here.
            uid: String(state.uid),
            patch: { content: state.content, comment: state.comment, enabled: state.enabled },
        });
        state.fullEntries[String(state.uid)] = {
            ...(state.fullEntries[String(state.uid)] ?? {}),
            content: state.content,
            comment: state.comment,
            disable: !state.enabled,
        };
        state.status = `条目 ${state.uid} 已保存。`;
    } catch (error) {
        state.status = error.message;
    }
    refresh();
}
