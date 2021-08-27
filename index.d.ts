// TODO: tbd
declare namespace JSON {
	type Value = Date | RegExp | string | number | boolean | null | JSON.Object;
	type Object = JSON.Value[] | { [key: string]: JSON.Value };
}

// TODO: support arraybuffer types
export type Message = JSON.Object | string;

export interface State {
	gateway: string;
	socket: WebSocket;
}

export interface Socket {
	uid: string;
	send: WebSocket['send'];
	close: WebSocket['close'];
	broadcast(msg: Message): Promise<void>;
	emit(msg: Message): void;
}

// TODO: ModuleWorker is inherited from source
export abstract class Shard<T extends ModuleWorker.Bindings> {
	readonly uid: string;
	constructor(state: DurableObjectState, env: T);

	/**
	 * Specify which `Gateway` class is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): DurableObjectNamespace & Gateway<T>;

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

	onopen?(socket: Socket): Promise<void> | void;
	onclose?(socket: Socket): Promise<void> | void;
	onerror?(socket: Socket): Promise<void> | void;
	onmessage?(socket: Socket, data: string): Promise<void> | void;

	/** Handle the WS connection upgrade. */
	connect(req: Request): Promise<Response>;

	/** Receive a request from a Gateway object. */
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export abstract class Gateway<T extends ModuleWorker.Bindings> {
	abstract limit: number;
	readonly target: DurableObjectNamespace;
	readonly uid: string;

	constructor(state: DurableObjectState, env: T);

	/**
	 * Specify which `Shard` class extension is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): any & Shard<T>;

	/**
	 * Generate a unique identifier for the request.
	 * @NOTE User-supplied logic/function.
	 */
	abstract identify(req: Request): Promise<string> | string;

	/**
	 * Generate a `DurableObjectId` for the shard cluster.
	 * @default this.target.newUniqueId()
	 */
	clusterize(req: Request): Promise<DurableObjectId> | DurableObjectId;

	/**
	 * Receives the initial request & figures out where to send it.
	 * @NOTE User should NOT redeclare/override this method.
	 */
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}