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
import * as meta from './metadatos.js';

const TAM_PARTE = 32 * 1024 * 1024; // subidas: 32 MB por trozo, hasta ~320 GB
const TAM_COPIA = 1024 ** 3; // copias de más de 5 GB: por trozos de 1 GB
const SUBIBLES = /\.(mp4|m4v|mkv|webm|mov|avi|ts|wmv|flv|srt|vtt|ass|jpg|jpeg|png|webp)$/i;
const TIPOS = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', ts: 'video/mp2t', srt: 'text/plain; charset=utf-8', vtt: 'text/vtt', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
// Webs desde las que se puede usar (además, en casa, cualquier localhost para probar)
const ORIGENES = String(process.env.PANEL_ORIGENES ?? 'https://saitamaeditor.github.io').split(',').map((o) => o.trim()).filter(Boolean);

let s3; let bucket; let foto; let nube; let p; let alMover = () => {};
export function iniciar(opciones) {
  ({ s3, bucket, foto, nube, perfiles: p } = opciones);
  alMover = opciones.alMover ?? alMover;
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
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
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
    if (!(await p.esAdmin(c))) throw error(403, 'Esta cuenta no es administradora');
    await registrar(c, ip, 'entra en el gestor');
    return json(res, 200, { token: await p.tokenPanel(c), usuario: c.usuario, nombre: c.nombre });
  }

  const c = await p.cuentaDeToken(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (!c) throw error(401, 'La sesión ha caducado: vuelve a entrar');
  if (!(await p.esAdmin(c))) throw error(403, 'Esta cuenta no es administradora');

  if (ruta === '/api/panel/yo') return json(res, 200, { usuario: c.usuario, nombre: c.nombre });

  // Contenido de una carpeta (sus subcarpetas y sus archivos)
  if (ruta === '/api/panel/listar') {
    const prefijo = carpetaValida(url.searchParams.get('prefijo') ?? '', { raiz: true });
    const carpetas = new Set(); const archivos = [];
    let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefijo, Delimiter: '/', ContinuationToken: token }));
      for (const x of r.CommonPrefixes ?? []) if (!interna(x.Prefix)) carpetas.add(x.Prefix);
      for (const o of r.Contents ?? []) {
        if (o.Key === prefijo || interna(o.Key)) continue;
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
    const lista = [...secciones.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return json(res, 200, { secciones: lista, archivos: lista.reduce((t, x) => t + x.archivos, 0), tamano: lista.reduce((t, x) => t + x.tamano, 0) });
  }

  // Enlace para ver o descargar un archivo (1 hora)
  if (ruta === '/api/panel/enlace') {
    const key = claveValida(url.searchParams.get('key'));
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

  // Elegir el título antes de subirlo: buscar por nombre o IMDb y su ficha con los capítulos
  if (ruta === '/api/panel/titulos') {
    const q = String(url.searchParams.get('q') ?? '').trim();
    if (q.length < 2) return json(res, 200, []);
    return json(res, 200, await meta.buscarParaSubir(q));
  }
  if (ruta === '/api/panel/titulo') return json(res, 200, await meta.fichaParaSubir(url.searchParams.get('tipo'), url.searchParams.get('id')));

  if (req.method !== 'POST') throw error(405, 'Método no permitido');

  // Deja apuntado qué título de TMDB es una película o una carpeta de serie (así la app no tiene
  // que adivinarlo por el nombre)
  if (ruta === '/api/panel/vincular') {
    const clave = claveValida(datos.clave);
    return json(res, 200, meta.corregir(clave, Number(datos.tmdbId), datos.tipo));
  }

  // Crear carpetas (una o varias: «SERIES/Nueva/Temporada 1/»…)
  if (ruta === '/api/panel/carpeta') {
    const lista = (Array.isArray(datos.carpetas) ? datos.carpetas : [datos.carpeta]).map((x) => carpetaValida(x));
    if (!lista.length || lista.length > 100) throw error(400, 'Carpetas no válidas');
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
  if (ruta === '/api/panel/subir/iniciar') {
    const nombre = nombreValido(datos.nombre);
    if (!SUBIBLES.test(nombre)) throw error(400, 'Solo vídeos, subtítulos (.srt, .vtt, .ass) o imágenes');
    const key = carpetaValida(datos.carpeta) + nombre;
    const tamano = Number(datos.tamano);
    if (!(tamano > 0) || tamano > TAM_PARTE * 10000) throw error(400, 'Tamaño no válido');
    if (await existe(key)) {
      if (!datos.reemplazar) return json(res, 409, { error: 'Ya existe un archivo con ese nombre en esta carpeta', existe: true });
      // El que se reemplaza va a la papelera (por si la subida nueva sale mal)
      const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      await esperarTrabajo(await aPapelera([{ Key: key, Size: h.ContentLength }], c, ip, 'reemplazado al subir', [key]));
    }
    const ext = key.match(/\.(\w+)$/)[1].toLowerCase();
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: TIPOS[ext] ?? 'application/octet-stream' }));
    console.log(`Panel: ${c.usuario} sube ${key} (${(tamano / 2 ** 30).toFixed(2)} GB)`);
    return json(res, 200, { key, uploadId: UploadId, tamParte: TAM_PARTE, partes: Math.ceil(tamano / TAM_PARTE) });
  }
  if (ruta.startsWith('/api/panel/subir/')) {
    const key = claveValida(datos.key);
    const uploadId = String(datos.uploadId ?? '');
    if (!uploadId) throw error(400, 'Falta la subida');
    if (ruta === '/api/panel/subir/partes') {
      const numeros = (Array.isArray(datos.numeros) ? datos.numeros : []).map(Number);
      if (!numeros.length || numeros.length > 100 || numeros.some((n) => !Number.isInteger(n) || n < 1 || n > 10000)) throw error(400, 'Partes no válidas');
      const urls = {};
      for (const n of numeros) urls[n] = await getSignedUrl(s3, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n }), { expiresIn: 6 * 3600 });
      return json(res, 200, { urls });
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
