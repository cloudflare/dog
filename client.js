// NAME = 'bob'
let uid = ''; // tbd
let ws = new WebSocket('ws://localhost:8787/ws');

ws.json = function (input) {
	input.uid = uid;
	input.user = NAME;
	ws.send(JSON.stringify(input));
}

ws.onopen = function (ev) {
	console.log('OPEN', ev);
	ws.json({ type: 'whoami' });
};

ws.onmessage = function (ev) {
	let input = JSON.parse(ev.data);
	let { type, ...data } = input;

	if (type === 'whoami') {
		console.log('[whoami]', uid = data.uid);
		return ws.json({ type: 'joined' });
	}

	if (type === 'join') return console.log('[join]', data.uid); // Room.onopen
	if (type === 'exit') return console.log('[exit]', data.uid); // Room.onclose

	if (type === 'joined') {
		console.log('[joined] "%s" has joined', data.user);
		return console.log('~> ', data.uid);
	}

	if (type === 'count') {
		console.log('[count]', data.value++);
		if (data.value > 10) console.log('STOP');
		else ws.json({ type, value: data.value });
	} else {
		console.log(input);
	}
};

ws.onclose = function (ev) {
	console.log('CLOSE', ev.code);
};

ws.onerror = function (ev) {
	console.log('ERROR', ev.code);
};
