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
    * [`whisper`](#todo) a targeted connection within the cluster

## Overview

With DOG, it's easy to setup named clusters of related [Durable Objects](#TODO). Each cluster is controlled by a [`Gateway`](#TODO), which directs an incoming `Request` to a specific [`Shard`](#TODO) instance. A `Gateway` adheres to the user-defined [limit](#todo) of active connections per `Shard` and, in doing so, will reuse existing or create new `Shard` instances as necessary.

DOG includes convenience methods that allow `Shard` instances to directly communicate with other `Shard` instances belonging to the same `Gateway` – effectively a peer-to-peer/gossip network. Additionally, when dealing with active _client_ connections, a `Shard` class allows you to:

* [broadcast](#todo) a message to all active connections within the _entire_ cluster
* [emit](#todo) a message only to active connections owned by the `Shard` itself
* [whisper](#todo) a message to a single, targeted connection (via your [identification system](#todo)); even if it's owned by another `Shard` instance!

`Gateway` and `Shard` are both [abstract classes](https://www.typescriptlang.org/docs/handbook/classes.html#abstract-classes), which means that you're required — **and allowed** — to extend them with your own application needs. You may define your own class methods, add your own state properties, or use [Durable Storage](#TODO) to fulfill your needs.

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
    return auth && auth.replace(/^[^\s]+\s+/, '') || 'anonymous';
  }
}

// deployed as `TASK` binding
export class Task extends Shard {
  // WIP
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

### `Shard`

> **Note:** Refer to the [TypeScript definitions](/index.d.ts#33) for more information.


## License

MIT © Cloudflare
