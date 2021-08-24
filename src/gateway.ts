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
	// private current: UID;

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

		console.log('[GATEWAY][fetch] request', [...request.headers]);

		let rid = await this.identify(request);
		console.log('[GATEWAY][fetch] rid', rid);

		let shard: DurableObjectStub | void, alive: number | void;
		let sid = await this.storage.get<string|void> (`rid:${rid}`);
		if (sid != null) alive = await this.storage.get<number|void>(`sid:${sid}`);

		console.log('[GATEWAY][fetch] storage', { sid, alive });

		if (alive != null && this.limit >= ++alive) {
			// use this shard if found & not over limit
			console.log('IF-OK', { sid, limit: this.limit, alive });
		} else {
			// generate a new shard
			console.log('ELSE', { sid, limit: this.limit });
			sid = await this.clusterize(request).toString();
			console.log('~> ELSE NEW:', { sid });
			await this.storage.put<string>(`rid:${rid}`, sid);
			alive = 1;
		}

		shard = this.target.get(sid!);
		await this.storage.put<number>(`sid:${sid!}`, alive);
		console.log('[GATEWAY][counter]', { sid, alive });

		// Attach indentifiers / rid keys
		request.headers.set(HEADERS.CLIENTID, rid);
		request.headers.set(HEADERS.GATEWAYID, this.uid);
		request.headers.set(HEADERS.SHARDID, String(sid!));

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

		return new Response('OK');
	}
}
