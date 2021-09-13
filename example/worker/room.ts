import { Replica } from 'dog';
import type { Bindings } from './types';
import type { Socket, Gossip } from 'dog';

type Message = {
	uid: string;
	type: string;
};

type MessageData =
	| { type: 'req:connected' }
	| { type: 'req:user:list' }
	| { type: 'msg'; text: string };

type Output = {
	type: string;
	from?: string;
	time: number;
}

type Note = Gossip.Message & {
	type: 'intra:user:list';
}

export class Room extends Replica<Bindings> {
	users = new Map<string, number>();

	link(env: Bindings) {
		return {
			parent: env.LOBBY,
			self: env.ROOM,
		};
	}

	async receive(req: Request) {
		console.log('[ HELLO ][receive] req.url', req.url);

		let { pathname } = new URL(req.url);

		if (pathname === '/ws') {
			return this.connect(req);
		}

		// NOTE: can employ whatever routing logic
		return new Response(`PATH: "${pathname}"`);
	}

	onopen(socket: Socket) {
		console.log('[ HELLO ][onopen]', socket.uid);

		let output: Output = {
			type: 'user:join',
			from: socket.uid,
			time: Date.now(),
		};

		socket.broadcast(output, true);
		this.users.set(socket.uid, output.time);
	}

	onclose(socket: Socket) {
		console.log('[ HELLO ][onclose]');

		let output: Output = {
			type: 'user:exit',
			from: socket.uid,
			time: Date.now(),
		}

		socket.broadcast(output);
		this.users.delete(socket.uid);
	}

	async ongossip(msg: Note): Promise<Gossip.Payload> {
		if (msg.type === 'intra:user:list') {
			return [ ...this.users.keys() ];
		}

		throw new Error(`Missing: "${msg.type}" ongossip`);
	}

	async onmessage(socket: Socket, data: string) {
		// raw broadcast channel
		let input = JSON.parse(data) as Message & MessageData;
		console.log('[room] onmessage', input);
		input.uid = input.uid || socket.uid;

		if (input.type === 'req:connected') {
			let output: Output = {
				type: 'user:connected',
				from: input.uid,
				time: Date.now(),
			}
			// save the `uid`::Date association
			this.users.set(input.uid, output.time);
			return socket.broadcast(JSON.stringify(output), true);
		}

		// send down a list of all connected users
		if (input.type === 'req:user:list') {
			let results = await this.gossip<Note>({
				type: 'intra:user:list'
			}) as string[][];

			let list = new Set<string>(results.flat());
			for (let [user] of this.users) list.add(user);

			let output: Output & { list: string[] } = {
				type: 'user:list',
				list: [...list],
				time: Date.now(),
			};

			return socket.send(
				JSON.stringify(output)
			);
		}

		if (input.type === 'msg') {
			let text = input.text.trim();

			let output: Output & { text: string, to?: string; meta?: string } = {
				type: 'user:msg',
				from: socket.uid,
				text: text,
				time: Date.now(),
			}

			// slash commands~!
			// ---

			let match: RegExpExecArray | null;

			// group chat: "/group <text>" || "/g <text>"
			if (match = /^([/](?:g|group)\s+)/.exec(text)) {
				output.meta = 'group'; // group only
				output.text = text.substring(match[0].length);
				return socket.emit(output, true);
			}

			// whisper: "/w <target> <text>" || "/msg <target> <text>"
			if (match = /^([/](?:w|msg)\s+(?<target>[^\s]+))\s+/.exec(text)) {
				let target = match.groups!.target;
				output.text = text.substring(match[0].length);
				output.meta = 'whisper';
				output.to = target;

				// ensure it's sent to target first
				await socket.whisper(target, output);
				// then confirm w/ sender by echoing msg
				return socket.send(JSON.stringify(output));
			}

			// all chat (default): "/all <text>" || "/a <text>"
			if (match = /^([/](?:a|all)\s+)/.exec(text)) {
				output.text = text.substring(match[0].length);
				return socket.broadcast(output, true);
			}

			return socket.broadcast(output, true);
		}

		// catch all: broadcast
		socket.broadcast(input, true);
	}
}
