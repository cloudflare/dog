import { Gateway } from '$lib/index';
import { SHA256 } from 'worktop/crypto';

import type { Bindings } from './types';

export class Lobby extends Gateway<Bindings> {
	limit = 50;

	link(env: Bindings) {
		return env.Room;
	}

	identify(req: Request): Promise<string> {
		// return req.headers.get('cf-connecting-ip') || 'anon';
		// or
		return SHA256(this.uid + ':' + (req.cf.colo || ''));
	}
}
