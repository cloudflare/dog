import type { Bindings } from './types';

// export the custom DO classes
export { Lobby } from './lobby';
export { Room } from './room';

const worker: ModuleWorker<Bindings> = {
	fetch(req, env, ctx) {
		// DEMO: can implement front-facing routing
		// let { pathname } = new URL(req.url);
		// if (pathname !== '/') return new Response('Not Found', { status: 404 });

		// ~> can have multiple gateway'd shards
		let id = env.LOBBY.idFromName('lobby-id');
		let lobby = env.LOBBY.get(id);
		return lobby.fetch(req);
	}
}

export default worker;
