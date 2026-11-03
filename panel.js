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

  if (req.method !== 'POST') throw error(405, 'Método no permitido');

  // Crear carpetas (una o varias: «SERIES/Nueva/Temporada 1/»…)
  if (ruta === '/api/panel/carpeta') {
    const lista = (Array.isArray(datos.carpetas) ? datos.carpetas : [datos.carpeta]).map((x) => carpetaValida(x));
    if (!lista.length || lista.length > 100) throw error(400, 'Carpetas no válidas');
    for (const x of lista) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: x, Body: '' }));
    console.log(`Panel: ${c.usuario} crea ${lista.join(', ')}`);
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
    alMover(origen.map((o) => destino(o.Key)));
    for (const o of origen) await copiar(o.Key, destino(o.Key), o.Size);
    await borrarClaves(origen.map((o) => o.Key));
    console.log(`Panel: ${c.usuario} mueve ${de} → ${a} (${origen.length})`);
    return json(res, 200, { ok: true, movidos: origen.length });
  }

  // Borrar archivos o carpetas enteras (no se puede deshacer: lo confirma la web antes)
  if (ruta === '/api/panel/borrar') {
    const claves = (Array.isArray(datos.claves) ? datos.claves : []).map(claveValida);
    if (!claves.length || claves.length > 500) throw error(400, 'Nada que borrar');
    const lista = new Set();
    for (const k of claves) {
      if (k.endsWith('/')) (await todos(k)).forEach((o) => lista.add(o.Key));
      lista.add(k);
    }
    await borrarClaves([...lista]);
    console.log(`Panel: ${c.usuario} borra ${claves.join(', ')} (${lista.size} objetos)`);
    return json(res, 200, { ok: true, borrados: lista.size });
  }

  // ---------- Subidas ----------
  if (ruta === '/api/panel/subir/iniciar') {
    const nombre = nombreValido(datos.nombre);
    if (!SUBIBLES.test(nombre)) throw error(400, 'Solo vídeos, subtítulos (.srt, .vtt, .ass) o imágenes');
    const key = carpetaValida(datos.carpeta) + nombre;
    const tamano = Number(datos.tamano);
    if (!(tamano > 0) || tamano > TAM_PARTE * 10000) throw error(400, 'Tamaño no válido');
    if (!datos.reemplazar && await existe(key)) return json(res, 409, { error: 'Ya existe un archivo con ese nombre en esta carpeta', existe: true });
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
      return json(res, 200, { ok: true, key });
    }
    if (ruta === '/api/panel/subir/cancelar') {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => {});
      return json(res, 200, { ok: true });
    }
  }
  throw error(404, 'No existe');
}
