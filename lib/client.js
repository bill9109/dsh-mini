window.__ModuleLoader__.load({
	id: "dsh-mini",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/client/panel-session.ts
		const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
		function followPanelSession(workspace, lists, host = window) {
			const panel = host.__DSH_PANEL__;
			if (!panel) return () => {};
			let wanted = null;
			const ready = () => lists.workspaces.list.getSnapshot().phase === "ready" && lists.sessions.list.getSnapshot().phase === "ready";
			let timer;
			const flush = () => {
				if (wanted === null || !ready() || timer) return;
				timer = setTimeout(() => {
					timer = void 0;
					const id = wanted;
					wanted = null;
					if (id === null) return;
					try {
						workspace.openSession(id);
					} catch (error) {
						console.warn("dsh-mini-panel: open session failed", error);
					}
				}, 0);
			};
			const open = (id) => {
				if (typeof id !== "string" || !SESSION_ID.test(id)) return;
				wanted = id;
				flush();
			};
			const offS = lists.sessions.list.subscribe(flush);
			const offW = lists.workspaces.list.subscribe(flush);
			open(panel.session);
			const onMessage = (event) => {
				if (event.source !== host.parent || host.parent === host) return;
				const data = event.data;
				if (data?.type === "dsh-panel/open-session") open(data.sessionId);
			};
			host.addEventListener("message", onMessage);
			return () => {
				offS();
				offW();
				clearTimeout(timer);
				host.removeEventListener("message", onMessage);
			};
		}
		//#endregion
		//#region src/client/settings-page.ts
		/**
		* 设置 → DSH Mini. Laid out like the shell's own 模型 page so it reads as part of DSH: an H2 title
		* and intro per section, one row card per item (name, status dot, tags, then 编辑 / 删除 on the
		* right), an inline editor that opens inside the card, and a dashed "+ 添加…" button.
		*
		* The shell's styles are hashed CSS modules, so this file restates the same rules against the
		* same --dsw-* tokens instead of borrowing class names that change between builds.
		*/
		const PAIRING = "/dsh-mini-panel/api/v1/pairing";
		const LIST = "/dsh-mini-panel/api/v1/sites";
		const ACTION = "/dsh-mini-panel/api/v1/sites/action";
		const SETTINGS_PAGE_CSS = [
			".dshm-page{display:flex;flex-direction:column;gap:28px;max-width:720px;color:var(--dsw-alias-label-primary)}",
			".dshm-section{display:flex;flex-direction:column;gap:12px}",
			".dshm-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}",
			".dshm-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}",
			".dshm-intro code,.dshm-hint code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:.92em}",
			".dshm-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}",
			".dshm-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl)}",
			".dshm-head{display:flex;align-items:center;gap:10px;min-height:28px}",
			".dshm-identity{display:inline-flex;align-items:center;gap:6px;min-width:0}",
			".dshm-name{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshm-off .dshm-name{color:var(--dsw-alias-label-tertiary)}",
			".dshm-tag{flex:0 0 auto;padding:1px 6px;font-size:11px;line-height:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary)}",
			".dshm-dot{box-sizing:border-box;flex:0 0 auto;width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dsw-alias-label-dimmed)}",
			".dshm-dot-ok{background:var(--dsw-alias-state-success-primary)}",
			".dshm-dot-bad{background:var(--dsw-alias-state-error-primary)}",
			".dshm-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:-6px;word-break:break-all}",
			".dshm-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto}",
			".dshm-btn,.dshm-danger,.dshm-primary{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}",
			".dshm-btn{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}",
			".dshm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover))}",
			".dshm-danger{border:0;background:transparent;color:var(--dsw-alias-state-error-primary)}",
			".dshm-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}",
			".dshm-primary{border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
			".dshm-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
			".dshm-add{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:44px;padding:0 14px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}",
			".dshm-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dshm-btn:disabled,.dshm-danger:disabled,.dshm-primary:disabled,.dshm-add:disabled{opacity:.4;cursor:default}",
			".dshm-btn:focus-visible,.dshm-danger:focus-visible,.dshm-primary:focus-visible,.dshm-add:focus-visible,.dshm-input:focus-visible,.dshm-code:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}",
			".dshm-editor{display:flex;flex-direction:column;gap:14px}",
			".dshm-field{display:flex;flex-direction:column;gap:6px}",
			".dshm-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
			".dshm-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}",
			".dshm-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}",
			".dshm-input[readonly]{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12.5px}",
			".dshm-code{box-sizing:border-box;width:100%;min-height:300px;resize:vertical;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12.5px;line-height:1.6;tab-size:2}",
			".dshm-code:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}",
			".dshm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dshm-err{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-word}",
			".dshm-ok{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}",
			".dshm-footer{display:flex;align-items:center;gap:8px}",
			".dshm-grow{flex:1;min-width:0}",
			".dshm-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dshm-pre{margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.55}",
			".dshm-test{display:flex;gap:8px;align-items:center}"
		].join("");
		async function api(path, body) {
			const response = await fetch(path, body === void 0 ? { headers: { accept: "application/json" } } : {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: JSON.stringify(body)
			});
			const value = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(value.message || "HTTP " + String(response.status));
			return value;
		}
		const message = (error) => error instanceof Error ? error.message : String(error);
		const PlusIcon = () => (0, react.createElement)("svg", {
			width: 14,
			height: 14,
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": "true",
			focusable: "false"
		}, (0, react.createElement)("path", {
			d: "M8 2V14",
			stroke: "currentColor"
		}), (0, react.createElement)("path", {
			d: "M2 8H14",
			stroke: "currentColor"
		}));
		const STATUS = {
			connected: {
				dot: "dshm-dot dshm-dot-ok",
				label: "扩展已连接"
			},
			"stale-code": {
				dot: "dshm-dot dshm-dot-bad",
				label: "扩展的配对码已失效，请重新粘贴"
			},
			idle: {
				dot: "dshm-dot",
				label: "扩展最近没有连接"
			},
			never: {
				dot: "dshm-dot dshm-dot-bad",
				label: "尚未配对"
			}
		};
		function ago(ms) {
			const s = Math.max(0, Math.round((Date.now() - ms) / 1e3));
			if (s < 60) return "刚刚";
			if (s < 3600) return String(Math.floor(s / 60)) + " 分钟前";
			return String(Math.floor(s / 3600)) + " 小时前";
		}
		function PairingSection() {
			const [info, setInfo] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [open, setOpen] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)("");
			const [shown, setShown] = (0, react.useState)(false);
			const [copied, setCopied] = (0, react.useState)(false);
			const load = (0, react.useCallback)(async () => {
				try {
					setInfo(await api(PAIRING));
					setError("");
				} catch (e) {
					setError(message(e));
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
				const t = setInterval(() => {
					load();
				}, 1e4);
				return () => clearInterval(t);
			}, [load]);
			const rotate = async () => {
				if (!window.confirm("生成新配对码后，旧码立即失效，扩展需要重新粘贴。继续吗？")) return;
				setBusy(true);
				setNote("");
				try {
					setInfo(await api("/dsh-mini-panel/api/v1/pairing/rotate", {}));
					setNote("已生成新配对码；把它粘进扩展的连接设置。");
					setShown(true);
				} catch (e) {
					setNote(message(e));
				} finally {
					setBusy(false);
				}
			};
			const copy = async () => {
				if (!info?.token) return;
				try {
					await navigator.clipboard.writeText(info.token);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch {
					setShown(true);
				}
			};
			const s = STATUS[info?.status?.state ?? "never"];
			const seen = info?.status?.lastSeen !== void 0 ? "，" + ago(info.status.lastSeen) : "";
			const field = (label, value, extra) => (0, react.createElement)("div", { className: "dshm-field" }, (0, react.createElement)("label", { className: "dshm-label" }, label), (0, react.createElement)("div", { className: "dshm-test" }, (0, react.createElement)("input", {
				className: "dshm-input",
				readOnly: true,
				value,
				"aria-label": label
			}), extra ?? null));
			return (0, react.createElement)("section", {
				className: "dshm-section",
				"aria-labelledby": "dshm-pairing-title"
			}, (0, react.createElement)("h2", {
				className: "dshm-title",
				id: "dshm-pairing-title"
			}, "Chrome 扩展"), (0, react.createElement)("p", { className: "dshm-intro" }, "把下面的接口地址和配对码填进扩展的连接设置。"), error ? (0, react.createElement)("p", {
				className: "dshm-err",
				role: "alert"
			}, "加载失败：" + error) : null, (0, react.createElement)("ul", { className: "dshm-rows" }, (0, react.createElement)("li", { className: "dshm-card" }, (0, react.createElement)("div", { className: "dshm-head" }, (0, react.createElement)("span", { className: "dshm-identity" }, (0, react.createElement)("span", { className: "dshm-name" }, "Mini Panel"), (0, react.createElement)("span", {
				className: s.dot,
				role: "img",
				"aria-label": s.label + seen,
				title: s.label + seen
			})), (0, react.createElement)("span", { className: "dshm-actions" }, (0, react.createElement)("button", {
				type: "button",
				className: "dshm-btn",
				onClick: () => setOpen((v) => !v),
				"aria-expanded": open
			}, open ? "收起" : "编辑"))), (0, react.createElement)("div", {
				className: "dshm-sub",
				"aria-live": "polite"
			}, s.label + seen), open ? (0, react.createElement)("div", { className: "dshm-editor" }, field("接口地址", info?.endpoint ?? ""), field("配对码", info?.token ? shown ? info.token : "•".repeat(Math.min(43, info.token.length)) : "（尚未生成）", (0, react.createElement)("span", { className: "dshm-actions" }, (0, react.createElement)("button", {
				type: "button",
				className: "dshm-btn",
				onClick: () => setShown((v) => !v),
				disabled: !info?.token
			}, shown ? "隐藏" : "显示"), (0, react.createElement)("button", {
				type: "button",
				className: "dshm-btn",
				onClick: () => {
					copy();
				},
				disabled: !info?.token
			}, copied ? "已复制" : "复制"))), field("配对码文件", info?.tokenPath ?? ""), note ? (0, react.createElement)("p", {
				className: "dshm-hint",
				role: "status"
			}, note) : null, (0, react.createElement)("div", { className: "dshm-footer" }, (0, react.createElement)("span", { className: "dshm-grow" }), (0, react.createElement)("button", {
				type: "button",
				className: "dshm-danger",
				onClick: () => {
					rotate();
				},
				disabled: busy
			}, busy ? "生成中…" : "生成新配对码"))) : null)));
		}
		function download(name, text) {
			const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			a.rel = "noopener";
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1e3);
		}
		function SiteEditor(props) {
			const [text, setText] = (0, react.useState)(props.initial);
			const [busy, setBusy] = (0, react.useState)(false);
			const [status, setStatus] = (0, react.useState)(null);
			const dirty = text !== props.initial;
			const save = async () => {
				setBusy(true);
				setStatus(null);
				const failure = await props.onSave(text);
				setBusy(false);
				if (failure) setStatus({
					ok: false,
					text: failure
				});
			};
			const cancel = () => {
				if (!dirty || window.confirm("放弃未保存的修改？")) props.onCancel();
			};
			return (0, react.createElement)("div", { className: "dshm-editor" }, (0, react.createElement)("div", { className: "dshm-field" }, (0, react.createElement)("label", {
				className: "dshm-label",
				htmlFor: "dshm-site-text"
			}, "文件内容"), (0, react.createElement)("textarea", {
				id: "dshm-site-text",
				className: "dshm-code",
				value: text,
				spellCheck: false,
				onChange: (e) => {
					setText(e.target.value);
					setStatus(null);
				}
			}), (0, react.createElement)("p", { className: "dshm-hint" }, "文件头写在 ", (0, react.createElement)("code", null, "// ==DshSite=="), " 和 ", (0, react.createElement)("code", null, "// ==/DshSite=="), " 之间：必填 ", (0, react.createElement)("code", null, "@name"), "、", (0, react.createElement)("code", null, "@version"), "、至少一条 ", (0, react.createElement)("code", null, "@match"), "（同油猴，如 ", (0, react.createElement)("code", null, "*://*.feishu.cn/*"), "）；可选 ", (0, react.createElement)("code", null, "@exclude"), "、", (0, react.createElement)("code", null, "@description"), "、", (0, react.createElement)("code", null, "@author"), "。文件头之后是给模型的正文，最多 32 KB。")), status ? (0, react.createElement)("p", {
				className: status.ok ? "dshm-ok" : "dshm-err",
				role: status.ok ? "status" : "alert"
			}, status.text) : null, (0, react.createElement)("div", { className: "dshm-footer" }, props.onExport ? (0, react.createElement)("button", {
				type: "button",
				className: "dshm-btn",
				onClick: () => props.onExport(text),
				disabled: busy
			}, "导出") : null, (0, react.createElement)("span", { className: "dshm-grow" }), (0, react.createElement)("button", {
				type: "button",
				className: "dshm-btn",
				onClick: cancel,
				disabled: busy
			}, "取消"), (0, react.createElement)("button", {
				type: "button",
				className: "dshm-primary",
				onClick: () => {
					save();
				},
				disabled: busy || !dirty && !props.isNew
			}, busy ? "保存中…" : "保存")));
		}
		function SitesSection() {
			const [listing, setListing] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [editing, setEditing] = (0, react.useState)(null);
			const [draftFromImport, setDraftFromImport] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [testUrl, setTestUrl] = (0, react.useState)("");
			const [test, setTest] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)("");
			const editorKey = (0, react.useRef)(0);
			const load = (0, react.useCallback)(async () => {
				try {
					setListing(await api(LIST));
					setError("");
				} catch (e) {
					setError(message(e));
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const open = (next, imported = null) => {
				editorKey.current++;
				setDraftFromImport(imported);
				setEditing(next);
				setNotice("");
			};
			const save = async (text, id) => {
				try {
					const out = await api(ACTION, {
						action: "save",
						text,
						...id ? { id } : {}
					});
					if (!out.ok) return out.message ?? "保存失败";
					await load();
					setEditing(null);
					setNotice("已保存，下一轮对话生效。");
					return;
				} catch (e) {
					return message(e);
				}
			};
			const act = async (body) => {
				setBusy(true);
				try {
					await api(ACTION, body);
					await load();
				} catch (e) {
					setNotice(message(e));
				} finally {
					setBusy(false);
				}
			};
			const remove = (row) => {
				if (!window.confirm("删除站点偏好「" + row.name + "」？此操作不可撤销。")) return;
				if (editing && editing.kind !== "new" && editing.id === row.id) setEditing(null);
				act({
					action: "delete",
					id: row.id
				});
			};
			const importFile = () => {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = ".txt,.js,.md,text/plain";
				input.onchange = () => {
					const file = input.files?.[0];
					if (!file) return;
					if (file.size > 32 * 1024) {
						setNotice("文件超过 32 KB。");
						return;
					}
					file.text().then((text) => open({ kind: "new" }, text));
				};
				input.click();
			};
			const runTest = async () => {
				const url = testUrl.trim();
				if (!url) return;
				try {
					setTest(await api(ACTION, {
						action: "test",
						url
					}));
				} catch (e) {
					setNotice(message(e));
				}
			};
			const names = (0, react.useMemo)(() => new Map((listing?.files ?? []).map((f) => [f.id, f.meta.name])), [listing]);
			const fileCard = (f) => {
				const isOpen = editing?.kind === "file" && editing.id === f.id;
				return (0, react.createElement)("li", {
					key: f.id,
					className: "dshm-card" + (f.enabled ? "" : " dshm-off")
				}, (0, react.createElement)("div", { className: "dshm-head" }, (0, react.createElement)("span", { className: "dshm-identity" }, (0, react.createElement)("span", { className: "dshm-name" }, f.meta.name), (0, react.createElement)("span", { className: "dshm-tag" }, "v" + f.meta.version), f.enabled ? null : (0, react.createElement)("span", { className: "dshm-tag" }, "已停用")), (0, react.createElement)("span", { className: "dshm-actions" }, (0, react.createElement)("label", { className: "dshm-switch" }, (0, react.createElement)("input", {
					type: "checkbox",
					checked: f.enabled,
					disabled: busy,
					onChange: () => {
						act({
							action: "enable",
							id: f.id,
							enabled: !f.enabled
						});
					}
				}), "启用"), isOpen ? null : (0, react.createElement)("button", {
					type: "button",
					className: "dshm-btn",
					onClick: () => open({
						kind: "file",
						id: f.id
					}),
					"aria-label": "编辑 " + f.meta.name
				}, "编辑"), (0, react.createElement)("button", {
					type: "button",
					className: "dshm-danger",
					onClick: () => remove({
						id: f.id,
						name: f.meta.name
					}),
					disabled: busy,
					"aria-label": "删除 " + f.meta.name
				}, "删除"))), (0, react.createElement)("div", { className: "dshm-sub" }, (f.meta.description ? f.meta.description + "  ·  " : "") + f.meta.match.join("  ·  ")), isOpen ? (0, react.createElement)(SiteEditor, {
					key: "e" + String(editorKey.current),
					initial: f.text,
					isNew: false,
					onSave: (text) => save(text, f.id),
					onCancel: () => setEditing(null),
					onExport: (text) => download(f.id + ".dshsite.txt", text)
				}) : null);
			};
			const brokenCard = (b) => {
				const isOpen = editing?.kind === "broken" && editing.id === b.id;
				return (0, react.createElement)("li", {
					key: "bad-" + b.id,
					className: "dshm-card"
				}, (0, react.createElement)("div", { className: "dshm-head" }, (0, react.createElement)("span", { className: "dshm-identity" }, (0, react.createElement)("span", { className: "dshm-name" }, b.id), (0, react.createElement)("span", {
					className: "dshm-dot dshm-dot-bad",
					role: "img",
					"aria-label": "无法解析",
					title: "无法解析"
				})), (0, react.createElement)("span", { className: "dshm-actions" }, isOpen ? null : (0, react.createElement)("button", {
					type: "button",
					className: "dshm-btn",
					onClick: () => open({
						kind: "broken",
						id: b.id
					})
				}, "编辑"), (0, react.createElement)("button", {
					type: "button",
					className: "dshm-danger",
					onClick: () => remove({
						id: b.id,
						name: b.id
					}),
					disabled: busy
				}, "删除"))), (0, react.createElement)("p", { className: "dshm-err" }, "无法解析，不会生效：" + b.message), isOpen ? (0, react.createElement)(SiteEditor, {
					key: "e" + String(editorKey.current),
					initial: b.text,
					isNew: false,
					onSave: (text) => save(text, b.id),
					onCancel: () => setEditing(null)
				}) : null);
			};
			return (0, react.createElement)("section", {
				className: "dshm-section",
				"aria-labelledby": "dshm-sites-title"
			}, (0, react.createElement)("h2", {
				className: "dshm-title",
				id: "dshm-sites-title"
			}, "站点偏好"), (0, react.createElement)("p", { className: "dshm-intro" }, "写给模型的、针对某类网站的偏好（比如飞书文档的格式要求）。Mini 面板绑定的页面命中 ", (0, react.createElement)("code", null, "@match"), " 时，正文才会进入这次对话。文件格式沿用油猴脚本，带版本号，可以导出分享。"), error ? (0, react.createElement)("p", {
				className: "dshm-err",
				role: "alert"
			}, "加载失败：" + error) : null, notice ? (0, react.createElement)("p", {
				className: "dshm-hint",
				role: "status"
			}, notice) : null, (0, react.createElement)("ul", {
				className: "dshm-rows",
				"aria-label": "站点偏好文件"
			}, ...(listing?.files ?? []).map(fileCard), ...(listing?.invalid ?? []).map(brokenCard), editing?.kind === "new" ? (0, react.createElement)("li", {
				key: "new",
				className: "dshm-card"
			}, (0, react.createElement)("div", { className: "dshm-head" }, (0, react.createElement)("span", { className: "dshm-name" }, draftFromImport !== null ? "导入的文件" : "新站点偏好")), (0, react.createElement)(SiteEditor, {
				key: "e" + String(editorKey.current),
				initial: draftFromImport ?? listing?.template ?? "",
				isNew: true,
				onSave: (text) => save(text),
				onCancel: () => setEditing(null)
			})) : null), editing?.kind === "new" ? null : (0, react.createElement)("div", { className: "dshm-test" }, (0, react.createElement)("button", {
				type: "button",
				className: "dshm-add",
				onClick: () => open({ kind: "new" }),
				disabled: !listing
			}, (0, react.createElement)(PlusIcon, null), "添加站点偏好"), (0, react.createElement)("button", {
				type: "button",
				className: "dshm-btn",
				onClick: importFile,
				disabled: !listing,
				style: {
					height: 44,
					borderRadius: "var(--dsw-radius-lg)",
					padding: "0 16px",
					fontSize: 14
				}
			}, "导入文件")), listing ? (0, react.createElement)("p", { className: "dshm-hint" }, "文件存放在 ", (0, react.createElement)("code", null, listing.directory)) : null, (0, react.createElement)("div", { className: "dshm-card" }, (0, react.createElement)("div", { className: "dshm-head" }, (0, react.createElement)("span", { className: "dshm-name" }, "测试匹配")), (0, react.createElement)("div", { className: "dshm-test" }, (0, react.createElement)("input", {
				className: "dshm-input",
				type: "url",
				placeholder: "https://xxx.feishu.cn/docx/…",
				value: testUrl,
				"aria-label": "测试网址",
				onChange: (e) => setTestUrl(e.target.value),
				onKeyDown: (e) => {
					if (e.key === "Enter") runTest();
				}
			}), (0, react.createElement)("button", {
				type: "button",
				className: "dshm-btn",
				onClick: () => {
					runTest();
				},
				disabled: !testUrl.trim()
			}, "测试")), test ? test.matched.length ? (0, react.createElement)("div", { className: "dshm-editor" }, (0, react.createElement)("p", { className: "dshm-hint" }, "命中：" + test.matched.map((id) => names.get(id) ?? id).join("、") + "。模型会看到："), (0, react.createElement)("pre", { className: "dshm-pre" }, test.prompt)) : (0, react.createElement)("p", { className: "dshm-hint" }, "没有启用的站点偏好命中这个网址。") : null));
		}
		function SettingsPage() {
			return (0, react.createElement)("div", { className: "dshm-page" }, (0, react.createElement)(PairingSection, null), (0, react.createElement)(SitesSection, null));
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of dsh-mini-panel: the card on 设置 → 插件 → 插件配置.
		*
		* The plugins tab only lays out a flex column and dispatches
		* `settings.plugin.item` keyed by a settings namespace, so this plugin owns its
		* own card. Chrome mirrors the host's PluginCard / dsh-market's SettingsCard one
		* for one (same tokens, same collapsible row + chevron + bordered body) so it
		* does not look like it wandered in from another product.
		*
		* The Host half registers the `dsh-mini-panel` settings namespace — without it
		* the tab has no key to dispatch and this card never renders. Token traffic goes
		* over the Host's own webServer route (same origin as this page), because the
		* loopback rewrite endpoint on 18765 is Bearer-guarded and belongs to the
		* extension, not to the GUI.
		*/
		const name = "dsh-mini-panel-client";
		/** `slots` is a hard dependency: apply() registers into it. */
		const inject = ["slots"];
		const NS = "dsh-mini-panel";
		const ROUTE = "/dsh-mini-panel/api/v1/pairing";
		const CSS = [
			".dsh-mp-card{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
			".dsh-mp-cardOpen{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}",
			".dsh-mp-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".dsh-mp-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".dsh-mp-name{color:var(--dsw-alias-label-primary,#1f2328);font-size:15px;font-weight:600;line-height:1.4}",
			".dsh-mp-desc{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:13px;line-height:1.5}",
			".dsh-mp-chevron{color:var(--dsw-alias-label-tertiary,#8b93a1);flex:none;display:inline-flex;transition:transform .16s}",
			".dsh-mp-chevronOpen{transform:rotate(180deg)}",
			".dsh-mp-body{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);margin:0 16px;padding-bottom:8px}",
			".dsh-mp-row{display:flex;align-items:center;gap:12px;padding:12px 0}",
			".dsh-mp-labelBox{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}",
			".dsh-mp-label{font-size:13px;line-height:20px}",
			".dsh-mp-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b93a1)}",
			".dsh-mp-field{flex:1;min-width:0}",
			".dsh-mp-input{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;line-height:18px;padding:6px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".dsh-mp-actions{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
			".dsh-mp-err{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;line-height:18px;margin:8px 0;word-break:break-all}",
			".dsh-mp-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280);padding:8px 0 0}"
		].join("");
		async function call(path, method) {
			const response = await fetch(path, {
				method,
				headers: { accept: "application/json" }
			});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			return await response.json();
		}
		function readPairing(value) {
			return {
				endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
				tokenPath: typeof value.tokenPath === "string" ? value.tokenPath : "",
				token: typeof value.token === "string" ? value.token : ""
			};
		}
		function Panel(props) {
			const [state, setState] = (0, react.useState)({
				phase: "loading",
				open: props.defaultOpen === true
			});
			(0, react.useEffect)(() => {
				let alive = true;
				call(ROUTE, "GET").then((value) => {
					if (alive) setState((previous) => ({
						phase: "ready",
						open: previous.open,
						info: readPairing(value)
					}));
				}).catch((error) => {
					if (alive) setState({
						phase: "error",
						open: true,
						message: error instanceof Error ? error.message : String(error)
					});
				});
				return () => {
					alive = false;
				};
			}, []);
			const toggle = () => {
				setState((previous) => ({
					...previous,
					open: !previous.open
				}));
			};
			const rotate = () => {
				setState((previous) => ({
					...previous,
					busy: true,
					message: void 0
				}));
				call("/dsh-mini-panel/api/v1/pairing/rotate", "POST").then((value) => {
					setState((previous) => ({
						phase: "ready",
						open: true,
						busy: false,
						rotated: true,
						info: readPairing(value)
					}));
				}).catch((error) => {
					setState((previous) => ({
						...previous,
						busy: false,
						message: error instanceof Error ? error.message : String(error)
					}));
				});
			};
			const header = (0, react.createElement)("button", {
				className: "dsh-mp-header",
				type: "button",
				onClick: toggle,
				"aria-expanded": state.open
			}, (0, react.createElement)("div", { className: "dsh-mp-headText" }, (0, react.createElement)("div", { className: "dsh-mp-name" }, "Mini Panel"), (0, react.createElement)("div", { className: "dsh-mp-desc" }, "Chrome 插件配对")), (0, react.createElement)("span", { className: "dsh-mp-chevron" + (state.open ? " dsh-mp-chevronOpen" : "") }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14 })));
			const info = state.info;
			const row = (label, hint, value) => (0, react.createElement)("div", { className: "dsh-mp-row" }, (0, react.createElement)("div", { className: "dsh-mp-labelBox" }, (0, react.createElement)("div", { className: "dsh-mp-label" }, label), (0, react.createElement)("div", { className: "dsh-mp-hint" }, hint)), (0, react.createElement)("div", { className: "dsh-mp-field" }, (0, react.createElement)("input", {
				className: "dsh-mp-input",
				readOnly: true,
				value
			})));
			const body = state.open ? (0, react.createElement)("div", { className: "dsh-mp-body" }, row("接口地址", "Chrome 扩展连接设置里的 endpoint", info?.endpoint ?? ""), row("配对码", "43 位，粘进扩展的连接设置", info?.token ?? "（尚未生成）"), row("文件", "Host 启动时读取", info?.tokenPath ?? ""), state.rotated ? (0, react.createElement)("div", { className: "dsh-mp-note" }, "已生成新配对码，立即生效；扩展里需要重新粘贴一次。") : null, state.message ? (0, react.createElement)("div", { className: "dsh-mp-err" }, state.message) : null, (0, react.createElement)("div", { className: "dsh-mp-actions" }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				onClick: rotate,
				disabled: state.busy,
				size: "sm"
			}, state.busy ? "生成中…" : "生成新配对码"))) : null;
			return (0, react.createElement)("li", { className: "dsh-mp-card" + (state.open ? " dsh-mp-cardOpen" : "") }, header, body);
		}
		function apply(ctx) {
			ctx.effect(() => {
				const element = document.createElement("style");
				element.textContent = CSS + SETTINGS_PAGE_CSS;
				document.head.append(element);
				return () => {
					element.remove();
				};
			}, "dsh-mini-panel: card styles");
			ctx.inject([
				"uiWorkspace",
				"sessions",
				"workspaces"
			], (scope) => {
				scope.effect(() => followPanelSession(scope.uiWorkspace, scope), "dsh-mini-panel: panel session");
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-mini-sites",
				order: 31,
				label: () => "DSH Mini"
			}, () => (0, react.createElement)(SettingsPage, null)));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS
			}, () => (0, react.createElement)(Panel, {})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map