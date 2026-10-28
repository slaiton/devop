/* Pruebas de la sesión de 12 h renovable (POST /auth/refresh): duración, renovación sin perder la hora de la
 * autenticación real (la reautenticación de acciones sensibles NO se puede saltar renovando), tope absoluto,
 * revocación y casos de borde.
 *
 * Uso (desde la raíz del repo, con postgres y api levantados; el contenedor necesita JWT_SECRET):
 *   docker compose exec -T api node - < apps/api/test/session-renewal.e2e.js
 *
 * Crea una organización de prueba y la borra al terminar. */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE = 'http://localhost:3000/api';
const SECRET = process.env.JWT_SECRET;
const PASSWORD = 'Passw0rd!sess';
const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });
const q = async (sql, params) => (await owner.query(sql, params)).rows;
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const now = () => Math.floor(Date.now() / 1000);
const TTL = 12 * 3600;

class Client {
  constructor() {
    this.jar = {};
    this.ip = `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
    this.lastSetCookie = null;
  }
  async call(method, path, body) {
    const headers = { 'x-forwarded-for': this.ip };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    this.lastSetCookie = null;
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (name === 'session') this.lastSetCookie = c;
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) delete this.jar[name];
      else this.jar[name] = value;
    }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }
  get token() {
    return jwt.decode(this.jar.session);
  }
}
const withToken = (payload, opts = { expiresIn: TTL }) => {
  const c = new Client();
  c.jar.session = jwt.sign(payload, SECRET, opts);
  return c;
};

(async () => {
  const suffix = crypto.randomBytes(3).toString('hex');
  const hash = await bcrypt.hash(PASSWORD, 10);
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('Sess', $1) RETURNING id`, [`sess-${suffix}`]))[0].id;
  const email = `admin-${suffix}@sess.test`;
  const user = (await q(`INSERT INTO users(email, name, password_hash) VALUES ($1, 'Admin', $2) RETURNING id`, [email, hash]))[0];
  await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, user.id, 'admin']);
  const base = { sub: user.id, orgId: org, amr: 'pwd', sv: 0 };

  try {
    // ---------------------------------------------------------------- duración
    const c = new Client();
    const login = await c.call('POST', '/auth/login', { email, password: PASSWORD });
    check('login ok', login.status === 201 && !!c.jar.session);
    const t0 = c.token;
    check('el token dura 12 h', t0.exp - t0.iat === TTL, `${t0.exp - t0.iat}`);
    check('la cookie también dura 12 h (Max-Age)', new RegExp(`Max-Age=${TTL}\\b`).test(c.lastSetCookie ?? ''), c.lastSetCookie);
    check('el token guarda la hora de la autenticación real (at)', Math.abs(t0.at - t0.iat) <= 2);
    const me = await c.call('GET', '/auth/me');
    check('/auth/me informa cuándo expira y cuánto dura la sesión', me.json.sessionExpiresAt === t0.exp * 1000 && me.json.sessionTtlMs === TTL * 1000, JSON.stringify(me.json));

    // ---------------------------------------------------------------- renovación
    const near = withToken({ ...base, at: now() - 3600 }, { expiresIn: 60 }); // le queda 1 minuto
    const before = near.token;
    const r = await near.call('POST', '/auth/refresh');
    const after = near.token;
    check('refresh con la sesión por vencer → ok', r.status === 201 && r.json.ok === true, JSON.stringify(r));
    check('refresh extiende la vigencia a 12 h desde ahora', after.exp - now() > TTL - 5 && after.exp > before.exp);
    check('refresh devuelve cuándo expira ahora', r.json.expiresAt === after.exp * 1000);
    check('refresh deja la cookie nueva con Max-Age de 12 h', new RegExp(`Max-Age=${TTL}\\b`).test(near.lastSetCookie ?? ''));
    check('refresh conserva identidad, versión y hora de la autenticación real', after.sub === user.id && after.orgId === org && after.sv === 0 && after.amr === 'pwd' && after.at === before.at, JSON.stringify({ before, after }));
    check('la sesión renovada sigue funcionando', (await near.call('GET', '/auth/me')).status === 200);

    // ---------------------------------------------------------------- renovar NO equivale a autenticarse de nuevo
    const sens = withToken({ ...base, at: now() - 600, iat: now() - 600 });
    const s1 = await sens.call('POST', '/auth/passkeys/register/options');
    check('acción sensible con autenticación de hace 10 min → REAUTH_REQUIRED', s1.status === 403 && s1.json.code === 'REAUTH_REQUIRED', JSON.stringify(s1));
    await sens.call('POST', '/auth/refresh');
    check('tras renovar, el token es nuevo (iat reciente) pero conserva la autenticación vieja', sens.token.iat >= now() - 3 && sens.token.at <= now() - 590);
    const s2 = await sens.call('POST', '/auth/passkeys/register/options');
    check('renovar la sesión NO salta la reautenticación de acciones sensibles', s2.status === 403 && s2.json.code === 'REAUTH_REQUIRED', JSON.stringify(s2));
    check('reautenticar con la contraseña sí lo habilita', (await sens.call('POST', '/auth/reauth', { password: PASSWORD })).status === 201 && (await sens.call('POST', '/auth/passkeys/register/options')).status === 201);
    check('y esa reautenticación actualiza la hora de autenticación real', now() - sens.token.at <= 3);

    // ---------------------------------------------------------------- tokens anteriores a este cambio (sin `at`)
    const legacyIat = now() - 1800;
    const legacy = withToken({ ...base, iat: legacyIat });
    check('un token viejo (sin at) se renueva', (await legacy.call('POST', '/auth/refresh')).status === 201);
    check('y su autenticación real se toma de su iat original', legacy.token.at === legacyIat, JSON.stringify(legacy.token));

    // ---------------------------------------------------------------- tope absoluto
    const tooOld = withToken({ ...base, at: now() - 8 * 86400, iat: now() - 60 });
    const old = await tooOld.call('POST', '/auth/refresh');
    check('pasado el tope absoluto (7 días desde la última autenticación) no se renueva → 401', old.status === 401 && /duración máxima/.test(JSON.stringify(old.json)), JSON.stringify(old));
    const okAge = withToken({ ...base, at: now() - 6 * 86400 });
    check('dentro del tope (6 días) sí se renueva', (await okAge.call('POST', '/auth/refresh')).status === 201);

    // ---------------------------------------------------------------- rechazos
    check('sin sesión → 401', (await new Client().call('POST', '/auth/refresh')).status === 401);
    const expired = withToken({ ...base, at: now() - 100 }, { expiresIn: -10 });
    check('con la sesión ya vencida → 401 (no se resucita)', (await expired.call('POST', '/auth/refresh')).status === 401);
    const forged = new Client();
    forged.jar.session = jwt.sign({ ...base, at: now() }, 'otro-secreto', { expiresIn: TTL });
    check('token firmado con otro secreto → 401', (await forged.call('POST', '/auth/refresh')).status === 401);
    await q('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [user.id]);
    const revoked = withToken({ ...base, sv: 0, at: now() });
    check('sesión revocada (cambió la versión) → no se puede renovar', (await revoked.call('POST', '/auth/refresh')).status === 401);
    const sv = (await q('SELECT session_version FROM users WHERE id = $1', [user.id]))[0].session_version;

    // ---------------------------------------------------------------- cambio de contraseña pendiente
    const mcp = withToken({ ...base, sv, mcp: true, at: now() });
    check('con cambio de contraseña pendiente: las demás rutas siguen bloqueadas', (await mcp.call('GET', '/dashboard/repositories')).status === 403);
    check('pero la sesión se puede renovar y conserva la marca de cambio pendiente', (await mcp.call('POST', '/auth/refresh')).status === 201 && mcp.token.mcp === true);

    // ---------------------------------------------------------------- uso normal tras renovar muchas veces
    const loop = withToken({ ...base, sv, at: now() - 100 });
    let ok = true;
    for (let i = 0; i < 5; i++) ok = ok && (await loop.call('POST', '/auth/refresh')).status === 201;
    check('renovar repetidamente mantiene la sesión válida y la hora de autenticación', ok && (await loop.call('GET', '/auth/me')).status === 200 && Math.abs(loop.token.at - (now() - 100)) <= 2);
  } finally {
    await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@sess.test`]);
    await q('DELETE FROM organizations WHERE id = $1', [org]);
    await owner.end();
  }
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
