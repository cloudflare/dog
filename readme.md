# DOG [![CI](https://github.com/lukeed/dog/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lukeed/dog/actions/workflows/ci.yml)

> Durable Object Gateway

## Features

* Supports `Shard` workloads using the HTTP and/or WS protocols
* Auto-scale Durable Object clusters based on connection count
* Includes `Shard`-to-`Shard` (peer-to-peer) communication
* Ready for strongly-typed, strict TypeScript usage
* Allows an active connection to:
    * [`broadcast`](#todo) messages to the entire cluster
    * [`emit`](#todo) messages to `Shard`-owned connections
    * send a [`whisper`](#todo) a single connection within the cluster

## Overview

With DOG, it's easy to setup named clusters of related [Durable Objects](#TODO). Each cluster is controlled by a [`Gateway`](#TODO), which directs an incoming `Request` to a specific [`Shard`](#TODO) instance. A `Gateway` adheres to the user-defined [limit](#todo) of active connections per `Shard` and, in doing so, will reuse existing or create new `Shard` instances as necessary.

DOG includes convenience methods that allow a `Shard` to directly communicate with another `Shard` belonging to the same `Gateway` – effectively a peer-to-peer/gossip network. Additionally, when dealing with active client connections, a `Shard` class allows you to:

* [broadcast](#todo) a message to all active connections within the _entire_ cluster
* [emit](#todo) a message only to active connections owned by the `Shard` itself
* [whisper](#todo) a message to a single, targeted connection (via your [identification system](#todo)); even if it's owned by another `Shard` instance!

`Gateway` and `Shard` are both [abstract classes](https://www.typescriptlang.org/docs/handbook/classes.html#abstract-classes), which means that you're allowed — **and required** — to extend them with your own application needs. You may define your own class methods, add your own state properties, or use [Durable Storage](#TODO) to fulfill your needs.

Please see [Usage](#usage), the [API](#api) docs, and the [example application](/example/worker) for further information!


## Install

```sh
$ npm install dog@next
```


## Usage

> Refer to the [`/example`](/example) for a complete Chat Room application.

```ts
import { Gateway, Shard } from 'dog';

// deployed as `POOL` binding
export class Pool extends Gateway {
  limit = 50; // each Shard handles 50 connections max

  link(env: Bindings) {
    return {
      child: env.TASK, // receiving Shard
      self: env.POOL, // self-identifier
    };
  }

  // Generate unique client identifier
  // NOTE: Purely application-specific logic
  identify(req: Request): string {
    let auth = req.headers.get('authorization');
    let token = auth && auth.replace(/^[^\s]+\s+/, '');
    return token || req.headers.get('cf-connecting-ip') || 'anon';
  }
}

// deployed as `TASK` binding
export class Task extends Shard {
  link(env) {
    return {
      parent: env.POOL, // parent Gateway
      self: env.TASK, // self-identifier
    };
  }

  receive(req) {
    // TODO: come up w/ succinct example, webcrawler?
  }
}

function toError(msg, status) {
  return new Response(msg, { status });
}

// Module Worker
export default {
  fetch(req, env, ctx) {
    // Accept: /tasks/<taskname>
    let match = /[/]tasks[/]([^/]+)[/]?/.exec(req.url);
    if (match == null) return toError('Missing task name', 404);

    let taskname = match[1].trim();
    if (taskname.length < 1) return toError('Invalid task name', 400);

    // Generate Durable Object ID from taskname
    let id = env.POOL.idFromName(taskname);

    // Load the Durable Object & forward the request
    return env.POOL.get(id).fetch(req);
  }
}
```

## API

### `Gateway`

> **Note:** Refer to the [TypeScript definitions](/index.d.ts#L69) for more information.

***Required:***

* `limit: number` – the maximum number of active connections a `Shard` can handle
* `link(env: Bindings): { self, child }` – define the relationships between this `Gateway` and its `Shard` child class
* `identify(req: Request): Promise<string> | string` – a user-supplied method to identify an incoming request

A `Gateway` is initial coordinator for the cluster. It calls the user-supplied `identify` method to determine a request identifier, `ReqID`. If the `ReqID` has been seen before, the Gateway will attempt to target the same Shard that the `ReqID` was previously connected to. If the `ReqID` is unknown, the Gateway will send the request to the least-utilized `Shard` instance.

Afer a `Shard` instance has been targeted, the Gateway verifies that the `Shard` actually has availability for the request, as determined by the user-supplied `limit` value. If a new Shard instance needs to be created, the Gateway's `clusterize()` method is called to generate a new `Shard` instance identifier. You may override this method with your own logic – for example, including a [jurisdiction](#todo) – but by default, the Gateway calls `newUniqueId()` for a system-guaranteed identifier.

The number of active connections within each `Shard` instance is automatically tracked and shared between the `Shard` and its `Gateway` parent. The `Shard`'s count is decremented when the connection is closed. This means that when a `Shard` works with WebSockets, open connections continue to reserve `Shard` quota until closed. Non-upgraded HTTP connections close and decrement the `Shard` count as soon as a `Response` is returned.

> **Important:** *Do not* define your own `fetch()` method! <br>Doing so requires that `super.fetch()` be called appropriately, otherwise the entire cluster's inter-communication will fail.

You may attach any additional state and/or methods to your `Gateway` class extension.


### `Shard`

> **Note:** Refer to the [TypeScript definitions](/index.d.ts#33) for more information.

***Required:***

* `link(env: Bindings): { self, child }` – define the relationships between this `Shard` and its `Gateway` parent class
* `receive(req: Request): Promise<Response> | Response` – a user-supplied method to handle an incoming Request

A `Shard` is the cluster's terminating node. In other words, it's your workhorse and is where the bulk of your application logic will reside. By default, a `Shard` actually _does nothing_ and requires your user-supplied code to become useful. It does, however, provide you with utilities, lifecycle hooks, and event listeners to organize and structure your logic.

A `Shard` can only receive a `Request` from its parent `Gateway` or from its `Shard` siblings/peers. Because of this, you **cannot** define a `fetch()` method in your `Shard` class extension, otherwise all internal routing and inter-communication will break.

However, this _does not_ mean that you cannot deploy your own external-facing routing solution!

If an incoming request to a `Shard` is not an internal DOG event, the request is passed to your `receive` method, which receives the original `Request` without any modifications. This means that the execution order for a client request looks like this:

<!-- TODO: actual graphic -->
```
client request
└──> Gateway#fetch (internal)
      │   ├──> Gateway#identify
      │   └──> Gateway#clusterize (optional)
      └──> Shard#fetch (internal)
            └──> Shard#receive
```

Your `receive` method is the final handler and decides what the `Shard` actually does.

If you'd like to remain in the HTTP protocol, then you can treat `receive()` as if it were the underyling `fetch()` method. Otherwise, to upgrade the HTTP connection into a WebSocket connection, then you may reach for the `Shard.connect()` method, which handles the upgrade and unlocks the rest of the `Shard` abstractions.

Internally, a [`Socket` interface](/index.d.ts#23) is instantiated and passed to WebSocket event listeners that you chose to define. For example, to handle incoming messages or to react to a new connection, your `Shard` class may including the following:

```js
import { Shard } from 'dog';

export class Counter extends Shard {
  #counts = new Map<string, number>;

  onopen(socket) {
    // Gateway#identify value
    let reqid = socket.uid;
    this.#counts.set(reqid, 0);

    // notify others ONLY in Shard
    socket.emit(`"${reqid}" has joined`);
  }

  onmessage(socket, data) {
    let reqid = socket.uid;
    let current = this.#counts.get(reqid);

    // data is always a string
    let msg = JSON.parse(data);

    if (msg.type === '+1') count++;
    else if (msg.type === '-1') count--;
    else return; // unknown msg type

    this.#counts.set(reqid, count);

    // tell EVERYONE in cluster about new count
    socket.broadcast(`"${reqid}" now has ${count}`);
  }

  receive(req) {
    // Only accept "/ws" pathname
    let isWS = /^[/]ws[/]?/.test(req.url);
    // Handle upgrade, return 101 status
    if (isWS) return this.connect(req);
    // Otherwise return a 404
    return new Response('Invalid', { status: 404 });
  }
}
```

The `Shard` class allows you to optionally define event listeners for the underlying WebSocket events. Whether or not you define `onclose` and/or `onerror` listeners, the `Shard` will always notify the `Gateway` parent when the WebSocket connection is closed. The event listeners may be asynchronous and their names follow the browser's [`WebSocket` event names](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket#events):

* `onopen` – the `Shard` established a  `WebSocket` connection
* `onmessage` – the `Shard` received a message from the `WebSocket` connection
* `onerror` – the `WebSocket` connection terminated due to an error
* `onclose` – the `WebSocket` connection was closed

> **Note:** If defined, the `onclose` listener will be called in the absence of an `onerror` listener.

Finally, a `Shard` may communicate directly with its `Shard` peers in the cluster. This does not rely on WebSockets nor does it require you to use them! It can, however, be leveraged at any point during your HTTP and/or WebSocket handlers.

In DOG, this peer-to-peer communication is called gossip – because `Shard`s are typically talking _about_ their connections but without _involving_ the connections; AKA, behind their backs!

In order for a `Shard` to hear gossip, it must define an `ongossip` method handler. It will receive a decoded JSON object and must return a new JSON object so that DOG can serialize it and deliver it to sender. In practice, this internal communication is happening over HTTP which means that each `Gossip.Message` must represent point-in-time information.

Returning to the `Counter` example, suppose the `Counter` objects needs to coordinate with one another to determine a leaderboard. Refreshing this leaderboard could be done through a new `refresh:leaderboard` message, for example:

```js
import { Shard } from 'dog';

export class Counter extends Shard {
  #counts = new Map<string, number>;
  #lastupdate = 0; // timestamp
  #leaders = []; // Array<string, number>[]

  // NOTE: now `async` method
  async onmessage(socket, data) {
    let reqid = socket.uid;
    let current = this.#counts.get(reqid);

    // data is always a string
    let msg = JSON.parse(data);

    // ...

    if (msg.type === 'refresh:leaderboard') {
      // Only gossip if cache is older than 60s
      if (Date.now() - this.#lastupdate > 60e3) {
        // `ongossip` returns Array<[string,number][]>
        let results = await this.gossip({ type: 'ask:scores' });
        let leaders = results.flat(1); // [ [reqid,count], [reqid,count], ... ]

        // sort by highest scores, keep top 10 only
        this.#scores = leaders.sort((a, b) => b[1] - a[1]).slice(0, 10);
        this.#lastupdate = Date.now();
      }

      // Tell EVERYONE in cluster
      return socket.broadcast({
        leaders: this.#scores,
        timestamp: this.#lastupdate,
      });
    }
  }

  ongossip(msg) {
    // Return array of tuples: Array<[string, number]>
		if (msg.type === 'ask:scores') return [...this.#counts];
		throw new Error(`Missing "${msg.type}" handler in ongossip`);
	}

  // ...
}
```


## License

MIT © Cloudflare
