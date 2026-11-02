// MorvehTV (visor de IDrive e2): un servidor local de solo lectura que lista el bucket y firma
// enlaces para ver cada archivo. Nunca escribe ni borra nada en e2.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as meta from './metadatos.js';
import * as acceso from './acceso.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Credenciales: el .env de esta carpeta o, si no existe, el de la API de MorvehTV
for (const f of [path.join(dir, '.env'), path.join(dir, '../fotograma/api/.env')]) {
  if (existsSync(f)) {
    process.loadEnvFile(f);
    break;
  }
}

const { E2_ENDPOINT, E2_REGION = 'us-east-1', E2_BUCKET, E2_ACCESS_KEY_ID, E2_SECRET_ACCESS_KEY } = process.env;
// Render da el puerto en PORT; en casa se usa el 4010
const PUERTO = Number(process.env.PORT || process.env.VISOR_PUERTO || 4010);

if (!(E2_ENDPOINT && E2_BUCKET && E2_ACCESS_KEY_ID && E2_SECRET_ACCESS_KEY)) {
  console.error('Faltan las variables E2_* — copia .env.example como .env y rellénalo.');
  process.exit(1);
}

await meta.iniciar(dir);
await acceso.iniciar(dir);

const s3 = new S3Client({
  endpoint: /^https?:\/\//.test(E2_ENDPOINT) ? E2_ENDPOINT : `https://${E2_ENDPOINT}`,
  region: E2_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: E2_ACCESS_KEY_ID, secretAccessKey: E2_SECRET_ACCESS_KEY },
});

const esVideo = (key) => /\.(mp4|m4v|webm|mov|mkv|ogv|avi|ts|wmv|flv)$/i.test(key);
const esImagen = (key) => /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(key);

function firmar(key, { segundos = 4 * 3600 } = {}) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: E2_BUCKET, Key: key }), { expiresIn: segundos });
}

const archivo = (o) => ({ key: o.Key, tamano: o.Size, fecha: o.LastModified });

// En internet nunca se enseñan las carpetas internas («_fotograma» guarda las cuentas de
// morvehtv.es y «_hls» las claves de los vídeos cifrados), ni con el botón «Ocultas»
const prohibido = (k) => acceso.NUBE && String(k ?? '').split('/').some((p) => p.startsWith('_'));

// Un nivel de carpeta: subcarpetas + archivos, paginado de 1000 en 1000
async function listarNivel(prefijo, token) {
  const r = await s3.send(
    new ListObjectsV2Command({ Bucket: E2_BUCKET, Prefix: prefijo, Delimiter: '/', ContinuationToken: token || undefined }),
  );
  const archivos = await Promise.all(
    (r.Contents ?? [])
      .filter((o) => !o.Key.endsWith('/') && !prohibido(o.Key))
      .map(async (o) => ({ ...archivo(o), ...(esImagen(o.Key) && { miniatura: await firmar(o.Key) }) })),
  );
  return {
    carpetas: (r.CommonPrefixes ?? []).map((p) => p.Prefix).filter((p) => !prohibido(p)),
    archivos,
    siguiente: r.IsTruncated ? r.NextContinuationToken : null,
  };
}

// Recorre todo lo que cuelga de un prefijo (para buscar y calcular tamaños)
async function* recorrer(prefijo) {
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: E2_BUCKET, Prefix: prefijo, ContinuationToken: token }));
    for (const o of r.Contents ?? []) yield o;
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
}

const normalizar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function buscar(prefijo, q) {
  const terminos = normalizar(q).split(/\s+/).filter(Boolean);
  const resultados = [];
  for await (const o of recorrer(prefijo)) {
    if (o.Key.endsWith('/') || prohibido(o.Key)) continue;
    const nombre = normalizar(o.Key.slice(prefijo.length));
    if (terminos.every((t) => nombre.includes(t))) {
      resultados.push({ ...archivo(o), ...(esImagen(o.Key) && { miniatura: await firmar(o.Key) }) });
      if (resultados.length >= 500) return { archivos: resultados, recortado: true };
    }
  }
  return { archivos: resultados, recortado: false };
}

async function tamano(prefijo) {
  let objetos = 0;
  let bytes = 0;
  for await (const o of recorrer(prefijo)) {
    if (o.Key.endsWith('/') || prohibido(o.Key)) continue;
    objetos++;
    bytes += o.Size;
  }
  return { objetos, bytes };
}

// Texto pequeño (txt, json, srt, vtt…) leído a través del servidor, máx. 2 MB
async function texto(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: E2_BUCKET, Key: key, Range: 'bytes=0-2097151' }));
  return { texto: await r.Body.transformToString('utf-8'), recortado: (r.ContentRange ?? '').split('/')[1] > 2097152 };
}

// ---------- Reproducción convertida con ffmpeg ----------
// Los .ts no tienen índice (no se puede saltar), muchos .mkv llevan audio AC3/DTS y el
// iPhone y las smart TV no abren .mkv. ffmpeg lee el archivo de e2 desde el segundo pedido y
// lo convierte al vuelo en HLS (el formato de streaming que entienden iPhone, Android y las
// teles), copiando el vídeo H.264 y pasando el audio a AAC.
const AUDIO_NATIVO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
const VIDEO_NATIVO = ['h264'];
const medios = new Map();

function medio(key) {
  if (!medios.has(key)) {
    const p = firmar(key).then(
      (url) =>
        new Promise((ok, mal) =>
          execFile(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height:stream_tags=language,title', '-of', 'json', url],
            { timeout: 60000 },
            (err, salida) => {
              if (err) return mal(new Error(`ffprobe no pudo leer el vídeo: ${err.message}`));
              const d = JSON.parse(salida);
              const pistas = d.streams ?? [];
              const video = pistas.find((s) => s.codec_type === 'video');
              ok({
                duracion: Number(d.format?.duration) || 0,
                video: video?.codec_name ?? null,
                resolucion: video?.width ? `${video.width}×${video.height}` : null,
                subtitulos: pistas
                  .filter((s) => s.codec_type === 'subtitle')
                  .map((s) => ({ codec: s.codec_name, idioma: s.tags?.language ?? '', titulo: s.tags?.title ?? '' })),
                audios: pistas
                  .filter((s) => s.codec_type === 'audio')
                  .map((s) => ({ codec: s.codec_name, idioma: s.tags?.language ?? '', titulo: s.tags?.title ?? '' })),
              });
            },
          ),
        ),
    );
    p.catch(() => medios.delete(key));
    medios.set(key, p);
  }
  return medios.get(key);
}

// Cada sesión es un ffmpeg escribiendo trozos de 4 s en una carpeta temporal. Lee a 3× la
// velocidad normal (no descarga la película entera de golpe) y se borra al cerrar el vídeo
// o tras 10 minutos sin que nadie pida nada. Si una pausa dura más, el reproductor prepara
// otra sesión desde el mismo segundo al reanudar.
const DIR_HLS = path.join(os.tmpdir(), 'morvehtv-hls');
// -readrate_initial_burst solo existe desde ffmpeg 6.1; el ffmpeg de Render puede ser anterior
const ayudaFfmpeg = await new Promise((ok) => execFile('ffmpeg', ['-hide_banner', '-h', 'full'], { maxBuffer: 1e8 }, (e, out) => ok(out || '')));
const RAFAGA = ayudaFfmpeg.includes('readrate_initial_burst') ? ['-readrate_initial_burst', '30'] : [];
const sesionesHls = new Map(); // id → { ff, carpeta, ultimo, errores }
await rm(DIR_HLS, { recursive: true, force: true });

async function hlsIniciar(p) {
  const key = p.get('key');
  const desde = Math.max(0, Math.floor(Number(p.get('desde')) || 0));
  const info = await medio(key);
  const audio = Math.min(Math.max(0, Number(p.get('audio')) || 0), Math.max(0, info.audios.length - 1));
  const url = await firmar(key, { segundos: 12 * 3600 });
  const id = randomUUID();
  const carpeta = path.join(DIR_HLS, id);
  await mkdir(carpeta, { recursive: true });
  const args = [
    // -multiple_requests reutiliza la conexión con e2 al buscar el minuto (salta el doble de rápido)
    // -reconnect…: si e2 corta la conexión a mitad de película, ffmpeg la retoma donde iba
    '-v', 'error', '-readrate', '3', ...RAFAGA, '-multiple_requests', '1',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10',
    '-ss', String(desde), '-i', url,
    '-map', '0:v:0', ...(info.audios.length ? ['-map', `0:a:${audio}`] : []),
    ...(VIDEO_NATIVO.includes(info.video)
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '96']),
    ...(info.audios[audio]?.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '192k']),
    '-sn',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(carpeta, 's%05d.ts'), path.join(carpeta, 'index.m3u8'),
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const sesion = { ff, carpeta, ultimo: Date.now(), errores: '' };
  sesionesHls.set(id, sesion);
  ff.stderr.on('data', (d) => (sesion.errores = (sesion.errores + d).slice(-2000)));
  ff.on('close', (code) => code && sesion.errores && console.error(`ffmpeg (${key} @${desde}s): ${sesion.errores.trim().slice(-300)}`));

  // Espera a que la lista cubra los segundos pedidos («margen»: el cliente empieza un poco
  // antes del punto elegido para poder retroceder sin volver a preparar)
  const margen = Math.min(30, Math.max(0, Number(p.get('margen')) || 0));
  for (let i = 0; i < 150; i++) {
    const lista = await readFile(path.join(carpeta, 'index.m3u8'), 'utf8').catch(() => '');
    const preparado = [...lista.matchAll(/#EXTINF:([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    if (preparado > 0 && (preparado >= margen + 2 || ff.exitCode !== null)) return { id, url: `/hls/${id}/index.m3u8`, desde };
    if (ff.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const motivo = sesion.errores.trim().split('\n').pop();
  hlsParar(id);
  throw new Error(`No se pudo preparar el vídeo${motivo ? `: ${motivo}` : ''}`);
}

function hlsParar(id) {
  const s = sesionesHls.get(id);
  if (!s) return { ok: true };
  sesionesHls.delete(id);
  s.ff.kill('SIGKILL');
  setTimeout(() => rm(s.carpeta, { recursive: true, force: true }).catch(() => {}), 1000);
  return { ok: true };
}

setInterval(() => {
  for (const [id, s] of sesionesHls) if (Date.now() - s.ultimo > 10 * 60000) hlsParar(id);
}, 60000).unref();

async function hlsServir(res, id, archivo) {
  const s = sesionesHls.get(id);
  if (!s || !/^[\w.]+\.(m3u8|ts)$/.test(archivo)) throw Object.assign(new Error('Sesión de vídeo caducada'), { status: 404 });
  s.ultimo = Date.now();
  const cuerpo = await readFile(path.join(s.carpeta, archivo));
  res.writeHead(200, {
    'content-type': archivo.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    'cache-control': 'no-store',
  });
  res.end(cuerpo);
}

// ---------- Avisos de contenido nuevo ----------
// Cada pocos segundos repasa el bucket entero y, si aparece, cambia o desaparece algo, avisa
// a las pestañas abiertas (Server-Sent Events) para que se actualicen solas. Las carpetas
// internas («_hls», «_fotograma»…) no cuentan: el catálogo de MorvehTV cambia a menudo.
const SEGUNDOS_ESCANEO = Math.max(5, Number(process.env.VISOR_ESCANEO_SEGUNDOS) || 20);
const oyentes = new Set();
let foto = null; // key → "tamaño:fecha" del último repaso

const esInterna = (key) => key.split('/').some((p) => p.startsWith('_'));

function avisar(evento, datos) {
  const msg = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
  for (const res of oyentes) res.write(msg);
}

async function repasar() {
  const ahora = new Map();
  for await (const o of recorrer('')) {
    if (!esInterna(o.Key)) ahora.set(o.Key, `${o.Size}:${o.LastModified?.getTime()}`);
  }
  if (foto) {
    const nuevos = [...ahora.keys()].filter((k) => !foto.has(k));
    const cambiados = [...ahora.keys()].filter((k) => foto.has(k) && foto.get(k) !== ahora.get(k));
    const borrados = [...foto.keys()].filter((k) => !ahora.has(k));
    if (nuevos.length || cambiados.length || borrados.length) {
      console.log(`Cambios en e2: ${nuevos.length} nuevos, ${cambiados.length} cambiados, ${borrados.length} borrados`);
      // Busca ya los metadatos de los vídeos nuevos para que lleguen con su carátula
      for (const k of nuevos.filter((k) => esVideo(k))) await meta.deArchivo(k).catch(() => {});
      avisar('cambios', { nuevos, cambiados, borrados });
    }
  }
  foto = ahora;
}

async function vigilar() {
  try {
    await repasar();
  } catch (err) {
    console.error(`No se pudo repasar el bucket: ${err.message}`);
  }
  setTimeout(vigilar, SEGUNDOS_ESCANEO * 1000);
}

function eventos(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  oyentes.add(res);
  const latido = setInterval(() => res.write(': latido\n\n'), 25000);
  res.on('close', () => { clearInterval(latido); oyentes.delete(res); });
}

const rutas = {
  '/api/meta': (p) => meta.deArchivo(p.get('key')),
  '/api/meta-carpeta': (p) => meta.deCarpeta(p.get('prefijo')),
  '/api/tmdb-buscar': (p) => meta.buscar(p.get('q'), p.get('tipo') || undefined),
  '/api/corregir': (p) => meta.corregir(meta.claveDe(p.get('key')), p.get('tmdbId'), p.get('tipo')),
  '/api/hls': (p) => hlsIniciar(p),
  '/api/hls-parar': (p) => hlsParar(p.get('id')),
  '/api/red': (p, req) => ({
    urls: acceso.direcciones(PUERTO),
    // El PIN solo se enseña en el propio ordenador
    pin: acceso.esLocal(req) ? acceso.elPin() : null,
  }),
  '/api/medio': async (p) => ({ ...(await medio(p.get('key'))), audioNativo: AUDIO_NATIVO, videoNativo: VIDEO_NATIVO }),
  '/api/info': () => ({ bucket: E2_BUCKET }),
  '/api/listar': (p) => listarNivel(p.get('prefijo') ?? '', p.get('token')),
  '/api/buscar': (p) => buscar(p.get('prefijo') ?? '', p.get('q') ?? ''),
  '/api/tamano': (p) => tamano(p.get('prefijo') ?? ''),
  '/api/url': async (p) => ({ url: await firmar(p.get('key')) }),
  '/api/texto': (p) => texto(p.get('key')),
};

const tipos = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
// Librerías servidas desde node_modules (sin depender de internet ni de un CDN)
const VENDOR = {
  '/vendor/hls.min.js': 'node_modules/hls.js/dist/hls.min.js',
  '/vendor/qrcode.js': 'node_modules/qrcode-generator/qrcode.js',
};

// El JavaScript de la app se rebaja a una versión que entienden las smart TV de 2017 en
// adelante (Tizen 4 / webOS 4 ≈ Chrome 56) y los iPhone con iOS 12
const compilados = new Map();
async function js(fichero) {
  const { mtimeMs } = await stat(fichero);
  const c = compilados.get(fichero);
  if (c?.mtimeMs === mtimeMs) return c.codigo;
  const { code } = await transform(await readFile(fichero, 'utf8'), { target: ['chrome56', 'safari12'], loader: 'js' });
  compilados.set(fichero, { mtimeMs, codigo: code });
  return code;
}

// Hora a la que arrancó el servidor (para saber si Render ya ha cargado la última versión)
const ARRANQUE = new Date().toISOString();

const json = (res, status, datos) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(datos));
};

// Lo que se puede abrir sin haber puesto el PIN: la pantalla para ponerlo y los iconos
const PUBLICO = ['/entrar.html', '/manifest.webmanifest', '/icono-192.png', '/icono-512.png', '/icono.svg', '/api/modo', '/api/salud'];

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const permiso = acceso.permiso(req);
      if (permiso === 'fuera') return json(res, 403, { error: 'Solo se puede entrar desde la red de casa' });
      if (url.pathname === '/api/entrar' && req.method === 'POST') return await acceso.entrar(req, res);
      // Para la pantalla de entrada (¿PIN o contraseña?) y para que Render sepa que está viva
      if (url.pathname === '/api/modo') return json(res, 200, { nube: acceso.NUBE });
      if (url.pathname === '/api/salud') return json(res, 200, { ok: true, arranque: ARRANQUE });
      if (permiso === 'pin' && !PUBLICO.includes(url.pathname)) {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hls/')) return json(res, 401, { error: 'Falta el PIN' });
        res.writeHead(302, { location: '/entrar.html' });
        return res.end();
      }

      if (url.pathname === '/api/eventos') return eventos(req, res);
      const hls = url.pathname.match(/^\/hls\/([\w-]+)\/([^/]+)$/);
      if (hls) return await hlsServir(res, hls[1], hls[2]);
      const ruta = rutas[url.pathname];
      if (ruta && (prohibido(url.searchParams.get('key')) || prohibido(url.searchParams.get('prefijo')))) {
        return json(res, 403, { error: 'Esta carpeta no se puede ver desde internet' });
      }
      if (ruta) return json(res, 200, await ruta(url.searchParams, req));

      if (VENDOR[url.pathname]) {
        res.writeHead(200, { 'content-type': tipos['.js'], 'cache-control': 'max-age=86400' });
        return res.end(await readFile(path.join(dir, VENDOR[url.pathname])));
      }
      const fichero = path.join(dir, 'public', url.pathname === '/' ? 'index.html' : path.normalize(decodeURIComponent(url.pathname)));
      if (!fichero.startsWith(path.join(dir, 'public'))) throw Object.assign(new Error('No'), { status: 403 });
      const ext = path.extname(fichero);
      const cuerpo = ext === '.js' ? await js(fichero) : await readFile(fichero);
      res.writeHead(200, { 'content-type': tipos[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(cuerpo);
    } catch (err) {
      json(res, err.status ?? (err.code === 'ENOENT' ? 404 : err.$metadata?.httpStatusCode ?? 500), { error: err.message });
    }
  })
  // Escucha en la red de casa para que entren el móvil y la tele (con PIN); con
  // VISOR_SOLO_LOCAL=1 solo se puede usar desde este ordenador
  .listen(PUERTO, process.env.VISOR_SOLO_LOCAL === '1' && !acceso.NUBE ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(`MorvehTV (bucket "${E2_BUCKET}") en http://localhost:${PUERTO}${acceso.NUBE ? ' (modo nube: entra con VISOR_CLAVE)' : ''}`);
    if (process.env.VISOR_SOLO_LOCAL !== '1' && !acceso.NUBE) {
      for (const u of acceso.direcciones(PUERTO)) console.log(`  En el móvil o la tele (misma wifi): ${u}`);
      console.log(`  PIN para otros dispositivos: ${acceso.elPin()}`);
    }
    vigilar();
  });
