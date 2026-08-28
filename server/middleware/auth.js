/*
 * Identity comes from the edge, never from this application.
 *
 * OpenPrintHQ fronts every request with Authentik. By the time a request
 * reaches this process a person has already proved who they are, so the
 * library has no login, no password hashes, no sessions and no CSRF tokens of
 * its own. It reads the identity the edge asserts, maps it to a local user
 * row, and gets on with serving files.
 *
 * Two header sets are accepted, in this order:
 *
 *   1. X-OPHQ-User / X-OPHQ-Email / X-OPHQ-Groups, set by the OpenPrintHQ
 *      control-plane when it proxies a tenant to their own library.
 *   2. X-authentik-username / X-authentik-email / X-authentik-groups, set by
 *      Authentik forward-auth at the reverse proxy, for a library reached
 *      directly rather than through the control-plane.
 *
 * A header is only an assertion, so it is trusted only when the caller can
 * prove it is the edge. Set OPHQ_AUTH_SECRET and every request must carry
 * X-OPHQ-Auth: <timestamp>.<hmac>, the HMAC taken over the asserted identity
 * and the timestamp. Without the secret the process trusts its headers
 * outright, which is only safe on the internal per-tenant network the
 * container normally runs on, so it says so loudly at boot.
 *
 * There is deliberately no fallback to a local password. A deployment that
 * loses its edge loses access, rather than quietly reopening a second door
 * into a tenant's files.
 */

const crypto = require('crypto');
const { get, run } = require('../database');

const SECRET = process.env.OPHQ_AUTH_SECRET || '';
const MAX_SKEW_SECONDS = Number(process.env.OPHQ_AUTH_MAX_SKEW || 300);

const ADMIN_GROUPS = splitList(process.env.OPHQ_ADMIN_GROUPS || 'openprinthq-admins,vault-admins,authentik Admins');
const VIEWER_GROUPS = splitList(process.env.OPHQ_VIEWER_GROUPS || 'vault-viewers,openprinthq-viewers');
// Everyone who is not explicitly an admin or a viewer can upload. The library
// is per tenant, so the common case is a single person who owns everything in
// it, and defaulting that person to read-only would be wrong.
const DEFAULT_ROLE = process.env.OPHQ_DEFAULT_ROLE || 'uploader';

function splitList(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function header(req, name) {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] || '';
  return typeof v === 'string' ? v : '';
}

/** Read the identity the edge asserts, whichever header set it uses. */
function assertedIdentity(req) {
  const username = header(req, 'x-ophq-user') || header(req, 'x-authentik-username');
  if (!username) return null;
  const email = header(req, 'x-ophq-email') || header(req, 'x-authentik-email') || '';
  // Authentik joins groups with '|', the control-plane sends them comma
  // separated. Accept either.
  const rawGroups = header(req, 'x-ophq-groups') || header(req, 'x-authentik-groups') || '';
  const groups = rawGroups.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
  return { username, email, groups, rawGroups };
}

/**
 * Verify X-OPHQ-Auth when a secret is configured.
 *
 * The signature covers the identity as well as the timestamp, so a captured
 * header cannot be replayed against a different username, and the timestamp
 * window keeps a captured one from being useful for long.
 */
function signatureValid(req, id) {
  if (!SECRET) return true;
  const presented = header(req, 'x-ophq-auth');
  const dot = presented.indexOf('.');
  if (dot < 1) return false;
  const ts = presented.slice(0, dot);
  const mac = presented.slice(dot + 1);
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) return false;
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`${id.username}\n${id.email}\n${id.rawGroups}\n${ts}`)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function roleFor(groups) {
  if (groups.some((g) => ADMIN_GROUPS.includes(g))) return 'admin';
  if (groups.some((g) => VIEWER_GROUPS.includes(g))) return 'viewer';
  return DEFAULT_ROLE;
}

/**
 * Map the asserted identity onto a local user row.
 *
 * Rows still exist because everything else in the schema points at a user id:
 * prints, uploads, shares, printers. They are a local mirror of an account
 * that lives in Authentik, never an account in their own right, so
 * password_hash is a sentinel no credential can ever match.
 *
 * The row is looked up by username first and email second, so a person whose
 * username changes in the IdP keeps their library rather than silently
 * starting a second one.
 */
function resolveUser(id) {
  const role = roleFor(id.groups);
  let row = get('SELECT * FROM users WHERE username = ?', [id.username]);
  if (!row && id.email) row = get('SELECT * FROM users WHERE email = ?', [id.email]);

  if (!row) {
    const r = run(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [id.username, id.email || null, '!sso', role]
    );
    return { id: r.lastId, username: id.username, email: id.email, role };
  }

  // Keep the mirror current: the IdP is the authority on name, address and
  // role, and a stale role here would outrank a group change made in Authentik.
  if (row.username !== id.username || (id.email && row.email !== id.email) || row.role !== role) {
    run('UPDATE users SET username = ?, email = ?, role = ? WHERE id = ?', [
      id.username,
      id.email || row.email || null,
      role,
      row.id
    ]);
  }
  return { id: row.id, username: id.username, email: id.email || row.email, role, preferred_slicer: row.preferred_slicer };
}

function authenticate(req, res, next) {
  // The gate in front of /api runs this once per request, and individual
  // routes still name it. Resolving twice would mean a second write to the
  // user row for every call, so a request that already has an identity passes
  // straight through.
  if (req.user) return next();

  const id = assertedIdentity(req);
  if (!id) return res.status(401).json({ error: 'No identity asserted by the edge' });
  if (!signatureValid(req, id)) return res.status(401).json({ error: 'Edge assertion failed verification' });

  try {
    req.user = resolveUser(id);
  } catch (e) {
    console.error('[auth] could not resolve asserted identity:', e.message);
    return res.status(500).json({ error: 'Could not resolve identity' });
  }

  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && req.user.role === 'viewer') {
    return res.status(403).json({ error: 'Viewer accounts cannot modify data' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') next();
  else res.status(403).json({ error: 'Admin privileges required' });
}

function requireUploader(req, res, next) {
  if (req.user && req.user.role !== 'viewer') next();
  else res.status(403).json({ error: 'Uploader privileges required' });
}

function warnIfUnsigned() {
  if (!SECRET) {
    console.warn(
      '[auth] OPHQ_AUTH_SECRET is not set: identity headers are trusted without a signature. ' +
      'Only run this way on a network where the edge is the sole possible caller.'
    );
  }
}

module.exports = { authenticate, requireAdmin, requireUploader, warnIfUnsigned, roleFor };
