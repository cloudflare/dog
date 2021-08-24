import * as HEADERS from './internal/headers';
import * as utils from './internal/utils';

import type { Shard } from './shard';

// STORAGE: `rid:${rid}` => (string) sid
// STORAGE: `sid:${sid}` => (number) "live"

// TODO: should even use storage?
export abstract class Gateway<T extends ModuleWorker.Bindings> {
	public uid: string;
	public abstract limit: number;
	public readonly target: DurableObjectNamespace;
	private storage: DurableObjectStorage;
	private current?: DurableObjectId;

	constructor(state: DurableObjectState, env: T) {
		this.storage = state.storage;
		this.uid = state.id.toString();
		this.target = this.link(env);
	}

	/**
	 * Specify which `Shard` class extension is the target.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): DurableObjectNamespace & Shard<T>;

	/**
	 * Generate a unique identifier for the request.
	 * @NOTE User-supplied logic/function.
	 */
	abstract identify(req: Request): Promise<string> | string;

	/**
	 * Generate a `DurableObjectId` for the shard cluster
	 */
	clusterize(req: Request): Promise<DurableObjectId> | DurableObjectId {
		return this.target.newUniqueId();
	}

	/**
	 * Receive the request & figure out where to send it.
	 */
	async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
		let request = new Request(input, init);
		let { pathname } = new URL(request.url, 'foo://');
		console.log('[GATEWAY][fetch] pathname', pathname);

		// ~> internal SHARD request
		if (pathname === '/~$~/close') {
			try {
				return await this.#close(request);
			} catch (err) {
				return utils.abort(400, (err as Error).message);
			}
		}

		// console.log('[GATEWAY][fetch] request', [...request.headers]);

		let rid = await this.identify(request);
		console.log('[GATEWAY][fetch] rid', rid);

		let shard: DurableObjectStub | void, alive: number | void;
		let sid = await this.storage.get<string|void> (`rid:${rid}`) || this.current;
		if (sid != null) alive = await this.storage.get<number|void>(`sid:${sid}`);

		console.log('[GATEWAY][fetch] storage', { sid, alive });

		if (alive != null && this.limit >= ++alive) {
			// use this shard if found & not over limit
			console.log('IF-OK', { sid, limit: this.limit, alive });
		} else {
			// TODO: look at `this.list` for next available
			// generate a new shard
			console.log('ELSE', { sid, limit: this.limit });
			sid = await this.clusterize(request).toString();
			console.log('~> ELSE NEW:', { sid });
			alive = 1;
		}

		let shardid = sid!.toString();
		shard = this.target.get(shardid);

		await this.storage.put<string>(`rid:${rid}`, shardid);
		await this.storage.put<number>(`sid:${shardid}`, alive);
		console.log('[GATEWAY][counter]', { sid: shardid, alive });

		this.current = (alive < this.limit) ? shardid : undefined;

		// Attach indentifiers / hash keys
		request.headers.set(HEADERS.GATEWAYID, this.uid);
		request.headers.set(HEADERS.SHARDID, shardid);
		request.headers.set(HEADERS.CLIENTID, rid);

		let keys = await this.storage.list();
		console.log({ keys });

		// console.log('[GATEWAY][fetch] internal headers', [...request.headers]);

		return shard.fetch(request);
	}

	async #close(req: Request): Promise<Response> {
		var { rid, sid, gid } = utils.validate(req);
		if (gid !== this.uid) throw new Error('Mismatch: Gateway ID');

		await this.storage.delete(`rid:${rid}`);

		let key = `sid:${sid}`;
		let alive = await this.storage.get<number>(key);
		if (alive == null) throw new Error('Unknown: Shard ID');

		// TODO: sort by availability
		alive = Math.max(0, --alive);
		await this.storage.put<number>(key, alive);
		console.log('[GATEWAY][counter]', { sid, alive });

		this.current = sid;

		return new Response('OK');
	}
}
