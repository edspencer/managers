#!/usr/bin/env bash
# Build a self-contained Managers release tarball from an already-built tree.
#
# Assumes `npm run build` has run (packages/{server,web}/dist exist). Produces
# managers-<version>.tgz containing exactly what a host needs to run the app:
#   package.json + package-lock.json (for `npm ci --omit=dev`)
#   packages/server/{package.json,dist}
#   packages/web/{package.json,dist}
#   LICENSE
#   INSTALL.md (run instructions)
#
# Consumer:  tar xzf managers-<v>.tgz && cd managers-<v> && npm ci --omit=dev \
#            && MANAGERS_DATA_DIR=/var/lib/managers node packages/server/dist/index.js
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./packages/server/package.json').version")"
OUT="managers-${VERSION}"
STAGE="dist-tarball/${OUT}"

test -d packages/server/dist || { echo "packages/server/dist missing — run 'npm run build' first" >&2; exit 1; }
test -d packages/web/dist    || { echo "packages/web/dist missing — run 'npm run build' first" >&2; exit 1; }

rm -rf dist-tarball
mkdir -p "${STAGE}/packages/server" "${STAGE}/packages/web"

cp package.json package-lock.json LICENSE "${STAGE}/"
cp packages/server/package.json "${STAGE}/packages/server/"
cp -R packages/server/dist "${STAGE}/packages/server/dist"
cp packages/web/package.json "${STAGE}/packages/web/"
cp -R packages/web/dist "${STAGE}/packages/web/dist"

cat > "${STAGE}/INSTALL.md" <<EOF
# Managers ${VERSION} — tarball install

\`\`\`sh
npm ci --omit=dev
MANAGERS_DATA_DIR=/var/lib/managers \\
CLAUDE_CODE_OAUTH_TOKEN=... \\
MANAGERS_AUTH_MODE=jwt \\
MANAGERS_AUTH_JWKS_URL=https://<idp>/.well-known/jwks.json \\
MANAGERS_AUTH_JWT_ISSUER=https://<idp>/ \\
MANAGERS_AUTH_JWT_AUDIENCE=managers \\
PORT=7234 HOST=0.0.0.0 \\
node packages/server/dist/index.js
\`\`\`

Requires Node.js >= 22. Chats resolve the Claude Agent SDK's own bundled binary, so
they work as-is; the \`claude\` CLI on PATH
(\`npm i -g @anthropic-ai/claude-code\`) is needed only for the post-turn sweeper
and for \`driveMode: batch\`.

Managers refuses to start with authentication off unless
\`MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1\` is set: with no auth, the agents it runs
on this host can act as you over its API. It also refuses a non-loopback bind
with no auth unless \`MANAGERS_DANGEROUSLY_ALLOW_OPEN=1\`. See AUTH.md in
https://github.com/edspencer/managers.

## Easier alternatives

\`\`\`sh
# No install, no clone (binds 127.0.0.1:7234):
npx @edspencer/managers
\`\`\`

For an always-on server, the Docker image (ghcr.io/edspencer/managers:${VERSION}) is
batteries-included. This tarball is the right choice when you want the app on the box
with no Docker and no registry access.
EOF

tar -czf "${OUT}.tgz" -C dist-tarball "${OUT}"
( command -v sha256sum >/dev/null && sha256sum "${OUT}.tgz" || shasum -a 256 "${OUT}.tgz" ) > "${OUT}.tgz.sha256"
rm -rf dist-tarball

echo "built ${OUT}.tgz"
cat "${OUT}.tgz.sha256"
