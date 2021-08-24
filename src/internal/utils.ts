import { STATUS_CODES } from 'worktop';
import { byteLength } from 'worktop/utils';
import * as HEADERS from './headers';

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

/**
 * Ensure the request HEADER values exist & match
 */
export function validate(req: Request, shardid?: string) {
	let sid = req.headers.get(HEADERS.SHARDID);
	if (sid == null) throw new Error('Missing: Shard ID');
	if (shardid && sid !== shardid) throw new Error('Mismatch: Shard ID');

	let gid = req.headers.get(HEADERS.GATEWAYID);
	if (gid == null) throw new Error('Missing: Gateway ID');

	let rid = req.headers.get(HEADERS.CLIENTID);
	if (rid == null) throw new Error('Missing: Request ID');

	return { gid, rid, sid };
}
