/**
 * Permission consent prompt.
 *
 * Core emits `core:permission:requested` when an extension asks for a grant.
 * This module turns open requests into a declarative Loom UI tree, which the
 * panel renders through the framework's own view engine (`LoomUI.createView`) —
 * the first real consumer of that system rather than hand-written markup.
 *
 * Builders are pure: no DOM access, so the prompt structure stays unit testable.
 */

export const CONSENT_CONTAINER_ID = 'loom_consent';
export const CONSENT_VIEW_ID = 'loom-consent';

/**
 * One-line summary of a capability schema, for a consent prompt that has to stay
 * readable. Full JSON contracts stay in the panel; here the user only needs
 * "what will it send and what will it get back".
 */
export function describeContract(schema) {
    if (schema === null || schema === undefined) return '无';
    if (typeof schema !== 'object' || Array.isArray(schema)) return '未知';

    const typeOf = value => {
        if (value === null) return '任意';
        if (Array.isArray(value.type)) return value.type.join('|');
        if (typeof value.type === 'string') return value.type;
        return '任意';
    };

    if (schema.type === 'array') {
        return `数组<${typeOf(schema.items ?? {})}>`;
    }
    if (schema.type === 'object' || Array.isArray(schema.required) || schema.properties) {
        const required = Array.isArray(schema.required) ? schema.required.filter(key => typeof key === 'string') : [];
        if (required.length === 0) {
            const properties = schema.properties && typeof schema.properties === 'object'
                ? Object.keys(schema.properties)
                : [];
            return properties.length > 0 ? `{ ${properties.join(', ')} }` : '空对象';
        }
        const shown = required.slice(0, 4).join(', ');
        const suffix = required.length > 4 ? `, +${required.length - 4}` : '';
        return `{ ${shown}${suffix} }`;
    }
    if (schema.enum) return `${typeOf(schema)} 枚举`;
    return typeOf(schema);
}

/**
 * Join open requests with extension names, the capabilities that declare each
 * permission, and a readable summary of those capabilities' contracts.
 *
 * @param {{ requests?: Array, extensions?: Array, capabilities?: Array }} state
 */
export function summarizeRequests({ requests = [], extensions = [], capabilities = [] } = {}) {
    const extensionNames = new Map(extensions.map(extension => [extension.id, extension.name || extension.id]));
    const declaredBy = new Map();
    for (const capability of capabilities) {
        for (const permission of capability.permissions ?? []) {
            if (!declaredBy.has(permission)) declaredBy.set(permission, new Map());
            declaredBy.get(permission).set(
                `${capability.extensionId}:${capability.id}`,
                {
                    id: `${capability.extensionId}:${capability.id}`,
                    input: describeContract(capability.input),
                    output: describeContract(capability.output),
                },
            );
        }
    }

    return requests
        .map(request => {
            const contracts = [...(declaredBy.get(request.permission)?.values() ?? [])]
                .sort((left, right) => left.id.localeCompare(right.id));
            return {
                id: request.id,
                extensionId: request.extensionId,
                extensionName: extensionNames.get(request.extensionId) ?? request.extensionId,
                permission: request.permission,
                reason: typeof request.reason === 'string' ? request.reason : '',
                declaredBy: contracts.map(contract => contract.id),
                contracts,
            };
        })
        .sort((left, right) => (
            left.extensionName.localeCompare(right.extensionName) || left.permission.localeCompare(right.permission)
        ));
}

/**
 * Build the consent prompt as a Loom UI node tree.
 *
 * @param {Array} summaries Output of `summarizeRequests`.
 * @param {{ approve: (requestId: string) => void, deny: (requestId: string) => void }} handlers
 * @returns {object|null} A `card` node, or null when there is nothing to ask.
 */
export function buildConsentNodes(summaries = [], handlers = {}) {
    if (summaries.length === 0) return null;

    const rows = summaries.map(summary => ({
        component: 'column',
        props: { gap: 4 },
        children: [
            {
                component: 'text',
                props: { text: `${summary.extensionName} 请求 ${summary.permission}`, variant: 'title' },
            },
            ...(summary.declaredBy.length > 0
                ? [{
                    component: 'text',
                    props: {
                        text: `所需能力：${summary.declaredBy.join('、')}`,
                        variant: 'caption',
                        tone: 'muted',
                    },
                }, {
                    // What the granted capability would actually send and return.
                    component: 'text',
                    props: {
                        text: `输入 ${summary.contracts[0].input} → 输出 ${summary.contracts[0].output}`,
                        variant: 'caption',
                        tone: 'muted',
                    },
                }]
                : [{
                    component: 'text',
                    props: { text: '当前没有能力声明该权限。', variant: 'caption', tone: 'warning' },
                }]),
            {
                component: 'text',
                props: { text: summary.reason || '未提供理由。', variant: 'caption', tone: 'muted' },
            },
            {
                component: 'row',
                props: { gap: 8 },
                children: [
                    {
                        component: 'button',
                        props: { label: '允许', variant: 'primary' },
                        on: { click: () => handlers.approve?.(summary.id) },
                    },
                    {
                        component: 'button',
                        props: { label: '拒绝' },
                        on: { click: () => handlers.deny?.(summary.id) },
                    },
                ],
            },
        ],
    }));

    return {
        component: 'card',
        props: {
            title: 'Loom 权限请求',
            subtitle: summaries.length === 1
                ? '一个扩展请求授权，允许后将写入设置。'
                : `${summaries.length} 个扩展请求授权，允许后将写入设置。`,
        },
        children: rows,
    };
}
