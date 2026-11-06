// Cuentas de usuario (registro con usuario y contraseña) con su «Seguir viendo» y sus favoritos.
// Todo se guarda en un único archivo oculto del bucket (_morvehtv/usuarios.json): así lo
// comparten el servidor de casa y el de Render y no se pierde cuando Render se reinicia. Es lo
// único que MorvehTV escribe en e2; los vídeos nunca se tocan.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as pagos from './pagos.js';
import { comprobarHumano } from './defensa.js';

const ARCHIVO = '_morvehtv/usuarios.json';

let s3;
let bucket;
let NUBE = false;
let doc = null; // { secreto, cuentas: [...], perfiles y comun (de antes, sin usar) }
let leidoEn = 0;
let cola = Promise.resolve(); // las escrituras van de una en una
const posPendientes = new Map(); // cuenta → Map(key → posición): se guardan juntas cada 20 s

// ¿Se puede escribir el archivo de cuentas? (la clave de e2 tiene que permitirlo). Se comprueba
// al arrancar reescribiendo el archivo tal cual y se ve en /api/salud
export let escritura = 'comprobando';

export function iniciar(cliente, nombreBucket, nube) {
  s3 = cliente; bucket = nombreBucket; NUBE = nube;
  setInterval(() => volcarPosiciones().catch((e) => console.error(`No se pudo guardar el progreso: ${e.message}`)), 20000);
  cambiar(() => {}).then(() => { escritura = 'ok'; }, (e) => {
    escritura = `error: ${e.name || e.message}`;
    console.error(`No se puede escribir ${ARCHIVO} en e2: ${e.message}`);
  });
}

async function descargar() {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ARCHIVO }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return { secreto: randomBytes(32).toString('hex'), perfiles: [], cuentas: [] };
    throw e;
  }
}

// Lectura con caché de unos segundos (el otro servidor puede haber cambiado algo)
async function leer() {
  if (!doc || Date.now() - leidoEn > 10000) {
    doc = await descargar();
    leidoEn = Date.now();
  }
  return doc;
}

// Cambio seguro: se vuelve a leer el archivo justo antes, se aplica el cambio y se sube
function cambiar(fn) {
  const tarea = cola.then(async () => {
    const d = await descargar();
    const r = fn(d);
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: ARCHIVO, Body: JSON.stringify(d), ContentType: 'application/json',
    }));
    doc = d; leidoEn = Date.now();
    return r;
  });
  cola = tarea.catch(() => {});
  return tarea;
}

const error = (status, message) => Object.assign(new Error(message), { status });

// Otros datos de MorvehTV que viven en el mismo archivo (los temas de Telegram…)
export const leerAjuste = async (clave) => (await descargar())[clave] ?? null;
export const guardarAjuste = (clave, valor) => cambiar((d) => { d[clave] = valor; });

// ---------- Cuentas ----------
// La contraseña se guarda con scrypt, nunca en claro. La sesión es una cookie firmada con el
// secreto del archivo que lleva la «generación» de la cuenta: cambiar la contraseña o «cerrar
// sesión en todos los dispositivos» la sube y deja sin valor las cookies anteriores.
// (La lista común y los perfiles de antes se quedan en el archivo, sin usar.)
const COOKIE = 'morvehtv_sesion';
const MAX_CUENTAS = 300;
const scryptAsync = promisify(scrypt);
const hashClave = async (clave, sal) => (await scryptAsync(String(clave).slice(0, 200), sal, 64)).toString('hex');
const mismoHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const usuarioValido = (u) => /^[a-z0-9._-]{3,20}$/.test(u);
const normalizar = (u) => String(u ?? '').trim().toLowerCase();
const firma = (secreto, c) => createHmac('sha256', secreto).update(`cuenta:${c.id}:${c.gen || 0}`).digest('hex');
const publica = (c) => ({ id: c.id, usuario: c.usuario, nombre: c.nombre, creado: c.creado });

// Límites de intentos: por conexión y por usuario (contraseñas) y por conexión (registros)
const intentos = new Map(); // clave → [marcas de tiempo]
function frenar(clave, max, minutos) {
  const lista = (intentos.get(clave) || []).filter((t) => t > Date.now() - minutos * 60000);
  intentos.set(clave, lista);
  if (lista.length >= max) throw error(429, `Demasiados intentos. Prueba dentro de ${minutos} minutos.`);
  return () => lista.push(Date.now());
}
setInterval(() => {
  for (const [k, l] of intentos) if (!l.some((t) => t > Date.now() - 3600000)) intentos.delete(k);
}, 600000).unref();

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
}
const cookieSesion = (valor, maxAge) =>
  `${COOKIE}=${valor}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${NUBE ? '; Secure' : ''}`;
const ponerSesion = (res, d, c) => res.setHeader('set-cookie', cookieSesion(`${c.id}.${firma(d.secreto, c)}`, 31536000));

// Los administradores (pueden subir contenido) se apuntan por usuario en el campo «admins» del
// archivo; un servidor también puede añadir los suyos con VISOR_ADMINS («usuario1,usuario2»)
const ADMINS_ENTORNO = String(process.env.VISOR_ADMINS ?? '').split(',').map(normalizar).filter(Boolean);
export const esAdmin = async (c) => Boolean(c && [...((await leer()).admins || []), ...ADMINS_ENTORNO].includes(c.usuario));

// ---------- Plan de cada cuenta ----------
// «premium» si tiene la suscripción al día (o es administrador); si no, «basico» (con anuncios)
// Premium de por vida: SOLO los administradores. Los demás, solo durante el tiempo que hayan pagado en USDC
// esté pagada (no hay otra forma de tener Premium gratis).
export async function planDe(c) {
  if (!c) return { tipo: 'basico' };
  if (await esAdmin(c)) return { tipo: 'premium', admin: true };
  if (pagos.esPremium(c.plan)) return { tipo: 'premium', hasta: c.plan.hasta, cancelado: c.plan.cancelado };
  return { tipo: 'basico' };
}
export const cuentaPorUsuario = async (u) => ((await leer()).cuentas || []).find((x) => x.usuario === normalizar(u)) ?? null;
// Colaboradores del gestor: cuentas que pueden subir contenido en las secciones que les dé un
// administrador (se guardan en «colaboradores» del archivo: [{ usuario, secciones, creado, por }])
// Un administrador crea desde el gestor la cuenta de un colaborador (usuario, nombre y contraseña)
// y le da sus secciones, todo de una vez. La contraseña se guarda cifrada, como cualquier otra.
export async function crearColaborador({ usuario, nombre, clave, secciones, por }) {
  usuario = normalizar(usuario);
  if (!usuarioValido(usuario)) throw error(400, 'El usuario debe tener de 3 a 20 caracteres: letras, números, punto, guion o guion bajo');
  clave = String(clave ?? '');
  claveNueva(clave);
  const sal = randomBytes(16).toString('hex');
  const hash = await hashClave(clave, sal);
  return cambiar((d) => {
    d.cuentas = d.cuentas || [];
    if (d.cuentas.length >= MAX_CUENTAS) throw error(403, 'No se admiten más cuentas por ahora');
    if (d.cuentas.some((x) => x.usuario === usuario)) throw error(409, 'Ese usuario ya existe: si ya tiene cuenta, dale permiso con «Añadir o cambiar secciones»');
    const c = { id: randomBytes(8).toString('hex'), usuario, nombre: String(nombre ?? '').trim().slice(0, 30) || usuario, sal, clave: hash, gen: 0,
      creado: new Date().toISOString(), favoritos: [], posiciones: {}, creadaPor: por };
    d.cuentas.push(c);
    d.colaboradores = (d.colaboradores || []).filter((x) => x.usuario !== usuario);
    d.colaboradores.push({ usuario, secciones, creado: new Date().toISOString(), por });
    return publica(c);
  });
}
// Nueva contraseña para un colaborador (si la olvida). Cierra sus sesiones abiertas.
export async function claveDeColaborador(usuario, clave) {
  usuario = normalizar(usuario);
  clave = String(clave ?? '');
  claveNueva(clave);
  const sal = randomBytes(16).toString('hex');
  const hash = await hashClave(clave, sal);
  return cambiar((d) => {
    if (!(d.colaboradores || []).some((x) => x.usuario === usuario)) throw error(403, 'Solo se puede cambiar la contraseña de los colaboradores');
    const c = (d.cuentas || []).find((x) => x.usuario === usuario);
    if (!c) throw error(404, 'Esa cuenta ya no existe');
    c.sal = sal; c.clave = hash; c.gen = (c.gen || 0) + 1;
    comprobadas.delete(usuario);
  });
}
export const colaboradorDe = async (c) => (c ? ((await leer()).colaboradores || []).find((x) => x.usuario === c.usuario) ?? null : null);
// Una cuenta por su id (o null), leída del archivo
export const cuentaPorId = async (id) => ((await leer()).cuentas || []).find((x) => x.id === id) ?? null;

// Versión de las condiciones (cambia si se modifican) y apunte de cuándo las aceptó cada cuenta
export const VERSION_CONDICIONES = '2026-11-04';
export const anotarAceptacion = (id, que) => cambiar((d) => {
  const c = (d.cuentas || []).find((x) => x.id === id);
  if (!c) return;
  c.acepto = { ...(c.acepto || {}), [que]: { fecha: new Date().toISOString(), version: VERSION_CONDICIONES } };
});

// Cuántas cuentas hay de cada plan (para el gestor)
export async function resumenPlanes() {
  const d = await leer();
  const cuentas = d.cuentas || [];
  const admins = new Set([...(d.admins || []), ...ADMINS_ENTORNO]);
  const deAdmin = cuentas.filter((c) => admins.has(c.usuario)).length;
  const premium = cuentas.filter((c) => !admins.has(c.usuario) && pagos.esPremium(c.plan)).length;
  return { cuentas: cuentas.length, admins: deAdmin, premium, basico: cuentas.length - premium - deAdmin };
}
// Lo apuntan los pagos en USDC (al leerlos en la blockchain) y el gestor: por id de cuenta o por su suscripción.
// Avisa al momento a la web y la app abiertas de esa cuenta (alCambiarPlan, ver server.js).
let avisoPlan = () => {};
export const alCambiarPlan = (fn) => { avisoPlan = fn; };
// opciones.unicaSuscripcion: si esa suscripción (cuenta de Patreon) ya está en otra cuenta, error 409
// opciones.soloSiExiste: si no hay ninguna cuenta con ella, no pasa nada (sin aviso en el registro)
export async function ponerPlan(quien, datos, opciones = {}) {
  const r = await cambiar((d) => {
    const c = (d.cuentas || []).find((x) => (quien.id && x.id === quien.id) || (!quien.id && quien.suscripcion && x.plan?.suscripcion === quien.suscripcion));
    if (!c) { if (!opciones.soloSiExiste) console.error(`Pagos: no hay ninguna cuenta para ${quien.id || quien.suscripcion}`); return null; }
    if (opciones.unicaSuscripcion && datos.suscripcion && (d.cuentas || []).some((x) => x.id !== c.id && x.plan?.suscripcion === datos.suscripcion)) {
      throw error(409, 'Esa cuenta de Patreon ya está conectada a otra cuenta de MorvehTV');
    }
    c.plan = { ...(c.plan || {}), ...datos, cambiado: Date.now() };
    console.log(`Pagos: ${c.usuario} → ${c.plan.estado}${c.plan.cancelado ? ' (cancelada: sigue hasta fin de mes)' : ''}`);
    return { id: c.id, plan: c.plan };
  });
  if (!r) return null;
  try { avisoPlan(r.id, pagos.esPremium(r.plan) ? 'premium' : 'basico'); } catch (e) { /* sin aviso en directo */ }
  return r.plan;
}

// La cuenta de quien hace la petición, o null (la usa también el servidor para dejar pasar)
export async function sesion(req) {
  const [id, f] = String(cookies(req)[COOKIE] ?? '').split('.');
  if (!id || !f) return null;
  const d = await leer();
  const c = (d.cuentas || []).find((x) => x.id === id);
  return c && mismoHash(f, firma(d.secreto, c)) ? c : null;
}

// Usuario y contraseña que llegan de un reproductor externo (tipo Xtream), sin cookie. Cada
// petición los trae, así que lo ya comprobado se recuerda 10 minutos (si cambia la contraseña,
// deja de valer al momento). Devuelve la cuenta o null; con demasiados fallos, error 429.
const comprobadas = new Map(); // usuario → { huella, clave, hasta }
export async function credenciales(usuario, clave, ip) {
  usuario = normalizar(usuario);
  clave = String(clave ?? '');
  const d = await leer();
  const c = (d.cuentas || []).find((x) => x.usuario === usuario);
  const huella = createHash('sha256').update(`${c ? c.sal : ''}:${clave}`).digest('hex');
  const v = comprobadas.get(usuario);
  if (c && v && v.huella === huella && v.clave === c.clave && v.hasta > Date.now()) return c;
  const anotarIp = frenar(`login:${ip}`, 10, 10);
  const anotarUsuario = frenar(`usuario:${usuario}`, 10, 10);
  if (!c || !mismoHash(await hashClave(clave, c ? c.sal : 'sin-cuenta'), c.clave)) {
    anotarIp(); anotarUsuario();
    return null;
  }
  comprobadas.set(usuario, { huella, clave: c.clave, hasta: Date.now() + 10 * 60000 });
  return c;
}

// Token del panel de gestión (es otra web, así que no comparte la cookie): caduca a los 30 días
// y deja de valer, como la cookie, al cambiar la contraseña o cerrar las sesiones (generación)
const firmaPanel = (secreto, base) => createHmac('sha256', secreto).update(`panel:${base}`).digest('hex');
export async function tokenPanel(c) {
  const base = `${c.id}.${c.gen || 0}.${Date.now() + 30 * 864e5}`;
  return `${base}.${firmaPanel((await leer()).secreto, base)}`;
}
export async function cuentaDeToken(token) {
  const [id, gen, hasta, f] = String(token ?? '').split('.');
  if (!f || !(Number(hasta) > Date.now())) return null;
  const d = await leer();
  const c = (d.cuentas || []).find((x) => x.id === id);
  if (!c || String(c.gen || 0) !== gen) return null;
  return mismoHash(f, firmaPanel(d.secreto, `${id}.${gen}.${hasta}`)) ? c : null;
}

async function necesitaCuenta(req) {
  const c = await sesion(req);
  if (!c) throw error(401, 'Inicia sesión');
  return c;
}

// Cambia la cuenta dentro del archivo (releído justo antes) y devuelve lo que diga fn
const cambiarCuenta = (id, fn) => cambiar((d) => {
  const c = (d.cuentas || []).find((x) => x.id === id);
  if (!c) throw error(401, 'Esa cuenta ya no existe');
  return fn(c, d);
});

async function cuerpo(req) {
  let t = '';
  for await (const trozo of req) {
    t += trozo;
    if (t.length > 20000) throw error(413, 'Demasiado grande');
  }
  return t ? JSON.parse(t) : {};
}

function claveNueva(clave) {
  if (clave.length < 8) throw error(400, 'La contraseña debe tener al menos 8 caracteres');
  if (clave.length > 200) throw error(400, 'Contraseña demasiado larga');
}

// ---------- Rutas ----------
export async function atender(ruta, req, res, json, ip) {
  // ¿Hay sesión? (la pantalla de entrada lo mira para saltar directa a la app)
  if (ruta === '/api/sesion') {
    const c = await sesion(req);
    return c ? json(res, 200, publica(c)) : json(res, 401, { error: 'Inicia sesión' });
  }
  if (ruta === '/api/yo') {
    const c = await necesitaCuenta(req);
    const pendientes = posPendientes.get(c.id);
    const posiciones = { ...c.posiciones, ...(pendientes ? Object.fromEntries(pendientes) : {}) };
    return json(res, 200, { ...publica(c), admin: await esAdmin(c), plan: (await planDe(c)).tipo, favoritos: c.favoritos, posiciones });
  }
  if (req.method !== 'POST') throw error(405, 'Método no permitido');
  const datos = await cuerpo(req);

  if (ruta === '/api/registro') {
    const usuario = normalizar(datos.usuario);
    const clave = String(datos.clave ?? '');
    const nombre = String(datos.nombre ?? '').trim().slice(0, 30) || usuario;
    if (!usuarioValido(usuario)) throw error(400, 'El usuario debe tener de 3 a 20 caracteres: letras, números, punto, guion o guion bajo');
    claveNueva(clave);
    if (datos.acepta !== true) throw error(400, 'Tienes que confirmar que tienes al menos 14 años');
    const anotar = frenar(`registro:${ip}`, 5, 60);
    await comprobarHumano(datos, ip, true);
    const sal = randomBytes(16).toString('hex');
    const hash = await hashClave(clave, sal);
    const r = await cambiar((d) => {
      d.cuentas = d.cuentas || [];
      if (d.cuentas.length >= MAX_CUENTAS) throw error(403, 'No se admiten más registros por ahora');
      if (d.cuentas.some((x) => x.usuario === usuario)) throw error(409, 'Ese usuario ya existe');
      const c = { id: randomBytes(8).toString('hex'), usuario, nombre, sal, clave: hash, gen: 0,
        creado: new Date().toISOString(), favoritos: [], posiciones: {},
        acepto: { registro: { fecha: new Date().toISOString(), version: VERSION_CONDICIONES } } };
      d.cuentas.push(c);
      return { c, d };
    });
    anotar();
    console.log(`Cuenta nueva: ${usuario}`);
    ponerSesion(res, r.d, r.c);
    return json(res, 200, publica(r.c));
  }

  if (ruta === '/api/login') {
    const usuario = normalizar(datos.usuario);
    const anotarIp = frenar(`login:${ip}`, 10, 10);
    const anotarUsuario = frenar(`usuario:${usuario}`, 10, 10);
    await comprobarHumano(datos, ip, false);
    const d = await leer();
    const c = (d.cuentas || []).find((x) => x.usuario === usuario);
    // Con un usuario que no existe también se calcula un hash: así no se nota por el tiempo
    const hash = await hashClave(String(datos.clave ?? ''), c ? c.sal : 'sin-cuenta');
    if (!c || !mismoHash(hash, c.clave)) {
      anotarIp(); anotarUsuario();
      throw error(401, 'Usuario o contraseña incorrectos');
    }
    ponerSesion(res, d, c);
    return json(res, 200, publica(c));
  }

  if (ruta === '/api/salir') {
    res.setHeader('set-cookie', cookieSesion('', 0));
    return json(res, 200, { ok: true });
  }

  const yo = await necesitaCuenta(req);

  if (ruta === '/api/cuenta-nombre') {
    const nombre = String(datos.nombre ?? '').trim().slice(0, 30);
    if (!nombre) throw error(400, 'Escribe un nombre');
    return json(res, 200, await cambiarCuenta(yo.id, (c) => { c.nombre = nombre; return publica(c); }));
  }

  // Cambiar la contraseña o borrar la cuenta: las dos piden la contraseña actual
  if (ruta === '/api/cuenta-clave' || ruta === '/api/cuenta-borrar') {
    const anotar = frenar(`usuario:${yo.usuario}`, 10, 10);
    if (!mismoHash(await hashClave(String(datos.actual ?? ''), yo.sal), yo.clave)) {
      anotar();
      throw error(401, 'La contraseña actual no es correcta');
    }
    if (ruta === '/api/cuenta-borrar') {
      await pagos.cancelarDe(yo); // que no se le siga cobrando
      await cambiar((d) => { d.cuentas = (d.cuentas || []).filter((x) => x.id !== yo.id); });
      posPendientes.delete(yo.id);
      console.log(`Cuenta borrada: ${yo.usuario}`);
      res.setHeader('set-cookie', cookieSesion('', 0));
      return json(res, 200, { ok: true });
    }
    const nueva = String(datos.nueva ?? '');
    claveNueva(nueva);
    const sal = randomBytes(16).toString('hex');
    const hash = await hashClave(nueva, sal);
    const r = await cambiarCuenta(yo.id, (c, d) => { c.sal = sal; c.clave = hash; c.gen = (c.gen || 0) + 1; return { c, d }; });
    ponerSesion(res, r.d, r.c); // este dispositivo sigue dentro; los demás tienen que volver a entrar
    return json(res, 200, { ok: true });
  }

  // Cierra la sesión en todos los dispositivos menos en este
  if (ruta === '/api/cuenta-cerrar-todas') {
    const r = await cambiarCuenta(yo.id, (c, d) => { c.gen = (c.gen || 0) + 1; return { c, d }; });
    ponerSesion(res, r.d, r.c);
    return json(res, 200, { ok: true });
  }

  // Añadir o quitar de «Mi lista» (un vídeo o una serie entera)
  if (ruta === '/api/favorito') {
    const key = String(datos.key ?? '');
    if (!key || key.length > 1024 || (NUBE && key.split('/').some((p) => p.startsWith('_')))) throw error(400, 'Clave no válida');
    const favoritos = await cambiarCuenta(yo.id, (p) => {
      p.favoritos = p.favoritos.filter((f) => f.key !== key);
      if (datos.si) {
        p.favoritos.unshift({ key, tipo: key.endsWith('/') ? 'carpeta' : 'archivo',
          tamano: Number(datos.tamano) || null, fecha: datos.fecha || null, cuando: Date.now() });
        p.favoritos = p.favoritos.slice(0, 500);
      }
      return p.favoritos;
    });
    return json(res, 200, { favoritos });
  }

  // Por dónde vas: se apunta ya y se sube a e2 junto con las demás cada 20 s
  if (ruta === '/api/posicion') {
    const key = String(datos.key ?? '');
    if (!key || key.length > 1024) throw error(400, 'Clave no válida');
    if (!posPendientes.has(yo.id)) posPendientes.set(yo.id, new Map());
    posPendientes.get(yo.id).set(key, datos.borrar ? null
      : { t: Math.floor(Number(datos.t) || 0), total: Math.floor(Number(datos.total) || 0), cuando: Date.now(),
        tamano: Number(datos.tamano) || null, fecha: datos.fecha || null });
    return json(res, 200, { ok: true });
  }

  throw error(404, 'No existe');
}

async function volcarPosiciones() {
  if (!posPendientes.size) return;
  const lote = new Map(posPendientes);
  posPendientes.clear();
  try {
    await cambiar((d) => {
      for (const [id, cambios] of lote) {
        const p = (d.cuentas || []).find((x) => x.id === id);
        if (!p) continue;
        for (const [key, pos] of cambios) {
          if (pos) p.posiciones[key] = pos; else delete p.posiciones[key];
        }
        // Como mucho los 300 vídeos más recientes por cuenta
        const claves = Object.keys(p.posiciones).sort((a, b) => p.posiciones[b].cuando - p.posiciones[a].cuando);
        claves.slice(300).forEach((k) => delete p.posiciones[k]);
      }
    });
  } catch (e) {
    // Si falla se vuelve a intentar en la próxima vuelta (sin pisar lo que haya llegado después)
    for (const [id, cambios] of lote) {
      if (!posPendientes.has(id)) posPendientes.set(id, new Map());
      const actual = posPendientes.get(id);
      for (const [k, v] of cambios) if (!actual.has(k)) actual.set(k, v);
    }
    throw e;
  }
}

// Al apagar el servidor (Render lo hace a menudo) se intenta guardar lo pendiente
export const guardarPendiente = () => volcarPosiciones().catch(() => {});

export const RUTAS = ['/api/sesion', '/api/yo', '/api/registro', '/api/login', '/api/salir', '/api/cuenta-nombre',
  '/api/cuenta-clave', '/api/cuenta-borrar', '/api/cuenta-cerrar-todas', '/api/favorito', '/api/posicion'];
// Las que se pueden usar sin haber entrado
export const SIN_SESION = ['/api/sesion', '/api/registro', '/api/login', '/api/salir'];
