---
"@managers/server": minor
"@managers/web": patch
---

Chat turns now see state changes made since the chat's previous turn. Each later human turn of an open chat is sent a bounded "Changed since your last turn" block (Ed's answers, task and objective updates, new episodes from Ed, runs and other chats, by id), and nothing when nothing changed. A reloaded chat shows only what Ed typed.
