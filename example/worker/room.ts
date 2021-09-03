import { Shard } from 'dog';
import type { Bindings } from './types';
import type { Socket } from 'dog';

type Message = {
	uid: string;
	type: string;
};

type MessageData =
	| { type: 'whoami'; user?: string }
	| { type: 'msg'; user: string; text: string };

export class Room extends Shard<Bindings> {
	users = new Map<string, string>();

	link(env: Bindings) { return env.LOBBY }
	self(env: Bindings) { return env.ROOM }

	async receive(req: Request) {
		console.log('[ HELLO ][receive] req.url', req.url);

		let { pathname } = new URL(req.url);

		if (pathname === '/ws') {
			return this.connect(req);
		}

		return new Response(`PATH: "${pathname}"`);
	}

	onopen(socket: Socket) {
		console.log('[ HELLO ][onopen]');

		socket.broadcast({
			type: 'join',
			uid: socket.uid,
		});
	}

	onclose(socket: Socket) {
		console.log('[ HELLO ][onclose]');

		socket.broadcast({
			type: 'exit',
			uid: socket.uid,
			user: this.users.get(socket.uid)!
		});

		this.users.delete(socket.uid);
	}

	onmessage(socket: Socket, data: string) {
		// raw broadcast channel
		let input = JSON.parse(data) as Message & MessageData;
		console.log('[room] onmessage', input);
		input.uid = input.uid || socket.uid;

		if (input.type === 'whoami') {
			// save the `uid`: `name` association
			this.users.set(input.uid, input.user || 'anon');
			socket.send(JSON.stringify(input));

			// send down a list of all connected users
			let arr = [];
			for (let [uid, name] of this.users) {
				arr.push({ uid, name });
			}

			return socket.send(
				JSON.stringify({
					type: 'users:list',
					list: arr,
				})
			);
		}

		if (input.type === 'msg') {
			let text = input.text.trim();

			// slash commands~!
			// ---

			if (text.startsWith('/group ')) {
				input.text = text.substring(7);
				return socket.emit(input);
			}

			if (text.startsWith('/all ')) {
				input.text = text.substring(5)
			}

			return socket.broadcast(input);
		}

		// catch all: broadcast
		socket.broadcast(input);
	}
}
