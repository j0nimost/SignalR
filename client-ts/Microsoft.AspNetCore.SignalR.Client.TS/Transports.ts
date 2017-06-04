import { DataReceived, TransportClosed } from "./Common"
import { IHttpClient } from "./HttpClient"

export enum TransportType {
    WebSockets,
    ServerSentEvents,
    LongPolling
}

export interface ITransport {
    connect(url: string, queryString: string): Promise<void>;
    send(data: any): Promise<void>;
    stop(): void;
    onDataReceived: DataReceived;
    onClosed: TransportClosed;
}

export class WebSocketTransport implements ITransport {
    private webSocket: WebSocket;

    connect(url: string, queryString: string = ""): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            url = url.replace(/^http/, "ws");
            let connectUrl = url + (queryString ? "?" + queryString : "");

            let webSocket = new WebSocket(connectUrl);

            webSocket.onopen = (event: Event) => {
                console.log(`WebSocket connected to ${connectUrl}`);
                this.webSocket = webSocket;
                resolve();
            };

            webSocket.onerror = (event: Event) => {
                reject();
            };

            webSocket.onmessage = (message: MessageEvent) => {
                console.log(`(WebSockets transport) data received: ${message.data}`);
                if (this.onDataReceived) {
                    this.onDataReceived(message.data);
                }
            }

            webSocket.onclose = (event: CloseEvent) => {
                // webSocket will be null if the transport did not start successfully
                if (this.onClosed && this.webSocket) {
                    if (event.wasClean === false || event.code !== 1000) {
                        this.onClosed(new Error(`Websocket closed with status code: ${event.code} (${event.reason})`));
                    }
                    else {
                        this.onClosed();
                    }
                }
            }
        });
    }

    send(data: any): Promise<void> {
        if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
            this.webSocket.send(data);
            return Promise.resolve();
        }

        return Promise.reject("WebSocket is not in the OPEN state");
    }

    stop(): void {
        if (this.webSocket) {
            this.webSocket.close();
            this.webSocket = null;
        }
    }

    onDataReceived: DataReceived;
    onClosed: TransportClosed;
}

export class ServerSentEventsTransport implements ITransport {
    private eventSource: EventSource;
    private url: string;
    private queryString: string;
    private fullUrl: string;
    private httpClient: IHttpClient;

    constructor(httpClient: IHttpClient) {
        this.httpClient = httpClient;
    }

    connect(url: string, queryString: string): Promise<void> {
        if (typeof (EventSource) === "undefined") {
            Promise.reject("EventSource not supported by the browser.")
        }

        this.queryString = queryString;
        this.url = url;
        this.fullUrl = url + (queryString ? "?" + queryString : "");

        return new Promise<void>((resolve, reject) => {
            let eventSource = new EventSource(this.fullUrl);

            try {
                eventSource.onmessage = (e: MessageEvent) => {
                    if (this.onDataReceived) {
                        try {
                            console.log(`(SSE transport) data received: ${e.data}`);
                            this.onDataReceived(e.data);
                        } catch (error) {
                            if (this.onClosed) {
                                this.onClosed(error);
                            }
                            return;
                        }
                    }
                };

                eventSource.onerror = (e: ErrorEvent) => {
                    reject();

                    // don't report an error if the transport did not start successfully
                    if (this.eventSource && this.onClosed) {
                        this.onClosed(new Error(e.message || "Error occurred"));
                    }
                }

                eventSource.onopen = () => {
                    console.log(`SSE connected to ${this.fullUrl}`);
                    this.eventSource = eventSource;
                    resolve();
                }
            }
            catch (e) {
                return Promise.reject(e);
            }
        });
    }

    async send(data: any): Promise<void> {
        return send(this.httpClient, this.fullUrl, data);
    }

    stop(): void {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    onDataReceived: DataReceived;
    onClosed: TransportClosed;
}

export class LongPollingTransport implements ITransport {
    private url: string;
    private queryString: string;
    private fullUrl: string;
    private httpClient: IHttpClient;
    private pollXhr: XMLHttpRequest;
    private shouldPoll: boolean;

    constructor(httpClient: IHttpClient) {
        this.httpClient = httpClient;
    }

    connect(url: string, queryString: string): Promise<void> {
        this.url = url;
        this.queryString = queryString;
        this.shouldPoll = true;
        this.fullUrl = url + (queryString ? "?" + queryString : "");
        this.poll(this.fullUrl);
        return Promise.resolve();
    }

    private poll(url: string): void {
        if (!this.shouldPoll) {
            return;
        }

        let pollXhr = new XMLHttpRequest();

        pollXhr.onload = () => {
            if (pollXhr.status == 200) {
                if (this.onDataReceived) {
                    try {
                        console.log(`(LongPolling transport) data received: ${pollXhr.response}`);
                        this.onDataReceived(pollXhr.response);
                    } catch (error) {
                        if (this.onClosed) {
                            this.onClosed(error);
                        }
                        return;
                    }
                }
                this.poll(url);
            }
            else if (this.pollXhr.status == 204) {
                if (this.onClosed) {
                    this.onClosed();
                }
            }
            else {
                if (this.onClosed) {
                    this.onClosed(new Error(`Status: ${pollXhr.status}, Message: ${pollXhr.responseText}`));
                }
            }
        };

        pollXhr.onerror = () => {
            if (this.onClosed) {
                // network related error or denied cross domain request
                this.onClosed(new Error("Sending HTTP request failed."));
            }
        };

        pollXhr.ontimeout = () => {
            this.poll(url);
        }

        this.pollXhr = pollXhr;
        this.pollXhr.open("GET", url, true);
        // TODO: consider making timeout configurable
        this.pollXhr.timeout = 110000;
        this.pollXhr.send();
    }

    async send(data: any): Promise<void> {
        return send(this.httpClient, this.fullUrl, data);
    }

    stop(): void {
        this.shouldPoll = false;
        if (this.pollXhr) {
            this.pollXhr.abort();
            this.pollXhr = null;
        }
    }

    onDataReceived: DataReceived;
    onClosed: TransportClosed;
}

const headers = new Map<string, string>();
headers.set("Content-Type", "application/vnd.microsoft.aspnetcore.endpoint-messages.v1+text");

async function send(httpClient: IHttpClient, url: string, data: any): Promise<void> {
    await httpClient.post(url, data, headers);
}