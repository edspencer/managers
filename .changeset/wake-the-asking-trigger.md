---
"@managers/server": patch
"@managers/web": patch
---

"Wake the manager now" wakes the trigger that asked, not only `wake`. A run that sets a task to awaiting-ed now records `raisedBy: {trigger, run}` on it (older tasks are traced through the run id in their log). Answering with wake fires that trigger, or falls back to `wake`, and never a trigger whose behaviour is off. `GET …/managers/wake` returns the same target per task (`trigger`, a `tasks` map, `?task=`), and the switch names a trigger other than `wake` ("runs roadmap").
