/**
 * Offline verification for the FFXIV tool plugin.
 *
 * Checks: plugin shape, tool count/names, compact parameter DSL, output schema
 * shape, renderers, local-only tool execution, and the "supported: false"
 * behavior of tools whose external endpoint is not configured.
 * Network-dependent success paths are covered by `scripts/smoke.mjs`.
 * @module dsh-plugin-ffxiv/scripts/verify
 */
import assert from 'node:assert/strict';
import { apply, createTools, inject, loadDefineTool, TOOL_NAMES } from '../index.js';
import { createFallbackDefineTool } from '../core/define.js';
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function render(tool, args, value) {
    const blocks = tool.output.render(args, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name}: render 必须返回非空内容块数组`);
    return blocks.map((block) => block.text).join('\n');
}
/** Recursively check one output-schema node against the enforced DSL rules. */
function checkSchema(toolName, node, path = '$') {
    assert.ok(isRecord(node), `${toolName}: schema ${path} 必须是对象`);
    if (Array.isArray(node.oneOf)) {
        assert.ok(node.oneOf.length >= 2, `${toolName}: schema ${path}.oneOf 至少 2 个分支`);
        node.oneOf.forEach((branch, index) => checkSchema(toolName, branch, `${path}.oneOf[${index}]`));
        return;
    }
    const type = node.type;
    assert.ok(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'].includes(String(type)), `${toolName}: schema ${path}.type 非法（${String(type)}）`);
    if (type === 'object') {
        assert.equal(typeof node.additionalProperties, 'boolean', `${toolName}: schema ${path} 必须显式声明 additionalProperties`);
        assert.ok(isRecord(node.properties), `${toolName}: schema ${path}.properties 必须是对象`);
        for (const [key, child] of Object.entries(node.properties))
            checkSchema(toolName, child, `${path}.${key}`);
        if (node.required !== undefined) {
            assert.ok(Array.isArray(node.required), `${toolName}: schema ${path}.required 必须是数组`);
            for (const key of node.required) {
                assert.ok(key in node.properties, `${toolName}: schema ${path}.required 引用了未知属性 ${key}`);
            }
        }
    }
    if (type === 'array') {
        assert.ok(isRecord(node.items), `${toolName}: schema ${path}.items 必须声明`);
        checkSchema(toolName, node.items, `${path}[]`);
    }
}
function checkParameters(toolName, parameters) {
    assert.ok(isRecord(parameters), `${toolName}: parameters 必须是对象`);
    assert.equal(parameters.type, 'object', `${toolName}: parameters.type 必须是 object`);
    assert.equal(parameters.additionalProperties, false, `${toolName}: parameters 必须 additionalProperties:false`);
    assert.ok(isRecord(parameters.properties), `${toolName}: parameters.properties 必须是对象`);
    for (const [key, value] of Object.entries(parameters.properties)) {
        assert.ok(isRecord(value), `${toolName}: 参数 ${key} 必须是对象`);
        assert.ok(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'].includes(String(value.type)), `${toolName}: 参数 ${key}.type 非法`);
        assert.ok(typeof value.description === 'string' && value.description.length > 0, `${toolName}: 参数 ${key} 缺少 description`);
        if (value.type === 'object') {
            assert.equal(typeof value.additionalProperties, 'boolean', `${toolName}: 参数 ${key} 需要 additionalProperties`);
        }
    }
}
/** Validate one canonical value against the compiled output schema (mirrors the Harness rules). */
function validateValue(toolName, schema, value, path = '$') {
    if (Array.isArray(schema.oneOf)) {
        let lastError;
        for (const branch of schema.oneOf) {
            try {
                validateValue(toolName, branch, value, path);
                return;
            }
            catch (error) {
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(`${toolName}: ${path} 不匹配 oneOf`);
    }
    if (schema.type === undefined)
        return;
    switch (schema.type) {
        case 'object': {
            assert.ok(isRecord(value), `${toolName}: ${path} 应为对象`);
            for (const key of schema.required ?? []) {
                assert.ok(key in value, `${toolName}: ${path}.${key} 是必填字段但缺失`);
            }
            if (schema.additionalProperties === false) {
                for (const key of Object.keys(value)) {
                    assert.ok(key in (schema.properties ?? {}), `${toolName}: ${path}.${key} 不在 schema 中（会被 Harness 拒绝）`);
                }
            }
            for (const [key, child] of Object.entries(schema.properties ?? {})) {
                if (key in value && value[key] !== undefined)
                    validateValue(toolName, child, value[key], `${path}.${key}`);
            }
            break;
        }
        case 'array': {
            assert.ok(Array.isArray(value), `${toolName}: ${path} 应为数组`);
            value.forEach((item, index) => validateValue(toolName, schema.items, item, `${path}[${index}]`));
            break;
        }
        case 'integer':
            assert.ok(typeof value === 'number' && Number.isInteger(value), `${toolName}: ${path} 应为整数`);
            break;
        case 'number':
            assert.ok(typeof value === 'number' && Number.isFinite(value), `${toolName}: ${path} 应为数字`);
            break;
        case 'string':
            assert.equal(typeof value, 'string', `${toolName}: ${path} 应为字符串`);
            break;
        case 'boolean':
            assert.equal(typeof value, 'boolean', `${toolName}: ${path} 应为布尔值`);
            break;
        case 'null':
            assert.equal(value, null, `${toolName}: ${path} 应为 null`);
            break;
        default:
            break;
    }
    if (Array.isArray(schema.enum)) {
        assert.ok(schema.enum.includes(value), `${toolName}: ${path} 不在枚举范围内`);
    }
    if (schema.const !== undefined)
        assert.deepEqual(value, schema.const, `${toolName}: ${path} 必须等于 const`);
}
/** Build a fake Cordis context and run the plugin's apply() to check registration. */
async function checkApplyRegistersAll() {
    const registered = [];
    const fakeCtx = {
        tools: {
            register: (definition) => {
                registered.push(definition);
                return () => { };
            },
        },
    };
    await apply(fakeCtx);
    assert.equal(registered.length, 21, `apply 应注册 21 个工具，实际 ${registered.length}`);
    for (const tool of registered) {
        assert.ok(tool.name.startsWith('ffxiv_'), `${tool.name}: 注册名不合法`);
        assert.equal(typeof tool.execute, 'function', `${tool.name}: 注册定义缺少 execute`);
        assert.equal(typeof tool.output?.render, 'function', `${tool.name}: 注册定义缺少 render`);
        assert.equal(typeof tool.parameters, 'object', `${tool.name}: 注册定义缺少 parameters`);
    }
    console.log(`✓ 插件 apply 注册成功：${registered.length} 个工具（模拟 Cordis ctx.tools.register）`);
}
async function main() {
    // 1. Plugin shape.
    assert.equal(typeof apply, 'function', 'apply 必须是函数');
    assert.ok(Array.isArray(inject) && inject.includes('tools'), "inject 必须包含 'tools'");
    // 2. Build with the fallback compiler, then with the real defineTool if possible.
    const fallback = createFallbackDefineTool();
    const tools = createTools(fallback);
    assert.equal(tools.length, 21, `应注册 21 个工具，实际 ${tools.length}`);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, '工具名不能重复');
    assert.deepEqual(new Set(tools.map((tool) => tool.name)), new Set(TOOL_NAMES), '工具名与 TOOL_NAMES 不一致');
    for (const tool of tools) {
        assert.ok(tool.name.startsWith('ffxiv_'), `${tool.name}: 工具名必须以 ffxiv_ 开头`);
        assert.ok(tool.description.startsWith('当用户') && tool.description.includes('时调用此工具'), `${tool.name}: description 必须写成“当用户……时调用此工具”`);
        checkParameters(tool.name, tool.parameters);
        checkSchema(tool.name, tool.output.schema);
        assert.equal(typeof tool.output.render, 'function', `${tool.name}: 缺少 render`);
        assert.equal(typeof tool.execute, 'function', `${tool.name}: 缺少 execute`);
    }
    let realDefineToolAvailable = false;
    let realTools;
    try {
        const mod = await import('@deepseek-ai/dsh-tools');
        if (typeof mod?.defineTool === 'function') {
            // loadDefineTool() applies the author-schema → dsh-tools DSL projection.
            realTools = createTools(await loadDefineTool());
            assert.equal(realTools.length, 21, '真实 defineTool 构建的工具数不对');
            for (const tool of realTools) {
                assert.equal(typeof tool.parameters, 'object', `${tool.name}: 真实 defineTool 缺少 parameters`);
                assert.equal(typeof tool.output.render, 'function', `${tool.name}: 真实 defineTool 缺少 render`);
                assert.equal(typeof tool.output.schema, 'object', `${tool.name}: 真实 defineTool 缺少 schema`);
                assert.equal(typeof tool.execute, 'function', `${tool.name}: 真实 defineTool 缺少 execute`);
            }
            realDefineToolAvailable = true;
            console.log('✓ 真实 @deepseek-ai/dsh-tools defineTool 构建成功（21 个工具，含 DSL 适配）');
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Cannot find package '@deepseek-ai/") || message.includes('ERR_MODULE_NOT_FOUND')) {
            // 本地校验目录只安装了 dsh-tools 本身，Harness 宿主运行时才会提供 peer 依赖。
            console.log('… 本机未安装 dsh-tools 的 peer 依赖，跳真实 defineTool 构建（Harness 加载时会用真实实现）');
        }
        else {
            console.error('✗ 真实 defineTool 构建失败：', message);
            process.exitCode = 1;
        }
    }
    if (!realDefineToolAvailable) {
        console.log('… 未加载真实 defineTool（将使用 fallback 原始 JSON Schema 注册）');
    }
    const call = async (name, args, timeoutMs = 30_000) => {
        const tool = tools.find((entry) => entry.name === name);
        assert.ok(tool, `缺少工具 ${name}`);
        const value = await tool.execute(args, { signal: AbortSignal.timeout(timeoutMs) });
        const text = render(tool, args, value);
        assert.ok(text.trim().length > 0, `${name}: render 输出为空`);
        return { value, text, tool };
    };
    // 3. Local-only tools must work without network access.
    const et = await call('ffxiv_et_now', {});
    assert.match(et.text, /艾欧泽亚时间：\d{2}:\d{2}/);
    assert.match(et.text, /本地：/);
    console.log('✓ ffxiv_et_now：', et.text);
    const reset = await call('ffxiv_reset_timers', {});
    assert.match(reset.text, /每日重置：还有/);
    assert.match(reset.text, /每周重置：还有/);
    console.log('✓ ffxiv_reset_timers：', reset.text.split('\n').join(' | '));
    const weather = await call('ffxiv_weather', { territory: '森都', windows: 3 });
    assert.equal(weather.value.territory, '格里达尼亚新街');
    assert.ok(weather.value.current.weather.length > 0);
    assert.equal(weather.value.upcoming.length, 3);
    assert.match(weather.text, /当前天气：/);
    console.log('✓ ffxiv_weather：', weather.text.split('\n').slice(0, 2).join(' | '));
    // 4. Endpoint-backed tools must degrade to supported: false without configuration.
    const unsupported = [
        ['ffxiv_fashion_report', {}, '时尚品鉴'],
        ['ffxiv_server_status', {}, '服务器状态'],
        ['ffxiv_fflogs_summary', { reportUrl: 'https://www.fflogs.com/reports/ABC123' }, 'FFLogs'],
        ['ffxiv_character_lookup', { name: '塔塔露', server: '神意之地' }, '角色'],
    ];
    const checkedValues = [
        { tool: et.tool, value: et.value },
        { tool: reset.tool, value: reset.value },
        { tool: weather.tool, value: weather.value },
    ];
    for (const [name, args, keyword] of unsupported) {
        const result = await call(name, args);
        checkedValues.push({ tool: result.tool, value: result.value });
        const value = result.value;
        if ('supported' in value)
            assert.equal(value.supported, false, `${name}: 未配置时应 supported:false`);
        if ('found' in value)
            assert.equal(value.found, false, `${name}: 未配置时应 found:false`);
        assert.ok(typeof value.message === 'string' && value.message.length > 0, `${name}: 不支持时必须给出 message`);
        assert.ok(result.text.includes(value.message) || /暂不可用|需要|未找到/.test(result.text), `${name}: render 应输出说明文本`);
        assert.ok(!/^\s*[{[]/.test(result.text), `${name}: render 不应输出原始 JSON`);
        console.log(`✓ ${name}（不支持路径，含“${keyword}”语义）：`, result.text.split('\n')[0]);
    }
    // 4b. Live community/official sources: succeed with data, degrade with a message, or throw a readable network error.
    const liveSources = [
        ['ffxiv_employee_items', { job: '园艺工', level: 90 }],
        ['ffxiv_housing', { server: '神意之地', limit: 3 }],
        ['ffxiv_party_finder', { dc: '陆行鸟', limit: 3 }],
        ['ffxiv_official_news', { limit: 3 }],
        ['ffxiv_job_guide', { job: '龙骑士', level: 90 }],
        ['ffxiv_duty_guide', { duty: '万魔殿 边境之狱4' }],
    ];
    for (const [name, args] of liveSources) {
        let result;
        try {
            result = await call(name, args, 120_000);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(message, /网络|超时|HTTP|不可达|fetch|取消/, `${name}: 网络失败应给出可读错误，实际：${message}`);
            console.log(`… ${name}：网络不可达，已按降级路径处理`);
            continue;
        }
        checkedValues.push({ tool: result.tool, value: result.value });
        const value = result.value;
        if ('supported' in value) {
            assert.equal(typeof value.supported, 'boolean', `${name}: supported 必须是布尔值`);
            if (value.supported === false) {
                assert.ok(typeof value.message === 'string' && value.message.length > 0, `${name}: supported:false 必须带 message`);
            }
        }
        assert.ok(!/^\s*[{[]/.test(result.text), `${name}: render 不应输出原始 JSON`);
        console.log(`✓ ${name}（实时数据源）：`, result.text.split('\n')[0]);
    }
    // 5. Canonical values must satisfy the compiled output schema.
    for (const { tool, value } of checkedValues)
        validateValue(tool.name, tool.output.schema, value);
    console.log(`✓ canonical 值通过 output.schema 校验：${checkedValues.length} 个返回值`);
    if (realTools) {
        // The same canonical values must satisfy the schema compiled by the real DSL.
        for (const { tool, value } of checkedValues) {
            const real = realTools.find((entry) => entry.name === tool.name);
            assert.ok(real, `真实 defineTool 缺少工具 ${tool.name}`);
            validateValue(real.name, real.output.schema, value);
        }
        console.log(`✓ canonical 值通过真实 defineTool 编译出的 schema 校验：${checkedValues.length} 个返回值`);
    }
    // 6. The plugin entry must register all tools through ctx.tools.register.
    await checkApplyRegistersAll();
    // 7. Windowing helper sanity: weather windows must be strictly future and ordered.
    const upcoming = weather.value.upcoming;
    for (const window of upcoming)
        assert.ok(window.startsIn > 0, '天气窗口必须严格在未来');
    for (let index = 1; index < upcoming.length; index += 1) {
        assert.ok(upcoming[index].startsIn > upcoming[index - 1].startsIn, '天气窗口必须按时间递增');
    }
    console.log(`\n全部离线校验通过：${tools.length} 个工具，${realDefineToolAvailable ? '真实 defineTool' : 'fallback defineTool'}。`);
}
main().catch((error) => {
    console.error('✗ 校验失败：', error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
});
