// @ts-ignore - inline the HTML, via build
import HTML from '../public/index.html';

import type { Bindings } from './types';

// export the custom DO classes
export { Lobby } from './lobby';
export { Room } from './room';

const worker: ModuleWorker<Bindings> = {
	fetch(req, env, ctx) {
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

		// ~> can have multiple gateway'd shards
		let id = env.LOBBY.idFromName('lobby-id');
		let lobby = env.LOBBY.get(id);
		return lobby.fetch(req);
	}
}

export default worker;
