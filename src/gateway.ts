import type { ReqID, Shard } from './shard';
import * as HEADERS from './internal/headers';

// STORAGE: `hash:${ReqID}` => DurableObjectId
// STORAGE: `bucket:${string}` => Bucket

interface Bucket {
	uid: DurableObjectId;
	live: number;
}

export abstract class Gateway<T extends ModuleWorker.Bindings> {
	public uid: string;
	public abstract limit: number;
	public storage: DurableObjectStorage;

	private target: DurableObjectNamespace;
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
	 * Generate a hashed keyname for the Request
	 * @NOTE User-supplied logic/function.
	 */
	abstract identify(req: Request): Promise<string> | string;

	/**
	 * Receive the request & figure out where to send it.
	 */
	async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
		let shard: DurableObjectStub | void;
		let request = new Request(input, init);
		let hash: ReqID = await this.identify(request);

		let uid = await this.storage.get<DurableObjectId | void>(`hash:${hash}`);
		let bucket = uid && await this.storage.get<Bucket | void>(`bucket:${uid}`);

		if (bucket && this.limit - bucket.live > 0) {
			// use this shard
			shard = this.target.get(bucket.uid);
		} else {
			// make a new shard
			uid = this.target.newUniqueId().toString();
			await this.storage.put<DurableObjectId>(`hash:${hash}`, uid);
			shard = this.target.get(uid);
		}

		await this.storage.put<Bucket>(`bucket:${uid}`, {
			uid: shard.id,
			live: (bucket && bucket.live || 0) + 1,
		});

		// Attach indentifiers / hash keys
		request.headers.set(HEADERS.CLIENTID, hash);
		request.headers.set(HEADERS.GATEWAYID, String(this.uid));
		request.headers.set(HEADERS.SHARDID, String(shard.id));

		return shard.fetch(request);
	}
}
