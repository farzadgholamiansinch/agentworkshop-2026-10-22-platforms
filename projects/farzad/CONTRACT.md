# NodeLink Node module: contract (team farzad)

Owner: team `farzad`. Version: `0.1` (draft). Changes are announced in `#build` before they ship.

Nodes are virtual nodes running inside the board plugin `board/plugins/farzad/`. Every call between nodes,
and between nodes and the gateway, is a real HTTP/JSON call. Base URL: `/t/farzad/` on the group's board.

## 1. Message envelope

Every message, in both modes, uses this JSON object:

```json
{
  "messageId": "m-7f3a9c",
  "type": "request",
  "source": { "nodeId": "n1", "appId": "echo" },
  "destination": { "nodeId": "n4", "appId": "echo" },
  "timestamp": 1792915200123,
  "correlationId": "m-7f3a9c",
  "payload": { "any": "json" },
  "ttlMs": 2000
}
```

| Field | Type | Notes |
|---|---|---|
| `messageId` | string | Unique per message. |
| `type` | `request` \| `response` \| `oneway` \| `broadcast` | |
| `source` | `{nodeId, appId}` | Sender. |
| `destination` | `{nodeId, appId}` | For `broadcast`, `nodeId` is `"*"`. |
| `timestamp` | number | Epoch milliseconds when the message was sent. |
| `correlationId` | string | A `response` carries the `messageId` of its request. Otherwise the same as `messageId`. |
| `payload` | any JSON | |
| `ttlMs` | number, optional | Request timeout. Default 2000. |

Node IDs: `n1`, `n2`, and so on. Built-in apps on every node: `echo` (answers a request with its payload) and
`sink` (accepts one-way messages and broadcasts, no answer).

## 2. Error codes

An error is returned as `{"error": {"code": "<CODE>", "message": "<text>"}, "correlationId": "<id>"}`.

| Code | HTTP | Meaning |
|---|---|---|
| `UNKNOWN_NODE` | 404 | No node with that ID. |
| `UNKNOWN_APP` | 404 | The node exists but has no such application ID. |
| `TIMEOUT` | 504 | No response within `ttlMs`. |
| `NODE_UNAVAILABLE` | 503 | The node is known but down or killed. |
| `REJECTED` | 401 / 429 | Rejected by auth (401) or rate limit (429). |

## 3. Node endpoints (used by peers and by the gateway)

### `POST /t/farzad/n/<nodeId>/deliver`

Delivers one envelope to a node. Used by mesh peers and by the gateway.

- `request`: the answer is `200` with the `response` envelope in the body.
- `oneway` / `broadcast`: the answer is `202 {"accepted": true}`.
- Errors: see section 2.

### `POST /t/farzad/n/<nodeId>/heartbeat`

Mesh only. Body `{"from": "n2", "ts": 1792915200123}`. Answer `200 {"nodeId": "n4", "ts": ...}`.

## 4. Cluster control (used by Control, team platforms-tp)

| Call | Body | Effect |
|---|---|---|
| `POST /t/farzad/api/nodes` | `{"count": 1}` | Adds nodes, at most 20 in total. Answer: the new node IDs. |
| `DELETE /t/farzad/api/nodes/<nodeId>` | | Stops a node cleanly (deregisters). |
| `POST /t/farzad/api/reset` | `{"nodes": 5, "mode": "mesh"}` | Starts a fresh cluster of 3 to 20 nodes. |
| `POST /t/farzad/api/mode` | `{"mode": "mesh"}` or `{"mode": "gateway"}` | Switches mode at runtime, without a restart. |
| `POST /t/farzad/api/send` | `{"from": "n1", "type": "request", "to": {"nodeId": "n3", "appId": "echo"}, "payload": {}, "ttlMs": 2000}` | Makes one node send one message. Answer: the response or the error. |
| `POST /t/farzad/api/traffic` | `{"rate": 20, "mix": {"request": 0.6, "oneway": 0.3, "broadcast": 0.1}, "payloadBytes": 256}` | Built-in traffic generator. `{"rate": 0}` stops it. |
| `POST /t/farzad/api/chaos` | see below | Fault injection on nodes. |

Chaos bodies:

```json
{"action": "kill",  "nodeId": "n3"}
{"action": "revive","nodeId": "n3"}
{"action": "slow",  "nodeId": "n3", "delayMs": 800}
{"action": "drop",  "nodeId": "n3", "percent": 30}
{"action": "clear", "nodeId": "n3"}
```

A killed node stops answering and stops sending heartbeats, but stays in the list as `down`. Killing the gateway is
the Gateway team's hook, not ours.

## 5. State and events (used by Dashboard, team anders, and by Control)

### `GET /t/farzad/api/state`

```json
{
  "mode": "mesh",
  "nodes": [
    {"nodeId": "n1", "apps": ["echo", "sink"], "status": "up", "chaos": {"delayMs": 0, "dropPercent": 0}}
  ],
  "links": [ {"from": "n1", "to": "n2", "status": "up"} ],
  "connections": 20,
  "metrics": {
    "mesh":    {"p50Ms": 4, "p95Ms": 11, "throughputPerSec": 18.5, "errorRate": 0.01, "detectMs": 3100},
    "gateway": {"p50Ms": 0, "p95Ms": 0, "throughputPerSec": 0, "errorRate": 0, "detectMs": null}
  }
}
```

- `links` in mesh mode: one entry per node pair, both directions. In gateway mode: one link from each node to `gateway`.
- `connections`: open connections at this moment. Mesh: n·(n−1). Gateway: n.
- `detectMs`: time from killing a node to the first peer marking it down (mesh), or to the gateway reporting it
  (gateway mode).

### `GET /t/farzad/api/events?since=<seq>`

The latest events, oldest first, at most 200:

```json
{"seq": 1042, "events": [
  {"seq": 1041, "ts": 1792915200123, "kind": "message", "mode": "mesh", "messageId": "m-7f3a9c",
   "type": "request", "from": "n1", "to": "n4", "latencyMs": 6, "error": null},
  {"seq": 1042, "ts": 1792915200400, "kind": "node-down", "nodeId": "n3", "detectedBy": "n1", "detectMs": 3100}
]}
```

Event kinds: `message`, `node-up`, `node-down`, `mode-change`, `chaos`.

## 6. Gateway mode (what we expect from Gateway, team pisak)

Agreed in `#build`; the exact bodies are to be confirmed against `projects/pisak/CONTRACT.md`.

- On entering gateway mode each node calls `POST /t/pisak/api/register` with
  `{"nodeId": "n1", "apps": ["echo", "sink"], "deliverUrl": "/t/farzad/n/n1/deliver"}` and keeps the returned token.
- Each send goes to `POST /t/pisak/api/route` with the envelope from section 1 and `Authorization: Bearer <token>`.
- The gateway delivers to the node's `deliverUrl` and returns the node's answer, or an error from section 2.
- On leaving gateway mode, or when a node is stopped, it calls `POST /t/pisak/api/deregister` with `{"nodeId": "n1"}`.
