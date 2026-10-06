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
			// 全部规则以 #dsh-provider-gate 开头做作用域，避免误伤官方 UI。
			// token 全部按 app.asar 官方定义核验（grep 定义处 >0 才用）：
			//   文字 label-{primary,secondary,tertiary} · 危险 state-error-{primary,secondary}
			//   边 border-{l1,l2} · 底 bg-base / specific-menu · 圆角 radius-{md,lg}
			//   描边进阴影 elevation-stroke-color + elevation-prominent（不写 border）
			//   字号 font:var(--dsw-font-xs-13)（简写型，不散装 font-size/line-height）
			//   开关完全照抄官方 primitives Switch.module.css：36×20 / thumb 16 /
			//   padding 2 / translateX(16px) / off=border-l3 on=brand-primary /
			//   transition 120ms ease / 禁用 opacity:.5
			el.textContent = `
#dsh-provider-gate { display:flex; flex-direction:column; gap:12px; font:var(--dsw-font-xs-13); color:var(--dsw-alias-label-primary); }
#dsh-provider-gate .pg-note { color:var(--dsw-alias-label-secondary); line-height:1.6; }
#dsh-provider-gate .pg-summary { display:flex; align-items:center; gap:8px; }
#dsh-provider-gate .pg-badge { display:inline-block; padding:1px 8px; border-radius:999px; font:var(--dsw-font-xxs-12); background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-secondary); }
#dsh-provider-gate .pg-badge-off { background:var(--dsw-alias-interactive-bg-hover-danger); color:var(--dsw-alias-state-error-primary); }
#dsh-provider-gate .pg-list { display:flex; flex-direction:column; border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-base); overflow:hidden; --dsw-elevation-stroke-color:var(--dsw-alias-border-l1); box-shadow:var(--dsw-elevation-stroke), var(--dsw-elevation-prominent); }
#dsh-provider-gate .pg-row { display:flex; align-items:center; gap:10px; padding:8px 12px; }
#dsh-provider-gate .pg-row + .pg-row { border-top:.5px solid var(--dsw-alias-border-l2); }
#dsh-provider-gate .pg-row .pg-id { font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
#dsh-provider-gate .pg-row .pg-name { color:var(--dsw-alias-label-tertiary); font-size:12px; flex:1; }
#dsh-provider-gate .pg-row.pg-disabled .pg-id, #dsh-provider-gate .pg-row.pg-disabled .pg-name { opacity:.55; text-decoration:line-through; }
#dsh-provider-gate .pg-switch { appearance:none; box-sizing:border-box; position:relative; flex:0 0 auto; width:36px; height:20px; padding:2px; border:0; border-radius:999px; background:var(--dsw-alias-border-l3); cursor:pointer; transition:background 120ms ease; }
#dsh-provider-gate .pg-switch::after { content:""; display:block; width:16px; height:16px; border-radius:50%; background:var(--dsw-alias-switch-thumb, var(--dsw-alias-label-primary-foreground)); transition:transform 120ms ease; }
#dsh-provider-gate .pg-switch:checked { background:var(--dsw-alias-brand-primary); }
#dsh-provider-gate .pg-switch:checked::after { background:var(--dsw-alias-label-primary-foreground); transform:translateX(16px); }
#dsh-provider-gate .pg-switch:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:2px; }
#dsh-provider-gate .pg-switch:disabled { cursor:default; opacity:.5; }
#dsh-provider-gate .pg-err { color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; }
#dsh-provider-gate .pg-foot { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.6; }
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
