/**
 * 角色面板 —— 一个把"界面 + 数据 + 上下文"串起来的示例扩展。
 *
 * 它演示四件事，正好是互动面板类扩展的骨架：
 * 1. 用 `LoomUI.registerBlock` 在消息里渲染一块交互界面（标记本身不进提示词）；
 * 2. 用 `Loom.setState` 保存数据（宿主会持久化，刷新后仍在）；
 * 3. 用 `prompt.set` 把"变化后的状态 + 回执规则"编译成自然语言注入上下文；
 * 4. 在收到消息时解析 AI 的 `[[...]]` 回执，改动数据并刷新面板。
 *
 * 面板本身只读 + 一个"用掉一个"的按钮；真正的写入都走同一份 `applyCommand`，
 * 所以界面点击和 AI 回执走的是同一条路径，不会出现两套规则。
 */
import {
    applyCommand,
    applyReceipts,
    describeState,
    normalizeState,
    panelLines,
} from './state.js';

const EXTENSION_ID = 'character-panel';
const STATE_KEY = 'panel';
const PROMPT_KEY = 'status';
const BLOCK_KIND = 'character.panel';

let memo = normalizeState(null);
let lastChanges = [];
let processedMessages = new Set();
let extensionId = EXTENSION_ID;
let unsubscribers = [];
let warnedChatRead = false;

export default {
    activate({ id }) {
        const Loom = globalThis.Loom;
        const LoomUI = globalThis.LoomUI;
        if (!Loom?.executeCapability || !LoomUI?.registerBlock) return;
        extensionId = id;

        memo = normalizeState(Loom.getState(id, STATE_KEY));
        processedMessages = new Set(Loom.getState(id, 'processedMessages') ?? []);

        LoomUI.registerBlock(id, {
            id: BLOCK_KIND,
            name: '角色面板',
            build: () => buildPanel(),
        });

        registerCapabilities(Loom, id);
        subscribeToMessages(Loom, id);
        void seedBaseline(Loom, id);
        // The prompt is rebuilt from state on every activation so a reload cannot
        // leave the model reading stale numbers.
        void pushPrompt(id, { silent: true });
    },

    deactivate() {
        for (const unsubscribe of unsubscribers) {
            try {
                unsubscribe();
            } catch {
                // A stale subscription must not block deactivation.
            }
        }
        unsubscribers = [];
        processedMessages = new Set();
    },
};

function registerCapabilities(Loom, id) {
    const definitions = [
        {
            id: 'panel.get',
            name: 'Read the panel',
            description: 'Return the current panel state.',
            output: { type: 'object' },
            execute: () => ({ ...memo, items: { ...memo.items } }),
        },
        {
            id: 'panel.apply',
            name: 'Apply one change',
            description: 'Apply one command (item/gold/exp/level) to the panel.',
            input: {
                type: 'object',
                required: ['op'],
                properties: {
                    op: { type: 'string', enum: ['item', 'gold', 'exp', 'level'] },
                    name: { type: 'string', maxLength: 24 },
                    delta: { type: 'integer', minimum: -9999, maximum: 9999 },
                },
                additionalProperties: false,
            },
            output: {
                type: 'object',
                required: ['state', 'note', 'rejected'],
                properties: {
                    state: { type: 'object' },
                    note: { type: 'string' },
                    rejected: { type: ['string', 'null'] },
                },
                additionalProperties: false,
            },
            execute: async input => {
                const result = applyCommand(memo, input);
                if (!result.rejected) {
                    memo = result.state;
                    lastChanges = [result.note];
                    await persistAndRefresh(id);
                }
                return { state: { ...memo, items: { ...memo.items } }, note: result.note, rejected: result.rejected ?? null };
            },
        },
        {
            id: 'panel.reset',
            name: 'Reset the panel',
            description: 'Restore the default panel state.',
            output: { type: 'object' },
            execute: async () => {
                memo = normalizeState(null);
                lastChanges = ['面板已重置'];
                await persistAndRefresh(id);
                return { ...memo, items: { ...memo.items } };
            },
        },
        {
            id: 'panel.block',
            name: 'Panel block markup',
            description: 'Return the marker an extension writes into a message to show the panel.',
            output: { type: 'string' },
            execute: () => {
                const markers = globalThis.Loom;
                return markers?.widgetMarker
                    ? markers.widgetMarker(BLOCK_KIND, '')
                    : `\u27E6loom:${BLOCK_KIND}\u27E7\u27E6/loom\u27E7`;
            },
        },
    ];
    for (const definition of definitions) {
        try {
            Loom.registerCapability(id, definition);
        } catch {
            // A reload re-registers; Core refuses duplicates and that is fine.
        }
    }
}

/**
 * Mark the messages that already exist as processed.
 *
 * State is persisted, so replaying the whole history after a reload would apply
 * every historical receipt a second time. Seeding the baseline at activation makes
 * "apply once" the invariant: only messages that arrive while this extension is
 * running can change the panel.
 */
async function seedBaseline(Loom, id) {
    try {
        for (const message of await readRecent(Loom, id)) {
            if (!message.isUser) processedMessages.add(message.index);
        }
        await Loom.setState(id, 'processedMessages', [...processedMessages].slice(-500));
    } catch (error) {
        console.warn('[character-panel] 初始化回执基线失败：', error);
    }
}

/** The tail of the chat, independent of how long the log is. */
async function readRecent(Loom, id, limit = 200) {
    const first = await Loom.executeCapability('loom-host', 'chat.messages', { limit, offset: 0 }, { caller: id });
    if (!first.success) {
        // Most often a missing grant; say so once instead of failing silently.
        if (!warnedChatRead) {
            warnedChatRead = true;
            console.warn('[character-panel] 无法读取聊天，回执将不会被处理：', first.error?.code, first.error?.message);
        }
        return [];
    }
    const total = first.data?.total ?? 0;
    if (total <= limit) return first.data.messages ?? [];
    const tail = await Loom.executeCapability('loom-host', 'chat.messages', { limit, offset: total - limit }, { caller: id });
    return tail.success ? tail.data.messages ?? [] : first.data.messages ?? [];
}

/**
 * Apply receipts from newly received messages.
 *
 * Parsing happens on the conversation text, not on the DOM: the block renderer
 * replaces the panel marker in the message body, and the receipt lives in the same
 * text, so reading the stored message is the only reliable source.
 */
function subscribeToMessages(Loom, id) {
    const handle = async () => {
        try {
            const messages = await readRecent(Loom, id);
            const fresh = messages.filter(message => !message.isUser && !processedMessages.has(message.index));
            if (fresh.length === 0) return;

            let applied = [];
            for (const message of fresh) {
                processedMessages.add(message.index);
                const outcome = applyReceipts(memo, message.text);
                if (outcome.notes.length === 0 && outcome.rejected.length === 0) continue;
                memo = outcome.state;
                applied = applied.concat(outcome.notes);
                if (outcome.rejected.length > 0) {
                    console.warn('[character-panel] 回执被忽略：', outcome.rejected);
                }
            }
            if (applied.length > 0) {
                lastChanges = applied;
                await persistAndRefresh(id);
            }
            await Loom.setState(id, 'processedMessages', [...processedMessages].slice(-500));
        } catch (error) {
            console.error('[character-panel] 处理回执失败：', error);
        }
    };
    unsubscribers.push(Loom.subscribe(id, 'host:message:received', handle));
    // A chat switch starts a fresh scope: the stored message indexes belong to the
    // previous chat, so do not carry them over, and re-seed from the new chat.
    unsubscribers.push(Loom.subscribe(id, 'host:chat:changed', () => {
        processedMessages = new Set();
        void seedBaseline(Loom, id);
    }));
}

async function persistAndRefresh(id) {
    const Loom = globalThis.Loom;
    Loom.setState(id, STATE_KEY, { ...memo, items: { ...memo.items } });
    await pushPrompt(id);
    try {
        // The marker was replaced by the widget container when it first rendered, so
        // refreshing by text would find nothing: rebuild the live views instead.
        const rerendered = globalThis.LoomUI?.rerenderBlocks?.(id);
        if (!rerendered) globalThis.LoomUI?.refreshBlocks?.();
    } catch (error) {
        console.error('[character-panel] 刷新面板失败：', error);
    }
}

/** Compile the state into natural language and inject it. */
async function pushPrompt(id, { silent = false } = {}) {
    const Loom = globalThis.Loom;
    if (!Loom?.executeCapability) return;
    const text = describeState(memo, lastChanges);
    const result = await Loom.executeCapability('loom-host', 'prompt.set', {
        text,
        key: PROMPT_KEY,
        position: 'in_chat',
        depth: 1,
    }, { caller: id });
    if (!result.success && !silent) {
        console.warn('[character-panel] 注入失败：', result.error?.code, result.error?.message);
    }
    if (result.success) lastChanges = [];
}

/** The rendered panel: a heading, the item rows and a use-it button per item. */
function buildPanel() {
    const { heading, items } = panelLines(memo);
    const rows = items.map(label => ({ component: 'text', props: { text: label, variant: 'caption' } }));
    const usable = Object.keys(memo.items).sort();
    const buttons = usable.length === 0
        ? []
        : [{
            component: 'row',
            props: { gap: 4 },
            children: usable.slice(0, 6).map(name => ({
                component: 'button',
                props: { label: `用 ${name}` },
                on: { click: () => void useItem(name) },
            })),
        }];

    return {
        component: 'card',
        props: { title: '角色面板', subtitle: heading },
        children: [
            { component: 'column', props: { gap: 2 }, children: rows },
            ...buttons,
        ],
    };
}

async function useItem(name) {
    const result = applyCommand(memo, { op: 'item', name, delta: -1 });
    if (result.rejected) return;
    memo = result.state;
    lastChanges = [result.note];
    await persistAndRefresh(extensionId);
}
