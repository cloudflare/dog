# DOG [![CI](https://github.com/lukeed/dog/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lukeed/dog/actions/workflows/ci.yml)

> Durable Object Groups

## Features

* Supports `Replica` workloads using the HTTP and/or WS protocols
* Creates or reuses a `Replica` based on configured connection limit
* Includes `Replica`-to-`Replica` (peer-to-peer) communication
* Ready for strongly-typed, strict TypeScript usage
* Allows an active connection to:
    * `broadcast` messages to the entire cluster
    * `emit` messages to `Replica`-owned connections
    * send a `whisper` a single connection within the cluster

## Overview

With DOG, it's easy to setup named clusters of related [Durable Objects](https://developers.cloudflare.com/workers/runtime-apis/durable-objects). Each cluster is controlled by a [`Group`](#group), which directs an incoming `Request` to a specific [`Replica`](#replica) instance. A `Group` adheres to the user-defined [limit](#group) of active connections per `Replica` and, in doing so, will reuse existing or create new `Replica` instances as necessary.

DOG includes convenience methods that allow a `Replica` to directly communicate with another `Replica` belonging to the same `Group` – effectively a peer-to-peer/gossip network. Additionally, when dealing with active client connections, a `Replica` class allows you to:

* `broadcast` a message to all active connections within the _entire_ cluster
* `emit` a message only to active connections owned by the `Replica` itself
* `whisper` a message to a single, targeted connection (via your own identification system); even if it's owned by another `Replica` instance!

`Group` and `Replica` are both [abstract classes](https://www.typescriptlang.org/docs/handbook/classes.html#abstract-classes), which means that you're allowed — **and required** — to extend them with your own application needs. You may define your own class methods, add your own state properties, or use [Durable Storage](https://developers.cloudflare.com/workers/runtime-apis/durable-objects#transactional-storage-api) to fulfill your needs.

Please see [Usage](#usage), the [API](#api) docs, and the [example application](/example/worker) for further information!


## Install

```sh
$ npm install dog
```


## Usage

> Refer to the [`/example`](/example) for a complete Chat Room application.

```ts
import { identify, Group, Replica } from 'dog';

// deployed as `POOL` binding
export class Pool extends Group {
  limit = 50; // each Replica handles 50 connections max

  link(env: Bindings) {
    return {
      child: env.TASK, // receiving Replica
      self: env.POOL, // self-identifier
    };
  }
}

// deployed as `TASK` binding
export class Task extends Replica {
  link(env) {
    return {
      parent: env.POOL, // parent Group
      self: env.TASK, // self-identifier
    };
  }

  async onmessage(socket, data) {
    let message = JSON.parse(data);
    console.log('[task] onmessage', message);

    if (message.type === 'crawl:url') {
      let { url } = message;
      // ...
      let output = { url, done: true };
      // alert everyone that the task is complete
      return socket.broadcast(JSON.stringify(output), true);
    }

    // other events
  }

  receive(req) {
    // Receive & handle the request
    // NOTE: This is the original, forwarded request
    let { pathname } = new URL(req.url);

    // Rely on internal util for WebSocket upgrade
    if (pathname === '/ws') return this.connect(req);

    // Any other custom routing behavior(s)
    if (pathname === '/') return new Response('OK');

    return toError('Unknown path', 404);
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
    let group = env.POOL.idFromName(taskname);

    // Custom request identifier logic
    let reqid = req.headers.get('x-request-id');

    // Identify the `Replica` stub to use
    let replica = await identify(group, reqid, {
      parent: env.POOL,
      child: env.TASK,
    });

    // (Optional) Save reqid -> replica.id
    // await KV.put(`req::${reqid}`, replica.id.toString());

    // Send request to the Replica instance
    return replica.fetch(req);
  }
}
```

## API

### `identify`

> **Note:** Refer to the [TypeScript definitions](/index.d.ts#L149) for more information.

The utility function to identify a `Replica` to be used and, if necessary, will create a new `Replica` if none are available. Returns the `Replica` stub directly.


### `Group`

> **Note:** Refer to the [TypeScript definitions](/index.d.ts#L116) for more information.

***Required:***

* `limit: number` – the maximum number of active connections a `Replica` can handle
* `link(env: Bindings): { self, child }` – define the relationships between this `Group` and its `Replica` child class

A `Group` is initial coordinator for the cluster. It receives a user-supplied request identifier, `ReqID`, and replies with the Durable Object ID for the `Replica` instance to be used. If the `ReqID` has been seen before, the Group will attempt to target the same Replica that the `ReqID` was previously connected to. If the `ReqID` is unknown, the Group will send the request to the least-utilized `Replica` instance or generate a new `Replica` ID to be used.

When targeting an existing `Replica` instance, the Group verifies that the `Replica` actually has availability for the request, as determined by the user-supplied `limit` value. If a new Replica instance needs to be created, the Group's `clusterize()` method is called to generate a new `Replica` instance identifier. You may override this method with your own logic – for example, including a [jurisdiction](https://developers.cloudflare.com/workers/runtime-apis/durable-objects#restricting-objects-to-a-jurisdiction) – but by default, the Group calls `newUniqueId()` for a system-guaranteed identifier.

The number of active connections within each `Replica` instance is automatically tracked and shared between the `Replica` and its `Group` parent. The `Replica`'s count is decremented when the connection is closed. This means that when a `Replica` works with WebSockets, open connections continue to reserve `Replica` quota until closed. Non-upgraded HTTP connections close and decrement the `Replica` count as soon as a `Response` is returned.

> **Important:** *Do not* define your own `fetch()` method! <br>Doing so requires that `super.fetch()` be called appropriately, otherwise the entire cluster's inter-communication will fail.

You may attach any additional state and/or methods to your `Group` class extension.


### `Replica`

> **Note:** Refer to the [TypeScript definitions](/index.d.ts#60) for more information.

***Required:***

* `link(env: Bindings): { self, child }` – define the relationships between this `Replica` and its `Group` parent class
* `receive(req: Request): Promise<Response> | Response` – a user-supplied method to handle an incoming Request

A `Replica` is the cluster's terminating node. In other words, it's your workhorse and is where the bulk of your application logic will reside. By default, a `Replica` actually _does nothing_ and requires your user-supplied code to become useful. It does, however, provide you with utilities, lifecycle hooks, and event listeners to organize and structure your logic.

A `Replica` can only receive a `Request` from its parent `Group` or from its `Replica` siblings/peers. Because of this, you **cannot** define a `fetch()` method in your `Replica` class extension, otherwise all internal routing and inter-communication will break.

However, this _does not_ mean that you cannot deploy your own external-facing routing solution!

If an incoming request to a `Replica` is not an internal DOG event, the request is passed to your `receive` method, which receives the original `Request` without any modifications. This means that the execution order for a client request looks like this:

<!-- TODO: actual graphic -->
```
client request
└──> dog.identify(...)
      │   ├──> Group#fetch (internal)
      │   └──> Group#clusterize (optional)
      └──> Replica
          └──> Replica.fetch (user)
              └──> Replica#receive
```

Your `receive` method is the final handler and decides what the `Replica` actually does.

If you'd like to remain in the HTTP protocol, then you can treat `receive()` as if it were the underyling `fetch()` method. Otherwise, to upgrade the HTTP connection into a WebSocket connection, then you may reach for the `Replica.connect()` method, which handles the upgrade and unlocks the rest of the `Replica` abstractions.

Internally, a [`Socket` interface](/index.d.ts#23) is instantiated and passed to WebSocket event listeners that you chose to define. For example, to handle incoming messages or to react to a new connection, your `Replica` class may including the following:

```js
import { Replica } from 'dog';

export class Counter extends Replica {
  #counts = new Map<string, number>;

  onopen(socket) {
    // via dog.identify
    // ~> your own ReqID
    let reqid = socket.uid;
    this.#counts.set(reqid, 0);

    // notify others ONLY in Replica
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

The `Replica` class allows you to optionally define event listeners for the underlying WebSocket events. Whether or not you define `onclose` and/or `onerror` listeners, the `Replica` will always notify the `Group` parent when the WebSocket connection is closed. The event listeners may be asynchronous and their names follow the browser's [`WebSocket` event names](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket#events):

* `onopen` – the `Replica` established a  `WebSocket` connection
* `onmessage` – the `Replica` received a message from the `WebSocket` connection
* `onerror` – the `WebSocket` connection terminated due to an error
* `onclose` – the `WebSocket` connection was closed

> **Note:** If defined, the `onclose` listener will be called in the absence of an `onerror` listener.

Finally, a `Replica` may communicate directly with its `Replica` peers in the cluster. This does not rely on WebSockets nor does it require you to use them! It can, however, be leveraged at any point during your HTTP and/or WebSocket handlers.

In DOG, this peer-to-peer communication is called gossip – because `Replica`s are typically talking _about_ their connections but without _involving_ the connections; AKA, behind their backs!

In order for a `Replica` to hear gossip, it must define an `ongossip` method handler. It will receive a decoded JSON object and must return a new JSON object so that DOG can serialize it and deliver it to sender. In practice, this internal communication is happening over HTTP which means that each `Gossip.Message` must represent point-in-time information.

Returning to the `Counter` example, suppose the `Counter` objects needs to coordinate with one another to determine a leaderboard. Refreshing this leaderboard could be done through a new `refresh:leaderboard` message, for example:

```js
import { Replica } from 'dog';

export class Counter extends Replica {
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
