import { Shard } from '$lib/index';
import type { Socket } from '$lib/index';
import type { Bindings } from './types';

export class Room extends Shard<Bindings> {
	users = new Map<string, string>();

	onconnect() {
		console.log('user has joined');
	}

	link(env: Bindings) {
		return env.LOBBY;
	}

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

		socket.emit({
			type: 'join',
			uid: socket.uid,
		});
	}

	onclose(socket: Socket) {
		console.log('[ HELLO ][onclose]');

		socket.emit({
			type: 'exit',
			uid: socket.uid,
			user: this.users.get(socket.uid)!
		});

		this.users.delete(socket.uid);
	}

	onmessage(socket: Socket, data: string) {
		// raw broadcast channel
		let input = JSON.parse(data);
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

			socket.send(
				JSON.stringify({
					type: 'users:list',
					list: arr,
				})
			);
		} else {
			socket.emit(input);
		}
	}
}
