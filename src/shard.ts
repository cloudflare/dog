import * as utils from './internal/utils';
import * as ROUTES from './internal/routes';
import * as HEADERS from './internal/headers';

import type * as DOG from 'dog';

// ---

export type ReqID = string;
export type ShardID = string;

type Pool = Map<ReqID, DOG.State>;

export abstract class Shard<T extends ModuleWorker.Bindings> implements DOG.Shard<T> {
	public readonly uid: string;

	readonly #pool: Pool;
	readonly #neighbors: Set<ShardID>;
	#target: DurableObjectNamespace;
	#ns: DurableObjectNamespace;

	constructor(state: DurableObjectState, env: T) {
		this.uid = state.id.toString();
		this.#target = this.link(env);
		this.#ns = this.self(env);
		this.#neighbors = new Set;
		this.#pool = new Map;
	}

	/**
	 * Specify which `Gateway` class is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): DurableObjectNamespace & DOG.Gateway<T>;

	/**
	 * Self-identify the current `Shard` class.
	 * @NOTE User-supplied logic/function.
	 */
	abstract self(bindings: T): DurableObjectNamespace & Shard<T>;

	/**
	 * Receive the HTTP request.
	 * @NOTE User must call `this.connect` for WS connection.
	 * @NOTE User-supplied logic/function.
	 */
	abstract receive(req: Request): Promise<Response> | Response;

	// This request has connected via WS
	onopen?(socket: DOG.Socket): Promise<void> | void;

	// A message was received
	onmessage?(socket: DOG.Socket, data: string): Promise<void> | void;

	// The connection was closed
	onclose?(socket: DOG.Socket): Promise<void> | void;

	// The connection closed due to error
	onerror?(socket: DOG.Socket): Promise<void> | void;

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

		let socket: DOG.Socket = {
			uid: rid,
			send: server.send.bind(server),
			close: server.close.bind(server),
			broadcast: this.#broadcast.bind(this, gid, rid),
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

		this.#pool.set(rid, {
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
			var { pathname } = new URL(request.url, 'foo://');
			var { rid, gid } = utils.validate(request, this.uid);
		} catch (err) {
			return utils.abort(400, (err as Error).message);
		}

		if (pathname === ROUTES.NEIGHBOR) {
			// rid === HEADERS.NEIGHBORID
			this.#neighbors.add(rid);
			return new Response;
		}

		if (pathname === ROUTES.BROADCAST) {
			try {
				this.#emit(rid, await request.text());
				return new Response;
			} catch (err) {
				let msg = (err as Error).stack;
				return utils.abort(400, msg || 'Error parsing broadcast message');
			}
		}

		let res: Response;

		try {
			return res = await this.receive(request);
		} catch (err) {
			let stack = (err as Error).stack;
			return res = utils.abort(400, stack || 'Error in `receive` method');
		} finally {
			if (res!.status !== 101) await this.#decrement(rid, gid);
		}
	}

	/**
	 * Share a message ONLY with this Shard's connections
	 */
	#emit(sender: ReqID, msg: DOG.Message): void {
		if (typeof msg === 'object') {
			msg = JSON.stringify(msg);
		}

		for (let [rid, state] of this.#pool) {
			rid === sender || state.socket.send(msg);
		}
	}

	/**
	 * Share a message across ALL shards w/in group
	 */
	async #broadcast(gateway: string, sender: ReqID, msg: DOG.Message): Promise<void> {
		let body = typeof msg === 'object'
			? JSON.stringify(msg)
			: msg;

		this.#emit(sender, body);

		let list = [...this.#neighbors];
		if (list.length < 1) return;

		let commons = {
			[HEADERS.GATEWAYID]: gateway,
			[HEADERS.NEIGHBORID]: this.uid,
			[HEADERS.CLIENTID]: sender,
		};

		await Promise.all(
			list.map(sid => {
				let stub = this.#ns.get(sid);
				let headers = new Headers(commons);
				headers.set(HEADERS.SHARDID, sid);
				return stub.fetch(ROUTES.BROADCAST, {
					method: 'POST',
					headers,
					body,
				});
			})
		);
	}

	/**
	 * Tell relevant Gateway object to -1 its count
	 */
	async #decrement(rid: ReqID, gid: string) {
		console.log('[ SHARD ][#decrement]', { gid, rid });

		this.#pool.delete(rid);

		let headers = new Headers;
		headers.set(HEADERS.GATEWAYID, gid);
		headers.set(HEADERS.SHARDID, this.uid);
		headers.set(HEADERS.CLIENTID, rid);

		// Prepare internal request
		// ~> notify Gateway of -1 count
		let gateway = this.#target.get(gid);
		await gateway.fetch(ROUTES.CLOSE, { headers });
	}
}
