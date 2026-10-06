// dsh-provider-gate — host 半边
//
// 做什么：把当前 DSH 里全部 provider 路由（llm-pi-ai 手写的 + 其他插件注入的
// codex-subscription / qoder-connect / workbuddy 系列等）列出来，逐个禁用/启用；
// 再支持把某一个 provider 里的**单个模型**禁用（模型选择器立即不再出现它）。
//
// 原理（来自 app.asar 中 @deepseek-ai/dsh-llm 的 LlmRuntime 源码）：
//   · 所有 provider 都注册在 llm 服务实例的 `adapters` Map 上；
//   · `listProviders()` = [...this.adapters.values()]，
//     模型选择器目录（session-controller 的 buildModelCatalog）也调它；
//   · 请求分发 `registration(provider)` 查不到就抛 NO_ADAPTER。
//   所以「禁用 provider = 把 entry 从 Map 摘下存进快照，启用 = 放回去」一个动作
//   即可让选择器、目录、请求三处行为一致，零 patch 上游插件。
//   模型级禁用则是对 runtime 实例的三个方法做**实例级 override**（不动任何
//   插件对象、不碰 prototype）：
//     listModels(provider)     → 过滤掉被禁模型（选择器目录立即消失）
//     resolveModelInfo(...)    → 被禁模型直接抛 MODEL_DISABLED
//     streamWithRegistration   → 被禁模型直接抛 MODEL_DISABLED（请求层拦截）
//   override 的原方法闭包里读 state，清单变更即时生效（热更新）。
//
// 热更新：每次变更后广播 `llm/adapters-updated` —— 该事件在 api-remotes 的
// 转发白名单里（`API_REMOTE_FORWARDED_EVENTS`，mode "emit"），经 typertGateway
// 推到 client，`dsh-client-ui-model-selection` 收到后 `catalog.refresh()` 重新
// 拉 modelCatalog —— 于是开关一切换，所有打开着的模型选择器立刻重渲染。
//
// 路由（prefix /dsh-provider-gate，挂宿主 webServer，走 dsh-app:// 转发）：
//   GET  /providers        provider 列表（含禁用状态与各 provider 的禁用模型数）
//   GET  /models/<id>      某 provider 的模型清单（含各自禁用状态）
//   POST /toggle           { provider, disabled }                    provider 级
//   POST /bulk             { disabled: string[] }                    provider 级覆写
//   POST /toggle-model     { provider, model, disabled }             模型级
//   POST /bulk-models      { provider, models: string[] }            模型级覆写（该 provider 全量）
//   GET  /health           探活
//
// 持久化在 state/provider-gate/state.json（一个文件两层清单：
// { disabledProviders: string[], disabledModels: { [provider]: string[] } }）。

export const name = "dsh-provider-gate";

// 摘/还 entry、override 方法都要碰 ctx.llm（LlmRuntime 实例）。cordis 对未
// 注入服务的属性访问直接抛 `cannot get property "llm" without inject`
// （dsh-btw 实测），所以必须声明在这里。
export const inject = ["llm"];

const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");
const fsp = process.getBuiltinModule("node:fs/promises");

const ROUTE = "/dsh-provider-gate";
const VERSION = "0.2.0";
const HOME =
	typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
		? process.env.DSH_HOME
		: path.join(os.homedir(), ".dsh");
const STATE_DIR = path.join(HOME, "state", "provider-gate");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LEGACY_DISABLED_FILE = path.join(STATE_DIR, "disabled.json");
const MAX_BODY = 256 * 1024;

const log = (...a) => console.log("[dsh-provider-gate]", ...a);

// ── 持久化 ─────────────────────────────────────────────────────────────────

function normalizeState(raw) {
	const out = { disabledProviders: [], disabledModels: {} };
	if (Array.isArray(raw?.disabledProviders)) out.disabledProviders = raw.disabledProviders.filter((x) => typeof x === "string");
	if (Array.isArray(raw?.disabled)) out.disabledProviders = raw.disabled; // 0.1 兼容
	if (raw?.disabledModels && typeof raw.disabledModels === "object") {
		for (const [p, list] of Object.entries(raw.disabledModels)) {
			if (Array.isArray(list)) out.disabledModels[p] = list.filter((x) => typeof x === "string");
		}
	}
	return out;
}

async function loadState() {
	try {
		return normalizeState(JSON.parse(await fsp.readFile(STATE_FILE, "utf8")));
	} catch {
		// 0.1 迁移：disabled.json → state.json
		try {
			const legacy = JSON.parse(await fsp.readFile(LEGACY_DISABLED_FILE, "utf8"));
			return normalizeState({ disabledProviders: legacy });
		} catch {
			return { disabledProviders: [], disabledModels: {} };
		}
	}
}

async function saveState(state) {
	await fsp.mkdir(STATE_DIR, { recursive: true });
	const body = {
		disabledProviders: state.disabledProviders,
		disabledModels: state.disabledModels,
	};
	await fsp.writeFile(STATE_FILE, JSON.stringify(body, null, "\t"), "utf8");
}

// ── adapters Map 操作 ──────────────────────────────────────────────────────

function adaptersMap(ctx) {
	const map = ctx.llm?.adapters;
	if (!(map instanceof Map)) throw new Error("llm service exposes no adapters Map (host version changed?)");
	return map;
}

/** 当前全部 provider 元数据（含已被摘下的）。 */
function listAll(ctx, state) {
	const live = [];
	for (const [id, reg] of adaptersMap(ctx)) {
		live.push({
			provider: id,
			name: reg?.provider?.name ?? id,
			disabled: false,
			disabledModels: (state.disabledModels[id] ?? []).length,
		});
	}
	for (const id of state.disabledProviders) {
		if (!live.some((x) => x.provider === id)) {
			const entry = state.entries.get(id);
			live.push({
				provider: id,
				name: entry?.provider?.name ?? id,
				disabled: true,
				disabledModels: (state.disabledModels[id] ?? []).length,
			});
		}
	}
	live.sort((a, b) => a.provider.localeCompare(b.provider));
	return live;
}

/** 某 provider 的模型清单（含禁用状态）。provider 被摘下时从快照的 adapter 上取。 */
async function listModelsOf(ctx, state, provider) {
	const registration = adaptersMap(ctx).get(provider) ?? state.entries.get(provider);
	if (!registration) throw new Error(`provider "${provider}" is not registered`);
	const adapter = registration.adapter;
	if (typeof adapter?.listModels !== "function") throw new Error(`provider "${provider}" adapter has no listModels`);
	const models = await adapter.listModels(provider);
	const disabled = new Set(state.disabledModels[provider] ?? []);
	return (Array.isArray(models) ? models : [])
		.map((m) => ({ model: m.id, name: m.name, disabled: disabled.has(m.id) }))
		.sort((a, b) => a.model.localeCompare(b.model));
}

/** 摘下一个 provider 的 entry（禁用）。 */
function take(ctx, provider) {
	const map = adaptersMap(ctx);
	const entry = map.get(provider);
	if (entry === undefined) throw new Error(`provider "${provider}" is not registered`);
	map.delete(provider);
	return entry;
}

/** 放回一个 provider 的 entry（启用）。 */
function give(ctx, provider, entry) {
	const map = adaptersMap(ctx);
	if (map.has(provider)) throw new Error(`provider "${provider}" is already registered`);
	map.set(provider, entry);
}

/**
 * 广播 llm/adapters-updated，让客户端模型目录重新拉取。
 * 链路：本 dispatch → cordis _hooks → api-remotes 的转发 listener（该事件在
 * API_REMOTE_FORWARDED_EVENTS 白名单）→ typertGateway → client `remote.$on`
 * → `catalog.refresh()`。事件通道不可用只影响自动刷新，不影响禁用本身。
 */
function announce(ctx) {
	try {
		// 不走 inject("events")：events 是 cordis Context 固有属性，运行期
		// ctx.events 直接可用；inject 它反而会 pending 在 waiting-for-service。
		const events = ctx.get?.("events") ?? ctx.events;
		events?.dispatch?.("emit", ["llm/adapters-updated"]);
	} catch (error) {
		log(`announce failed (selector may need manual refresh): ${error?.message ?? error}`);
	}
}

// ── 模型级禁用：runtime 实例方法 override ──────────────────────────────────

function modelDisabled(state, provider, model) {
	return (state.disabledModels[provider] ?? []).includes(model);
}

/**
 * 对 LlmRuntime 实例做三个方法的实例级 override（只碰自己的实例，不动
 * prototype、不碰任何插件对象）。原方法保存到 install 标记里，重复 apply
 * （插件重载）时不会叠层 wrap。
 */
function installModelGate(ctx, state) {
	const runtime = ctx.llm;
	if (typeof runtime !== "object" || runtime === null) throw new Error("ctx.llm is not an object");

	// 重载保护：若已装过（fiber 重启会拿到全新 runtime 实例；同一实例重复
	// apply 只可能发生在同 fiber 重载），先还原。
	if (runtime.__providerGateOriginal) {
		const orig = runtime.__providerGateOriginal;
		runtime.listModels = orig.listModels;
		runtime.resolveModelInfo = orig.resolveModelInfo;
		runtime.streamWithRegistration = orig.streamWithRegistration;
		runtime.__providerGateOriginal = undefined;
	}
	const original = {
		listModels: runtime.listModels,
		resolveModelInfo: runtime.resolveModelInfo,
		streamWithRegistration: runtime.streamWithRegistration,
	};
	runtime.__providerGateOriginal = original;

	// 1) 目录：listModels 过滤被禁模型 —— buildModelCatalog 走这里，
	//    选择器目录即时少一行。
	runtime.listModels = async function (provider) {
		const models = await original.listModels.call(this, provider);
		const disabled = state.disabledModels[provider];
		if (!disabled || disabled.length === 0) return models;
		return models.filter((m) => !disabled.includes(m.id));
	};

	// 2) 精确元信息：被禁模型直接抛（用户手选了一个已禁的 id 时给出明确错误）。
	runtime.resolveModelInfo = async function (provider, model, signal) {
		if (modelDisabled(state, provider, model)) {
			const err = new Error(`model "${provider}/${model}" is disabled by dsh-provider-gate`);
			err.code = "MODEL_DISABLED";
			throw err;
		}
		return original.resolveModelInfo.call(this, provider, model, signal);
	};

	// 3) 请求：最终入口 streamWithRegistration 的 options 里有 provider/model。
	//    在进 adapterStream 之前抛，轮次以错误结束（不会回退到别的模型）。
	runtime.streamWithRegistration = function (options, prepared) {
		const provider = options?.provider;
		const model = options?.model;
		if (typeof provider === "string" && typeof model === "string" && modelDisabled(state, provider, model)) {
			const err = new Error(`model "${provider}/${model}" is disabled by dsh-provider-gate`);
			err.code = "MODEL_DISABLED";
			throw err;
		}
		return original.streamWithRegistration.call(this, options, prepared);
	};

	log("model gate installed (listModels / resolveModelInfo / streamWithRegistration)");
}

// ── HTTP ───────────────────────────────────────────────────────────────────

function reply(res, status, body) {
	const payload = JSON.stringify(body ?? {});
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
		"Access-Control-Allow-Origin": "*",
	});
	res.end(payload);
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > MAX_BODY) throw new Error("request body too large");
		chunks.push(c);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	return JSON.parse(text);
}

function createHandler(ctx, state) {
	return async function handler(req, res) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const route = url.pathname.replace(/\/+$/, "") || ROUTE;
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			});
			res.end();
			return;
		}
		try {
			if ((req.method === "GET" || req.method === "HEAD") && (route === ROUTE || route === `${ROUTE}/health`)) {
				reply(res, 200, { ok: true, name, version: VERSION });
				return;
			}
			if ((req.method === "GET" || req.method === "HEAD") && route === `${ROUTE}/providers`) {
				reply(res, 200, { ok: true, providers: listAll(ctx, state) });
				return;
			}
			// GET /models/<provider>
			if ((req.method === "GET" || req.method === "HEAD") && route.startsWith(`${ROUTE}/models/`)) {
				const provider = decodeURIComponent(route.slice(`${ROUTE}/models/`.length));
				reply(res, 200, { ok: true, provider, models: await listModelsOf(ctx, state, provider) });
				return;
			}
			if (req.method === "POST" && route === `${ROUTE}/toggle`) {
				const body = await readBody(req);
				const provider = String(body.provider ?? "");
				const disabled = Boolean(body.disabled);
				if (provider === "") throw new Error("field `provider` is required");
				const map = adaptersMap(ctx);
				if (disabled) {
					const entry = take(ctx, provider);
					state.entries.set(provider, entry);
					if (!state.disabledProviders.includes(provider)) state.disabledProviders.push(provider);
				} else {
					const entry = state.entries.get(provider);
					if (entry !== undefined) {
						give(ctx, provider, entry);
						state.entries.delete(provider);
					}
					state.disabledProviders = state.disabledProviders.filter((x) => x !== provider);
				}
				await saveState(state);
				announce(ctx);
				log(`${disabled ? "disabled" : "enabled"} provider "${provider}"`);
				reply(res, 200, { ok: true, providers: listAll(ctx, state) });
				return;
			}
			if (req.method === "POST" && route === `${ROUTE}/bulk`) {
				const body = await readBody(req);
				const want = Array.isArray(body.disabled) ? body.disabled.filter((x) => typeof x === "string") : null;
				if (want === null) throw new Error("field `disabled` (string[]) is required");
				const map = adaptersMap(ctx);
				for (const id of want) {
					if (map.has(id)) {
						state.entries.set(id, take(ctx, id));
						if (!state.disabledProviders.includes(id)) state.disabledProviders.push(id);
					}
				}
				for (const [id, entry] of [...state.entries]) {
					if (!want.includes(id)) {
						give(ctx, id, entry);
						state.entries.delete(id);
					}
				}
				state.disabledProviders = want;
				await saveState(state);
				announce(ctx);
				log(`bulk → disabled=[${want.join(", ")}]`);
				reply(res, 200, { ok: true, providers: listAll(ctx, state) });
				return;
			}
			if (req.method === "POST" && route === `${ROUTE}/toggle-model`) {
				const body = await readBody(req);
				const provider = String(body.provider ?? "");
				const model = String(body.model ?? "");
				const disabled = Boolean(body.disabled);
				if (provider === "" || model === "") throw new Error("fields `provider` and `model` are required");
				const current = new Set(state.disabledModels[provider] ?? []);
				if (disabled) current.add(model);
				else current.delete(model);
				if (current.size === 0) delete state.disabledModels[provider];
				else state.disabledModels[provider] = [...current];
				await saveState(state);
				announce(ctx);
				log(`${disabled ? "disabled" : "enabled"} model "${provider}/${model}"`);
				reply(res, 200, {
					ok: true,
					provider,
					models: await listModelsOf(ctx, state, provider),
				});
				return;
			}
			if (req.method === "POST" && route === `${ROUTE}/bulk-models`) {
				const body = await readBody(req);
				const provider = String(body.provider ?? "");
				if (provider === "") throw new Error("field `provider` is required");
				const want = Array.isArray(body.models) ? body.models.filter((x) => typeof x === "string") : null;
				if (want === null) throw new Error("field `models` (string[]) is required");
				if (want.length === 0) delete state.disabledModels[provider];
				else state.disabledModels[provider] = want;
				await saveState(state);
				announce(ctx);
				log(`bulk-models "${provider}" → disabled=[${want.join(", ")}]`);
				reply(res, 200, { ok: true, provider, models: await listModelsOf(ctx, state, provider) });
				return;
			}
			reply(res, 404, { ok: false, error: `no route ${req.method} ${route}` });
		} catch (error) {
			reply(res, 400, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

// ── 启动时恢复 + apply ─────────────────────────────────────────────────────

export function apply(ctx) {
	const state = {
		disabledProviders: [],
		disabledModels: {},
		entries: new Map(), // provider id → 摘下的 registration 快照
	};

	// 模型门：立刻装（不依赖任何 provider 插件的注册时序）。
	installModelGate(ctx, state);

	// 启动时按落盘清单重放禁用。时序：本插件 apply 时其他 provider 插件可能
	// 尚未注册完，所以重放分两段：立即摘已注册的；2s 轮询补摘晚注册的
	// （60s 上限）。请求侧永远查不到被摘的 provider（NO_ADAPTER），轮询只是
	// 让选择器那几秒别闪现。
	async function replay() {
		const loaded = await loadState();
		state.disabledProviders = loaded.disabledProviders;
		state.disabledModels = loaded.disabledModels;
		if (state.disabledProviders.length === 0) return;
		const map = adaptersMap(ctx);
		for (const id of [...state.disabledProviders]) {
			if (map.has(id)) {
				state.entries.set(id, take(ctx, id));
				log(`replay: disabled provider "${id}"`);
			}
		}
		// state.disabledProviders 保持完整禁用集（已摘的 + 尚未注册上的）。
	}
	function watchLatecomers() {
		if (state.disabledProviders.length === 0) return;
		let elapsed = 0;
		const timer = setInterval(() => {
			elapsed += 2000;
			try {
				const map = adaptersMap(ctx);
				for (const id of [...state.disabledProviders]) {
					if (map.has(id)) {
						state.entries.set(id, take(ctx, id));
						log(`replay(late): disabled provider "${id}"`);
					}
				}
				if (state.entries.size >= state.disabledProviders.length || elapsed >= 60000) clearInterval(timer);
			} catch (error) {
				clearInterval(timer);
				log(`watchLatecomers stopped: ${error?.message ?? error}`);
			}
		}, 2000);
		ctx.effect(() => () => clearInterval(timer));
	}

	ctx.inject(["webServer"], (wctx) => {
		wctx.webServer.register({
			kind: "prefix",
			path: ROUTE,
			handler: createHandler(ctx, state),
		});
	});

	replay()
		.then(() => watchLatecomers())
		.catch((error) => log(`replay failed: ${error?.message ?? error}`));

	log(`host half mounted; route=${ROUTE} · state=${STATE_DIR}`);
}
