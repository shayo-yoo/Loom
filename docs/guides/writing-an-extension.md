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
| `entry` | 是 | 包内入口 `.js`，必须存在 |
| `description` | 否 | 面板与索引里显示 |
| `dependencies` | 否 | 依赖的扩展 id；激活时它们必须已 `active` |
| `permissions` | 否 | 激活时向用户申请的权限（会弹同意提示） |

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

## 6. 脚本：一个文件就够了

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
- 修改源码后点「重新运行」即可（脚本使用内存中的源码，不需要刷新页面）。
- 脚本不是沙箱：它是本地加载器，信任边界与扩展相同——不要用它运行来源不明的代码。

## 7. 安装、启用与重载

1. 扩展：把目录放进 `extensions/<id>/`，运行 `npm run extensions:index`。
2. 刷新酒馆页面；面板「扩展安装」区会列出它，状态 `active`。
3. 每行可以 **停用/启用**（停用会卸载扩展并记住选择，刷新后仍然停用）、**重新加载**（修改代码后重新导入；手动安装的模块会带缓存参数，确保读到新文件）、**移除**（仅手动安装的扩展）。

手动安装（不放进仓库）：在面板输入模块地址（相对 Loom 根目录或绝对 URL），安装记录会持久化，刷新后自动恢复。

## 8. 调试

- 面板「扩展」列表显示每个扩展的状态与错误信息；
- 「安装问题」区显示导入/脚本失败的原因；
- `globalThis.Loom.getExtensionState('<id>')` 读取状态与最后错误；
- `globalThis.LoomUI.isReady()` 判断安装器是否已完成启动（索引与脚本已加载）；
- 单元测试放在相邻的 `*.test.js`，`npm test` 无需浏览器；
- 端到端验证用 `npm run verify:browser`（需要酒馆在 8100 运行），并可用 `Emulation` 模拟窄视口。**验证脚本只能修改自己创建的临时数据**。

## 9. 完整例子

`extensions/hello-loom/` 是最小可用包；`extensions/world-book-manager/` 演示了权限申请、宿主读写、LoomUI 界面、分页/搜索与错误处理。两者的 `manifest.json` 与 `index.js` 都可以直接复制改写。

世界书管理器的两个容易踩的点，也写在代码注释里：

- **读完整内容要用 `worlds.export`**：`worlds.entries` 为展示会把内容截断到 2000 字，拿截断内容回写会毁数据。
- **`worlds.entry.update` 的 `uid` 是字符串**（`worlds.entry.create` 返回的也是字符串），传数字会得到 `INVALID_INPUT`。

## 10. 常见错误

| 现象 | 原因 |
|---|---|
| 面板里看不到包 | 没跑 `npm run extensions:index`，或 `id` 与目录名不一致 |
| 状态 `failed` + `MANIFEST_INVALID` | manifest 字段不合规（id 非法、entry 不存在） |
| 调用返回 `PERMISSION_DENIED` | 能力声明了权限而调用方没获授权；先 `requestPermission` |
| 调用返回 `INVALID_INPUT` | 输入不符合声明的 schema（多余字段也会被拒） |
| `CAPABILITY_NOT_FOUND` | 目标扩展未激活，或能力 id 写错 |
| 刷新后手动安装的扩展消失 | 安装记录在 `loom-ui` 状态里；检查宿主 settings 是否持久化 |
