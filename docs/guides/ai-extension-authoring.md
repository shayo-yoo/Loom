# Loom 扩展开发速查（给 AI 用）

这是一份**面向 AI 的压缩规范**：读完后应能直接写出可运行的 Loom 扩展或脚本。人类向的完整说明见 `writing-an-extension.md`，二者冲突时以代码与 `API_INDEX.md` 为准。

## 0. 三条硬约束

1. **没有构建步骤**。原生 ES module，`import`/`export` 即可，不要引入打包器。
2. **不碰酒馆内部**。宿主数据只能通过能力（capability）访问；直接读 `SillyTavern` 内部对象属于越界。
3. **身份决定一切**。能力、组件、块、状态、订阅都挂在扩展 id 上；卸载即全部清理。

## 1. 最小扩展包

```
extensions/<id>/
├── manifest.json
└── index.js
```

```json
{
  "id": "<id>",           // 必须等于目录名，/^[a-z0-9][a-z0-9._-]*$/i
  "name": "显示名",
  "version": "0.1.0",
  "author": "作者标识",     // 可选，与 id 组成身份 author:id
  "entry": "index.js",     // 必须是存在的 .js
  "dependencies": [],      // 依赖的扩展 id
  "permissions": []        // 激活时向用户申请
}
```

```js
export default {
    activate({ id }) { /* 注册能力/界面/订阅 */ },
    deactivate({ id }) { /* 可选：停止自己的定时器 */ },
};
```

写完后在仓库根目录执行 `npm run extensions:index`，否则不会被发现。`activate` 抛错 → 扩展进入 `failed`，不影响其他扩展。

## 2. 注册能力（对外接口）

```js
globalThis.Loom.registerCapability(id, {
    id: 'my.tool',                 // 稳定 id，能力全名是 <扩展id>:<能力id>
    name: 'My tool',
    description: '一句话说明',
    permissions: [],               // 声明"调用我的人"需要什么权限
    errors: [{ code: 'NOT_FOUND', description: '目标不存在' }],  // 可选，仅说明
    compatibility: { since: '0.34.0', deprecated: false },       // 可选
    input: {                       // 可选；未声明则不校验
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
        additionalProperties: false,
    },
    output: { type: 'string' },    // 可选；返回后校验
    execute: async (input, context) => {
        // context = { caller, target, capabilityId, capabilityPermissions, hasPermission(p) }
        return input.text;
    },
});
```

**schema 子集**（只支持这些关键字，其他会注册失败）：
`type`（可用数组）、`enum`、`const`、`required`、`properties`、`items`、`additionalProperties`、`minimum`/`maximum`（**可为负数**）、`minLength`/`maxLength`/`minItems`/`maxItems`（非负整数）。

调用别人的能力：

```js
const result = await globalThis.Loom.executeCapability('loom-host', 'worlds.list', null, { caller: id });
if (!result.success) return result.error;   // { code, message, details }
result.data;                                 // 已通过输出 schema 校验
```

`caller` 必须是自己。对方能力声明了权限而你没获授权 → `PERMISSION_DENIED`（`details.missing`）。

## 3. 宿主机能力速查

| 能力 | 要点 | 权限 |
|---|---|---|
| `context.snapshot` / `characters.list` / `characters.get` | 只读 | 无 |
| `worlds.list` / `worlds.entries` | `entries` 返回 `{ total, offset, limit, hasMore, entries }`，正文截断 2000 字 | 无 |
| `worlds.export` | 整本原始数据（编辑前取全文用它） | 无 |
| `worlds.entry.create` / `update` / `remove` | `uid` 是**字符串**；update 只改传入字段 | `host.worldinfo.write` |
| `worlds.create` / `remove` / `import` / `rename` | 删除/改名需回显名字；`rename` 可带 `migrateCards` | `host.worldinfo.manage` |
| `characters.update` | 只用传入字段；写 PNG 的 V2 data 块 | `host.characters.write` |
| `characters.create` / `remove` | 删除需回显头像名；保留聊天目录 | `host.characters.manage` |
| `chat.messages` | `{ total, offset, limit, hasMore, messages }`，`offset` 是从开头的绝对下标；可 `query`/`order` | `host.chat.read` |
| `chat.append` | 系统消息，类型 `generic`/`assistant_note` | `host.chat.write` |
| `chat.edit` / `chat.delete` | 编辑返回原文；删除需 `expect` 回显当前文本 | `host.chat.write` |
| `prompt.set` / `clear` / `list` | 注入上下文，键按调用方命名空间隔离 | `host.prompt.inject` |
| `prompt.filterStats` | 块过滤计数 | 无 |

## 4. 界面（LoomUI 视图）

```js
const view = globalThis.LoomUI.createView(id, {
    target: '#my-box',            // 选择器或元素；省略挂 body
    root: {
        component: 'column',
        props: { gap: 4 },
        children: [
            { component: 'text', props: { text: '标题', variant: 'title' } },
            { component: 'button', props: { label: '点我' }, on: { click: () => {} } },
        ],
    },
});
```

节点：`{ component, props?, children?, on?, key? }`；字符串等价于 `text`。

**组件与必填 props**：`text(text)`、`button(label)`、`input(value…)`、`textarea(value…)`、`toggle(checked,label)`、`select(options,value)`（`options` 元素可为字符串或 `{value,label}`）、`card(title…)`、`row`/`column`(`gap`)、`grid`、`divider`、`list(items)`、`badge`、`image(src,alt)`、`tabs`（受控）、`modal`（受控）、`menu`。

事件回调参数：`{ event, payload, path, viewId, extensionId }`；`select`/`input`/`textarea`/`toggle` 的新值在 `payload`。

局部更新：`view.setProps(path, props)`、`view.setChildren(path, children)`、`view.setRoot(node)`；`path` 是下标数组。

**复合组件**（复用一整棵树）：

```js
globalThis.LoomUI.registerCompositeComponent(id, {
    id: 'my.card', name: 'My card',
    props: { title: { type: 'string', default: '' } },
    build: props => ({ component: 'card', props: { title: props.title }, children: ['内容'] }),
});
// 用法：{ component: 'my.card', props: { title: 'x' } }
```

**原生面板槽位**（放进酒馆自己的面板）：

```js
globalThis.LoomUI.mountToSlot(id, 'settings', { root: { component: 'text', props: { text: '设置' } } });
// 槽位：settings / settings2 / menu / leftNav；容器不存在时返回 null，稍后重试
```

## 5. 消息内交互（块）

块 = 只显示、不进提示词的区域。宿主适配器会把它从提示词里剥掉。

```js
// 1) 注册渲染器
globalThis.LoomUI.registerBlock(id, {
    id: 'my.panel', name: '我的面板',
    build: ({ inner }) => ({ component: 'text', props: { text: '内容 ' + inner } }),
});

// 2) 把标记写进消息（例如通过 chat.append）
const marker = '\u27E6loom:my.panel\u27E7\u27E6/loom\u27E7';

// 3) 数据变化后刷新已渲染的块
globalThis.LoomUI.rerenderBlocks(id);   // 重建实时视图
globalThis.LoomUI.refreshBlocks();      // 从消息文本里找新块（标记还在时用）
```

要点：

- 语法 `⟦loom:<kind>⟧载荷⟦/loom⟧` 或指针 `⟦loom:<kind>⟧`；`kind` 是标识符。
- 渲染只替换**文本节点**，不动酒馆的消息结构。
- 未知 kind、`build` 抛错 → 隐藏占位符（不会露出裸标记）。
- 同一条消息重复渲染只保留一个实例；扩展卸载会带走它的块与视图。
- 渲染后标记已被替换，**再改数据要用 `rerenderBlocks`**，`refreshBlocks` 找不到它。

## 6. 上下文注入与回执

```js
await globalThis.Loom.executeCapability('loom-host', 'prompt.set', {
    text: '【角色状态】…',
    key: 'status',            // 实际键：loom:<你的id>:status
    position: 'in_chat',      // in_prompt / in_chat / before_prompt
    depth: 1,
    role: 'system',           // system / user / assistant
}, { caller: id });

await globalThis.Loom.executeCapability('loom-host', 'prompt.list', null, { caller: id });
await globalThis.Loom.executeCapability('loom-host', 'prompt.clear', { all: true }, { caller: id });
```

注入内容会持续生效直到你改写或清除；渲染侧要"只显示不进上下文"，用块；要让模型读到，用注入。

**回执模式**（让 AI 改你的数据）：在注入文本里说明格式，然后在收到消息时解析：

```js
globalThis.Loom.subscribe(id, 'host:message:received', async () => {
    const page = await globalThis.Loom.executeCapability('loom-host', 'chat.messages',
        { limit: 50, offset: 0 }, { caller: id });
    for (const message of page.data.messages) { /* 解析 message.text 里的命令 */ }
});
```

要点：

- 只处理**新**消息：记录已处理的 `index`，否则刷新后会重复应用。
- 回执留在消息里会被后续轮次读到（少量 token），但它也是可读的操作日志。
- 用 `host:chat:changed` 重置索引集合。

## 7. 状态与事件

```js
globalThis.Loom.setState(id, 'key', value);   // 仅可结构化克隆的值；宿主会持久化
globalThis.Loom.getState(id, 'key');
globalThis.Loom.subscribe(id, 'host:message:received', payload => {});
```

可用 `host:*` 事件：`chat:changed`、`message:sent`、`message:received`、`character:edited`、`worldinfo:updated`、`generation:started`、`generation:ended`（payload 只有 `{ source, event }`）。

## 8. 脚本（不建目录）

面板「脚本」区粘贴即可，或：

```js
await globalThis.LoomUI.saveScript('名字', 'export default { activate({ id }) { /* … */ } };');
```

脚本有自动生成的 id（`script-<slug>`），其余与扩展完全一致；可 `setScriptEnabled` / `deleteScript`。

## 9. 错误码

`INVALID_INPUT`（schema 不符）、`PERMISSION_DENIED`、`CALLER_NOT_FOUND`、`CALLER_REQUIRED`、`CAPABILITY_NOT_FOUND`、`HOST_UNSUPPORTED`、`NO_CHAT`、`MESSAGE_NOT_FOUND`、`CONFIRMATION_REQUIRED`、`WORLD_NOT_FOUND`、`WORLD_EXISTS`、`ENTRY_NOT_FOUND`、`CHARACTER_NOT_FOUND`、`CHARACTER_EXISTS`、`CHARACTER_IN_USE`、`PROMPT_INJECT_FAILED`。

失败一律返回 `{ success: false, error: { code, message, details } }`，不要靠 `throw` 判断业务失败（`throw` 会被包成 `CAPABILITY_FAILED`）。

## 10. 自检清单

- [ ] 目录名 == manifest.id，`entry` 文件存在，已跑 `npm run extensions:index`
- [ ] 用到的权限写进了 `manifest.permissions`（否则激活后调用会被拒）
- [ ] 能力/组件/块的 id 都以扩展 id 归属；`deactivate` 里清掉自己的定时器与外部监听
- [ ] 只改自己写入的数据；临时数据用完删除
- [ ] 界面渲染失败时有回退，不把异常抛到消息渲染里
- [ ] 有新逻辑时有对应 `*.test.js`（`npm test` 不依赖浏览器）
