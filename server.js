// MorvehTV (visor de IDrive e2): un servidor que lista el bucket y firma enlaces para ver cada
// archivo. Nunca escribe ni borra vídeos en e2: lo único que escribe es el archivo oculto de
// cuentas (_morvehtv/usuarios.json, ver perfiles.js). Sin sesión solo se ve entrar.html.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, stat, rename } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { gzip, brotliCompress, constants as zlibC } from 'node:zlib';
import { promisify } from 'node:util';
import os from 'node:os';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { servirRango, estadisticas as lecturaE2 } from './e2rapido.js';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as meta from './metadatos.js';
import * as acceso from './acceso.js';
import * as perfiles from './perfiles.js';
import * as telegram from './telegram.js';
import * as intros from './intros.js';
import * as xtream from './xtream.js';
import * as panel from './panel.js';
import * as defensa from './defensa.js';
import * as pagos from './pagos.js';
import { analizarEnlaces } from './enlaces-video.js';

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

// Modo mudanza (VISOR_MUDADO_A=https://morvehtv.com): este servidor ya no es MorvehTV. No toca e2
// ni Telegram (así nunca hay dos servidores escribiendo las cuentas a la vez) y manda a todos a la
// dirección nueva: los navegadores, con una redirección; la app de Android vieja, con una página
// propia (si la redirigiera, la abriría en el navegador y no llegaría a buscar su actualización)
const MUDADO_A = String(process.env.VISOR_MUDADO_A ?? '').trim().replace(/\/$/, '');
if (/^https:\/\/[a-z0-9.-]+$/i.test(MUDADO_A)) {
  const pagina = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MorvehTV se ha mudado</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b10;color:#eee;font:17px/1.5 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}
h1{font-size:24px;margin:0 0 8px}a{display:inline-block;margin-top:18px;padding:12px 22px;border-radius:10px;background:#e50914;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><main><h1>MorvehTV se ha mudado</h1><p>Ahora estamos en <b>${MUDADO_A.replace(/^https:\/\//, '')}</b>.<br>Acepta la actualización de la app que aparece ahora para seguir viéndolo todo.</p>
<a href="${MUDADO_A}/">Ir a ${MUDADO_A.replace(/^https:\/\//, '')}</a></main></body></html>`;
  http.createServer((req, res) => {
    const ruta = (req.url ?? '/').startsWith('/') ? req.url : '/';
    if (ruta === '/api/salud') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, mudado: MUDADO_A })); }
    if (/MorvehTVApp/.test(req.headers['user-agent'] ?? '')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(pagina);
    }
    res.writeHead(301, { location: MUDADO_A + ruta, 'cache-control': 'max-age=3600' });
    res.end();
  }).listen(PUERTO, '0.0.0.0', () => console.log(`MorvehTV se ha mudado a ${MUDADO_A}: este servidor solo redirige`));
  await new Promise(() => {}); // aquí se queda: el resto de este archivo no se ejecuta
}

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
// La misma conexión con la otra dirección que admite e2 para el bucket (bucket.servidor en vez de
// servidor/bucket). Solo para las subidas del panel: e2 habla HTTP/1.1 y el navegador abre como
// mucho 6 conexiones por dirección, así que con dos direcciones sube con 12 a la vez (el doble de
// rápido cuando cada conexión va limitada). PANEL_DOS_DIRECCIONES=0 lo desactiva.
const s3Virtual = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(E2_BUCKET) && process.env.PANEL_DOS_DIRECCIONES !== '0'
  ? new S3Client({
    endpoint: /^https?:\/\//.test(E2_ENDPOINT) ? E2_ENDPOINT : `https://${E2_ENDPOINT}`,
    region: E2_REGION,
    forcePathStyle: false,
    credentials: { accessKeyId: E2_ACCESS_KEY_ID, secretAccessKey: E2_SECRET_ACCESS_KEY },
  })
  : null;
perfiles.iniciar(s3, E2_BUCKET, acceso.NUBE);
// Fichas a mano escritas desde el gestor: al arrancar y cada 5 minutos (por si cambian en otro servidor)
// Avisos propios del reproductor (los escribe el gestor): en memoria, al arrancar y cada 5 minutos
let avisosReproductor = [];
const cargarFichasGestor = () => Promise.all([
  perfiles.leerAjuste('fichasManuales').then((l) => meta.ponerFichasGestor(l ?? [])),
  perfiles.leerAjuste('avisosReproductor').then((l) => { avisosReproductor = l ?? []; }),
]).catch(() => {});
cargarFichasGestor();
setInterval(cargarFichasGestor, 300000).unref();
// Sus imágenes viven en e2 (_morvehtv/fichas/); se guardan en memoria al pedirlas
const imagenesFichas = new Map();
async function imagenFichaE2(nombre) {
  if (imagenesFichas.has(nombre)) return imagenesFichas.get(nombre);
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: E2_BUCKET, Key: `_morvehtv/fichas/${nombre}` }));
    const img = { buf: Buffer.from(await r.Body.transformToByteArray()), tipo: r.ContentType || tipos[path.extname(nombre).toLowerCase()] || 'image/jpeg' };
    if (imagenesFichas.size > 200) imagenesFichas.delete(imagenesFichas.keys().next().value);
    imagenesFichas.set(nombre, img);
    return img;
  } catch { return null; }
}
// Render apaga el servidor a menudo: antes se guarda el progreso pendiente de cada perfil
for (const senal of ['SIGTERM', 'SIGINT']) {
  process.once(senal, () => perfiles.guardarPendiente().finally(() => process.exit(0)));
}

const esVideo = (key) => /\.(mp4|m4v|webm|mov|mkv|ogv|avi|ts|wmv|flv)$/i.test(key);
// Avisos de lo nuevo en Telegram, con un tema por sección (ver telegram.js)
await telegram.iniciar({ nube: acceso.NUBE, esVideo: (k) => esTitulo(k), leer: perfiles.leerAjuste, guardar: perfiles.guardarAjuste });
// Reproductores externos tipo Xtream Codes (ver xtream.js): usan la foto del último repaso.
// Apagados salvo que el servidor tenga XTREAM_ACTIVO=1
pagos.iniciar({ perfiles, firmar: (k, o) => firmar(k, o) });
xtream.iniciar({ foto: async () => { if (!foto) await repasar(); return foto; }, firmar, esVideo, credenciales: perfiles.credenciales, esAdmin: perfiles.esAdmin,
  // Los reproductores externos (King Stream Player…) funcionan con todas las cuentas; con
  // XTREAM_SOLO_VIP=1 vuelven a ser solo para VIP (en ellos no se pueden poner anuncios)
  permitido: async (c) => process.env.XTREAM_SOLO_VIP !== '1' || !pagos.activo || (await perfiles.planDe(c)).tipo === 'premium' });
// API del panel de gestión (otra web: «MorvehTV Gestor»), solo administradores (ver panel.js)
panel.iniciar({ s3, s3Virtual, bucket: E2_BUCKET, nube: acceso.NUBE, perfiles, foto: async () => { if (!foto) await repasar(); return foto; }, alMover: telegram.ignorar, pagosEstado: () => pagos.estado, pagos,
  // Al poner o quitar el mantenimiento desde el gestor, las páginas abiertas se recargan al momento
  alFichas: (lista) => meta.ponerFichasGestor(lista),
  alAvisos: (lista) => { avisosReproductor = lista; },
  alMantenimiento: (m) => { mantenimiento = m; mantenimientoLeido = Date.now(); avisar('mantenimiento', { activo: m.activo }); } });

// ---------- Web en mantenimiento ----------
// Se pone y se quita desde el gestor (se guarda en el archivo de cuentas de e2). Mientras dura,
// quien no es administrador solo ve la pantalla de mantenimiento: ni catálogo, ni vídeos, ni
// registros. Los administradores entran por /entrar.html?admin y lo usan todo con normalidad.
let mantenimiento = { activo: false };
let mantenimientoLeido = 0;
async function enMantenimiento() {
  if (Date.now() - mantenimientoLeido > 10000) {
    mantenimientoLeido = Date.now();
    try { mantenimiento = (await perfiles.ajusteReciente('mantenimiento')) ?? { activo: false }; } catch {} // si e2 falla, se queda como estaba
  }
  return mantenimiento;
}
function paginaMantenimiento(res, m) {
  const mensaje = m.mensaje ? escHtml(m.mensaje) : 'Estamos haciendo mejoras en MorvehTV. Volvemos en un rato: esta página se abrirá sola en cuanto terminemos.';
  const tg = telegram.invitacion();
  const pagina = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MorvehTV · En mantenimiento</title><meta name="robots" content="noindex"><link rel="icon" href="/icono.svg">
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:grid;place-items:center;padding:24px 16px;background:#0b0c10 radial-gradient(ellipse at 50% 0%,rgba(139,92,246,.28),transparent 60%);color:#f1f2f4;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
main{max-width:460px}img{width:96px;height:96px}
h1{margin:18px 0 10px;font-size:28px}p{margin:0 0 14px;color:#b9bec8}
.estado{display:inline-flex;align-items:center;gap:8px;margin-top:6px;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,.07);font-size:14px;color:#d4d7dd}
.estado i{width:9px;height:9px;border-radius:50%;background:#f5a524;animation:p 1.6s infinite}@keyframes p{50%{opacity:.3}}
a{color:#c4b5fd}.tg{display:inline-block;margin-top:18px;padding:11px 20px;border-radius:10px;background:#229ed9;color:#fff;font-weight:700;text-decoration:none}
.admin{position:fixed;bottom:12px;right:14px;font-size:12px;color:#5c6270;text-decoration:none}
</style></head><body><main>
<img src="/icono.svg" alt="">
<h1>Web en mantenimiento</h1>
<p>${mensaje}</p>
<span class="estado"><i></i>Comprobando cada poco si ya hemos vuelto…</span>
${tg ? `<br><a class="tg" href="${escHtml(tg)}" target="_blank" rel="noopener">Avisos en Telegram</a>` : ''}
</main><a class="admin" href="/entrar.html?admin">Administración</a>
<script>
setInterval(function(){fetch('/api/salud',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d&&d.mantenimiento===false)location.href='/'}).catch(function(){})},20000);
</script></body></html>`;
  return enviar(res, 503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '600' }, pagina);
}
const json503 = (res) => json(res, 503, { error: 'MorvehTV está en mantenimiento: vuelve en un rato', mantenimiento: true });
const esImagen = (key) => /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(key);

function firmar(key, { segundos = 4 * 3600 } = {}) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: E2_BUCKET, Key: key }), { expiresIn: segundos });
}

const archivo = (o) => ({ key: o.Key, tamano: o.Size, fecha: o.LastModified });

// ---------- Vídeo de e2 a varias conexiones (e2rapido.js) ----------
// Lo que pesa un archivo: del último repaso del bucket o, si aún no está, preguntándolo a e2
async function tamDe(key) {
  const v = foto?.get(key);
  if (v) return Number(String(v).split(':')[0]);
  const h = await s3.send(new HeadObjectCommand({ Bucket: E2_BUCKET, Key: key }));
  return Number(h.ContentLength) || 0;
}
// ffmpeg lee los vídeos por una dirección interna de este mismo servidor (solo desde la propia
// máquina, con un código al azar que caduca), así también va a varias conexiones
const lecturasInternas = new Map(); // código → { url, tam, hasta }
async function direccionInterna(key) {
  const codigo = randomUUID();
  lecturasInternas.set(codigo, { url: await firmar(key, { segundos: 12 * 3600 }), tam: await tamDe(key), hasta: Date.now() + 12 * 3600000 });
  for (const [c, l] of lecturasInternas) if (l.hasta < Date.now()) lecturasInternas.delete(c);
  return `http://127.0.0.1:${PUERTO}/_e2/${codigo}`;
}
const esLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const TIPO_VIDEO = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ts: 'video/mp2t' };

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
// Lo que cuenta como título en la portada, las fichas y los avisos de Telegram
const esTitulo = (key) => esVideo(key) || esEnlace(key);
const STREAM = /\.(m3u8|mp4|m4v|webm|mov|mp3|m4a|aac)(\?|#|$)/i;


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

async function enlace(key, opcion = 0) {
  if (!esEnlace(key)) throw Object.assign(new Error('No es un enlace'), { status: 400 });
  const r = await s3.send(new GetObjectCommand({ Bucket: E2_BUCKET, Key: key, Range: 'bytes=0-65535' }));
  // El archivo puede llevar una dirección, varias (una por línea: servidores de reserva) o
  // códigos <iframe> pegados; enlaces-video.js reconoce el servidor (Voe, Streamwish,
  // Filelions…) y deja cada uno en su dirección «embed» limpia
  const contenido = (await r.Body.transformToString('utf-8')).replace(/^\s*URL=/gim, '');
  const opciones = analizarEnlaces(contenido).slice(0, 30).map((o) => ({
    servidor: o.servidor,
    idioma: o.idioma,
    calidad: o.calidad,
    url: o.url,
    tipo: !o.conocido && STREAM.test(new URL(o.url).pathname) ? 'stream' : 'embed',
  }));
  if (!opciones.length) throw Object.assign(new Error('El archivo no tiene una dirección http(s) válida'), { status: 422 });
  const n = Math.min(Math.max(0, Number(opcion) || 0), opciones.length - 1);
  // Solo se comprueba desde aquí un stream (.mp4, .m3u8…). Las páginas con reproductor (Voe,
  // Streamwish…) suelen rechazar a quien no es un navegador (Cloudflare): desde el servidor
  // saldrían «caídas» aunque funcionen. Se abren siempre; si no cargan, avisa el reproductor.
  const comprobado = opciones[n].tipo === 'stream' ? await comprobar(opciones[n].url) : { estado: null };
  return { ...opciones[n], opcion: n, opciones, ...comprobado };
}

// ---------- Reproducción convertida con ffmpeg ----------
// Los .ts no tienen índice (no se puede saltar), muchos .mkv llevan audio AC3/DTS y el
// iPhone y las smart TV no abren .mkv. ffmpeg lee el archivo de e2 desde el segundo pedido y
// lo convierte al vuelo en HLS (el formato de streaming que entienden iPhone, Android y las
// teles), copiando el vídeo H.264 y pasando el audio a AAC.
const AUDIO_NATIVO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

// Idioma y nombre de una pista, mire donde mire cada formato: en MKV van en «language» y
// «title»; en MP4 el nombre va en «handler_name» (que a menudo es solo «SoundHandler»); hay
// archivos con las etiquetas en mayúsculas
const NOMBRE_GENERICO = /^(sound ?handler|audio ?handler|core media audio|iso media|gpac|mainconcept|apple|l-smash|stereo|mono|surround|audio|track ?\d*|pista ?\d*|\d+(\.\d)?( ?ch)?)$/i;
function etiquetasPista(tags = {}) {
  const t = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), String(v ?? '').trim()]));
  const idioma = t.language || t.lang || '';
  const titulo = [t.title, t.handler_name, t.name].find((x) => x && !NOMBRE_GENERICO.test(x)) || '';
  return { idioma: idioma === 'und' ? '' : idioma, titulo };
}

// Nombres de los audios puestos a mano por un administrador, para los archivos que no dicen su
// idioma: por archivo o para toda una carpeta (una temporada o una serie suelen venir con el
// mismo orden de pistas). Se guardan en el archivo de cuentas, clave «audios».
async function nombresAudioDe(key) {
  const todos = (await perfiles.leerAjuste('audios').catch(() => null)) || {};
  if (todos[key]) return todos[key];
  // La carpeta más cercana que tenga nombres (la temporada antes que la serie)
  const partes = key.split('/');
  for (let i = partes.length - 1; i > 0; i--) {
    const c = `${partes.slice(0, i).join('/')}/`;
    if (todos[c]) return todos[c];
  }
  return null;
}
const IDIOMAS_PERMITIDOS = /^[\p{L} .·()0-9-]{1,30}$/u;
async function guardarNombresAudio(req, quien) {
  if (req.method !== 'POST') throw Object.assign(new Error('Método no permitido'), { status: 405 });
  if (!quien.admin) throw Object.assign(new Error('Solo la administración puede poner nombre a los audios'), { status: 403 });
  let texto = '';
  for await (const trozo of req) { texto += trozo; if (texto.length > 20000) throw Object.assign(new Error('Demasiado grande'), { status: 413 }); }
  const d = JSON.parse(texto || '{}');
  const key = String(d.key ?? '');
  if (!key || prohibido(key) || key.split('/').length < 2) throw Object.assign(new Error('Falta el archivo'), { status: 400 });
  const nombres = Array.isArray(d.nombres) ? d.nombres.slice(0, 16).map((x) => String(x ?? '').trim()) : [];
  if (nombres.some((x) => x && !IDIOMAS_PERMITIDOS.test(x))) throw Object.assign(new Error('Nombre de idioma no válido'), { status: 400 });
  // Toda la carpeta del archivo (la temporada) o solo este archivo
  const clave = d.carpeta ? key.replace(/[^/]+$/, '') : key;
  const todos = (await perfiles.leerAjuste('audios').catch(() => null)) || {};
  if (nombres.some(Boolean)) todos[clave] = nombres; else delete todos[clave];
  // Al guardarlo para la carpeta, lo puesto antes archivo por archivo dentro de ella deja de valer
  if (d.carpeta) for (const k of Object.keys(todos)) if (k !== clave && k.startsWith(clave)) delete todos[k];
  await perfiles.guardarAjuste('audios', todos);
  return { ok: true, clave, nombres: todos[clave] ?? null };
}
const VIDEO_NATIVO = ['h264'];
const medios = new Map();

// ---------- Duración real de cada vídeo ----------
// Para los capítulos y películas cuya ficha no dice cuánto duran (versiones internacionales,
// fichas de Wikipedia…): se mide el propio archivo con ffprobe una sola vez y se guarda en
// data/duraciones.json («key|tamaño» → segundos; si se cambia el archivo, se vuelve a medir)
const ARCHIVO_DURACIONES = path.join(dir, 'data', 'duraciones.json');
let duraciones = {};
try { duraciones = JSON.parse(readFileSync(ARCHIVO_DURACIONES, 'utf8')); } catch {}
let guardandoDuraciones = null;
const claveDuracion = (key) => `${key}|${foto?.get(key)?.split(':')[0] ?? ''}`;
const duracionDe = (key) => duraciones[claveDuracion(key)] ?? null;
// Los que alguien tiene en pantalla sin duración: al medirlos se le avisa (la tarjeta se completa sola)
const pedidosSinDuracion = new Map(); // key → hasta cuándo interesa
function anotarDuracion(key, segundos) {
  if (!(segundos > 0)) return;
  duraciones[claveDuracion(key)] = Math.round(segundos);
  if (pedidosSinDuracion.get(key) > Date.now()) avisar('duracion', { key, duracion: Math.max(1, Math.round(segundos / 60)) });
  pedidosSinDuracion.delete(key);
  clearTimeout(guardandoDuraciones);
  guardandoDuraciones = setTimeout(() => {
    mkdir(path.dirname(ARCHIVO_DURACIONES), { recursive: true })
      .then(() => writeFile(ARCHIVO_DURACIONES, JSON.stringify(duraciones)))
      .catch((e) => console.error(`No se pudieron guardar las duraciones: ${e.message}`));
  }, 3000);
}
// Colas para medir sin cargar el servidor (dos a la vez): primero lo que alguien está viendo o se
// acaba de subir; después, sin prisa, el repaso del catálogo entero
const porMedirYa = new Set();
const porMedir = new Set();
const fallosMedir = new Map(); // key → veces que no se pudo (a la tercera, se deja)
let midiendo = 0;
function medirLuego(keys, urgente = false) {
  for (const k of keys) {
    if (!esVideo(k) || esInterna(k) || duracionDe(k) != null || (fallosMedir.get(k) ?? 0) >= 3) continue;
    if (urgente) { porMedir.delete(k); if (porMedirYa.size < 2000) porMedirYa.add(k); } else if (!porMedirYa.has(k) && porMedir.size < 5000) porMedir.add(k);
  }
  while (midiendo < 2 && (porMedirYa.size || porMedir.size)) {
    const cola = porMedirYa.size ? porMedirYa : porMedir;
    const k = cola.values().next().value;
    cola.delete(k);
    midiendo++;
    medio(k).then((m) => {
      if (m.duracion > 0) anotarDuracion(k, m.duracion);
      else throw new Error('el archivo no dice su duración');
    }).catch((e) => {
      fallosMedir.set(k, (fallosMedir.get(k) ?? 0) + 1);
      console.warn(`No se pudo medir la duración de «${k}»: ${String(e.message).slice(0, 160)}`);
    }).finally(() => { midiendo--; medirLuego([]); });
  }
}
// ---------- Miniatura de cada capítulo ----------
// Los capítulos sin imagen propia en su ficha (versiones internacionales, series de Wikipedia…)
// llevan un fotograma de su propio vídeo, sacado con ffmpeg una sola vez y guardado en
// data/miniaturas/ (640 px de ancho). Como mucho dos a la vez, para no frenar los vídeos.
const DIR_MINIATURAS = path.join(dir, 'data', 'miniaturas');
const miniaturasEnCurso = new Map();
let haciendoMiniaturas = 0;
const esperaMiniatura = [];
const archivoMiniatura = (key) => path.join(DIR_MINIATURAS, `${createHash('sha1').update(claveDuracion(key)).digest('hex').slice(0, 20)}.jpg`);
function miniatura(key) {
  const destino = archivoMiniatura(key);
  if (existsSync(destino)) return Promise.resolve(destino);
  if (!miniaturasEnCurso.has(key)) {
    const p = (async () => {
      if (haciendoMiniaturas >= 2) await new Promise((ok) => esperaMiniatura.push(ok));
      haciendoMiniaturas++;
      try {
        const m = await medio(key).catch(() => null);
        const segundos = m?.duracion || duracionDe(key) || 0;
        // Un momento ya metido en el capítulo (no la cabecera ni un fundido a negro)
        const en = segundos ? Math.max(5, Math.min(segundos * 0.3, segundos - 5)) : 120;
        await mkdir(DIR_MINIATURAS, { recursive: true });
        const url = await firmar(key, { segundos: 600 });
        const tmp = `${destino}.${process.pid}.tmp.jpg`;
        const filtro = m?.hdr ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=640:-2' : 'scale=640:-2';
        await new Promise((ok, mal) => execFile('ffmpeg', ['-v', 'error', '-ss', String(Math.round(en)), '-i', url, '-frames:v', '1', '-vf', filtro, '-q:v', '4', '-y', tmp],
          { timeout: 90000 }, (e) => (e ? mal(e) : ok())));
        await rename(tmp, destino);
        return destino;
      } finally {
        haciendoMiniaturas--;
        esperaMiniatura.shift()?.();
      }
    })();
    p.catch(() => {}).finally(() => miniaturasEnCurso.delete(key));
    miniaturasEnCurso.set(key, p);
  }
  return miniaturasEnCurso.get(key);
}
const urlMiniatura = (key) => `/api/miniatura?key=${encodeURIComponent(key)}&v=${encodeURIComponent(foto?.get(key)?.split(':')[0] ?? '')}`;

// ---------- «Saltar intro» ----------
// La intro de cada capítulo se busca comparando la huella de audio del principio de los capítulos
// de la misma temporada (intros.js). Se hace una vez por temporada, en segundo plano (al subir
// capítulos, al abrir la temporada o al ver uno), y se guarda en data/intros.json
// («key|tamaño» → { inicio, fin } en segundos, o 0 si ese capítulo no tiene intro).
const ARCHIVO_INTROS = path.join(dir, 'data', 'intros.json');
let introsGuardadas = {};
try { introsGuardadas = JSON.parse(readFileSync(ARCHIVO_INTROS, 'utf8')); } catch {}
let estadoIntros = 'comprobando';
let hayHuellas = false;
intros.hayChromaprint().then((si) => { hayHuellas = si; estadoIntros = si ? 'ok' : 'sin chromaprint en ffmpeg'; });
let guardandoIntros = null;
function guardarIntros() {
  clearTimeout(guardandoIntros);
  guardandoIntros = setTimeout(() => {
    mkdir(path.dirname(ARCHIVO_INTROS), { recursive: true }).then(() => writeFile(ARCHIVO_INTROS, JSON.stringify(introsGuardadas)))
      .catch((e) => console.error(`No se pudieron guardar las intros: ${e.message}`));
  }, 2000);
}
const introDe = (key) => introsGuardadas[claveDuracion(key)];
const huellasEnMemoria = new Map(); // «key|tamaño» → huella (las últimas 400)
const temporadasPorMirar = new Set();
let mirandoIntros = false;
// La carpeta del capítulo (la temporada o la de la serie) y sus vídeos, en orden de capítulo
const carpetaDe = (key) => key.replace(/[^/]+$/, '');
const capitulosDe = (carpeta) => (foto ? [...foto.keys()] : [])
  .filter((k) => k.startsWith(carpeta) && !k.slice(carpeta.length).includes('/') && esVideo(k))
  .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
function buscarIntrosLuego(keys) {
  if (!hayHuellas) return;
  for (const k of keys) {
    if (!esVideo(k) || esInterna(k) || introDe(k) !== undefined) continue;
    const c = carpetaDe(k);
    if (c.split('/').length > 2) temporadasPorMirar.add(c); // nunca la raíz de una sección
  }
  if (!mirandoIntros && temporadasPorMirar.size) mirarTemporada();
}
async function mirarTemporada() {
  mirandoIntros = true;
  const carpeta = temporadasPorMirar.values().next().value;
  temporadasPorMirar.delete(carpeta);
  try {
    const caps = capitulosDe(carpeta);
    if (caps.length >= 2 && caps.some((k) => introDe(k) === undefined)) {
      const huellas = [];
      for (const k of caps) {
        const id = claveDuracion(k);
        let h = huellasEnMemoria.get(id);
        if (!h) {
          // El principio del capítulo (las intros suelen estar en los primeros minutos)
          const dur = duracionDe(k) || 0;
          const ventana = dur ? Math.min(600, Math.max(300, dur * 0.4)) : 600;
          h = await intros.huella(await firmar(k, { segundos: 900 }), ventana).catch((e) => { console.warn(`Intro: no se pudo escuchar «${k}» (${e.message.slice(0, 120)})`); return null; });
          if (h) { huellasEnMemoria.set(id, h); if (huellasEnMemoria.size > 400) huellasEnMemoria.delete(huellasEnMemoria.keys().next().value); }
        }
        huellas.push(h);
      }
      const res = intros.introsDeTemporada(huellas);
      caps.forEach((k, i) => { if (huellas[i]) introsGuardadas[claveDuracion(k)] = res[i] ?? 0; });
      guardarIntros();
      const con = res.filter(Boolean).length;
      console.log(`Intro: «${carpeta}» → ${con} de ${caps.length} capítulos con intro`);
      for (const [i, k] of caps.entries()) if (res[i]) avisar('intro', { key: k, ...res[i] });
    }
  } catch (e) { console.warn(`Intro: «${carpeta}» (${e.message})`); }
  mirandoIntros = false;
  if (temporadasPorMirar.size) setTimeout(mirarTemporada, 1000);
}

// Completa la ficha con la duración real (en minutos, como la de las bases de datos)
function conDuracion(key, r) {
  if (!r?.encontrado || !key) return r;
  const segundos = duracionDe(key);
  if (r.episodio && !r.episodio.imagenPropia && esVideo(key)) r.episodio.imagen = urlMiniatura(key);
  if (r.episodio && !r.episodio.duracion) {
    if (segundos) r.episodio.duracion = Math.max(1, Math.round(segundos / 60)); else { pedidosSinDuracion.set(key, Date.now() + 1800000); medirLuego([key], true); }
  } else if (!r.episodio && !r.duracion) {
    if (segundos) r.duracion = Math.max(1, Math.round(segundos / 60)); else { pedidosSinDuracion.set(key, Date.now() + 1800000); medirLuego([key], true); }
  }
  return r;
}

function medio(key) {
  if (!medios.has(key)) {
    const p = firmar(key).then(
      (url) =>
        new Promise((ok, mal) =>
          execFile(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,profile,pix_fmt,width,height,channels,color_transfer:stream_tags', '-of', 'json', url],
            { timeout: 60000 },
            (err, salida) => {
              if (err) return mal(new Error(`ffprobe no pudo leer el vídeo: ${err.message}`));
              const d = JSON.parse(salida);
              const pistas = d.streams ?? [];
              // (las carátulas incrustadas también salen como «vídeo»: se coge la primera pista de verdad)
              const video = pistas.find((s) => s.codec_type === 'video' && !['mjpeg', 'png', 'bmp', 'gif'].includes(s.codec_name))
                ?? pistas.find((s) => s.codec_type === 'video');
              // H.264 de 10 bits o con color 4:2:2 / 4:4:4 no lo abre casi ningún navegador ni tele:
              // se marca aparte para que no vaya directo ni se copie tal cual, sino que se convierta
              let codec = video?.codec_name ?? null;
              const pix = String(video?.pix_fmt ?? '');
              if (codec === 'h264' && ((pix && !/^yuvj?420p$/.test(pix)) || /high 10|4:2:2|4:4:4/i.test(String(video?.profile ?? '')))) codec = `h264-${pix || 'raro'}`;
              ok({
                duracion: Number(d.format?.duration) || 0,
                video: codec,
                // (el reproductor lo usa para saber si el aparato abre ese HEVC: 8 o 10 bits)
                pix: pix || null,
                resolucion: video?.width ? `${video.width}×${video.height}` : null,
                ancho: Number(video?.width) || 0,
                alto: Number(video?.height) || 0,
                // HDR10 / HDR10+ (smpte2084) o HLG (arib-std-b67): al pasarlo a H.264 normal hay que
                // convertir los colores, o se ve todo apagado y grisáceo
                hdr: { smpte2084: 'pq', 'arib-std-b67': 'hlg' }[video?.color_transfer] || null,
                subtitulos: pistas
                  .filter((s) => s.codec_type === 'subtitle')
                  .map((s) => ({ codec: s.codec_name, idioma: s.tags?.language ?? '', titulo: s.tags?.title ?? '' })),
                audios: pistas
                  .filter((s) => s.codec_type === 'audio')
                  .map((s) => ({ codec: s.codec_name, canales: Number(s.channels) || 0, ...etiquetasPista(s.tags) })),
              });
            },
          ),
        ),
    );
    p.then((m) => anotarDuracion(key, m.duracion), () => medios.delete(key));
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

// ---- 4K y HDR ----
// Convertir un 4K a H.264 en 4K, en tiempo real, no lo aguanta ninguna VPS normal (iba a
// tirones). Se convierte a 1080p como mucho (VISOR_MAX_ALTO) y, si es HDR, se pasan los colores
// a normales (SDR) para que no se vea grisáceo en aparatos sin HDR. Si el vídeo no se convierte
// (H.264 normal), va tal cual en su resolución.
const filtrosFfmpeg = await new Promise((ok) => execFile('ffmpeg', ['-hide_banner', '-filters'], { maxBuffer: 1e7 }, (e, out) => ok(out || '')));
// Cómo se pasan los colores HDR a normales: «tonemapx» (el ffmpeg de Jellyfin, rápido, con
// instrucciones SIMD), «zscale» (zscale + tonemap, más lento) o nada (se ve algo grisáceo)
const MODOS_TONEMAP = [
  /\stonemapx\s/.test(filtrosFfmpeg) && 'tonemapx',
  /\szscale\s/.test(filtrosFfmpeg) && /\stonemap\s/.test(filtrosFfmpeg) && 'zscale',
].filter(Boolean);
let TONEMAP = MODOS_TONEMAP[0] || null;
let HAY_TONEMAP = !!TONEMAP;
// Al arrancar, prueba la cadena completa con 2 s de imagen 4K HDR inventada: si un modo falla
// se pasa al siguiente, y si fallan todos se convierte sin pasar los colores (mejor algo
// grisáceo que no verlo). Mide a cuántas imágenes por segundo lo hace este servidor (sale en
// /api/salud; por debajo de ~30 iría a tirones)
const pruebaVideo = { estado: 'probando' };
setTimeout(() => {
  const prueba = (hdr) => new Promise((ok) => {
    const t0 = Date.now();
    const { filtro } = filtroVideo({ ancho: 3840, alto: 2160, hdr: hdr ? 'pq' : null });
    execFile('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=24:duration=2', '-vf', `format=yuv420p10le,${filtro}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-f', 'null', '-'], { timeout: 120000 },
    (e, _o, err) => ok(e ? { error: String(err || e.message).trim().split('\n').pop() } : { fps: Math.round(48000 / (Date.now() - t0)) }));
  });
  (async () => {
    for (const modo of MODOS_TONEMAP) {
      TONEMAP = modo;
      const r = await prueba(true);
      if (!r.error) { pruebaVideo.hdr = r.fps; pruebaVideo.modoHdr = modo; break; }
      console.error(`4K HDR: la conversión de colores con ${modo} falla (${r.error})`);
      TONEMAP = null;
    }
    HAY_TONEMAP = !!TONEMAP;
    const r = await prueba(false);
    Object.assign(pruebaVideo, { estado: r.error ? 'error' : 'ok', '4k': r.fps ?? null, ...(r.error && { error: r.error }) });
  })();
}, 20000).unref?.();
const MAX_ALTO = Math.min(2160, Math.max(480, Number(process.env.VISOR_MAX_ALTO) || 1080));
const MAX_ANCHO = Math.round((MAX_ALTO * 16) / 9);
function filtroVideo(info) {
  const f = [];
  const grande = info.ancho > MAX_ANCHO || info.alto > MAX_ALTO;
  // (se reduce antes de convertir los colores: así esa parte trabaja con 4 veces menos píxeles)
  // (bilinear: casi igual de nítido al reducir y bastante más rápido que bicubic)
  if (grande) f.push(`scale=w=${MAX_ANCHO}:h=${MAX_ALTO}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bilinear`);
  const tin = info.hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  if (info.hdr && TONEMAP === 'tonemapx') {
    // (setparams: muchos archivos no dicen bien sus colores; tonemapx los lee de cada imagen)
    f.push(`setparams=color_primaries=bt2020:color_trc=${tin}:colorspace=bt2020nc:range=tv`,
      'tonemapx=tonemap=bt2390:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=yuv420p');
  } else if (info.hdr && TONEMAP === 'zscale') {
    f.push(`zscale=tin=${tin}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100`, 'format=gbrpf32le', 'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  f.push('format=yuv420p');
  return { filtro: f.join(','), pesado: grande || !!info.hdr };
}
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
  let desde = Math.max(0, Math.floor(Number(p.get('desde')) || 0));
  let margen = Math.min(30, Math.max(0, Number(p.get('margen')) || 0));
  const info = await medio(key);
  // Sin pista de imagen (p. ej. solo el audio de un vídeo, o un archivo incompleto) no hay nada que
  // preparar: se dice claro en vez de mostrar el error de ffmpeg
  if (!info.video) throw Object.assign(new Error('Este archivo no tiene imagen (solo audio o está incompleto): hay que volver a subir el vídeo completo'), { status: 422 });
  const audio = Math.min(Math.max(0, Number(p.get('audio')) || 0), Math.max(0, info.audios.length - 1));
  // (por e2rapido: a varias conexiones; con VISOR_E2_RAPIDO=0, directo de e2 como antes)
  const url = process.env.VISOR_E2_RAPIDO === '0' ? await firmar(key, { segundos: 12 * 3600 }) : await direccionInterna(key);
  const id = randomUUID();
  const carpeta = path.join(DIR_HLS, id);
  await mkdir(carpeta, { recursive: true });
  // HEVC (H.265) en un aparato que lo decodifica (casi todas las Android TV / Google TV): la
  // imagen se copia tal cual en trozos fMP4, sin volver a codificarla. Arranca antes, no se
  // queda atrás y conserva la calidad; el servidor apenas trabaja. Si no, se pasa a H.264.
  // APAGADO (2026-11-06): en las teles el audio y la imagen se desincronizaban. Solo con
  // VISOR_HEVC_COPIA=1 en el servidor; si no, el HEVC se convierte a H.264 como siempre.
  const copiaHevc = process.env.VISOR_HEVC_COPIA === '1' && info.video === 'hevc' && p.get('hevc') === '1';
  const copiaVideo = VIDEO_NATIVO.includes(info.video) || copiaHevc;
  const { filtro, pesado } = filtroVideo(info);
  // Un 4K/HDR tarda más en convertirse: en vez de esperar 20 s de margen hacia atrás antes de
  // arrancar, se empieza 4 s antes del punto pedido (arranca mucho antes)
  if (!copiaVideo && pesado && margen > 4) { desde += margen - 4; margen = 4; }
  // Si hay que convertir la imagen y el servidor ya está convirtiendo otro vídeo (o este es
  // 4K/HDR), un ajuste de x264 más rápido: un poco menos de calidad por megabyte, pero va por
  // delante de la reproducción en vez de quedarse atrás (y pararse)
  const convirtiendo = [...sesionesHls.values()].filter((s) => s.convierte && s.ff.exitCode === null).length;
  const preset = process.env.VISOR_PRESET || (pesado || convirtiendo >= 1 ? 'superfast' : 'veryfast');
  const args = [
    // -multiple_requests reutiliza la conexión con e2 al buscar el minuto (salta el doble de rápido)
    // -reconnect…: si e2 corta la conexión a mitad de película, ffmpeg la retoma donde iba
    // -progress: cada 2 s dice a qué velocidad va (para saber si va por delante del vídeo)
    '-v', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '2',
    '-readrate', '3', ...RAFAGA, '-multiple_requests', '1',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10',
    '-ss', String(desde), '-i', url,
    // «?»: si una pista no está donde decía ffprobe, se sigue sin ella en vez de fallar
    '-map', '0:v:0', ...(info.audios.length ? ['-map', `0:a:${audio}?`] : []),
    ...(copiaVideo
      ? ['-c:v', 'copy', ...(copiaHevc ? ['-tag:v', 'hvc1'] : [])]
      // Fotograma clave justo cada 4 s (cada trozo empieza en uno: saltar es más fino) y tope de
      // caudal, para que una escena con mucho movimiento no pida de golpe más de lo que da la wifi
      : ['-vf', filtro, '-c:v', 'libx264', '-preset', preset, '-crf', '21', '-maxrate', '10M', '-bufsize', '20M',
        '-profile:v', 'high', '-force_key_frames', 'expr:gte(t,n_forced*4)']),
    // El AAC estéreo se copia; el 5.1/7.1 (aunque sea AAC) se pasa a estéreo: muchas teles
    // Android no lo decodifican y se queda sin sonido
    ...(info.audios[audio]?.codec === 'aac' && (info.audios[audio]?.canales || 2) <= 2 ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '192k']),
    '-sn',
    // Copiando la imagen, ffmpeg la empieza en el fotograma clave anterior al segundo pedido y el
    // sonido justo en ese segundo: en fMP4 cada pista se ponía a cero por su cuenta y se
    // desincronizaban. Así se desplazan las dos lo mismo y siguen a la par.
    ...(copiaHevc ? ['-avoid_negative_ts', 'make_zero'] : []),
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    ...(copiaHevc
      ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(carpeta, 's%05d.m4s')]
      : ['-hls_segment_filename', path.join(carpeta, 's%05d.ts')]),
    path.join(carpeta, 'index.m3u8'),
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const sesion = {
    ff, carpeta, ultimo: Date.now(), errores: '', usuario: quien?.cuenta.usuario,
    convierte: !copiaVideo, preset: copiaVideo ? 'copia' : preset, inicio: Date.now(), velocidad: null, avisado: false,
    tipo: `${info.video || '?'} ${info.resolucion || ''}`.trim(),
  };
  sesionesHls.set(id, sesion);
  ff.stderr.on('data', (d) => (sesion.errores = (sesion.errores + d).slice(-2000)));
  // Velocidad de la conversión (1x = tan rápido como se ve; por debajo, el vídeo acaba parándose)
  let resto = '';
  ff.stdout.on('data', (d) => {
    resto += d;
    const lineas = resto.split('\n'); resto = lineas.pop();
    for (const l of lineas) {
      const v = l.match(/^speed=\s*([\d.]+)x/);
      if (!v) continue;
      sesion.velocidad = Number(v[1]);
      // Tras el arranque (que va a ráfagas), si va más lento que el vídeo se deja anotado
      if (!sesion.avisado && Date.now() - sesion.inicio > 40000 && sesion.velocidad < 1) {
        sesion.avisado = true;
        console.warn(`Conversión lenta: ${sesion.velocidad}x (${sesion.tipo}, ${sesion.preset}, ${[...sesionesHls.values()].filter((s) => s.ff.exitCode === null).length} vídeos a la vez)`);
      }
    }
  });
  ff.on('close', (code) => code && sesion.errores && console.error(`ffmpeg (${key} @${desde}s): ${sesion.errores.trim().slice(-300)}`));

  // Espera a que la lista cubra los segundos pedidos («margen»: el cliente empieza un poco
  // antes del punto elegido para poder retroceder sin volver a preparar) y unos 10 s más de
  // colchón, para que un bache al empezar no pare la imagen (si tarda, con 2 s basta)
  for (let i = 0; i < 150; i++) {
    const lista = await readFile(path.join(carpeta, 'index.m3u8'), 'utf8').catch(() => '');
    const preparado = [...lista.matchAll(/#EXTINF:([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    const listo = preparado >= margen + 10 || (preparado >= margen + 2 && i >= 30);
    if (preparado > 0 && (listo || ff.exitCode !== null)) return { id, url: `/hls/${id}/index.m3u8`, desde, hevc: copiaHevc };
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
  if (!s || !/^[\w.]+\.(m3u8|ts|m4s|mp4)$/.test(archivo)) throw Object.assign(new Error('Sesión de vídeo caducada'), { status: 404 });
  s.ultimo = Date.now();
  const cuerpo = await readFile(path.join(s.carpeta, archivo));
  const tipo = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', m4s: 'video/iso.segment', mp4: 'video/mp4' }[archivo.split('.').pop()];
  res.writeHead(200, {
    'content-type': tipo,
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
  // Al arrancar (un minuto después, sin prisa): la duración de los vídeos que aún no la tienen
  if (!antes) setTimeout(() => medirLuego([...ahora.keys()]), 60000).unref();
  if (!antes || !hayCambios) return;
  // Cada vídeo que se acaba de subir (o se ha cambiado): su duración y su miniatura al momento,
  // sin esperar a que alguien lo abra
  const videosNuevos = [...nuevos, ...cambiados].filter((k) => esVideo(k));
  medirLuego(videosNuevos, true);
  buscarIntrosLuego(videosNuevos);
  for (const k of videosNuevos.slice(0, 300)) miniatura(k).catch(() => {});
  console.log(`Cambios en e2: ${nuevos.length} nuevos, ${cambiados.length} cambiados, ${borrados.length} borrados`);
  const total = nuevos.length + cambiados.length + borrados.length;
  avisar('cambios', total > MAX_AVISO
    ? { nuevos: nuevos.slice(0, MAX_AVISO), cambiados: [], borrados: [], todo: true, huella }
    : { nuevos, cambiados, borrados, huella });
  prepararFichas(nuevos.filter((k) => esTitulo(k)));
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
// ---------- Plataformas (Netflix, Prime Video, Disney+…) ----------
// Cada título del catálogo, esté en la carpeta que esté, en las plataformas donde se puede ver
// en España (su ficha de TMDB) o en la que diga su carpeta («PELICULAS NETFLIX»). El índice se
// hace en segundo plano y se rehace cuando cambia el contenido; lo de cada título se recuerda
// un día (las plataformas cambian su catálogo).
const plataformasTitulo = new Map(); // clave → { hasta, lista }
const indicePlat = { huella: null, construyendo: null, datos: null };
async function plataformasDeTitulo(t) {
  const c = plataformasTitulo.get(t.key);
  if (c && c.hasta > Date.now()) return c.lista;
  let m = null;
  try { m = t.tipo === 'carpeta' ? await meta.deCarpeta(t.key) : await meta.deArchivo(t.key); } catch (e) {}
  const lista = [...new Set([...meta.plataformasDeRuta(t.key), ...(m?.plataformas ?? [])])];
  // (sin ficha todavía, p. ej. TMDB caído: se vuelve a mirar en 10 minutos, no en un día)
  plataformasTitulo.set(t.key, { hasta: Date.now() + (m?.encontrado ? 24 * 3600000 : 600000), lista });
  return lista;
}
async function construirPlataformas() {
  const c = await catalogoEntero();
  // Solo películas (vídeos sueltos): las series no salen en las plataformas
  const titulos = c.carpetas.flatMap((x) => x.titulos.filter((t) => t.tipo !== 'carpeta').map((t) => ({ ...t, seccion: x.carpeta })));
  const por = new Map();
  let i = 0;
  const trabajar = async () => {
    while (i < titulos.length) {
      const t = titulos[i++];
      for (const p of await plataformasDeTitulo(t)) {
        if (!por.has(p)) por.set(p, []);
        por.get(p).push(t);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, trabajar));
  const orden = meta.PLATAFORMAS.map(([n]) => n);
  const logos = await meta.logosPlataformas().catch(() => ({}));
  // Primero las conocidas (en su orden: Netflix, Prime Video, Disney+…) y después todas las demás
  // que haya dado TMDB, de la que más títulos tiene a la que menos
  const puesto = (n) => (orden.includes(n) ? orden.indexOf(n) : 1000);
  return [...por]
    .sort((a, b) => puesto(a[0]) - puesto(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0], 'es'))
    .map(([nombre, lista]) => ({
      nombre,
      logo: logos[nombre] ?? null,
      total: lista.length,
      // (para las dos filas de la portada: plataformas con películas y con series)
      peliculas: lista.filter((t) => t.tipo !== 'carpeta').length,
      series: lista.filter((t) => t.tipo === 'carpeta').length,
      titulos: lista.sort((a, b) => new Date(b.fecha) - new Date(a.fecha)),
    }));
}
async function plataformas() {
  if (indicePlat.huella !== huella && !indicePlat.construyendo) {
    const para = huella;
    indicePlat.construyendo = construirPlataformas()
      .then((datos) => { indicePlat.datos = datos; indicePlat.huella = para; })
      .catch((e) => console.error(`Plataformas: ${e.message}`))
      .finally(() => { indicePlat.construyendo = null; });
  }
  // La primera vez se espera un poco; después, lo último hecho mientras se rehace
  if (!indicePlat.datos && indicePlat.construyendo) await Promise.race([indicePlat.construyendo, new Promise((ok) => setTimeout(ok, 8000))]);
  return { preparando: !indicePlat.datos || !!indicePlat.construyendo, plataformas: indicePlat.datos ?? [] };
}
// (se empieza solo a los 2 minutos de arrancar, para que esté listo cuando alguien entre)
setTimeout(() => plataformas().catch(() => {}), 120000).unref();

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
    // (los .url/.strm de enlaces de vídeo también son títulos: se ven igual en la portada)
    if (!esTitulo(o.key)) continue;
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

// ---------- Listas de la portada: tendencias, mejor valoradas y populares ----------
// Con las fichas de TMDB de todo el catálogo (películas: vídeos sueltos; series: carpetas), por
// separado para películas y series. Se hacen una vez por cada estado del contenido (huella), en
// segundo plano, y mientras se rehacen se sirven las anteriores.
const listas = { huella: null, datos: null, haciendo: null };
const VACIAS = { peliculas: { tendencias: [], valoradas: [], populares: [] }, series: { tendencias: [], valoradas: [], populares: [] } };
async function hacerListas() {
  const h = huella;
  const c = await catalogo(0);
  const titulos = c.carpetas.flatMap((x) => x.titulos);
  const con = [];
  let n = 0;
  // De 4 en 4: las fichas ya conocidas salen de la caché; las nuevas, de TMDB sin saturarlo
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (n < titulos.length) {
      const t = titulos[n++];
      const m = await (t.tipo === 'carpeta' ? meta.deCarpeta(t.key) : meta.deArchivo(t.key)).catch(() => null);
      if (m?.encontrado && m.poster && !m.episodio) con.push({ t, m });
    }
  }));
  // Un mismo título en dos secciones: solo una vez (el más nuevo)
  const vistos = new Map();
  for (const x of con) {
    const id = `${x.t.tipo}:${x.m.fuente || ''}:${x.m.tmdbId ?? x.m.id ?? x.m.titulo}`;
    const otro = vistos.get(id);
    if (!otro || otro.t.fecha < x.t.fecha) vistos.set(id, x);
  }
  const tarjeta = ({ t, m }) => ({
    tipo: t.tipo, key: t.key, fecha: t.fecha, tamano: t.tamano, ultimo: t.ultimo,
    titulo: m.titulo, poster: m.poster, anio: m.anio || '', valoracion: m.valoracion ?? null,
    temporadas: m.temporadas ?? null, serie: m.tipo === 'serie',
  });
  const este = new Date().getFullYear();
  const pop = (x) => x.m.popularidad ?? 0;
  const hacer = (lista) => {
    const porPopularidad = [...lista].sort((a, b) => pop(b) - pop(a) || b.t.fecha - a.t.fecha);
    // Tendencias: lo más popular de estos dos años (si no llega a 10, lo más popular sin más)
    const recientes = porPopularidad.filter((x) => Number(x.m.anio) >= este - 1);
    const tendencias = [...recientes, ...porPopularidad.filter((x) => !recientes.includes(x))].slice(0, 10);
    const enTendencias = new Set(tendencias);
    return {
      tendencias: tendencias.map(tarjeta),
      // Mejor valoradas: con votos suficientes para que la nota signifique algo
      valoradas: lista.filter((x) => x.m.valoracion && (x.m.votos ?? 100) >= 30)
        .sort((a, b) => b.m.valoracion - a.m.valoracion || pop(b) - pop(a)).slice(0, 20).map(tarjeta),
      populares: porPopularidad.filter((x) => !enTendencias.has(x)).slice(0, 20).map(tarjeta),
    };
  };
  const todos = [...vistos.values()];
  listas.datos = { peliculas: hacer(todos.filter((x) => x.t.tipo === 'archivo')), series: hacer(todos.filter((x) => x.t.tipo === 'carpeta')) };
  listas.huella = h;
  return listas.datos;
}
async function listasPortada() {
  if (listas.datos && listas.huella === huella) return listas.datos;
  if (!listas.haciendo) listas.haciendo = hacerListas().catch((e) => { console.error(`Listas de la portada: ${e.message}`); return null; }).finally(() => { listas.haciendo = null; });
  if (listas.datos) return listas.datos;
  // La primera vez se espera (como mucho 25 s; si no, vacías y estarán en la próxima visita)
  return (await Promise.race([listas.haciendo, new Promise((ok) => setTimeout(() => ok(null), 25000))])) ?? VACIAS;
}
// Se preparan poco después de arrancar, para que la primera visita ya las tenga
setTimeout(() => listasPortada().catch(() => {}), 90000).unref();

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
  // Avisos del reproductor activos (texto y enlace; sin datos de nadie)
  '/api/avisos-reproductor': () => avisosReproductor.filter((a) => a.activo).map(({ id, texto, enlace, boton }) => ({ id, texto, enlace, boton })),
  '/api/meta': async (p) => conDuracion(p.get('key'), await meta.deArchivo(p.get('key'))),
  '/api/metas': async (p) => {
    const keys = p.getAll('key').slice(0, 30);
    if (keys.some((k) => prohibido(k))) throw Object.assign(new Error('No'), { status: 403 });
    return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, conDuracion(k, await meta.deArchivo(k).catch(() => null))])));
  },
  '/api/meta-carpeta': (p) => meta.deCarpeta(p.get('prefijo'), (pre) => {
    const videos = foto ? [...foto.keys()].filter((k) => k.startsWith(pre) && esVideo(k)) : [];
    // Al abrir una temporada, se miden (en segundo plano) los capítulos que aún no tienen duración
    medirLuego(videos, true);
    buscarIntrosLuego(videos);
    for (const k of videos.slice(0, 300)) if (!existsSync(archivoMiniatura(k))) miniatura(k).catch(() => {});
    return videos.length;
  }),
  '/api/portada': (p) => meta.portadaCategoria(p.get('cat')),
  '/api/listas-portada': () => listasPortada(),
  // Con «seccion»: el catálogo completo de esa sección (todas sus películas y series, también las
  // de sus subcarpetas que solo agrupan), para verla entera de una vez
  '/api/catalogo': async (p) => {
    const seccion = p.get('seccion');
    if (!seccion) return catalogo(p.get('max'));
    if (prohibido(seccion) || !/^[^/]+\/$/.test(seccion)) throw Object.assign(new Error('Sección no válida'), { status: 400 });
    const c = await catalogo(0);
    return { seccion, titulos: c.carpetas.find((x) => x.carpeta === seccion)?.titulos ?? [] };
  },
  '/api/plataformas': () => plataformas(),
  // Corregir la ficha de un vídeo o una serie: solo administradores (afecta a todo el mundo)
  '/api/tmdb-buscar': async (p, req, quien) => {
    if (!quien.admin) throw Object.assign(new Error('Solo los administradores pueden corregir fichas'), { status: 403 });
    const fuente = p.get('fuente') || 'tmdb';
    if (fuente === 'tmdb') return meta.buscar(p.get('q'), p.get('tipo') || undefined);
    const lista = await meta.buscarParaSubir(String(p.get('q') ?? ''), fuente);
    return p.get('tipo') ? lista.filter((r) => r.tipo === p.get('tipo')) : lista;
  },
  '/api/corregir': (p, req, quien) => {
    if (!quien.admin) throw Object.assign(new Error('Solo los administradores pueden corregir fichas'), { status: 403 });
    const fuente = p.get('fuente') || 'tmdb';
    return meta.corregir(meta.claveDe(p.get('key')), p.get('tmdbId'), p.get('tipo'), fuente !== 'tmdb' ? { fuente, id: p.get('id') } : null);
  },
  '/api/hls': (p, req, quien) => { defensa.permitirVideo(quien.cuenta, quien.ip, p.get('key'), quien.admin); return hlsIniciar(p, quien); },
  '/api/hls-parar': (p) => hlsParar(p.get('id')),
  '/api/medio': async (p) => ({ ...(await medio(p.get('key'))), nombresAudio: await nombresAudioDe(p.get('key') ?? ''), audioNativo: AUDIO_NATIVO, videoNativo: VIDEO_NATIVO }),
  '/api/audio-nombres': (p, req, quien) => guardarNombresAudio(req, quien),
  '/api/info': () => ({ bucket: E2_BUCKET }),
  '/api/listar': (p) => listar(p.get('prefijo') ?? '', p.get('token')),
  '/api/buscar': (p) => buscar(p.get('prefijo') ?? '', p.get('q') ?? '', Math.min(50, Number(p.get('azar')) || 0)),
  '/api/tamano': (p) => tamano(p.get('prefijo') ?? ''),
  '/api/url': async (p, req, quien) => {
    if (esVideo(p.get('key') ?? '')) defensa.permitirVideo(quien.cuenta, quien.ip, p.get('key'), quien.admin);
    return { url: await firmar(p.get('key')) };
  },
  '/api/texto': (p) => texto(p.get('key')),
  '/api/enlace': (p) => enlace(p.get('key'), p.get('opcion')),
};

const tipos = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
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
  // Minificado: pesa la mitad y el móvil o la tele lo analiza antes. Los nombres de primer nivel
  // se conservan (los archivos comparten funciones entre sí)
  const { code } = await transform(await readFile(fichero, 'utf8'), { target: ['chrome56', 'safari12'], loader: 'js', minify: true, legalComments: 'none' });
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
  const ficheros = ['server.js', 'metadatos.js', 'perfiles.js', 'acceso.js', 'telegram.js', 'xtream.js', 'panel.js', 'defensa.js', 'pagos.js', 'intros.js', 'enlaces.js', 'enlaces-video.js', 'e2rapido.js', 'fichas/fichas.json', ...readdirSync(path.join(dir, 'public')).sort().map((f) => `public/${f}`)];
  for (const f of ficheros) { h.update(f); h.update(readFileSync(path.join(dir, f))); }
  return h.digest('hex').slice(0, 10);
})();
const CON_VERSION = /(src|href)="(polyfills\.js|intro\.css|intro\.js|app\.js|perfiles\.js)"/g;

// Las respuestas grandes (catálogo, listados) van comprimidas: con mucho contenido pesan 5-10
// veces menos y la tele o el móvil las reciben antes. Brotli si el navegador lo entiende (pesa
// ~20 % menos que gzip) y siempre fuera del hilo principal, para no frenar a los demás.
const gzipA = promisify(gzip), brotliA = promisify(brotliCompress);
const COMPRIMIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/;
function codificacion(res) {
  const a = String(res.req?.headers['accept-encoding'] ?? '');
  return /\bbr\b/.test(a) ? 'br' : /\bgzip\b/.test(a) ? 'gzip' : null;
}
// fijo = archivo que no cambia hasta la próxima versión: se comprime al máximo una sola vez
const comprimir = (buf, cod, fijo) => (cod === 'br'
  ? brotliA(buf, { params: { [zlibC.BROTLI_PARAM_QUALITY]: fijo ? 11 : 4, [zlibC.BROTLI_PARAM_SIZE_HINT]: buf.length } })
  : gzipA(buf, { level: fijo ? 9 : 5 }));
async function enviar(res, status, cabeceras, cuerpo) {
  const buf = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo);
  const cod = buf.length > 1024 && COMPRIMIBLE.test(cabeceras['content-type'] ?? '') && codificacion(res);
  if (cod) {
    try {
      const z = await comprimir(buf, cod, false);
      if (res.headersSent) return;
      res.writeHead(status, { ...cabeceras, 'content-encoding': cod, vary: 'accept-encoding' });
      return res.end(z);
    } catch {}
  }
  if (res.headersSent) return;
  res.writeHead(status, cabeceras);
  res.end(buf);
}

// Archivos de la app (js, css, iconos): se preparan una vez (compilados y comprimidos) y se
// guardan en memoria. Los que la página pide con «?v=versión» se quedan en la caché del
// navegador para siempre (la versión cambia con cada publicación), así que abrir la app ya no
// descarga nada; el resto se revalida con su huella (ETag) y, si no cambió, no viaja nada.
const preparados = new Map(); // fichero → { mtimeMs, tipo, etag, crudo, br, gzip }
async function preparado(fichero, tipo) {
  const { mtimeMs } = await stat(fichero);
  let p = preparados.get(fichero);
  if (p?.mtimeMs !== mtimeMs) {
    const crudo = fichero.endsWith('.js') && fichero.includes(`${path.sep}public${path.sep}`) ? Buffer.from(await js(fichero)) : await readFile(fichero);
    p = { mtimeMs, tipo, crudo, etag: `"${createHash('sha1').update(crudo).digest('base64url').slice(0, 16)}"` };
    preparados.set(fichero, p);
  }
  return p;
}
async function servirFijo(req, res, fichero, tipo, cache) {
  const p = await preparado(fichero, tipo);
  const cab = { 'content-type': tipo, 'cache-control': cache, etag: p.etag, vary: 'accept-encoding' };
  if (req.headers['if-none-match'] === p.etag) { res.writeHead(304, cab); return res.end(); }
  const cod = p.crudo.length > 1024 && COMPRIMIBLE.test(tipo) && codificacion(res);
  if (cod) {
    p[cod] = p[cod] || comprimir(p.crudo, cod, true).catch(() => null);
    const z = await p[cod];
    if (z) { res.writeHead(200, { ...cab, 'content-encoding': cod, 'content-length': z.length }); return res.end(z); }
  }
  res.writeHead(200, { ...cab, 'content-length': p.crudo.length });
  res.end(p.crudo);
}
// Al arrancar se deja todo listo, para que el primer visitante no espere a compilar ni comprimir
async function precalentar() {
  for (const f of ['app.js', 'perfiles.js', 'intro.js', 'polyfills.js', 'intro.css']) {
    const p = await preparado(path.join(dir, 'public', f), tipos[path.extname(f)]).catch(() => null);
    if (p) { p.br = comprimir(p.crudo, 'br', true).catch(() => null); p.gzip = comprimir(p.crudo, 'gzip', true).catch(() => null); await p.br; }
  }
}
const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const json = (res, status, datos) => enviar(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(datos));

// La app de Android: dónde se descarga y qué versión es la última (la publica GitHub Actions en
// version.json). Se mira cada hora en segundo plano: la portada nunca espera por ello.
const APK_URL = process.env.VISOR_APK_URL || 'https://github.com/saitamaeditor/morvehtv-visor/releases/latest/download/MorvehTV.apk';
const apk = { version: null, hasta: 0 };
function versionApk() {
  if (Date.now() > apk.hasta) {
    apk.hasta = Date.now() + 3600000;
    fetch(APK_URL.replace(/MorvehTV\.apk$/, 'version.json'), { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json()).then((d) => { if (/^[\w.-]{1,20}$/.test(String(d.versionName ?? ''))) apk.version = String(d.versionName); })
      .catch(() => { apk.hasta = Date.now() + 300000; });
  }
  return apk.version;
}
versionApk();

// Lo que se puede abrir sin haber entrado: la pantalla de entrada y los iconos
const PUBLICO = ['/entrar.html', '/manifest.webmanifest', '/icono-192.png', '/icono-512.png', '/icono.svg'];

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Lectura interna de ffmpeg (solo desde la propia máquina; no pasa por límites ni sesión)
    if (url.pathname.startsWith('/_e2/')) {
      const l = esLocal(req) && lecturasInternas.get(url.pathname.slice(5));
      if (!l || l.hasta < Date.now()) { res.writeHead(404); return res.end(); }
      return servirRango(req, res, l.url, l.tam, 'application/octet-stream').catch(() => res.destroy());
    }
    defensa.cabeceras(res, acceso.NUBE);
    try {
      const permiso = acceso.permiso(req);
      if (permiso === 'fuera') return json(res, 403, { error: 'Solo se puede entrar desde la red de casa' });
      const ip = acceso.ipDe(req);
      // Límite de peticiones por conexión (Render lo comprueba en /api/salud: esa no cuenta)
      if (url.pathname !== '/api/salud') { defensa.limitar(ip, url.pathname); ultimaVisita = Date.now(); }
      // Bots: el enlace trampa los bloquea; las herramientas de extracción no pasan de aquí
      // (salvo lo que tienen que leer programas: comprobaciones, ads.txt, Ko-fi y los reproductores)
      if (url.pathname === defensa.TRAMPA) { defensa.atrapar(ip, 'enlace oculto'); return json(res, 404, { error: 'No existe' }); }
      if (url.pathname === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=3600' });
        return res.end(`User-agent: *\nAllow: /entrar.html\nAllow: /ads.txt\nDisallow: /\nDisallow: ${defensa.TRAMPA}\n`);
      }
      const paraProgramas = ['/api/salud', '/ads.txt', '/apk', '/api/kofi/webhook'].includes(url.pathname) || (xtream.esRuta(url.pathname) && process.env.XTREAM_ACTIVO === '1');
      if (!paraProgramas && defensa.esBot(req)) return json(res, 403, { error: 'Acceso automático no permitido' });
      // ads.txt de la red de anuncios (público: lo lee su rastreador)
      if (url.pathname === '/ads.txt') {
        const t = pagos.adsTxt();
        if (!t) return json(res, 404, { error: 'Sin ads.txt' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=3600' });
        return res.end(t);
      }
      // Dirección corta para instalar la app en la tele (en «Downloader» se escribe morvehtv.com/apk)
      if (url.pathname === '/apk') {
        res.writeHead(302, { location: APK_URL, 'cache-control': 'no-store' });
        return res.end();
      }
      // Aviso de pago de Ko-fi (lo manda Ko-fi, sin sesión: se comprueba con su token)
      if (url.pathname === '/api/kofi/webhook') return await pagos.webhookKofi(req, res, json);
      // El banner de la red de anuncios, dentro de un marco aislado de la propia web: es la única
      // página que se deja enmarcar (solo por MorvehTV) y que dice a la red desde qué web se ve
      // (solo el dominio: así la red comprueba que es la web dada de alta)
      if (url.pathname === '/marco-previo.html') {
        const pagina = pagos.paginaBanner();
        if (!pagina) return json(res, 404, { error: 'Sin banner' });
        res.setHeader('x-frame-options', 'SAMEORIGIN');
        res.setHeader('content-security-policy', "frame-ancestors 'self'; base-uri 'none'; object-src 'none'");
        res.setHeader('referrer-policy', 'origin');
        return enviar(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, pagina);
      }
      // Para que Render sepa que está viva
      if (url.pathname === '/api/salud') return json(res, 200, { ok: true, version: VERSION, mantenimiento: (await enMantenimiento()).activo, intros: estadoIntros, arranque: ARRANQUE, perfiles: perfiles.escritura, telegram: telegram.estado, tmdb: await meta.saludTmdb(), pagos: pagos.estado, video: { maxAlto: MAX_ALTO, hdrASdr: HAY_TONEMAP && TONEMAP, nucleos: os.cpus().length, carga: os.loadavg().map((x) => Math.round(x * 10) / 10), prueba: pruebaVideo,
        // Lo que se está preparando ahora (sin nombres ni de quién): velocidad (1x = tan rápido como se ve)
        sesiones: [...sesionesHls.values()].filter((s) => s.ff.exitCode === null).map((s) => ({ tipo: s.tipo, preset: s.preset, velocidad: s.velocidad, minutos: Math.round((Date.now() - s.inicio) / 6000) / 10 })),
        // Vídeo directo (MP4 por /flujo) y lo que lee ffmpeg: a varias conexiones con e2
        lectura: lecturaE2 } });
      // Panel de gestión: otra web, entra con su token (y CORS solo para ella)
      if (panel.esRuta(url.pathname)) return await panel.atender(url.pathname, req, res, json, acceso.ipDe(req));
      // Reproductores tipo Xtream: entran con usuario y contraseña en cada petición, sin cookie
      // (apagados: ninguna app de IPTV puede entrar; con XTREAM_ACTIVO=1 vuelven a funcionar)
      if (xtream.esRuta(url.pathname) && process.env.XTREAM_ACTIVO !== '1') return json(res, 404, { error: 'No disponible' });
      if (xtream.esRuta(url.pathname)) return await xtream.atender(url.pathname, req, res, json, { ip: acceso.ipDe(req), nube: acceso.NUBE });
      // En mantenimiento: nada de registros y, en vez de la pantalla de entrar, la de mantenimiento
      // (salvo /entrar.html?admin, por donde entran los administradores)
      const mant = await enMantenimiento();
      if (mant.activo && url.pathname === '/api/registro') return json503(res);
      if (mant.activo && url.pathname === '/entrar.html' && !url.searchParams.has('admin')) return paginaMantenimiento(res, mant);
      // Sin sesión solo se llega a la pantalla de entrar o registrarse
      if (perfiles.SIN_SESION.includes(url.pathname)) return await perfiles.atender(url.pathname, req, res, json, acceso.ipDe(req));
      // Carátulas de las fichas escritas a mano (públicas: Telegram las descarga para sus avisos)
      const imagenFicha = url.pathname.match(/^\/fichas\/([\w.-]+\.(?:jpe?g|png|webp))$/i);
      if (imagenFicha) {
        const local = path.join(dir, 'fichas', imagenFicha[1]);
        if (existsSync(local)) return await servirFijo(req, res, local, tipos[path.extname(imagenFicha[1]).toLowerCase()], 'public, max-age=86400');
        const img = await imagenFichaE2(imagenFicha[1]);
        if (!img) return json(res, 404, { error: 'No existe' });
        res.writeHead(200, { 'content-type': img.tipo, 'content-length': img.buf.length, 'cache-control': 'public, max-age=86400' });
        return res.end(img.buf);
      }
      const cuenta = PUBLICO.includes(url.pathname) ? null : await perfiles.sesion(req);
      if (!PUBLICO.includes(url.pathname) && !cuenta) {
        // Para ver qué piden las apps externas que no aciertan con las direcciones de Xtream (solo la
        // ruta, sin la parte «?…» que puede llevar la contraseña, y sin IP); los navegadores no
        const ua = String(req.headers['user-agent'] ?? '');
        if (!/Mozilla|bot|crawl|spider/i.test(ua)) console.log(`Sin sesión: ${req.method} ${url.pathname.slice(0, 80)} · app ${ua.slice(0, 80) || '¿?'}`);
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hls/')) return json(res, 401, { error: 'Inicia sesión' });
        res.writeHead(302, { location: '/entrar.html', 'cache-control': 'no-store' });
        return res.end();
      }
      // Con sesión pero sin ser administrador, durante el mantenimiento no se ve nada (salvo
      // cerrar sesión, que va antes, y los iconos)
      if (mant.activo && cuenta && !PUBLICO.includes(url.pathname) && !(await perfiles.esAdmin(cuenta))) {
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hls/') || url.pathname.startsWith('/vendor/')) return json503(res);
        return paginaMantenimiento(res, mant);
      }

      // Vídeo directo (MP4) para el reproductor, a través del servidor y a varias conexiones con
      // e2: así no se para aunque e2 limite cada conexión. (El permiso de ver el vídeo se comprueba
      // en /api/url, que el reproductor pide antes.)
      if (url.pathname === '/flujo') {
        const key = url.searchParams.get('key') ?? '';
        if (!esVideo(key) || prohibido(key) || esInterna(key)) return json(res, 404, { error: 'No existe' });
        return await servirRango(req, res, await firmar(key), await tamDe(key), TIPO_VIDEO[key.split('.').pop().toLowerCase()] || 'application/octet-stream');
      }
      if (url.pathname === '/api/eventos') return eventos(req, res, cuenta);
      if (perfiles.RUTAS.includes(url.pathname)) return await perfiles.atender(url.pathname, req, res, json, acceso.ipDe(req));
      if (pagos.RUTAS.includes(url.pathname)) return await pagos.atender(url.pathname, req, res, json, cuenta);
      if (url.pathname === '/api/intro') {
        const key = url.searchParams.get('key') ?? '';
        if (!esVideo(key) || prohibido(key)) return json(res, 404, { error: 'No existe' });
        const i = introDe(key);
        if (i === undefined) buscarIntrosLuego([key]);
        return json(res, 200, i ? { inicio: i.inicio, fin: i.fin } : { inicio: null, pendiente: i === undefined && hayHuellas });
      }
      if (url.pathname === '/api/miniatura') {
        const key = url.searchParams.get('key') ?? '';
        if (!esVideo(key) || prohibido(key) || esInterna(key)) return json(res, 404, { error: 'No existe' });
        const fichero = await miniatura(key).catch(() => null);
        if (!fichero) return json(res, 404, { error: 'No se pudo sacar la imagen' });
        return await servirFijo(req, res, fichero, 'image/jpeg', 'private, max-age=2592000, immutable');
      }
      const hls = url.pathname.match(/^\/hls\/([\w-]+)\/([^/]+)$/);
      if (hls) return await hlsServir(res, hls[1], hls[2]);
      const ruta = rutas[url.pathname];
      if (ruta && (prohibido(url.searchParams.get('key')) || prohibido(url.searchParams.get('prefijo')))) {
        return json(res, 403, { error: 'Esta carpeta no se puede ver desde internet' });
      }
      if (ruta) return json(res, 200, await ruta(url.searchParams, req, { cuenta, ip, admin: await perfiles.esAdmin(cuenta) }));

      if (VENDOR[url.pathname]) {
        return await servirFijo(req, res, path.join(dir, VENDOR[url.pathname]), tipos['.js'], 'public, max-age=604800');
      }
      const fichero = path.join(dir, 'public', url.pathname === '/' ? 'index.html' : path.normalize(decodeURIComponent(url.pathname)));
      if (!fichero.startsWith(path.join(dir, 'public'))) throw Object.assign(new Error('No'), { status: 403 });
      const ext = path.extname(fichero);
      // La página nunca se guarda en caché y enlaza sus archivos con la versión
      if (ext === '.html') {
        let html = (await readFile(fichero, 'utf8')).replace(CON_VERSION, `$1="$2?v=${VERSION}"`);
        // La oferta VIP del registro, solo con los pagos activados (y con su precio)
        if (url.pathname === '/entrar.html') {
          html = pagos.activo
            ? html.replace(/<!--\/?PAGOS-->/g, '').replace(/\{\{PRECIO\}\}/g, escHtml((await pagos.precioTexto().catch(() => null)) || 'un pago único'))
            : html.replace(/<!--PAGOS-->[\s\S]*?<!--\/PAGOS-->/g, '');
          // Los planes VIP de la ventana «Acceso VIP» (el más largo, marcado como el que más compensa)
          const planes = pagos.planesPortada();
          const mejor = planes.reduce((m, x) => (!m || x.meses > m.meses ? x : m), null);
          html = html.replace('{{PLANES_VIP}}', planes.map((x) => `<button type="button" class="plan${x === mejor && planes.length > 1 ? ' mejor' : ''}" data-plan="${escHtml(x.id)}" data-nombre="${escHtml(`${x.titulo} · ${x.precio}`)}">`
            + `${x === mejor && planes.length > 1 ? '<em>El que más compensa</em>' : ''}<b>${escHtml(x.titulo)}</b><strong>${escHtml(x.precio)}</strong><small>Pago único</small></button>`).join(''));
          // La portada con los datos de verdad: versión de la app de Android y grupo de Telegram
          const version = versionApk();
          html = version ? html.replace(/<!--\/?CONVERSION-->/g, '').replace(/\{\{VERSION_APK\}\}/g, escHtml(version)) : html.replace(/<!--CONVERSION-->[\s\S]*?<!--\/CONVERSION-->/g, '');
          // Turnstile de Cloudflare en el registro, solo si está configurado
          html = defensa.TURNSTILE_SITEKEY
            ? html.replace(/<!--\/?TURNSTILE-->/g, '').replace(/\{\{TURNSTILE\}\}/g, escHtml(defensa.TURNSTILE_SITEKEY))
            : html.replace(/<!--TURNSTILE-->[\s\S]*?<!--\/TURNSTILE-->/g, '');
          const grupo = telegram.invitacion();
          html = grupo ? html.replace(/<!--\/?TELEGRAM-->/g, '').replace(/\{\{TELEGRAM\}\}/g, escHtml(grupo)) : html.replace(/<!--TELEGRAM-->[\s\S]*?<!--\/TELEGRAM-->/g, '');
        }
        return enviar(res, 200, { 'content-type': tipos[ext], 'cache-control': 'no-store' }, html);
      }
      const conVersion = url.searchParams.get('v') === VERSION;
      const cache = conVersion ? 'private, max-age=31536000, immutable'
        : ['.png', '.svg', '.webmanifest'].includes(ext) ? 'public, max-age=604800' : 'no-cache';
      return await servirFijo(req, res, fichero, tipos[ext] ?? 'application/octet-stream', cache);
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
    precalentar().catch(() => {});
  });
