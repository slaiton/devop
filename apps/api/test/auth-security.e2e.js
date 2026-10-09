/* Pruebas de punta a punta de passkeys y seguridad de cuenta contra una API en marcha.
 *
 * No necesita navegador ni dispositivo: incluye un autenticador de software que genera
 * claves ES256 y arma atestaciones/aserciones WebAuthn reales, así que el servidor las
 * verifica con la misma librería que usa en producción.
 *
 * Uso (desde la raíz del repo, con el stack levantado: postgres, redis y api):
 *   docker compose exec -T api node - < apps/api/test/auth-security.e2e.js
 *
 * Crea su propia organización de prueba y la borra al terminar. Requiere que el contenedor
 * tenga PUBLIC_WEB_ORIGIN, JWT_SECRET y MIGRATIONS_DATABASE_URL (los trae el .env). */
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createAccountToken } = require('/repo/apps/api/dist/modules/auth/accountTokens.js');

const BASE = 'http://localhost:3000/api';
const ORIGIN = (process.env.PUBLIC_WEB_ORIGIN || '').replace(/\/+$/, '');
const RP_ID = new URL(ORIGIN).hostname;
const SECRET = process.env.JWT_SECRET;
const owner = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL });

// ---------- mini CBOR + autenticador de software ----------
const head = (major, n) => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
};
const cInt = (n) => (n >= 0 ? head(0, n) : head(1, -1 - n));
const cBytes = (b) => Buffer.concat([head(2, b.length), b]);
const cText = (s) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cMap = (entries) => Buffer.concat([head(5, entries.length), ...entries.flat()]);
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

class SoftAuthenticator {
  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cMap([
      [cInt(1), cInt(2)],
      [cInt(3), cInt(-7)],
      [cInt(-1), cInt(1)],
      [cInt(-2), cBytes(Buffer.from(jwk.x, 'base64url'))],
      [cInt(-3), cBytes(Buffer.from(jwk.y, 'base64url'))],
    ]);
    this.credentialId = crypto.randomBytes(32);
    this.userHandle = null;
  }

  register(options, { origin = ORIGIN, flags = 0x45 /* UP|UV|AT */, rpId = RP_ID } = {}) {
    this.userHandle = options.user.id;
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([flags]),
      u32(0),
      Buffer.alloc(16),
      Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 255]),
      this.credentialId,
      this.cose,
    ]);
    const attestationObject = cMap([
      [cText('fmt'), cText('none')],
      [cText('attStmt'), cMap([])],
      [cText('authData'), cBytes(authData)],
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  assert(options, { counter, origin = ORIGIN, flags = 0x05 /* UP|UV */, tamper = false, credentialId = this.credentialId } = {}) {
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([flags]), u32(counter)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    let signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    if (tamper) signature = Buffer.from(signature.map((byte, i) => (i === 10 ? byte ^ 0xff : byte)));
    return {
      id: b64u(credentialId),
      rawId: b64u(credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle,
      },
    };
  }
}

// ---------- cliente HTTP con jar de cookies manual ----------
class Client {
  constructor(ip) {
    this.jar = {};
    this.ip = ip ?? `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
  }
  async call(method, path, body, extraHeaders = {}) {
    const headers = { 'x-forwarded-for': this.ip, ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) delete this.jar[name];
      else this.jar[name] = value;
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
}

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`);
};
const q = async (sql, params) => (await owner.query(sql, params)).rows;

(async () => {
  const suffix = crypto.randomBytes(3).toString('hex');
  const PASSWORD = 'Passw0rd!test';
  const hashPw = await bcrypt.hash(PASSWORD, 10);
  const org = (await q(`INSERT INTO organizations(name, slug) VALUES ('E2E auth', $1) RETURNING id`, [`e2e-auth-${suffix}`]))[0].id;
  const mkUser = async (label, role, extra = '') => {
    const id = (await q(
      `INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [`${label}-${suffix}@e2e.test`, label, hashPw],
    ))[0].id;
    await q('INSERT INTO org_memberships(organization_id, user_id, role) VALUES ($1, $2, $3)', [org, id, role]);
    if (extra) await q(`UPDATE users SET ${extra} WHERE id = $1`, [id]);
    return { id, email: `${label}-${suffix}@e2e.test` };
  };
  const admin = await mkUser('admin', 'admin');
  const bob = await mkUser('bob', 'user');
  const login = (c, email, password = PASSWORD) => c.call('POST', '/auth/login', { email, password });

  // ===== login con contraseña =====
  const a = new Client();
  check('contraseña incorrecta → 401', (await login(a, admin.email, 'mala-clave')).status === 401);
  const ok = await login(a, admin.email);
  check('contraseña correcta → sesión', ok.status === 201 && a.jar.session, JSON.stringify(ok));
  const me0 = (await a.call('GET', '/auth/me')).json;
  check('/auth/me: 0 passkeys, correo sin verificar', me0.passkeyCount === 0 && me0.emailVerified === false && me0.mustChangePassword === false);
  check('token con amr=pwd y sv', jwt.decode(a.jar.session).amr === 'pwd' && jwt.decode(a.jar.session).sv === 0);

  // ===== registro de passkey =====
  const auth = new SoftAuthenticator();
  const regOpts = await a.call('POST', '/auth/passkeys/register/options');
  check('opciones de registro: passkey descubrible + UV obligatorio',
    regOpts.status === 201 && regOpts.json.options.authenticatorSelection.residentKey === 'required' &&
      regOpts.json.options.authenticatorSelection.userVerification === 'required' && a.jar.pk_chal, JSON.stringify(regOpts.json).slice(0, 200));
  check('rp.id coincide con el dominio configurado', regOpts.json.options.rp.id === RP_ID);

  const wrongOrigin = auth.register(regOpts.json.options, { origin: 'https://evil.example' });
  check('registro con origen falso → 400', (await a.call('POST', '/auth/passkeys/register/verify', { response: wrongOrigin })).status === 400);
  // el challenge se consumió en el intento: hay que pedir opciones nuevas
  const regOpts2 = await a.call('POST', '/auth/passkeys/register/options');
  const noUv = auth.register(regOpts2.json.options, { flags: 0x41 /* UP|AT sin UV */ });
  check('registro sin verificación de usuario (UV) → 400', (await a.call('POST', '/auth/passkeys/register/verify', { response: noUv })).status === 400);

  const regOpts3 = await a.call('POST', '/auth/passkeys/register/options');
  const attestation = auth.register(regOpts3.json.options);
  const reg = await a.call('POST', '/auth/passkeys/register/verify', { response: attestation, name: '  Mi laptop  ' });
  check('registro válido → passkey creada', reg.status === 201 && reg.json.passkey.name === 'Mi laptop', JSON.stringify(reg.json));
  check('replay del mismo challenge → 400', (await a.call('POST', '/auth/passkeys/register/verify', { response: attestation })).status === 400);
  const stored = (await q('SELECT * FROM webauthn_credentials WHERE user_id = $1', [admin.id]))[0];
  check('se guarda solo clave pública y metadatos', stored && Buffer.isBuffer(stored.public_key) && stored.sign_count === '0' && stored.transports[0] === 'internal');
  const regOpts4 = await a.call('POST', '/auth/passkeys/register/options');
  check('excludeCredentials evita duplicar la passkey', regOpts4.json.options.excludeCredentials.length === 1);
  const dup = await a.call('POST', '/auth/passkeys/register/verify', { response: auth.register(regOpts4.json.options) });
  check('registrar la misma credencial otra vez → 400', dup.status === 400);

  // ===== login con passkey =====
  const p = new Client();
  const lo = await p.call('POST', '/auth/passkey/options');
  check('login: opciones sin allowCredentials (no revela usuarios)', lo.status === 201 && (lo.json.options.allowCredentials ?? []).length === 0 && p.jar.pk_chal);
  const goodAssertion = auth.assert(lo.json.options, { counter: 1 });
  const usedChallengeCookie = p.jar.pk_chal;
  const lv = await p.call('POST', '/auth/passkey/verify', { response: goodAssertion });
  check('login con passkey → sesión con amr=webauthn', lv.status === 201 && jwt.decode(p.jar.session)?.amr === 'webauthn', JSON.stringify(lv));
  check('/auth/me con sesión de passkey', (await p.call('GET', '/auth/me')).json.userId === admin.id);
  check('contador y último uso actualizados', (await q('SELECT sign_count, last_used_at FROM webauthn_credentials WHERE user_id = $1', [admin.id]))[0].sign_count === '1');

  const replay = new Client();
  replay.jar.pk_chal = usedChallengeCookie;
  check('replay exacto de la aserción (challenge ya consumido) → 401', (await replay.call('POST', '/auth/passkey/verify', { response: goodAssertion })).status === 401);

  const tryAssertion = async (opts, label, expectStatus = 401) => {
    const c = new Client();
    const o = await c.call('POST', '/auth/passkey/options');
    const r = await c.call('POST', '/auth/passkey/verify', { response: auth.assert(o.json.options, opts) });
    check(label, r.status === expectStatus, `status ${r.status} ${JSON.stringify(r.json)}`);
  };
  await tryAssertion({ counter: 1 }, 'contador que no avanza (posible clon) → 401');
  await tryAssertion({ counter: 5, origin: 'https://evil.example' }, 'aserción desde otro origen (phishing) → 401');
  await tryAssertion({ counter: 5, flags: 0x01 }, 'aserción sin verificación de usuario → 401');
  await tryAssertion({ counter: 5, tamper: true }, 'firma alterada → 401');
  await tryAssertion({ counter: 5, credentialId: crypto.randomBytes(32) }, 'credencial desconocida → 401');
  await tryAssertion({ counter: 6 }, 'aserción válida con contador mayor → 201', 201);

  // ===== sesiones, reautenticación y revocación =====
  const old = new Client();
  old.jar.session = jwt.sign({ sub: admin.id, orgId: org, amr: 'pwd', sv: 0, iat: Math.floor(Date.now() / 1000) - 600 }, SECRET, { expiresIn: '4h' });
  const stale = await old.call('POST', '/auth/passkeys/register/options');
  check('sesión con más de 5 min → REAUTH_REQUIRED', stale.status === 403 && stale.json.code === 'REAUTH_REQUIRED', JSON.stringify(stale));
  check('reautenticar con contraseña incorrecta → 401', (await old.call('POST', '/auth/reauth', { password: 'x' + PASSWORD })).status === 401);
  check('reautenticar con contraseña → ok', (await old.call('POST', '/auth/reauth', { password: PASSWORD })).status === 201);
  check('tras reautenticar se puede agregar passkey', (await old.call('POST', '/auth/passkeys/register/options')).status === 201);

  const old2 = new Client();
  old2.jar.session = jwt.sign({ sub: admin.id, orgId: org, amr: 'pwd', sv: 0, iat: Math.floor(Date.now() / 1000) - 600 }, SECRET, { expiresIn: '4h' });
  const ro = await old2.call('POST', '/auth/passkey/reauth/options');
  const rv = await old2.call('POST', '/auth/passkey/reauth/verify', { response: auth.assert(ro.json.options, { counter: 7 }) });
  check('reautenticar con passkey → ok', rv.status === 201, JSON.stringify(rv));
  check('tras reautenticar con passkey se puede agregar otra', (await old2.call('POST', '/auth/passkeys/register/options')).status === 201);

  const list = (await a.call('GET', '/auth/passkeys')).json;
  const del = await a.call('DELETE', `/auth/passkeys/${list[0].id}`);
  check('borrar passkey → ok y credentialId para avisar al proveedor', del.status === 200 && !!del.json.credentialId, JSON.stringify(del));
  check('borrar passkey cierra las demás sesiones (sv)', (await p.call('GET', '/auth/me')).status === 401);
  check('la sesión que borró sigue viva con token nuevo', (await a.call('GET', '/auth/me')).status === 200);
  check('la passkey borrada ya no inicia sesión', await (async () => {
    const c = new Client();
    const o = await c.call('POST', '/auth/passkey/options');
    return (await c.call('POST', '/auth/passkey/verify', { response: auth.assert(o.json.options, { counter: 99 }) })).status === 401;
  })());

  // admin revoca las passkeys de otra persona
  const bobClient = new Client();
  await login(bobClient, bob.email);
  const bobAuth = new SoftAuthenticator();
  const bo = await bobClient.call('POST', '/auth/passkeys/register/options');
  await bobClient.call('POST', '/auth/passkeys/register/verify', { response: bobAuth.register(bo.json.options) });
  const usersList = (await a.call('GET', '/users')).json;
  const bobRow = usersList.find((u) => u.user_id === bob.id);
  check('lista de usuarios muestra passkeys y verificación', bobRow.passkey_count === 1 && bobRow.email_verified_at === null);
  check('un usuario normal no puede revocar passkeys ajenas', (await bobClient.call('DELETE', `/users/${admin.id}/passkeys`)).status === 403);
  check('admin revoca passkeys de otro usuario', (await a.call('DELETE', `/users/${bob.id}/passkeys`)).json.revoked === 1);
  check('la sesión del usuario revocado se cierra', (await bobClient.call('GET', '/auth/me')).status === 401);

  // ===== bloqueo por intentos y límite de peticiones =====
  const victim = await mkUser('victim', 'user');
  for (let i = 0; i < 10; i++) await login(new Client(), victim.email, 'mala-' + i);
  check('10 fallos seguidos bloquean la cuenta', (await q('SELECT locked_until > now() AS locked FROM users WHERE id = $1', [victim.id]))[0].locked === true);
  const lockedTry = await login(new Client(), victim.email);
  check('cuenta bloqueada rechaza hasta la contraseña correcta (mensaje genérico)', lockedTry.status === 401 && /incorrectos/.test(lockedTry.json.message));
  await q('UPDATE users SET locked_until = now() - interval \'1 minute\' WHERE id = $1', [victim.id]);
  check('vencido el bloqueo vuelve a entrar y se reinicia el contador', (await login(new Client(), victim.email)).status === 201);
  const same = new Client('203.0.113.77');
  let last;
  for (let i = 0; i < 11; i++) last = await login(same, 'nadie@e2e.test', 'x');
  check('más de 10 logins por minuto desde una IP → 429', last.status === 429, `status ${last.status}`);

  // ===== cambio de contraseña forzado =====
  const temp = await mkUser('temp', 'admin', 'must_change_password = true');
  const t = new Client();
  const tl = await login(t, temp.email);
  check('login con contraseña temporal marca mustChangePassword', tl.json.mustChangePassword === true && jwt.decode(t.jar.session).mcp === true);
  const blocked = await t.call('GET', '/dashboard/repositories');
  check('con cambio pendiente la API bloquea el resto (403 PASSWORD_CHANGE_REQUIRED)', blocked.status === 403 && blocked.json.code === 'PASSWORD_CHANGE_REQUIRED');
  check('…pero /auth/me sigue disponible', (await t.call('GET', '/auth/me')).json.mustChangePassword === true);
  check('contraseña nueva débil → 400', (await t.call('POST', '/auth/change-password', { currentPassword: PASSWORD, newPassword: 'corta' })).status === 400);
  check('cambiar la contraseña levanta el bloqueo', (await t.call('POST', '/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Nueva-clave-2026' })).status === 201);
  check('ya puede usar la API', (await t.call('GET', '/dashboard/repositories')).status === 200);

  // ===== verificación de correo y recuperación =====
  const v1 = await createAccountToken(bob.id, 'verify_email', 60);
  const pub = new Client();
  check('enlace de verificación → ok', (await pub.call('POST', '/auth/verify-email', { token: v1 })).status === 201);
  check('el enlace no se puede reusar', (await pub.call('POST', '/auth/verify-email', { token: v1 })).status === 400);
  check('token inventado → 400', (await pub.call('POST', '/auth/verify-email', { token: 'abc' })).status === 400);
  const expired = await createAccountToken(victim.id, 'verify_email', 60);
  await q(`UPDATE account_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND purpose = 'verify_email'`, [victim.id]);
  check('enlace vencido → 400', (await pub.call('POST', '/auth/verify-email', { token: expired })).status === 400);
  check('correo quedó verificado', (await q('SELECT email_verified_at IS NOT NULL AS v FROM users WHERE id = $1', [bob.id]))[0].v === true);

  const tokensFor = async (id) => (await q(`SELECT count(*)::int AS n FROM account_tokens WHERE user_id = $1 AND purpose = 'reset_password'`, [id]))[0].n;
  const sameReply = [
    await pub.call('POST', '/auth/recover/request', { email: `nadie-${suffix}@e2e.test` }),
    await pub.call('POST', '/auth/recover/request', { email: bob.email }),
  ];
  check('recuperación responde igual exista o no el correo', sameReply.every((r) => r.status === 201 && r.json.ok === true));
  check('usuario verificado recibe enlace de recuperación', (await tokensFor(bob.id)) === 1);
  await q('UPDATE users SET email_verified_at = now() WHERE id = $1', [admin.id]);
  await pub.call('POST', '/auth/recover/request', { email: admin.email });
  check('un admin NO puede recuperarse solo por correo', (await tokensFor(admin.id)) === 0);
  await pub.call('POST', '/auth/recover/request', { email: victim.email });
  check('un correo sin verificar NO recibe enlace', (await tokensFor(victim.id)) === 0);

  const bobOld = new Client();
  await login(bobOld, bob.email);
  const reset = await createAccountToken(bob.id, 'reset_password', 15);
  check('restablecer con contraseña débil → 400', (await pub.call('POST', '/auth/recover/complete', { token: reset, newPassword: '123' })).status === 400);
  check('restablecer contraseña con enlace válido', (await pub.call('POST', '/auth/recover/complete', { token: reset, newPassword: 'Otra-clave-2026' })).status === 201);
  check('el enlace de recuperación es de un solo uso', (await pub.call('POST', '/auth/recover/complete', { token: reset, newPassword: 'Otra-clave-2027' })).status === 400);
  check('restablecer cierra las sesiones abiertas', (await bobOld.call('GET', '/auth/me')).status === 401);
  check('la contraseña vieja ya no sirve y la nueva sí', (await login(new Client(), bob.email)).status === 401 && (await login(new Client(), bob.email, 'Otra-clave-2026')).status === 201);

  // ===== usuarios creados por un admin y verificación de origen =====
  const created = await a.call('POST', '/users', { email: `nuevo-${suffix}@e2e.test`, name: 'Nuevo', role: 'user', password: 'Temporal-2026' });
  check('admin crea usuario: marcado para cambiar contraseña y correo sin verificar',
    created.status === 201 && created.json.verification_email_sent === false &&
      (await q(`SELECT must_change_password, email_verified_at FROM users WHERE email = $1`, [`nuevo-${suffix}@e2e.test`]))[0].must_change_password === true);
  const sv0 = (await q('SELECT session_version FROM users WHERE id = $1', [bob.id]))[0].session_version;
  await a.call('PATCH', `/users/${bob.id}`, { password: 'Fijada-por-admin-1' });
  const afterAdmin = (await q('SELECT session_version, must_change_password FROM users WHERE id = $1', [bob.id]))[0];
  check('admin fija contraseña ajena: cierra sesiones y exige cambiarla', afterAdmin.session_version === sv0 + 1 && afterAdmin.must_change_password === true);

  check('POST con Origin ajeno → 403 (CSRF)', (await new Client().call('POST', '/auth/login', { email: admin.email, password: PASSWORD }, { origin: 'https://evil.example' })).status === 403);
  check('POST con el Origin correcto pasa', (await new Client().call('POST', '/auth/login', { email: admin.email, password: PASSWORD }, { origin: ORIGIN })).status === 201);

  const events = (await q(`SELECT DISTINCT event FROM security_events WHERE user_id = ANY($1)`, [[admin.id, bob.id, victim.id]])).map((r) => r.event);
  const wanted = ['passkey_added', 'login_passkey', 'passkey_removed', 'passkeys_revoked_by_admin', 'account_locked', 'login_failed', 'email_verified', 'password_reset'];
  check('eventos de seguridad registrados', wanted.every((e) => events.includes(e)), `faltan: ${wanted.filter((e) => !events.includes(e)).join(', ')}`);

  await q('DELETE FROM users WHERE email LIKE $1', [`%-${suffix}@e2e.test`]);
  await q('DELETE FROM organizations WHERE id = $1', [org]);
  await owner.end();
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('ERROR', e);
  process.exit(1);
});
