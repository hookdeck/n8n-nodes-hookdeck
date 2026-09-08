# Transport: how events reach n8n

The trigger picks one of two delivery routes when you publish the workflow,
based on whether Hookdeck can reach the address n8n advertises.

| n8n's webhook URL | Destination | How events arrive |
| --- | --- | --- |
| Publicly reachable — n8n Cloud, or self-hosted with a public address | `HTTP` | Hookdeck makes a request to n8n directly |
| Not reachable — a laptop, or an instance behind NAT | `CLI` | Hookdeck sends events to `hookdeck listen`, which forwards them to n8n |

There is nothing to configure. Both routes sign deliveries the same way, so
signature verification behaves identically and the workflow receives the same
item either way.

This is about reachability, not about development. A self-hosted n8n behind NAT
uses the CLI route in production just as a laptop does.

## Running the CLI route

The node writes the exact commands to n8n's server log when the workflow is
published — that is the console n8n itself is running in, not the **Logs** panel
in the editor, which only shows workflow executions. Run them alongside n8n:

```bash
hookdeck ci --api-key <your Event Gateway project API key>
hookdeck listen 5678 <source> --device-name n8n-<host>-<instance>
```

`hookdeck ci` matters: `hookdeck listen` otherwise uses whichever project the
CLI was last logged into, and pointing it at the wrong one looks like the node
is broken. `--device-name` keeps two n8n instances from being treated as one
listener restarting.

**No connection is named in that command, deliberately.** An n8n trigger has two
webhook URLs — the live one used while the workflow is active, and a separate
one used by **Listen for test event** in the editor. The node provisions a
Hookdeck connection for each, both on the same source. Naming a connection
attaches the CLI to that one alone, so a command naming the live connection
would leave test events with no CLI session — and events for a connection with
no session are not recorded at all. Naming only the source attaches to every
connection the source has.

The CLI picks up the connections that exist when it starts, so restart it after
the first use of **Listen for test event**, which is when n8n creates the second
connection.

## What the CLI route cannot do

- **No Delivery Rate Limit and no Delivery Group.** Hookdeck supports these on
  directly reachable destinations only. If they are set, the node does not send
  them and says so in the log.
- **Events are not held for a listener that is not there.** Two cases, and the
  second is the one that bites:
  - `hookdeck listen` was running and dropped. The session stays eligible for
    two minutes, so the event is created and the attempt fails with
    `CLI_UNAVAILABLE`. The connection's retry rule then applies — five
    exponential retries from a minute apart by default, roughly half an hour of
    recovery. Beyond that, retry it by hand.
  - **No CLI session exists at all. No event is created for that connection.**
    Measured: with two CLI connections on one source and a listener on only one
    of them, the listened connection recorded two events and the unlistened one
    recorded zero. There is nothing queued, nothing failed, and nothing to
    retry — the delivery simply is not recorded against that connection.

That last point decides whether this route suits production, and the answer
depends on how you run the CLI. A terminal window on a laptop is not production
whatever the retry settings. A supervised process on a server — a systemd unit,
or a container with a restart policy — keeps outages to seconds, which the retry
rule covers.

## Test runs on each route

**Listen for test event** provisions a *separate* connection against n8n's test
URL, tracked independently, so a test run never disturbs the production
connection. On the direct route that connection is deleted when the listen
window closes, since the URL behind it stops answering after 120 seconds. On
the CLI route it is **paused** instead: deleting it would mean every test run
created a new connection that a running `hookdeck listen` is not attached to,
so the CLI would need restarting each time. Paused, it keeps its ID, the CLI
stays attached, and the next test run unpauses it.

Both connections share one source, so they share one source URL — there is no
second URL to configure for testing. The flip side is that while you are
listening for a test event **on a workflow that is also published**, each
incoming event is delivered twice: once to the published workflow and once to
the test listener.

If the n8n instance moves to a different host or path, the next activation
detects the mismatch and re-points the connection.
