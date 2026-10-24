# dsh-mini — 在任意网页里使用 DSH

[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-0B7285?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E20%20%7C%20%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![DSH profiles](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)

**安装插件：** `dsh plugin --profile web add github:bill9109/dsh-mini`

**在任意网页选中文字，让 DeepSeek Harness 改写或续写，再把结果原位写回页面。由 Cordis 插件（Host + Web UI）和一个独立的 Chrome 扩展组成。**

[English](README.md) | 中文

## 两个部分，分开安装

| 部分 | 目录 | 是什么 | 怎么安装 |
| --- | --- | --- | --- |
| Cordis 插件 | 仓库根目录（`src/`、`lib/`、`package.json`） | DSH bundle：本机回环 Host 接口，加上 设置 → 插件 里的配对卡片 | `dsh plugin`（见下） |
| Chrome 扩展 | [`chrome-extension/`](chrome-extension/) | Manifest V3 扩展：选区胶囊、侧边栏、页内写回 | 在 Chrome 里加载该文件夹（见下） |

扩展只访问 `http://127.0.0.1`，用配对码鉴权。它不需要插件源码，插件也不需要扩展文件，所以两边可以各自升级。

## 安装 Cordis 插件

```sh
dsh plugin --profile web add github:bill9109/dsh-mini
```

命令会在 profile 目录执行 `pnpm add`，并把 bundle 追加进 `dsh.profile.bundles`。仓库自带构建产物（`lib/`），装完即可用，不需要另外构建。安装后重启 Web UI 并强制刷新浏览器页面。

唯一的运行时依赖是 `ws`，DSH 自身的包由正在运行的 DSH 提供。bundle 以默认配置挂载 Host 插件（`cordis.patch.yml` 里列出了全部可选项：端口、工作区、超时）。

确认 Host 已就绪。令牌文件会在首次启动时生成：

```sh
curl -s -H "Authorization: Bearer $(cat ~/.dsh/mini-panel/token)" http://127.0.0.1:18765/v1/health
# {"ok":true,...,"panel":true}
```

### 卸载

```sh
dsh plugin --profile web remove dsh-mini
```

## 安装 Chrome 扩展

1. 获取 `chrome-extension/` 文件夹（clone 本仓库，或下载 ZIP 解压）。
2. 打开 `chrome://extensions`，打开右上角的**开发者模式**。
3. 点**加载已解压的扩展程序**，选择 `chrome-extension/` 文件夹本身（里面直接有 `manifest.json` 的那一层）。
4. 打开扩展的选项页，填写：
   - **接口地址**：`http://127.0.0.1:18765`（默认值）
   - **配对码**：`~/.dsh/mini-panel/token` 的内容。DSH 里 **设置 → 插件 → Mini Panel** 也显示同一个值，并可以在那里重新生成。

在网页上选中文字，胶囊就会出现。需要 Chrome 116 或更新版本。详见 [`chrome-extension/README.md`](chrome-extension/README.md)。

## 安全模型

- 所有路由只绑定 `127.0.0.1`，并要求 `Authorization: Bearer <配对码>`。
- 跨源请求只接受 `localhost`、`127.0.0.1` 和 `chrome-extension://` 来源。
- 令牌文件权限为 0600，不会写日志，也不会被任何路由返回。重新生成后立即生效。
- 扩展申请了 `<all_urls>` 主机权限，胶囊才能在任意页面出现。扩展不读取 Cookie，配对码只存在 `chrome.storage.local`，不会进入页面。
- 选中的文字会作为带来源标注的不可信数据交给你配置的 DSH 模型，并记录在会话日志里。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | Host 插件（`index.ts`）、页面 broker、页面 WebSocket、侧边栏代理；`src/client/` 是 Web UI 部分 |
| `src/shared/edit-protocol.cjs` | 编辑协议，唯一权威来源；`chrome-extension/src/edit-protocol.js` 是同步副本（在扩展目录里运行 `npm run sync:protocol`） |
| `lib/` | 已提交的构建产物 |
| `tests/` | Host 测试（vitest） |
| `chrome-extension/` | Chrome 扩展及其测试 |
| `docs/` | 设计笔记：飞书前端引擎、写入循环设计、已验证操作 |

## 开发与验证

```sh
# 工具链和 @deepseek-ai/* 包来自 DSH 源码 checkout。
export DSH_CHECKOUT=/path/to/dsh

pnpm run build        # tsc + tsdown -> lib/（已提交）
pnpm test             # Host 测试
pnpm run test:extension   # 扩展：check + background + edit-core
```

已知缺口：

- `tests/host-http.host.spec.ts` 有 19 项失败：测试 harness 没有提供 Host 现在要求的 `tools` 服务。其余 Host 测试套件通过。
- `chrome-extension/tests/ui.mjs`、`options.mjs`、`e2e.mjs`、`sidepanel-e2e.mjs` 通过 DSH checkout 里的 Playwright 驱动真实浏览器。需要设置 `DSH_CHECKOUT`（侧边栏测试还需要 `DSH_E2E_CHROME`）。
- 真机点击打开侧边栏、收回会话后胶囊重新出现，这两项没有在真实浏览器里验证过。

## 社区

- 可复现的 bug 和聚焦的需求请提 [GitHub Issues](https://github.com/bill9109/dsh-mini/issues)。
- 提交改动前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。
- 版本说明见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

BSD-3-Clause
