// Subir contenido a IDrive e2 desde el gestor (solo administradores).
// El navegador sube el archivo por trozos DIRECTAMENTE a e2 (no pasa por la VPS ni por Cloudflare):
// este servidor solo abre la subida, firma la dirección de cada trozo (válida 1 hora) y la cierra.
// Las claves de e2 (E2_*) están solo en /etc/morvehtv-cuentas/cuentas.env; el navegador nunca las ve.
// Sin dependencias: la firma de S3 (AWS Signature V4) está hecha aquí con node:crypto.
// Además vigila e2 cada minuto: lo que se suba por cualquier vía se le dice a Emby al momento (abajo).
import { createHmac, createHash, randomBytes } from 'node:crypto';

const ENDPOINT = String(process.env.E2_ENDPOINT ?? '').trim().replace(/\/+$/, '');
const BASE = !ENDPOINT ? '' : /^https?:\/\//.test(ENDPOINT) ? ENDPOINT : `https://${ENDPOINT}`;
const REGION = String(process.env.E2_REGION ?? '').trim() || 'us-east-1';
const BUCKET = String(process.env.E2_BUCKET ?? '').trim();
const ID = String(process.env.E2_ACCESS_KEY_ID ?? '').trim();
const SECRETO = String(process.env.E2_SECRET_ACCESS_KEY ?? '').trim();
// S3: 5 MB mínimo por trozo y 10.000 trozos como mucho (E2_PARTE_MB solo para las pruebas en local)
const MIN_PARTE = Math.max(5, Number(process.env.E2_PARTE_MB) || 64) * 1024 * 1024;
const MAX_TAMANO = 2 * 1024 ** 4;   // 2 TB
const AJUSTE = 'subidas';
const EXTENSIONES = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg|srt|ass|ssa|vtt|sub|idx|sup|jpg|jpeg|png|nfo)$/i;

const error = (status, message) => Object.assign(new Error(message), { status });
export const configurado = () => Boolean(BASE && BUCKET && ID && SECRETO);
let p = null;
let escanear = null;
export let estado = configurado() ? 'iniciando' : 'sin configurar';

// ---------- Firma S3 (AWS Signature V4) ----------
const sha = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
const cod = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const codRuta = (key) => key.split('/').map(cod).join('/');

function firma({ metodo, key = '', query = {}, cabeceras = {}, hashCuerpo = 'UNSIGNED-PAYLOAD', caduca = 0 }) {
  const url = new URL(`${BASE}/${cod(BUCKET)}${key ? `/${codRuta(key)}` : ''}`);
  const fecha = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dia = fecha.slice(0, 8);
  const ambito = `${dia}/${REGION}/s3/aws4_request`;
  const q = { ...query };
  const cab = { host: url.host, ...Object.fromEntries(Object.entries(cabeceras).map(([k, v]) => [k.toLowerCase(), String(v)])) };
  if (caduca) Object.assign(q, { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${ID}/${ambito}`, 'X-Amz-Date': fecha, 'X-Amz-Expires': String(caduca), 'X-Amz-SignedHeaders': 'host' });
  else Object.assign(cab, { 'x-amz-date': fecha, 'x-amz-content-sha256': hashCuerpo });
  const firmadas = caduca ? ['host'] : Object.keys(cab).sort();
  const consulta = Object.keys(q).sort().map((k) => `${cod(k)}=${cod(String(q[k]))}`).join('&');
  const canonica = [metodo, url.pathname, consulta, firmadas.map((k) => `${k}:${cab[k].trim()}\n`).join(''), firmadas.join(';'), hashCuerpo].join('\n');
  const aFirmar = ['AWS4-HMAC-SHA256', fecha, ambito, sha(canonica)].join('\n');
  const clave = hmac(hmac(hmac(hmac(`AWS4${SECRETO}`, dia), REGION), 's3'), 'aws4_request');
  const f = createHmac('sha256', clave).update(aFirmar).digest('hex');
  if (caduca) return `${url.origin}${url.pathname}?${consulta}&X-Amz-Signature=${f}`;
  delete cab.host;
  cab.authorization = `AWS4-HMAC-SHA256 Credential=${ID}/${ambito}, SignedHeaders=${firmadas.join(';')}, Signature=${f}`;
  return { url: `${url.origin}${url.pathname}${consulta ? `?${consulta}` : ''}`, cabeceras: cab };
}

export const __pruebas = { firma };

async function s3(metodo, { key, query, cuerpo = '', cabeceras = {}, tolera = [] } = {}) {
  if (!configurado()) throw error(503, 'La subida a e2 no está configurada en el servidor (faltan las claves E2_*)');
  const datos = Buffer.from(cuerpo);
  const f = firma({ metodo, key, query, cabeceras, hashCuerpo: sha(datos) });
  let r;
  try {
    r = await fetch(f.url, { method: metodo, headers: f.cabeceras, body: datos.length ? datos : undefined, signal: AbortSignal.timeout(30000) });
  } catch (e) { throw error(502, `No se pudo conectar con e2 (${e.name === 'TimeoutError' ? 'no responde' : e.cause?.code || e.message})`); }
  const texto = await r.text();
  if (!r.ok && !tolera.includes(r.status)) {
    const codigo = /<Code>([^<]*)<\/Code>/.exec(texto)?.[1];
    throw error(r.status === 404 ? 404 : 502, `e2 respondió ${r.status}${codigo ? ` (${codigo})` : ''}`);
  }
  return { status: r.status, texto };
}
const xml = (t, etiqueta) => [...t.matchAll(new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`, 'g'))].map((m) => m[1]);
const desXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const aXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- Carpetas ----------
// Subcarpetas de un nivel (sin las internas que empiezan por «_»: papelera, catálogos…)
export async function carpetas(prefijo = '') {
  const pre = limpiarRuta(prefijo, { carpeta: true });
  const salida = []; let token;
  do {
    const { texto } = await s3('GET', { query: { 'list-type': '2', delimiter: '/', prefix: pre, ...(token && { 'continuation-token': token }) } });
    for (const c of xml(texto, 'CommonPrefixes')) {
      const nombre = desXml(xml(c, 'Prefix')[0] ?? '').slice(pre.length).replace(/\/$/, '');
      if (nombre && !nombre.startsWith('_')) salida.push(nombre);
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(texto) ? desXml(xml(texto, 'NextContinuationToken')[0] ?? '') : null;
  } while (token);
  return salida.sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
}

// Comprueba una ruta del bucket: carpeta de primer nivel que ya exista (y no interna), sin «..» ni
// caracteres raros. Devuelve la ruta limpia.
function limpiarRuta(ruta, { carpeta = false } = {}) {
  const r = String(ruta ?? '').normalize('NFC').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  if (!r) return '';
  const partes = r.replace(/\/$/, '').split('/').map((x) => x.trim());
  if (partes.some((x) => !x || x === '.' || x === '..' || /[\u0000-\u001f\u007f]/.test(x) || x.length > 200)) throw error(400, 'Esa ruta no es válida');
  if (partes[0].startsWith('_')) throw error(403, 'No se puede subir a las carpetas internas');
  const limpia = partes.join('/');
  if (Buffer.byteLength(limpia) > 900) throw error(400, 'La ruta es demasiado larga');
  return carpeta ? `${limpia}/` : limpia;
}

// ---------- Subidas (multiparte) ----------
// Las subidas abiertas se guardan en el archivo de datos: si el servidor se reinicia a mitad, siguen
const leer = async () => (await p.leerAjuste(AJUSTE)) ?? {};
const guardar = (s) => p.guardarAjuste(AJUSTE, s);

export async function iniciar(opciones) {
  p = opciones.perfiles;
  escanear = opciones.escanear ?? null;
  avisarEmby = opciones.avisarEmby ?? null;
  if (!configurado()) return;
  setTimeout(limpiarViejas, 30000).unref();
  setInterval(limpiarViejas, 6 * 3600000).unref();
  if (avisarEmby || escanear) {
    setTimeout(vigilar, 5000).unref();
    setInterval(vigilar, VIGILAR).unref();
  }
  try { await ponerCors(opciones.origenes ?? []); estado = 'ok'; } catch (e) { estado = `error: ${e.message}`; console.error(`e2: no se pudo preparar el CORS del bucket (${e.message})`); }
}

// El navegador sube directamente a e2: el bucket tiene que aceptar PUT desde el panel y dejar leer
// la cabecera ETag. Se AÑADE una regla para el panel sin tocar las que ya hubiera.
async function ponerCors(origenes) {
  const local = process.env.NODE_ENV !== 'production'; // pruebas en este ordenador
  const lista = [...new Set(origenes.filter((o) => /^https:\/\//.test(o) || (local && /^http:\/\/localhost(:\d+)?$/.test(o))))];
  if (!lista.length) return;
  const { status, texto } = await s3('GET', { query: { cors: '' }, tolera: [404] });
  const actual = status === 404 ? '' : texto;
  const reglas = xml(actual, 'CORSRule');
  const cubierto = (o) => reglas.some((r) => /<AllowedMethod>PUT<\/AllowedMethod>/.test(r) && /ETag/i.test(r)
    && xml(r, 'AllowedOrigin').some((x) => x === '*' || x === o));
  const faltan = lista.filter((o) => !cubierto(o));
  if (!faltan.length) return;
  const nueva = `<CORSRule><ID>morvehtv-panel</ID>${faltan.map((o) => `<AllowedOrigin>${aXml(o)}</AllowedOrigin>`).join('')}`
    + '<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>'
    + '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>';
  const cuerpo = `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${reglas.map((r) => `<CORSRule>${r}</CORSRule>`).join('')}${nueva}</CORSConfiguration>`;
  await s3('PUT', { query: { cors: '' }, cuerpo, cabeceras: { 'content-md5': createHash('md5').update(cuerpo).digest('base64'), 'content-type': 'application/xml' } });
  console.log(`e2: CORS del bucket preparado para ${faltan.join(', ')}`);
}

async function existe(key) {
  const { status } = await s3('HEAD', { key, tolera: [404] });
  return status !== 404;
}

export async function abrir({ ruta, tamano, tipo, reemplazar }, usuario) {
  const key = limpiarRuta(ruta);
  const nombre = key.split('/').pop();
  if (!key.includes('/')) throw error(400, 'Elige una carpeta');
  if (!EXTENSIONES.test(nombre)) throw error(400, 'Solo se pueden subir vídeos, subtítulos e imágenes');
  const n = Number(tamano);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TAMANO) throw error(400, 'Tamaño de archivo no válido');
  const raiz = key.split('/')[0];
  if (!(await carpetas()).includes(raiz)) throw error(400, `La carpeta «${raiz}» no existe en e2`);
  if (!reemplazar && (await existe(key))) throw error(409, `Ya existe «${key}»`);
  const tamParte = Math.max(MIN_PARTE, Math.ceil(n / 9000 / 1048576) * 1048576);
  const { texto } = await s3('POST', { key, query: { uploads: '' }, cabeceras: { 'content-type': /^[\w.+-]+\/[\w.+-]+$/.test(tipo ?? '') ? tipo : 'application/octet-stream' } });
  const uploadId = desXml(xml(texto, 'UploadId')[0] ?? '');
  if (!uploadId) throw error(502, 'e2 no ha abierto la subida');
  const id = randomBytes(12).toString('base64url');
  const s = await leer();
  s[id] = { key, uploadId, tamano: n, tamParte, partes: Math.ceil(n / tamParte), usuario, creada: new Date().toISOString() };
  await guardar(s);
  return { id, key, tamParte, partes: s[id].partes };
}

async function deUsuario(id, usuario) {
  const s = await leer();
  const x = s[String(id ?? '')];
  if (!x || x.usuario !== usuario) throw error(404, 'Esa subida ya no existe: empieza otra vez');
  return { s, x };
}

// Direcciones firmadas para subir unos trozos (válidas 1 hora)
export async function trozos({ id, numeros }, usuario) {
  const { x } = await deUsuario(id, usuario);
  const lista = [...new Set((Array.isArray(numeros) ? numeros : []).map(Number))].slice(0, 50);
  if (!lista.length || lista.some((n) => !Number.isInteger(n) || n < 1 || n > x.partes)) throw error(400, 'Trozos no válidos');
  return { urls: Object.fromEntries(lista.map((n) => [n, firma({ metodo: 'PUT', key: x.key, query: { partNumber: String(n), uploadId: x.uploadId }, caduca: 3600 })])) };
}

export async function cerrar({ id, etags }, usuario) {
  const { s, x } = await deUsuario(id, usuario);
  const lista = Array.isArray(etags) ? etags : [];
  if (lista.length !== x.partes || lista.some((e) => typeof e !== 'string' || !/^"?[\w-]{1,80}"?$/.test(e))) throw error(400, 'Faltan trozos por subir');
  const cuerpo = `<CompleteMultipartUpload>${lista.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>"${e.replace(/"/g, '')}"</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
  const { texto } = await s3('POST', { key: x.key, query: { uploadId: x.uploadId }, cuerpo, cabeceras: { 'content-type': 'application/xml' } });
  if (/<Error>/.test(texto)) throw error(502, `e2 no ha podido juntar el archivo (${xml(texto, 'Code')[0] ?? 'error'})`);
  delete s[id]; await guardar(s);
  vistos?.set(x.key, limpiarEtag(xml(texto, 'ETag')[0] ?? ''));
  notificar([x.key]);
  return { key: x.key, tamano: x.tamano };
}

export async function cancelar({ id }, usuario) {
  const { s, x } = await deUsuario(id, usuario);
  await s3('DELETE', { key: x.key, query: { uploadId: x.uploadId }, tolera: [404] }).catch(() => {});
  delete s[id]; await guardar(s);
  return { ok: true };
}

// Subidas abandonadas (más de 2 días): se cancelan para que e2 no guarde los trozos sueltos
async function limpiarViejas() {
  try {
    const s = await leer(); let cambia = false;
    for (const [id, x] of Object.entries(s)) {
      if (Date.now() - new Date(x.creada).getTime() < 2 * 86400000) continue;
      await s3('DELETE', { key: x.key, query: { uploadId: x.uploadId }, tolera: [404] }).catch(() => {});
      delete s[id]; cambia = true;
    }
    if (cambia) await guardar(s);
  } catch (e) { console.error(`e2: limpieza de subidas (${e.message})`); }
}

// ---------- Vigilar e2: lo que se sube (desde el panel, la web de iDrive o rclone) llega a Emby ----------
// e2 no avisa de nada, así que cada minuto se mira qué hay en las carpetas de las bibliotecas (las
// que no empiezan por «_»). Un archivo nuevo o cambiado → se le dice a Emby su ruta exacta
// (/Library/Media/Updated) y Emby añade solo eso, en segundos. Se espera un poco antes de avisar
// porque el montaje de e2 en la VPS guarda las listas de carpetas ~1 minuto (--dir-cache-time 1m).
// La primera vuelta solo apunta lo que hay. Lo que se escape lo recoge el escaneo programado de Emby.
const VIGILAR = Number(process.env.E2_VIGILAR_MS ?? 60000);
const ESPERA_MONTAJE = Number(process.env.E2_ESPERA_MONTAJE_MS ?? 75000);
const RUTA_EMBY = String(process.env.EMBY_RUTA_E2 ?? '/e2').replace(/\/+$/, '');
const MEDIOS = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg|srt|ass|ssa|vtt|sub|idx|sup)$/i;
const limpiarEtag = (e) => desXml(String(e)).replace(/"/g, '');
let avisarEmby = null;
let vistos = null; // Map ruta → ETag
let vigilando = false;
let falloVigilar = '';

async function listarTodo(prefijo) {
  const salida = []; let token;
  do {
    const { texto } = await s3('GET', { query: { 'list-type': '2', prefix: prefijo, ...(token && { 'continuation-token': token }) } });
    for (const c of xml(texto, 'Contents')) salida.push({ key: desXml(xml(c, 'Key')[0] ?? ''), etag: limpiarEtag(xml(c, 'ETag')[0] ?? '') });
    token = /<IsTruncated>true<\/IsTruncated>/.test(texto) ? desXml(xml(texto, 'NextContinuationToken')[0] ?? '') : null;
  } while (token);
  return salida;
}

export async function vigilar() {
  if (vigilando || !configurado()) return;
  vigilando = true;
  try {
    const ahora = new Map();
    for (const raiz of await carpetas()) {
      for (const o of await listarTodo(`${raiz}/`)) if (MEDIOS.test(o.key)) ahora.set(o.key, o.etag);
    }
    if (vistos) {
      const nuevos = [...ahora].filter(([k, e]) => vistos.get(k) !== e).map(([k]) => k);
      if (nuevos.length) notificar(nuevos);
    }
    vistos = ahora;
    if (falloVigilar) { console.log('e2: vigilancia de subidas otra vez en marcha'); falloVigilar = ''; }
  } catch (e) {
    // Si falla una vuelta no se toca lo apuntado (no se confunde con «todo es nuevo»)
    if (falloVigilar !== e.message) console.error(`e2: no se pudo mirar si hay subidas nuevas (${e.message})`);
    falloVigilar = e.message;
  } finally { vigilando = false; }
}

// Junta lo nuevo de unos segundos y se lo dice a Emby cuando el montaje ya lo ve
const porAvisar = new Set();
let temporizador = null;
function notificar(keys) {
  for (const k of keys) if (MEDIOS.test(k)) porAvisar.add(k);
  if (!porAvisar.size || temporizador || (!avisarEmby && !escanear)) return;
  temporizador = setTimeout(async () => {
    temporizador = null;
    const lista = [...porAvisar]; porAvisar.clear();
    const nombre = lista[0].split('/').pop();
    try {
      if (!avisarEmby) throw new Error('sin aviso directo');
      await avisarEmby(lista.map((k) => `${RUTA_EMBY}/${k}`));
      console.log(`e2: ${lista.length} archivo${lista.length === 1 ? '' : 's'} nuevo${lista.length === 1 ? '' : 's'} → Emby («${nombre}»${lista.length > 1 ? ' y más' : ''})`);
    } catch (e) {
      // Si Emby no acepta el aviso directo, escaneo completo de las bibliotecas
      console.error(`e2: aviso directo a Emby falló (${e.message}); escaneo completo`);
      await escanear?.().catch((x) => console.error(`Escaneo de Emby: ${x.message}`));
    }
  }, ESPERA_MONTAJE);
  temporizador.unref?.();
}
