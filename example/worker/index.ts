// @ts-ignore - inline the HTML, via build
import HTML from '../public/index.html';

import * as dog from 'dog';
import type { Bindings } from './types';

// export the custom DO classes
export { Lobby } from './lobby';
export { Room } from './room';

const worker: ModuleWorker<Bindings> = {
	async fetch(req, env, ctx) {
		let { pathname } = new URL(req.url);
		if (!/^(HEAD|GET)$/.test(req.method)) {
			return new Response('Method not allowed', { status: 405 });
		}

		if (pathname === '/') {
			return new Response(HTML, {
				headers: {
					'Content-Type': 'text/html;charset=utf-8'
				}
			});
		}

		// ~> determine request identifier
		// NOTE: ideally result of some cookie/auth process
		let { searchParams } = new URL(req.url);
		let reqid =  searchParams.get('u') || 'anon';

		// You can have multiple/separate lobby groups
		// For this demo, each "lobby" has its *own* set of Room replicas,
		// but you may, for example, want to have a Room replicaset for an
		// entire server and use the "lobby/channel" as a namespace
		// during any & all socket & gossip messaging.
		let gid = env.LOBBY.idFromName('lobby-id');

		let room = await dog.identify(gid, reqid, {
			parent: env.LOBBY,
			child: env.ROOM,
		});

		return room.fetch(req);
	}
}

export default worker;
