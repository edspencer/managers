---
"@managers/server": patch
"@managers/web": patch
---

Runs that the Claude runtime refuses are now recorded as failed, not succeeded (#11). Claude Code answers a turn it cannot run (an expired login, a bad API key, billing) with a synthetic `model: "<synthetic>"` reply such as "Not logged in · Please run /login" and a `subtype: "success"` result. That reply used to be dropped as a placeholder, so the run read `succeeded`, `error: null`, with 0 output tokens. Now:

- such a turn, and any turn that ends with no assistant content and zero output tokens, is a `failed` run, with the runtime's own message (clipped, credentials redacted) as its `error` and a new `errorKind` (`runtime` or `no-output`). This holds on both drive modes (session and batch), and the `run-failed` alert carries the message;
- the run drawer says "The Claude runtime refused this run" above the message;
- the chat shows a "Claude couldn't run this turn" notice with the message, both live and after a reload, instead of leaving the prompt sitting there;
- when such failures repeat across workspaces (or with the same error), Home's Needs you shows ONE `runtime-unavailable` error ("Claude runtime is failing: … N runs failed since …"). The per-trigger `run-failed`/`stale` alerts it explains are folded into it, and the next successful run clears it.
