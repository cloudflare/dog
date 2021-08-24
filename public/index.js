// @ts-check
var $ = document.querySelector.bind(document);
var $$ = document.querySelectorAll.bind(document);

var form = $('form');
var chat = $('.chat');
var aside = $('aside');
var input = $('input');

// @ts-ignore
var username = window.NAME;
var ws = new WebSocket('ws://localhost:8787/ws');

ws.onopen = function (ev) {
	input.focus(); // form input
	console.log('[ws][open]', ev);
	toJSON('whoami');
	toJSON('users:list');
}

ws.onmessage = function (ev) {
	let input = JSON.parse(ev.data);
	let { type, ...data } = input;

	switch (type) {
		case 'whoami': {
			// @ts-ignore
			ws.uid = data.uid;
			console.log('[ws][whoami]', data.uid);
			return toJSON('joined');
		}
		case 'users:list': {
			console.log('[ws][users:list]', data);
			data.list.forEach(obj => {
				draw_user(obj.uid, obj.name, true);
			});
		}
		case 'join': {
			// via Room.onopen
			console.log('[ws][join]', data);
			return toggle_user(data.uid, true);
		}
		case 'exit': {
			// via Room.onclose
			console.log('[ws][exit] "%s" has joined', data.user)
			toggle_user(data.uid, false);
			return announce(data.user, false);
		}
		case 'joined': {
			console.log('[ws][joined] "%s" has joined', data.user);
			return draw_user(data.uid, data.user, true);
		}
		case 'msg': {
			console.log('[ws][msg] "%s" sent a message', data.user, data);
			return message(data.user, data.text);
		}
		case 'count': {
			console.log('[ws][count]', data.value);
			if (data.value++ > 10) return console.log('STOP');
			return toJSON(type, { value: data.value });
		}
		default: {
			console.log(input);
			break;
		}
	}
}

ws.onclose = function (ev) {
	console.log('[ws][close]', ev);
}

ws.onerror = function (ev) {
	console.log('[ws][error]', ev);
}

// Send a message
form.onsubmit = function (ev) {
	ev.preventDefault();
	let text = (input.value || '').trim();
	if (!text.length) return;

	toJSON('msg', { text });
	input.value = '';

	// draw own message
	message(username, text);
}

/**
 * @param {string} type
 * @param {object} [data]
 */
function toJSON(type, data={}) {
	// @ts-ignore
	data.uid = ws.uid;
	data.user = username;
	data.type = type;
	ws.send(JSON.stringify(data));
}

/**
 * @param {string} uid
 * @param {boolean} online
 */
function toggle_user(uid, online) {
	let fig = aside.querySelector(`figure[data-uid="${uid}"]`);
	if (fig) fig.classList.toggle('online', online);
}

/**
 * @param {string} uid
 * @param {string} name
 * @param {boolean} [status]
 */
function draw_user(uid, name, status) {
	let fig = document.createElement('figure');
	let caption = document.createElement('figcaption');

	fig.setAttribute('data-uid', uid);
	caption.innerText = name;

	if (status != null) {
		announce(name, status);
		fig.classList.toggle('online', !!status);
	}

	fig.appendChild(caption);
	aside.appendChild(fig);
}

/**
 * @param {string} name
 * @param {boolean} online
 */
function announce(name, online) {
	let div = document.createElement('div');
	div.innerText = `${name} has ${online ? 'joined' : 'left'}`;
	div.className = 'announce';
	chat.appendChild(div);
}

/**
 * @param {string} name
 * @param {string} text
 */
function message(name, text) {
	let div = document.createElement('div');
	div.className = 'msg';

	let from = document.createElement('strong');
	from.innerText = name;

	let msg = document.createElement('span');
	msg.innerText = text;

	div.appendChild(from);
	div.appendChild(msg);

	chat.appendChild(div);

	// scroll to bottom
	chat.scrollTop = chat.scrollHeight
}
