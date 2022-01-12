// TODO: tbd
declare namespace JSON {
	type Value = Date | RegExp | string | number | boolean | null | JSON.Object;
	type Object = JSON.Value[] | { [key: string]: JSON.Value };
}

// Socket Messages
// @todo support arraybuffer types
export type Message = JSON.Object | string;

export type RequestID = string;
export type GroupID = string;
export type ReplicaID = string;

export namespace Gossip {
	type Message = {
		[key: string]: JSON.Value;
	};
	type Payload = JSON.Object | JSON.Value;
}

export interface State {
	group: string;
	socket: Set<WebSocket>;
}

export interface Socket {
	/**
	 * The request identifier.
	 * @see {Group.identify}
	 */
	uid: string;
	/**
	 * Send the WebSocket client a string-serializable message.
	 */
	send: WebSocket['send'];
	/**
	 * Close the WebSocket connection.
	 */
	close: WebSocket['close'];
	/**
	 * Send a message to other WebSockets owned by the Replica.
	 * @param {boolean} [self] Send the message to the sender?
	 */
	emit(msg: Message, self?: boolean): void;
	/**
	 * Send a message to ALL WebSockets within the CLUSTER.
	 * @param {boolean} [self] Send the message to the sender?
	 */
	broadcast(msg: Message, self?: boolean): Promise<void>;
	/**
	 * Send a message to a specific WebSocket target.
	 */
	whisper(target: string, msg: Message): Promise<void>;
}

// @see https://github.com/cloudflare/workers-types/pull/102
export type Bindings = Record<string, KVNamespace | DurableObjectNamespace | CryptoKey | string>;

export abstract class Replica<T extends Bindings> {
	readonly uid: string;

	constructor(state: DurableObjectState, env: T);

	/**
	 * Specify which `Group` class is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): {
		parent: DurableObjectNamespace & Group<T>;
		self: DurableObjectNamespace & Replica<T>;
	};

	/**
	 * Receive the HTTP request.
	 * @NOTE User must call `this.connect` for WS connection.
	 * @NOTE User-supplied logic/function.
	 */
	abstract receive(req: Request): Promise<Response> | Response;

	/** The WebSocket client connection was established. */
	onopen?(socket: Socket): Promise<void> | void;
	/** The WebSocket client was closed. */
	onclose?(socket: Socket): Promise<void> | void;
	/** The WebSocket client was closed due to an error. */
	onerror?(socket: Socket): Promise<void> | void;
	/** The WebSocket client sent the Replica a message. */
	onmessage?(socket: Socket, data: string): Promise<void> | void;

	/**
	 * Handle the WS connection upgrade.
	 */
	connect(req: Request): Promise<Response>;

	/**
	 * Send a message (via HTTP) to WebSockets owned by the Replica
	 * @NOTE This is the HTTP-accessible version of `Socket.emit`
	 */
	emit(msg: Message): void;

	/**
	 * Send a message (via HTTP) to ALL WebSockets within the CLUSTER.
	 * @NOTE This is the HTTP-accessible version of `Socket.broadcast`
	 */
	broadcast(msg: Message): Promise<void>;

	/**
	 * Send a message (via HTTP) to a specific WebSocket target.
	 * @NOTE This is the HTTP-accessible version of `Socket.whisper`
	 */
	whisper(target: string, msg: Message): Promise<void>;

	/**
	 * Respond to another Replica's gossip.
	 * @NOTE Must return a JSON-serializable value.
	 */
	ongossip?(msg: Gossip.Message): Promise<Gossip.Payload> | Gossip.Payload;

	/**
	 * Send a message directly to other Replicas.
	 * A `Gossip.Message` must be a JSON object.
	 * Returns a list of `Gossip.Payload`s, one from each Replica sibling.
	 * @NOTE Peer-to-peer communication; does not involve client connections.
	 */
	gossip<M extends Gossip.Message>(msg: M): Promise<Gossip.Payload[]>;

	/**
	 * Receives a request from a Group object.
	 * @IMPORTANT Do NOT define your own `fetch` method!
	 */
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export abstract class Group<T extends ModuleWorker.Bindings> {
	abstract limit: number;
	readonly uid: string;

	constructor(state: DurableObjectState, env: T);

	/**
	 * Specify which `Replica` class extension is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): {
		child: DurableObjectNamespace & Replica<T>;
		self: DurableObjectNamespace & Group<T>;
	};

	/**
	 * Generate a `DurableObjectId` for the Replica cluster.
	 * @default target.newUniqueId()
	 */
	clusterize(req: Request, target: DurableObjectNamespace): Promise<DurableObjectId> | DurableObjectId;

	/**
	 * Receive the HTTP request if not an internal route.
	 * @NOTE Unlike `Replica.receive`, this is optionally defined.
	 *       Useful for supply custom routing/handler logic if the
	 *       incoming `Request` was not significant to the DOG.
	 * @default utils.abort(404)
	 */
	receive(req: Request): Promise<Response> | Response;

	/**
	 * Receives the initial request & figures out where to send it.
	 * @NOTE User should NOT redeclare/override this method.
	 */
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface Family<T extends ModuleWorker.Bindings> {
	parent: DurableObjectNamespace & Group<T>;
	child: DurableObjectNamespace & Replica<T>;
}

export function identify<T extends ModuleWorker.Bindings>(
	groupid: DurableObjectId,
	requestid: RequestID,
	family: Family<T>,
): Promise<DurableObjectStub>;
