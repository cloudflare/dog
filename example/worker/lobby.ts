import { Group } from 'dog';
import type { Bindings } from './types';

export class Lobby extends Group<Bindings> {
	limit = 2; // max conns per REPLICA stub

	link(env: Bindings) {
		return {
			child: env.ROOM,
			self: env.LOBBY,
		};
	}

	// Optional: Only create REPLICAs in the "eu" jurisdiction
	// clusterize(req: Request, target: DurableObjectNamespace): DurableObjectId {
	// 	return target.newUniqueId({ jurisdiction: 'eu' });
	// }
}
