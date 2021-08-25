import * as HEADERS from './internal/headers';
import * as ROUTES from './internal/routes';
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

	private current?: string;
	private sorted: string[];

	constructor(state: DurableObjectState, env: T) {
		this.storage = state.storage;
		this.uid = state.id.toString();
		this.target = this.link(env);
		this.sorted = [];
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
		if (pathname === ROUTES.CLOSE) {
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
		let sid = await this.storage.get<string|void>(`rid:${rid}`) || this.current || this.sorted[0];
		if (sid != null) alive = await this.storage.get<number|void>(`sid:${sid}`);

		console.log('[GATEWAY][fetch] storage.exists', { sid, alive });

		if (alive != null && this.limit >= ++alive) {
			// use this shard if found & not over limit
			console.log('IF-OK', { sid, limit: this.limit, alive });
		} else {
			console.log('ELSE', { sid, alive, limit: this.limit });

			// if aware of existing shards, sort & get most free
			// NOTE: `sync` only keeps buckets if `alive` <= limit
			let pair = this.sorted.length > 0 && await this.#sort();

			if (pair) {
				sid = pair[0].substring(4);
				alive = pair[1] + 1;
			} else {
				sid = await this.clusterize(request).toString();
				console.log('~> ELSE NEW:', { sid });
				this.sorted.unshift(sid); // front
				alive = 1;
			}
		}

		this.current = (alive < this.limit) ? sid : undefined;

		shard = this.target.get(sid);
		await this.storage.put<string>(`rid:${rid}`, sid);
		await this.storage.put<number>(`sid:${sid}`, alive);
		console.log('[GATEWAY] storage.put', { sid, alive });

		// Attach indentifiers / hash keys
		request.headers.set(HEADERS.GATEWAYID, this.uid);
		request.headers.set(HEADERS.CLIENTID, rid);
		request.headers.set(HEADERS.SHARDID, sid);

		// let keys = await this.storage.list();
		// console.log({ keys });

		return shard.fetch(request);
	}

	/**
	 * Sort all "sid:" entries by most available.
	 * Save the sorted list as `this.sorted` property.
	 * Return the most-available entry.
	 */
	async #sort(): Promise<[string, number] | void> {
		console.log('[GATEWAY] SORTING');
		let buckets = [...await this.storage.list<number>({ prefix: 'sid:' })];
		if (buckets.length > 1) buckets.sort((a, b) => a[1] - b[1]);

		// ignore shards >= limit
		//   and only keep the IDs
		let i=0, list: string[] = [];
		let bucket: typeof buckets[0] | void;
		for (; i < buckets.length; i++) {
			if (buckets[i][1] < this.limit) {
				if (!bucket) bucket = buckets[i];
				list.push(buckets[i][0]);
			}
		}

		this.sorted = list;

		console.log('[GATEWAY] SORTING ~> DONE:', { list });
		// console.log('[GATEWAY] SORTING ~> DONE:', { buckets, list });

		return bucket;
	}

	async #close(req: Request): Promise<Response> {
		var { rid, sid, gid } = utils.validate(req);
		if (gid !== this.uid) throw new Error('Mismatch: Gateway ID');

		await this.storage.delete(`rid:${rid}`);

		let key = `sid:${sid}`;
		let alive = await this.storage.get<number>(key);
		if (alive == null) throw new Error('Unknown: Shard ID');

		alive = Math.max(0, --alive);
		await this.storage.put<number>(key, alive);
		console.log('[GATEWAY][counter]', { sid, alive });

		// sort by availability
		let bucket = await this.#sort();
		this.current = bucket ? bucket[0].substring(4) : undefined;

		return new Response('OK');
	}
}
