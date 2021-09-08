import { Gateway } from 'dog';

import type { Bindings } from './types';

export class Lobby extends Gateway<Bindings> {
	limit = 2; // max conns per SHARD stub

	link(env: Bindings) {
		return {
			child: env.ROOM,
			self: env.LOBBY,
		};
	}

	// Generate client unique identifier
	identify(req: Request): string {
		let { searchParams } = new URL(req.url);
		return searchParams.get('u') || 'anon';
	}

	// Optional: Only create SHARDs in the "eu" jurisdiction
	// clusterize(req: Request, target: DurableObjectNamespace): DurableObjectId {
	// 	return target.newUniqueId({ jurisdiction: 'eu' });
	// }
}
