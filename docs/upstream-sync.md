# Keeping this fork in sync with upstream GyroidVault

This is a real fork of [TeeCodeDev/GyroidVault](https://github.com/TeeCodeDev/GyroidVault)
with upstream history and SHAs intact, so pulling upstream work is a MERGE, not a
port. That property is the whole reason the fork was made this way, and it is
easy to destroy: see "Never rewrite history" below.

## Branches

| Branch | What it is |
|---|---|
| `main` | A mirror of upstream. Nothing of ours lands here. |
| `dev` | Our work. This is what gets built. |
| `upstream/main` | The remote. Add with `git remote add upstream https://github.com/TeeCodeDev/GyroidVault.git` |

Working clone on docker01: `/opt/ophq-vault/repo`, with `upstream` already
configured.

## The procedure

```bash
cd /opt/ophq-vault/repo
git fetch upstream --tags
git log --oneline HEAD..upstream/main        # what is actually new

# Mirror upstream onto main. Fast-forward only: if this ever refuses, something
# of ours has landed on main and that is the bug to fix, not the flag to drop.
git checkout main && git merge --ff-only upstream/main && git push origin main

# Bring it into our branch.
git checkout dev && git merge upstream/main
```

Then resolve, run the gate below, build, and deploy.

## What will conflict, and how to resolve it

Our fork touches four files and deletes two areas. Upstream changes to anything
else merge cleanly. The four:

**`server/middleware/auth.js`** is entirely ours. Upstream's version
authenticates with local accounts, sessions and CSRF; ours reads a signed
identity asserted by the edge. Take OURS wholesale unless upstream has added
something that is not about authentication. Never take a hunk that reintroduces
a password, a token, a session or a CSRF check.

**`server/index.js`** is where the real work is. Three kinds of hunk:

- *New routes.* Take them, then check they are gated. Every `/api` route is
  gated centrally in this fork, so a new one is closed by default, but confirm
  rather than assume.
- *Auth-related changes.* Reject. Upstream will keep touching login,
  registration, invites, password reset, API keys and SMTP because it still has
  them. We deleted those routes; a merge that restores one restores a way into
  a tenant's library that does not go through Authentik.
- *Static serving and the SPA fallback.* Reject. We serve no frontend: the
  `express.static(public)` line and the `app.get('*')` fallback are gone
  deliberately and an unknown path returns 404.

**`package.json` / `package-lock.json`.** We removed the dependencies that went
with SMTP and the local account system. If upstream adds a dependency for a
feature we kept, take it; if it is for one we removed, do not. Also not taken:
`express-rate-limit` (its limiters were keyed to login) and `occt-import-js`,
which upstream only serves as static files to its own browser viewer.
Regenerate the lock rather than hand-merging it:
`docker run --rm -v $PWD:/w -w /w node:22-alpine npm install --package-lock-only --ignore-scripts`.

**Code that merges cleanly but still does not belong.** Conflict markers are
not the whole review. In the v2.1.1 merge these arrived outside any conflict:
`app.use('/api', apiLimiter)` and `heavyLimiter` on three download routes
(would crash at boot, `rateLimit` is not imported here), and
`scripts/seed-demo-data.js` (seeds an account with a fixed password) plus
`scripts/import-user-models.js` (imports from a path on upstream's machine),
which `COPY . .` ships in every tenant image. Grep the merged tree, not just
the conflicts.

**`public/`.** Deleted, along with `server/utils/email.js`. Upstream will keep
changing files in `public/`, and git will happily recreate them on merge as
"they modified, we deleted". Always resolve those as DELETED:

```bash
git status --short | awk '$1 ~ /^(DU|UD|AU|UA)$/ {print $2}'
git rm -r --cached public 2>/dev/null; rm -rf public
git rm --cached server/utils/email.js 2>/dev/null; rm -f server/utils/email.js
```

A merge that quietly restores `public/` puts an older, unauthenticated copy of
the whole UI back inside every tenant's container. That is the single worst
outcome of a careless sync, and it produces no error.

## The gate before building

Run all of it. Each line exists because the corresponding mistake is silent.

```bash
# 1. No frontend came back.
test ! -d public && echo "public: absent" || echo "FAIL: public/ is back"

# 2. No authentication routes came back.
grep -nE "auth/(login|register|logout|invite|forgot-password|reset-password)|api-keys|nodemailer" server/index.js \
  && echo "FAIL: an auth route or SMTP returned" || echo "auth routes: absent"

# 3. The central gate is still central: no /api route registered outside it,
#    and /uploads and /library-files are still behind authenticate.
grep -nE "app\.use\('/(uploads|library-files)'" server/index.js

# 4. Unknown paths 404 rather than serving a page.
grep -n "app.get('\*'" server/index.js

# 5. Nothing from the account system survived outside the conflicts.
grep -nE "Limiter|rateLimit|jwt\.|bcrypt|req\.cookies|getJwtSecret|smtp|occt" server/index.js
grep -lE "bcryptjs|jsonwebtoken|nodemailer" -r server scripts && echo "FAIL" || echo "deps: clean"

# 6. Every file parses.
docker run --rm -v $PWD:/w -w /w node:22-alpine sh -c 'for f in server/*.js server/*/*.js; do node --check $f || echo FAIL $f; done'
```

Before rolling out, also open a database written by the image prod is running
now with the new image (seed through the API, `docker stop`, start the new
image on the same data dir). The schema migrates in place on start, and this
is the only check that proves it does so for a real tenant's data.

Then, against a running container:

| Check | Expected |
|---|---|
| `/api/health` with no identity | 200 |
| `/api/models` with no identity | 401 |
| `/api/files/1/download` with no identity | 401 |
| `/uploads/` with no identity | 401 |
| `/` and `/index.html` | 404 |
| Signed headers with the username swapped | 401 |

`docs/authentication.md` carries the header contract those signed requests use.

## Building and rolling it out

Multi-arch, because prod is aarch64 and test is x86-64:

```bash
SHA=$(git rev-parse --short HEAD)
docker buildx build --builder ophqbuilder --platform linux/amd64,linux/arm64 \
  --provenance=false --sbom=false \
  -t ghcr.io/norjms/openprinthq-vault:test -t ghcr.io/norjms/openprinthq-vault:sha-$SHA \
  --push .
```

Then per tier: the GHCR package is PRIVATE and the control-plane holds no
registry credentials, so the image must be PRE-PULLED on the deploy host or the
library will not start. `ensureVault` compares the resolved image ID and
recreates each tenant on the next reconcile. Full procedure, including why the
recreate stops the container rather than killing it, is in
`openprinthq-terraform/docs/deploy-runbook.md`.

## Never rewrite history

Do not run a full-history rewrite on this repo. It re-hashes upstream's commits,
which destroys the shared merge base and turns every future sync from a merge
into a manual port. If authorship ever needs correcting, use a range-limited
rewrite over our own commits only, and never over upstream's.

## When to check

Upstream tags releases (`v1.4.0`, `v1.5.0`, ...), so `git fetch upstream --tags`
followed by `git tag -l` is the quickest look. We forked at `v1.5.0` (`e35a3f7`)
and last merged `v2.1.1` (`f7b139d`, merge `5600bfd`, 2026-09-25).

Checking is cheap and skipping it is how a fork drifts far enough that merging
stops being possible, which is the failure this document exists to prevent.
