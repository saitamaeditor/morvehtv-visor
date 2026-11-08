// Analiza enlaces de vídeo y los devuelve limpios: qué servidor es, el ID del vídeo, la dirección
// «embed» normalizada y un <iframe> seguro listo para meter en el HTML. Sin dependencias: vale
// para Node y para el navegador.
//
// Entiende el texto tal como se pega: URL sueltas (con o sin https://, con signos de puntuación
// pegados), códigos <iframe>/<a>/<video>, BBCode ([url]…[/url]), Markdown, entidades HTML…
//
//   import { analizarEnlaces } from './enlaces-video.js';
//   analizarEnlaces('Ver: voe.sx/abc123, <iframe src="//streamwish.to/f/xyz">');
//   → [{ servidor: 'Voe', conocido: true, id: 'abc123', url: 'https://voe.sx/e/abc123', iframe: '…' }, …]

// ---------- Cómo sacar el ID del vídeo ----------
// Rutas típicas de los servidores de vídeo: /e/ID, /v/ID, /d/ID, /f/ID, /embed/ID,
// /embed-ID.html, /embed-ID-640x360.html, /ID.html, /ID/nombre-del-archivo.mp4, /ID
const ID_COMUN = new RegExp([
  String.raw`^/(?:e|v|d|f|w|embed|video|videos|play|file|watch|download|dl|player|p)/([\w-]{4,})`,
  String.raw`^/embed-([\w-]{4,}?)(?:-\d+x\d+)?(?:\.html?)?(?:/|$)`,
  String.raw`^/([\w-]{5,})(?:\.html?)?(?:/|$)`,
].join('|'), 'i');
const idComun = (u) => {
  const m = u.pathname.match(ID_COMUN);
  return (m && (m[1] || m[2] || m[3])) || u.searchParams.get('id') || u.searchParams.get('v') || null;
};
// Un ID sacado de una ruta concreta (la primera captura de la expresión)
const porRuta = (re) => (u) => (u.pathname.match(re) || [])[1] || null;
// Los servidores con espejos cambian de dominio a menudo: se conserva el dominio que venía
const mismoHost = (ruta) => (id, u) => `https://${u.hostname}${ruta.replace('ID', encodeURIComponent(id))}`;
// Dominios de una familia: «nombre», «nombre2», «nombre-tv»… con cualquier terminación (.com, .to…)
const familia = (...nombres) => new RegExp(`^(?:[\\w-]+\\.)?(?:${nombres.join('|')})[\\w-]*\\.[a-z.]{2,}$`, 'i');

// ---------- Tabla de servidores ----------
// Para añadir uno: { nombre, dominios: [texto o regex], id(url), embed(id, url) }
// Un texto vale para el dominio exacto y sus subdominios; una regex se prueba contra el dominio
// (sin «www.» ni «m.»). El orden importa: el primero que encaje.
export const SERVIDORES = [
  {
    nombre: 'YouTube',
    dominios: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    id: (u) => (u.hostname.endsWith('youtu.be') ? u.pathname.slice(1).split('/')[0]
      : u.searchParams.get('v') || porRuta(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/)(u)) || null,
    embed: (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`,
  },
  {
    nombre: 'Vimeo',
    dominios: ['vimeo.com'],
    id: porRuta(/(?:^|\/)(\d{5,})(?:\/|$)/),
    embed: (id) => `https://player.vimeo.com/video/${id}`,
  },
  {
    nombre: 'Dailymotion',
    dominios: ['dailymotion.com', 'dai.ly'],
    id: (u) => (u.hostname.endsWith('dai.ly') ? u.pathname.slice(1) : porRuta(/\/video\/([a-z0-9]+)/i)(u)) || null,
    embed: (id) => `https://www.dailymotion.com/embed/video/${encodeURIComponent(id)}`,
  },
  {
    nombre: 'Google Drive',
    dominios: ['drive.google.com', 'docs.google.com'],
    id: (u) => porRuta(/\/file\/d\/([\w-]{10,})/)(u) || u.searchParams.get('id'),
    embed: (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`,
  },
  {
    nombre: 'OK.ru',
    dominios: ['ok.ru', 'odnoklassniki.ru'],
    id: porRuta(/\/(?:video|videoembed|live)\/(\d{5,})/),
    embed: (id) => `https://ok.ru/videoembed/${id}`,
  },
  {
    // La clave del archivo va detrás de «#»: sin ella Mega no puede abrir el vídeo
    nombre: 'Mega',
    dominios: ['mega.nz', 'mega.co.nz', 'mega.io'],
    id: (u) => {
      const ruta = u.pathname.match(/^\/(?:file|embed)\/([\w-]{6,})/);
      if (ruta && u.hash.length > 1) return `${ruta[1]}#${u.hash.slice(1)}`;
      const vieja = u.hash.match(/^#!([\w-]{6,})!([\w-]+)/);
      return vieja ? `${vieja[1]}#${vieja[2]}` : null;
    },
    embed: (id) => `https://mega.nz/embed/${id}`,
  },
  {
    nombre: 'Archive.org',
    dominios: ['archive.org'],
    id: porRuta(/^\/(?:details|embed)\/([^/?#]+)/),
    embed: (id) => `https://archive.org/embed/${encodeURIComponent(id)}`,
  },
  {
    nombre: 'Byse',
    dominios: [familia('byse')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Streamwish',
    dominios: [familia('streamwish', 'wishembed', 'swdyu', 'strwish', 'playerwish', 'embedwish', 'awish', 'dwish', 'sfastwish',
      'wishfast', 'flaswish', 'obeywish', 'cdnwish', 'mwish', 'jodwish', 'hlswish', 'swhoi', 'streamhg', 'hglink', 'wishonly',
      'iplayerhls', 'ghbrisk', 'haxloppd', 'davioad', 'dhcplay', 'stbhg', 'gradehgplus', 'hgplaycdn', 'hlsflast', 'cybervynx')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Filelions',
    dominios: [familia('filelions', 'alions', 'dlions', 'vidhide', 'filelion', 'lionzz', 'mivalyo', 'dinisglows', 'callistanise',
      'kinoger', 'smoothpre', 'dhtpre', 'peytonepre', 'nikaplayer', 'ryderjet', 'vhaudm', 'movearnpre', 'luluvid', 'vidhidehub')],
    id: idComun,
    embed: mismoHost('/v/ID'),
  },
  {
    // Voe tiene muchos dominios espejo con nombres al azar: voe.sx redirige al que toque
    nombre: 'Voe',
    dominios: [familia('voe', 'voeunblock', 'voeun-block', 'voe-unblock', 'un-block-voe', 'voeunbl0ck', 'audaciousdefaulthouse',
      'launchreliantcleaverriver', 'reputationsheriffkennethsand', 'fittingcentermondaysunday', 'jilliandescribecompany',
      'robertordercharacter', 'christopheruntilpoint', 'jonathansociallike', 'maxfinishseveral', 'mariatheserepublican')],
    id: idComun,
    embed: (id) => `https://voe.sx/e/${encodeURIComponent(id)}`,
  },
  {
    nombre: 'Filemoon',
    dominios: [familia('filemoon', 'kerapoxy', 'moonmov', 'fmoonembed', 'boosteradx', 'smdfs', 'cinegrab', 'z1ekv717', 'bf0skv', '96ar')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Doodstream',
    dominios: [familia('dood', 'doodstream', 'dooood', 'd0000d', 'd000d', 'd0o0d', 'do0od', 'ds2play', 'ds2video', 'doods', 'vidply',
      'all3do', 'do7go', 'doodcdn', 'dooodster', 'playmogo', 'vide0', 'myvidplay')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Streamtape',
    dominios: [familia('streamtape', 'strtape', 'stape', 'streamta', 'tapecontent', 'streamadblocker', 'tapeblocker', 'tapewithadblock',
      'adblockeronstape', 'strcloud', 'shavetape', 'tapeantiads', 'watchadsontape')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Mixdrop',
    dominios: [familia('mixdrop', 'mixdroop', 'mxdrop', 'md3b0j6hj', 'mixdrp', 'mdy48tn97', 'mdbekjwqa', 'mdfx9dc8n', 'm1xdrop', 'mdzsmutpcvykb')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Lulustream',
    dominios: [familia('lulustream', 'luluvdo', 'lulustr', 'lulu\\.st')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Vidguard',
    dominios: [familia('vidguard', 'vgfplay', 'vgembed', 'listeamed', 'bembed', 'v6embed', 'moflix-stream', 'fslinks', 'vid-guard')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Streamvid',
    dominios: [familia('streamvid')],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Vidmoly',
    dominios: [familia('vidmoly')],
    id: idComun,
    embed: mismoHost('/embed-ID.html'),
  },
  {
    nombre: 'Mp4upload',
    dominios: [familia('mp4upload')],
    id: idComun,
    embed: mismoHost('/embed-ID.html'),
  },
  {
    nombre: 'Vidoza',
    dominios: [familia('vidoza', 'videzz')],
    id: idComun,
    embed: mismoHost('/embed-ID.html'),
  },
  {
    nombre: 'Uqload',
    dominios: [familia('uqload')],
    id: idComun,
    embed: mismoHost('/embed-ID.html'),
  },
  {
    nombre: 'Upstream',
    dominios: [familia('upstream')],
    id: idComun,
    embed: mismoHost('/embed-ID.html'),
  },
  {
    nombre: 'Netu',
    dominios: [familia('hqq', 'netu', 'waaw', 'netuplayer', 'younetu')],
    id: (u) => u.searchParams.get('v') || u.searchParams.get('vid') || porRuta(/^\/(?:e|f|watch)\/([\w-]{4,})/)(u),
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Sendvid',
    dominios: [familia('sendvid')],
    id: porRuta(/^\/(?:embed\/)?([a-z0-9]{6,})/i),
    embed: (id) => `https://sendvid.com/embed/${id}`,
  },
];

// Parámetros de seguimiento que se quitan
const SEGUIMIENTO = /^(utm_\w+|fbclid|gclid|dclid|msclkid|igshid|si|ref|ref_src|feature|_ga|_gl|mc_\w+)$/i;

const escapar = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const desentidades = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x2F;|&#47;/gi, '/').replace(/&#x3A;|&#58;/gi, ':').replace(/&amp;/g, '&');

// El iframe que se devuelve: siempre el mismo y sin copiar nada del original (onload, style…)
export function iframeDe(url) {
  return `<iframe src="${escapar(url)}" width="100%" height="100%" frameborder="0" allowfullscreen `
    + 'allow="autoplay; fullscreen; picture-in-picture" referrerpolicy="no-referrer" loading="lazy"></iframe>';
}

const coincide = (host, d) => (typeof d === 'string' ? host === d || host.endsWith(`.${d}`) : d.test(host));
const servidorDe = (host) => SERVIDORES.find((s) => s.dominios.some((d) => coincide(host, d))) || null;

// Nombre legible de un servidor que no está en la tabla: «bysekoze.com» → «Bysekoze»
function nombreDeDominio(host) {
  const partes = host.split('.');
  // (co.uk, com.es…: se salta la terminación doble)
  const i = partes.length > 2 && partes[partes.length - 2].length <= 3 ? partes.length - 3 : partes.length - 2;
  const base = partes[Math.max(0, i)] || host;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// ---------- Sacar las direcciones del texto ----------
// En el mismo orden en que aparecen (el primero es el principal). Un atributo src/href/data-src
// cuenta como una sola dirección (no se vuelve a contar la URL que lleva dentro).
const BUSCAR = new RegExp([
  // atributos HTML: src="…", data-src='…', href=…
  String.raw`\b(?:data-)?(?:src|href|file|url)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`,
  // URL con esquema o que empiezan por //
  String.raw`((?:https?:)?//[^\s"'<>\[\]{}|\\^\x60]+)`,
  // dominio.tld/ruta sin esquema («voe.sx/e/abc»)
  String.raw`(?<![\w@./-])((?:[a-z0-9-]+\.)+[a-z]{2,}/[^\s"'<>\[\]{}|\\^\x60]*)`,
].join('|'), 'gi');

function quitarPuntuacion(t) {
  // Lo que se queda pegado al final al copiar de un texto: «…/abc).», «…/abc»,» …
  for (;;) {
    const ultimo = t.slice(-1);
    if (/[.,;:!?»"'”’>]/.test(ultimo)) { t = t.slice(0, -1); continue; }
    // un paréntesis o corchete de cierre solo si no se abrió dentro de la URL
    if (ultimo === ')' && (t.match(/\(/g) || []).length < (t.match(/\)/g) || []).length) { t = t.slice(0, -1); continue; }
    if (ultimo === ']' && !t.includes('[')) { t = t.slice(0, -1); continue; }
    return t;
  }
}

export function extraerDirecciones(texto) {
  const s = String(texto ?? '');
  const lista = [];
  for (const m of s.matchAll(BUSCAR)) {
    const bruto = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (bruto) lista.push(quitarPuntuacion(desentidades(bruto.trim())));
  }
  return lista;
}

function aUrl(t) {
  if (!t) return null;
  if (t.startsWith('//')) t = `https:${t}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = `https://${t}`;
  let u;
  try { u = new URL(t); } catch (e) { return null; }
  // Solo http/https con un dominio de verdad: fuera javascript:, data:, file:, «a.b/…» sin sentido
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') && u.hostname !== 'localhost') return null;
  return u;
}

// ---------- Analizar ----------
// Un enlace (una URL o un trozo de texto con una) → { servidor, conocido, id, url, iframe } o null
export function analizarEnlace(texto) {
  const u = aUrl(extraerDirecciones(texto)[0] ?? String(texto ?? '').trim());
  return u ? analizarUrl(u) : null;
}

function analizarUrl(u) {
  // Para reconocer el servidor: https, sin «www.» ni «m.»; la dirección desconocida se deja como
  // venía (con su http si lo era: p. ej. un servidor de vídeos de la red de casa)
  const limpio = new URL(u.href);
  limpio.protocol = 'https:';
  limpio.hostname = u.hostname.toLowerCase().replace(/^(www\d?|m)\./, '');
  for (const k of [...limpio.searchParams.keys()]) if (SEGUIMIENTO.test(k)) { limpio.searchParams.delete(k); u.searchParams.delete(k); }
  const s = servidorDe(limpio.hostname);
  let id = s ? s.id(limpio) : null;
  if (id && !/^[\w-]+(#[\w-]+)?$/.test(id) && s.nombre !== 'Archive.org') id = null;
  const url = s && id ? s.embed(id, limpio) : u.href;
  const servidor = s ? s.nombre : nombreDeDominio(limpio.hostname);
  return { servidor, conocido: !!(s && id), id: id || null, url, iframe: iframeDe(url) };
}

// Texto con muchos enlaces (como venga: líneas, comas, iframes, HTML, BBCode…) o un array de
// ellos → lista sin repetidos (el mismo vídeo en dos dominios espejo cuenta una vez)
export function analizarEnlaces(entrada) {
  const vistos = new Set();
  const lista = [];
  for (const t of Array.isArray(entrada) ? entrada : [entrada]) {
    for (const bruto of extraerDirecciones(t)) {
      const u = aUrl(bruto);
      if (!u) continue;
      const r = analizarUrl(u);
      const clave = r.conocido ? `${r.servidor}|${r.id}` : r.url;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      lista.push(r);
    }
  }
  return lista;
}
