// dsh-provider-gate — client 半边（设置 → 插件 → 本插件 tab）
//
// 挂载点：slot `settings.plugins.tab`，**id 必须等于插件包名** —— 宿主在
// 「设置 → 插件」页按插件清单行的 id 用 { only: row.id } 过滤渲染 tab，
// 写成别的字符串会落在永远不会被渲染的行上（点开空白）。
//
// 页面：供应商列表（含禁用中的），每行一个开关；顶部显示禁用数量；
// 底部说明禁用 = 模型选择器不再出现该供应商、请求直接 NO_ADAPTER。

window.__ModuleLoader__.load({
	id: "dsh-provider-gate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useCallback } = React;

		const API = "/dsh-provider-gate";
		const STYLE_ID = "dsh-provider-gate-css";

		async function api(method, suffix, body) {
			const res = await fetch(API + suffix, {
				method,
				headers: body === undefined ? undefined : { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await res.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				throw new Error(`${method} ${suffix} → ${res.status}: ${text.slice(0, 200)}`);
			}
			if (!res.ok || json.ok === false) throw new Error(json.error ?? `${method} ${suffix} → ${res.status}`);
			return json;
		}

		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const el = document.createElement("style");
			el.id = STYLE_ID;
			// 全部规则都以 #dsh-provider-gate 开头做作用域，避免误伤官方 UI
			el.textContent = `
#dsh-provider-gate { display:flex; flex-direction:column; gap:12px; font-size:13px; }
#dsh-provider-gate .pg-note { color: var(--dsw-alias-text-secondary, #888); line-height:1.6; }
#dsh-provider-gate .pg-summary { display:flex; align-items:center; gap:8px; }
#dsh-provider-gate .pg-badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; background:var(--dsw-alias-fill-secondary, rgba(127,127,127,.15)); }
#dsh-provider-gate .pg-badge-off { background:rgba(255,90,60,.18); color:var(--dsw-alias-text-danger, #d5422a); }
#dsh-provider-gate .pg-list { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); border-radius:10px; overflow:hidden; }
#dsh-provider-gate .pg-row { display:flex; align-items:center; gap:10px; padding:8px 12px; }
#dsh-provider-gate .pg-row + .pg-row { border-top:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18)); }
#dsh-provider-gate .pg-row .pg-id { font-family:ui-monospace,monospace; font-size:12px; }
#dsh-provider-gate .pg-row .pg-name { color:var(--dsw-alias-text-secondary, #888); font-size:12px; flex:1; }
#dsh-provider-gate .pg-row.pg-disabled .pg-id, #dsh-provider-gate .pg-row.pg-disabled .pg-name { opacity:.55; text-decoration:line-through; }
#dsh-provider-gate .pg-switch { appearance:none; width:34px; height:20px; border-radius:999px; background:var(--dsw-alias-fill-secondary, rgba(127,127,127,.3)); position:relative; cursor:pointer; transition:background .15s; outline:none; border:none; flex:none; }
#dsh-provider-gate .pg-switch::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform .15s; box-shadow:0 1px 2px rgba(0,0,0,.25); }
#dsh-provider-gate .pg-switch:checked { background:var(--dsw-alias-accent, #4f7cff); }
#dsh-provider-gate .pg-switch:checked::after { transform:translateX(14px); }
#dsh-provider-gate .pg-switch:disabled { opacity:.5; cursor:default; }
#dsh-provider-gate .pg-err { color:var(--dsw-alias-text-danger, #d5422a); white-space:pre-wrap; }
#dsh-provider-gate .pg-foot { color:var(--dsw-alias-text-secondary, #888); font-size:12px; line-height:1.6; }
`;
			document.head.appendChild(el);
		}

		function ProviderRow(props) {
			const { p, busy, onToggle } = props;
			return h(
				"div",
				{ className: `pg-row${p.disabled ? " pg-disabled" : ""}` },
				h("input", {
					className: "pg-switch",
					type: "checkbox",
					checked: !p.disabled,
					disabled: busy,
					onChange: () => onToggle(p.provider, !p.disabled),
					title: p.disabled ? "点击启用" : "点击禁用",
				}),
				h("span", { className: "pg-id" }, p.provider),
				h("span", { className: "pg-name" }, p.name ?? ""),
			);
		}

		function Panel() {
			const [providers, setProviders] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");

			const refresh = useCallback(async () => {
				try {
					const json = await api("GET", "/providers");
					setProviders(json.providers ?? []);
					setError("");
				} catch (e) {
					setError(String(e.message ?? e));
				}
			}, []);

			useEffect(() => {
				refresh();
				const timer = setInterval(refresh, 15000);
				return () => clearInterval(timer);
			}, [refresh]);

			const onToggle = useCallback(
				async (provider, disabled) => {
					setBusy(true);
					try {
						const json = await api("POST", "/toggle", { provider, disabled });
						setProviders(json.providers ?? []);
						setError("");
					} catch (e) {
						setError(String(e.message ?? e));
					} finally {
						setBusy(false);
					}
				},
				[],
			);

			const disabledCount = (providers ?? []).filter((p) => p.disabled).length;

			return h(
				"div",
				{ id: "dsh-provider-gate" },
				h(
					"div",
					{ className: "pg-summary" },
					h("strong", null, "供应商开关"),
					h("span", { className: `pg-badge${disabledCount > 0 ? " pg-badge-off" : ""}` }, `${providers?.length ?? "…"} 个供应商 · 禁用 ${disabledCount}`),
				),
				h(
					"div",
					{ className: "pg-note" },
					"开关立即生效（无需重启）：禁用后模型选择器不再出现该供应商的所有模型；重新启用即刻恢复。清单在重启后保持。",
				),
				error !== "" && h("div", { className: "pg-err" }, error),
				providers === null
					? h("div", { className: "pg-note" }, "加载中…")
					: h(
							"div",
							{ className: "pg-list" },
							providers.map((p) => h(ProviderRow, { key: p.provider, p, busy, onToggle })),
							providers.length === 0 && h("div", { className: "pg-row pg-note" }, "没有发现任何已注册的供应商"),
						),
				h(
					"div",
					{ className: "pg-foot" },
					"覆盖所有 provider 路由：包括你在配置里手写的，以及其他插件（Codex 订阅、Qoder、WorkBuddy 等）注入的。",
				),
			);
		}

		/** Browser half entry：挂到「设置 → 插件」本插件那一行的 tab 上。 */
		function apply(ctx) {
			ensureStyle();
			ctx.slots.inject("settings.plugins.tab", () =>
				ctx.slots.register(
					{
						name: "settings.plugins.tab",
						id: "dsh-provider-gate",
						order: 21,
						label: () => "供应商开关",
					},
					Panel,
				),
			);
		}

		exports.name = "dsh-provider-gate";
		exports.inject = ["slots"];
		exports.apply = apply;

		return module.exports;
	},
});
