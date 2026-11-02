// Perfiles de la familia: «¿Quién está viendo?», cada uno con su PIN de 4 cifras, su lista de
// favoritos y por dónde va en cada vídeo.
// Todo se guarda en un único archivo oculto del bucket (_morvehtv/usuarios.json): así lo
// comparten el servidor de casa y el de Render y no se pierde cuando Render se reinicia. Es lo
// único que MorvehTV escribe en e2; los vídeos nunca se tocan.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const ARCHIVO = '_morvehtv/usuarios.json';
const COOKIE = 'morvehtv_perfil';
const MAX_PERFILES = 10;
export const AVATARES = ['🦁', '🐼', '🦊', '🐸', '🐙', '🦄', '🐯', '🐵', '🐧', '🐶', '🐱', '🐻'];
export const COLORES = ['#e5484d', '#4f8cff', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#12a594', '#ffb224'];

let s3;
let bucket;
let NUBE = false;
let doc = null; // { secreto, perfiles: [...] }
let leidoEn = 0;
let cola = Promise.resolve(); // las escrituras van de una en una
const posPendientes = new Map(); // perfil → Map(key → posición): se guardan juntas cada 20 s
const fallos = new Map(); // perfil → { n, hasta }

// ¿Se puede escribir el archivo de perfiles? (la clave de e2 tiene que permitirlo). Se comprueba
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
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return { secreto: randomBytes(32).toString('hex'), perfiles: [] };
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

const hashPin = (pin, sal) => scryptSync(String(pin), sal, 32).toString('hex');
const error = (status, message) => Object.assign(new Error(message), { status });
const publico = (p) => ({ id: p.id, nombre: p.nombre, avatar: p.avatar, color: p.color });

// ---------- Sesión del perfil (cookie firmada con un secreto que vive en el propio archivo) ----------
function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
}
const firma = (secreto, id) => createHmac('sha256', secreto).update(`perfil:${id}`).digest('hex');

async function perfilDe(req) {
  const [id, f] = String(cookies(req)[COOKIE] ?? '').split('.');
  if (!id || !f) return null;
  const d = await leer();
  const bien = firma(d.secreto, id);
  if (f.length !== bien.length || !timingSafeEqual(Buffer.from(f), Buffer.from(bien))) return null;
  return d.perfiles.find((p) => p.id === id) ?? null;
}

async function necesitaPerfil(req) {
  const p = await perfilDe(req);
  if (!p) throw error(401, 'Elige tu perfil');
  return p;
}

const cookiePerfil = (valor, maxAge) =>
  `${COOKIE}=${valor}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${NUBE ? '; Secure' : ''}`;

async function cuerpo(req) {
  let t = '';
  for await (const trozo of req) {
    t += trozo;
    if (t.length > 20000) throw error(413, 'Demasiado grande');
  }
  return t ? JSON.parse(t) : {};
}

const pinValido = (pin) => /^\d{4}$/.test(String(pin ?? ''));

// ---------- Rutas ----------
export async function atender(ruta, req, res, json) {
  // Lista para «¿Quién está viendo?»
  if (ruta === '/api/perfiles') {
    const d = await leer();
    const yo = await perfilDe(req);
    return json(res, 200, { perfiles: d.perfiles.map(publico), actual: yo ? yo.id : null, avatares: AVATARES, colores: COLORES });
  }
  if (req.method !== 'POST' && ruta !== '/api/yo') throw error(405, 'Método no permitido');

  if (ruta === '/api/yo') {
    const p = await necesitaPerfil(req);
    const pendientes = posPendientes.get(p.id);
    const posiciones = { ...p.posiciones, ...(pendientes ? Object.fromEntries(pendientes) : {}) };
    return json(res, 200, { ...publico(p), favoritos: p.favoritos, posiciones });
  }

  const datos = await cuerpo(req);

  if (ruta === '/api/perfil-crear') {
    const nombre = String(datos.nombre ?? '').trim().slice(0, 20);
    if (!nombre) throw error(400, 'Pon un nombre');
    if (!pinValido(datos.pin)) throw error(400, 'El PIN tiene que ser de 4 números');
    const avatar = AVATARES.includes(datos.avatar) ? datos.avatar : AVATARES[0];
    const color = COLORES.includes(datos.color) ? datos.color : COLORES[0];
    const nuevo = await cambiar((d) => {
      if (d.perfiles.length >= MAX_PERFILES) throw error(400, `Como mucho ${MAX_PERFILES} perfiles`);
      if (d.perfiles.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) throw error(400, 'Ya hay un perfil con ese nombre');
      const sal = randomBytes(16).toString('hex');
      const p = { id: randomBytes(8).toString('hex'), nombre, avatar, color, sal, pin: hashPin(datos.pin, sal),
        creado: new Date().toISOString(), favoritos: [], posiciones: {} };
      d.perfiles.push(p);
      return { p, secreto: d.secreto };
    });
    res.setHeader('set-cookie', cookiePerfil(`${nuevo.p.id}.${firma(nuevo.secreto, nuevo.p.id)}`, 31536000));
    return json(res, 200, publico(nuevo.p));
  }

  if (ruta === '/api/perfil-entrar') {
    const d = await leer();
    const p = d.perfiles.find((x) => x.id === datos.id);
    if (!p) throw error(404, 'Ese perfil ya no existe');
    const f = fallos.get(p.id);
    if (f && f.n >= 5 && f.hasta > Date.now()) throw error(429, 'Demasiados intentos. Espera 5 minutos.');
    if (!pinValido(datos.pin) || hashPin(datos.pin, p.sal) !== p.pin) {
      fallos.set(p.id, { n: (f && f.hasta > Date.now() ? f.n : 0) + 1, hasta: Date.now() + 5 * 60000 });
      throw error(401, 'PIN incorrecto');
    }
    fallos.delete(p.id);
    res.setHeader('set-cookie', cookiePerfil(`${p.id}.${firma(d.secreto, p.id)}`, 31536000));
    return json(res, 200, publico(p));
  }

  if (ruta === '/api/perfil-salir') {
    res.setHeader('set-cookie', cookiePerfil('', 0));
    return json(res, 200, { ok: true });
  }

  const yo = await necesitaPerfil(req);

  // Cambiar nombre, avatar, color o PIN del propio perfil (pide el PIN actual)
  if (ruta === '/api/perfil-editar') {
    if (hashPin(datos.pinActual ?? '', yo.sal) !== yo.pin) throw error(401, 'PIN actual incorrecto');
    const r = await cambiar((d) => {
      const p = d.perfiles.find((x) => x.id === yo.id);
      if (!p) throw error(404, 'Ese perfil ya no existe');
      const nombre = String(datos.nombre ?? '').trim().slice(0, 20);
      if (nombre) {
        if (d.perfiles.some((x) => x.id !== p.id && x.nombre.toLowerCase() === nombre.toLowerCase())) throw error(400, 'Ya hay un perfil con ese nombre');
        p.nombre = nombre;
      }
      if (AVATARES.includes(datos.avatar)) p.avatar = datos.avatar;
      if (COLORES.includes(datos.color)) p.color = datos.color;
      if (datos.pin) {
        if (!pinValido(datos.pin)) throw error(400, 'El PIN tiene que ser de 4 números');
        p.sal = randomBytes(16).toString('hex');
        p.pin = hashPin(datos.pin, p.sal);
      }
      return publico(p);
    });
    return json(res, 200, r);
  }

  if (ruta === '/api/perfil-borrar') {
    if (hashPin(datos.pin ?? '', yo.sal) !== yo.pin) throw error(401, 'PIN incorrecto');
    await cambiar((d) => { d.perfiles = d.perfiles.filter((x) => x.id !== yo.id); });
    posPendientes.delete(yo.id);
    res.setHeader('set-cookie', cookiePerfil('', 0));
    return json(res, 200, { ok: true });
  }

  // Añadir o quitar de «Mi lista» (un vídeo o una serie entera)
  if (ruta === '/api/favorito') {
    const key = String(datos.key ?? '');
    if (!key || key.length > 1024 || (NUBE && key.split('/').some((p) => p.startsWith('_')))) throw error(400, 'Clave no válida');
    const favoritos = await cambiar((d) => {
      const p = d.perfiles.find((x) => x.id === yo.id);
      if (!p) throw error(404, 'Ese perfil ya no existe');
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
        const p = d.perfiles.find((x) => x.id === id);
        if (!p) continue;
        for (const [key, pos] of cambios) {
          if (pos) p.posiciones[key] = pos; else delete p.posiciones[key];
        }
        // Como mucho los 300 vídeos más recientes por perfil
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

export const RUTAS = ['/api/perfiles', '/api/yo', '/api/perfil-crear', '/api/perfil-entrar', '/api/perfil-salir',
  '/api/perfil-editar', '/api/perfil-borrar', '/api/favorito', '/api/posicion'];
