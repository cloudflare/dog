import type { Group, Replica } from 'dog';

// TODO: Remove the intersection types?
export interface Bindings extends ModuleWorker.Bindings {
	LOBBY: DurableObjectNamespace & Group<Bindings>;
	ROOM: DurableObjectNamespace & Replica<Bindings>;
}
