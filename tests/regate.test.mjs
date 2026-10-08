// 离线自测：补摘监听（regate）+ 广播（announce）。
// 覆盖两件事：
//   ① provider 插件重新注册（典型：llm-pi-ai 在 loader/volatile-update 时
//      registration.replace(routes) 把整套路由写回 adapters）后，被禁用的
//      provider 是否被再次摘掉；
//   ② 变更是否**真的广播** llm/adapters-updated —— 0.2.1 及之前只在
//      events.dispatch 上取到监听器却不调用，等于空操作，客户端永不刷新。
// stub 复刻 cordis 的语义：dispatch(type, args) 只「解析并按事件名返回监听器」，
// 不调用它们（真正的调用发生在 emit/parallel/serial 里），且会 shift 掉事件名。
// 用法：node tests/regate.test.mjs   （零网络、零写入真实 ~/.dsh，state 落在临时 HOME）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-regate-'));
process.env.DSH_HOME = tmp;
const stateDir = path.join(tmp, 'state', 'provider-gate');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
	path.join(stateDir, 'state.json'),
	JSON.stringify({ disabledProviders: ['gpt'], disabledModels: {} }, null, '\t'),
);

const { apply } = await import('../lib/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const registration = (id) => ({
	provider: { id, name: id },
	adapter: { listModels: async () => [] },
});
const adapters = new Map();
/** name → listener[]（cordis 一个事件可挂多个 listener）。 */
const handlers = new Map();
/** 每次 dispatch 解析到的事件名（用于断言「广播发生了」）。 */
const dispatched = [];
/** 模拟 api-remotes 的转发 listener 被调用的次数 —— 它被调用 = client 会收到事件。 */
const forwarded = [];

const events = {
	dispatch(type, args) {
		const name = args.shift(); // cordis 会 shift 掉事件名（并 mutate 入参数组）
		if (typeof name === 'string' && !name.startsWith('internal/')) dispatched.push(name);
		return (handlers.get(name) ?? []).slice();
	},
};
const ctx = {
	llm: {
		adapters,
		listModels: async () => [],
		resolveModelInfo: async () => ({}),
		streamWithRegistration: async () => {},
	},
	events,
	get(name) {
		return name === 'events' ? events : undefined;
	},
	on(name, fn) {
		const list = handlers.get(name) ?? [];
		list.push(fn);
		handlers.set(name, list);
		return () => handlers.set(name, (handlers.get(name) ?? []).filter((f) => f !== fn));
	},
	effect(fn) {
		const disposer = fn();
		return typeof disposer === 'function' ? disposer : () => {};
	},
	inject(_deps, cb) {
		cb({ webServer: { register() {} } });
		return () => {};
	},
};

adapters.set('gpt', registration('gpt')); // 禁用项：replay 时就该被摘掉
adapters.set('grok', registration('grok')); // 未禁用项：必须一直在

// 模拟「api-remotes 转发 listener → typertGateway → client catalog.refresh()」
// 这段链路里的转发方：它被调用，才说明客户端有机会刷新。
handlers.set('llm/adapters-updated', [() => { forwarded.push('forward'); }]);

apply(ctx);
await sleep(120); // 等 replay 读完 state

const checks = [];
const check = (name, fn) => {
	try {
		fn();
		checks.push([true, name]);
	} catch (error) {
		checks.push([false, `${name} — ${error.message}`]);
	}
};

check('replay 摘掉了清单里的 gpt', () => assert.equal(adapters.has('gpt'), false));
check('未禁用的 grok 不受影响', () => assert.equal(adapters.has('grok'), true));
check(
	'补摘监听 + 转发 listener 都挂在 llm/adapters-updated 上',
	() => assert.equal((handlers.get('llm/adapters-updated') ?? []).length, 2),
);

// 模拟 llm-pi-ai 的 volatile-update：全量 replace 把 gpt 写回 adapters
const beforeForwarded = forwarded.length;
adapters.set('gpt', registration('gpt'));
events.dispatch('emit', ['llm/adapters-updated']).forEach((listener) => listener());
await sleep(30);
check('重注册后被再次摘掉', () => assert.equal(adapters.has('gpt'), false));
check(
	// +1 = 上面那次人工广播（模拟 llm-pi-ai 自己 commitRoutes 时的广播）；
	// +1 = 补摘摘到东西后 announce 的广播 → 客户端因此会重拉目录
	'补摘真的广播了（人工广播之外还多一次 → 客户端会刷新目录）',
	() => assert.equal(forwarded.length, beforeForwarded + 2),
);
check('未禁用项仍未被误摘', () => assert.equal(adapters.has('grok'), true));
check(
	'广播的是 llm/adapters-updated 这个事件名',
	() => assert.ok(dispatched.filter((n) => n === 'llm/adapters-updated').length >= 2),
);

// 幂等：无可摘项时不再广播（链上有界，不会自我循环）
const before2 = forwarded.length;
events.dispatch('emit', ['llm/adapters-updated']).forEach((listener) => listener());
await sleep(30);
check(
	// 只多了本次人工广播那一跳；补摘没有额外广播（否则会成环）
	'无变化时不再额外广播、不成环',
	() => assert.equal(forwarded.length, before2 + 1),
);

const failed = checks.filter(([ok]) => !ok);
for (const [ok, name] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
