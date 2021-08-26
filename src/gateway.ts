import * as HEADERS from './internal/headers';
import * as ROUTES from './internal/routes';
import * as utils from './internal/utils';

import type { Shard, ShardID } from './shard';

// NOTE: Private
type BucketKey = `sid:${ShardID}`;
type BucketTuple = [BucketKey, number];

// STORAGE: `rid:${rid}` => (string) sid
// STORAGE: `sid:${sid}` => (number) "live"

export abstract class Gateway<T extends ModuleWorker.Bindings> {
	public uid: string;
	public abstract limit: number;
	public readonly target: DurableObjectNamespace;
	private storage: DurableObjectStorage;

	private current?: ShardID;
	private sorted: ShardID[];
	private sids: Set<ShardID>;

	constructor(state: DurableObjectState, env: T) {
		this.storage = state.storage;
		this.uid = state.id.toString();
		this.target = this.link(env);
		this.sids = new Set;
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
				this.#welcome(sid); // no await!
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

		return shard.fetch(request);
	}

	/**
	 * Notify existing SHARDs of a new neighbor.
	 * @param {ShardID} nid  The newly created SHARD identifier.
	 */
	async #welcome(nid: ShardID): Promise<void> {
		// get read-only copy
		let items = [...this.sids];
		this.sorted.unshift(nid);
		this.sids.add(nid);

		if (items.length > 0) {
			await Promise.all(
				items.map(sid => {
					let headers = new Headers;
					let stub = this.target.get(sid);
					headers.set(HEADERS.SHARDID, sid);
					headers.set(HEADERS.NEIGHBORID, nid);
					headers.set(HEADERS.GATEWAYID, this.uid);
					console.log('~> before fetch(neighbor)');
					return stub.fetch(ROUTES.NEIGHBOR, { headers });
				})
			);
		}
	}

	/**
	 * Sort all "sid:" entries by most available.
	 * Save the sorted list as `this.sorted` property.
	 * Return the most-available entry.
	 */
	async #sort(): Promise<BucketTuple | void> {
		console.log('[GATEWAY] SORTING');

		let sids = new Set<string>();
		let tuples: BucketTuple[] = [];

		let smap = await this.storage.list<number>({ prefix: 'sid:' }) as Map<BucketKey, number>;

		for (let pair of smap) {
			tuples.push(pair as BucketTuple);
			sids.add(pair[0].substring(4));
		}

		if (tuples.length > 1) {
			tuples.sort((a, b) => a[1] - b[1]);
		}

		// ignore buckets w/ active >= limit
		//   and only keep the bucket IDs
		let i=0, list: BucketKey[] = [];
		let bucket: BucketTuple | void;
		for (; i < tuples.length; i++) {
			if (tuples[i][1] < this.limit) {
				if (!bucket) bucket = tuples[i];
				list.push(tuples[i][0]);
			}
		}

		this.sids = sids;
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
