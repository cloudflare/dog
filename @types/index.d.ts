declare const WebSocketPair: {
	new(): {
		/** the `client` socket */
		0: WebSocket,
		/** the `server` socket */
		1: WebSocket,
	};
};

interface WebSocket {
	accept(): void;
}

interface ResponseInit {
	webSocket?: WebSocket;
}

interface Request {
	cf: {
		/** @example "HTTP/2", "HTTP/3" */
		httpProtocol: string;
		/** @example "weight=192;exclusive=0;group=3;group-weight=127" */
		requestPriority: string;
		/** @example "gzip, deflate, br" */
		clientAcceptEncoding: string;
		edgeRequestKeepAliveStatus: 1 | 0;
		/** @example "TLSv1.3" */
		tlsVersion: string;
		/** @example "AEAD-AES128-GCM-SHA256" */
		tlsCipher: string;
		tlsClientAuth: {
			certIssuerDNLegacy: string;
			certIssuerSKI: string;
			certSubjectDNRFC2253: string;
			certSubjectDNLegacy: string;
			certFingerprintSHA256: string;
			certNotBefore: string;
			certSKI: string;
			certSerial: string;
			certIssuerDN: string;
			certVerified: 'SUCCESS' | 'NONE' | `FAILED:${infer string}`;
			certNotAfter: string;
			certSubjectDN: string;
			certPresented: '0' | '1';
			certRevoked: '0' | '1';
			certIssuerSerial: string;
			certIssuerDNRFC2253: string;
			certFingerprintSHA1: string;
		};
		tlsExportedAuthenticator: {
			/** @example "62805..." */
			clientFinished: string;
			/** @example "209f5..." */
			clientHandshake: string;
			/** @example "caeb5..." */
			serverHandshake: string;
			/** @example "fe073..." */
			serverFinished: string;
		};
		/** @example "-97.74260" */
		longitude: string;
		/** @example "30.27130" */
		latitude: string;
		/** @example "Austin" */
		city: string;
		/** @example "Texas" */
		region: string;
		/** @example "DFW", "LAX" */
		colo: string;
		/** @example "TX" */
		regionCode: string;
		/** @example "78701" */
		postalCode: string;
		/** @example "635" */
		metroCode: string;
		/** @example 7922 */
		asn: number;
		/** @example "America/Chicago" */
		timezone: string;
		/** @example "US" */
		country: string;
		/** @example "NA" */
		continent: string;
	};
}

// interface FetchEvent {
// 	passThroughOnException: () => void;
// }

interface DurableObject<Environment extends ModuleWorker.Bindings = ModuleWorker.Bindings> {
	state: DurableObjectState;
	constructor(state: DurableObjectState, env: Environment): DurableObject;
	fetch(request: Request): Promise<Response> | Response;
}

declare namespace ModuleWorker {
	type Bindings = Record<string, KVNamespace | DurableObjectNamespace | string>;

	type FetchHandler<Environment extends Bindings = Bindings> = (
		request: Request,
		env: Environment,
		ctx: Pick<FetchEvent, 'waitUntil'|'passThroughOnException'>
	) => Promise<Response> | Response;

	type CronHandler<Environment extends Bindings = Bindings> = (
		event: Omit<ScheduledEvent, 'waitUntil'>,
		env: Environment,
		ctx: Pick<ScheduledEvent, 'waitUntil'>
	) => Promise<void> | void;
}

interface ModuleWorker<Environment extends ModuleWorker.Bindings = ModuleWorker.Bindings> {
	fetch?: ModuleWorker.FetchHandler<Environment>;
	scheduled?: ModuleWorker.CronHandler<Environment>;
}

// ---

declare namespace JSON {
	type Value = Date | RegExp | string | boolean | null | JSON.Object;
	type Object = JSON.Value[] | { [key: string]: JSON.Value };
}
