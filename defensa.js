// Defensa del servidor contra abusos (todo en memoria, se reinicia con el servidor):
//  · Límite de peticiones por IP, más estricto en lo que cuesta (buscar en todo el bucket,
//    preparar un vídeo con ffmpeg…). Quien se pasa una y otra vez queda bloqueado un rato.
//  · Cabeceras de seguridad en todas las respuestas.
//  · Vídeos: una cuenta no puede abrir vídeos desde demasiadas conexiones distintas a la vez
//    (cuentas compartidas o enlaces revendidos) ni bajarse el catálogo entero de golpe.
// Los números se pueden cambiar con variables de entorno sin tocar el código.
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const MAX_IPS = num(process.env.VISOR_MAX_IPS, 4); // conexiones distintas por cuenta…
const HORAS_IPS = num(process.env.VISOR_HORAS_IPS, 2); // …en estas horas
const MAX_VIDEOS_HORA = num(process.env.VISOR_MAX_VIDEOS_HORA, 60); // vídeos distintos por cuenta y hora

const error = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });

// ---------- Límite de peticiones por IP ----------
// grupo → [máximo, segundos]
const GRUPOS = {
  general: [900, 60], // páginas, catálogo, trozos de vídeo HLS (uno cada 4 s por vídeo)…
  pesado: [30, 60], // buscar en todo el bucket, calcular tamaños, analizar o preparar un vídeo
  video: [120, 60], // enlaces a vídeos
  panel: [600, 60], // el gestor (subir un archivo grande pide muchas firmas)
  subida: [2400, 60], // los trozos que el gestor sube a través del servidor (muchos y rápidos)
  xtream: [600, 60], // reproductores externos: navegan por el catálogo a base de peticiones
};
// (buscar y tamaño ya salen de la memoria: no cuentan como pesadas)
const PESADAS = ['/api/hls', '/api/medio', '/api/enlace', '/api/tmdb-buscar'];
const cuentas = new Map(); // `${grupo}|${ip}` → { n, desde }
const avisos = new Map(); // ip → [marcas de veces que se pasó]
const bloqueadas = new Map(); // ip → hasta cuándo

export function grupoDe(ruta) {
  if (ruta === '/api/panel/subir/trozo') return 'subida';
  if (ruta.startsWith('/api/panel/')) return 'panel';
  if (/^\/(player_api|get|xmltv)\.php$/.test(ruta) || /^\/(movie|series)\//.test(ruta)) return 'xtream';
  if (PESADAS.includes(ruta)) return 'pesado';
  if (ruta === '/api/url') return 'video';
  return 'general';
}

// Lanza 429 si esa IP va demasiado deprisa
export function limitar(ip, ruta) {
  if (!ip) return;
  const ahora = Date.now();
  const hasta = bloqueadas.get(ip);
  if (hasta > ahora) throw error(429, 'Demasiadas peticiones desde tu conexión. Espera unos minutos.', { espera: Math.ceil((hasta - ahora) / 1000) });
  const grupo = grupoDe(ruta);
  const [max, seg] = GRUPOS[grupo];
  const k = `${grupo}|${ip}`;
  let c = cuentas.get(k);
  if (!c || ahora - c.desde > seg * 1000) { c = { n: 0, desde: ahora }; cuentas.set(k, c); }
  if (++c.n <= max) return;
  // Se pasó: si le pasa a menudo (5 veces en 10 minutos), 15 minutos fuera
  if (c.n === max + 1) {
    const lista = (avisos.get(ip) ?? []).filter((t) => ahora - t < 600000);
    lista.push(ahora); avisos.set(ip, lista);
    if (lista.length >= 5) { bloqueadas.set(ip, ahora + 15 * 60000); console.warn('Defensa: una conexión bloqueada 15 minutos (demasiadas peticiones)'); }
  }
  throw error(429, 'Demasiadas peticiones. Espera un momento.', { espera: Math.ceil((c.desde + seg * 1000 - ahora) / 1000) });
}

// ---------- Cabeceras de seguridad ----------
export function cabeceras(res, nube) {
  res.setHeader('x-content-type-options', 'nosniff');
  // Nadie puede meter MorvehTV dentro de su web (para engañar con clics o copiarla)
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  // Los enlaces firmados de los vídeos no se filtran a otras webs al pinchar un enlace
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (nube) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

// ---------- Vídeos por cuenta ----------
// Se cuenta la red y no la IP exacta: el móvil con IPv6 cambia la parte final a menudo
const red = (ip) => (ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip);
const usos = new Map(); // usuario → { ips: Map(red → última vez), videos: Map(key → primera vez) }

// Llamar antes de dar el enlace (o preparar) un vídeo. Los administradores no tienen límite.
export function permitirVideo(cuenta, ip, key, admin) {
  if (!cuenta || admin) return;
  const ahora = Date.now();
  let u = usos.get(cuenta.usuario);
  if (!u) { u = { ips: new Map(), videos: new Map() }; usos.set(cuenta.usuario, u); }
  for (const [r, t] of u.ips) if (ahora - t > HORAS_IPS * 3600000) u.ips.delete(r);
  for (const [k, t] of u.videos) if (ahora - t > 3600000) u.videos.delete(k);
  const r = red(ip || '?');
  if (!u.ips.has(r) && u.ips.size >= MAX_IPS) {
    console.warn(`Defensa: la cuenta ${cuenta.usuario} intenta ver vídeos desde demasiadas conexiones (${u.ips.size + 1})`);
    throw error(429, `Esta cuenta se está usando en demasiados sitios a la vez (máximo ${MAX_IPS}). Si no eres tú, cambia la contraseña en «Mi cuenta» y cierra las demás sesiones.`);
  }
  if (!u.videos.has(key) && u.videos.size >= MAX_VIDEOS_HORA) {
    console.warn(`Defensa: la cuenta ${cuenta.usuario} ha pedido más de ${MAX_VIDEOS_HORA} vídeos en una hora`);
    throw error(429, 'Has abierto demasiados vídeos en poco tiempo. Espera un rato y vuelve a probar.');
  }
  u.ips.set(r, ahora);
  if (!u.videos.has(key)) u.videos.set(key, ahora);
}

// ---------- Bots ----------
// Ninguna IP se escribe en disco ni en los registros: los bloqueos viven solo en memoria.
const HORAS_TRAMPA = num(process.env.VISOR_HORAS_TRAMPA, 12);

// Herramientas de extracción y navegadores automatizados que se presentan como tales. Los
// reproductores de vídeo (okhttp, Dart, VLC, Kodi…) no están: usan las rutas Xtream.
const UA_BOT = /HeadlessChrome|PhantomJS|Selenium|webdriver|Puppeteer|Playwright|python-requests|python-urllib|python-httpx|aiohttp|Scrapy|curl\/|Wget|libwww-perl|Goutte|Guzzle|HTTrack|colly|node-fetch|axios\/|MJ12bot|AhrefsBot|SemrushBot|DotBot|PetalBot|Bytespider|GPTBot|ClaudeBot|CCBot|DataForSeoBot|ImagesiftBot/i;
export const esBot = (req) => UA_BOT.test(String(req.headers['user-agent'] ?? '')) || !req.headers['user-agent'];

// Enlace trampa: está en las páginas pero oculto y fuera del mando; robots.txt lo prohíbe, así
// que solo lo pisa un programa que recorre todos los enlaces sin mirar nada
export const TRAMPA = '/acceso-socios';
export function atrapar(ip, motivo) {
  if (!ip) return;
  bloqueadas.set(ip, Date.now() + HORAS_TRAMPA * 3600000);
  console.warn(`Defensa: un bot ha caído en la trampa (${motivo}); bloqueado ${HORAS_TRAMPA} h`);
}

// Turnstile de Cloudflare (opcional: con TURNSTILE_SITEKEY y TURNSTILE_SECRET en el entorno)
export const TURNSTILE_SITEKEY = /^[\w-]{10,100}$/.test(process.env.TURNSTILE_SITEKEY ?? '') ? process.env.TURNSTILE_SITEKEY : '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? '';
async function turnstileValido(token) {
  if (!TURNSTILE_SITEKEY || !TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token }), signal: AbortSignal.timeout(8000),
    });
    return (await r.json()).success === true;
  } catch (e) {
    // Si Cloudflare no contesta no se deja a nadie sin poder registrarse
    console.error(`Turnstile: no se pudo comprobar (${e.message})`);
    return true;
  }
}

// Comprobaciones de entrar y registrarse desde entrar.html. La página manda «humano»: el
// campo trampa (vacío para una persona), si el navegador está automatizado, cuánto tardó y el
// pase de Turnstile. Un programa que llama a la API a pelo no lo trae.
export async function comprobarHumano(datos, ip, registro) {
  const h = datos?.humano;
  if (!h || typeof h !== 'object') throw error(400, 'Recarga la página y vuelve a intentarlo');
  if (h.cebo) { atrapar(ip, 'rellenó el campo oculto'); throw error(400, 'No se pudo completar'); }
  if (h.auto) { atrapar(ip, 'navegador automatizado'); throw error(400, 'No se pudo completar'); }
  // Nadie rellena el registro entero en menos de 3 segundos
  if (registro && !(Number(h.ms) >= 3000)) throw error(400, 'Espera un momento y vuelve a intentarlo');
  if (registro && !(await turnstileValido(h.pase))) throw error(400, 'No se pudo comprobar que eres una persona. Espera unos segundos y vuelve a intentarlo.');
}

// Limpieza de lo viejo cada 10 minutos
setInterval(() => {
  const ahora = Date.now();
  for (const [k, c] of cuentas) if (ahora - c.desde > 600000) cuentas.delete(k);
  for (const [ip, h] of bloqueadas) if (h < ahora) bloqueadas.delete(ip);
  for (const [ip, l] of avisos) if (!l.some((t) => ahora - t < 600000)) avisos.delete(ip);
  for (const [u, x] of usos) if (![...x.ips.values()].some((t) => ahora - t < HORAS_IPS * 3600000)) usos.delete(u);
}, 600000).unref();
