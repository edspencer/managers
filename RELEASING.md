# Releasing Managers

Managers is an **application**, not a set of libraries. Its release pipeline is
Paddock's, ported (edspencer/paddock `release.yml`, `RELEASING.md`). We use
[changesets](https://github.com/changesets/changesets) for versioning and
changelogs. The workspace packages (`@managers/server`, `@managers/web`) stay
`private` and are never published under their own names. Every release produces:

- **Docker images** for linux/amd64 + linux/arm64:
  - `ghcr.io/edspencer/managers:<version>` and `:latest`, the lean runtime (`base`);
  - `ghcr.io/edspencer/managers:<version>-devbox` and `:devbox`, base plus the
    coding-agent toolbox (PM2/`pm`, Playwright Chromium, Docker CLI, kubectl,
    python/uv, ffmpeg);
- **an npm package**, `@edspencer/managers`, with a provenance attestation. This is
  the `npx` / `npm i -g` entry point and the `managers` command;
- **a release tarball**, `managers-<version>.tgz` (+ `.sha256`, plus a stable-named
  `managers-latest.tgz` copy), attached to the GitHub Release `v<version>`.

All three come from `.github/workflows/release.yml`.

## Versioning model

- `@managers/server` and `@managers/web` are `fixed` together in
  `.changeset/config.json`, so they always share one number. **That number is "the
  Managers version".** `scripts/sync-root-version.mjs` keeps the repo-root
  `managers` version in lockstep.
- 0.1.0 was the unpublished fork (milestones M1–M15, tags `m1`…`m14.5`). The first
  published release is **0.2.0**, carried by `.changeset/first-release.md`.
- Pre-1.0, a `minor` bump is the "something you would notice" bump (new
  capability, changed default, changed config or data layout); `patch` is a fix.

## Day-to-day: adding a changeset

When a PR makes a user-facing change, add a changeset in the same PR:

```sh
npm run changeset
# pick the bump (patch/minor/major) and write a one-line summary
git add .changeset && git commit -m "chore: add changeset"
```

**Name `@managers/server` and/or `@managers/web`, never `@edspencer/managers`.** The
published package is synthesized at release time and is not a workspace member, so
a changeset naming it passes every PR check, merges green, and then breaks
`changeset version` in the Release workflow on that merge and every merge after it
(this happened in Paddock). Check before merging:

```sh
npx changeset status --since origin/main   # read-only: what the next bump would be
```

No changeset is needed for pure-internal changes (tests, CI, refactors with no
observable effect).

## Cutting a release

1. Merge feature PRs, each with its changeset, into `main`.
2. The **Release** workflow opens or updates a **"chore: version packages"** PR that
   bumps the version, prepends to `packages/*/CHANGELOG.md` and refreshes the
   lockfile.
3. **Merge that PR.** In the same workflow run, the merge commit then:
   1. `verify-ci`: waits for **CI on that exact commit** and refuses to go on
      unless it concluded `success`;
   2. `build-image`: builds base + devbox on native amd64 and arm64 runners
      (four legs), each pushing by digest;
   3. `artifacts`: merges the digests into the multi-arch tags, builds the
      tarball, creates the GitHub Release `v<version>` (which creates the tag),
      then regenerates `openapi-site/open-api.json` and commits it to `main`;
   4. `publish-npm`: stages the package (`scripts/make-npm-package.mjs`),
      `npm publish`es it over OIDC, and fails the run if no provenance
      attestation appears.

`workflow_dispatch` (Actions → Release → Run workflow) re-runs the pipeline. It
only publishes when the current version has no `v<version>` tag yet, so it is safe
to re-run after a partial failure. npm is gated on `verify-ci` **and** every image
leg, because it is the one leg that cannot be undone: a published npm version can
never be republished.

### The version PR's own checks are not enough

The version PR is opened by `github-actions[bot]`, and GitHub parks workflow runs
on bot-authored PRs at **`action_required`**. So the PR can look mergeable while
typecheck, tests and E2E never ran. Approve the parked run (on the PR: the
pending CI run → *Approve and run*) if you want a verdict before merging. Either
way, `verify-ci` blocks every artifact unless CI passed on the merge commit. If
CI is red for a reason you judge unrelated, re-run CI until it is green, then
re-run the Release workflow by hand.

## The npm package is synthesized, not a workspace package

`scripts/make-npm-package.mjs` stages a single public package from the built
output into `dist-npm/`. The workspace manifests are left alone: flipping their
`private` flag would make every future `npm publish` in the repo a loaded gun
pointed at an internal-named package.

- **bin:** `managers` → `packages/server/dist/cli/managers.js`.
- **Sourcemaps are stripped** (files and `sourceMappingURL` comments). The Docker
  image and the tarball keep theirs.
- **Dependencies are pinned** to the exact versions in `package-lock.json`, because
  a lockfile does not travel with a published package. Pinned, the closure `npx`
  users get is the closure CI tested.
- A `preinstall` notice warns that the first install downloads ~250 MB (the Claude
  Agent SDK's platform binary).

## npm auth: OIDC trusted publishing, no token

`publish-npm` authenticates with **OIDC trusted publishing**. There is no
`NPM_TOKEN` secret and there should never be one. It needs `id-token: write`,
npm ≥ 11.5.1 (Node 22 ships npm 10, so the job upgrades it), `registry-url` on
`setup-node`, and a trusted publisher configured for this repository and workflow
at <https://www.npmjs.com/package/@edspencer/managers/access>. Provenance is
requested explicitly (`publishConfig.provenance`) and verified after publishing.

## One-time setup (before the first release)

Do these **before** merging the first "chore: version packages" PR. Nothing in
the pipeline needs a secret.

### 1. GitHub repository settings

- **Settings → Actions → General → Workflow permissions**: tick **"Allow GitHub
  Actions to create and approve pull requests"**. Without it, the changesets step
  fails with *"GitHub Actions is not permitted to create or approve pull
  requests"* and no version PR ever appears. (Default permissions can stay
  *Read*; the workflow asks for what it needs per job.)
  Equivalent: `gh api -X PUT repos/edspencer/managers/actions/permissions/workflow
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`.

### 2. Claim the npm name with a placeholder (bootstrap)

A brand-new package **cannot** be created by OIDC: npm has no settings page for a
package that does not exist, so there is nowhere to attach a trusted publisher
([npm/cli#8544](https://github.com/npm/cli/issues/8544)). Paddock broke this
chicken-and-egg with a code-free placeholder; do the same (on a laptop, since the
dev box has no npm credentials):

```sh
mkdir /tmp/managers-bootstrap && cd /tmp/managers-bootstrap
cat > package.json <<'EOF'
{
  "name": "@edspencer/managers",
  "version": "0.0.1",
  "description": "Placeholder. Install a real release: npm i -g @edspencer/managers@latest",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/edspencer/managers.git" },
  "publishConfig": { "access": "public" }
}
EOF
npm login                       # web login + 2FA; a 2-hour session, no token stored
npm publish --tag bootstrap
```

Deliberately **no** `bin`, **no** dependencies, **no** scripts and **no**
`publishConfig.provenance` (npm refuses provenance outside a supported CI:
*"Automatic provenance generation not supported outside of GitHub Actions"*).

Expect two things, both seen with Paddock:

- **`--tag bootstrap` does not keep it off `latest`** on a first publish; npm sets
  `latest` anyway. Until the first CI release moves `latest` on,
  `npx @edspencer/managers` fails with "could not determine executable to run".
  Keep that window short.
- The package may **404 for a minute or two** after the publish (the packument
  replicates separately). The settings page does not wait for it.

### 3. Configure the trusted publisher

At <https://www.npmjs.com/package/@edspencer/managers/access> → **Trusted
Publisher** → GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `edspencer` |
| Repository | `managers` |
| Workflow filename | `release.yml` |
| Environment | *(blank)* |

Then, on the same page under **Publishing access**, choose **"Require two-factor
authentication and disallow tokens"**. Trusted publishing keeps working, and no
token can publish this package.

### 4. GHCR: make the images public, once they exist

The first release run creates `ghcr.io/edspencer/managers` as a **private**
package (GitHub's default for a new container package). After that run, at
<https://github.com/users/edspencer/packages/container/managers/settings>:

- **Danger Zone → Change visibility → Public**. Until then `docker pull` needs a
  login, and anonymous pulls fail with `denied`.
- Check **Manage Actions access** lists `edspencer/managers` with **Write** (a
  package created by that repository's workflow is linked to it automatically;
  the image also carries an `org.opencontainers.image.source` label).

Verify anonymously: `docker pull ghcr.io/edspencer/managers:<version>`.

## Running an artifact

**npm (a laptop):**

```sh
npx @edspencer/managers            # or: npm i -g @edspencer/managers && managers
```

It binds `127.0.0.1:7234` with auth off. On a loopback bind only, the `managers`
command allows that without `MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH` (and shows the
no-auth banner). Set that variable to `0` to make it refuse instead.

**Docker (a server, VM or LXC):**

```sh
docker run -d --name managers -p 127.0.0.1:7234:7234 -v /srv/managers-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e MANAGERS_AUTH_MODE=jwt \
  -e MANAGERS_AUTH_JWKS_URL=https://<idp>/.well-known/jwks.json \
  -e MANAGERS_AUTH_JWT_ISSUER=https://<idp>/ \
  -e MANAGERS_AUTH_JWT_AUDIENCE=managers \
  ghcr.io/edspencer/managers:0.2.0
```

The image binds `0.0.0.0`. With auth `none` it refuses to start unless both
`MANAGERS_DANGEROUSLY_ALLOW_NO_AUTH=1` and `MANAGERS_DANGEROUSLY_ALLOW_OPEN=1` are
set. The CLI's loopback default does not apply: the image runs
`node packages/server/dist/index.js`, not the `managers` command.

**Tarball:** see `INSTALL.md` inside it. In short: `npm ci --omit=dev`, then
`node packages/server/dist/index.js` (Node ≥ 22).

## Local dry-runs

```sh
scripts/clean-env.sh npm run build
scripts/clean-env.sh node scripts/make-npm-package.mjs   # stages dist-npm/
(cd dist-npm && npm pack)                                # edspencer-managers-<v>.tgz
bash scripts/make-tarball.sh                             # managers-<v>.tgz
docker build --target base -t managers:dev .             # the image (devbox: --target devbox)
npx changeset status --since origin/main                 # what the next bump would be
```

To try the npm package without publishing it, install the packed tarball into a
scratch prefix with an isolated `HOME` and no Claude credentials:

```sh
npm i -g --prefix /tmp/mgr-prefix ./dist-npm/edspencer-managers-*.tgz
env -i PATH=/tmp/mgr-prefix/bin:$PATH HOME=/tmp/mgr-home managers --data-dir /tmp/mgr-data
```

## What this pipeline does not do

It **publishes** artifacts. It does not **deploy** them. Rolling a version out to
a running instance (for example, the managers.valfenda.net LXC) is a separate
step: pull the new image tag, or `npm i -g @edspencer/managers@<version>`, then
restart.
