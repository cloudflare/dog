import { Gateway } from '$lib/index';
import { SHA256 } from 'worktop/crypto';

import type { Bindings } from './types';

export class Lobby extends Gateway<Bindings> {
	// limit = 50;
	limit = 2;

	link(env: Bindings) {
		return env.ROOM;
	}

	// Generate client unique identifier
	identify(req: Request): Promise<string> {
		// let ident = req.headers.get('cf-connecting-ip') || 'anon';
		let ident = req.headers.get('sec-websocket-key') || 'anon'; // remove
		let { searchParams } = new URL(req.url);
		ident += searchParams.get('name') || '';
		return SHA256(ident);
	}

	// Group requests by colo
	// clusterize(req: Request): DurableObjectId {
	// 	return this.target.newUniqueId({ jurisdiction: req.cf.country });
	// }
}
