// Panel de subida (subir.html), solo para administradores: el navegador sube el archivo directo
// a e2 por trozos, cada uno con su enlace firmado; el servidor solo abre, firma y cierra la
// subida. Así no hay límite de tamaño ni el vídeo pasa por Render. (El bucket tiene que aceptar
// peticiones PUT desde la web en sus reglas CORS y dejar leer la cabecera ETag.)
// Nunca se puede subir a las carpetas internas («_morvehtv», «_fotograma»…).
import {
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  HeadObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const TAM_PARTE = 32 * 1024 * 1024; // 32 MB: hasta ~320 GB con las 10.000 partes que admite S3
const EXTENSIONES = /\.(mp4|m4v|mkv|webm|mov|avi|ts|wmv|flv|srt|vtt|ass|jpg|jpeg|png|webp)$/i;
const TIPOS = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', ts: 'video/mp2t', srt: 'text/plain; charset=utf-8', vtt: 'text/vtt', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

let s3; let bucket; let foto; let sesion; let esAdmin;
export function iniciar(opciones) {
  ({ s3, bucket, foto, sesion, esAdmin } = opciones);
}

export const RUTAS = ['/api/subir/carpetas', '/api/subir/carpeta', '/api/subir/iniciar', '/api/subir/partes', '/api/subir/completar', '/api/subir/cancelar'];

const error = (status, message) => Object.assign(new Error(message), { status });

// Carpeta de destino: «SERIES/» o «SERIES/Nombre/Temporada 1/». Nada interno ni raro
function carpetaValida(c) {
  const carpeta = String(c ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
  const partes = carpeta.replace(/\/$/, '').split('/');
  if (!carpeta.endsWith('/') || carpeta.length > 700 || partes.some((p) => !p.trim() || p.startsWith('_') || p.startsWith('.') || p !== p.trim() || /[\u0000-\u001f]/.test(p))) {
    throw error(400, 'Carpeta no válida');
  }
  return carpeta;
}
function nombreValido(n) {
  const nombre = String(n ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
  if (!nombre || nombre.startsWith('.') || nombre.length > 200) throw error(400, 'Nombre de archivo no válido');
  if (!EXTENSIONES.test(nombre)) throw error(400, 'Solo vídeos, subtítulos (.srt, .vtt, .ass) o imágenes');
  return nombre;
}
// La clave tiene que ser una de las que este panel puede tocar
function claveValida(k) {
  const key = String(k ?? '');
  carpetaValida(key.slice(0, key.lastIndexOf('/') + 1));
  nombreValido(key.slice(key.lastIndexOf('/') + 1));
  return key;
}

async function cuerpo(req) {
  let t = '';
  for await (const trozo of req) {
    t += trozo;
    if (t.length > 200000) throw error(413, 'Demasiado grande');
  }
  return t ? JSON.parse(t) : {};
}

const existe = (key) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(() => true, (e) => {
  if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
  throw e;
});

export async function atender(ruta, req, res, json) {
  const c = await sesion(req);
  if (!c) throw error(401, 'Inicia sesión');
  if (!(await esAdmin(c))) throw error(403, 'Tu cuenta no puede subir contenido');

  // Las secciones y todas sus subcarpetas (para elegir serie y temporada)
  if (ruta === '/api/subir/carpetas') {
    const carpetas = new Set();
    for (const key of (await foto()).keys()) {
      const partes = key.split('/');
      for (let i = 1; i < partes.length; i++) carpetas.add(`${partes.slice(0, i).join('/')}/`);
    }
    const lista = [...carpetas].filter((k) => !k.split('/').some((p) => p.startsWith('_'))).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    return json(res, 200, { carpetas: lista, tamParte: TAM_PARTE });
  }
  if (req.method !== 'POST') throw error(405, 'Método no permitido');
  const d = await cuerpo(req);

  // Crear una carpeta vacía (una categoría nueva, una serie o una temporada)
  if (ruta === '/api/subir/carpeta') {
    const carpeta = carpetaValida(d.carpeta);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: carpeta, Body: '' }));
    console.log(`Subidas: carpeta creada por ${c.usuario}: ${carpeta}`);
    return json(res, 200, { carpeta });
  }

  if (ruta === '/api/subir/iniciar') {
    const key = carpetaValida(d.carpeta) + nombreValido(d.nombre);
    const tamano = Number(d.tamano);
    if (!(tamano > 0) || tamano > TAM_PARTE * 10000) throw error(400, 'Tamaño no válido');
    if (!d.reemplazar && await existe(key)) return json(res, 409, { error: 'Ya existe un archivo con ese nombre en esa carpeta', existe: true });
    const ext = key.match(/\.(\w+)$/)[1].toLowerCase();
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: TIPOS[ext] ?? 'application/octet-stream' }));
    console.log(`Subidas: ${c.usuario} empieza ${key} (${(tamano / 2 ** 30).toFixed(2)} GB)`);
    return json(res, 200, { key, uploadId: UploadId, tamParte: TAM_PARTE, partes: Math.ceil(tamano / TAM_PARTE) });
  }

  const key = claveValida(d.key);
  const uploadId = String(d.uploadId ?? '');
  if (!uploadId) throw error(400, 'Falta la subida');

  // Enlaces firmados para subir unos trozos (se piden por tandas, válidos 6 horas)
  if (ruta === '/api/subir/partes') {
    const numeros = (Array.isArray(d.numeros) ? d.numeros : []).map(Number);
    if (!numeros.length || numeros.length > 100 || numeros.some((n) => !Number.isInteger(n) || n < 1 || n > 10000)) throw error(400, 'Partes no válidas');
    const urls = {};
    for (const n of numeros) {
      urls[n] = await getSignedUrl(s3, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n }), { expiresIn: 6 * 3600 });
    }
    return json(res, 200, { urls });
  }

  if (ruta === '/api/subir/completar') {
    const partes = (Array.isArray(d.partes) ? d.partes : [])
      .map((p) => ({ PartNumber: Number(p.n), ETag: String(p.etag ?? '') }))
      .filter((p) => p.PartNumber > 0 && p.ETag)
      .sort((a, b) => a.PartNumber - b.PartNumber);
    if (!partes.length) throw error(400, 'Faltan las partes');
    await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: partes } }));
    console.log(`Subidas: ${c.usuario} terminó ${key}`);
    return json(res, 200, { ok: true, key });
  }

  if (ruta === '/api/subir/cancelar') {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => {});
    console.log(`Subidas: ${c.usuario} canceló ${key}`);
    return json(res, 200, { ok: true });
  }
  throw error(404, 'No existe');
}
