import * as ROUTES from './internal/routes';
import * as HEADERS from './internal/headers';

import type * as DOG from 'dog';

export const identify: typeof DOG.identify = async function (gid, rid, family) {
	let group = family.parent.get(gid);

	let request = new Request(ROUTES.IDENTIFY);
	request.headers.set(HEADERS.GROUPID, gid.toString());
	request.headers.set(HEADERS.CLIENTID, rid);

	let text = await group.fetch(request).then(r => r.text());
	let sid = family.child.idFromString(text);
	return family.child.get(sid);
}
