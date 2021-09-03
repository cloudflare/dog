import { Gateway } from 'dog';
import { SHA256 } from 'worktop/crypto';

import type { Bindings } from './types';

export class Lobby extends Gateway<Bindings> {
	// limit = 50;
	limit = 2;

	link(env: Bindings) {
		return env.ROOM;
	}

	// Generate client unique identifier
	identify(req: Request): string {
		let { searchParams } = new URL(req.url);
		return searchParams.get('u') || 'anon';
		// return SHA256(ident);
	}
	// identify(req: Request): string {
	// 	// let ident = req.headers.get('cf-connecting-ip') || 'anon';
	// 	return req.headers.get('sec-websocket-key')!;
	// }

	// Group requests by colo
	// clusterize(req: Request): DurableObjectId {
	// 	return this.target.newUniqueId({ jurisdiction: 'eu' });
	// }
}
