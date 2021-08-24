import { Shard } from '$lib/index';

export class Room extends Shard {
	onconnect() {
		console.log('user has joined');
	}

	onmessage(socket) {
		//

		this.broadcast('hello');
	}

}
