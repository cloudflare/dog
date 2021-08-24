import * as utils from './internal/utils';
import * as ROUTES from './internal/routes';
import * as HEADERS from './internal/headers';

import type { Gateway } from './gateway';

// ---

export type ReqID = string;
export type Pool = Map<ReqID, State>;
export type Message = JSON.Object | string;

export interface State {
	gateway: string;
	socket: WebSocket;
}

export interface Socket {
	uid: ReqID;
	send: WebSocket['send'];
	close: WebSocket['close'];
	emit(msg: Message): void;
}

export abstract class Shard<T extends ModuleWorker.Bindings> {
	public readonly uid: string;

	private readonly pool: Pool;
	private target: DurableObjectNamespace;

	constructor(state: DurableObjectState, env: T) {
		this.uid = state.id.toString();
		this.target = this.link(env);
		this.pool = new Map;
	}

	/**
	 * Specify which `Gateway` class is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): DurableObjectNamespace & Gateway<T>;

	/**
	 * Receive the HTTP request.
	 * @NOTE User must call `this.connect` for WS connection.
	 * @NOTE User-supplied logic/function.
	 */
	abstract receive(req: Request): Promise<Response> | Response;

	// This request has connected via WS
	onopen?(socket: Socket): Promise<void> | void;

	// A message was received
	onmessage?(socket: Socket, data: string): Promise<void> | void;

	// The connection was closed
	onclose?(socket: Socket): Promise<void> | void;

	// The connection closed due to error
	onerror?(socket: Socket): Promise<void> | void;

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
			var { rid, gid } = utils.validate(req, this.uid);
		} catch (err) {
			return utils.abort(400, (err as Error).message);
		}

		// TODO: check for `conn.get(rid)` here?
		let { 0: client, 1: server } = new WebSocketPair;

		server.accept();

		let socket: Socket = {
			uid: rid,
			send: server.send.bind(server),
			close: server.close.bind(server),
			emit: this.#emit.bind(this, rid),
		};

		let closer = async (evt: Event) => {
			try {
				if (evt.type === 'error' && this.onerror) await this.onerror(socket);
				else if (this.onclose) await this.onclose(socket);
			} finally {
				console.error('[ SHARD ][closer][finally]', { gid, rid });
				await this.#decrement(rid, gid);
				server.close();
			}
		}

		server.addEventListener('close', closer);
		server.addEventListener('error', closer);

		if (this.onmessage) {
			server.addEventListener('message', evt => {
				// console.log('[  RAW  ][message]', rid, evt);
				this.onmessage!(socket, evt.data);
			});
		}

		if (this.onopen) {
			await this.onopen(socket);
		}

		this.pool.set(rid, {
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
		// console.log('[ SHARD ][fetch] url', request.url);

		try {
			var { rid, gid } = utils.validate(request, this.uid);
		} catch (err) {
			return utils.abort(400, (err as Error).message);
		}

		let res: Response;

		try {
			return res = await this.receive(request);
		} catch (err) {
			return res = utils.abort(400, err.stack || 'Error in `receive` method');
		} finally {
			if (res!.status !== 101) await this.#decrement(rid, gid);
		}
	}

	async #emit(sender: ReqID, msg: Message) {
		if (typeof msg === 'object') {
			msg = JSON.stringify(msg);
		}

		for (let [rid, state] of this.pool) {
			rid === sender || state.socket.send(msg);
		}
	}

	/**
	 * Tell relevant Gateway object to -1 its count
	 */
	async #decrement(rid: ReqID, gid: string) {
		console.log('[ SHARD ][#decrement]', { gid, rid });

		this.pool.delete(rid);

		let headers = new Headers;
		headers.set(HEADERS.GATEWAYID, gid);
		headers.set(HEADERS.SHARDID, this.uid);
		headers.set(HEADERS.CLIENTID, rid);

		// Prepare internal request
		// ~> notify Gateway of -1 count
		let gateway = this.target.get(gid);
		await gateway.fetch(ROUTES.CLOSE, { headers });
	}
}
