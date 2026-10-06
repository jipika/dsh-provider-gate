// dsh-provider-gate — host 半边
//
// 做什么：把当前 DSH 里全部 provider 路由（llm-pi-ai 手写的 + 其他插件注入的
// codex-subscription / qoder-connect / workbuddy 系列等）列出来，逐个禁用/启用。
//
// 原理（来自 app.asar 中 @deepseek-ai/dsh-llm 的 LlmRuntime 源码）：
//   · 所有 provider 都注册在 llm 服务实例的 `adapters` Map 上；
//   · `listProviders()` = [...this.adapters.values()]，
//     模型选择器目录（session-controller 的 buildModelCatalog）也调它；
//   · 请求分发 `registration(provider)` 查不到就抛 NO_ADAPTER。
//   所以「禁用 = 把 entry 从 Map 摘下存进快照，启用 = 放回去」一个动作即可让
//   选择器、目录、请求三处行为一致，无需 wrap 任何方法、零 patch 上游插件。
//
// 路由（prefix /dsh-provider-gate，挂宿主 webServer，走 dsh-app:// 转发）：
//   GET  /providers   列表（含禁用状态与当前可见性）
//   POST /toggle      { provider, disabled: boolean }
//   POST /bulk        { disabled: string[] } 整体覆写
//   GET  /health      探活
//
// 禁用清单持久化在 state/provider-gate/disabled.json（独立文件，不碰
// settings.json，避免与官方 settings 写入路径互相踩）。

export const name = "dsh-provider-gate";

// 摘/还 entry 都要碰 ctx.llm（LlmRuntime 实例）。cordis 对未注入服务的属性
// 访问直接抛 `cannot get property "llm" without inject`（dsh-btw 实测），
// 所以必须声明在这里。
export const inject = ["llm"];

const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");
const fsp = process.getBuiltinModule("node:fs/promises");

const ROUTE = "/dsh-provider-gate";
const VERSION = "0.1.0";
const HOME =
	typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
		? process.env.DSH_HOME
		: path.join(os.homedir(), ".dsh");
const STATE_DIR = path.join(HOME, "state", "provider-gate");
const DISABLED_FILE = path.join(STATE_DIR, "disabled.json");
const MAX_BODY = 64 * 1024;

const log = (...a) => console.log("[dsh-provider-gate]", ...a);

// ── 禁用清单持久化 ─────────────────────────────────────────────────────────

async function loadDisabled() {
	try {
		const text = await fsp.readFile(DISABLED_FILE, "utf8");
		const arr = JSON.parse(text);
		return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

async function saveDisabled(list) {
	await fsp.mkdir(STATE_DIR, { recursive: true });
	await fsp.writeFile(DISABLED_FILE, JSON.stringify(list, null, "\t"), "utf8");
}

// ── adapters Map 操作（核心） ──────────────────────────────────────────────

/**
 * 取 llm 服务实例上的 adapters Map。
 * ctx.llm 是 LlmRuntime 实例，其类字段 `adapters` 是普通 Map（源码 1800 行附近：
 * `adapters = new Map()`）。
 */
function adaptersMap(ctx) {
	const map = ctx.llm?.adapters;
	if (!(map instanceof Map)) throw new Error("llm service exposes no adapters Map (host version changed?)");
	return map;
}

/** 当前全部 provider 元数据（含已被摘下的）。 */
function listAll(ctx, disabledList, disabledEntries) {
	const live = [];
	for (const [id, reg] of adaptersMap(ctx)) {
		live.push({
			provider: id,
			name: reg?.provider?.name ?? id,
			disabled: false,
			// 该 provider 是否有禁用快照（曾禁用过又启用 → 快照已还原，无条目）
		});
	}
	for (const id of disabledList) {
		if (!live.some((x) => x.provider === id)) {
			const entry = disabledEntries.get(id);
			live.push({
				provider: id,
				name: entry?.provider?.name ?? id,
				disabled: true,
			});
		}
	}
	live.sort((a, b) => a.provider.localeCompare(b.provider));
	return live;
}

/** 摘下一个 provider 的 entry（禁用）。 */
function take(ctx, provider) {
	const map = adaptersMap(ctx);
	const entry = map.get(provider);
	if (entry === undefined) throw new Error(`provider "${provider}" is not registered`);
	map.delete(provider);
	announce(ctx);
	return entry;
}

/** 放回一个 provider 的 entry（启用）。 */
function give(ctx, provider, entry) {
	const map = adaptersMap(ctx);
	if (map.has(provider)) throw new Error(`provider "${provider}" is already registered`);
	map.set(provider, entry);
	announce(ctx);
}

/**
 * 广播 llm/adapters-updated，让客户端模型目录重新拉取
 * （dsh-client-ui-model-selection 监听该事件后 catalog.refresh()）。
 * dispatch 的确切签名按宿主版本可能变化，所以整段 try/catch：
 * 事件通道不可用时降级为「用户重开选择器才刷新」，不影响禁用本身。
 */
function announce(ctx) {
	try {
		// 不走 inject("events")：在 0.2.0-rc.2 上 events 是按需服务、inject 它会
		// 让本插件 pending 在 waiting-for-service 上永不激活。改为运行期按需取
		// （事件通道不可用只影响选择器自动刷新，不影响禁用本身）。
		const events = ctx.get?.("events") ?? ctx.events;
		events?.dispatch?.("emit", ["llm/adapters-updated"]);
	} catch (error) {
		log(`announce failed (selector may need manual refresh): ${error?.message ?? error}`);
	}
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
				reply(res, 200, { ok: true, providers: listAll(ctx, state.disabled, state.entries) });
				return;
			}
			if (req.method === "POST" && route === `${ROUTE}/toggle`) {
				const body = await readBody(req);
				const provider = String(body.provider ?? "");
				const disabled = Boolean(body.disabled);
				if (provider === "") throw new Error("field `provider` is required");
				const map = adaptersMap(ctx);
				if (disabled) {
					// 禁用：摘 entry + 记快照 + 落盘
					const entry = take(ctx, provider);
					state.entries.set(provider, entry);
					if (!state.disabled.includes(provider)) state.disabled.push(provider);
					await saveDisabled(state.disabled);
					log(`disabled "${provider}"`);
				} else {
					// 启用：放回 entry + 清记录 + 落盘
					const entry = state.entries.get(provider);
					if (entry !== undefined) {
						give(ctx, provider, entry);
						state.entries.delete(provider);
					}
					state.disabled = state.disabled.filter((x) => x !== provider);
					await saveDisabled(state.disabled);
					log(`enabled "${provider}"`);
				}
				reply(res, 200, { ok: true, providers: listAll(ctx, state.disabled, state.entries) });
				return;
			}
			if (req.method === "POST" && route === `${ROUTE}/bulk`) {
				const body = await readBody(req);
				const want = Array.isArray(body.disabled) ? body.disabled.filter((x) => typeof x === "string") : null;
				if (want === null) throw new Error("field `disabled` (string[]) is required");
				const map = adaptersMap(ctx);
				// 先摘：当前活着但要禁用的
				for (const id of want) {
					if (map.has(id)) {
						state.entries.set(id, take(ctx, id));
						if (!state.disabled.includes(id)) state.disabled.push(id);
					}
				}
				// 再还：快照里有但不在目标清单里的
				for (const [id, entry] of [...state.entries]) {
					if (!want.includes(id)) {
						give(ctx, id, entry);
						state.entries.delete(id);
					}
				}
				state.disabled = want;
				await saveDisabled(state.disabled);
				log(`bulk → disabled=[${want.join(", ")}]`);
				reply(res, 200, { ok: true, providers: listAll(ctx, state.disabled, state.entries) });
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
	const state = { disabled: [], entries: new Map() };

	// 启动时按落盘清单重放禁用。注意时序：本插件 apply 时，其他 provider 插件
	// 可能尚未注册完（cordis 按依赖图激活）。所以「恢复」分两段：
	//   1) 立即摘已经注册上的；
	//   2) 监听 adapters Map 的后续变化——但 Map 本身没有事件，改用轮询
	//      （间隔 2s，总共 60s；覆盖正常启动窗口，之后停止避免常驻开销）。
	// 更稳的兜底：请求侧永远查不到被摘的 provider（NO_ADAPTER），所以即使
	// 重放漏了某个晚注册的 provider，它也只是「多活了几秒」而不是「漏禁」。
	// 但模型选择器那几秒会闪现，所以轮询还是值得做。
	async function replay() {
		state.disabled = await loadDisabled();
		if (state.disabled.length === 0) return;
		const map = adaptersMap(ctx);
		for (const id of [...state.disabled]) {
			if (map.has(id)) {
				state.entries.set(id, take(ctx, id));
				log(`replay: disabled "${id}"`);
			}
		}
		// state.disabled 保持完整禁用集（已摘的 + 尚未注册上的），
		// listAll 与 UI 以它为准；没摘上的交给 watchLatecomers 补摘。
	}
	function watchLatecomers() {
		if (state.disabled.length === 0) return;
		let elapsed = 0;
		const timer = setInterval(() => {
			elapsed += 2000;
			try {
				const map = adaptersMap(ctx);
				for (const id of [...state.disabled]) {
					if (map.has(id)) {
						state.entries.set(id, take(ctx, id));
						log(`replay(late): disabled "${id}"`);
					}
				}
				// 全部摘完即停（entries.size === disabled.length）
				if (state.entries.size >= state.disabled.length || elapsed >= 60000) clearInterval(timer);
			} catch (error) {
				// fiber 可能已 teardown，别让 interval 抛错
				clearInterval(timer);
				log(`watchLatecomers stopped: ${error?.message ?? error}`);
			}
		}, 2000);
		// fiber 卸载时清掉 interval
		ctx.effect(() => () => clearInterval(timer));
	}

	ctx.inject(["webServer"], (wctx) => {
		wctx.webServer.register({
			kind: "prefix",
			path: ROUTE,
			handler: createHandler(ctx, state),
		});
	});

	// replay 依赖 webServer 不依赖——直接跑即可。adapters Map 在 apply 期可能
	// 还空着（各 provider 插件尚未 apply），watchLatecomers 兜底。
	replay()
		.then(() => watchLatecomers())
		.catch((error) => log(`replay failed: ${error?.message ?? error}`));

	log(`host half mounted; route=${ROUTE} · state=${STATE_DIR}`);
}
