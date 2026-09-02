# Offline model

Field sites have poor connectivity, so the app is built around a deliberate line:
**some work requires a network and some must not.** Getting that line in the wrong
place is what makes offline systems either useless or corrupt.

## Where the line is

| Workflow             | Offline? | Why                                                                                                                                                                                  |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — New** (intake) | ❌ No    | Serials are globally unique and trigger an email to the PM. A device cannot mint `NIT26-001` without risking a collision, so the flow shows an explicit "connection required" state. |
| **B — Transfer**     | ✅ Yes   | Acts only on serials the device already cached. The phone validates each scan locally, writes to the outbox, and syncs later.                                                        |
| **C — Returns** (M4) | ✅ Yes   | Same shape as B, plus a signature captured on-device.                                                                                                                                |

## The two local stores

`apps/mobile/src/db/` — one `Store` interface, two backends. Android gets
`expo-sqlite`; the web export gets an in-memory stand-in, because `expo-sqlite` on
web needs a wasm asset plus cross-origin-isolation headers that the API's static
`/app` mount does not send. Web is a demo surface, Android is the field target.

**1. The batch mirror** (`cached_batch`, `cached_cylinder`, `cached_site`).
Written when a technician selects a batch — while they still have signal. The
scanner then answers "does this serial belong to this batch?" with no round trip.
Re-caching **replaces** a batch's cylinder list rather than merging it: a cylinder
the server no longer reports must disappear locally, or the scanner would go on
accepting a serial that has left the batch.

**2. The outbox** (`outbox`). Every field mutation is written here _before_ it is
POSTed. If the app dies between the two, the work is already durable.

```
scan → destination → [outbox row written] → POST → settle
                            │                 ↑
                            └── no signal ────┘ retried by the sync worker
```

## Idempotency: the key is the row id

`outbox.id` **is** the request's `clientRequestId` — for transfers (`kind: 'transfer'`) and returns (`kind: 'return'`) alike. It is minted once, at enqueue,
where the intent is formed — never per attempt.

This is the single most important rule in this file, and it was violated once
already: M2's New flow minted a fresh key per attempt, so retrying a partial failure
re-created batches and re-emailed the PM. The server's idempotency was unreachable
because the client never presented the same key twice.

Making the key the primary key enforces the rule structurally — `INSERT OR IGNORE`
means a double submit cannot create a second row, and cannot reset the attempt count
of a row that is already in flight.

## Retry policy

The sync worker (`src/sync/worker.ts`) drains oldest-first, so work replays in the
order it happened.

| Server said           | Worker does                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2xx                   | settle `done`, keep the response for the result screen                                                                                               |
| **401**               | **stop the drain**, leave every row pending. The session is gone; burning rows against it would only waste attempts. Flushes after the next sign-in. |
| 4xx (other)           | park as `rejected`. The server understood us and said no — replaying identical bytes gets the same answer forever, so a human is needed.             |
| 5xx / network failure | defer with exponential backoff: 5s, 10s, 20s … capped at 5 min                                                                                       |

Concurrent `flushOutbox()` calls share one pass, so a row is never sent twice.

## What the server guarantees in return

A replayed transfer is not merely deduplicated — `POST /transfers` returns **200 with
the original transfer**, including the serials it moved. Two devices replaying the
same queued row at once both get a usable answer (the loser of the unique-index race
falls through to the replay path), because an outbox retry that 409s is an outbox
retry that never clears.

Rejections come back **per serial**, not as a blanket failure, so a queued transfer
that partly conflicts still moves what it legally can and names the cylinders it
could not.
