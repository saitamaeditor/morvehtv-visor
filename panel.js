// API del panel de gestión de e2 («MorvehTV Gestor», una web aparte en GitHub Pages): explorar
// el bucket, crear carpetas, mover o renombrar, borrar, sacar enlaces y subir archivos directo a
// e2 por trozos firmados (el archivo no pasa por este servidor). Solo administradores: los de
// «admins» en el archivo de cuentas (o VISOR_ADMINS). Como es otra web, entra con un token en la
// cabecera Authorization en vez de la cookie, y aquí se responde con CORS solo a esa web.
// Nunca se tocan las carpetas internas («_morvehtv», «_fotograma»…). Para que el navegador pueda
// subir, el bucket tiene que aceptar PUT desde la web del panel en sus reglas CORS.
import {
  ListObjectsV2Command, HeadObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectsCommand,
  CreateMultipartUploadCommand, UploadPartCommand, UploadPartCopyCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import * as meta from './metadatos.js';
import * as enlaces from './enlaces.js';

// Subidas desde enlace en marcha y recientes (en memoria: id → estado)
const trabajosEnlace = new Map();

// Subidas a través del servidor: el navegador manda cada trozo aquí (por HTTP/2, muchos a la vez
// sobre una sola conexión) y se reenvía a e2 según va llegando, sin guardarlo. Desde el navegador
// directo a e2 no se pasa de unos 5 MB/s (e2 limita cada conexión y el navegador abre pocas);
// el servidor llega a e2 a más de 60 MB/s con muchas conexiones a la vez.
const agenteE2 = new https.Agent({ keepAlive: true, maxSockets: 64 });
function reenviarTrozo(destino, req, largo) {
  return new Promise((ok, mal) => {
    const u = new URL(destino);
    const local = u.protocol === 'http:';
    const fallo = (m) => mal(Object.assign(new Error(m), { status: 502 }));
    const sal = (local ? http : https).request(u, { method: 'PUT', agent: local ? undefined : agenteE2, headers: { 'content-length': largo } }, (r) => {
      r.resume();
      r.on('end', () => (r.statusCode >= 200 && r.statusCode < 300 && r.headers.etag ? ok(r.headers.etag) : fallo(`e2 respondió ${r.statusCode}`)));
    });
    sal.on('error', (e) => fallo(`No se pudo enviar a e2 (${e.message})`));
    req.on('aborted', () => sal.destroy(new Error('el navegador cortó la subida')));
    req.on('error', (e) => sal.destroy(e));
    req.pipe(sal);
  });
}

const TAM_PARTE = 64 * 1024 * 1024; // el trozo más grande: 64 MB (hasta 640 GB por archivo)
// Trozo a la medida de cada archivo: unos 48 trozos (así las 12 conexiones del panel van llenas
// casi hasta el final), nunca menos de 8 MB ni más de 64 MB, y siempre menos de los 10 000 que admite e2
const MB = 1024 * 1024;
const tamParteDe = (tamano) => Math.max(8 * MB, Math.min(TAM_PARTE, Math.ceil(tamano / 48 / MB) * MB, Infinity), Math.ceil(tamano / 9999));
const TAM_COPIA = 1024 ** 3; // copias de más de 5 GB: por trozos de 1 GB
const SUBIBLES = /\.(mp4|m4v|mkv|webm|mov|avi|ts|wmv|flv|srt|vtt|ass|jpg|jpeg|png|webp)$/i;
const TIPOS = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', ts: 'video/mp2t', srt: 'text/plain; charset=utf-8', vtt: 'text/vtt', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
// Webs desde las que se puede usar (además, en casa, cualquier localhost para probar)
const ORIGENES = String(process.env.PANEL_ORIGENES ?? 'https://saitamaeditor.github.io').split(',').map((o) => o.trim()).filter(Boolean);

let s3; let s3Virtual = null; let bucket; let foto; let nube; let p; let alMover = () => {};
let pagosEstado = () => 'desactivado';
let pagos = null; // pagos.js (USDC)
let alMantenimiento = () => {};
let alFichas = () => {};
let alAvisos = () => {};
export function iniciar(opciones) {
  alFichas = opciones.alFichas ?? alFichas;
  alAvisos = opciones.alAvisos ?? alAvisos;
  ({ s3, bucket, foto, nube, perfiles: p } = opciones);
  s3Virtual = opciones.s3Virtual ?? null;
  alMover = opciones.alMover ?? alMover;
  alMantenimiento = opciones.alMantenimiento ?? alMantenimiento;
  pagosEstado = opciones.pagosEstado ?? pagosEstado;
  pagos = opciones.pagos ?? null;
  // La papelera se vacía sola pasados unos días (solo un servidor: el de Render)
  if (nube) { setTimeout(purgar, 120000).unref(); setInterval(purgar, 6 * 3600000).unref(); }
  // Borra las IPs que guardó el registro antes de dejar de apuntarlas
  setTimeout(async () => {
    try {
      const lista = await p.leerAjuste('registro');
      if (lista?.some((x) => 'ip' in x)) await p.guardarAjuste('registro', lista.map(sinIp));
    } catch { /* se reintenta en el próximo arranque */ }
  }, 30000).unref();
}

export const esRuta = (ruta) => ruta.startsWith('/api/panel/');
const error = (status, message) => Object.assign(new Error(message), { status });

// ---------- Rutas y nombres permitidos ----------
const interna = (k) => k.split('/').some((x) => x.startsWith('_'));
function carpetaValida(c, { raiz = false } = {}) {
  const carpeta = String(c ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
  if (raiz && carpeta === '') return '';
  const partes = carpeta.replace(/\/$/, '').split('/');
  if (!carpeta.endsWith('/') || carpeta.length > 700 || interna(carpeta)
    || partes.some((x) => !x.trim() || x === '.' || x === '..' || x !== x.trim() || /[\u0000-\u001f]/.test(x))) throw error(400, 'Carpeta no válida');
  return carpeta;
}
function nombreValido(n) {
  const nombre = String(n ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
  if (!nombre || nombre.startsWith('.') || nombre.startsWith('_') || nombre.length > 200) throw error(400, 'Nombre no válido');
  return nombre;
}
// Una clave cualquiera de las que el panel puede tocar: un archivo o una carpeta («…/»)
function claveValida(k) {
  const key = String(k ?? '');
  if (key.endsWith('/')) return carpetaValida(key);
  const i = key.lastIndexOf('/');
  if (i > 0) carpetaValida(key.slice(0, i + 1));
  nombreValido(key.slice(i + 1));
  return key;
}

// Vídeos de anuncios: van a una carpeta interna (no salen en el catálogo ni en Telegram)
const ANUNCIO_VIDEO = /^_morvehtv\/anuncios\/[\w-]{8,60}\.(mp4|m4v|webm|mov)$/;
const claveSubida = (k) => (ANUNCIO_VIDEO.test(String(k ?? '')) ? String(k) : claveValida(k));

async function cuerpo(req) {
  let t = '';
  for await (const trozo of req) {
    t += trozo;
    if (t.length > 500000) throw error(413, 'Demasiado grande');
  }
  return t ? JSON.parse(t) : {};
}

async function todos(prefijo) {
  const lista = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefijo, ContinuationToken: token }));
    lista.push(...(r.Contents ?? []));
    token = r.NextContinuationToken;
  } while (token);
  return lista;
}
const existe = (key) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(() => true, (e) => {
  if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
  throw e;
});
const fuente = (key) => `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;

// Copia dentro del bucket (las de más de 5 GB, por trozos, como pide S3)
async function copiar(de, a, tamano) {
  if (tamano <= 5 * 1024 ** 3) {
    return s3.send(new CopyObjectCommand({ Bucket: bucket, Key: a, CopySource: fuente(de) }));
  }
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: a }));
  try {
    const partes = [];
    for (let n = 1, desde = 0; desde < tamano; n++, desde += TAM_COPIA) {
      const r = await s3.send(new UploadPartCopyCommand({ Bucket: bucket, Key: a, UploadId, PartNumber: n, CopySource: fuente(de),
        CopySourceRange: `bytes=${desde}-${Math.min(desde + TAM_COPIA, tamano) - 1}` }));
      partes.push({ PartNumber: n, ETag: r.CopyPartResult.ETag });
    }
    await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: a, UploadId, MultipartUpload: { Parts: partes } }));
  } catch (e) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: a, UploadId })).catch(() => {});
    throw e;
  }
}
async function borrarClaves(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const r = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    if (r.Errors?.length) throw error(500, `No se pudo borrar ${r.Errors[0].Key}: ${r.Errors[0].Message}`);
  }
}

// ---------- Papelera ----------
// Borrar no borra: lo mueve a «_papelera/<lote>/<ruta de antes>» (carpeta interna, que no ve
// nadie más que el panel). Desde ahí se recupera tal cual. Vaciar un lote sí es para siempre, y
// pide la contraseña y que el lote tenga al menos un día: si alguien roba una cuenta de
// administrador, no puede destruir nada al momento. Lo de más de 30 días se vacía solo.
const PAPELERA = '_papelera/';
const DIAS_PAPELERA = Math.max(1, Number(process.env.VISOR_PAPELERA_DIAS) || 30);
const HORAS_ANTES_DE_VACIAR = 24;
const MANIFIESTO = '_lote.json';
const trabajos = new Map(); // id → { tipo, total, hechos, estado, error, fin }

function nuevoTrabajo(tipo, total) {
  const id = randomUUID();
  const t = { id, tipo, total, hechos: 0, estado: 'en curso' };
  trabajos.set(id, t);
  for (const [k, x] of trabajos) if (x.fin && Date.now() - x.fin > 3600000) trabajos.delete(k);
  return t;
}
const terminar = (t, e) => { t.estado = e ? 'error' : 'hecho'; t.error = e?.message; t.fin = Date.now(); };
async function esperarTrabajo(t) {
  while (t.estado === 'en curso') await new Promise((ok) => setTimeout(ok, 200));
  if (t.estado === 'error') throw error(500, t.error);
}

// Mueve objetos a un lote nuevo de la papelera (uno a uno: copiar y borrar, así un corte a medias
// no pierde nada). Devuelve el trabajo, que sigue en segundo plano.
async function aPapelera(objetos, c, ip, motivo, claves) {
  const lote = `${new Date().toISOString().replace(/[:.]/g, '-')}_${c.usuario}`;
  const tamano = objetos.reduce((t, o) => t + (o.Size || 0), 0);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${PAPELERA}${lote}/${MANIFIESTO}`, ContentType: 'application/json',
    Body: JSON.stringify({ lote, usuario: c.usuario, fecha: new Date().toISOString(), motivo, claves, objetos: objetos.length, tamano }) }));
  const t = nuevoTrabajo('papelera', objetos.length);
  t.lote = lote;
  (async () => {
    for (const o of objetos) {
      await copiar(o.Key, `${PAPELERA}${lote}/${o.Key}`, o.Size || 0);
      await borrarClaves([o.Key]);
      t.hechos++;
    }
  })().then(() => terminar(t), (e) => { terminar(t, e); console.error(`Panel: papelera ${lote}: ${e.message}`); });
  return t;
}

const lote2fecha = (lote) => lote.replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z.*$/, '$1:$2:$3.$4Z');
const loteValido = (l) => { if (!/^[\w.-]{10,80}$/.test(String(l ?? ''))) throw error(400, 'Lote no válido'); return String(l); };

async function lotes() {
  const lista = new Map();
  for (const o of await todos(PAPELERA)) {
    const [, lote, ...resto] = o.Key.split('/');
    if (!lote) continue;
    if (!lista.has(lote)) lista.set(lote, { lote, objetos: [], tamano: 0, info: null });
    const l = lista.get(lote);
    if (resto.join('/') === MANIFIESTO) l.manifiesto = o.Key;
    else { l.objetos.push(o); l.tamano += o.Size || 0; }
  }
  for (const l of lista.values()) {
    if (l.manifiesto) {
      try { l.info = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: l.manifiesto }))).Body.transformToString()); } catch { /* sin datos */ }
    }
    l.fecha = l.info?.fecha ?? lote2fecha(l.lote);
  }
  return [...lista.values()].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

async function purgar() {
  try {
    for (const l of await lotes()) {
      if (Date.now() - new Date(l.fecha).getTime() < DIAS_PAPELERA * 864e5) continue;
      await borrarClaves([...l.objetos.map((o) => o.Key), ...(l.manifiesto ? [l.manifiesto] : [])]);
      await registrar({ usuario: 'sistema' }, null, 'papelera vaciada sola', [l.lote], l.objetos.length);
      console.log(`Panel: papelera ${l.lote} vaciada (más de ${DIAS_PAPELERA} días)`);
    }
  } catch (e) { console.error(`Panel: no se pudo repasar la papelera (${e.message})`); }
}

// ---------- Registro: quién hizo qué (en el archivo de cuentas, las últimas 500 acciones) ----------
// Sin IPs ni otros datos personales: solo el usuario, la fecha y la acción. (Las entradas
// antiguas que llevaban IP la pierden la próxima vez que se escribe.)
const sinIp = ({ ip, ...x }) => x;
async function registrar(c, _ip, accion, claves = [], objetos) {
  try {
    const lista = ((await p.leerAjuste('registro')) ?? []).map(sinIp);
    lista.unshift({ fecha: new Date().toISOString(), usuario: c.usuario, accion, claves: claves.slice(0, 20), total: claves.length, ...(objetos != null && { objetos }) });
    await p.guardarAjuste('registro', lista.slice(0, 500));
  } catch (e) { console.error(`Panel: no se pudo apuntar en el registro (${e.message})`); }
}

// ---------- CORS ----------
function cors(req, res) {
  const origen = req.headers.origin;
  const vale = origen && (ORIGENES.includes(origen) || (!nube && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen)));
  if (vale) {
    res.setHeader('access-control-allow-origin', origen);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('access-control-max-age', '3600');
  }
  return vale;
}

// ---------- Rutas ----------
export async function atender(ruta, req, res, json, ip) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const datos = req.method === 'POST' ? await cuerpo(req) : {};

  // Entrar: usuario y contraseña de MorvehTV de un administrador → token de 30 días
  if (ruta === '/api/panel/entrar') {
    let c = null;
    try { c = await p.credenciales(datos.usuario, datos.clave, ip); } catch (e) { if (e.status === 429) throw e; }
    if (!c) throw error(401, 'Usuario o contraseña incorrectos');
    if (!(await p.esAdmin(c)) && !(await p.colaboradorDe(c))) throw error(403, 'Esta cuenta no es administradora ni colaboradora');
    await registrar(c, ip, 'entra en el gestor');
    const esAdm = await p.esAdmin(c);
    return json(res, 200, { token: await p.tokenPanel(c), usuario: c.usuario, nombre: c.nombre, rol: esAdm ? 'admin' : 'colaborador', secciones: esAdm ? null : (await p.colaboradorDe(c)).secciones });
  }

  const c = await p.cuentaDeToken(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (!c) throw error(401, 'La sesión ha caducado: vuelve a entrar');
  // Dos papeles: administrador (todo) y colaborador (subir y crear carpetas, solo en sus secciones;
  // nunca borrar, mover, ni la papelera, el registro, los anuncios, los pagos o los colaboradores).
  // Se comprueba en cada petición: si un administrador lo quita, deja de poder al momento.
  const admin = await p.esAdmin(c);
  const colab = admin ? null : await p.colaboradorDe(c);
  if (!admin && !colab) throw error(403, 'Esta cuenta ya no tiene acceso al gestor');
  const secciones = admin ? null : (colab.secciones || []);
  const puede = (clave) => !secciones || secciones.some((s) => String(clave).startsWith(s));
  const SOLO_ADMIN = /^\/api\/panel\/(mover|borrar|papelera|registro|anuncios|cripto|colaboradores|admins|trabajo|mantenimiento|fichas|avisos)/;
  if (!admin && (SOLO_ADMIN.test(ruta) || datos.anuncio)) throw error(403, 'Eso solo lo pueden hacer los administradores');
  const fuera = () => error(403, 'No tienes permiso en esa sección');

  if (ruta === '/api/panel/yo') return json(res, 200, { usuario: c.usuario, nombre: c.nombre, rol: admin ? 'admin' : 'colaborador', secciones });

  // ---------- Colaboradores (solo administradores) ----------
  if (ruta === '/api/panel/colaboradores' && req.method === 'GET') {
    const lista = (await p.leerAjuste('colaboradores')) ?? [];
    const conCuenta = await Promise.all(lista.map(async (x) => ({ ...x, existe: Boolean(await p.cuentaPorUsuario(x.usuario)) })));
    const todas = [...new Set([...(await foto()).keys()].filter((k) => k.includes('/')).map((k) => `${k.split('/')[0]}/`))].sort();
    return json(res, 200, { colaboradores: conCuenta, secciones: todas, admins: await p.listaAdmins(), yo: c.usuario });
  }
  // Administradores: dar el papel a una cuenta que ya existe, o quitárselo (a otro: uno mismo no,
  // para no quedarse fuera; y nunca el último). Al quitarlo, con «secciones» pasa a colaborador.
  if (ruta === '/api/panel/admins/dar') {
    const quien = await p.cuentaPorUsuario(String(datos.usuario ?? ''));
    if (!quien) throw error(404, 'No hay ninguna cuenta de MorvehTV con ese usuario: que se registre primero');
    if (await p.esAdmin(quien)) throw error(409, 'Esa cuenta ya es administradora');
    await p.ponerAdmin(quien.usuario, true, { por: c.usuario });
    await registrar(c, ip, `hace administrador a ${quien.usuario}`);
    return json(res, 200, { ok: true });
  }
  if (ruta === '/api/panel/admins/quitar') {
    const usuario = String(datos.usuario ?? '').trim().toLowerCase();
    if (usuario === c.usuario) throw error(409, 'No puedes quitarte a ti mismo: que lo haga otro administrador');
    const elegidas = [...new Set((Array.isArray(datos.secciones) ? datos.secciones : []).map((x) => carpetaValida(x)).filter((x) => x.split('/').length === 2))];
    await p.ponerAdmin(usuario, false, { por: c.usuario, secciones: elegidas });
    await registrar(c, ip, elegidas.length ? `pasa a ${usuario} de administrador a colaborador` : `quita el permiso de administrador a ${usuario}`, elegidas.length ? elegidas : undefined);
    return json(res, 200, { ok: true });
  }
  if (ruta === '/api/panel/colaboradores') {
    const quien = await p.cuentaPorUsuario(String(datos.usuario ?? ''));
    if (!quien) throw error(404, 'No hay ninguna cuenta de MorvehTV con ese usuario: que se registre primero');
    const elegidas = [...new Set((Array.isArray(datos.secciones) ? datos.secciones : []).map((x) => carpetaValida(x)).filter((x) => x.split('/').length === 2))];
    if (!elegidas.length) throw error(400, 'Elige al menos una sección');
    // Un administrador que pasa a colaborador
    if (await p.esAdmin(quien)) {
      if (quien.usuario === c.usuario) throw error(409, 'No puedes quitarte a ti mismo el permiso de administrador');
      await p.ponerAdmin(quien.usuario, false, { por: c.usuario, secciones: elegidas });
      await registrar(c, ip, `pasa a ${quien.usuario} de administrador a colaborador`, elegidas);
      return json(res, 200, { ok: true });
    }
    const lista = ((await p.leerAjuste('colaboradores')) ?? []).filter((x) => x.usuario !== quien.usuario);
    lista.push({ usuario: quien.usuario, secciones: elegidas, creado: new Date().toISOString(), por: c.usuario });
    await p.guardarAjuste('colaboradores', lista);
    await registrar(c, ip, `da permiso de colaborador a ${quien.usuario}`, elegidas);
    return json(res, 200, { ok: true });
  }
  // Crear la cuenta de un colaborador (usuario, nombre y contraseña) con sus secciones
  if (ruta === '/api/panel/colaboradores/crear') {
    const elegidas = [...new Set((Array.isArray(datos.secciones) ? datos.secciones : []).map((x) => carpetaValida(x)).filter((x) => x.split('/').length === 2))];
    // Cuenta nueva de administrador: se crea igual y se le da el papel (sin secciones: puede con todo)
    if (datos.rol === 'admin') {
      const nueva = await p.crearColaborador({ usuario: datos.usuario, nombre: datos.nombre, clave: datos.clave, secciones: [], por: c.usuario });
      await p.ponerAdmin(nueva.usuario, true, { por: c.usuario });
      await registrar(c, ip, `crea la cuenta de administrador ${nueva.usuario}`);
      return json(res, 200, { ok: true, usuario: nueva.usuario });
    }
    if (!elegidas.length) throw error(400, 'Elige al menos una sección');
    const nueva = await p.crearColaborador({ usuario: datos.usuario, nombre: datos.nombre, clave: datos.clave, secciones: elegidas, por: c.usuario });
    console.log(`Panel: ${c.usuario} crea la cuenta de colaborador ${nueva.usuario}`);
    await registrar(c, ip, `crea la cuenta de colaborador ${nueva.usuario}`, elegidas);
    return json(res, 200, { ok: true, usuario: nueva.usuario });
  }
  // Nueva contraseña para un colaborador
  if (ruta === '/api/panel/colaboradores/clave') {
    await p.claveDeColaborador(datos.usuario, datos.clave);
    await registrar(c, ip, `cambia la contraseña del colaborador ${String(datos.usuario ?? '').toLowerCase()}`);
    return json(res, 200, { ok: true });
  }
  if (ruta === '/api/panel/colaboradores/quitar') {
    const usuario = String(datos.usuario ?? '').trim().toLowerCase();
    const lista = (await p.leerAjuste('colaboradores')) ?? [];
    if (!lista.some((x) => x.usuario === usuario)) throw error(404, 'No es colaborador');
    await p.guardarAjuste('colaboradores', lista.filter((x) => x.usuario !== usuario));
    await registrar(c, ip, `quita el permiso de colaborador a ${usuario}`);
    return json(res, 200, { ok: true });
  }

  // Contenido de una carpeta (sus subcarpetas y sus archivos)
  if (ruta === '/api/panel/listar') {
    const prefijo = carpetaValida(url.searchParams.get('prefijo') ?? '', { raiz: true });
    if (prefijo && !puede(prefijo)) throw fuera();
    const carpetas = new Set(); const archivos = [];
    let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefijo, Delimiter: '/', ContinuationToken: token }));
      for (const x of r.CommonPrefixes ?? []) if (!interna(x.Prefix) && (prefijo || puede(x.Prefix))) carpetas.add(x.Prefix);
      for (const o of r.Contents ?? []) {
        if (o.Key === prefijo || interna(o.Key) || (!prefijo && !admin)) continue;
        archivos.push({ key: o.Key, nombre: o.Key.slice(prefijo.length), tamano: o.Size, fecha: o.LastModified });
      }
      token = r.NextContinuationToken;
    } while (token);
    const orden = (a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
    return json(res, 200, {
      prefijo,
      carpetas: [...carpetas].map((x) => ({ prefijo: x, nombre: x.slice(prefijo.length, -1) })).sort((a, b) => orden(a.nombre, b.nombre)),
      archivos: archivos.sort((a, b) => orden(a.nombre, b.nombre)),
    });
  }

  // Resumen: cuántos archivos y cuánto ocupa cada sección
  if (ruta === '/api/panel/resumen') {
    const secciones = new Map();
    for (const [key, v] of await foto()) {
      if (!key.includes('/')) continue;
      const s = `${key.split('/')[0]}/`;
      if (!secciones.has(s)) secciones.set(s, { prefijo: s, nombre: s.slice(0, -1), archivos: 0, tamano: 0, ultima: 0 });
      if (key.endsWith('/')) continue;
      const [tam, ms] = v.split(':').map(Number);
      const x = secciones.get(s);
      x.archivos++; x.tamano += tam; x.ultima = Math.max(x.ultima, ms);
    }
    const lista = [...secciones.values()].filter((x) => puede(x.prefijo)).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return json(res, 200, { secciones: lista, archivos: lista.reduce((t, x) => t + x.archivos, 0), tamano: lista.reduce((t, x) => t + x.tamano, 0) });
  }

  // Enlace para ver o descargar un archivo (1 hora)
  if (ruta === '/api/panel/enlace') {
    const key = claveValida(url.searchParams.get('key'));
    if (!puede(key)) throw fuera();
    const descargar = url.searchParams.get('descargar') === '1';
    const nombre = key.split('/').pop();
    return json(res, 200, { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key,
      ...(descargar && { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(nombre)}` }) }), { expiresIn: 3600 }) });
  }

  // Cómo va un borrado o una recuperación (van en segundo plano)
  if (ruta === '/api/panel/trabajo') {
    const t = trabajos.get(String(url.searchParams.get('id')));
    if (!t) throw error(404, 'Ese trabajo ya no existe');
    return json(res, 200, t);
  }
  if (ruta === '/api/panel/papelera') {
    return json(res, 200, { dias: DIAS_PAPELERA, horasAntesDeVaciar: HORAS_ANTES_DE_VACIAR, lotes: (await lotes()).map((l) => ({
      lote: l.lote, fecha: l.fecha, usuario: l.info?.usuario ?? l.lote.split('_').slice(1).join('_'), motivo: l.info?.motivo ?? 'borrado',
      claves: l.info?.claves ?? [], objetos: l.objetos.filter((o) => !o.Key.endsWith('/')).length, tamano: l.tamano,
      seVaciaSola: new Date(new Date(l.fecha).getTime() + DIAS_PAPELERA * 864e5).toISOString(),
    })) });
  }
  if (ruta === '/api/panel/registro') return json(res, 200, ((await p.leerAjuste('registro')) ?? []).map(sinIp));

  // Pagos en USDC: pedidos recientes y lo que llegó sin poder identificarse
  if (ruta === '/api/panel/cripto' && req.method === 'GET') {
    if (!pagos) throw error(503, 'Pagos no disponibles');
    return json(res, 200, await pagos.resumenAdmin());
  }
  if (ruta === '/api/panel/cripto/asignar') {
    const quien = await p.cuentaPorUsuario(String(datos.usuario ?? ''));
    if (!quien) throw error(404, 'No hay ninguna cuenta con ese usuario');
    const meses = Number(datos.meses);
    if (!Number.isInteger(meses) || meses < 1 || meses > 60) throw error(400, 'Meses no válidos (1 a 60)');
    await pagos.asignarSuelto(String(datos.tx ?? ''), quien.id, meses, c.usuario);
    await registrar(c, ip, `asigna un pago USDC a ${quien.usuario} (${meses} meses)`, [String(datos.tx ?? '')]);
    return json(res, 200, { ok: true });
  }

  // Anuncios propios (los ve el plan Básico en la web y la app) y cómo van los planes
  if (ruta === '/api/panel/anuncios' && req.method === 'GET') {
    return json(res, 200, { anuncios: (await p.leerAjuste('anuncios')) ?? [], planes: await p.resumenPlanes(), pagos: pagosEstado(),
      adsense: Boolean(process.env.ANUNCIOS_ADSENSE) });
  }
  if (ruta === '/api/panel/anuncios') {
    const https = (u) => { try { return new URL(u).protocol === 'https:' ? String(u).slice(0, 1000) : null; } catch { return null; } };
    const lista = (Array.isArray(datos.anuncios) ? datos.anuncios : []).slice(0, 30).map((a) => ({
      id: String(a.id || randomUUID()).slice(0, 40),
      titulo: String(a.titulo ?? '').trim().slice(0, 60),
      texto: String(a.texto ?? '').trim().slice(0, 160),
      imagen: a.imagen ? https(a.imagen) : null,
      enlace: a.enlace ? https(a.enlace) : null,
      // Vídeo para antes de reproducir: uno subido desde aquí (en e2) o una dirección https
      video: !a.video ? null : ANUNCIO_VIDEO.test(String(a.video)) ? String(a.video) : https(a.video),
      activo: a.activo !== false,
    })).filter((a) => a.titulo || a.imagen || a.video);
    await p.guardarAjuste('anuncios', lista);
    await registrar(c, ip, `guarda los anuncios (${lista.length})`);
    return json(res, 200, { anuncios: lista });
  }

  // Web en mantenimiento: nadie entra salvo los administradores
  if (ruta === '/api/panel/mantenimiento' && req.method === 'GET') {
    return json(res, 200, (await p.leerAjuste('mantenimiento')) ?? { activo: false });
  }
  if (ruta === '/api/panel/mantenimiento') {
    const activo = datos.activo === true;
    const m = { activo, mensaje: String(datos.mensaje ?? '').trim().slice(0, 300), desde: activo ? new Date().toISOString() : null, por: c.usuario };
    await p.guardarAjuste('mantenimiento', m);
    alMantenimiento(m);
    await registrar(c, ip, activo ? 'pone la web en mantenimiento' : 'quita el mantenimiento');
    return json(res, 200, m);
  }

  // ---------- Avisos del reproductor ----------
  // Mensajes propios (Telegram, novedades, mantenimientos…) que salen en una tarjeta al empezar
  // un vídeo. No son publicidad de nadie: ni redes de anuncios ni pagos. Los ve todo el mundo.
  if (ruta === '/api/panel/avisos' && req.method === 'GET') return json(res, 200, { avisos: (await p.leerAjuste('avisosReproductor')) ?? [] });
  if (ruta === '/api/panel/avisos') {
    const https = (u) => { try { return new URL(u).protocol === 'https:' ? String(u).slice(0, 500) : null; } catch { return null; } };
    const lista = (Array.isArray(datos.avisos) ? datos.avisos : []).slice(0, 20).map((a) => ({
      id: String(a.id || randomUUID()).slice(0, 40),
      texto: String(a.texto ?? '').trim().slice(0, 160),
      enlace: a.enlace ? https(a.enlace) : null,
      boton: String(a.boton ?? '').trim().slice(0, 24) || null,
      activo: a.activo !== false,
    })).filter((a) => a.texto);
    await p.guardarAjuste('avisosReproductor', lista);
    alAvisos(lista);
    await registrar(c, ip, `guarda los avisos del reproductor (${lista.filter((a) => a.activo).length} activos)`);
    return json(res, 200, { avisos: lista });
  }

  // ---------- Fichas a mano (para lo que no está en ninguna base de datos) ----------
  // Se guardan en «fichasManuales» del archivo de cuentas y sus imágenes en _morvehtv/fichas/
  // (se ven en morvehtv.com/fichas/…). Las del repositorio (fichas/fichas.json) solo se enseñan.
  if (ruta === '/api/panel/fichas' && req.method === 'GET') {
    return json(res, 200, { fichas: (await p.leerAjuste('fichasManuales')) ?? [], repo: meta.fichasRepo() });
  }
  if (ruta === '/api/panel/fichas/imagen') {
    let buf; let tipo;
    if (req.method === 'PUT') {
      tipo = String(req.headers['content-type'] ?? '').split(';')[0];
      const trozos = []; let largo = 0;
      for await (const t of req) { largo += t.length; if (largo > 10 * MB) throw error(413, 'La imagen pesa más de 10 MB'); trozos.push(t); }
      buf = Buffer.concat(trozos);
    } else {
      // Desde un enlace: el servidor la descarga y la guarda (así no depende de la otra web)
      const u = (() => { try { return new URL(String(datos.url ?? '')); } catch { return null; } })();
      if (!u || u.protocol !== 'https:') throw error(400, 'Pega un enlace https a la imagen');
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (MorvehTV)' }, signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (!r?.ok) throw error(400, 'No se pudo descargar la imagen de ese enlace');
      tipo = String(r.headers.get('content-type') ?? '').split(';')[0];
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 10 * MB) throw error(413, 'La imagen pesa más de 10 MB');
    }
    const ext = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[tipo];
    if (!ext || !buf?.length) throw error(415, 'Tiene que ser una imagen JPG, PNG o WebP');
    const base = String(url.searchParams.get('nombre') ?? datos.nombre ?? 'imagen').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'imagen';
    const nombre = `${base}-${randomUUID().slice(0, 8)}.${ext}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `_morvehtv/fichas/${nombre}`, Body: buf, ContentType: tipo }));
    return json(res, 200, { nombre, url: `${String(process.env.VISOR_URL_FICHAS || 'https://morvehtv.com/fichas').replace(/\/$/, '')}/${nombre}` });
  }
  // Los capítulos que ya hay subidos de una serie (por el nombre de su carpeta, esté en la sección
  // que esté), con el título del archivo si lo trae y lo que diga la ficha actual (resumen…)
  if (ruta === '/api/panel/fichas/detectar') {
    const nombre = String(url.searchParams.get('nombre') ?? '').trim();
    if (!nombre) throw error(400, 'Escribe primero el nombre de la carpeta de la serie');
    const norm = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const sinAnio = (t) => t.replace(/\s+(?:19|20)\d\d$/, '');
    const buscado = norm(nombre.replace(/\/$/, '').split('/').pop());
    const ES_VIDEO = /\.(mp4|m4v|mkv|webm|mov|avi|ts|wmv|flv)$/i;
    const carpetas = new Map();
    for (const k of (await foto()).keys()) {
      if (interna(k) || !ES_VIDEO.test(k)) continue;
      const partes = k.split('/');
      for (let i = 1; i < partes.length - 1; i++) {
        const n = norm(partes[i]);
        if (n !== buscado && sinAnio(n) !== sinAnio(buscado)) continue;
        const pre = `${partes.slice(0, i + 1).join('/')}/`;
        if (!carpetas.has(pre)) carpetas.set(pre, []);
        carpetas.get(pre).push(k);
        break;
      }
    }
    if (!carpetas.size) throw error(404, `No hay ninguna carpeta llamada «${nombre}» con vídeos en e2`);
    const [carpeta, keys] = [...carpetas].sort((a, b) => b[1].length - a[1].length)[0];
    const temporadas = {};
    const generico = (t) => !t || /^(?:episodio|episode|cap[ií]tulo)\s*\d+$/i.test(t.trim());
    for (const k of keys.sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))) {
      const d = meta.analizar(k);
      if (!d?.episodio) continue;
      const delArchivo = k.split('/').pop().match(/(?:S\d{1,2}\s*E\d{1,4}|\d{1,2}x\d{2,4})\s*-\s*(.+)\.[a-z0-9]{2,4}$/i)?.[1]?.trim();
      const m = await meta.deArchivo(k).catch(() => null);
      const titulo = !generico(delArchivo) ? delArchivo : !generico(m?.episodio?.titulo) ? m.episodio.titulo : '';
      const lista = (temporadas[d.temporada] = temporadas[d.temporada] || []);
      if (!lista.some((e) => e.numero === d.episodio)) lista.push({ numero: d.episodio, titulo, sinopsis: m?.episodio?.sinopsis ?? '' });
    }
    // Huecos: los números que faltan entre el 1 y el último de cada temporada
    const faltan = [];
    for (const [t, eps] of Object.entries(temporadas)) {
      eps.sort((a, b) => a.numero - b.numero);
      const hay = new Set(eps.map((e) => e.numero));
      for (let n = 1; n <= eps.at(-1).numero; n++) if (!hay.has(n)) faltan.push(`T${t}E${n}`);
    }
    return json(res, 200, { carpeta, nombre: carpeta.replace(/\/$/, '').split('/').pop(), temporadas, total: Object.values(temporadas).reduce((s, x) => s + x.length, 0), faltan });
  }
  if (ruta === '/api/panel/fichas/guardar') {
    const f = datos.ficha ?? {};
    const texto = (t, n) => String(t ?? '').trim().slice(0, n);
    const lista = (x, n) => (Array.isArray(x) ? x : String(x ?? '').split(',')).map((s) => texto(s, 80)).filter(Boolean).slice(0, n);
    const imagen = (x) => { const v = texto(x, 500); return !v ? null : /^https:\/\//.test(v) || /^[\w.-]+\.(jpe?g|png|webp)$/i.test(v) ? v : null; };
    const numero = (x, max) => { const n = Math.floor(Number(x)); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
    const archivos = (Array.isArray(f.archivos) ? f.archivos : [f.archivos]).map((a) => texto(a, 200).replace(/\/$/, '').split('/').pop().replace(/\.(mp4|m4v|mkv|webm|mov|avi|ts|wmv|flv)$/i, '')).filter(Boolean).slice(0, 10);
    if (!archivos.length) throw error(400, 'Escribe el nombre del vídeo o de la carpeta de la serie');
    const soloCapitulos = f.ficha === false;
    const titulo = texto(f.titulo, 150);
    if (!titulo && !soloCapitulos) throw error(400, 'Escribe el título');
    const temporadas = {};
    for (const [n, eps] of Object.entries(f.temporadas ?? {})) {
      const t = numero(n, 99);
      if (t == null || !Array.isArray(eps)) continue;
      const caps = eps.slice(0, 1000).map((e) => ({ numero: numero(e.numero, 9999), titulo: texto(e.titulo, 200), sinopsis: texto(e.sinopsis, 2000),
        ...(imagen(e.imagen) && { imagen: imagen(e.imagen) }), ...(numero(e.duracion, 999) && { duracion: numero(e.duracion, 999) }) }))
        .filter((e) => e.numero != null);
      if (caps.length) temporadas[String(t)] = caps;
    }
    const todas = (await p.leerAjuste('fichasManuales')) ?? [];
    const antes = todas.find((x) => x.id === f.id);
    const nueva = {
      id: antes?.id ?? randomUUID(), archivos, tipo: f.tipo === 'serie' ? 'serie' : 'pelicula', ...(soloCapitulos && { ficha: false }),
      titulo, anio: texto(f.anio, 4).replace(/\D/g, ''), sinopsis: texto(f.sinopsis, 3000), duracion: numero(f.duracion, 999),
      generos: lista(f.generos, 6), direccion: lista(f.direccion, 6), reparto: lista(f.reparto, 12),
      poster: imagen(f.poster), fondo: imagen(f.fondo), web: /^https:\/\//.test(texto(f.web, 500)) ? texto(f.web, 500) : null, fuente: texto(f.fuente, 30) || null,
      ...(Object.keys(temporadas).length && { temporadas }),
      ...(f.tipo === 'serie' && f.numeracion === 'internacional' && { numeracion: 'internacional' }),
      // «Anunciar en Telegram» al guardar: una vez (cada vez que se marca, con otra marca)
      anunciar: f.anunciar ? new Date().toISOString() : (antes?.anunciar ?? null),
      cambiada: new Date().toISOString(), por: c.usuario,
    };
    // Que ningún otro nombre quede repetido en otra ficha
    const resto = todas.filter((x) => x.id !== nueva.id).map((x) => ({ ...x, archivos: (x.archivos ?? []).filter((a) => !archivos.some((b) => b.toLowerCase() === a.toLowerCase())) })).filter((x) => x.archivos.length);
    const guardadas = [...resto, nueva];
    await p.guardarAjuste('fichasManuales', guardadas);
    alFichas(guardadas);
    await registrar(c, ip, `${antes ? 'cambia' : 'crea'} la ficha a mano de «${titulo || archivos[0]}»`);
    return json(res, 200, { ficha: nueva });
  }
  if (ruta === '/api/panel/fichas/borrar') {
    const todas = (await p.leerAjuste('fichasManuales')) ?? [];
    const f = todas.find((x) => x.id === datos.id);
    if (!f) throw error(404, 'Esa ficha ya no existe');
    const guardadas = todas.filter((x) => x.id !== datos.id);
    await p.guardarAjuste('fichasManuales', guardadas);
    alFichas(guardadas);
    await registrar(c, ip, `borra la ficha a mano de «${f.titulo || f.archivos[0]}»`);
    return json(res, 200, { ok: true });
  }

  // Elegir el título antes de subirlo: buscar por nombre o IMDb y su ficha con los capítulos
  if (ruta === '/api/panel/titulos') {
    const q = String(url.searchParams.get('q') ?? '').trim();
    if (q.length < 2) return json(res, 200, []);
    return json(res, 200, await meta.buscarParaSubir(q, url.searchParams.get('fuente') || 'tmdb'));
  }
  if (ruta === '/api/panel/fuentes') return json(res, 200, meta.FUENTES_GESTOR);
  if (ruta === '/api/panel/titulo') return json(res, 200, await meta.fichaParaSubir(url.searchParams.get('tipo'), url.searchParams.get('id'), url.searchParams.get('fuente') || 'tmdb'));

  // ---------- Subir desde un enlace ----------
  // El servidor descarga el archivo del enlace y lo sube a e2 a la vez (enlaces.js). Va en segundo
  // plano: el gestor pregunta cómo va. Como mucho 3 a la vez.
  if (ruta === '/api/panel/subir/enlaces') {
    const mios = [...trabajosEnlace.values()].filter((t) => admin || t.por === c.usuario).slice(-30).reverse();
    return json(res, 200, mios.map(({ id, nombre, key, estado, bajado, total, error: e, inicio, fin }) => ({ id, nombre, key, estado, bajado, total, error: e, inicio, fin })));
  }
  if (ruta === '/api/panel/subir/enlace/cancelar') {
    const t = trabajosEnlace.get(String(datos.id ?? ''));
    if (!t || (!admin && t.por !== c.usuario)) throw error(404, 'No existe');
    t.cancelar = true;
    return json(res, 200, { ok: true });
  }
  if (ruta === '/api/panel/subir/enlace') {
    const carpeta = carpetaValida(datos.carpeta);
    if (carpeta.split('/').length < 2 || !puede(carpeta)) throw fuera();
    const activos = [...trabajosEnlace.values()].filter((t) => t.estado === 'bajando').length;
    if (activos >= 3) throw error(429, 'Ya hay 3 subidas desde enlace en marcha: espera a que acabe alguna');
    const { r, url: final, control } = await enlaces.abrir(String(datos.url ?? '').trim());
    if (!enlaces.esArchivo(r)) { control.abort(); throw error(400, 'Ese enlace lleva a una página web, no a un archivo. Copia el enlace de descarga directa del vídeo.'); }
    let nombre = String(datos.nombre ?? '').trim() || enlaces.nombreDe(r, final);
    // Sin extensión conocida: la del tipo de archivo que dice el servidor
    const tipo = String(r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const extTipo = { 'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/mp2t': 'ts' }[tipo];
    if (!SUBIBLES.test(nombre) && extTipo) nombre = `${nombre || 'video'}.${extTipo}`;
    try { nombre = nombreValido(nombre); } catch { control.abort(); throw error(400, 'No se sabe el nombre del archivo: escríbelo tú (con su extensión, p. ej. «Película - 2026.mp4»)'); }
    if (!SUBIBLES.test(nombre)) { control.abort(); throw error(400, 'Solo vídeos, subtítulos (.srt, .vtt, .ass) o imágenes: pon el nombre con su extensión (.mp4, .mkv…)'); }
    const key = carpeta + nombre;
    if (await existe(key)) { control.abort(); return json(res, 409, { error: `Ya hay un archivo «${nombre}» en esa carpeta: cámbiale el nombre o borra el otro antes`, existe: true }); }
    const total = Number(r.headers.get('content-length')) || null;
    const t = { id: randomUUID(), nombre, key, estado: 'bajando', bajado: 0, total, error: null, inicio: Date.now(), fin: null, por: c.usuario, cancelar: false };
    trabajosEnlace.set(t.id, t);
    if (trabajosEnlace.size > 100) trabajosEnlace.delete(trabajosEnlace.keys().next().value);
    const ext = nombre.split('.').pop().toLowerCase();
    enlaces.subirDesde(r, { s3, bucket, key, contentType: TIPOS[ext] ?? (tipo || 'application/octet-stream'), estado: t, control })
      .then(() => { t.estado = 'hecho'; console.log(`Panel: ${c.usuario} sube desde un enlace «${key}» (${(t.bajado / 2 ** 20).toFixed(0)} MB)`); })
      .catch((e) => { t.estado = t.cancelar ? 'cancelada' : 'error'; t.error = t.cancelar ? null : String(e.message).slice(0, 200); })
      .finally(() => { t.fin = Date.now(); });
    await registrar(c, ip, `sube desde un enlace «${nombre}»`, [key]);
    return json(res, 200, { id: t.id, nombre, key, total });
  }

  // Un trozo que llega por el servidor: se reenvía a e2 tal cual va llegando (con PUT, por eso va
  // antes de la regla de solo POST). PANEL_POR_SERVIDOR=0 lo apaga: el gestor vuelve solo a subir
  // directo a e2.
  if (ruta === '/api/panel/subir/trozo') {
    if (process.env.PANEL_POR_SERVIDOR === '0') throw error(404, 'Subida por el servidor desactivada');
    if (req.method !== 'PUT') throw error(405, 'Se envía con PUT');
    const key = claveSubida(url.searchParams.get('key'));
    if (!puede(key)) throw fuera();
    const uploadId = String(url.searchParams.get('uploadId') ?? '');
    const n = Number(url.searchParams.get('n'));
    const largo = Number(req.headers['content-length']);
    if (!uploadId || !Number.isInteger(n) || n < 1 || n > 10000) throw error(400, 'Trozo no válido');
    if (!(largo > 0) || largo > TAM_PARTE) throw error(413, 'Trozo demasiado grande');
    const destino = await getSignedUrl(s3, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n }), { expiresIn: 3600 });
    return json(res, 200, { etag: await reenviarTrozo(destino, req, largo) });
  }

  if (req.method !== 'POST') throw error(405, 'Método no permitido');

  // Deja apuntado qué título de TMDB es una película o una carpeta de serie (así la app no tiene
  // que adivinarlo por el nombre)
  if (ruta === '/api/panel/vincular') {
    const clave = claveValida(datos.clave);
    if (!puede(clave)) throw fuera();
    return json(res, 200, meta.corregir(clave, Number(datos.tmdbId), datos.tipo, datos.fuente && datos.fuente !== 'tmdb' ? { fuente: String(datos.fuente), id: datos.id } : null,
      { internacional: datos.internacional === true }));
  }

  // Crear carpetas (una o varias: «SERIES/Nueva/Temporada 1/»…)
  if (ruta === '/api/panel/carpeta') {
    const lista = (Array.isArray(datos.carpetas) ? datos.carpetas : [datos.carpeta]).map((x) => carpetaValida(x));
    if (!lista.length || lista.length > 100) throw error(400, 'Carpetas no válidas');
    // Un colaborador crea carpetas dentro de sus secciones, no secciones nuevas
    if (lista.some((x) => !puede(x) || (!admin && x.split('/').length === 2))) throw fuera();
    for (const x of lista) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: x, Body: '' }));
    console.log(`Panel: ${c.usuario} crea ${lista.join(', ')}`);
    await registrar(c, ip, 'crea carpetas', lista);
    return json(res, 200, { carpetas: lista });
  }

  // Mover o renombrar un archivo o una carpeta entera (copiar y borrar el original)
  if (ruta === '/api/panel/mover') {
    const de = claveValida(datos.de);
    const a = claveValida(datos.a);
    if (de === a) return json(res, 200, { ok: true, movidos: 0 });
    if (de.endsWith('/') !== a.endsWith('/')) throw error(400, 'No se puede convertir un archivo en carpeta');
    if (de.endsWith('/') && a.startsWith(de)) throw error(400, 'No se puede mover una carpeta dentro de sí misma');
    const origen = de.endsWith('/') ? await todos(de) : [await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: de }))
      .then((h) => ({ Key: de, Size: h.ContentLength }), () => { throw error(404, 'Ese archivo ya no existe'); })];
    if (!origen.length) throw error(404, 'Esa carpeta está vacía o ya no existe');
    if (!datos.reemplazar && (a.endsWith('/') ? (await todos(a)).length : await existe(a))) {
      return json(res, 409, { error: 'Ya existe algo con ese nombre en el destino', existe: true });
    }
    const destino = (k) => a + k.slice(de.length);
    // Lo que se reemplaza en el destino no se pierde: va a la papelera
    if (datos.reemplazar) {
      const pisados = a.endsWith('/') ? await todos(a)
        : await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: a })).then((h) => [{ Key: a, Size: h.ContentLength }], () => []);
      if (pisados.length) await esperarTrabajo(await aPapelera(pisados, c, ip, 'reemplazado al mover', [a]));
    }
    alMover(origen.map((o) => destino(o.Key)));
    for (const o of origen) await copiar(o.Key, destino(o.Key), o.Size);
    await borrarClaves(origen.map((o) => o.Key));
    console.log(`Panel: ${c.usuario} mueve ${de} → ${a} (${origen.length})`);
    await registrar(c, ip, `mueve a ${a}`, [de], origen.length);
    return json(res, 200, { ok: true, movidos: origen.length });
  }

  // Borrar archivos o carpetas enteras: van a la papelera (se pueden recuperar). Si es mucho de
  // golpe (más de 20 archivos o una sección entera) hay que confirmarlo escribiendo «BORRAR».
  if (ruta === '/api/panel/borrar') {
    const claves = (Array.isArray(datos.claves) ? datos.claves : []).map(claveValida);
    if (!claves.length || claves.length > 500) throw error(400, 'Nada que borrar');
    const lista = new Map();
    for (const k of claves) {
      if (k.endsWith('/')) {
        (await todos(k)).forEach((o) => lista.set(o.Key, o));
        if (!lista.has(k)) lista.set(k, { Key: k, Size: 0 });
      } else if (!lista.has(k)) {
        const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: k })).catch(() => null);
        if (h) lista.set(k, { Key: k, Size: h.ContentLength });
      }
    }
    const objetos = [...lista.values()];
    const archivos = objetos.filter((o) => !o.Key.endsWith('/')).length;
    const tamano = objetos.reduce((t, o) => t + (o.Size || 0), 0);
    const seccion = claves.some((k) => k.endsWith('/') && k.split('/').length === 2);
    if ((archivos > 20 || seccion) && datos.confirmacion !== 'BORRAR') {
      return json(res, 428, { error: 'Hay que confirmarlo escribiendo BORRAR', confirmar: true, archivos, tamano, seccion });
    }
    const t = await aPapelera(objetos, c, ip, 'borrado', claves);
    console.log(`Panel: ${c.usuario} manda a la papelera ${claves.join(', ')} (${objetos.length} objetos)`);
    await registrar(c, ip, 'borra (a la papelera)', claves, archivos);
    return json(res, 200, { ok: true, trabajo: t.id, lote: t.lote, borrados: archivos });
  }

  // Recuperar un lote de la papelera a donde estaba (lo que ya exista en su sitio no se pisa)
  if (ruta === '/api/panel/papelera/recuperar') {
    const lote = loteValido(datos.lote);
    const l = (await lotes()).find((x) => x.lote === lote);
    if (!l) throw error(404, 'Ese lote ya no está en la papelera');
    const base = `${PAPELERA}${lote}/`;
    const t = nuevoTrabajo('recuperar', l.objetos.length);
    t.saltados = 0;
    alMover(l.objetos.map((o) => o.Key.slice(base.length)));
    (async () => {
      for (const o of l.objetos) {
        const destino = o.Key.slice(base.length);
        if (!destino.endsWith('/') && await existe(destino)) { t.saltados++; t.hechos++; continue; }
        await copiar(o.Key, destino, o.Size || 0);
        await borrarClaves([o.Key]);
        t.hechos++;
      }
      if (!t.saltados && l.manifiesto) await borrarClaves([l.manifiesto]);
    })().then(() => terminar(t), (e) => terminar(t, e));
    await registrar(c, ip, 'recupera de la papelera', l.info?.claves ?? [lote], l.objetos.length);
    return json(res, 200, { ok: true, trabajo: t.id });
  }

  // Vaciar un lote para siempre: con la contraseña y solo si lleva al menos un día en la papelera
  if (ruta === '/api/panel/papelera/vaciar') {
    const lote = loteValido(datos.lote);
    let ok = null;
    try { ok = await p.credenciales(c.usuario, datos.clave, ip); } catch (e) { if (e.status === 429) throw e; }
    if (!ok || ok.id !== c.id) throw error(403, 'Contraseña incorrecta');
    const l = (await lotes()).find((x) => x.lote === lote);
    if (!l) throw error(404, 'Ese lote ya no está en la papelera');
    const horas = (Date.now() - new Date(l.fecha).getTime()) / 3600000;
    if (horas < HORAS_ANTES_DE_VACIAR) {
      throw error(423, `Por seguridad, lo borrado no se puede eliminar del todo hasta que pasen ${HORAS_ANTES_DE_VACIAR} horas (faltan ${Math.ceil(HORAS_ANTES_DE_VACIAR - horas)}).`);
    }
    await borrarClaves([...l.objetos.map((o) => o.Key), ...(l.manifiesto ? [l.manifiesto] : [])]);
    console.log(`Panel: ${c.usuario} vacía de la papelera ${lote} (${l.objetos.length} objetos)`);
    await registrar(c, ip, 'elimina para siempre de la papelera', l.info?.claves ?? [lote], l.objetos.length);
    return json(res, 200, { ok: true });
  }

  // ---------- Subidas ----------
  if (ruta === '/api/panel/subir/iniciar' && datos.anuncio) {
    const ext = String(datos.nombre ?? '').match(/\.(mp4|m4v|webm|mov)$/i)?.[1]?.toLowerCase();
    if (!ext) throw error(400, 'El vídeo del anuncio tiene que ser .mp4, .webm o .mov (los que abre cualquier aparato)');
    const tamano = Number(datos.tamano);
    if (!(tamano > 0) || tamano > 2 * 1024 ** 3) throw error(400, 'El vídeo del anuncio puede ocupar como mucho 2 GB');
    const key = `_morvehtv/anuncios/${randomUUID()}.${ext}`;
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: TIPOS[ext] ?? 'video/mp4' }));
    console.log(`Panel: ${c.usuario} sube un vídeo de anuncio (${(tamano / 2 ** 20).toFixed(1)} MB)`);
    const tp = tamParteDe(tamano);
    return json(res, 200, { key, uploadId: UploadId, tamParte: tp, partes: Math.ceil(tamano / tp) });
  }
  if (ruta === '/api/panel/subir/iniciar') {
    const nombre = nombreValido(datos.nombre);
    if (!SUBIBLES.test(nombre)) throw error(400, 'Solo vídeos, subtítulos (.srt, .vtt, .ass) o imágenes');
    const key = carpetaValida(datos.carpeta) + nombre;
    if (!puede(key)) throw fuera();
    const tamano = Number(datos.tamano);
    if (!(tamano > 0) || tamano > TAM_PARTE * 10000) throw error(400, 'Tamaño no válido');
    if (await existe(key)) {
      if (!datos.reemplazar) return json(res, 409, { error: 'Ya existe un archivo con ese nombre en esta carpeta', existe: true });
      if (!admin) throw error(403, 'Ya existe un archivo con ese nombre: solo un administrador puede reemplazarlo');
      // El que se reemplaza va a la papelera (por si la subida nueva sale mal)
      const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      await esperarTrabajo(await aPapelera([{ Key: key, Size: h.ContentLength }], c, ip, 'reemplazado al subir', [key]));
    }
    const ext = key.match(/\.(\w+)$/)[1].toLowerCase();
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: TIPOS[ext] ?? 'application/octet-stream' }));
    const tp = tamParteDe(tamano);
    console.log(`Panel: ${c.usuario} sube ${key} (${(tamano / 2 ** 30).toFixed(2)} GB en trozos de ${tp / MB} MB)`);
    return json(res, 200, { key, uploadId: UploadId, tamParte: tp, partes: Math.ceil(tamano / tp) });
  }
  if (ruta.startsWith('/api/panel/subir/')) {
    const key = claveSubida(datos.key);
    if (!puede(key)) throw fuera();
    const uploadId = String(datos.uploadId ?? '');
    if (!uploadId) throw error(400, 'Falta la subida');
    if (ruta === '/api/panel/subir/partes') {
      const numeros = (Array.isArray(datos.numeros) ? datos.numeros : []).map(Number);
      if (!numeros.length || numeros.length > 200 || numeros.some((n) => !Number.isInteger(n) || n < 1 || n > 10000)) throw error(400, 'Partes no válidas');
      // Cada trozo, firmado para las dos direcciones del bucket (el panel reparte los trozos entre
      // ellas para tener el doble de conexiones a la vez)
      const urls = {}; const urls2 = {};
      for (const n of numeros) {
        const orden = () => new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n });
        urls[n] = await getSignedUrl(s3, orden(), { expiresIn: 6 * 3600 });
        if (s3Virtual) urls2[n] = await getSignedUrl(s3Virtual, orden(), { expiresIn: 6 * 3600 });
      }
      return json(res, 200, s3Virtual ? { urls, urls2 } : { urls });
    }
    if (ruta === '/api/panel/subir/completar') {
      const partes = (Array.isArray(datos.partes) ? datos.partes : [])
        .map((x) => ({ PartNumber: Number(x.n), ETag: String(x.etag ?? '') })).filter((x) => x.PartNumber > 0 && x.ETag)
        .sort((x, y) => x.PartNumber - y.PartNumber);
      if (!partes.length) throw error(400, 'Faltan las partes');
      await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: partes } }));
      console.log(`Panel: ${c.usuario} terminó ${key}`);
      await registrar(c, ip, 'sube', [key]);
      return json(res, 200, { ok: true, key });
    }
    if (ruta === '/api/panel/subir/cancelar') {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => {});
      return json(res, 200, { ok: true });
    }
  }
  throw error(404, 'No existe');
}
