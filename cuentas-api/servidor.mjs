// MorvehTV Cuentas — servidor (API) del panel de cuentas de Emby.
// Es lo único que queda del servidor de MorvehTV: no sirve ninguna web, solo /api/panel/… para el
// gestor (saitamaeditor.github.io/morvehtv-gestor) y /api/salud. Sin dependencias: solo Node.
// Los administradores se crean desde la VPS con admin.mjs (habla con este servidor por un enchufe
// Unix local, así nadie puede hacerlo desde internet).
// Los administradores (y solo ellos) pueden subir a e2 desde el gestor: ver e2.js.
//
// Datos: un archivo JSON (DATOS, por defecto /datos/datos.json) con los ajustes que usan
// emby.js y revendedores.js («emby», «embyRevendedores», «embyMovimientos»), más los
// administradores del panel («admins», contraseñas con scrypt), sus sesiones (solo la huella del
// token) y el registro de acciones. Cada día guarda una copia y conserva las 7 últimas.
//
// Si existe /datos/importar.json (el archivo de cuentas antiguo de MorvehTV), copia SOLO lo de Emby,
// revendedores y Telegram que aún no tenga, y borra ese archivo.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import * as emby from './emby.js';
import * as revendedores from './revendedores.js';
import * as telegram from './telegram.js';
import * as e2 from './e2.js';
import * as fichas from './fichas.js';

const PUERTO = Number(process.env.PUERTO ?? 10100);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATOS = process.env.DATOS ?? '/datos/datos.json';
const PRODUCCION = process.env.NODE_ENV === 'production';
const ORIGENES = String(process.env.PANEL_ORIGENES ?? 'https://saitamaeditor.github.io').split(',').map((o) => o.trim()).filter(Boolean);
// Dirección pública del panel (para el CORS del bucket de e2: el navegador sube allí directamente)
const PANEL_PUBLICO = String(process.env.PANEL_PUBLICO ?? 'https://panel.morvehtv.com').trim();
const DIAS_TOKEN = 30;
const IMPORTABLES = ['emby', 'embyRevendedores', 'embyMovimientos', 'telegram'];

const error = (status, message) => Object.assign(new Error(message), { status });

// ---------- Almacén (un JSON en disco, escrito de forma atómica y de uno en uno) ----------
let datos = {};
let cola = Promise.resolve();
const copia = (v) => (v == null ? v : structuredClone(v));

async function cargar() {
  await fs.mkdir(path.dirname(DATOS), { recursive: true });
  try {
    datos = JSON.parse(await fs.readFile(DATOS, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`No se puede leer ${DATOS}: ${e.message}`);
  }
  // Importar del archivo de cuentas antiguo (si lo han dejado) lo que aún no esté: Emby,
  // revendedores y el grupo de Telegram con sus temas. Nada más, y luego se borra.
  const importar = path.join(path.dirname(DATOS), 'importar.json');
  try {
    const viejo = JSON.parse(await fs.readFile(importar, 'utf8'));
    const traidos = IMPORTABLES.filter((k) => viejo[k] != null && datos[k] == null);
    for (const k of traidos) datos[k] = viejo[k];
    console.log(`Importado de la copia antigua: ${traidos.join(', ') || 'nada nuevo'}`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`No se pudo importar ${importar}: ${e.message}`);
  }
  await escribir();
  await fs.rm(importar, { force: true }); // tenía datos de la web antigua: no se guarda
}

async function escribir() {
  const tmp = `${DATOS}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(datos), { mode: 0o600 });
  await fs.rename(tmp, DATOS);
}

const almacen = {
  leerAjuste: async (clave) => copia(datos[clave] ?? null),
  guardarAjuste: (clave, valor) => {
    const r = cola.then(() => { datos[clave] = copia(valor); return escribir(); });
    cola = r.catch(() => {});
    return r;
  },
};

// Copia diaria (se quedan las 7 últimas)
async function copiaDiaria() {
  try {
    const dir = path.join(path.dirname(DATOS), 'copias');
    await fs.mkdir(dir, { recursive: true });
    const hoy = new Date().toISOString().slice(0, 10);
    await fs.writeFile(path.join(dir, `datos-${hoy}.json`), JSON.stringify(datos), { mode: 0o600 });
    const viejas = (await fs.readdir(dir)).filter((f) => /^datos-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -7);
    for (const f of viejas) await fs.rm(path.join(dir, f), { force: true });
  } catch (e) { console.error(`Copia diaria: ${e.message}`); }
}

// ---------- Administradores del panel ----------
function cifrar(clave) { const sal = randomBytes(16).toString('hex'); return `${sal}:${scryptSync(String(clave), sal, 32).toString('hex')}`; }
function claveOk(clave, guardada) {
  const [sal, hx] = String(guardada ?? '').split(':');
  if (!sal || !hx) { scryptSync('x', 'y', 32); return false; }
  const a = scryptSync(String(clave ?? ''), sal, 32); const b = Buffer.from(hx, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
const huella = (t) => createHash('sha256').update(t).digest('hex');
const usuarioValido = (u) => {
  const s = String(u ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(s)) throw error(400, 'El usuario debe tener de 3 a 20 caracteres: letras, números, punto, guion o guion bajo');
  return s;
};

// Los usa admin.mjs (desde la VPS, por el enchufe local de control) para gestionar administradores
async function ponerAdmin(usuario, clave) {
  const u = usuarioValido(usuario);
  if (String(clave ?? '').length < 10) throw error(400, 'La contraseña debe tener al menos 10 caracteres');
  const admins = (await almacen.leerAjuste('admins')) ?? {};
  const nuevo = !admins[u];
  admins[u] = { clave: cifrar(clave), creado: admins[u]?.creado ?? new Date().toISOString() };
  await almacen.guardarAjuste('admins', admins);
  // Al cambiar la contraseña se cierran sus sesiones
  const ses = (await almacen.leerAjuste('sesiones')) ?? {};
  for (const [k, s] of Object.entries(ses)) if (s.usuario === u) delete ses[k];
  await almacen.guardarAjuste('sesiones', ses);
  return { usuario: u, nuevo };
}
async function quitarAdmin(usuario) {
  const u = usuarioValido(usuario);
  const admins = (await almacen.leerAjuste('admins')) ?? {};
  if (!admins[u]) throw error(404, 'No existe ese administrador');
  delete admins[u];
  await almacen.guardarAjuste('admins', admins);
  const ses = (await almacen.leerAjuste('sesiones')) ?? {};
  for (const [k, s] of Object.entries(ses)) if (s.usuario === u) delete ses[k];
  await almacen.guardarAjuste('sesiones', ses);
}
const listaAdmins = async () => Object.keys((await almacen.leerAjuste('admins')) ?? {});

const fallos = new Map(); // por usuario y por IP: 6 fallos → 15 minutos fuera
function frenar(claves) {
  for (const k of claves) { const f = fallos.get(k); if (f && f.hasta > Date.now() && f.n >= 6) throw error(429, 'Demasiados intentos: espera 15 minutos'); }
}
function fallo(claves) {
  for (const k of claves) {
    const f = fallos.get(k);
    fallos.set(k, { n: (f && f.hasta > Date.now() ? f.n : 0) + 1, hasta: Date.now() + 15 * 60000 });
  }
  if (fallos.size > 10000) fallos.clear();
}

async function entrarAdmin(d, ip) {
  const usuario = String(d.usuario ?? '').trim().toLowerCase();
  const claves = [`u:${usuario}`, `ip:${ip}`];
  frenar(claves);
  const admins = (await almacen.leerAjuste('admins')) ?? {};
  const a = admins[usuario];
  if (!claveOk(d.clave, a?.clave)) { fallo(claves); throw error(401, 'Usuario o contraseña incorrectos'); }
  const token = `ad_${randomBytes(32).toString('base64url')}`;
  const ses = (await almacen.leerAjuste('sesiones')) ?? {};
  const ahora = Date.now();
  for (const [k, s] of Object.entries(ses)) if (s.caduca < ahora) delete ses[k];
  ses[huella(token)] = { usuario, caduca: ahora + DIAS_TOKEN * 86400000 };
  await almacen.guardarAjuste('sesiones', ses);
  await registrar(usuario, 'entra en el panel');
  return { token, usuario, nombre: usuario, rol: 'admin', e2: e2.configurado() };
}
async function adminDeToken(token) {
  const ses = (await almacen.leerAjuste('sesiones')) ?? {};
  const s = ses[huella(token)];
  if (!s || s.caduca < Date.now()) return null;
  const admins = (await almacen.leerAjuste('admins')) ?? {};
  return admins[s.usuario] ? s.usuario : null;
}
async function salirAdmin(token) {
  const ses = (await almacen.leerAjuste('sesiones')) ?? {};
  if (ses[huella(token)]) { delete ses[huella(token)]; await almacen.guardarAjuste('sesiones', ses); }
}

async function registrar(usuario, accion) {
  try {
    const lista = (await almacen.leerAjuste('registro')) ?? [];
    lista.unshift({ fecha: new Date().toISOString(), usuario, accion, claves: [], total: 0 });
    await almacen.guardarAjuste('registro', lista.slice(0, 500));
  } catch (e) { console.error(`No se pudo apuntar en el registro (${e.message})`); }
}

// ---------- HTTP ----------
function json(res, status, cuerpo) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(cuerpo));
}
function cors(req, res) {
  const origen = req.headers.origin;
  const vale = origen && (ORIGENES.includes(origen) || (!PRODUCCION && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen)));
  if (vale) {
    res.setHeader('access-control-allow-origin', origen);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-max-age', '3600');
  }
}
async function cuerpo(req, max = 64 * 1024) {
  if (req.method !== 'POST') return {};
  let largo = 0; const trozos = [];
  for await (const t of req) { largo += t.length; if (largo > max) throw error(413, 'Demasiado grande'); trozos.push(t); }
  if (!largo) return {};
  try { const d = JSON.parse(Buffer.concat(trozos).toString('utf8')); return d && typeof d === 'object' ? d : {}; } catch { throw error(400, 'JSON no válido'); }
}
// Detrás de Cloudflare → Caddy: la IP real llega en cf-connecting-ip (el cortafuegos solo deja
// entrar a Cloudflare). Solo se usa para frenar intentos de contraseña; no se guarda.
const ipDe = (req) => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '');

async function atender(req, res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  const url = new URL(req.url, 'http://x');
  const ruta = url.pathname.replace(/\/+$/, '') || '/';
  if (ruta === '/api/salud') return json(res, 200, { ok: true, emby: emby.configurado(), telegram: telegram.estado, e2: e2.estado });
  if (!ruta.startsWith('/api/panel/')) return json(res, 404, { error: 'No existe' });
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Método no permitido' });

  // Cerrar una subida grande lleva la lista de trozos (hasta 9000): más sitio solo para esa ruta
  const d = await cuerpo(req, ruta === '/api/panel/e2/cerrar' ? 1024 * 1024 : 64 * 1024);
  const ip = ipDe(req);
  if (ruta === '/api/panel/entrar') return json(res, 200, await entrarAdmin(d, ip));
  if (ruta === '/api/panel/emby/entrar') return json(res, 200, await revendedores.entrar(d));

  const tk = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!tk) throw error(401, 'Tienes que entrar');

  // Revendedores: solo /api/panel/emby…
  if (tk.startsWith('rv_')) {
    const a = await revendedores.actorDeToken(tk);
    if (!a) throw error(401, 'La sesión ha caducado: vuelve a entrar');
    if (ruta === '/api/panel/yo') return json(res, 200, revendedores.yo(a));
    if (ruta === '/api/panel/emby/salir' || ruta === '/api/panel/salir') { await revendedores.salir(tk); return json(res, 200, { ok: true }); }
    if (!ruta.startsWith('/api/panel/emby')) throw error(403, 'No tienes acceso a eso');
    const r = await revendedores.atender(ruta, req.method, d, a);
    if (r.registro) await registrar(`${a.usuario} (revendedor)`, r.registro);
    return json(res, 200, r.datos);
  }

  // Administradores
  const usuario = tk.startsWith('ad_') ? await adminDeToken(tk) : null;
  if (!usuario) throw error(401, 'La sesión ha caducado: vuelve a entrar');
  if (ruta === '/api/panel/yo') return json(res, 200, { usuario, nombre: usuario, rol: 'admin', e2: e2.configurado() });
  if (ruta === '/api/panel/salir') { await salirAdmin(tk); return json(res, 200, { ok: true }); }
  if (ruta === '/api/panel/registro') return json(res, 200, (await almacen.leerAjuste('registro')) ?? []);
  // Subir a e2: SOLO administradores (los revendedores ya se han quedado fuera arriba)
  if (ruta === '/api/panel/e2/carpetas') return json(res, 200, { carpetas: await e2.carpetas(url.searchParams.get('en') ?? '') });
  if (ruta === '/api/panel/e2/ficha') return json(res, 200, await fichas.buscar(url.searchParams.get('q'), url.searchParams.get('tipo')));
  if (ruta.startsWith('/api/panel/e2/') && req.method === 'POST') {
    if (ruta === '/api/panel/e2/abrir') return json(res, 200, await e2.abrir(d, usuario));
    if (ruta === '/api/panel/e2/trozos') return json(res, 200, await e2.trozos(d, usuario));
    if (ruta === '/api/panel/e2/cancelar') return json(res, 200, await e2.cancelar(d, usuario));
    if (ruta === '/api/panel/e2/cerrar') {
      const r = await e2.cerrar(d, usuario);
      await registrar(usuario, `sube a e2 «${r.key}» (${(r.tamano / 1073741824).toFixed(2)} GB)`);
      return json(res, 200, r);
    }
  }
  if (ruta.startsWith('/api/panel/emby')) {
    const r = await revendedores.atender(ruta, req.method, d, { admin: true, usuario });
    if (r.registro) await registrar(usuario, r.registro);
    return json(res, 200, r.datos);
  }
  throw error(404, 'No existe');
}

// ---------- Control local (enchufe Unix en la carpeta de datos: solo root y el propio servidor) ----------
const ENCHUFE = process.env.CONTROL ?? path.join(path.dirname(DATOS), 'control.sock');
async function control(req, res) {
  try {
    const d = await cuerpo(req);
    if (d.accion === 'poner') { const r = await ponerAdmin(d.usuario, d.clave); await registrar(r.usuario, r.nuevo ? 'cuenta de administrador creada desde la VPS' : 'contraseña cambiada desde la VPS'); return json(res, 200, r); }
    if (d.accion === 'quitar') { await quitarAdmin(d.usuario); await registrar('sistema', `quita el administrador ${String(d.usuario).toLowerCase()}`); return json(res, 200, { ok: true }); }
    if (d.accion === 'lista') return json(res, 200, { admins: await listaAdmins() });
    if (d.accion === 'telegram-todo') { await telegram.avisarTodo(); await registrar('sistema', 'pide a Telegram avisar de todo el contenido'); return json(res, 200, { ok: true }); }
    throw error(400, 'Acción no válida');
  } catch (e) { json(res, Number.isInteger(e.status) ? e.status : 500, { error: e.message }); }
}

async function iniciar() {
  await cargar();
  emby.iniciar({ perfiles: almacen, nube: true });
  revendedores.iniciar({ perfiles: almacen });
  telegram.iniciar({ perfiles: almacen });
  e2.iniciar({ perfiles: almacen, origenes: [PANEL_PUBLICO, ...ORIGENES], escanear: emby.configurado() ? emby.escanear : null, avisarEmby: emby.configurado() ? emby.avisarCambios : null, alAvisar: () => telegram.pronto(10000) });
}

async function escuchar() {
  if (!ENCHUFE.startsWith('\\')) await fs.rm(ENCHUFE, { force: true });
  http.createServer(control).listen(ENCHUFE, () => fs.chmod(ENCHUFE, 0o600).catch(() => {}));
  copiaDiaria();
  setInterval(copiaDiaria, 24 * 3600000).unref();
  const servidor = http.createServer((req, res) => {
    atender(req, res).catch((e) => {
      const status = Number.isInteger(e.status) ? e.status : 500;
      if (status >= 500) console.error(`${req.method} ${req.url}: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, status, { error: status >= 500 && !e.status ? 'Error del servidor' : e.message });
      else res.end();
    });
  });
  servidor.requestTimeout = 30000;
  servidor.headersTimeout = 15000;
  servidor.listen(PUERTO, HOST, () => {
    console.log(`MorvehTV Cuentas en http://${HOST}:${PUERTO} — Emby ${emby.configurado() ? 'conectado' : 'SIN CONFIGURAR (falta EMBY_URL / EMBY_API_KEY)'}`);
  });
  const parar = () => { setTimeout(() => process.exit(0), 5000).unref(); servidor.close(() => cola.finally(() => process.exit(0))); servidor.closeIdleConnections(); };
  process.on('SIGTERM', parar);
  process.on('SIGINT', parar);
}

await iniciar();
await escuchar();
