import type { Gateway, Shard } from '$lib/index';

// TODO: Remove the intersection types?
export interface Bindings extends ModuleWorker.Bindings {
	Lobby: DurableObjectNamespace & Gateway<Bindings>;
	Room: DurableObjectNamespace & Shard<Bindings>;
}
