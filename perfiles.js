// Favoritos y «Seguir viendo» (por dónde va cada vídeo): una sola lista para todos, sin perfiles
// ni PIN.
// Todo se guarda en un único archivo oculto del bucket (_morvehtv/usuarios.json): así lo
// comparten el servidor de casa y el de Render y no se pierde cuando Render se reinicia. Es lo
// único que MorvehTV escribe en e2; los vídeos nunca se tocan.
import { randomBytes } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const ARCHIVO = '_morvehtv/usuarios.json';

let s3;
let bucket;
let NUBE = false;
let doc = null; // { secreto, comun, perfiles: [...] }
let leidoEn = 0;
let cola = Promise.resolve(); // las escrituras van de una en una
const posPendientes = new Map(); // lista → Map(key → posición): se guardan juntas cada 20 s

// ¿Se puede escribir el archivo de perfiles? (la clave de e2 tiene que permitirlo). Se comprueba
// al arrancar reescribiendo el archivo tal cual y se ve en /api/salud
export let escritura = 'comprobando';

export function iniciar(cliente, nombreBucket, nube) {
  s3 = cliente; bucket = nombreBucket; NUBE = nube;
  setInterval(() => volcarPosiciones().catch((e) => console.error(`No se pudo guardar el progreso: ${e.message}`)), 20000);
  // De paso se crea la lista común si aún no existe
  cambiar(unir).then(() => { escritura = 'ok'; }, (e) => {
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

const error = (status, message) => Object.assign(new Error(message), { status });

// ---------- Lista común ----------
// Ya no hay perfiles que elegir: todos usan la misma lista. La primera vez se juntan en ella los
// favoritos y el progreso de los perfiles que hubiera (que se quedan en el archivo, sin tocar)
function unir(d) {
  if (d.comun && d.perfiles.some((p) => p.id === d.comun)) return;
  const comun = { id: randomBytes(8).toString('hex'), nombre: 'MorvehTV', creado: new Date().toISOString(), favoritos: [], posiciones: {} };
  const favoritos = d.perfiles.flatMap((p) => p.favoritos || []).sort((a, b) => (b.cuando || 0) - (a.cuando || 0));
  comun.favoritos = favoritos.filter((f, i) => favoritos.findIndex((x) => x.key === f.key) === i).slice(0, 500);
  for (const p of d.perfiles) {
    for (const [key, pos] of Object.entries(p.posiciones || {})) {
      if (!comun.posiciones[key] || comun.posiciones[key].cuando < pos.cuando) comun.posiciones[key] = pos;
    }
  }
  d.perfiles.push(comun);
  d.comun = comun.id;
}

async function necesitaPerfil() {
  let d = await leer();
  if (!d.comun) d = await cambiar((x) => { unir(x); return x; });
  const p = d.perfiles.find((x) => x.id === d.comun);
  if (!p) throw error(503, 'La lista aún no está lista');
  return p;
}

async function cuerpo(req) {
  let t = '';
  for await (const trozo of req) {
    t += trozo;
    if (t.length > 20000) throw error(413, 'Demasiado grande');
  }
  return t ? JSON.parse(t) : {};
}

// ---------- Rutas ----------
export async function atender(ruta, req, res, json) {
  if (ruta === '/api/yo') {
    const p = await necesitaPerfil();
    const pendientes = posPendientes.get(p.id);
    const posiciones = { ...p.posiciones, ...(pendientes ? Object.fromEntries(pendientes) : {}) };
    return json(res, 200, { id: p.id, nombre: p.nombre, favoritos: p.favoritos, posiciones });
  }
  if (req.method !== 'POST') throw error(405, 'Método no permitido');
  const datos = await cuerpo(req);
  const yo = await necesitaPerfil();

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

export const RUTAS = ['/api/yo', '/api/favorito', '/api/posicion'];
