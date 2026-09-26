#!/usr/bin/env bash
# Run a command with no inherited Paddock/Managers config, credentials or NODE_ENV.
#
#   scripts/clean-env.sh npm run typecheck
#   scripts/clean-env.sh npm run test -w packages/server
#
# The dev box this fork grew up on exports ~40 PADDOCK_* vars (production
# Paddock's own config), NODE_ENV=production and a real Claude credential into
# every shell. Any of those reaching a test or a QA server either false-fails it
# or, worse, points it at production data / spends real API credit.
set -euo pipefail
for v in $(compgen -e); do
  case "$v" in PADDOCK_*|MANAGERS_*|NODE_ENV|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CONFIG_DIR) unset "$v";; esac
done
exec "$@"
