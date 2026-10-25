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
import { createElement as h, useEffect, useState } from 'react';
import { Button, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { followPanelSession } from "./panel-session.js";
import { SettingsPage, SETTINGS_PAGE_CSS } from "./settings-page.js";
export const name = 'dsh-mini-panel-client';
/** `slots` is a hard dependency: apply() registers into it. */
export const inject = ['slots'];
const NS = 'dsh-mini-panel';
const ROUTE = '/dsh-mini-panel/api/v1/pairing';
const CSS = [
    '.dsh-mp-card{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
    '.dsh-mp-cardOpen{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}',
    '.dsh-mp-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
    '.dsh-mp-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
    '.dsh-mp-name{color:var(--dsw-alias-label-primary,#1f2328);font-size:15px;font-weight:600;line-height:1.4}',
    '.dsh-mp-desc{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:13px;line-height:1.5}',
    '.dsh-mp-chevron{color:var(--dsw-alias-label-tertiary,#8b93a1);flex:none;display:inline-flex;transition:transform .16s}',
    '.dsh-mp-chevronOpen{transform:rotate(180deg)}',
    '.dsh-mp-body{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);margin:0 16px;padding-bottom:8px}',
    '.dsh-mp-row{display:flex;align-items:center;gap:12px;padding:12px 0}',
    '.dsh-mp-labelBox{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}',
    '.dsh-mp-label{font-size:13px;line-height:20px}',
    '.dsh-mp-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b93a1)}',
    '.dsh-mp-field{flex:1;min-width:0}',
    '.dsh-mp-input{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;line-height:18px;padding:6px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.dsh-mp-actions{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
    '.dsh-mp-err{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;line-height:18px;margin:8px 0;word-break:break-all}',
    '.dsh-mp-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280);padding:8px 0 0}',
].join('');
async function call(path, method) {
    const response = await fetch(path, { method, headers: { accept: 'application/json' } });
    if (!response.ok)
        throw new Error('HTTP ' + String(response.status));
    return await response.json();
}
function readPairing(value) {
    return {
        endpoint: typeof value.endpoint === 'string' ? value.endpoint : '',
        tokenPath: typeof value.tokenPath === 'string' ? value.tokenPath : '',
        token: typeof value.token === 'string' ? value.token : '',
    };
}
function Panel(props) {
    const [state, setState] = useState({ phase: 'loading', open: props.defaultOpen === true });
    useEffect(() => {
        let alive = true;
        void call(ROUTE, 'GET').then((value) => {
            if (alive)
                setState(previous => ({ phase: 'ready', open: previous.open, info: readPairing(value) }));
        }).catch((error) => {
            if (alive)
                setState({ phase: 'error', open: true, message: error instanceof Error ? error.message : String(error) });
        });
        return () => { alive = false; };
    }, []);
    const toggle = () => { setState(previous => ({ ...previous, open: !previous.open })); };
    const rotate = () => {
        setState(previous => ({ ...previous, busy: true, message: undefined }));
        void call(ROUTE + '/rotate', 'POST').then((value) => {
            setState(previous => ({ phase: 'ready', open: true, busy: false, rotated: true, info: readPairing(value) }));
        }).catch((error) => {
            setState(previous => ({ ...previous, busy: false, message: error instanceof Error ? error.message : String(error) }));
        });
    };
    const header = h('button', {
        className: 'dsh-mp-header', type: 'button', onClick: toggle, 'aria-expanded': state.open,
    }, h('div', { className: 'dsh-mp-headText' }, h('div', { className: 'dsh-mp-name' }, 'Mini Panel'), h('div', { className: 'dsh-mp-desc' }, 'Chrome 插件配对')), h('span', { className: 'dsh-mp-chevron' + (state.open ? ' dsh-mp-chevronOpen' : '') }, h(IconChevronDownOutlineRegular, { size: 14 })));
    const info = state.info;
    const row = (label, hint, value) => h('div', { className: 'dsh-mp-row' }, h('div', { className: 'dsh-mp-labelBox' }, h('div', { className: 'dsh-mp-label' }, label), h('div', { className: 'dsh-mp-hint' }, hint)), h('div', { className: 'dsh-mp-field' }, h('input', { className: 'dsh-mp-input', readOnly: true, value })));
    const body = state.open
        ? h('div', { className: 'dsh-mp-body' }, row('接口地址', 'Chrome 扩展连接设置里的 endpoint', info?.endpoint ?? ''), row('配对码', '43 位，粘进扩展的连接设置', info?.token ?? '（尚未生成）'), row('文件', 'Host 启动时读取', info?.tokenPath ?? ''), state.rotated
            ? h('div', { className: 'dsh-mp-note' }, '已生成新配对码，立即生效；扩展里需要重新粘贴一次。')
            : null, state.message ? h('div', { className: 'dsh-mp-err' }, state.message) : null, h('div', { className: 'dsh-mp-actions' }, h(Button, { onClick: rotate, disabled: state.busy, size: 'sm' }, state.busy ? '生成中…' : '生成新配对码')))
        : null;
    return h('li', { className: 'dsh-mp-card' + (state.open ? ' dsh-mp-cardOpen' : '') }, header, body);
}
export function apply(ctx) {
    ctx.effect(() => {
        const element = document.createElement('style');
        element.textContent = CSS + SETTINGS_PAGE_CSS;
        document.head.append(element);
        return () => { element.remove(); };
    }, 'dsh-mini-panel: card styles');
    // Inside the extension's side panel, open the handed-over session; a no-op in the ordinary GUI.
    ctx.inject(['uiWorkspace', 'sessions', 'workspaces'], (scope) => {
        scope.effect(() => followPanelSession(scope.uiWorkspace, scope), 'dsh-mini-panel: panel session');
    });
    // 设置 → DSH Mini: its own section, right after 金融账户 (order 30).
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-mini-sites',
        order: 31,
        label: () => 'DSH Mini',
    }, () => h(SettingsPage, null)));
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
    }, () => h(Panel, {})));
}
