#!/usr/bin/env bash
# docs-media rig launcher.
#
# Stands up a Paddock instance that is safe to photograph: synthetic projects,
# a fake `claude`, an isolated Claude home, no credentials, no branding.
#
# Required env:
#   MANAGERS_RIG_HOME    scratch root — holds home/, data/, projects/
#   MANAGERS_RIG_CLONE   a built checkout (packages/{web,server}/dist)
# Optional:
#   MANAGERS_RIG_PROJECTS   projects root (default "$MANAGERS_RIG_HOME/projects")
#   MANAGERS_RIG_USER_HOME  the instance's HOME (default "$MANAGERS_RIG_HOME/home").
#                          Set a presentable fictional path before shooting
#                          Discover — see the note at the HOME export below.
#   MANAGERS_RIG_FIXTURES   prompt->reply JSON map for the fake `claude`
#   PORT                   injected by the process manager; required
set -euo pipefail

RIG="${MANAGERS_RIG_HOME:?set MANAGERS_RIG_HOME}"
CLONE="${MANAGERS_RIG_CLONE:?set MANAGERS_RIG_CLONE}"

# ---------------------------------------------------------------------------
# Re-exec under a SCRUBBED environment. This is the load-bearing safety
# mechanism of the whole file, not a tidiness measure.
#
# A process manager copies the operator's whole environment. If an inherited
# CLAUDE_CODE_OAUTH_TOKEN meets a drive mode that ignores the fake `claude`,
# the rig quietly bills real money while LOOKING like it worked: turns complete
# fast, with plausible replies. `env -i` removes the ingredient rather than
# relying on remembering to unset it.
# ---------------------------------------------------------------------------
if [ -z "${DOCS_MEDIA_CLEANENV:-}" ]; then
  exec /usr/bin/env -i \
    DOCS_MEDIA_CLEANENV=1 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PORT="${PORT:-}" \
    TERM=xterm \
    MANAGERS_RIG_HOME="$RIG" \
    MANAGERS_RIG_CLONE="$CLONE" \
    MANAGERS_RIG_PROJECTS="${MANAGERS_RIG_PROJECTS:-}" \
    MANAGERS_RIG_USER_HOME="${MANAGERS_RIG_USER_HOME:-}" \
    MANAGERS_RIG_FIXTURES="${MANAGERS_RIG_FIXTURES:-}" \
    "$0" "$@"
fi

# --- isolation --------------------------------------------------------------
# HOME and CLAUDE_CONFIG_DIR must BOTH be isolated. MANAGERS_DATA_DIR isolates
# the data dir only; anything resolving the Claude home via os.homedir() lands
# on the operator's real ~/.claude — real transcripts and a real login.
# Overridable, because on the DISCOVER screen the home path IS the content
# rather than chrome around it: DiscoverView renders `{candidate.path}` and
# `{result.homeDir}` verbatim inside <code>, and nothing in that component
# truncates or abbreviates a path. A rig whose HOME sits under a scratch
# directory therefore cannot produce a publishable Discover frame at all, and
# none of the usual escapes work:
#   - cropping fails, because the path is the SUBJECT of the shot;
#   - masking fails, because capture.mjs would blank the element being shot;
#   - a symlink fails, because paddock canonicalises the path for display.
# Point this at a presentable fictional home (e.g. /home/<demo>) before shooting
# Discover. Do NOT "simplify" it back to a fixed path — that is the bug.
export HOME="${MANAGERS_RIG_USER_HOME:-$RIG/home}"

# Precedence is CLAUDE_CONFIG_DIR > `claudeHome:` > <dataDir>/claude-home.
# CLAUDE_HOME was removed (#691) and is IGNORED rather than an error, so a
# launcher still exporting it silently falls back to the default while you
# believe you isolated. Paddock also refuses to start if the home resolves to a
# user's own ~/.claude — a guard, not a substitute for setting this correctly.
export CLAUDE_CONFIG_DIR="$RIG/data/claude-home"
export MANAGERS_DATA_DIR="$RIG/data"

# --- the projects root ------------------------------------------------------
# MUST be on persistent storage. The previous rig pointed this at /home/demo on
# a box where only /data was a volume; a container restart destroyed every
# project.yaml and every .chats/*.jsonl while the data dir survived, leaving
# orphaned job records that reported chats whose transcripts were gone.
export MANAGERS_PROJECTS_DIR="${MANAGERS_RIG_PROJECTS:-$RIG/projects}"
export MANAGERS_WEB_DIST="$CLONE/packages/web/dist"

# --- exposure ---------------------------------------------------------------
# Auth is OFF, so bind LOOPBACK ONLY. Capture runs on the same host, so this is
# sufficient — and it means the rig is never reachable from the network. Do not
# reach for MANAGERS_DANGEROUSLY_ALLOW_OPEN to bind 0.0.0.0 instead: with auth
# off that publishes an unauthenticated instance.
export MANAGERS_AUTH_MODE=none
export HOST=127.0.0.1
export MANAGERS_OPENAPI_ENABLED=1
export LOG_LEVEL=info

# --- $0 turns ---------------------------------------------------------------
# The fake `claude` is a CLI stub, so turns MUST run on the batch runtime. The
# DEFAULT drive mode is `session`, which uses the SDK runtime, ignores PATH
# entirely, and would call the real API. This line is what stops real billing.
export MANAGERS_DRIVE_MODE=batch
export PATH="$CLONE/test/bin:$PATH"

# A prompt -> reply JSON map, so the replies that land ON CAMERA are authored
# rather than improvised. Without it the fake `claude` echoes the prompt back,
# which photographs as an obviously fake conversation.
if [ -n "${MANAGERS_RIG_FIXTURES:-}" ]; then
  export MANAGERS_FAKE_SCRIPT="$MANAGERS_RIG_FIXTURES"
fi

# Belt and braces after `env -i`: derive the unset list from the environment
# rather than hand-writing it, so a newly-added credential var is covered.
for v in $(env | cut -d= -f1 | grep -E 'TOKEN|API_KEY|SECRET|PASSWORD|_KEY$' || true); do
  unset "$v" || true
done
unset MANAGERS_BRAND_NAME MANAGERS_BRAND_LOGO MANAGERS_BRAND_ACCENT || true

echo "docs-media rig: HOME=$HOME DATA=$MANAGERS_DATA_DIR PROJECTS=$MANAGERS_PROJECTS_DIR PORT=${PORT:-unset}"
exec node "$CLONE/packages/server/dist/cli/paddock.js" --port "${PORT:?PORT not injected}"
