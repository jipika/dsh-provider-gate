// 离线自测：补摘监听（regate）。
// 场景 = provider 插件重新注册（典型：llm-pi-ai 在 loader/volatile-update 时
// registration.replace(routes) 把整套路由写回 adapters）后，被禁用的 provider
// 是否会被再次摘掉，且不误伤未禁用项、不自我循环。
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

const registration = (id) => ({
	provider: { id, name: id },
	adapter: { listModels: async () => [] },
});
const adapters = new Map();
const handlers = new Map();
let dispatches = 0;

const events = {
	dispatch(type, args) {
		dispatches += 1;
		const fn = handlers.get(args?.[0]);
		if (typeof fn === 'function') fn({ name: args[0] });
		return [];
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
		handlers.set(name, fn);
		return () => handlers.delete(name);
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

apply(ctx);
await new Promise((r) => setTimeout(r, 120)); // 等 replay 读完 state

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
	'补摘监听挂在 llm/adapters-updated 上',
	() => assert.equal(typeof handlers.get('llm/adapters-updated'), 'function'),
);

// 模拟 llm-pi-ai 的 volatile-update：全量 replace 把 gpt 写回 adapters
const before = dispatches;
adapters.set('gpt', registration('gpt'));
handlers.get('llm/adapters-updated')();
await new Promise((r) => setTimeout(r, 30));
check('重注册后被再次摘掉', () => assert.equal(adapters.has('gpt'), false));
check('摘到东西时广播一次（客户端据此重拉目录）', () => assert.equal(dispatches, before + 1));
check('未禁用项仍未被误摘', () => assert.equal(adapters.has('grok'), true));

// 幂等：无可摘项时不再广播（链上有界，不会自我循环）
const before2 = dispatches;
handlers.get('llm/adapters-updated')();
await new Promise((r) => setTimeout(r, 30));
check('无变化时不广播、不成环', () => assert.equal(dispatches, before2));

const failed = checks.filter(([ok]) => !ok);
for (const [ok, name] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
