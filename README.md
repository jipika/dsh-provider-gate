<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-provider-gate icon">
</div>

# dsh-provider-gate

供应商开关：把 DSH 里全部 provider 路由（自己手写的 + 其他插件注入的）列出来逐个禁用/启用，禁用后模型选择器不再出现该供应商，重启后清单保持。

## 入口

设置 → 内置插件 → 本插件行 → 「供应商开关」tab。

## 原理

host 半边直接操作 `llm` 服务实例上的 `adapters` Map（LlmRuntime 的唯一注册表）：

- 禁用 = 把 entry 从 Map 摘下、存进内存快照 + 落盘 `~/.dsh/state/provider-gate/disabled.json`
- 启用 = 从快照放回 Map
- `listProviders()`、模型选择器目录（`modelCatalog`）、请求分发（`registration()`）都查这张 Map，所以三处行为自动一致
- 零 patch 上游插件，官方 `llm-pi-ai` / 各注入插件完全不动

## 路由

- `GET  /dsh-provider-gate/health`   探活
- `GET  /dsh-provider-gate/providers` 列表（含禁用状态）
- `POST /dsh-provider-gate/toggle`   `{provider, disabled}`
- `POST /dsh-provider-gate/bulk`     `{disabled: string[]}`

## 已知边界

- **本插件的路由在网关鉴权之外**（实测 desktop 上无 token 可直接访问 `/dsh-provider-gate/*`，与 dsh-writing-style 同一挂载机制）。它只走回环（webServer prefix 通道），外网摸不到；但本机任意本地进程都能改禁用清单，介意的话不要把端口暴露出去。
- 启动重放用 2s 轮询补摘晚注册的 provider（60s 上限），启动后头几秒被禁用的供应商可能在选择器里闪现一下，请求侧则始终拦得住。
- 禁用过程中若有会话正在用该 provider 发请求，该请求会以 `NO_ADAPTER` 报错结束（不会回退到别的 provider）。
- 宿主大版本升级后若 `adapters` 不是 Map（结构变了），插件会报错而不是静默不工作。
