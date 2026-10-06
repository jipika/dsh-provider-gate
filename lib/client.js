// dsh-provider-gate — client 半边（设置 → 插件 → 本插件 tab）
//
// 挂载点：slot `settings.plugins.tab`，**id 必须等于插件包名** —— 宿主在
// 「设置 → 插件」页按插件清单行的 id 用 { only: row.id } 过滤渲染 tab，
// 写成别的字符串会落在永远不会被渲染的行上（点开空白）。
//
// 页面：
//   · 供应商列表（含禁用中的），每行一个开关 —— 禁用后模型选择器整组消失；
//   · 每行可展开：列出该供应商的所有模型，逐模型开关 —— 单独隐藏某个模型；
//   · 变更立即生效（host 广播 llm/adapters-updated，打开着的选择器自动刷新）；
//   · 清单在重启后保持。
//
// token 全部按 app.asar 官方定义核验（grep 定义处 >0 才用）：
//   文字 label-{primary,secondary,tertiary} · 危险 state-error-primary
//   边 border-{l1,l2,l3} · 底 bg-base · 圆角 radius-{md,lg}
//   描边进阴影 elevation-stroke-color + elevation-prominent（不写 border）
//   字号 font token 简写 · 开关逐字照抄官方 primitives Switch.module.css

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
#dsh-provider-gate .pg-caret { appearance:none; background:none; border:none; color:var(--dsw-alias-label-tertiary); cursor:pointer; padding:0 2px; font-size:11px; line-height:1; flex:none; width:18px; }
#dsh-provider-gate .pg-caret:hover { color:var(--dsw-alias-label-primary); }
#dsh-provider-gate .pg-caret:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:2px; border-radius:var(--dsw-radius-xs); }
#dsh-provider-gate .pg-models { padding:2px 12px 10px 40px; display:flex; flex-direction:column; gap:2px; }
#dsh-provider-gate .pg-models .pg-mrow { display:flex; align-items:center; gap:10px; padding:3px 0; }
#dsh-provider-gate .pg-models .pg-mid { font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#dsh-provider-gate .pg-models .pg-mrow.pg-mdisabled .pg-mid { opacity:.55; text-decoration:line-through; }
#dsh-provider-gate .pg-models .pg-mnote { color:var(--dsw-alias-label-tertiary); font-size:12px; }
#dsh-provider-gate .pg-switch { appearance:none; box-sizing:border-box; position:relative; flex:0 0 auto; width:36px; height:20px; padding:2px; border:0; border-radius:999px; background:var(--dsw-alias-border-l3); cursor:pointer; transition:background 120ms ease; }
#dsh-provider-gate .pg-switch::after { content:""; display:block; width:16px; height:16px; border-radius:50%; background:var(--dsw-alias-switch-thumb, var(--dsw-alias-label-primary-foreground)); transition:transform 120ms ease; }
#dsh-provider-gate .pg-switch:checked { background:var(--dsw-alias-brand-primary); }
#dsh-provider-gate .pg-switch:checked::after { background:var(--dsw-alias-label-primary-foreground); transform:translateX(16px); }
#dsh-provider-gate .pg-switch:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:2px; }
#dsh-provider-gate .pg-switch:disabled { cursor:default; opacity:.5; }
#dsh-provider-gate .pg-switch.pg-switch-sm { width:28px; height:16px; padding:2px; }
#dsh-provider-gate .pg-switch.pg-switch-sm::after { width:12px; height:12px; }
#dsh-provider-gate .pg-switch.pg-switch-sm:checked::after { transform:translateX(12px); }
#dsh-provider-gate .pg-err { color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; }
#dsh-provider-gate .pg-foot { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.6; }
`;
			document.head.appendChild(el);
		}

		/** 单个模型行：小开关 + 模型 id。 */
		function ModelRow(props) {
			const { provider, m, busy, onToggleModel } = props;
			return h(
				"div",
				{ className: `pg-mrow${m.disabled ? " pg-mdisabled" : ""}` },
				h("input", {
					className: "pg-switch pg-switch-sm",
					type: "checkbox",
					checked: !m.disabled,
					disabled: busy,
					onChange: () => onToggleModel(provider, m.model, !m.disabled),
					title: m.disabled ? "点击启用该模型" : "点击禁用该模型",
				}),
				h("span", { className: "pg-mid", title: m.model }, m.model),
			);
		}

		/** 单个 provider 行：主开关 + 展开箭头 + （展开时）模型清单。 */
		function ProviderRow(props) {
			const { p, busy, onToggle, expanded, onExpand, models, modelsError, modelsLoading, onToggleModel } = props;
			const caret = expanded ? "▾" : "▸";
			return h(
				"div",
				{ key: p.provider },
				h(
					"div",
					{ className: `pg-row${p.disabled ? " pg-disabled" : ""}` },
					h(
						"button",
						{
							className: "pg-caret",
							disabled: p.disabled,
							onClick: () => onExpand(p.provider),
							title: p.disabled ? "供应商已禁用" : expanded ? "收起模型清单" : "展开模型清单（可单独隐藏某个模型）",
							"aria-expanded": expanded,
						},
						caret,
					),
					h("input", {
						className: "pg-switch",
						type: "checkbox",
						checked: !p.disabled,
						disabled: busy,
						onChange: () => onToggle(p.provider, !p.disabled),
						title: p.disabled ? "点击启用" : "点击禁用",
					}),
					h("span", { className: "pg-id" }, p.provider),
					h(
						"span",
						{ className: "pg-name" },
						(p.name ?? "") + (p.disabledModels > 0 ? ` · 隐藏 ${p.disabledModels} 个模型` : ""),
					),
				),
				expanded &&
					!p.disabled &&
					h(
						"div",
						{ className: "pg-models" },
						modelsLoading && h("div", { className: "pg-mnote" }, "加载模型…"),
						modelsError !== "" && h("div", { className: "pg-mnote" }, modelsError),
						models !== null &&
							models.map((m) => h(ModelRow, { key: m.model, provider: p.provider, m, busy, onToggleModel })),
						models !== null && models.length === 0 && h("div", { className: "pg-mnote" }, "该供应商没有暴露模型清单"),
					),
			);
		}

		function Panel() {
			const [providers, setProviders] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const [expanded, setExpanded] = useState(null); // provider id
			const [models, setModels] = useState(null); // 展开行的模型清单
			const [modelsError, setModelsError] = useState("");
			const [modelsLoading, setModelsLoading] = useState(false);

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

			const onExpand = useCallback(
				async (provider) => {
					if (expanded === provider) {
						setExpanded(null);
						setModels(null);
						return;
					}
					setExpanded(provider);
					setModels(null);
					setModelsError("");
					setModelsLoading(true);
					try {
						const json = await api("GET", `/models/${encodeURIComponent(provider)}`);
						setModels(json.models ?? []);
					} catch (e) {
						setModelsError(String(e.message ?? e));
					} finally {
						setModelsLoading(false);
					}
				},
				[expanded],
			);

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

			const onToggleModel = useCallback(
				async (provider, model, disabled) => {
					setBusy(true);
					try {
						const json = await api("POST", "/toggle-model", { provider, model, disabled });
						setModels(json.models ?? []);
						setError("");
						refresh();
					} catch (e) {
						setError(String(e.message ?? e));
					} finally {
						setBusy(false);
					}
				},
				[refresh],
			);

			const providersList = providers ?? [];
			const disabledCount = providersList.filter((p) => p.disabled).length;
			const hiddenModels = providersList.reduce((n, p) => n + (p.disabledModels || 0), 0);

			return h(
				"div",
				{ id: "dsh-provider-gate" },
				h(
					"div",
					{ className: "pg-summary" },
					h("strong", null, "供应商开关"),
					h(
						"span",
						{ className: `pg-badge${disabledCount > 0 || hiddenModels > 0 ? " pg-badge-off" : ""}` },
						`${providersList.length || "…"} 个供应商 · 禁用 ${disabledCount} · 隐藏模型 ${hiddenModels}`,
					),
				),
				h(
					"div",
					{ className: "pg-note" },
					"开关立即生效（无需重启，打开着的选择器会自动刷新）：禁用供应商 = 选择器整组消失；点 ▸ 展开可单独隐藏某个模型。清单在重启后保持。",
				),
				error !== "" && h("div", { className: "pg-err" }, error),
				providers === null
					? h("div", { className: "pg-note" }, "加载中…")
					: h(
							"div",
							{ className: "pg-list" },
							providersList.map((p) =>
								h(ProviderRow, {
									key: p.provider,
									p,
									busy,
									onToggle,
									expanded: expanded === p.provider,
									onExpand,
									models: expanded === p.provider ? models : null,
									modelsError: expanded === p.provider ? modelsError : "",
									modelsLoading: expanded === p.provider ? modelsLoading : false,
									onToggleModel,
								}),
							),
							providersList.length === 0 && h("div", { className: "pg-row pg-note" }, "没有发现任何已注册的供应商"),
						),
				h(
					"div",
					{ className: "pg-foot" },
					"覆盖所有 provider 路由：包括你在配置里手写的，以及其他插件（Codex 订阅、Qoder、WorkBuddy 等）注入的。被隐藏的模型若正被会话使用，该轮会以 MODEL_DISABLED 报错结束。",
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
