import * as utils from './internal/utils';
import * as ROUTES from './internal/routes';
import * as HEADERS from './internal/headers';

import type * as DOG from 'dog';

// ---

export type ReqID = string;
export type ShardID = string;

type Pool = Map<ReqID, DOG.State>;

interface Dispatch {
	gateway: string;
	sender: string;
	target?: string;
	route: string;
	body: string;
}

// internal : send message to all websockets
function send(conns: Set<WebSocket>, msg: string) {
	for (let ws of conns) ws.send(msg);
}

export abstract class Shard<T extends ModuleWorker.Bindings> implements DOG.Shard<T> {
	public readonly uid: string;

	readonly #pool: Pool;
	readonly #neighbors: Set<ShardID>;
	readonly #parent: DurableObjectNamespace;
	readonly #self: DurableObjectNamespace;

	constructor(state: DurableObjectState, env: T) {
		this.uid = state.id.toString();
		this.#neighbors = new Set;
		this.#pool = new Map;

		let refs = this.link(env);
		this.#parent = refs.parent;
		this.#self = refs.self;
	}

	/**
	 * Specify which `Gateway` class is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): {
		parent: DurableObjectNamespace & DOG.Gateway<T>;
		self: DurableObjectNamespace & Shard<T>;
	};

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

		let { 0: client, 1: server } = new WebSocketPair;

		server.accept();

		let socket: DOG.Socket = {
			uid: rid,
			send: server.send.bind(server),
			close: server.close.bind(server),
			broadcast: this.#broadcast.bind(this, gid, rid),
			whisper: this.#whisper.bind(this, gid, rid),
			emit: this.#emit.bind(this, rid),
		};

		let closer = async (evt: Event) => {
			try {
				if (evt.type === 'error' && this.onerror) await this.onerror(socket);
				else if (this.onclose) await this.onclose(socket);
			} finally {
				let state = this.#pool.get(rid);
				let isEmpty: boolean;

				if (!state || state.socket.size < 2) {
					this.#pool.delete(rid);
					isEmpty = true;
				} else {
					state.socket.delete(server);
					this.#pool.set(rid, state);
					isEmpty = false;
				}

				await this.#close(rid, gid, isEmpty);
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

		let state: DOG.State = this.#pool.get(rid) || {
			gateway: gid,
			socket: new Set,
		};

		state.socket.add(server);
		this.#pool.set(rid, state);

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
			var { rid, gid, tid } = utils.validate(request, this.uid);
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

		if (pathname === ROUTES.WHISPER) {
			try {
				if (!tid) throw new Error('Missing: Target ID');

				let state = this.#pool.get(tid);
				if (state) send(state.socket, await request.text());

				return new Response;
			} catch (err) {
				let msg = (err as Error).stack;
				return utils.abort(400, msg || 'Error parsing whisper message');
			}
		}

		let res: Response;

		try {
			return res = await this.receive(request);
		} catch (err) {
			let stack = (err as Error).stack;
			return res = utils.abort(400, stack || 'Error in `receive` method');
		} finally {
			if (res!.status !== 101) {
				await this.#close(rid, gid, true);
			}
		}
	}

	/**
	 * Share a message ONLY with this Shard's connections
	 */
	#emit(sender: ReqID, msg: DOG.Message, self?: boolean): void {
		if (typeof msg === 'object') {
			msg = JSON.stringify(msg);
		}

		for (let [rid, state] of this.#pool) {
			if (self || rid !== sender) send(state.socket, msg);
		}
	}

	/**
	 * Share a message across ALL shards w/in group
	 */
	async #broadcast(gateway: string, sender: ReqID, msg: DOG.Message, self?: boolean): Promise<void> {
		let body = typeof msg === 'object'
			? JSON.stringify(msg)
			: msg;

		this.#emit(sender, body, self);

		await this.#dispatch({
			gateway, sender, body,
			route: ROUTES.BROADCAST,
		});
	}

	/**
	 * Construct & send a message to SHARD neighbors.
	 */
	async #dispatch(params: Dispatch) {
		let list = [...this.#neighbors];
		if (list.length < 1) return;

		let commons: HeadersInit = {
			[HEADERS.NEIGHBORID]: this.uid,
			[HEADERS.GATEWAYID]: params.gateway,
			[HEADERS.CLIENTID]: params.sender,
		};

		if (params.target) {
			commons[HEADERS.TARGETID] = params.target;
		}

		await Promise.all(
			list.map(sid => {
				let stub = this.#self.get(sid);
				let headers = new Headers(commons);
				headers.set(HEADERS.SHARDID, sid);
				return stub.fetch(params.route, {
					method: 'POST',
					headers: headers,
					body: params.body,
				});
			})
		);
	}

	/**
	 * Send a Message to a specific Socket within a SHARD.
	 */
	async #whisper(gateway: string, sender: ReqID, target: ReqID, msg: DOG.Message): Promise<void> {
		// TODO: ever allow this?
		if (sender === target) return;

		let body = typeof msg === 'object'
			? JSON.stringify(msg)
			: msg;

		let state = this.#pool.get(target);
		if (state) return send(state.socket, body);

		await this.#dispatch({
			gateway, sender, target, body,
			route: ROUTES.WHISPER
		});
	}

	/**
	 * Tell relevant Gateway object to -1 its count
	 */
	async #close(rid: ReqID, gid: string, isEmpty: boolean) {
		console.log('[ SHARD ][#close]', { gid, rid });

		let headers = new Headers;
		headers.set(HEADERS.GATEWAYID, gid);
		headers.set(HEADERS.SHARDID, this.uid);
		headers.set(HEADERS.CLIENTID, rid);
		headers.set(HEADERS.ISEMPTY, isEmpty ? '1' : '0');

		// Prepare internal request
		// ~> notify Gateway of -1 count
		let gateway = this.#parent.get(gid);
		await gateway.fetch(ROUTES.CLOSE, { headers });
	}
}
