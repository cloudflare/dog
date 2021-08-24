import * as ws from 'worktop/ws';

interface Session {
	socket: WebSocket;
	quit?: boolean;
	name?: string;
}

export class Rooms {
	private timestamp: number;
	private storage: DurableObjectStorage;
	private sessions: Session[];

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
    this.sessions = [];
    this.timestamp = 0;
  }

  // The system will call fetch() whenever an HTTP req is sent to this Object. Such reqs
  // can only be sent from other Worker code, such as the code above; these reqs don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  async fetch(req: Request): Promise<Response> {
		let error = ws.connect(req);
		if (error) return error;

		let url = new URL(req.url);
		if (url.pathname !== '/stream') {
			return new Response('Not found', { status: 404 });
		}

		// Get the client's IP address for use with the rate limiter.
		let ip = req.headers.get('CF-Connecting-IP');

		let { 0: client, 1: server } = new WebSocketPair;

		// We're going to take pair[1] as our end, and return pair[0] to the client.
		await this.handleSession(server, ip);

		return new Response(null, {
			status: 101,
			statusText: 'Switching Protocols',
			webSocket: client
		});
  }

  // handleSession() implements our WebSocket-based chat protocol.
  async handleSession(socket: WebSocket, ip) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    socket.accept();

    // Create our session and add it to the sessions list.
    // We don't send any messages to the client until it has sent us the initial user info
    // message. Until then, we will queue messages in `session.blockedMessages`.
    let session: Session = {
			socket,
			blockedMessages: []
		};
    this.sessions.push(session);

    // Queue "join" messages for all online users, to populate the client's roster.
    this.sessions.forEach(otherSession => {
      if (otherSession.name) {
        session.blockedMessages.push(
					JSON.stringify({joined: otherSession.name})
				);
      }
    });

    // Load the last 100 messages from the chat history stored on disk, and send them to the
    // client.
    let storage = await this.storage.list({
			reverse: true,
			limit: 100,
		});

    let backlog = [...storage.values()];

    backlog.reverse().forEach(value => {
      session.blockedMessages.push(value);
    });

    // Set event handlers to receive messages.
    let receivedUserInfo = false;
    socket.addEventListener("message", async msg => {
      try {
        if (session.quit) {
          // Whoops, when trying to send to this WebSocket in the past, it threw an exception and
          // we marked it broken. But somehow we got another message? I guess try sending a
          // close(), which might throw, in which case we'll try to send an error, which will also
          // throw, and whatever, at least we won't accept the message. (This probably can't
          // actually happen. This is defensive coding.)
          socket.close(1011, "WebSocket broken.");
          return;
        }

        // I guess we'll use JSON.
        let data = JSON.parse(msg.data);

        if (!receivedUserInfo) {
          // The first message the client sends is the user info message with their name. Save it
          // into their session object.
          session.name = "" + (data.name || "anonymous");

          // Don't let people use ridiculously long names. (This is also enforced on the client,
          // so if they get here they are not using the intended client.)
          if (session.name.length > 32) {
            socket.send(JSON.stringify({error: "Name too long."}));
            socket.close(1009, "Name too long.");
            return;
          }

          // Deliver all the messages we queued up since the user connected.
          session.blockedMessages.forEach(queued => {
            socket.send(queued);
          });
          delete session.blockedMessages;

          // Broadcast to all other connections that this user has joined.
          this.broadcast({joined: session.name});

          socket.send(JSON.stringify({ready: true}));

          // Note that we've now received the user info message.
          receivedUserInfo = true;

          return;
        }

        // Construct sanitized message for storage and broadcast.
        data = { name: session.name, message: "" + data.message };

        // Block people from sending overly long messages. This is also enforced on the client,
        // so to trigger this the user must be bypassing the client code.
        if (data.message.length > 256) {
          socket.send(JSON.stringify({error: "Message too long."}));
          return;
        }

        // Add timestamp. Here's where this.timestamp comes in -- if we receive a bunch of
        // messages at the same time (or if the clock somehow goes backwards????), we'll assign
        // them sequential timestamps, so at least the ordering is maintained.
        data.timestamp = Math.max(Date.now(), this.timestamp + 1);
        this.timestamp = data.timestamp;

        // Broadcast the message to all other WebSockets.
        let dataStr = JSON.stringify(data);
        this.broadcast(dataStr);

        // Save message.
        let key = new Date(data.timestamp).toISOString();
        await this.storage.put(key, dataStr);
      } catch (err) {
        // Report any exceptions directly back to the client. As with our handleErrors() this
        // probably isn't what you'd want to do in production, but it's convenient when testing.
        socket.send(JSON.stringify({error: err.stack}));
      }
    });

    // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
    // a quit message.
    let closeOrErrorHandler = evt => {
      session.quit = true;
      this.sessions = this.sessions.filter(member => member !== session);
      if (session.name) {
        this.broadcast({quit: session.name});
      }
    };
    socket.addEventListener("close", closeOrErrorHandler);
    socket.addEventListener("error", closeOrErrorHandler);
  }

  // broadcast() broadcasts a message to all clients.
  broadcast(message) {
    // Apply JSON if we weren't given a string to start with.
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    // Iterate over all the sessions sending them messages.
    let quitters = [];
    this.sessions = this.sessions.filter(session => {
      if (session.name) {
        try {
          session.webSocket.send(message);
          return true;
        } catch (err) {
          // Whoops, this connection is dead. Remove it from the list and arrange to notify
          // everyone below.
          session.quit = true;
          quitters.push(session);
          return false;
        }
      } else {
        // This session hasn't sent the initial user info message yet, so we're not sending them
        // messages yet (no secret lurking!). Queue the message to be sent later.
        session.blockedMessages.push(message);
        return true;
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    });
  }
}

// // =======================================================================================
// // The RateLimiter Durable Object class.

// // RateLimiter implements a Durable Object that tracks the frequency of messages from a particular
// // source and decides when messages should be dropped because the source is sending too many
// // messages.
// //
// // We utilize this in ChatRoom, above, to apply a per-IP-address rate limit. These limits are
// // global, i.e. they apply across all chat rooms, so if a user spams one chat room, they will find
// // themselves rate limited in all other chat rooms simultaneously.
// export class RateLimiter {
//   constructor(controller, env) {
//     // Timestamp at which this IP will next be allowed to send a message. Start in the distant
//     // past, i.e. the IP can send a message now.
//     this.nextAllowedTime = 0;
//   }

//   // Our protocol is: POST when the IP performs an action, or GET to simply read the current limit.
//   // Either way, the result is the number of seconds to wait before allowing the IP to perform its
//   // next action.
//   async fetch(req) {
//     return await handleErrors(req, async () => {
//       let now = Date.now() / 1000;

//       this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

//       if (req.method == "POST") {
//         // POST req means the user performed an action.
//         // We allow one action per 5 seconds.
//         this.nextAllowedTime += 5;
//       }

//       // Return the number of seconds that the client needs to wait.
//       //
//       // We provide a "grace" period of 20 seconds, meaning that the client can make 4-5 reqs
//       // in a quick burst before they start being limited.
//       let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
//       return new Response(cooldown);
//     })
//   }
// }

// // RateLimiterClient implements rate limiting logic on the caller's side.
// class RateLimiterClient {
//   // The constructor takes two functions:
//   // * getLimiterStub() returns a new Durable Object stub for the RateLimiter object that manages
//   //   the limit. This may be called multiple times as needed to reconnect, if the connection is
//   //   lost.
//   // * reportError(err) is called when something goes wrong and the rate limiter is broken. It
//   //   should probably disconnect the client, so that they can reconnect and start over.
//   constructor(getLimiterStub, reportError) {
//     this.getLimiterStub = getLimiterStub;
//     this.reportError = reportError;

//     // Call the callback to get the initial stub.
//     this.limiter = getLimiterStub();

//     // When `inCooldown` is true, the rate limit is currently applied and checkLimit() will return
//     // false.
//     this.inCooldown = false;
//   }

//   // Call checkLimit() when a message is received to decide if it should be blocked due to the
//   // rate limit. Returns `true` if the message should be accepted, `false` to reject.
//   checkLimit() {
//     if (this.inCooldown) {
//       return false;
//     }
//     this.inCooldown = true;
//     this.callLimiter();
//     return true;
//   }

//   // callLimiter() is an internal method which talks to the rate limiter.
//   async callLimiter() {
//     try {
//       let response;
//       try {
//         // Currently, fetch() needs a valid URL even though it's not actually going to the
//         // internet. We may loosen this in the future to accept an arbitrary string. But for now,
//         // we have to provide a dummy URL that will be ignored at the other end anyway.
//         response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
//       } catch (err) {
//         // `fetch()` threw an exception. This is probably because the limiter has been
//         // disconnected. Stubs implement E-order semantics, meaning that calls to the same stub
//         // are delivered to the remote object in order, until the stub becomes disconnected, after
//         // which point all further calls fail. This guarantee makes a lot of complex interaction
//         // patterns easier, but it means we must be prepared for the occasional disconnect, as
//         // networks are inherently unreliable.
//         //
//         // Anyway, get a new limiter and try again. If it fails again, something else is probably
//         // wrong.
//         this.limiter = this.getLimiterStub();
//         response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
//       }

//       // The response indicates how long we want to pause before accepting more reqs.
//       let cooldown = +(await response.text());
//       await new Promise(resolve => setTimeout(resolve, cooldown * 1000));

//       // Done waiting.
//       this.inCooldown = false;
//     } catch (err) {
//       this.reportError(err);
//     }
//   }
// }
