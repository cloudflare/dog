import * as HEADERS from './internal/headers';
import * as ROUTES from './internal/routes';
import * as utils from './internal/utils';

import type * as DOG from 'dog';
import type { RequestID, ReplicaID } from 'dog';

// NOTE: Private
type LiveCount = number;
type BucketTuple = [ReplicaID, LiveCount];

export abstract class Group<T extends ModuleWorker.Bindings> implements DOG.Group<T> {
	public abstract limit: number;
	public readonly uid: string;

	readonly #child: DurableObjectNamespace;
	readonly #mapping: Map<RequestID, ReplicaID>;
	readonly #kids: Map<ReplicaID, LiveCount>;

	#sorted: ReplicaID[];
	#current?: ReplicaID;

	constructor(state: DurableObjectState, env: T) {
		this.uid = state.id.toString();
		this.#mapping = new Map;
		this.#kids = new Map;
		this.#sorted = [];

		let refs = this.link(env);
		this.#child = refs.child;
	}

	/**
	 * Define Group / Replica relationships.
	 * @NOTE User-supplied logic/function.
	 */
	abstract link(bindings: T): {
		child: DurableObjectNamespace & DOG.Replica<T>;
		self: DurableObjectNamespace & DOG.Group<T>;
	};

	/**
	 * Generate a unique identifier for the request.
	 * @NOTE User-supplied logic/function.
	 */
	abstract identify(req: Request): Promise<RequestID> | RequestID;

	/**
	 * Generate a `DurableObjectId` for the next Replica in cluster.
	 */
	clusterize(req: Request, target: DurableObjectNamespace): Promise<DurableObjectId> | DurableObjectId {
		return target.newUniqueId();
	}

	/**
	 * Receive the request & figure out where to send it.
	 */
	async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
		let request = new Request(input, init);
		let { pathname } = new URL(request.url, 'foo://');

		// ~> internal REPLICA request
		if (pathname === ROUTES.CLOSE) {
			try {
				return await this.#close(request);
			} catch (err) {
				return utils.abort(400, (err as Error).message);
			}
		}

		let rid = await this.identify(request);

		let alive: number | void;
		let sid = this.#mapping.get(rid) || this.#current || this.#sorted[0];
		if (sid != null) alive = this.#kids.get(sid);

		if (alive != null && this.limit >= ++alive) {
			// use this replica if found & not over limit
		} else {
			// if aware of existing replicas, sort & get most free
			// NOTE: `sync` only keeps buckets if `alive` <= limit
			let pair = this.#sorted.length > 0 && await this.#sort();

			if (pair) {
				sid = pair[0];
				alive = pair[1] + 1;
			} else {
				sid = await this.clusterize(request, this.#child).toString();
				this.#welcome(sid); // no await!
				alive = 1;
			}
		}

		this.#current = (alive < this.limit) ? sid : undefined;

		this.#mapping.set(rid, sid);
		this.#kids.set(sid, alive);

		// Attach indentifiers / hash keys
		request.headers.set(HEADERS.GROUPID, this.uid);
		request.headers.set(HEADERS.CLIENTID, rid);
		request.headers.set(HEADERS.OBJECTID, sid);

		return utils.load(this.#child, sid).fetch(request);
	}

	/**
	 * Notify existing REPLICAs of a new neighbor.
	 * @param {ReplicaID} nid  The newly created REPLICA identifier.
	 */
	async #welcome(nid: ReplicaID): Promise<void> {
		// get read-only copy
		let items = [...this.#kids.keys()];
		this.#sorted.unshift(nid);
		this.#kids.set(nid, 1);

		if (items.length > 0) {
			await Promise.all(
				items.map(sid => Promise.all([
					this.#introduce(nid, sid),
					this.#introduce(sid, nid),
				]))
			);
		}
	}

	/**
	 * Introduce `stranger` to the existing `target` replica.
	 */
	#introduce(stranger: ReplicaID, target: ReplicaID): Promise<Response> {
		let headers = new Headers;
		headers.set(HEADERS.OBJECTID, target);
		headers.set(HEADERS.NEIGHBORID, stranger);
		headers.set(HEADERS.GROUPID, this.uid);

		let stub = utils.load(this.#child, target);
		return stub.fetch(ROUTES.NEIGHBOR, { headers });
	}

	/**
	 * Sort all "sid:" entries by most available.
	 * Save the sorted list as `this.sorted` property.
	 * Return the most-available entry.
	 */
	async #sort(): Promise<BucketTuple | void> {
		let tuples: BucketTuple[] = [ ...this.#kids ];

		if (tuples.length > 1) {
			tuples.sort((a, b) => a[1] - b[1]);
		}

		let i=0, list: ReplicaID[] = [];
		let bucket: BucketTuple | void;
		for (; i < tuples.length; i++) {
			// ignore buckets w/ active >= limit
			if (tuples[i][1] < this.limit) {
				if (!bucket) bucket = tuples[i];
				list.push(tuples[i][0]); // keep replica id
			}
		}

		this.#sorted = list;

		return bucket;
	}

	async #close(req: Request): Promise<Response> {
		var { rid, oid, gid } = utils.validate(req);
		if (gid !== this.uid) throw new Error('Mismatch: Group ID');

		let alive = this.#kids.get(oid);
		if (alive == null) throw new Error('Unknown: Replica ID');

		alive = Math.max(0, --alive);
		this.#kids.set(oid, alive);

		if (req.headers.get(HEADERS.ISEMPTY) === '1') {
			this.#mapping.delete(rid);
		}

		// sort by availability
		let bucket = await this.#sort();
		this.#current = bucket ? bucket[0] : undefined;

		return new Response('OK');
	}
}
