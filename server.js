// MorvehTV (visor de IDrive e2): un servidor que lista el bucket y firma enlaces para ver cada
// archivo. Nunca escribe ni borra vídeos en e2: lo único que escribe es el archivo oculto de
// cuentas (_morvehtv/usuarios.json, ver perfiles.js). Sin sesión solo se ve entrar.html.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as meta from './metadatos.js';
import * as acceso from './acceso.js';
import * as perfiles from './perfiles.js';
import * as telegram from './telegram.js';
import * as xtream from './xtream.js';
import * as panel from './panel.js';
import * as defensa from './defensa.js';
import * as pagos from './pagos.js';

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

const s3 = new S3Client({
  endpoint: /^https?:\/\//.test(E2_ENDPOINT) ? E2_ENDPOINT : `https://${E2_ENDPOINT}`,
  region: E2_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: E2_ACCESS_KEY_ID, secretAccessKey: E2_SECRET_ACCESS_KEY },
});
perfiles.iniciar(s3, E2_BUCKET, acceso.NUBE);
// Render apaga el servidor a menudo: antes se guarda el progreso pendiente de cada perfil
for (const senal of ['SIGTERM', 'SIGINT']) {
  process.once(senal, () => perfiles.guardarPendiente().finally(() => process.exit(0)));
}

const esVideo = (key) => /\.(mp4|m4v|webm|mov|mkv|ogv|avi|ts|wmv|flv)$/i.test(key);
// Avisos de lo nuevo en Telegram, con un tema por sección (ver telegram.js)
await telegram.iniciar({ nube: acceso.NUBE, esVideo, leer: perfiles.leerAjuste, guardar: perfiles.guardarAjuste });
// Reproductores externos tipo Xtream Codes (ver xtream.js): usan la foto del último repaso
pagos.iniciar({ perfiles, firmar: (k, o) => firmar(k, o) });
xtream.iniciar({ foto: async () => { if (!foto) await repasar(); return foto; }, firmar, esVideo, credenciales: perfiles.credenciales, esAdmin: perfiles.esAdmin,
  permitido: async (c) => !pagos.activo || (await perfiles.planDe(c)).tipo === 'premium' });
// API del panel de gestión (otra web: «MorvehTV Gestor»), solo administradores (ver panel.js)
panel.iniciar({ s3, bucket: E2_BUCKET, nube: acceso.NUBE, perfiles, foto: async () => { if (!foto) await repasar(); return foto; }, alMover: telegram.ignorar, pagosEstado: () => pagos.estado });
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

// Una carpeta con todo junto: las subcarpetas que solo agrupan («PELICULAS NETFLIX»,
// «NETFLIX»…) no salen como carpetas, sale su contenido directamente. En la raíz no: allí
// cada carpeta es una categoría. Solo en la primera página (las siguientes son de la propia
// carpeta) y con tope, por si alguien anida muchísimas.
// ---------- Listados desde la memoria ----------
// Con mucho contenido, pedirle a e2 cada carpeta en cada visita es lo que más carga: aquí se
// sacan de la foto del último repaso (en memoria, al día cada pocos segundos) y se guardan
// hechos hasta que cambia algo. Se entregan por páginas para no mandar miles de golpe.
const POR_PAGINA = 200;
const listadosHechos = new Map(); // `${huella}|${prefijo}` → { carpetas, archivos }
function nivelDeFoto(prefijo) {
  const carpetas = new Set();
  const archivos = [];
  for (const [key, v] of foto) {
    if (key.length <= prefijo.length || !key.startsWith(prefijo)) continue;
    const resto = key.slice(prefijo.length);
    const i = resto.indexOf('/');
    if (i >= 0) carpetas.add(prefijo + resto.slice(0, i + 1));
    else {
      const [t, ms] = v.split(':');
      archivos.push({ key, tamano: Number(t), fecha: new Date(Number(ms)) });
    }
  }
  return { carpetas: [...carpetas], archivos };
}
// Intl.Collator es mucho más rápido que localeCompare con decenas de miles de nombres
const colador = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
const ordenClaves = colador.compare;
function juntoDeFoto(prefijo) {
  const id = `${huella}|${prefijo}`;
  if (listadosHechos.has(id)) return listadosHechos.get(id);
  const r = nivelDeFoto(prefijo);
  // Igual que listarJunto: las carpetas que solo agrupan enseñan su contenido directamente
  if (prefijo) {
    const pendientes = r.carpetas.filter((c) => meta.esAgrupadora(nombreDe(c)));
    r.carpetas = r.carpetas.filter((c) => !meta.esAgrupadora(nombreDe(c)));
    for (let vistas = 0; pendientes.length && vistas < 200; vistas++) {
      const s = nivelDeFoto(pendientes.shift());
      r.archivos.push(...s.archivos);
      for (const sub of s.carpetas) (meta.esAgrupadora(nombreDe(sub)) ? pendientes : r.carpetas).push(sub);
    }
    r.carpetas.push(...pendientes);
  }
  r.carpetas.sort(ordenClaves);
  r.archivos.sort((a, b) => ordenClaves(a.key, b.key));
  if (listadosHechos.size > 400) listadosHechos.clear();
  listadosHechos.set(id, r);
  return r;
}
async function listar(prefijo, token) {
  // Sin foto todavía (recién arrancado) o en carpetas internas (en casa), como siempre: a e2
  if (!foto || esInterna(prefijo)) return listarJunto(prefijo, token);
  const r = juntoDeFoto(prefijo);
  // Carpetas y archivos van seguidos en las mismas páginas (una sección con mil series tampoco
  // se manda de golpe)
  const desde = Math.max(0, Number(token) || 0);
  const total = r.carpetas.length + r.archivos.length;
  const carpetas = r.carpetas.slice(desde, desde + POR_PAGINA);
  const pagina = r.archivos.slice(Math.max(0, desde - r.carpetas.length), desde + POR_PAGINA - r.carpetas.length);
  return {
    carpetas,
    archivos: await Promise.all(pagina.map(async (o) => ({ ...o, ...(esImagen(o.key) && { miniatura: await firmar(o.key) }) }))),
    siguiente: desde + POR_PAGINA < total ? String(desde + POR_PAGINA) : null,
    total,
  };
}

async function listarJunto(prefijo, token) {
  const r = await listarNivel(prefijo, token);
  if (!prefijo || token) return r;
  const pendientes = r.carpetas.filter((c) => meta.esAgrupadora(nombreDe(c)));
  r.carpetas = r.carpetas.filter((c) => !meta.esAgrupadora(nombreDe(c)));
  for (let vistas = 0; pendientes.length && vistas < 40; vistas++) {
    const c = pendientes.shift();
    let t = null;
    do {
      const s = await listarNivel(c, t);
      r.archivos.push(...s.archivos);
      for (const sub of s.carpetas) (meta.esAgrupadora(nombreDe(sub)) ? pendientes : r.carpetas).push(sub);
      t = s.siguiente;
    } while (t);
  }
  r.carpetas.push(...pendientes); // lo que pase del tope sale como carpeta: nada se esconde
  return r;
}
const nombreDe = (k) => k.replace(/\/$/, '').split('/').pop();

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

// Buscar y contar desde la foto en memoria (sin recorrer e2). Con «azar=N» devuelve N vídeos
// al azar de esa carpeta (la portada los usa para elegir carteles)
async function buscar(prefijo, q, azar) {
  if (foto && !esInterna(prefijo)) {
    if (azar) {
      const videos = [...foto.keys()].filter((k) => k.startsWith(prefijo) && esVideo(k));
      const elegidos = [];
      for (let i = 0; i < Math.min(azar, videos.length); i++) elegidos.push(...videos.splice(Math.floor(Math.random() * videos.length), 1));
      return { archivos: elegidos.map((key) => ({ key, ...datosFoto(key) })), recortado: false };
    }
    const terminos = normalizar(q).split(/\s+/).filter(Boolean);
    const resultados = [];
    for (const key of foto.keys()) {
      if (!key.startsWith(prefijo) || key.endsWith('/')) continue;
      if (!terminos.every((t) => normalizar(key.slice(prefijo.length)).includes(t))) continue;
      resultados.push({ key, ...datosFoto(key), ...(esImagen(key) && { miniatura: await firmar(key) }) });
      if (resultados.length >= 500) return { archivos: resultados, recortado: true };
    }
    return { archivos: resultados, recortado: false };
  }
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

const datosFoto = (key) => { const [t, ms] = foto.get(key).split(':'); return { tamano: Number(t), fecha: new Date(Number(ms)) }; };
const tamanosHechos = new Map(); // `${huella}|${prefijo}` → { objetos, bytes }
async function tamano(prefijo) {
  if (foto && !esInterna(prefijo)) {
    const id = `${huella}|${prefijo}`;
    if (!tamanosHechos.has(id)) {
      let objetos = 0; let bytes = 0;
      for (const [key, v] of foto) if (key.startsWith(prefijo) && !key.endsWith('/')) { objetos++; bytes += Number(v.split(':')[0]); }
      if (tamanosHechos.size > 400) tamanosHechos.clear();
      tamanosHechos.set(id, { objetos, bytes });
    }
    return tamanosHechos.get(id);
  }
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

// ---------- Enlaces (.url / .strm) ----------
// Un archivo pequeño del bucket con la dirección de un vídeo que está en otro sitio: un stream
// (.m3u8, .mp4…) que abre el reproductor de siempre, o una página con su propio reproductor
// que se abre en un iframe aislado. Vale el formato de acceso directo de Windows («URL=…»)
// y el de Kodi/Jellyfin (.strm, la dirección en la primera línea).
const esEnlace = (key) => /\.(url|strm)$/i.test(key);
const STREAM = /\.(m3u8|mp4|m4v|webm|mov|mp3|m4a|aac)(\?|#|$)/i;

// YouTube y Vimeo no dejan meter su página normal en un iframe: se pasa a su versión «embed»
function aEmbed(u) {
  const yt = u.hostname.replace(/^(www|m)\./, '');
  const id = yt === 'youtu.be' ? u.pathname.slice(1)
    : yt === 'youtube.com' && u.pathname === '/watch' ? u.searchParams.get('v') : null;
  if (id) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
  const vimeo = yt === 'vimeo.com' && u.pathname.match(/^\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return u.href;
}

// Direcciones de la propia máquina o de la red de casa: el servidor no las comprueba
const privada = (host) => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(host);

// Comprueba que la dirección responde (sin descargar el vídeo): estado HTTP o el fallo de red
async function comprobar(url) {
  if (privada(new URL(url).hostname)) return { estado: null };
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 8000);
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: corte.signal, headers: { range: 'bytes=0-0' } });
    r.body?.cancel().catch(() => {});
    return { estado: r.status };
  } catch (e) {
    return { estado: 0, fallo: corte.signal.aborted ? 'No responde (tiempo agotado)' : 'No se pudo conectar' };
  } finally {
    clearTimeout(reloj);
  }
}

async function enlace(key) {
  if (!esEnlace(key)) throw Object.assign(new Error('No es un enlace'), { status: 400 });
  const r = await s3.send(new GetObjectCommand({ Bucket: E2_BUCKET, Key: key, Range: 'bytes=0-65535' }));
  const lineas = (await r.Body.transformToString('utf-8')).split(/\r?\n/).map((l) => l.trim());
  const bruto = (lineas.find((l) => /^URL=/i.test(l)) ?? '').slice(4) || lineas.find((l) => /^https?:\/\//i.test(l));
  let u;
  try { u = new URL(bruto); } catch (e) { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) throw Object.assign(new Error('El archivo no tiene una dirección http(s) válida'), { status: 422 });
  const tipo = STREAM.test(u.pathname) ? 'stream' : 'embed';
  const url = tipo === 'embed' ? aEmbed(u) : u.href;
  return { tipo, url, ...(await comprobar(url)) };
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

// Cada vídeo preparado es un ffmpeg en marcha: con tope en total y por cuenta, para que nadie
// tumbe el servidor abriendo vídeos sin parar
const MAX_FFMPEG = Math.max(1, Number(process.env.VISOR_MAX_FFMPEG) || 8);
const MAX_FFMPEG_CUENTA = 2;
async function hlsIniciar(p, quien) {
  const key = p.get('key');
  if (quien && !quien.admin) {
    // Los de esta cuenta que siguen abiertos: el más viejo se cierra para dejar sitio al nuevo
    const suyos = [...sesionesHls].filter(([, s]) => s.usuario === quien.cuenta.usuario).sort((a, b) => a[1].ultimo - b[1].ultimo);
    while (suyos.length >= MAX_FFMPEG_CUENTA) hlsParar(suyos.shift()[0]);
  }
  if (sesionesHls.size >= MAX_FFMPEG) throw Object.assign(new Error('El servidor está ocupado preparando otros vídeos. Prueba en un minuto.'), { status: 503 });
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
  const sesion = { ff, carpeta, ultimo: Date.now(), errores: '', usuario: quien?.cuenta.usuario };
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
const SEGUNDOS_ESCANEO = Math.max(3, Number(process.env.VISOR_ESCANEO_SEGUNDOS) || 5);
const oyentes = new Set();
let foto = null; // key → "tamaño:fecha" del último repaso
// Huella del contenido: la app la recibe al conectarse y, si no coincide con la que tenía (se
// perdió avisos mientras estaba en segundo plano o sin conexión), se pone al día sola
let huella = '';
const huellaDe = (mapa) => createHash('sha1').update([...mapa].sort().join('\n')).digest('hex').slice(0, 12);

const esInterna = (key) => key.split('/').some((p) => p.startsWith('_'));

function avisar(evento, datos) {
  const msg = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
  for (const res of oyentes) res.write(msg);
}

// Fichas de TMDB de lo recién subido, en segundo plano y de 2 en 2: una subida de miles de
// vídeos no atasca los repasos ni satura TMDB
const fichasPendientes = new Set();
let buscandoFichas = 0;
function prepararFichas(keys) {
  for (const k of keys) if (fichasPendientes.size < 5000) fichasPendientes.add(k);
  while (buscandoFichas < 2 && fichasPendientes.size) {
    const k = fichasPendientes.values().next().value;
    fichasPendientes.delete(k);
    buscandoFichas++;
    meta.deArchivo(k).catch(() => {}).finally(() => { buscandoFichas--; prepararFichas([]); });
  }
}

// Si cambian miles de cosas de golpe, el aviso no lleva la lista entera: la app lo recarga todo
const MAX_AVISO = 300;
async function repasar() {
  const ahora = new Map();
  for await (const o of recorrer('')) {
    if (!esInterna(o.Key)) ahora.set(o.Key, `${o.Size}:${o.LastModified?.getTime()}`);
  }
  const antes = foto;
  const nuevos = antes ? [...ahora.keys()].filter((k) => !antes.has(k)) : [];
  const cambiados = antes ? [...ahora.keys()].filter((k) => antes.has(k) && antes.get(k) !== ahora.get(k)) : [];
  const borrados = antes ? [...antes.keys()].filter((k) => !ahora.has(k)) : [];
  const hayCambios = nuevos.length || cambiados.length || borrados.length;
  // La foto nueva va primero: el catálogo que pida la app al recibir el aviso ya la incluye.
  // La huella (y con ella las cachés) solo se recalcula si algo ha cambiado.
  foto = ahora;
  if (!antes || hayCambios) huella = huellaDe(ahora);
  telegram.repaso(ahora); // por su cuenta: no frena los repasos
  if (!antes || !hayCambios) return;
  console.log(`Cambios en e2: ${nuevos.length} nuevos, ${cambiados.length} cambiados, ${borrados.length} borrados`);
  const total = nuevos.length + cambiados.length + borrados.length;
  avisar('cambios', total > MAX_AVISO
    ? { nuevos: nuevos.slice(0, MAX_AVISO), cambiados: [], borrados: [], todo: true, huella }
    : { nuevos, cambiados, borrados, huella });
  prepararFichas(nuevos.filter((k) => esVideo(k)));
}

// El repaso se adapta: con un bucket enorme (repasarlo tarda) se espera más entre uno y otro, y
// si nadie está usando MorvehTV se repasa más despacio. Nunca menos de cada SEGUNDOS_ESCANEO.
let ultimaVisita = Date.now();
let duracionRepaso = 0;
async function vigilar() {
  const inicio = Date.now();
  try {
    await repasar();
  } catch (err) {
    console.error(`No se pudo repasar el bucket: ${err.message}`);
  }
  duracionRepaso = Date.now() - inicio;
  let espera = Math.max(SEGUNDOS_ESCANEO * 1000, duracionRepaso * 3);
  if (!oyentes.size && Date.now() - ultimaVisita > 120000) espera = Math.max(espera, 30000);
  setTimeout(vigilar, Math.min(espera, 120000));
}

// ---------- Catálogo para la portada ----------
// Por cada carpeta de primer nivel, sus títulos del más nuevo al más antiguo: los vídeos
// sueltos son películas; lo que va en subcarpetas («SERIES/Serie/Temporada 1/…») es la serie.
// Sale de la foto del último repaso del bucket (o de un repaso nuevo si aún no hay).
// Hecho una vez por cada estado del contenido (huella); «max» recorta los títulos por carpeta
// (la portada solo enseña los 20 últimos de cada una)
const catalogosHechos = new Map(); // `${huella}|${max}` → catálogo
async function catalogo(max) {
  const tope = Math.min(Math.max(Number(max) || 0, 0), 100000) || 0;
  const id = `${huella}|${tope}`;
  if (foto && catalogosHechos.has(id)) return catalogosHechos.get(id);
  const c = await catalogoEntero();
  const r = tope ? { carpetas: c.carpetas.map((x) => ({ ...x, titulos: x.titulos.slice(0, tope), total: x.titulos.length })) } : c;
  if (foto) {
    if (catalogosHechos.size > 20) catalogosHechos.clear();
    catalogosHechos.set(id, r);
  }
  return r;
}
async function catalogoEntero() {
  let objetos;
  if (foto) {
    objetos = [...foto].map(([key, v]) => {
      const [tam, ms] = v.split(':');
      return { key, tamano: Number(tam), fecha: new Date(Number(ms)) };
    });
  } else {
    objetos = [];
    for await (const o of recorrer('')) if (!esInterna(o.Key)) objetos.push(archivo(o));
  }
  const carpetas = new Map();
  for (const o of objetos) {
    const partes = o.key.split('/');
    if (partes.length < 2 || prohibido(o.key)) continue;
    const raiz = `${partes[0]}/`;
    // También las carpetas aún vacías (o sin vídeos): la portada las enseña como «Próximamente»
    if (!carpetas.has(raiz)) carpetas.set(raiz, new Map());
    if (!esVideo(o.key)) continue;
    // Las carpetas que solo agrupan («PELICULAS NETFLIX», «NETFLIX»…) se saltan: la serie es la
    // primera carpeta de debajo que no lo sea; si no hay ninguna, el vídeo es una película
    let i = 1;
    while (i < partes.length - 1 && meta.esAgrupadora(partes[i])) i++;
    const esSerie = i < partes.length - 1;
    const clave = esSerie ? `${partes.slice(0, i + 1).join('/')}/` : o.key;
    if (!carpetas.has(raiz)) carpetas.set(raiz, new Map());
    const titulos = carpetas.get(raiz);
    const previo = titulos.get(clave);
    if (!previo || previo.fecha < o.fecha) {
      titulos.set(clave, esSerie
        ? { tipo: 'carpeta', key: clave, fecha: o.fecha, ultimo: o.key }
        : { tipo: 'archivo', key: o.key, fecha: o.fecha, tamano: o.tamano });
    }
  }
  return {
    carpetas: [...carpetas].map(([carpeta, titulos]) => ({
      carpeta,
      titulos: [...titulos.values()].sort((a, b) => b.fecha - a.fecha),
    })),
  };
}

// Conexiones abiertas de cada cuenta: al pagar (o cancelar) se les avisa para que la web y la
// app quiten o pongan los anuncios en el momento, en todos sus aparatos
const oyentesCuenta = new Map(); // id de cuenta → Set de conexiones
perfiles.alCambiarPlan((id, plan) => {
  for (const res of oyentesCuenta.get(id) ?? []) res.write(`event: plan\ndata: ${JSON.stringify(plan)}\n\n`);
});
function eventos(req, res, cuenta) {
  if (cuenta) {
    if (!oyentesCuenta.has(cuenta.id)) oyentesCuenta.set(cuenta.id, new Set());
    oyentesCuenta.get(cuenta.id).add(res);
    res.on('close', () => { const s = oyentesCuenta.get(cuenta.id); if (s) { s.delete(res); if (!s.size) oyentesCuenta.delete(cuenta.id); } });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  // Versión del servidor: si cambia (se publicó algo nuevo), la app se recarga sola
  res.write(`event: version\ndata: ${JSON.stringify(VERSION)}\n\n`);
  if (huella) res.write(`event: contenido\ndata: ${JSON.stringify(huella)}\n\n`);
  oyentes.add(res);
  const latido = setInterval(() => res.write(': latido\n\n'), 25000);
  res.on('close', () => { clearInterval(latido); oyentes.delete(res); });
}

const rutas = {
  '/api/meta': (p) => meta.deArchivo(p.get('key')),
  '/api/metas': async (p) => {
    const keys = p.getAll('key').slice(0, 30);
    if (keys.some((k) => prohibido(k))) throw Object.assign(new Error('No'), { status: 403 });
    return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await meta.deArchivo(k).catch(() => null)])));
  },
  '/api/meta-carpeta': (p) => meta.deCarpeta(p.get('prefijo')),
  '/api/portada': (p) => meta.portadaCategoria(p.get('cat')),
  '/api/catalogo': (p) => catalogo(p.get('max')),
  '/api/tmdb-buscar': (p) => meta.buscar(p.get('q'), p.get('tipo') || undefined),
  '/api/corregir': (p) => meta.corregir(meta.claveDe(p.get('key')), p.get('tmdbId'), p.get('tipo')),
  '/api/hls': (p, req, quien) => { defensa.permitirVideo(quien.cuenta, quien.ip, p.get('key'), quien.admin); return hlsIniciar(p, quien); },
  '/api/hls-parar': (p) => hlsParar(p.get('id')),
  '/api/medio': async (p) => ({ ...(await medio(p.get('key'))), audioNativo: AUDIO_NATIVO, videoNativo: VIDEO_NATIVO }),
  '/api/info': () => ({ bucket: E2_BUCKET }),
  '/api/listar': (p) => listar(p.get('prefijo') ?? '', p.get('token')),
  '/api/buscar': (p) => buscar(p.get('prefijo') ?? '', p.get('q') ?? '', Math.min(50, Number(p.get('azar')) || 0)),
  '/api/tamano': (p) => tamano(p.get('prefijo') ?? ''),
  '/api/url': async (p, req, quien) => {
    if (esVideo(p.get('key') ?? '')) defensa.permitirVideo(quien.cuenta, quien.ip, p.get('key'), quien.admin);
    return { url: await firmar(p.get('key')) };
  },
  '/api/texto': (p) => texto(p.get('key')),
  '/api/enlace': (p) => enlace(p.get('key')),
};

const tipos = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
// Librerías servidas desde node_modules (sin depender de internet ni de un CDN)
const VENDOR = {
  '/vendor/hls.min.js': 'node_modules/hls.js/dist/hls.min.js',
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

// Hora a la que arrancó el servidor. En el plan gratis de Render también cambia al despertar
// de la inactividad, así que no dice qué código hay publicado: para eso está VERSION.
const ARRANQUE = new Date().toISOString();

// Huella del código: cambia con cada publicación y solo entonces. La página pide «app.js?v=…»
// con ella, así que ninguna tele ni WebView puede quedarse con un archivo de la versión anterior.
const VERSION = (() => {
  const h = createHash('sha256');
  const ficheros = ['server.js', 'metadatos.js', 'perfiles.js', 'acceso.js', 'telegram.js', 'xtream.js', 'panel.js', 'defensa.js', 'pagos.js', ...readdirSync(path.join(dir, 'public')).sort().map((f) => `public/${f}`)];
  for (const f of ficheros) { h.update(f); h.update(readFileSync(path.join(dir, f))); }
  return h.digest('hex').slice(0, 10);
})();
const CON_VERSION = /(src|href)="(polyfills\.js|intro\.css|intro\.js|app\.js|perfiles\.js)"/g;

// Las respuestas grandes (catálogo, listados) van comprimidas: con mucho contenido pesan 5-10
// veces menos y la tele o el móvil las reciben antes
const aceptaGzip = (res) => /\bgzip\b/.test(String(res.req?.headers['accept-encoding'] ?? ''));
function enviar(res, status, cabeceras, cuerpo) {
  const buf = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo);
  if (buf.length > 2048 && aceptaGzip(res)) {
    res.writeHead(status, { ...cabeceras, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    return res.end(gzipSync(buf, { level: 5 }));
  }
  res.writeHead(status, cabeceras);
  res.end(buf);
}
// ---------- Páginas legales ----------
// Los datos del titular (obligatorios por la LSSI para cobrar) van en variables de entorno de
// Render, no en el código: el repositorio es público. Lo que falte sale como «pendiente».
const LEGAL = { TITULAR: 'LEGAL_TITULAR', NIF: 'LEGAL_NIF', DIRECCION: 'LEGAL_DIRECCION', EMAIL: 'LEGAL_EMAIL' };
const faltanLegal = () => Object.values(LEGAL).filter((v) => !String(process.env[v] ?? '').trim());
const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function legal(html, req) {
  const valores = Object.fromEntries(Object.entries(LEGAL).map(([k, v]) => {
    const x = String(process.env[v] ?? '').trim();
    if (!x) return [k, '<em style="color:#ffb224">[pendiente de completar]</em>'];
    return [k, k === 'EMAIL' ? `<a href="mailto:${escHtml(x)}">${escHtml(x)}</a>` : escHtml(x)];
  }));
  const web = process.env.VISOR_URL || `https://${req.headers.host}`;
  valores.WEB = `<a href="${escHtml(web)}">${escHtml(web.replace(/^https?:\/\//, ''))}</a>`;
  valores.PRECIO = escHtml((await pagos.precioTexto().catch(() => null)) || 'el indicado antes de pagar');
  valores.ANIO = String(new Date().getFullYear());
  // (en el pie, sin enlaces ni avisos: solo el nombre)
  return html.replace(/© \{\{ANIO\}\} \{\{TITULAR\}\}/, `© ${valores.ANIO} ${escHtml(String(process.env.LEGAL_TITULAR ?? '').trim())}`)
    .replace(/\{\{([A-Z]+)\}\}/g, (m, k) => valores[k] ?? m);
}

const json = (res, status, datos) => enviar(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(datos));

// Lo que se puede abrir sin haber entrado: la pantalla de entrada y los iconos
const PUBLICO = ['/entrar.html', '/legal.html', '/manifest.webmanifest', '/icono-192.png', '/icono-512.png', '/icono.svg'];

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    defensa.cabeceras(res, acceso.NUBE);
    try {
      const permiso = acceso.permiso(req);
      if (permiso === 'fuera') return json(res, 403, { error: 'Solo se puede entrar desde la red de casa' });
      const ip = acceso.ipDe(req);
      // Límite de peticiones por conexión (Render lo comprueba en /api/salud: esa no cuenta)
      if (url.pathname !== '/api/salud') { defensa.limitar(ip, url.pathname); ultimaVisita = Date.now(); }
      // Para que Render sepa que está viva
      if (url.pathname === '/api/salud') return json(res, 200, { ok: true, version: VERSION, arranque: ARRANQUE, perfiles: perfiles.escritura, telegram: telegram.estado, tmdb: await meta.saludTmdb(), pagos: pagos.estado,
        legal: faltanLegal().length ? `faltan ${faltanLegal().join(', ')}` : 'ok' });
      // Avisos de Stripe (cobros, renovaciones, cancelaciones): sin sesión, con su firma
      if (url.pathname === '/api/pago/webhook' && req.method === 'POST') return await pagos.webhook(req, res, json);
      // Panel de gestión: otra web, entra con su token (y CORS solo para ella)
      if (panel.esRuta(url.pathname)) return await panel.atender(url.pathname, req, res, json, acceso.ipDe(req));
      // Reproductores tipo Xtream: entran con usuario y contraseña en cada petición, sin cookie
      if (xtream.esRuta(url.pathname)) return await xtream.atender(url.pathname, req, res, json, { ip: acceso.ipDe(req), nube: acceso.NUBE });
      // Sin sesión solo se llega a la pantalla de entrar o registrarse
      if (perfiles.SIN_SESION.includes(url.pathname)) return await perfiles.atender(url.pathname, req, res, json, acceso.ipDe(req));
      const cuenta = PUBLICO.includes(url.pathname) ? null : await perfiles.sesion(req);
      if (!PUBLICO.includes(url.pathname) && !cuenta) {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hls/')) return json(res, 401, { error: 'Inicia sesión' });
        res.writeHead(302, { location: '/entrar.html', 'cache-control': 'no-store' });
        return res.end();
      }

      if (url.pathname === '/api/eventos') return eventos(req, res, cuenta);
      if (perfiles.RUTAS.includes(url.pathname)) return await perfiles.atender(url.pathname, req, res, json, acceso.ipDe(req));
      if (pagos.RUTAS.includes(url.pathname)) return await pagos.atender(url.pathname, req, res, json, cuenta);
      const hls = url.pathname.match(/^\/hls\/([\w-]+)\/([^/]+)$/);
      if (hls) return await hlsServir(res, hls[1], hls[2]);
      const ruta = rutas[url.pathname];
      if (ruta && (prohibido(url.searchParams.get('key')) || prohibido(url.searchParams.get('prefijo')))) {
        return json(res, 403, { error: 'Esta carpeta no se puede ver desde internet' });
      }
      if (ruta) return json(res, 200, await ruta(url.searchParams, req, { cuenta, ip, admin: await perfiles.esAdmin(cuenta) }));

      if (VENDOR[url.pathname]) {
        return enviar(res, 200, { 'content-type': tipos['.js'], 'cache-control': 'max-age=86400' }, await readFile(path.join(dir, VENDOR[url.pathname])));
      }
      const fichero = path.join(dir, 'public', url.pathname === '/' ? 'index.html' : path.normalize(decodeURIComponent(url.pathname)));
      if (!fichero.startsWith(path.join(dir, 'public'))) throw Object.assign(new Error('No'), { status: 403 });
      const ext = path.extname(fichero);
      // La página nunca se guarda en caché y enlaza sus archivos con la versión
      if (ext === '.html') {
        let html = (await readFile(fichero, 'utf8')).replace(CON_VERSION, `$1="$2?v=${VERSION}"`);
        if (url.pathname === '/legal.html') html = await legal(html, req);
        return enviar(res, 200, { 'content-type': tipos[ext], 'cache-control': 'no-store' }, html);
      }
      const cuerpo = ext === '.js' ? await js(fichero) : await readFile(fichero);
      enviar(res, 200, { 'content-type': tipos[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' }, cuerpo);
    } catch (err) {
      if (err.espera && !res.headersSent) res.setHeader('retry-after', String(err.espera));
      if (res.headersSent) return res.end();
      json(res, err.status ?? (err.code === 'ENOENT' ? 404 : err.$metadata?.httpStatusCode ?? 500), { error: err.message });
    }
  })
  // Escucha en la red de casa para que entren el móvil y la tele (sin PIN); con
  // VISOR_SOLO_LOCAL=1 solo se puede usar desde este ordenador
  .listen(PUERTO, process.env.VISOR_SOLO_LOCAL === '1' && !acceso.NUBE ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(`MorvehTV (bucket "${E2_BUCKET}") en http://localhost:${PUERTO}${acceso.NUBE ? ' (modo nube)' : ''}`);
    if (process.env.VISOR_SOLO_LOCAL !== '1' && !acceso.NUBE) {
      for (const u of acceso.direcciones(PUERTO)) console.log(`  En el móvil o la tele (misma wifi): ${u}`);
    }
    vigilar();
  });
