(() => {
  'use strict';
  globalThis.__dshSelectionDispose?.();
  let anchor = null, panel = false, generation = 0, requestId = null, panelSide = null;
  let captureTimer = 0, pollTimer = 0, phaseTimer = 0, layoutFrame = 0;
  // Both hint states (caret and selection) auto-hide after this long.
  const HINT_MS = 1500;
  let markerTimer = 0, typingEditor = null, composingEditor = null, dismissedRange = null, pointerHeld = false, pageSuspended = false;
  let compact = false, taskVisible = true, detailsVisible = false, taskState = 'idle', applying = false, replaying = false;
  let taskTitle = '', taskMessage = '', taskKind = 'rewrite';
  let binding = null, sessionWorking = false;
  let streamPort = null, streamThinking = '', streamText = '';
  let editingResult = false;
  const pageDocumentId = crypto.randomUUID();
  let currentPageTask = null;
  const icons = {
    edit: '<path d="M13 5H6a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7"/><path d="m11 15-4 1 1-4L18 2a2.1 2.1 0 0 1 3 3Z"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    arrow: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12 4 4 10-11"/>',
    stop: '<circle cx="12" cy="12" r="8"/><rect x="9" y="9" width="6" height="6" fill="currentColor"/>',  // 方形停止图标
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  const host = document.createElement('div');
  host.id = 'dsh-mini-panel';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      /* DSH light semantic palette from ui-theme/styles/design-platform.css.
         Local variables keep arbitrary webpage styles out of the extension.
         Translucent surface is the capsule-specific treatment of bg-layer-1. */
      /* Glass recipe. The "refraction" comes from a LOW blur over a fairly
         transparent fill: a heavy blur muddies the backdrop into frosted plastic.
         Two levels, because surfaces that carry text need more fill than a bare
         icon does — 65% white under 13px text is unreadable on a busy page. */
      :host{--dsh-glass-bg:rgba(255,255,255,.62);--dsh-glass-blur:2px;--dsh-glass-edge:rgba(0,0,0,.15);
            --dsh-glass-text-bg:rgba(255,255,255,.84);--dsh-glass-text-blur:8px;
            --dsh-surface:rgba(255,255,255,.96);--dsh-label:#0f1115;--dsh-secondary:#61666b;--dsh-tertiary:#81858c;--dsh-border:rgba(0,0,0,.1);--dsh-focus:#4176e6;--dsh-action:#4176e6;--dsh-action-hover:#679efe;--dsh-on-action:#fff;--dsh-hover:rgba(38,49,72,.06);--dsh-neutral:#f1f3f5;--dsh-tip:#f5f6f7;--dsh-success:#22c55e;--dsh-success-bg:#e6faed;--dsh-error:#ec1313;--dsh-shadow-opacity:.03}
      :host{all:initial;position:fixed;z-index:2147483647;top:0;left:0;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsh-label);color-scheme:light}
      *{box-sizing:border-box}
      button,input,textarea{font:inherit}
      button{cursor:pointer;border:0;background:transparent;color:inherit;padding:0}
      button:disabled{cursor:default;opacity:.36}
      button:focus-visible,textarea:focus-visible{outline:2px solid var(--dsh-focus);outline-offset:3px}
      svg{display:block;width:18px;height:18px;flex:none}
      .glass{background:var(--dsh-glass-bg);border:1px solid var(--dsh-glass-edge);backdrop-filter:blur(var(--dsh-glass-blur));-webkit-backdrop-filter:blur(var(--dsh-glass-blur))}
      .round{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:50%}
      button:hover:not(:disabled){background-color:var(--dsh-hover)}
      #marker:hover,#collapse:hover{background-color:var(--dsh-neutral)}
      #generate:hover:not(:disabled),.row .primary:hover:not(:disabled){background-color:var(--dsh-action-hover)}
      #generate:disabled{background:var(--dsh-neutral);color:var(--dsh-tertiary);opacity:1}
      /* Keep shadow filters off glass ancestors: filters change backdrop roots. */
      #elevation{position:fixed;inset:0;width:100vw;height:100vh;overflow:visible;pointer-events:none}
      #elevation .surface-shadow{filter:url(#dsh-soft-shadow)}
      #elevation feFlood{flood-opacity:var(--dsh-shadow-opacity)}
      #marker{position:fixed}
      section{position:fixed;width:336px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;scrollbar-width:thin;padding:0 0 4px;isolation:isolate;outline:none}
      .toolbar{display:flex;align-items:center;justify-content:center;gap:8px;min-height:40px}
      .ask{display:flex;align-items:center;gap:7px;height:40px;min-width:0;width:100%;padding:5px 7px;border-radius:24px;background:var(--dsh-glass-text-bg);backdrop-filter:blur(var(--dsh-glass-text-blur));-webkit-backdrop-filter:blur(var(--dsh-glass-text-blur));transition:width .28s cubic-bezier(.2,.8,.2,1)}
      #add{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--dsh-hover);flex:none}
      #instruction{flex:1;width:0;min-width:0;border:0;background:transparent;outline:none;color:var(--dsh-label);font-size:13px;padding:0;line-height:18px}
      #instruction::placeholder{color:var(--dsh-tertiary);opacity:1}
      .ask:focus-within{border-color:var(--dsh-focus)}
      #generate{flex:none;width:24px;height:24px;border-radius:50%;background:var(--dsh-action);color:var(--dsh-on-action);display:grid;place-items:center}
      #generate svg{width:16px;height:16px}
      #edit{display:none;width:40px;height:38px;align-items:center;justify-content:center;flex:none}
      #collapse{position:relative;z-index:1;transition:transform .22s ease}
      #collapse svg{transition:transform .22s ease}
      section[data-compact=true] .toolbar{gap:0}
      section[data-compact=true] .ask{width:80px;padding:0;gap:0}
      section[data-compact=true] #edit{display:flex}
      section[data-compact=true] #add,section[data-compact=true] #instruction,section[data-compact=true] #generate{display:none}
      section[data-compact=true] #collapse{width:39px;height:38px;margin-left:-40px;background:none;border:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;border-radius:0 20px 20px 0}
      section[data-compact=true] #collapse:before{content:"";position:absolute;left:0;height:20px;border-left:1px solid var(--dsh-border)}
      section[data-compact=true] .toolbar:has(#collapse[hidden]) .ask{width:40px}
      section[data-task-visible=false] #collapse svg{transform:rotate(180deg)}
      /* No overflow:hidden here: the clip-path below already rounds every child,
         and an overflow clip would cut the 1px contour drawn on the outer edge. */
      /* Opaque: the page behind must never show through the result card (its text
         and grey blocks were bleeding through the translucent surface). */
      #task{margin-top:12px;border-radius:28px;background:var(--dsh-glass-text-bg);backdrop-filter:blur(var(--dsh-glass-text-blur));-webkit-backdrop-filter:blur(var(--dsh-glass-text-blur));animation:appear .26s ease both}
      /* Live model output streams through the composer's one-line area, so the
         task card keeps its summary height instead of expanding while thinking. */

      #task-summary{width:100%;min-height:54px;padding:9px 16px;display:flex;align-items:center;gap:12px;text-align:left;cursor:default}
      section[data-state=complete] #task-summary,section[data-state=applied] #task-summary{cursor:pointer}
      /* The summary is a button, but the title row must not tint on hover. */
      #task-summary:hover,#task-summary:active{background:transparent}
      .task-copy{flex:1;min-width:0}
      #task-title{display:block;font-size:13px;line-height:18px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #task-message{display:block;font-size:13px;line-height:18px;color:var(--dsh-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* Positioned by card state: beside the summary line while collapsed, and in
         the card's bottom-right corner once the body is open. */
      #complete{position:absolute;top:50%;transform:translateY(-50%);right:16px;width:32px;height:32px;border-radius:50%;background:var(--dsh-success-bg);color:var(--dsh-success);display:grid;place-items:center;flex:none;cursor:pointer}
      #task[data-expanded=true] #complete{top:auto;transform:none;bottom:10px;right:14px}
      /* Keep the summary line and the action row clear of the mark. */
      #task:has(#complete:not([hidden])) #task-summary{padding-right:58px}
      #task[data-expanded=true] #preview .row{padding-right:42px}
      /* The corner check is 32px at bottom:10px: the strip below the text must clear it even when empty. */
      #task[data-expanded=true] #preview{display:block;min-height:44px}
      #complete svg{width:18px;height:18px}
      section[data-state=error] #task-message{color:var(--dsh-error);white-space:normal;overflow-wrap:anywhere}
      /* The expanded body is the same text the collapsed line truncates: no
         divider, no ring, no second border - it just keeps flowing. */
      /* The actions row only; the result text sits directly under the title so the
         folded and expanded card keep the title and first line in place. */
      #preview{padding:0 16px 12px}
      /* Markdown, DSH's grammar subset rendered as DOM (never innerHTML). */
      #rendered{cursor:text;min-width:0;margin:0 16px 12px;overflow-wrap:anywhere;font-size:13px;line-height:20px;color:var(--dsh-label)}
      /* Folded: title line + one clamped result line add up to the 56px capsule
         height, so the ends stay true half-circles. */
      /* Folded, the clamped line stops before the mark instead of running under it. */
      #task[data-expanded=false] #rendered{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;margin:0 58px 5px 16px}
      #task[data-expanded=false] #result{display:none}
      /* Pin the folded capsule to its 56px pill so the ends stay half-circles. */
      #task[data-expanded=false]:has(#complete:not([hidden])){height:56px}
      #task[data-expanded=true] #rendered{max-height:160px;overflow:auto;scrollbar-width:thin}
      #task:has(#complete:not([hidden])) #task-summary{min-height:auto;padding-bottom:0}
      #rendered>*:first-child{margin-top:2px}
      #rendered>*:last-child{margin-bottom:0}
      #rendered p{margin:8px 0}
      #rendered h1,#rendered h2,#rendered h3,#rendered h4,#rendered h5,#rendered h6{margin:14px 0 6px;font-weight:600;line-height:1.4}
      #rendered h1{font-size:17px}
      #rendered h2{font-size:16px}
      #rendered h3{font-size:15px}
      #rendered h4,#rendered h5,#rendered h6{font-size:13px}
      #rendered strong{font-weight:600}
      #rendered em{font-style:italic}
      #rendered del{text-decoration:line-through;color:var(--dsh-secondary)}
      #rendered a{color:var(--dsh-action);font-weight:500;text-decoration:none}
      #rendered a:hover{text-decoration:underline dotted var(--dsh-action);text-underline-offset:3px}
      #rendered :not(pre)>code{font-family:'SF Mono','JetBrains Mono','Fira Code',Consolas,Menlo,monospace;font-size:12px;padding:1px 4px;border-radius:4px;background:var(--dsh-neutral)}
      #rendered ul,#rendered ol{margin:8px 0;padding-left:20px}
      #rendered li{margin:2px 0}
      #rendered li>*:first-child{margin-top:0}
      #rendered blockquote{margin:8px 0;padding:2px 0 2px 10px;border-left:2px solid var(--dsh-border);color:var(--dsh-secondary)}
      #rendered hr{margin:12px 0;border:0;border-top:1px solid var(--dsh-border)}
      #rendered .md-code{margin:10px 0;border-radius:12px;overflow:hidden;background:var(--dsh-tip)}
      #rendered .md-lang{display:block;padding:5px 10px;font-size:11px;line-height:16px;color:var(--dsh-tertiary);border-bottom:1px solid var(--dsh-border)}
      #rendered pre{margin:0;padding:10px 12px;overflow:auto;scrollbar-width:thin}
      #rendered pre code{font-family:'SF Mono','JetBrains Mono','Fira Code',Consolas,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsh-label);white-space:pre}
      #rendered .md-table{margin:10px 0;overflow:auto;scrollbar-width:thin}
      #rendered table{border-collapse:collapse;font-size:12px;line-height:18px}
      #rendered th,#rendered td{border:1px solid var(--dsh-border);padding:4px 8px;text-align:left}
      #rendered th{background:var(--dsh-tip);font-weight:600}
      /* Same inset and rhythm as the rendered view: editing must not shift the text. */
      /* A textarea is a replaced element: width:auto would fall back to its
         intrinsic width and the card would look half as wide while editing. */
      #result{display:block;resize:none;min-height:0;max-height:160px;width:calc(100% - 32px);margin:0 16px 5px;padding:0;border:0;background:transparent;color:var(--dsh-label);outline:none;outline-offset:0;font-size:13px;line-height:20px}
      .row{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:6px}
      /* Human interaction card: approvals and ask_user_question, answered right on the page. */
      #ask{display:flex;flex-direction:column;gap:10px;padding:2px 16px 12px}
      #ask[hidden]{display:none}
      .ask-head{display:flex;flex-direction:column;gap:2px}
      .ask-eyebrow{font-size:12px;line-height:16px;color:var(--dsh-tertiary)}
      .ask-title{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsh-label);overflow-wrap:anywhere}
      .ask-body{display:flex;flex-direction:column;gap:12px;max-height:min(240px,40vh);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
      .ask-body[data-more=true]{-webkit-mask-image:linear-gradient(#000 calc(100% - 28px),transparent);mask-image:linear-gradient(#000 calc(100% - 28px),transparent)}
      .ask-body pre{margin:0;padding:8px 12px;border-radius:12px;background:var(--dsh-neutral);color:var(--dsh-secondary);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .ask-body fieldset{margin:0;padding:0;border:0;min-width:0;display:flex;flex-direction:column;gap:2px}
      .ask-body legend{padding:0 0 4px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsh-label)}
      .ask-body fieldset[data-invalid=true] legend{color:var(--dsh-error)}
      .ask-body label{display:flex;align-items:flex-start;gap:8px;min-height:32px;padding:6px 10px;border-radius:12px;cursor:pointer;line-height:20px}
      .ask-body label:hover{background:var(--dsh-hover)}
      .ask-body label{position:relative}
      .ask-body label input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
      .ask-num,.ask-check{display:grid;place-items:center;flex:0 0 20px;width:20px;height:20px;border-radius:4px}
      .ask-num{background:var(--dsh-neutral);color:var(--dsh-secondary);font-size:12px;font-weight:500;line-height:18px}
      .ask-check::before{content:'';grid-area:1/1;box-sizing:border-box;width:14px;height:14px;border:1px solid rgba(0,0,0,.22);border-radius:4px}
      .ask-check::after{content:'';grid-area:1/1;width:6px;height:3px;margin-top:-2px;border:solid var(--dsh-on-action);border-width:0 0 1.5px 1.5px;transform:rotate(-45deg);opacity:0}
      label:has(input:checked) .ask-check::before{border-color:var(--dsh-label);background:var(--dsh-label)}
      label:has(input:checked) .ask-check::after{opacity:1}
      .ask-body label{border:1px solid transparent}
      .ask-body label:has(input[type=radio]:checked){background:var(--dsh-hover);border-color:var(--dsh-border)}
      .ask-body label:has(input:focus-visible){outline:2px solid var(--dsh-focus);outline-offset:-1px}
      .ask-option{display:flex;flex-direction:column;min-width:0}
      .ask-option small{font-size:12px;line-height:16px;color:var(--dsh-tertiary)}
      .ask-body input[type=text]{box-sizing:border-box;width:100%;height:32px;margin-top:4px;padding:0 12px;border:1px solid var(--dsh-border);border-radius:16px;background:var(--dsh-surface);color:var(--dsh-label);font-size:13px;outline:none}
      .ask-body input[type=text]:focus-visible{border-color:var(--dsh-focus);box-shadow:0 0 0 1px var(--dsh-focus)}
      #task:has(#ask:not([hidden])){background:var(--dsh-surface)}
      .ask-foot{display:flex;align-items:center;gap:8px;min-height:32px}
      .ask-error{flex:1;min-width:0;margin:0;font-size:12px;line-height:16px;color:var(--dsh-error);overflow-wrap:anywhere}
      .ask-error:empty{visibility:hidden}
      .ask-actions{display:flex;gap:8px;margin-left:auto}
      .ask-actions button{height:32px;padding:0 14px;border-radius:16px;background:var(--dsh-neutral);font-size:12px;font-weight:500;line-height:16px;padding-top:1px}
      .ask-actions .primary{background:var(--dsh-action);color:var(--dsh-on-action)}
      .ask-actions .primary:hover:not(:disabled){background:var(--dsh-action-hover)}
      .row button{padding:5px 11px;border-radius:16px;background:var(--dsh-neutral);font-size:12px}
      .row .primary{background:var(--dsh-action);color:var(--dsh-on-action)}
      #cancel-task{margin-right:auto}
      #task-actions{padding:0 16px 10px;margin:0;justify-content:flex-start}
      /* Same material as the capsule and the task card. This strip used to be the only opaque
         surface in the panel, so a note about the page read as a foreign block bolted on. */
      #status{margin:7px 10px 0;font-size:12px;white-space:pre-wrap;color:var(--dsh-secondary);background:var(--dsh-glass-text-bg);backdrop-filter:blur(var(--dsh-glass-text-blur));-webkit-backdrop-filter:blur(var(--dsh-glass-text-blur));border-radius:16px;padding:6px 10px}
      #status[data-error=true]{color:var(--dsh-error)}
      #menu{margin-top:8px;padding:7px;border-radius:16px;animation:appear .15s ease}
      #selection-context{font-size:12px;line-height:1.5;margin:4px 8px 8px;color:var(--dsh-secondary);white-space:pre-wrap;max-height:72px;overflow:auto;overflow-wrap:anywhere}
      #menu button{display:block;width:100%;padding:7px 9px;border-radius:9px;text-align:left;font-size:12px}
      #menu button:hover{background:var(--dsh-hover)}
      #session-controls{border-top:1px solid var(--dsh-border);margin:6px 0;padding-top:7px}
      #session-label{display:block;padding:3px 8px;color:var(--dsh-secondary);font-size:12px;overflow-wrap:anywhere}
      #session-picker select,#session-id{width:100%;min-width:0;padding:6px;border:1px solid var(--dsh-border);border-radius:6px;color:var(--dsh-label);background:var(--dsh-surface);font:inherit;margin:3px 0}
      #session-picker label{font-size:12px;color:var(--dsh-secondary)}
      .ask,#task{position:relative;border-color:transparent;border-radius:0;box-shadow:none}
      .ask:focus-within{border-color:transparent}
      .contour{position:absolute;inset:-1px;width:calc(100% + 2px);height:calc(100% + 2px);pointer-events:none;overflow:visible}
      .contour path{fill:none;stroke:var(--dsh-border);stroke-width:1}
      .ask:focus-within>.contour path{stroke:var(--dsh-focus)}
      [hidden]{display:none!important}
      @keyframes appear{from{opacity:0;transform:translateY(-7px)}to{opacity:1;transform:translateY(0)}}
      @media(prefers-reduced-motion:reduce){*,*::before{animation:none!important;transition:none!important}}
      @media(max-width:350px){.toolbar{gap:6px}#task-summary{padding:9px 12px}.ask{gap:5px}#preview{padding:0 12px 12px}}
    </style>
    <svg id="elevation" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <defs><filter id="dsh-soft-shadow" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceAlpha" stdDeviation="8" result="near-blur"/>
        <feOffset in="near-blur" dy="4" result="near-offset"/>
        <feGaussianBlur in="SourceAlpha" stdDeviation="12" result="far-blur"/>
        <feFlood flood-color="black" flood-opacity=".03" result="ink"/>
        <feComposite in="ink" in2="near-offset" operator="in" result="near"/>
        <feComposite in="ink" in2="far-blur" operator="in" result="far"/>
        <feMerge><feMergeNode in="far"/><feMergeNode in="near"/></feMerge>
      </filter></defs>
      <g id="shadow-surfaces"></g>
    </svg>
    <button id="marker" class="round glass" hidden title="用 DSH 修改" aria-label="用 DSH 修改">${icon('edit')}</button>
    <section hidden role="dialog" aria-label="DSH 选区改写" tabindex="-1">
      <div class="toolbar">
        <div class="ask glass">
          <button id="edit" title="展开输入" aria-label="展开输入">${icon('edit')}</button>
          <button id="add" title="选区与更多操作" aria-label="选区与更多操作" aria-expanded="false" aria-controls="menu">${icon('plus')}</button>
          <input id="instruction" type="text" autocomplete="off" placeholder="Start new chat" aria-label="修改要求">
          <button id="generate" disabled title="生成改写" aria-label="生成改写">${icon('arrow')}</button>
        </div>
        <button id="collapse" class="round glass" hidden title="收起输入" aria-label="收起输入" aria-expanded="true" aria-controls="task">${icon('chevron')}</button>
      </div>
      <div id="menu" class="glass" hidden>
        <p id="selection-context"></p>
        <div id="session-controls">
          <span id="session-label" role="status">尚未绑定会话</span>
          <button id="session-new">新建会话</button>
          <button id="session-list">绑定已有会话</button>
          <button id="session-detach" hidden>解除绑定</button>
          <div id="session-picker" hidden>
            <label for="session-select">最近会话</label>
            <select id="session-select" aria-label="最近会话"></select>
            <label for="session-id">会话 ID</label>
            <input id="session-id" type="text" autocomplete="off" maxlength="128">
            <button id="session-bind">绑定所选会话</button>
          </div>
        </div>
        <button id="to-panel">在侧边栏中展开</button>
        <button id="desktop">在桌面胶囊中打开</button>
        <button id="settings">连接设置</button>
        <button id="cancel-task" hidden title="停止生成" aria-label="停止生成">${icon('stop')} 停止</button>
        <button id="close">关闭当前交互</button>
      </div>
      <div id="task" class="glass" hidden>
        <button id="task-summary" aria-label="任务状态" aria-expanded="false" aria-controls="preview">
          <span class="task-copy"><strong id="task-title"></strong><span id="task-message" role="status" aria-live="polite"></span></span>
        </button>
        <div id="ask" role="group" aria-labelledby="ask-title" hidden></div>
        <div id="task-actions" class="row" hidden><button id="retry" hidden>重试</button></div>
        <div id="rendered" class="md" role="document" hidden></div>
        <textarea id="result" spellcheck="false" aria-label="改写结果" hidden></textarea>
        <div id="preview" hidden>
        </div>
        <button id="complete" class="round" type="button" hidden aria-label="完成并关闭">${icon('check')}</button>
      </div>
      <p id="status" hidden role="status" aria-live="polite"></p>
    </section>`;
  document.documentElement.appendChild(host);

  const el = id => shadow.getElementById(id);
  const section = shadow.querySelector('section');
  const busy = () => taskState === 'starting' || taskState === 'thinking';
  const hasResult = () => taskState === 'complete' || taskState === 'applied';

  // True circular arcs, with a short cubic transition only beside straight edges.
  // P0/P1/P2 are collinear => k(start)=0. At P3, tangent matches the circle;
  // choosing b-a = 3*b*b/(2*r*sin(theta)) gives k(end)=1/r exactly.
  function capsuleContour(width, height, radius, inset = 0) {
    const w = width - 2 * inset, h = height - 2 * inset;
    const r = Math.max(0.1, Math.min(radius - inset, w / 2, h / 2));
    const theta = 25 * Math.PI / 180;
    const s = Math.sin(theta), c = Math.cos(theta), b = r * Math.tan(theta / 2);
    const a = b - 1.5 * b * b / (r * s);
    // Shrink the blend as a straight edge disappears; a square becomes a circle.
    const dx = Math.min(b / 2, Math.max(0, (w - 2 * r) / 2));
    const dy = Math.min(b / 2, Math.max(0, (h - 2 * r) / 2));
    const corners = [[w-r,r,dx,dy], [w-r,h-r,dy,dx], [r,h-r,dx,dy], [r,r,dy,dx]];
    const parts = [];
    const n = value => Number(value.toFixed(6));
    corners.forEach(([cx, cy, incoming, outgoing], i) => {
      const point = (x, y) => {
        const rotated = [[x,y],[-y,x],[-x,-y],[y,-x]][i];
        return `${n(cx + rotated[0] + inset)} ${n(cy + rotated[1] + inset)}`;
      };
      parts.push(`${i ? 'L' : 'M'} ${point(-incoming, -r)}`);
      if (incoming > 0) parts.push(`C ${point(a,-r)} ${point(b,-r)} ${point(r*s,-r*c)}`);
      parts.push(`A ${n(r)} ${n(r)} 0 0 1 ${outgoing > 0 ? point(r*c,-r*s) : point(r,0)}`);
      if (outgoing > 0) parts.push(`C ${point(r,-b)} ${point(r,-a)} ${point(r,outgoing)}`);
    });
    return parts.join(' ') + ' Z';
  }

  function paintContour(node) {
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    const radius = node.id === 'task' ? 28 : 20;
    node.style.clipPath = `path("${capsuleContour(width, height, radius)}")`;
    let svg = node.querySelector(':scope > .contour');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('contour');
      svg.setAttribute('aria-hidden', 'true');
      svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
      node.appendChild(svg);
    }
    svg.firstChild.setAttribute('d', capsuleContour(width, height, radius, 0.5));
  }

  function scheduleLayout() {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      if (panel && anchor) position(section, anchor.rect);
      paintShadows();
      if (section.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')) scheduleLayout();
    });
  }

  // A shadow-only sibling follows the actual G2 paths without clipping their
  // blur or introducing a new backdrop root above the translucent surfaces.
  function paintShadows() {
    const layer = el('shadow-surfaces');
    layer.replaceChildren();
    const candidates = [el('marker'), ...section.querySelectorAll('.ask,#collapse,#task,#menu,#status')];
    const viewport = section.getBoundingClientRect();
    for (const node of candidates) {
      if (!node.getClientRects().length || (compact && node.id === 'collapse')) continue;
      const bounds = node.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('transform', 'translate(' + bounds.x + ' ' + bounds.y + ')');
      group.dataset.surface = node.id || 'ask';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const shaped = node.classList.contains('ask') || node.id === 'task';
      const radius = shaped ? (node.id === 'task' ? 28 : 20) : parseFloat(getComputedStyle(node).borderTopLeftRadius);
      const r = Math.min(radius || 20, bounds.width / 2, bounds.height / 2);
      path.setAttribute('d', shaped ? capsuleContour(bounds.width, bounds.height, r) :
        'M ' + r + ' 0 H ' + (bounds.width - r) + ' A ' + r + ' ' + r + ' 0 0 1 ' + bounds.width + ' ' + r +
        ' V ' + (bounds.height - r) + ' A ' + r + ' ' + r + ' 0 0 1 ' + (bounds.width - r) + ' ' + bounds.height +
        ' H ' + r + ' A ' + r + ' ' + r + ' 0 0 1 0 ' + (bounds.height - r) + ' V ' + r + ' A ' + r + ' ' + r + ' 0 0 1 ' + r + ' 0 Z');
      // Clip only the silhouette before filtering when the panel is scrolling.
      if (node !== el('marker')) path.style.clipPath = 'inset(' + Math.max(0, viewport.top - bounds.top) + 'px ' + Math.max(0, bounds.right - viewport.right) + 'px ' + Math.max(0, bounds.bottom - viewport.bottom) + 'px ' + Math.max(0, viewport.left - bounds.left) + 'px)';
      const filterGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      filterGroup.classList.add('surface-shadow');
      filterGroup.style.opacity = getComputedStyle(node).opacity;
      filterGroup.appendChild(path); group.appendChild(filterGroup); layer.appendChild(group);
    }
  }
  const shadowObserver = new MutationObserver(scheduleLayout);
  for (const node of [section, el('marker')]) shadowObserver.observe(node, { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-state', 'data-compact'] });
  section.addEventListener('scroll', scheduleLayout);

  /**
   * Panel copy for failures.
   *
   * The kernel and adapters report precise machine codes (and precise English detail for the
   * model). None of that belongs on screen: a user needs one short line saying what happened.
   * A code without an entry falls back to a generic sentence - never to raw exception text.
   */
  const PANEL_ERRORS = {
    NO_TARGET: '没有可编辑的目标。',
    TARGET_UNAVAILABLE: '找不到可编辑的目标。',
    ADAPTER_UNAVAILABLE: '这个页面暂不支持编辑。',
    STALE_TARGET: '目标已失效，请重新选择。',
    STALE_RANGE: '内容已变化，请重新选择。',
    REVISION_CONFLICT: '内容已变化，请重新选择后重试。',
    READ_ONLY: '这里不能编辑。',
    // Two very different situations used to share one vague sentence. They need different actions:
    // one is about how much was selected, the other about what kind of content it is.
    CROSS_BLOCK: '暂不支持跨多行/多块的修改，可以逐块来。',
    OUTSIDE_EDITOR_TEXT: '把光标放进要改的那个块里再试（可以只点一下它）。',
    UNSUPPORTED_RANGE: '这块内容暂不支持修改。',
    NOT_MOUNTED: '目标当前不在页面上，请滚动到它再试。',
    NOT_RENDERED: '编辑器没有接受这次修改，内容未变。',
    NOTHING_TO_DO: '没有可写入的内容。',
    UNSUPPORTED_TARGET: '这里不是可编辑的正文。',
    PARTIAL_STRUCTURE: '只写入了部分结构，请核对文档。',
    ANCHOR_NOT_REMOVED: '新结构已写入，但原块未能移除，请核对。',
    UNSUPPORTED_STRUCTURE: '这块内容的结构暂不支持修改。',
    UNSUPPORTED_OPERATION: '这个操作暂不支持。',
    UNSUPPORTED_FORMAT: '这个格式暂不支持。',
    UNSUPPORTED_CONTENT_TYPE: '这个目标不支持这种写入方式。',
    EMPTY_SELECTION: '请先选中要修改的内容。',
    NOT_A_CARET: '请把光标放在插入位置。',
    SCOPE_MISMATCH: '目标与操作不匹配。',
    PAGE_CHANGED: '页面已切换，请重新选择。',
    PROTOCOL_MISMATCH: '页面状态已变化，请重新选择。',
    BUSY: '上一步还没结束。',
    CANCELLED: '已取消。',
    TOO_MANY_TARGETS: '请重新开始一次任务。',
    EDITOR_REJECTED: '编辑器拒绝了这次修改。',
    EDITOR_ERROR: '编辑器没有完成修改。',
    NO_CHANGE: '内容没有变化。',
    POSTCONDITION_FAILED: '结果与预期不一致。',
  };
  function panelError(code, fallback = '操作未完成。') {
    return PANEL_ERRORS[code] || fallback;
  }

  function status(message, error = false) {
    el('status').textContent = message;
    el('status').dataset.error = String(error);
    el('status').hidden = !message;
    scheduleLayout();
  }

  function render() {
    section.dataset.state = taskState === 'idle' ? 'input' : taskState;
    section.dataset.mode = anchor?.mode || 'rewrite';
    el('desktop').hidden = true;
    section.dataset.compact = String(compact);
    section.dataset.taskVisible = String(taskVisible);
    el('collapse').hidden = taskState === 'idle';
    el('collapse').setAttribute('aria-label', compact ? (taskVisible ? '隐藏任务卡' : '显示任务卡') : '收起输入');
    el('collapse').title = el('collapse').getAttribute('aria-label');
    el('collapse').setAttribute('aria-expanded', String(taskVisible));
    el('task').hidden = taskState === 'idle' || !taskVisible;
    el('task-title').textContent = taskTitle;
    el('task-title').title = taskTitle;
    el('task-message').textContent = taskMessage;
    el('task-message').title = taskMessage;
    // Expanded, the body continues the very text that line was truncating.
    // With a result, the text itself is the card body; the message line would only
    // repeat or push it down.
    el('task-message').hidden = hasResult() || !taskMessage;
    el('complete').hidden = !hasResult();
    el('preview').hidden = !hasResult() || !detailsVisible;
    // The raw editor only exists while the body is open: folding from the
    // expanded state must land back on the clamped capsule, not on a textarea
    // whose saved height would spill outside the 56px pill.
    if (!detailsVisible && editingResult) {
      editingResult = false;
      el('result').style.height = '';
    }
    el('task').dataset.expanded = String(hasResult() && detailsVisible);
    const completeLabel = hasResult() && detailsVisible ? '收起结果' : '完成并关闭';
    el('complete').title = completeLabel;
    el('complete').setAttribute('aria-label', completeLabel);
    el('task-summary').setAttribute('aria-expanded', String(!el('preview').hidden));
    el('task-summary').setAttribute('aria-label', hasResult() ? (detailsVisible ? '收起改写结果' : '查看改写结果') : '任务状态');
    el('generate').disabled = busy() || applying || sessionWorking || !el('instruction').value.trim();
    renderBinding();
    el('desktop').disabled = busy() || applying;
    el('task-actions').hidden = taskState !== 'error';
    el('cancel-task').hidden = !busy();
    el('retry').hidden = taskState !== 'error';
    renderStream();
    renderResult();
    scheduleLayout();
  }

  function renderBinding() {
    el('session-label').textContent = binding?.sessionId ? '当前会话 · ' + binding.sessionId : '尚未绑定会话';
    el('session-detach').hidden = !binding;
    for (const id of ['session-new', 'session-list', 'session-bind', 'session-detach']) {
      el(id).disabled = busy() || applying || sessionWorking;
    }
  }

  async function refreshBinding() {
    const pinned = anchor;
    const reply = await send({ type: 'session-state', url: pinned?.url || location.href });
    if (!panel || anchor !== pinned) return;
    if (reply?.ok) binding = reply.binding || null;
    renderBinding();
  }

  async function sessionAction(type) {
    if (!anchor || busy() || applying || sessionWorking) return;
    const pinned = anchor;
    sessionWorking = true;
    render();
    try {
      const reply = await send({ type, url: pinned.url, title: pinned.title, sessionId: el('session-id').value.trim() });
      if (!panel || anchor !== pinned) return;
      if (!reply?.ok) throw new Error(reply?.error?.message || '会话操作失败');
      if (type === 'session-list') {
        el('session-select').replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = ''; placeholder.textContent = '选择会话或输入会话 ID';
        el('session-select').appendChild(placeholder);
        for (const session of reply.sessions || []) {
          const option = document.createElement('option');
          option.value = session.sessionId;
          option.textContent = (session.title || session.sessionId) + (session.busy ? '（占用中）' : '');
          option.disabled = Boolean(session.busy);
          el('session-select').appendChild(option);
        }
        el('session-id').value = '';
        el('session-picker').hidden = false;
      } else {
        binding = reply.binding || null;
        el('session-picker').hidden = true;
        status(type === 'session-detach' ? '已解除绑定，下次提交将新建会话。' : '已绑定会话。');
      }
    // Never surface a raw transport or exception string: one short line the user can act on.
    } catch { if (panel && anchor === pinned) status('会话操作失败，请重试。', true); }
    finally { sessionWorking = false; if (panel) render(); }
  }

  function setTask(state, message) {
    taskState = state;
    taskMessage = message;
    render();
  }

  function menu(show) {
    el('menu').hidden = !show;
    el('add').setAttribute('aria-expanded', String(show));
    scheduleLayout();
  }

  function collapse() {
    menu(false);
    if (!compact) {
      compact = true;
      detailsVisible = false;
      render();
      el('edit').focus({ preventScroll: true });
    } else {
      taskVisible = !taskVisible;
      render();
    }
  }

  function expand() {
    compact = false;
    taskVisible = true;
    render();
    el('instruction').focus({ preventScroll: true });
  }

  function element(node) {
    return node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
  }

  function offset(root, node, end) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, end);
    return range.toString().length;
  }

  function position(node, rect) {
    const bounds = node.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const x = Math.max(left + 12, Math.min(left + width - bounds.width - 12, rect.left));
    const below = rect.bottom + 12;
    const above = rect.top - bounds.height - 12;
    // Pick the side once per interaction: re-deciding on every grow would make the
    // card jump when it expands. The section scrolls once it no longer fits.
    if (panelSide === null) panelSide = below + bounds.height <= top + height - 12 ? 'below' : above >= top + 12 ? 'above' : 'below';
    const preferred = panelSide === 'above' ? above : below;
    const y = Math.max(top + 12, Math.min(preferred, top + height - bounds.height - 12));
    node.style.left = x + 'px';
    node.style.top = y + 'px';
  }

  function sameRange(a, b) {
    return a && b && a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer && a.endOffset === b.endOffset;
  }

  function rememberDismissedRange() {
    const selection = getSelection();
    dismissedRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  }

  function hideMarker(forget = true, cancelCapture = true) {
    clearTimeout(markerTimer);
    if (cancelCapture) clearTimeout(captureTimer);
    el('marker').hidden = true;
    if (forget && !panel) anchor = null;
  }

  function sameAnchor(a, b) {
    return a && b && a.editor === b.editor && a.start === b.start && a.end === b.end &&
      a.full === b.full && a.mode === b.mode && a.url === location.href;
  }

  // ============================================================
  // Feishu Document Context Extraction (Phase 1: Tables)
  // ============================================================
  
  function extractFeishuContext(range) {
    if (!range || !location.hostname.includes('feishu') && !location.hostname.includes('larksuite')) {
      return { type: 'text' };
    }

    const container = range.commonAncestorContainer;
    const containerEl = container.nodeType === 1 ? container : container.parentElement;

    const table = containerEl?.closest('table');
    if (table) {
      return extractTableContext(table, range);
    }

    const line = containerEl?.closest('.ace-line');
    const block = line?.closest('[data-block-type]');
    if (!block) return { type: 'text' };
    return extractBlockContext(block, line, range);
  }

  /**
   * Context for a selection that is not in a table.
   *
   * The model cannot see the page, so anything it needs in order to make the new
   * text fit what is already there has to travel with the request: which kind of
   * block holds the selection, what contains it, what sits before and after it and
   * how the document is structured. Under Feishu docx all of it is already on the
   * DOM - data-block-type names the block, the nearest [data-block-type] ancestor
   * names the container, and Feishu renders its own automatic numbering as a
   * heading-order button rather than as characters.
   */
  function extractBlockContext(block, line, range) {
    return {
      type: 'block',
      block: {
        kind: block.getAttribute('data-block-type') || 'text',
        text: blockText(line).slice(0, 200),
        // Automatic numbering exists only here: it is a button, not text.
        autoNumbered: !!block.querySelector('[class*="heading-order"]'),
        indent: indentDepth(block),
      },
      container: containerKind(block),
      siblings: siblingContext(block),
      document: documentOutline(),
      styles: inlineStyleAt(range),
    };
  }

  function blockText(line) {
    return (line?.textContent || '').replace(/\u200b/g, '').trim();
  }

  /**
   * The nearest block-shaped ancestor: quote / callout / cell / grid column.
   * The page block is the document itself, so it reads as the body.
   */
  function containerKind(block) {
    let parent = block.parentElement;
    while (parent) {
      const kind = parent.getAttribute?.('data-block-type');
      if (kind) return kind === 'page' ? 'body' : kind;
      parent = parent.parentElement;
    }
    return 'body';
  }

  /** Nesting depth of a list item, found by walking outward through list blocks. */
  function indentDepth(block) {
    const lists = new Set(['bullet', 'ordered', 'todo']);
    let depth = 0;
    let parent = block.parentElement;
    while (parent) {
      const kind = parent.getAttribute?.('data-block-type');
      if (kind && lists.has(kind)) depth += 1;
      parent = parent.parentElement;
    }
    return depth;
  }

  /** Up to two blocks before and after, so a rewrite can match its surroundings. */
  function siblingContext(block) {
    const parent = block.parentElement;
    if (!parent) return { before: [], after: [] };
    const blocks = Array.from(parent.children).filter(child => child.getAttribute?.('data-block-type'));
    const index = blocks.indexOf(block);
    if (index < 0) return { before: [], after: [] };
    return {
      before: blocks.slice(Math.max(0, index - 2), index).map(describeBlock),
      after: blocks.slice(index + 1, index + 3).map(describeBlock),
    };
  }

  function describeBlock(block) {
    return {
      kind: block.getAttribute('data-block-type') || 'text',
      text: blockText(block.querySelector('.ace-line')).slice(0, 60),
    };
  }

  /** The heading skeleton, so new text can follow the level and numbering in use. */
  function documentOutline() {
    const headings = Array.from(document.querySelectorAll('[data-block-type^="heading"]'))
      .filter(block => block.getAttribute('data-block-type') !== 'page')
      .map(block => {
        const kind = block.getAttribute('data-block-type');
        return {
          level: Number((/heading(\d+)/.exec(kind) || [])[1] || 0),
          text: blockText(block.querySelector('.ace-line')).slice(0, 60),
          numbered: !!block.querySelector('[class*="heading-order"]'),
        };
      })
      .filter(heading => heading.level > 0)
      .slice(0, 20);
    return { headings };
  }

  /**
   * Inline styling of the selected run, so a rewrite can keep it or change it on
   * purpose. Feishu keeps every inline style on the [data-leaf] span it renders.
   */
  function inlineStyleAt(range) {
    const start = range?.startContainer;
    const element = start && start.nodeType === 1 ? start : start?.parentElement;
    const target = element?.closest?.('[data-leaf]') ?? element;
    if (!target) return null;
    const style = getComputedStyle(target);
    return {
      bold: Number(style.fontWeight) >= 600,
      italic: style.fontStyle === 'italic',
      strikethrough: style.textDecorationLine.includes('line-through'),
      underline: style.textDecorationLine.includes('underline'),
      color: style.color,
      background: style.backgroundColor === 'rgba(0, 0, 0, 0)' ? null : style.backgroundColor,
    };
  }
  
  /**
   * The rows of a Feishu table, header included.
   *
   * Feishu renders the sticky header as its OWN <table> inside the same
   * .docx-table-inner-wrapper, so table.rows holds the body only. Reporting those
   * rows directly tells the model the table has one row fewer than the user is
   * looking at and shifts every row index by one; resolving writes the same way
   * agrees with the wrong number instead of with the page. Both sides therefore go
   * through here.
   */
  function tableRowsOf(table) {
    const own = Array.from(table.rows);
    const wrapper = table.closest?.('.docx-table-inner-wrapper');
    if (!wrapper) return { header: null, rows: own };
    const all = Array.from(wrapper.querySelectorAll('table'));
    const sticky = all.find(candidate => candidate.classList.contains('sticky-row-wrapper')) ?? null;
    const body = all.find(candidate => candidate !== sticky && candidate.rows.length) ?? table;
    const header = sticky?.rows?.[0] ?? null;
    const bodyRows = Array.from(body.rows);
    return { header, rows: header ? [header, ...bodyRows] : bodyRows };
  }

  /**
   * One cell's text with its block structure kept.
   *
   * A cell is not one line: the cells a user asks to match usually hold a lead
   * sentence plus bullets, and reading only the first .ace-line hides exactly the
   * format they are pointing at. Every block is reported, bullets marked.
   */
  function cellTextOf(cell) {
    const blocks = Array.from(cell.querySelectorAll('[data-block-type]'));
    if (blocks.length === 0) return (cell.innerText || '').replace(/\u200b/g, '').trim();
    return blocks
      .map(block => {
        const line = block.querySelector('.ace-line') || block;
        const text = (line.innerText || line.textContent || '').replace(/\u200b/g, '').trim();
        if (!text) return null;
        const kind = block.getAttribute('data-block-type');
        if (kind === 'bullet') return '• ' + text;
        if (kind === 'ordered') return '1. ' + text;
        return text;
      })
      .filter(Boolean)
      .join('\n');
  }

  function extractTableContext(table, range) {
    const groups = tableRowsOf(table);
    const rows = groups.rows;
    if (rows.length === 0) return { type: 'text' };

    const cols = rows[0].cells.length;

    let currentCell = { row: -1, col: -1 };
    const rangeContainer = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const activeCell = rangeContainer?.closest('td, th');
    if (activeCell) {
      const activeRow = activeCell.parentElement;
      currentCell.row = rows.indexOf(activeRow);
      currentCell.col = Array.from(activeRow.cells).indexOf(activeCell);
    }

    const data = rows.map(row => Array.from(row.cells).map(cellTextOf));

    const markdown = tableToMarkdown(data);

    // The selected cell is named, not merely numbered. A coordinate alone leaves the
    // model to count rows and columns itself, and a deictic instruction ("complete
    // THIS cell") has nothing in the payload to bind to - which is how a request to
    // complete the 需求描述 column was answered as if it pointed at 示意图.
    const headerRow = groups.header ? Array.from(groups.header.cells).map(cellTextOf) : null;
    const cellAt = (r, c) => (r >= 0 && rows[r] && rows[r].cells[c] ? cellTextOf(rows[r].cells[c]) : null);

    return {
      type: 'table',
      structure: {
        rows: rows.length,
        cols,
        header: !!groups.header,
        currentCell,
        currentCellAddress: headerRow && currentCell.col >= 0 ? headerRow[currentCell.col] : null,
        currentCellText: cellAt(currentCell.row, currentCell.col),
        rowLabel: currentCell.row >= 0 ? cellAt(currentCell.row, 0) : null,
      },
      data,
      markdown,
    };
  }

  function tableToMarkdown(data) {
    if (!data || data.length === 0) return '';
    // A cell can hold several lines now, and a raw newline would break the row:
    // HTML line breaks keep the structure visible inside one Markdown cell.
    const cell = value => (value || ' ').replace(/\n/g, '<br>');

    const lines = [];
    lines.push('| ' + data[0].map(cell).join(' | ') + ' |');
    lines.push('|' + data[0].map(() => '---').join('|') + '|');

    for (let i = 1; i < data.length; i++) {
      lines.push('| ' + data[i].map(cell).join(' | ') + ' |');
    }

    return lines.join('\n');
  }

  /** Image bytes for insert-image: data: URLs decode here, http(s) goes through the background's checked fetch. */
  function imageFetcher(page, commandOf) {
    return async src => {
      try {
        let type, base64, name = 'image';
        const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(src);
        if (data) { type = data[1]; base64 = data[2]; name = 'image.' + type.split('/')[1]; }
        else {
          const cmd = commandOf();
          const reply = await send({ type: 'page-image', pageSession: page, commandId: cmd?.commandId, src });
          const result = reply?.ok ? reply.result : { ok: false, code: 'IMAGE_UNAVAILABLE', message: reply?.error?.message || 'Image fetch failed' };
          if (!result.ok) return result;
          ({ type, base64, name } = result);
        }
        const bin = atob(base64), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { ok: true, type, name, bytes };
      } catch (error) { return { ok: false, code: 'IMAGE_UNAVAILABLE', message: String(error?.message || error).slice(0, 160) }; }
    };
  }
  // Open shadow roots hide both the focused control and the selection from the light DOM.
  function deepActive() { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a; }
  function composedRange(selection) {
    const roots = []; for (let a = document.activeElement; a?.shadowRoot; a = a.shadowRoot.activeElement) roots.push(a.shadowRoot);
    if (roots.length && typeof selection.getComposedRanges === 'function') {
      try {
        const [r] = selection.getComposedRanges({ shadowRoots: roots });
        if (r) { const range = document.createRange(); range.setStart(r.startContainer, r.startOffset); range.setEnd(r.endContainer, r.endOffset); return range; }
      } catch (e) { /* fall back to the light-DOM range */ }
    }
    return selection.getRangeAt(0).cloneRange();
  }
  function readAnchor() {
    if (pageSuspended || composingEditor || document.activeElement === host) return null;
    const active = deepActive();
    let value;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      if (active instanceof HTMLInputElement && !['text', 'search', 'url', 'tel'].includes(active.type)) return null;
      const start = active.selectionStart, end = active.selectionEnd;
      if (start === null || end === null) return null;
      const editable = !active.readOnly && !active.disabled;
      if (start === end && (!editable || typingEditor === active)) return null;
      value = { kind: 'control', editor: active, start, end, full: active.value, text: active.value.slice(start, end), rect: active.getBoundingClientRect(), editable };
    } else {
      const selection = getSelection();
      if (!selection?.rangeCount) return null;
      const range = composedRange(selection);
      if (!range.collapsed && sameRange(range, dismissedRange)) return null;
      let editor = element(range.startContainer);
      // Do NOT narrow this to the nearest .zone-container. Feishu keeps the real
      // caret in an offscreen textarea (textarea.docx-selection-hidden-textarea)
      // that lives outside every zone, and document.activeElement is that textarea
      // while a docx block is being edited. The containment checks below therefore
      // only pass because this climbs to the outer container that holds both.
      while (editor?.parentElement?.isContentEditable) editor = editor.parentElement;
      const editable = !!editor?.isContentEditable && editor.contains(range.endContainer);
      const root = editable ? editor : (element(range.commonAncestorContainer) || document.body);
      if (range.collapsed && (!editable || !root.contains(active) || typingEditor === root)) return null;
      // A retained selection inside an editor that has lost focus is not an active input target.
      if (editable && !root.contains(active)) return null;
      const block = node => element(node)?.closest('p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,[data-block-id]');
      const rect = range.getBoundingClientRect();
      value = { kind: 'range', editor: root, range, full: root.textContent, text: range.toString(), start: offset(root, range.startContainer, range.startOffset), end: offset(root, range.endContainer, range.endOffset), rect: rect.height ? rect : root.getBoundingClientRect(), editable: editable && block(range.startContainer) === block(range.endContainer) };
    }
    value.mode = value.start === value.end ? 'insert' : 'rewrite';
    if (value.mode === 'rewrite' && (!value.text.trim() || value.text.length > 20000)) return null;
    
    // Extract structured context for Feishu documents (tables, lists, etc.)
    const pageContext = value.kind === 'range' ? extractFeishuContext(value.range) : { type: 'text' };
    if (pageContext.type === 'table') {
      value.mode = 'table-fill';  // Override mode for table selections
    }
    
    return { ...value, pageContext, selectionId: crypto.randomUUID(), url: location.href, title: document.title };
  }

  function showMarker(value, rearm = false) {
    const same = sameAnchor(anchor, value);
    // A different target earns a fresh placement decision.
    if (!same) panelSide = null;
    anchor = value;
    // An expired hint — either state — stays expired until another explicit
    // focus/click; incidental events must not restart it.
    if (same && !rearm) return;
    clearTimeout(markerTimer);
    el('marker').dataset.mode = value.mode;
    el('marker').title = value.mode === 'insert' ? '用 DSH 生成段落' : '用 DSH 修改';
    el('marker').setAttribute('aria-label', el('marker').title);
    el('marker').hidden = false;
    position(el('marker'), value.rect);
    markerTimer = setTimeout(() => hideMarker(false), HINT_MS);
  }

  function capture(rearm = false) {
    if (panel || document.activeElement === host) return;
    const value = readAnchor();
    if (!value) { hideMarker(); return; }
    showMarker(value, rearm);
  }

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { return { ok: false, error: { message: error.message || '扩展连接已失效，请刷新页面。' } }; }
  }

  function cancel() {
    generation++;
    currentPageTask?.control.abort();
    void currentPageTask?.channel?.stop();
    clearTimeout(pollTimer);
    clearTimeout(phaseTimer);
    if (requestId) void send({ type: 'cancel', requestId });
    requestId = null;
    try { streamPort?.disconnect(); } catch { /* already closed */ }
    streamPort = null;
  }

  /** Drop the previous attempt's buffers; the caller owns the visible state. */
  function resetStream() {
    streamThinking = '';
    streamText = '';
  }

  /** A model retry re-enters the waiting state before it reports anything new. */
  function clearStreamMessage() {
    if (busy()) setTask('thinking', '正在思考…');
  }

  /** Keep the newest characters visible: the status line is one line tall. */
  function tail(text) {
    return text.length > 160 ? '…' + text.slice(-160) : text;
  }

  // The task card's own status line carries the live reasoning, exactly where
  // "正在思考…" used to sit. The card never grows, and the answer is not
  // previewed there: it appears once, as the result.
  function renderStream() {
    if (busy() && streamThinking && !askId) el('task-message').textContent = tail(streamThinking);
  }

  function appendStream(kind, text) {
    if (typeof text !== 'string' || !text) return;
    if (kind === 'thinking') streamThinking = (streamThinking + text).slice(-4000);
    else streamText = (streamText + text).slice(-4000);
    if (!busy() || askId) return;
    if (streamThinking) setTask('thinking', tail(streamThinking));
    else if (streamText && taskState === 'starting') setTask('thinking', '正在生成结果…');
  }

  /**
   * Live rewrite channel: mirrors the one-shot reply shape so the caller does not
   * branch, while every delta updates the task card as it arrives.
   */
  function sendStream(message) {
    let port = null;
    try { port = chrome.runtime.connect({ name: 'dsh-stream' }); } catch { port = null; }
    // No silent downgrade to a plain rewrite. Only the port path consumes page commands, so a
    // request sent without it would let the model call page_edit and then wait for a page that
    // will never claim it. Report the broken channel instead of starting a task that cannot run.
    if (!port) return Promise.resolve({ ok: false, code: 'NO_STREAM', error: { message: '扩展连接已断开，请刷新页面后重试。' } });
    try { streamPort?.disconnect(); } catch { /* replaced below */ }
    streamPort = port;
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch { /* already gone */ }
        if (streamPort === port) streamPort = null;
        resolve(value);
      };
      port.onMessage.addListener(reply => {
        if (!reply || typeof reply.type !== 'string') return;
        if (reply.type === 'ready') { if (reply.sessionId) { binding = { sessionId: reply.sessionId }; renderBinding(); } const task=currentPageTask; if(task&&!task.ready){task.ready=true;void beginTarget(task);} return; }
        if (reply.type === 'reset') { resetStream(); clearStreamMessage(); return; }
        if (reply.type === 'wake') { currentPageTask?.channel?.wake?.(); return; }
        if (reply.type === 'ask') { showAsk(reply.frame, port); return; }
        if (reply.type === 'ask-cancel') { hideAsk(reply.frame?.interactionId); return; }
        if (reply.type === 'ask-done') { if (reply.frame?.interactionId === askId) { hideAsk(); if (busy()) setTask('thinking', '已收到，继续处理…'); } return; }
        if (reply.type === 'ask-invalid') { askError(reply.frame?.interactionId, '回答不完整，请检查后重新提交。'); return; }
        if (reply.type === 'thinking') { appendStream('thinking', reply.text); return; }
        if (reply.type === 'text') { appendStream('text', reply.text); return; }
        if (reply.type === 'done') { finish({ ok: true, replacement: reply.replacement, sessionId: reply.sessionId, binding: reply.binding }); return; }
        if (reply.type === 'error') {
          finish({ ok: false, error: { code: reply.code, message: reply.message } });
        }
      });
      port.onDisconnect.addListener(() => { hideAsk(); finish({ ok: false, error: { code: 'DISCONNECTED', message: 'DSH 连接已中断，请重试。' } }); });
      port.postMessage(message);
    });
  }

  /**
   * Approval / question card. Every string here comes from the model or a tool, so it is
   * rendered as text nodes only. Focus moves into the card so keyboard users land on it, and the
   * card is a labelled group announced through the existing live status line.
   */
  let askId = null;
  function node(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k in n) n[k] = v; else n.setAttribute(k, v); }
    for (const c of children) if (c) n.append(c);
    return n;
  }
  /** Header / scrolling body / pinned footer. The footer (error + actions) never scrolls away. */
  function card(eyebrow, title, body, error, actions) {
    const head = node('div', { className: 'ask-head' }, [node('span', { className: 'ask-eyebrow', id: 'ask-title', text: eyebrow }), title && node('p', { className: 'ask-title', text: title })]);
    const items = body.filter(Boolean);
    const scroll = items.length ? node('div', { className: 'ask-body' }, items) : null;
    if (scroll) { const more = () => { scroll.dataset.more = String(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 2); }; scroll.addEventListener('scroll', more, { passive: true }); requestAnimationFrame(more); }
    const foot = node('div', { className: 'ask-foot' }, [error, node('div', { className: 'ask-actions' }, actions)]);
    return [head, scroll, foot].filter(Boolean);
  }
  /** Scroll only the card body so the field shows with its legend; the page and card never jump. */
  function reveal(target) {
    const box = target.closest('.ask-body');
    if (box) box.scrollTop = Math.max(0, target.offsetTop - box.offsetTop - 4);
    target.querySelector('input')?.focus({ preventScroll: true });
  }
  function hideAsk(id) {
    if (id && id !== askId) return;
    askId = null;
    el('ask').replaceChildren();
    el('ask').hidden = true;
    scheduleLayout();
  }
  function askError(id, message) {
    if (id !== askId) return;
    const line = el('ask').querySelector('.ask-error');
    if (line) line.textContent = message;
    for (const b of el('ask').querySelectorAll('button')) b.disabled = false;
  }
  function showAsk(frame, port) {
    if (!frame || typeof frame.interactionId !== 'string') return;
    askId = frame.interactionId;
    const answer = value => { try { port.postMessage({ type: 'answer', interactionId: frame.interactionId, value }); } catch { /* port gone; Host hands the ask to DSH */ } };
    const error = node('p', { className: 'ask-error', role: 'alert', 'aria-live': 'polite' });
    let body;
    if (frame.kind === 'approval') {
      const allow = node('button', { type: 'button', className: 'primary', text: '允许一次' });
      const reject = node('button', { type: 'button', text: '拒绝' });
      const decide = decision => { allow.disabled = reject.disabled = true; answer({ decision }); };
      allow.addEventListener('click', () => decide('allow'));
      reject.addEventListener('click', () => decide('reject'));
      body = card(
        '需要你确认 · ' + String(frame.toolName || '工具调用'),
        String(frame.displayReason || frame.reason || '允许 DSH 执行这次工具调用吗？'),
        [frame.arguments && node('pre', { text: String(frame.arguments), 'aria-label': '调用参数', tabIndex: 0 })],
        error, [reject, allow]);
      setTask('thinking', '等待你确认…');
    } else {
      const questions = Array.isArray(frame.questions) ? frame.questions : [];
      const sets = questions.map((q, qi) => {
        const name = 'ask-' + qi;
        const options = (q.options || []).map((o, oi) => {
          const input = node('input', { type: q.multiSelect ? 'checkbox' : 'radio', name, value: String(o.label), id: name + '-' + oi });
          return node('label', { htmlFor: name + '-' + oi }, [input, node('span', { className: q.multiSelect ? 'ask-check' : 'ask-num', 'aria-hidden': 'true', text: q.multiSelect ? '' : String(oi + 1) }), node('span', { className: 'ask-option' }, [document.createTextNode(String(o.label)), o.description && node('small', { text: String(o.description) })])]);
        });
        const other = node('input', { type: 'text', 'aria-label': (q.header || q.question) + ' · 其他回答', placeholder: options.length ? '其他（可选）' : '输入回答', maxLength: 4000 });
        return { q, other, fieldset: node('fieldset', {}, [node('legend', { text: (q.header ? q.header + ' · ' : '') + String(q.question) }), q.detail && node('p', { text: String(q.detail) }), ...options, other]) };
      });
      const submit = node('button', { type: 'button', className: 'primary', text: '提交回答' });
      submit.addEventListener('click', () => {
        const answers = sets.map(({ q, other, fieldset }) => {
          const selected = [...fieldset.querySelectorAll('input:checked')].map(i => i.value);
          const custom = other.value.trim();
          return { id: q.id, selected, ...(custom ? { custom } : {}) };
        });
      const missing = sets.filter((s, i) => !answers[i].selected.length && !answers[i].custom);
      for (const s of sets) s.fieldset.dataset.invalid = String(missing.includes(s));
      if (missing.length) { error.textContent = '还有 ' + missing.length + ' 个问题没回答。'; reveal(missing[0].fieldset); return; }
        submit.disabled = true;
        answer({ answers });
      });
      body = card('DSH 想问你 · ' + sets.length + ' 个问题', '', sets.map(s => s.fieldset), error, [submit]);
      setTask('thinking', '等待你回答…');
    }
    el('ask').replaceChildren(...body);
    el('ask').hidden = false;
    compact = false; taskVisible = true; render();
    el('ask').querySelector('.ask-body input,.ask-actions .primary')?.focus({ preventScroll: true });
    scheduleLayout();
  }

  function close() {
    hideAsk();
    cancel();
    clearTimeout(captureTimer);
    clearTimeout(markerTimer);
    panel = false;
    anchor = null;
    section.hidden = true;
    section.dataset.state = 'closed';
    panelSide = null;
    el('marker').hidden = true;
    el('preview').hidden = true;
    el('result').value = '';
    el('rendered').replaceChildren();
    editingResult = false;
    el('instruction').value = '';
    menu(false);
    status('');
  }

  function open() {
    if (!anchor) return;
    clearTimeout(markerTimer);
    clearTimeout(captureTimer);
    panel = true;
    binding = null;
    el('session-picker').hidden = true;
    void refreshBinding();
    compact = false;
    taskVisible = true;
    detailsVisible = false;
    taskState = 'idle';
    taskTitle = taskMessage = '';
    el('marker').hidden = true;
    el('selection-context').textContent = anchor.mode === 'insert' ? '在当前光标处插入新内容' : '已选文字 · ' + anchor.text;
    el('instruction').placeholder = anchor.mode === 'insert' ? '描述你想生成的段落' : 'Start new chat';
    el('generate').title = anchor.mode === 'insert' ? '生成段落' : '生成改写';
    el('generate').setAttribute('aria-label', el('generate').title);
    section.hidden = false;
    render();
    position(section, anchor.rect);
    status('');
    el('instruction').focus({ preventScroll: true });
  }

  // DSH renders assistant Markdown through an mdast GFM pipeline. A content
  // script has no bundle and must never inject model HTML into the page, so this
  // mirrors the same subset by building DOM nodes: HTML in the source stays
  // literal text, exactly like mdast parsed without dangerous HTML.
  const INLINE = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|~~([\s\S]+?)~~|!?\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;

  function appendInline(parent, text) {
    // A private copy: a nested inline call must not move the outer scan position,
    // which would make the outer loop re-match the same text forever.
    const pattern = new RegExp(INLINE.source, 'g');
    let last = 0;
    for (;;) {
      const match = pattern.exec(text);
      if (!match) break;
      if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      last = match.index + match[0].length;
      const [full, fence, fenced, strong, strong2, em, em2, del, linkText, href, bare] = match;
      if (fence !== undefined) {
        const code = document.createElement('code');
        code.textContent = fenced;
        parent.appendChild(code);
      } else if (strong !== undefined || strong2 !== undefined) {
        const node = document.createElement('strong');
        appendInline(node, strong ?? strong2);
        parent.appendChild(node);
      } else if (em !== undefined || em2 !== undefined) {
        const node = document.createElement('em');
        appendInline(node, em ?? em2);
        parent.appendChild(node);
      } else if (del !== undefined) {
        const node = document.createElement('del');
        appendInline(node, del);
        parent.appendChild(node);
      } else if (linkText !== undefined || bare !== undefined) {
        const url = href ?? bare;
        // Only web schemes become anchors; anything else stays literal text.
        if (/^(https?:|mailto:)/i.test(url)) {
          const anchor = document.createElement('a');
          anchor.textContent = linkText || bare;
          anchor.setAttribute('href', url);
          anchor.setAttribute('target', '_blank');
          anchor.setAttribute('rel', 'noreferrer noopener');
          parent.appendChild(anchor);
        } else {
          parent.appendChild(document.createTextNode(full));
        }
      }
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function markdownBlock(lines) {
    const fragment = document.createDocumentFragment();
    let index = 0;
    const tableRow = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const isDivider = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
      if (fence) {
        const body = [];
        index += 1;
        while (index < lines.length && !new RegExp('^\\s*' + fence[1][0] + '{3,}\\s*$').test(lines[index])) { body.push(lines[index]); index += 1; }
        index += 1;
        const wrapper = document.createElement('div');
        wrapper.className = 'md-code';
        const language = fence[2].trim().split(/\s+/)[0];
        if (language) {
          const label = document.createElement('span');
          label.className = 'md-lang';
          label.textContent = language;
          wrapper.appendChild(label);
        }
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = body.join('\n');
        pre.appendChild(code);
        wrapper.appendChild(pre);
        fragment.appendChild(wrapper);
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const node = document.createElement('h' + heading[1].length);
        appendInline(node, heading[2].replace(/\s+#+$/, ''));
        fragment.appendChild(node);
        index += 1;
        continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
        fragment.appendChild(document.createElement('hr'));
        index += 1;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const body = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) { body.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
        const quote = document.createElement('blockquote');
        quote.appendChild(markdownBlock(body));
        fragment.appendChild(quote);
        continue;
      }
      if (line.includes('|') && index + 1 < lines.length && isDivider(lines[index + 1])) {
        const head = tableRow(line);
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(tableRow(lines[index])); index += 1; }
        const scroller = document.createElement('div');
        scroller.className = 'md-table';
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const cell of head) { const th = document.createElement('th'); appendInline(th, cell); headRow.appendChild(th); }
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        for (const row of rows) {
          const tr = document.createElement('tr');
          for (const cell of row) { const td = document.createElement('td'); appendInline(td, cell); tr.appendChild(td); }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        scroller.appendChild(table);
        fragment.appendChild(scroller);
        continue;
      }
      const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet) {
        const ordered = /^\d/.test(bullet[2]);
        const indent = bullet[1].length;
        const list = document.createElement(ordered ? 'ol' : 'ul');
        let item = null;
        while (index < lines.length) {
          const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
          if (!next || /^\d/.test(next[2]) !== ordered) break;
          if (next[1].length < indent) break;
          if (next[1].length > indent) {
            const nested = [];
            const deeper = next[1].length;
            while (index < lines.length) {
              const inner = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
              if (!inner || inner[1].length < deeper) break;
              nested.push(lines[index].slice(deeper));
              index += 1;
            }
            if (item) item.appendChild(markdownBlock(nested));
            continue;
          }
          const task = /^\[([ xX])\]\s+(.*)$/.exec(next[3]);
          item = document.createElement('li');
          if (task) {
            item.classList.add('md-task');
            item.appendChild(document.createTextNode(task[1].toLowerCase() === 'x' ? '☑ ' : '☐ '));
            appendInline(item, task[2]);
          } else {
            appendInline(item, next[3]);
          }
          list.appendChild(item);
          index += 1;
        }
        fragment.appendChild(list);
        continue;
      }
      const body = [];
      while (index < lines.length && lines[index].trim() && !/^\s*(#{1,6}\s|>|```|~~~)/.test(lines[index])
        && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index]) && !/^\s*([-*_])\s*\1\s*\1/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      const paragraph = document.createElement('p');
      appendInline(paragraph, body.join('\n').replace(/\n/g, ' '));
      fragment.appendChild(paragraph);
    }
    return fragment;
  }

  function renderResult() {
    const editing = editingResult;
    el('rendered').hidden = editing || !hasResult();
    el('result').hidden = !editing;
    if (!editing && hasResult()) el('rendered').replaceChildren(markdownBlock(el('result').value.split('\n')));
  }

  function preview(text) {
    el('result').value = text;
    editingResult = false;
    detailsVisible = !compact;
    taskVisible = true;
    // An empty reply leaves the card with its title and nothing else: no sentence is needed to
    // explain that there is no text.
    setTask('complete', text.replace(/\s+/g, ' ').trim());
    render();
  }

  /**
   * Establish the bound target, then start consuming commands.
   *
   * This runs only after the Host reports the task ready, because the initial read travels to the
   * page MAIN world through the same authenticated task identity as every other page call. Doing
   * it earlier meant an unauthenticated read against a task the Host had not bound yet.
   */
  async function beginTarget(task) {
    const initial = await task.kernel.begin(task.page, task.anchor).catch(error => ({ ok: false, code: error?.code }));
    // A selection that cannot be written (read-only page text, a cross-block range) still binds the
    // task: the model can read the page and work from refs it reads. Only an unbound task stops here.
    if (!initial.ok && !initial.bound) { setTask('error', panelError(initial.code)); task.control.abort(); return; }
    if (task.control.signal.aborted) return;
    task.initial = initial;
    await task.channel.start(task.page, task.control.signal);
  }

  async function generate(retry = false) {
    if (!anchor || busy() || applying || sessionWorking) return;
    if (location.href !== anchor.url) { status('网页已切换，请重新选择目标。', true); return; }
    const pinned=anchor, instruction=retry?taskTitle:el('instruction').value.trim();
    if(!instruction)return;
    cancel();
    const mine=generation;
    const id=crypto.randomUUID();requestId=id;
    const page={version:2,taskId:id,selectionId:pinned.selectionId,documentId:pageDocumentId,token:crypto.randomUUID()+crypto.randomUUID(),url:location.href};
    const control=new AbortController();let channel;
    const task={page,control,kernel:null,channel:null,lastEdit:null,ready:false};currentPageTask=task;
    const bridge=async spec=>{
      const cmd=channel?.currentCommand;
      const message=cmd?{type:'page-model',pageSession:page,commandId:cmd.commandId,leaseId:cmd.leaseId,spec}:{type:'page-inspect',pageSession:page,spec};
      const reply=await send(message);
      return reply?.ok?reply.result:{ok:false,code:'BRIDGE_UNAVAILABLE',message:reply?.error?.message||'编辑器桥不可用',modification:spec.action==='edit'?'unknown':'not-modified',verification:'none',retryable:false};
    };
    task.kernel=new globalThis.DSHPageKernel.Kernel({document,location,documentId:pageDocumentId,bridge,fetchImage:imageFetcher(page,()=>channel?.currentCommand)});
    taskKind='rewrite';taskTitle=instruction;detailsVisible=false;taskVisible=true;
    if(!retry)el('instruction').value='';el('result').value='';menu(false);status('');setTask('starting','正在读取编辑目标…');resetStream();
    try {
      channel=new globalThis.DSHPageChannel.Channel({send,kernel:task.kernel,onOutcome:outcome=>{
        if(outcome.code!=='READ')task.lastEdit=outcome;
      }});task.channel=channel;task.anchor=pinned;
      phaseTimer=setTimeout(()=>{if(mine===generation&&busy()&&!askId)setTask('thinking','正在处理…');},700);
      const reply=await sendStream({type:'rewrite',requestId:id,selectionId:pinned.selectionId,mode:pinned.mode,text:pinned.text,url:pinned.url,title:pinned.title,instruction,pageSession:page,pageContext:{version:2,referenceContext:pinned.pageContext}});
      await channel.stop();
      if(mine!==generation||!panel)return;
      clearTimeout(phaseTimer);requestId=null;
      if(!reply?.ok||typeof reply.replacement!=='string'){
        // The Host's own message is the only usable diagnosis (401/400/500 all used to
        // collapse into one sentence). Keep the old text as the no-detail fallback.
        const detail=reply?.error?.message||reply?.error?.code;
        setTask('error',detail?('任务连接失败：'+String(detail).slice(0,160)):'任务连接失败，请重试。');
        return;
      }
      if(reply.sessionId)binding=reply.binding||{sessionId:reply.sessionId};
      const envelope=parseEnvelope(reply.replacement);preview(envelope?envelope.text:reply.replacement);
      const edit=task.lastEdit;
      // The card state carries the outcome; a sentence would only repeat it. A write we could not
      // confirm is deliberately not marked applied - the document is on screen either way.
      if(edit?.ok&&edit.modification==='modified') setTask('applied','');
      // Replies are display-only. No automatic or manual reply-to-editor path exists.
    } catch(error){if(mine===generation&&panel)setTask('error',panelError(error?.code));}
    finally {
      clearTimeout(phaseTimer);
      if(channel)await channel.stop();
      if(requestId===id)requestId=null;
      if(currentPageTask===task)currentPageTask=null;
      // Handed to the side panel mid-run: the panel keeps the page once this run lets it go.
      if(handedOff&&!leaseTask)void startLease();
    }
  }

  // Reply envelopes are legacy display-only data. Never dispatch editing from a reply.
  function parseEnvelope(value) {
    try { const parsed=JSON.parse(String(value));return parsed&&['answer','write'].includes(parsed.kind)&&typeof parsed.text==='string'?parsed:null; }
    catch{return null;}
  }

  /**
   * Hand the conversation to the side panel. The click is the user gesture sidePanel.open() needs, so
   * the request leaves immediately; the capsule steps aside only once Chrome has actually opened it.
   * A run in flight keeps running on the Host, and the panel shows it live.
   */
  let handedOff = null;
  async function toPanel() {
    if (!anchor || sessionWorking || applying) return;
    const pinned = anchor;
    const reply = await send({ type: 'open-panel', url: pinned.url, title: pinned.title, sessionId: binding?.sessionId });
    if (!reply?.ok) { if (panel) status(reply?.error?.message || '无法打开侧边栏。', true); return; }
    handedOff = { anchor: pinned, retries: 0 };
    menu(false);
    // Leave the run alone (it continues on the Host) and drop only the capsule's own surface.
    section.hidden = true; el('marker').hidden = true;
    // The capsule that would show this run's approvals is hidden now: the panel answers them.
    if (busy()) { hideAsk(); try { streamPort?.postMessage({ type: 'surface', surface: 'gui' }); } catch { /* run already ended */ } }
    else void startLease();
  }

  /**
   * Side-panel lease: keep this page reachable for every turn the panel starts, not only the run the
   * capsule began. It reuses the handed-over selection as the initial target and consumes page
   * commands exactly like a capsule run; its approvals and questions are answered in the panel.
   */
  let leaseTask = null;
  const LEASE_RETRIES = 5;
  async function startLease() {
    if (!handedOff || leaseTask || currentPageTask) return;
    const pinned = handedOff.anchor;
    if (location.href !== pinned.url) { panelLog('lease/skip', { reason: 'url-changed' }); return; }
    let port = null;
    try { port = chrome.runtime.connect({ name: 'dsh-lease' }); } catch { port = null; }
    if (!port) return;
    const id = crypto.randomUUID();
    const page = { version: 2, taskId: id, selectionId: pinned.selectionId, documentId: pageDocumentId, token: crypto.randomUUID() + crypto.randomUUID(), url: location.href };
    const control = new AbortController();
    const task = { page, control, port, kernel: null, channel: null, anchor: pinned, lease: true };
    leaseTask = task;
    const bridge = async spec => {
      const cmd = task.channel?.currentCommand;
      const message = cmd ? { type: 'page-model', pageSession: page, commandId: cmd.commandId, leaseId: cmd.leaseId, spec } : { type: 'page-inspect', pageSession: page, spec };
      const reply = await send(message);
      return reply?.ok ? reply.result : { ok: false, code: 'BRIDGE_UNAVAILABLE', message: reply?.error?.message || '编辑器桥不可用', modification: spec.action === 'edit' ? 'unknown' : 'not-modified', verification: 'none', retryable: false };
    };
    task.kernel = new globalThis.DSHPageKernel.Kernel({ document, location, documentId: pageDocumentId, bridge, fetchImage: imageFetcher(page, () => task.channel?.currentCommand) });
    task.channel = new globalThis.DSHPageChannel.Channel({ send, kernel: task.kernel });
    const end = reason => {
      if (leaseTask !== task) return;
      leaseTask = null;
      control.abort();
      void task.channel.stop();
      try { port.disconnect(); } catch { /* already gone */ }
      panelLog('lease/end', { reason });
      // An unexpected loss (worker restart, socket drop) while the panel is still open: bind again.
      if (handedOff && reason !== 'host-ended' && reason !== 'failed' && handedOff.retries < LEASE_RETRIES) {
        handedOff.retries += 1;
        setTimeout(() => void startLease(), 500 * handedOff.retries);
      }
    };
    task.end = end;
    port.onDisconnect.addListener(() => end('port'));
    port.onMessage.addListener(async reply => {
      if (!reply || leaseTask !== task) return;
      if (reply.type === 'wake') { task.channel.wake(); return; }
      if (reply.type === 'ended') { end(reply.code === 'TASK_ENDED' ? 'host-ended' : 'socket'); return; }
      if (reply.type === 'error') { panelLog('lease/failed', { message: String(reply.message || '').slice(0, 80) }); end('failed'); return; }
      if (reply.type !== 'ready') return;
      if (reply.sessionId) binding = { sessionId: reply.sessionId };
      handedOff.retries = 0;
      // The selection may have been rewritten by the run that preceded the handoff. begin() then
      // refuses the stale target but still binds the task, so document-wide reads keep working.
      const initial = await task.kernel.begin(page, pinned).catch(error => ({ ok: false, code: error?.code }));
      panelLog('lease/ready', { initial: initial?.ok ? 'target' : String(initial?.code || 'none') });
      if (leaseTask !== task || control.signal.aborted) return;
      await task.channel.start(page, control.signal);
    });
    port.postMessage({ type: 'lease', requestId: id, selectionId: pinned.selectionId, url: page.url, title: pinned.title, pageSession: page });
  }
  function stopLease() { leaseTask?.end?.('panel-closed'); }

  /** The panel handed back: show the capsule again where it was, on the same conversation. */
  function fromPanel(sessionId) {
    if (!handedOff) return;
    const back = handedOff.anchor;
    handedOff = null;
    stopLease();
    // A run still in flight shows its next approval in the capsule again.
    if (busy()) { try { streamPort?.postMessage({ type: 'surface', surface: 'page' }); } catch { /* run already ended */ } }
    if (sessionId) binding = { sessionId };
    if (!anchor) anchor = back;
    panel = true;
    section.hidden = false;
    render();
    position(section, anchor.rect);
    renderBinding();
  }

  chrome.runtime.onMessage?.addListener(message => {
    if (message && message.type === 'panel-closed') fromPanel(typeof message.sessionId === 'string' ? message.sessionId : null);
  });
  async function desktop() {
    status('桌面交接暂不可用。', true);
  }

  const inUI = event => event.composedPath().includes(host);
  let uiPointerHeld = false;
  // Window capture precedes editor document handlers that may synchronously
  // blur the source. Keep its anchor until the UI click can open the composer.
  const uiPointerDown = event => {
    uiPointerHeld = inUI(event);
    if (!uiPointerHeld) return;
    clearTimeout(markerTimer);
    clearTimeout(captureTimer);
  };
  const pointerCancel = () => {
    uiPointerHeld = false;
    pointerHeld = false;
    if (!panel) hideMarker();
  };
  const pointer = event => {
    if (inUI(event) || pointerHeld) return;
    if (!panel) { clearTimeout(captureTimer); captureTimer = setTimeout(() => capture(event.type === 'mouseup'), 40); }
  };
  const pointerDown = event => {
    if (inUI(event)) return;
    pointerHeld = true;
    rememberDismissedRange();
    hideMarker();
  };
  const pointerUp = event => { pointerHeld = false; pointer(event); outside(event); uiPointerHeld = false; };
  const outside = event => {
    if (inUI(event) || !panel) return;
    menu(false);
    // An unused composer should not leave another floating icon over the page.
    if (taskState === 'idle') { close(); pointer(event); return; }
    if (!compact) { compact = true; detailsVisible = false; render(); }
    // Explicitly started tasks survive loss of page focus; a fresh selection may start the next one.
    if (!busy() && !applying) {
      clearTimeout(captureTimer);
      captureTimer = setTimeout(() => {
        const fresh = readAnchor();
        if (fresh && !sameAnchor(anchor, fresh)) { close(); showMarker(fresh, true); }
      }, 60);
    }
  };
  function editableOwner(node) {
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node;
    let owner = element(node);
    if (!owner?.isContentEditable) return null;
    while (owner.parentElement?.isContentEditable) owner = owner.parentElement;
    return owner;
  }
  const focusIn = event => {
    if (inUI(event) || uiPointerHeld) return;
    typingEditor = null;
    if (!editableOwner(event.target)) { rememberDismissedRange(); hideMarker(); return; }
    if (!panel) { clearTimeout(captureTimer); captureTimer = setTimeout(() => capture(true), 40); }
  };
  const focusOut = event => {
    if (inUI(event) || event.relatedTarget === host || uiPointerHeld) return;
    typingEditor = null;
    composingEditor = null;
    rememberDismissedRange();
    hideMarker();
  };
  const typing = event => {
    if (inUI(event) || applying) return;
    const editor = editableOwner(event.target);
    if (!editor) return;
    typingEditor = editor;
    hideMarker();
  };
  const compositionStart = event => { if (!inUI(event)) { composingEditor = editableOwner(event.target); typing(event); } };
  const compositionEnd = event => { if (!inUI(event)) { composingEditor = null; typing(event); } };
  const keyDown = event => {
    if (inUI(event)) return;
    // Markdown replay dispatches its own Space/Enter on the page, and this
    // listener runs in the capture phase, so it would otherwise read our replay
    // as the user typing and fold the panel away mid-operation.
    if (replaying) return;
    if (event.key === 'Escape') hideMarker();
    if ((event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) ||
        ['Backspace', 'Delete', 'Enter', 'Process'].includes(event.key) || event.isComposing) typing(event);
  };
  const key = event => {
    if (event.key === 'Escape') {
      if (!panel) return;
      // While the raw result editor is open, Escape only leaves editing.
      if (editingResult) { editingResult = false; render(); return; }
      if (!el('menu').hidden) { menu(false); el('add').focus(); }
      else if (!compact) collapse();
      else if (taskVisible && taskState !== 'idle') { taskVisible = false; render(); }
      else close();
    } else pointer(event);
  };
  const suspend = () => { pageSuspended = true; pointerHeld = false; uiPointerHeld = false; hideMarker(); };
  const resume = () => { pageSuspended = false; };
  const visibility = () => { if (document.hidden) suspend(); else resume(); };
  const scroll = event => {
    if (inUI(event)) return;
    // Focusing an off-screen field scrolls it into view before its hint is captured.
    // Hide an existing hint, but keep that pending focus capture alive.
    if (!panel) hideMarker(false, false);
  };
  const resize = () => {
    // A viewport change may invalidate the side chosen earlier in the session.
    panelSide = null;
    if (panel) scheduleLayout();
    else if (anchor && !el('marker').hidden) position(el('marker'), anchor.rect);
  };
  const layoutObserver = new ResizeObserver(scheduleLayout);
  layoutObserver.observe(section);
  const contourObserver = new ResizeObserver(entries => entries.forEach(entry => paintContour(entry.target)));
  contourObserver.observe(shadow.querySelector('.ask'));
  contourObserver.observe(el('task'));
  window.addEventListener('pointerdown', uiPointerDown, true);
  window.addEventListener('pointercancel', pointerCancel, true);
  document.addEventListener('pointerdown', pointerDown, true);
  document.addEventListener('mouseup', pointerUp);
  document.addEventListener('focusin', focusIn);
  document.addEventListener('focusout', focusOut);
  document.addEventListener('keydown', keyDown, true);
  document.addEventListener('beforeinput', typing, true);
  document.addEventListener('input', typing, true);
  document.addEventListener('compositionstart', compositionStart, true);
  document.addEventListener('compositionend', compositionEnd, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', suspend);
  window.addEventListener('focus', resume);
  document.addEventListener('keyup', key);
  document.addEventListener('selectionchange', pointer);
  document.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  el('marker').addEventListener('mousedown', event => event.preventDefault());
  el('marker').addEventListener('click', open);
  el('close').addEventListener('click', close);
  el('collapse').addEventListener('click', collapse);
  el('edit').addEventListener('click', expand);
  el('add').addEventListener('click', () => menu(el('menu').hidden));
  el('generate').addEventListener('click', () => void generate());
  el('instruction').addEventListener('input', render);
  el('instruction').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void generate(); }
  });
  el('to-panel').addEventListener('click', () => void toPanel());
  el('desktop').addEventListener('click', () => void desktop());
  el('retry').addEventListener('click', () => { if (taskKind === 'desktop') void desktop(); else void generate(true); });
  el('cancel-task').addEventListener('click', () => { cancel(); menu(false); setTask('error', '任务已取消，可以重试。'); });
  el('settings').addEventListener('click', () => { menu(false); void send({ type: 'options' }); });
  for (const id of ['session-new', 'session-list', 'session-bind', 'session-detach']) el(id).addEventListener('click', () => void sessionAction(id));
  el('session-select').addEventListener('change', () => { el('session-id').value = el('session-select').value; });
  el('task-summary').addEventListener('click', () => { if (hasResult()) { detailsVisible = !detailsVisible; render(); } });
  // The rendered view is the default; clicking it swaps in the raw editor, and
  // leaving the editor renders again. Replace always writes the raw text.
  // The completion mark confirms the task: while the body is open it folds the
  // card back to its capsule form, and from the capsule it closes the capsule.
  el('complete').addEventListener('click', () => {
    if (!hasResult()) return;
    if (detailsVisible) { detailsVisible = false; render(); return; }
    close();
  });
  el('rendered').addEventListener('click', () => {
    if (!hasResult()) return;
    editingResult = true;
    detailsVisible = true;
    render();
    el('result').focus();
    el('result').style.height = 'auto';
    el('result').style.height = Math.min(160, el('result').scrollHeight + 2) + 'px';
  });
  el('result').addEventListener('blur', () => {
    if (!editingResult) return;
    editingResult = false;
    render();
  });

  globalThis.__dshSelectionDispose = () => {
    const previousTask=currentPageTask;
    close();
    void previousTask?.kernel?.dispose();
    cancelAnimationFrame(layoutFrame);
    shadowObserver.disconnect();
    layoutObserver.disconnect();
    contourObserver.disconnect();
    window.removeEventListener('pointerdown', uiPointerDown, true);
    window.removeEventListener('pointercancel', pointerCancel, true);
    document.removeEventListener('pointerdown', pointerDown, true);
    document.removeEventListener('mouseup', pointerUp);
    document.removeEventListener('focusin', focusIn);
    document.removeEventListener('focusout', focusOut);
    document.removeEventListener('keydown', keyDown, true);
    document.removeEventListener('beforeinput', typing, true);
    document.removeEventListener('input', typing, true);
    document.removeEventListener('compositionstart', compositionStart, true);
    document.removeEventListener('compositionend', compositionEnd, true);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('blur', suspend);
    window.removeEventListener('focus', resume);
    document.removeEventListener('keyup', key);
    document.removeEventListener('selectionchange', pointer);
    document.removeEventListener('scroll', scroll, true);
    window.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('scroll', resize);
    host.remove();
    delete globalThis.__dshSelectionDispose;
  };
})();
