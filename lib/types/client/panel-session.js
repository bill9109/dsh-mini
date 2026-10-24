const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
export function followPanelSession(workspace, lists, host = window) {
    const g = host;
    const panel = g.__DSH_PANEL__;
    if (!panel)
        return () => { };
    let wanted = null;
    const ready = () => lists.workspaces.list.getSnapshot().phase === 'ready'
        && lists.sessions.list.getSnapshot().phase === 'ready';
    let timer;
    const flush = () => {
        if (wanted === null || !ready() || timer)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            const id = wanted;
            wanted = null;
            if (id === null)
                return;
            try {
                workspace.openSession(id);
            }
            catch (error) {
                console.warn('dsh-mini-panel: open session failed', error);
            }
        }, 0);
    };
    const open = (id) => {
        if (typeof id !== 'string' || !SESSION_ID.test(id))
            return;
        wanted = id;
        flush();
    };
    const offS = lists.sessions.list.subscribe(flush);
    const offW = lists.workspaces.list.subscribe(flush);
    open(panel.session);
    const onMessage = (event) => {
        if (event.source !== host.parent || host.parent === host)
            return;
        const data = event.data;
        if (data?.type === 'dsh-panel/open-session')
            open(data.sessionId);
    };
    host.addEventListener('message', onMessage);
    return () => { offS(); offW(); clearTimeout(timer); host.removeEventListener('message', onMessage); };
}
