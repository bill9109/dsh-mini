/**
 * Side-panel carrier: a loopback reverse proxy that serves the real DSH web client
 * (ui-chat, ui-conversation and every other client plugin) to the browser extension's
 * side panel, independent of how the Host was launched.
 *
 * The upstream is this process's own webServer (`dsh web` on 3080, Desktop on 19387).
 * Like the Desktop main process, the proxy holds the upstream browser cookie itself (minted
 * from the launch token in-process) and never hands it to the page. The page authenticates
 * to the proxy with a per-panel secret obtained by exchanging a one-time ticket, which the
 * extension gets from the Bearer-guarded pairing API.
 *
 * Authority: an admitted panel speaks for the operator, exactly like the GUI. Bundles
 * (`/plugins/`) and static assets are public upstream and are forwarded as is.
 */
export declare const PANEL_PORT_DEFAULT = 18766;
export interface PanelUpstream {
    /** Upstream port (the webServer this Host composed). */
    port(): number;
    /** A launch-token URL for the upstream root (`connection.authenticatedUrl`). */
    authenticatedUrl(base: string): string;
}
export declare class PanelProxy {
    private readonly upstream;
    private readonly port;
    private server;
    private cookie;
    private cookieInFlight;
    private readonly tickets;
    private readonly panels;
    private readonly sockets;
    private closed;
    constructor(upstream: PanelUpstream, port: number);
    get url(): string;
    /** Mint a single-use ticket; the iframe URL carries it once and the page never sees the pairing token. */
    issueTicket(session?: string): {
        ticket: string;
        url: string;
        expires: number;
    };
    listen(): Promise<void>;
    close(): Promise<void>;
    private sweep;
    private authorized;
    private extensionOrigin;
    private upstreamCookie;
    private headersFor;
    private handle;
    /** Exchange a ticket for a panel secret and serve the real index with the panel bootstrap first in <head>. */
    private index;
    private fetchIndex;
    /** Stream one request upstream with the proxy-held cookie; retries once on an expired cookie. */
    private forward;
    /** WebSocket mux: authenticate by the panel secret, then splice raw TCP to the upstream with its cookie. */
    private upgrade;
    private fail;
}
