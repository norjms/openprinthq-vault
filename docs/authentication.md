# Authentication in this fork

Upstream GyroidVault authenticates people itself: a registration form, bcrypt
password hashes, a JWT in a `pv_token` cookie, a CSRF token to go with it,
invite codes, password reset email and a login rate limiter with an IP block
list. All of that is gone here.

OpenPrintHQ already authenticates every request with Authentik before it
reaches this process. A second account system behind that one buys nothing and
costs plenty: a second password to manage, a second place a person can be
locked out of, and the two-app feeling of signing in twice to reach one set of
files.

## What replaces it

Identity arrives in headers, asserted by the edge, and this application maps it
to a local user row.

| Header | Set by | Meaning |
|---|---|---|
| `X-OPHQ-User` / `X-OPHQ-Email` / `X-OPHQ-Groups` | OpenPrintHQ control-plane | the tenant it is proxying |
| `X-authentik-username` / `X-authentik-email` / `X-authentik-groups` | Authentik forward-auth at the reverse proxy | a library reached directly |
| `X-OPHQ-Auth` | whichever of the two is in front | `<unix-timestamp>.<hmac>` proving the assertion came from the edge |

The OpenPrintHQ headers win when both are present.

`X-OPHQ-Auth` is `base64url(HMAC-SHA256(OPHQ_AUTH_SECRET, username + "\n" +
email + "\n" + groups + "\n" + timestamp))`. The signature covers the identity
as well as the timestamp, so a captured header cannot be replayed under a
different username, and it expires with the timestamp window.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPHQ_AUTH_SECRET` | unset | Shared secret for `X-OPHQ-Auth`. Unset means headers are trusted without proof, which is only safe when the edge is the sole possible caller. The process warns at boot when it is unset. |
| `OPHQ_AUTH_MAX_SKEW` | `300` | Seconds a signed assertion stays valid. |
| `OPHQ_ADMIN_GROUPS` | `openprinthq-admins,vault-admins,authentik Admins` | Groups mapped to the admin role. |
| `OPHQ_VIEWER_GROUPS` | `vault-viewers,openprinthq-viewers` | Groups mapped to read-only. |
| `OPHQ_DEFAULT_ROLE` | `uploader` | Role for anyone in neither list. |
| `OPHQ_LOGOUT_URL` | unset | Where the account menu sends someone to end their session. Empty hides the link. |
| `OPHQ_IDP_NAME` | `OpenPrintHQ` | Name shown wherever the UI points at the identity provider. |
| `OPHQ_PUBLIC_SHARES` | unset | `1` re-enables the unauthenticated share-link endpoint. |

## Roles

Roles are derived from group membership on every request, so a change in
Authentik takes effect on the next page load. The consequence worth knowing:
the local `users.role` column is a cache, not an authority, and editing it does
nothing. The user-management screen is therefore a read-only mirror.

## What else changed as a result

- **Every `/api` route requires an identity.** Upstream gated writes and left
  most reads open, including `/api/files/:id/download`, which handed any file
  to any caller who could reach the port. Reads are gated centrally now, so a
  route added later is closed unless someone opens it deliberately.
- **`/uploads` and `/library-files` are gated too.** They are how the files
  themselves are served, so leaving them open would have made the point above
  decorative.
- **Public share links are off by default.** They are an unauthenticated read
  path by design. Sharing outside the tenant belongs to OpenPrintHQ, which
  knows who the audience is. Set `OPHQ_PUBLIC_SHARES=1` to restore upstream
  behaviour.
- **No CSRF tokens.** CSRF defends a credential the browser attaches on its
  own. There is no such credential here: no cookie, no local session.
- **No SMTP.** Mail existed only for invites and password resets.
- **`/api/health`** is the one unauthenticated route, so a container
  healthcheck works before any edge is in front of it.

## Merging from upstream

`upstream` points at `TeeCodeDev/GyroidVault`. The auth changes are contained
in `server/middleware/auth.js`, the gate at the top of `server/index.js`, and
the removal of the auth routes, so an upstream release usually merges with
conflicts only where it touches those. Take upstream's version of anything that
is not auth, and keep this fork's version of the gate.
