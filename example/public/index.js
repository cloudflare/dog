// @ts-check
var $ = document.querySelector.bind(document);
var $$ = document.querySelectorAll.bind(document);

var form = $('form');
var chat = $('.chat');
var aside = $('aside');
var input = $('input');

// @ts-ignore
var uid = window.NAME;
var ws = new WebSocket(`ws://localhost:8787/ws?u=${uid}`);
var users = [];

ws.onopen = function (ev) {
	input.focus(); // form input
	console.log('[ws][open]', ev);
	toJSON('req:user:list');
	toJSON('req:connected');
}

ws.onmessage = function (ev) {
	let input = JSON.parse(ev.data);
	let { type, ...data } = input;

	console.log('[MESSAGE]', input);

	switch (type) {
		case 'user:list': {
			users = data.list;
			// TODO: ^merge/gossip
			return users.forEach(new_user);
		}
		case 'user:join': {
			new_user(data.from);
			users.push(data.from);
			return announce(data.from, 'joined');
		}
		case 'user:connected': {
			toggle_user(data.from, true);
			return announce(data.from, 'connected');
		}
		case 'user:exit': {
			// via Room.onclose
			toggle_user(data.from, false);
			return announce(data.from, 'left');
		}
		case 'user:msg': {
			return message(data.from, data.text, data.meta, data.to);
		}
		default: {
			console.log('DEFAULT', input);
			break;
		}
	}
}

ws.onclose = ws.onerror = function (ev) {
	console.log('[ws][%s]', ev.type, ev);
	users.forEach(str => {
		announce(str, 'left');
		toggle_user(str, false);
	});
}

// Send a message
form.onsubmit = function (ev) {
	ev.preventDefault();
	let text = (input.value || '').trim();
	if (!text.length) return;

	toJSON('msg', { text });
	input.value = '';

	// draw own message
	// message(uid, text);
}

/**
 * @param {string} type
 * @param {object} [data]
 */
function toJSON(type, data={}) {
	data.user = uid;
	data.type = type;
	ws.send(JSON.stringify(data));
}

/**
 * @param {string} user
 * @param {boolean} online
 */
function toggle_user(user, online) {
	let fig = aside.querySelector(`figure[data-user="${user}"]`);
	if (fig) fig.classList.toggle('online', online);
}

/**
 * @param {string} username
 */
function new_user(username) {
	let fig = aside.querySelector(`figure[data-user="${username}"]`);
	if (fig) return;

	fig = document.createElement('figure');
	let caption = document.createElement('figcaption');

	fig.setAttribute('data-user', username);
	caption.innerText = username;

	fig.classList.add('online');
	fig.appendChild(caption);
	aside.appendChild(fig);
}

/**
 * @param {string} name
 * @param {string} action
 */
function announce(name, action) {
	let div = document.createElement('div');
	div.innerText = `${name} has ${action}`;
	div.className = 'announce';
	chat.appendChild(div);
}

/**
 * @param {string} name
 * @param {string} text
 * @param {string} [type]
 * @param {string} [to]
 */
function message(name, text, type, to) {
	let div = document.createElement('div');
	div.className = 'msg';

	let from = document.createElement('strong');
	from.innerText = name;

	if (type) div.className += ' ' + type;
	if (to) from.innerText += ' ↦ ' + to;

	let msg = document.createElement('span');
	msg.innerText = text;

	div.appendChild(from);
	div.appendChild(msg);

	chat.appendChild(div);

	// scroll to bottom
	chat.scrollTop = chat.scrollHeight
}
