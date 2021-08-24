import { STATUS_CODES } from 'worktop';
import { byteLength } from 'worktop/utils';

/**
 * @see https://github.com/lukeed/worktop/blob/3187246b95d50c7b34f987b95e734a1dbcf2d778/src/internal/ws.ts#L4
 */
export function abort(code: number, message?: string) {
	message = message || STATUS_CODES[code];
	return new Response(message, {
		status: code,
		statusText: STATUS_CODES[code],
		headers: {
			'Connection': 'close',
			'Content-Type': 'text/plain',
			'Content-Length': '' + byteLength(message)
		}
	});
}
