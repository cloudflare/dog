import * as utils from './internal/utils';
import * as HEADERS from './internal/headers';

import type { Gateway } from './gateway';

// ---

export type ReqID = string;
export type Message = JSON.Object | string;

export interface State {
	gateway: string;
	socket?: WebSocket;
}

export interface Socket {
	uid: ReqID;
	send: WebSocket['send'];
	close: WebSocket['close'];
	emit: any; // TODO: typeof broadcast;
}

export type SocketHandler = (socket: Socket) => Promise<void> | void;

// TODO
// export function broadcast(socket) {
// }

// TODO: any benefit in passing `reqid` to user's `receive` method?
export abstract class Shard<T extends ModuleWorker.Bindings> {
	public readonly uid: string;

	private readonly conn: Map<ReqID, State>;
	private target: DurableObjectNamespace;

	constructor(state: DurableObjectState, env: T) {
		this.uid = state.id.toString();
		this.target = this.link(env);
		this.conn = new Map;
	}

	/**
	 * Specify which `Gateway` class is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): DurableObjectNamespace & Gateway<T>;

	// This request has connected via WS
	abstract onopen?: SocketHandler;
	// A message was received
	abstract onmessage?<T>(socket: Socket, data: T): Promise<void> | void;

	// The connection was closed
	abstract onclose?: SocketHandler;
	// The connection closed due to error
	abstract onerror?: SocketHandler;
	// Another connection has joined the pool
	// abstract onconnect?(req: Request): void;
	// Another connection has left the pool
	// abstract ondisconnect?(req: Request): void;

	/**
	 * Receive the HTTP request.
	 * @NOTE User must call `this.connect`
	 * @NOTE User-supplied logic/function.
	 */
	abstract receive(req: Request, reqid: ReqID): Promise<Response> | Response;

	/**
	 * Handle the WS connection upgrade
	 * @todo maybe can only be 400 code?
	 * @modified worktop/ws
	 */
	async connect(req: Request): Promise<Response> {
		// @see https://datatracker.ietf.org/doc/rfc6455/?include_text=1
		// @see https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers
		if (req.method !== 'GET') return utils.abort(405);

		let value = req.headers.get('upgrade');
		if (value !== 'websocket') return utils.abort(426);

		value = (req.headers.get('sec-websocket-key') || '').trim();
		if (!/^[+/0-9A-Za-z]{22}==$/.test(value)) return utils.abort(400);

		value = req.headers.get('sec-websocket-version');
		if (value !== '13') return utils.abort(400);

		try {
			var { rid, gid } = this.#validate(req);
		} catch (err) {
			return utils.abort(400, (err as Error).message);
		}

		// TODO: check for `conn.get(rid)` here
		let { 0: client, 1: server } = new WebSocketPair;

		server.accept();

		let socket: Socket = {
			uid: rid,
			send: server.send.bind(server),
			close: server.close.bind(server),
			emit: server.close.bind(server),
		};

		let closer = async (evt: Event) => {
			try {
				if (evt.type === 'error') {
					if (this.onerror) await this.onerror(socket);
				} else if (this.onclose) {
					await this.onclose(socket);
				}
			} finally {
				server.close();
				await this.#close(rid);
			}
		}

		server.addEventListener('close', closer);
		server.addEventListener('error', closer);

		if (this.onopen) {
			await this.onopen(socket);
		}

		if (this.onmessage) {
			server.addEventListener('message', evt => {
				this.onmessage!(socket, evt.data);
			});
		}

		this.conn.set(rid, {
			gateway: gid,
			socket: server,
		});

		return new Response(null, {
			status: 101,
			statusText: 'Switching Protocols',
			webSocket: client,
		});
	}

	/**
	 * Receive a request from Gateway node
	 */
	async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
		let request = new Request(input, init);

		try {
			var { rid } = this.#validate(request);
		} catch (err) {
			return utils.abort(400, (err as Error).message);
		}

		// if existing connection, then reuse
		// else establish new

		let res: Response;

		try {
			return res = await this.receive(request, rid);
		} catch (err) {
			return res = utils.abort(400, err.stack || 'Error in `receive` method');
		} finally {
			if (res!.status !== 101) {
				await this.#close(rid);
			}
		}
	}

	/**
	 * Ensure the HEADER values exist & match.
	 */
	#validate(req: Request) {
		let sid = req.headers.get(HEADERS.SHARDID);
		if (sid == null) throw new Error('Missing: Shard ID');
		if (sid !== this.uid) throw new Error('Mismatch: Shard ID');

		let rid = req.headers.get(HEADERS.CLIENTID) as ReqID;
		if (rid == null) throw new Error('Missing: Request ID');

		let gid = req.headers.get(HEADERS.GATEWAYID);
		if (gid == null) throw new Error('Missing: Gateway ID');

		return { sid, rid, gid };
	}

	/**
	 *
	 */
	async #close(reqid: ReqID) {
		let conn = this.conn.get(reqid);

		if (conn == null) {
			throw new Error('TODO: what to do?');
		}

		if (conn.socket) {
			conn.socket.close();
		}

		let headers = new Headers;
		headers.set(HEADERS.GATEWAYID, conn.gateway);
		headers.set(HEADERS.CLIENTID, reqid);
		headers.set(HEADERS.SHARDID, String(this.uid));

		// Prepare internal request
		// ~> notify Gateway of -1 count
		let gateway = this.target.get(conn.gateway);
		await gateway.fetch('/$/close', { headers });
	}
}
