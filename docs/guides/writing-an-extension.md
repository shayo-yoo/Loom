# 写一个 Loom 扩展

这份指南面向第一次给 Loom 写扩展的人。读完后你应当能：新建一个扩展包、让它被 Loom 自动装载、声明权限、调用宿主能力、用 LoomUI 画界面，并知道怎么验证。

Loom 运行在 SillyTavern 里，是一个"给扩展用的框架"：它负责扩展的注册、权限、事件、状态和界面基础设施；具体功能由扩展实现。

## 1. 最小扩展包

```
extensions/hello-loom/
├── manifest.json
└── index.js
```

`manifest.json` 描述身份与依赖：

```json
{
    "id": "hello-loom",
    "name": "Hello Loom",
    "version": "0.1.0",
    "author": "your-name",
    "description": "示例扩展",
    "entry": "index.js",
    "dependencies": [],
    "permissions": []
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 必须与目录名一致；`/^[a-z0-9][a-z0-9._-]*$/i` |
| `name` | 是 | 显示名 |
| `version` | 是 | 字符串，Loom 不做语义化校验 |
| `author` | 否 | 作者标识；与 `id` 组成身份 `author:id`。缺省视为 `anonymous` |
| `entry` | 是 | 包内入口 `.js`，必须存在 |
| `description` | 否 | 面板与索引里显示 |
| `dependencies` | 否 | 依赖的扩展 id；激活时它们必须已 `active` |
| `permissions` | 否 | 激活时向用户申请的权限（会弹同意提示） |

`npm run extensions:index` 会对「清单字段 + 入口源码」计算内容哈希并写进索引，Loom 用它识别实际内容；修改入口文件后重新生成索引，哈希会随之变化。

`index.js` 默认导出一个对象或返回该对象的函数：

```js
export default {
    activate({ id }) { /* 注册能力、挂界面、订阅事件 */ },
    deactivate({ id }) { /* 可选：释放自己的资源 */ },
};
```

- `activate` 在依赖满足、权限同意后调用；抛错会让扩展进入 `failed` 状态并记录错误，不影响其他扩展。
- `deactivate` 在卸载前调用；扩展的能力、监听、状态由 Loom 在卸载时统一清理。
- 身份（id/name/version）来自 `manifest.json`，钩子来自代码；加载器会把两者合并。

## 2. 注册一个能力

能力是扩展对外暴露的、带输入/输出契约的函数。别的扩展通过 `executeCapability` 调用。

```js
export default {
    activate({ id }) {
        globalThis.Loom.registerCapability(id, {
            id: 'hello.greet',
            name: 'Say hello',
            description: '返回一句问候',
            input: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1 } },
                additionalProperties: false,
            },
            output: {
                type: 'object',
                required: ['message'],
                properties: { message: { type: 'string' } },
                additionalProperties: false,
            },
            execute: input => ({ message: `Hello, ${input.name}!` }),
        });
    },
};
```

支持的 schema 子集：`type`（含类型数组）、`enum`、`const`、`required`、`properties`、`items`、`additionalProperties`、`minimum`/`maximum`、`minLength`/`maxLength`、`minItems`/`maxItems`。不支持的写法会在注册时直接报错。输入在调用前校验，输出在返回后校验——不要把未校验的数据传出去。

调用别人的能力：

```js
const result = await globalThis.Loom.executeCapability('loom-host', 'worlds.list', null, { caller: id });
if (!result.success) return result.error; // { code, message, details }
return result.data;
```

`caller` 必须是调用方自己的扩展 id；跨扩展调用要显式写目标扩展 id。

能力还可以声明两段可选元数据，便于调用方和工具判断契约：

```js
globalThis.Loom.registerCapability(id, {
    id: 'my.tool',
    name: 'My tool',
    errors: [{ code: 'NOT_FOUND', description: '目标不存在' }],
    compatibility: { since: '0.34.0', deprecated: false },
    execute: () => null,
});
```

- `errors`：可能返回的错误码（`UPPER_SNAKE_CASE`），仅作说明，不限制运行时实际错误码；
- `compatibility`：`since` / `deprecated` / `notes`。

自定义数据类型也可以登记稳定的身份（Loom 不解释内容，只做契约命名）：

```js
globalThis.Loom.registerType(id, {
    id: 'note',
    name: 'Note',
    schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
});
// getType(id, 'note') / listTypes(id) 按 `扩展id:类型id` 识别
```

## 3. 权限

两层：

1. **能力声明**：`permissions: ['host.worldinfo.write']` 表示"调用我的人需要这个权限"。Core 在 handler 之前统一检查。
2. **扩展声明**：`manifest.permissions` 表示"我激活时需要这些权限"，卸载后失效。

```js
globalThis.Loom.checkPermission(id, 'host.worldinfo.write');   // 是否已授权
globalThis.Loom.requestPermission(id, 'host.worldinfo.write', { reason: '需要写入世界书' });
```

`requestPermission` 会触发同意提示（带能力的输入/输出摘要），用户同意后才生效。授权持久化在宿主设置里，刷新后仍在。权限是**访问约束，不是沙箱**——同一页面里的脚本理论上可以绕过，Loom 不承诺对抗恶意脚本。

## 4. 状态与事件

```js
globalThis.Loom.setState(id, 'counter', 3);      // 可克隆的值；宿主挂了 store 时会持久化
globalThis.Loom.getState(id, 'counter');         // 当前值

globalThis.Loom.subscribe(id, 'host:message:sent', payload => { /* ... */ });
```

卸载扩展会清空它的状态与订阅。宿主事件是白名单转发（`host:chat:changed`、`host:message:sent`、`host:worldinfo:updated` 等），只带 `{ source, event }`，不携带聊天内容。

## 5. 界面

LoomUI 是声明式视图树，渲染到任意容器：

```js
const view = globalThis.LoomUI.createView(id, {
    target: '#my-container',       // CSS 选择器或元素；省略则挂到 document.body
    root: {
        component: 'card',
        props: { title: '我的扩展' },
        children: [
            { component: 'text', props: { text: '你好' } },
            { component: 'button', props: { label: '点我' }, on: { click: () => alert('hi') } },
        ],
    },
});
```

- 节点形状：`{ component, props?, children?, on?, key? }`；字符串会被当作 `text`。
- 可用组件：`text`、`button`（`label`）、`input`、`textarea`、`toggle`、`select`、`card`、`row`、`column`、`grid`、`divider`、`list`、`badge`、`image`、`tabs`、`modal`、`menu`。
- `select` 的 `options` 既可以是字符串，也可以是 `{ value, label }`（例如显示"条目 12"而值是 `"12"`）。
- 局部更新：`view.setProps([0, 1], { text: '新文本' })`、`view.setChildren([...], [...])`；`path` 是从根开始的下标数组。
- `key` 用于列表重排：带 `key` 的子节点在重排时保留元素与焦点。
- `tabs` 与 `modal` 是受控组件：交互只上报意图，由你的 `props` 决定显示状态。
- 事件处理器的参数是 `{ event, payload, path, viewId, extensionId }`；`select`/`input`/`textarea`/`toggle` 的 `change` 把新值放在 `payload` 里（如 `payload.value`）。
- 没有 `setRoot` 之外的大范围更新手段：状态驱动时重建整棵树最简单；重建会让输入框失焦，所以只在 `change`（失焦后）触发重建。

可复用的组合界面建议注册成**复合组件**，而不是把同一棵树复制到多处：

```js
globalThis.LoomUI.registerCompositeComponent(id, {
    id: 'greeting',
    name: 'Greeting',
    props: { name: { type: 'string', default: 'world' } },
    build: props => ({ component: 'text', props: { text: `Hello ${props.name}` } }),
});
// 之后任何视图都可以用 { component: 'greeting', props: { name: 'Loom' } }
```

复合组件与普通组件共享身份、属性校验、事件与清理；它内部是一棵嵌套视图，`update` 时重建、`unmount` 时销毁。

如果界面要放进酒馆自己的面板（而不是浮在页面上），用槽位：

```js
const view = globalThis.LoomUI.mountToSlot(id, 'settings', {
    root: { component: 'text', props: { text: '我的设置' } },
});
// view 为 null 说明容器还没渲染出来，稍后再挂一次即可
globalThis.LoomUI.unmountFromSlot(id, 'settings');
```

可用槽位：`settings`（扩展设置列）、`settings2`、`menu`（魔杖菜单）、`leftNav`。槽位是白名单，未知槽位会直接报错；卸载扩展时挂载的界面会被自动移除。

## 6. 上下文注入

如果扩展需要影响模型读到的内容，用注入能力（需要单独授权 `host.prompt.inject`）：

```js
await globalThis.Loom.executeCapability('loom-host', 'prompt.set', {
    text: '保持角色设定，不要跳出。',
    position: 'in_chat',   // in_prompt / in_chat / before_prompt
    depth: 4,
    role: 'system',        // system / user / assistant
    key: 'main',
}, { caller: id });

await globalThis.Loom.executeCapability('loom-host', 'prompt.list', null, { caller: id });
await globalThis.Loom.executeCapability('loom-host', 'prompt.clear', { all: true }, { caller: id });
```

要点：

- 键会被命名空间化为 `loom:<你的 id>:<key>`，因此不会和其他扩展冲突，也看不到别人的注入；
- 写入后会回读校验，宿主没存下来会得到 `PROMPT_INJECT_FAILED`；
- 扩展卸载时它写入的所有注入会自动清除；
- 目前**不支持**修改生成过程本身（`GENERATION_AFTER_COMMANDS`），只支持向上下文写入。

## 7. 脚本：一个文件就够了

不是每个小功能都值得建扩展目录。面板「脚本」区可以直接粘贴一个 ES 模块并运行：不需要 `manifest.json`、不需要目录、不需要跑索引。

```js
export default {
    activate({ id }) {
        globalThis.Loom.registerCapability(id, {
            id: 'my.tool',
            name: 'My tool',
            input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false },
            output: { type: 'string' },
            execute: input => input.text.trim(),
        });
    },
};
```

- 身份（`script-<名称>`）由 Loom 生成，脚本只写钩子；能力、权限、状态、错误、卸载都按普通扩展处理。
- 脚本保存在 Loom 的持久状态里，刷新页面后自动重新运行；删除脚本会卸载它。
- 每个脚本可以 **停用/启用**：停用会卸载脚本但保留源码，刷新后也不会自动运行；启用会重新运行。
- 点 **编辑** 会把源码载入表单，保存时按「保存修改」更新原脚本；「重新运行」直接重跑当前源码。
- 脚本不是沙箱：它是本地加载器，信任边界与扩展相同——不要用它运行来源不明的代码。

## 8. 第三方自注册扩展

如果扩展不在 `extensions/` 下（例如由另一段代码在运行时注入），可以请求 Loom 登记：

```js
const { id, status } = globalThis.LoomUI.registerExternal({
    id: 'my-tool',
    name: '我的工具',
    version: '1.0.0',
    author: 'someone',
    description: '一句话说明',
    permissions: ['host.chat.read'],
});
// status === 'pending'：已弹出确认，用户允许后才会真正注册
```

流程与约定：

- 首次请求是 `pending`：面板上方会弹出确认卡，列出 id、版本、作者、说明与**声明的权限**；
- 允许后 Loom 以 `origin: 'external'` 注册它，声明的权限再走正常的授权流程；
- 拒绝会记住，重复请求会直接报错；面板提供「改判允许 / 清除记录」；
- 决定会被持久化，刷新后不会重复询问，启动时只恢复已允许的记录；
- 这是**协作式确认，不是沙箱**：绕过本接口直接调用全局运行时不会被阻止。它的价值是让用户知道"有第三方代码要进来"。

## 9. 安装、启用与重载

1. 扩展：把目录放进 `extensions/<id>/`，运行 `npm run extensions:index`。
2. 刷新酒馆页面，或在面板「安装与扩展」里点 **重新扫描**（不必刷新页面）；面板会列出它，状态 `active`。
3. 面板按类别折叠：安装与扩展、脚本默认展开，扩展状态/宿主环境/权限/事件/公开能力默认收起，点标题展开；展开状态会被记住。
4. 每行可以 **停用/启用**（停用会卸载扩展并记住选择，刷新后仍然停用）、**重新加载**（修改代码后重新导入；手动安装的模块会带缓存参数，确保读到新文件）、**移除**（仅手动安装的扩展）。

手动安装（不放进仓库）：在面板输入模块地址（相对 Loom 根目录或绝对 URL），安装记录会持久化，刷新后自动恢复。

## 10. 调试

- 面板「扩展」列表显示每个扩展的状态与错误信息；
- 「安装问题」区显示导入/脚本失败的原因；
- `globalThis.Loom.getExtensionState('<id>')` 读取状态与最后错误；
- `globalThis.LoomUI.isReady()` 判断安装器是否已完成启动（索引与脚本已加载）；
- 单元测试放在相邻的 `*.test.js`，`npm test` 无需浏览器；
- 端到端验证用 `npm run verify:browser`（需要酒馆在 8100 运行），并可用 `Emulation` 模拟窄视口。**验证脚本只能修改自己创建的临时数据**。

## 11. 完整例子

`extensions/hello-loom/` 是最小可用包；`extensions/world-book-manager/` 演示了权限申请、宿主读写、LoomUI 界面、分页/搜索与错误处理。两者的 `manifest.json` 与 `index.js` 都可以直接复制改写。

世界书管理器的两个容易踩的点，也写在代码注释里：

- **读完整内容要用 `worlds.export`**：`worlds.entries` 为展示会把内容截断到 2000 字，拿截断内容回写会毁数据。
- **`worlds.entry.update` 的 `uid` 是字符串**（`worlds.entry.create` 返回的也是字符串），传数字会得到 `INVALID_INPUT`。

## 12. 消息内面板与回执：完整示例

`extensions/character-panel/` 是一个可运行的样板，把"界面 + 数据 + 上下文"串成一条闭环，四步对应四个能力：

| 步骤 | 做法 |
|---|---|
| 在消息里显示面板 | `LoomUI.registerBlock(id, { id, build })` + 往消息写入 `⟦loom:<kind>⟧⟦/loom⟧` |
| 保存数据 | `Loom.setState(id, 'panel', {...})`（宿主持久化） |
| 让 AI 看到状态 | `prompt.set` 注入自然语言，含`【角色状态】`与`【回执规则】` |
| 让 AI 改状态 | 解析它消息里的 `[[item:药水:+1]]` 之类回执 |

两个容易踩的坑，示例里都处理了：

- **渲染后标记就没有了**：块的标记会被替换成控件容器，所以数据变了要调 `LoomUI.rerenderBlocks(id)`（重建实时视图），而不是再 `refreshBlocks`（那是从文本里找新块）；
- **回执只处理一次**：激活时把已有消息的下标记为"已处理"，之后只处理新消息，否则刷新/重载会把历史回执重复应用。

回执语法刻意保持朴素（`[[gold:+10]]`、`[[item:药水:-1]]`、`[[exp:+50]]`、`[[level:+1]]`）：模型能照着模仿，短到留在消息里几乎不占 token，而且它本身就是一份可读的操作日志。若希望它完全不出现在上下文里，可以把回执也写成块（`⟦loom:receipt⟧…⟦/loom⟧`），代价是**模型看不到语法就学不会**——这是个取舍，示例选择了"可学习"。

调试这类扩展时：

- 面板里「扩展」区能看到它的状态与错误；
- 注入是否生效，看 `prompt.list`（只能看到自己的）；
- 回执没生效时优先检查 `host.chat.read` 授权——没授权就读不到消息，代码里会打印一次警告。

### 面板怎么"出现"

块本身只是一段标记，**不会自己出现**。每一步都是显式的：

1. 往消息里写标记（示例用 `chat.append` 写一条系统消息）；
2. 渲染器把标记换成控件（自动，见上）；
3. 数据变了重建控件（`rerenderBlocks`）。

示例扩展把这三步收成一个能力 `panel.show`，并给它配了一个入口：挂到酒馆的魔杖菜单（`LoomUI.mountToSlot(id, "menu", …)`），点一下就把面板插进当前聊天，已经有了就只重绘。**不要**在激活或宿主事件里自动写消息——那会把界面塞进每一段对话，示例最初就是这样在用户聊天里堆了八条相同消息。

这一轮的三个真实故障，值得记住：

| 故障 | 原因 | 修法 |
|---|---|---|
| 面板完全不出现 | 标记从未写入，渲染器无标记可找 | 提供显式入口；激活只绘制"已存在"的标记 |
| 面板出现过又消失 | `refreshBlocks` 在标记缺失时销毁了活动控件 | 标记缺失且已有 `.loom-block` 时不销毁 |
| 改了扩展代码却仍是旧行为 | 浏览器缓存 ES 模块 | 导入时用包指纹做 cache-busting（`?v=<contentHash>`） |

## 13. 常见错误

| 现象 | 原因 |
|---|---|
| 面板里看不到包 | 没跑 `npm run extensions:index`，或 `id` 与目录名不一致 |
| 状态 `failed` + `MANIFEST_INVALID` | manifest 字段不合规（id 非法、entry 不存在） |
| 调用返回 `PERMISSION_DENIED` | 能力声明了权限而调用方没获授权；先 `requestPermission` |
| 调用返回 `INVALID_INPUT` | 输入不符合声明的 schema（多余字段也会被拒） |
| `CAPABILITY_NOT_FOUND` | 目标扩展未激活，或能力 id 写错 |
| 刷新后手动安装的扩展消失 | 安装记录在 `loom-ui` 状态里；检查宿主 settings 是否持久化 |
| 数据变了但面板没变 | 渲染后标记已被替换，用 `rerenderBlocks` 而不是 `refreshBlocks` |
| 回执一直不生效 | 没批 `host.chat.read`（读不到消息），或消息不是新消息（索引已被标记处理） |
| 双向回执重复应用 | 激活时没有把历史消息标记为已处理 |

## 14. 给 AI 的压缩版

如果要把项目交给 AI 写扩展，直接给它 `docs/guides/ai-extension-authoring.md`：那是同一套规则的机器向摘要（能力表、schema 子集、组件必填 props、块与回执、错误码、自检清单），比本文更短、更适合作为提示词上下文。
