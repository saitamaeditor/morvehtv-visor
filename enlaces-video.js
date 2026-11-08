// Analiza enlaces de vídeo (URL sueltas o códigos <iframe> pegados) y los devuelve limpios:
// qué servidor es, el ID del vídeo, la dirección «embed» normalizada y un <iframe> seguro listo
// para meter en el HTML. Sin dependencias: vale para Node y para el navegador.
//
//   import { analizarEnlaces } from './enlaces-video.js';
//   analizarEnlaces('https://voe.sx/abc123\n<iframe src="//streamwish.to/f/xyz">');
//   → [{ servidor: 'Voe', id: 'abc123', url: 'https://voe.sx/e/abc123', iframe: '<iframe …>' }, …]

// Sacar el ID de las rutas típicas: /e/ID, /v/ID, /d/ID, /f/ID, /embed/ID, /embed-ID.html, /ID
const ID_COMUN = /^\/(?:e|v|d|f|embed|video|play)\/([\w-]{4,})|^\/embed-([\w-]{4,})(?:\.html)?|^\/([\w-]{6,})(?:\.html)?(?:\/|$)/i;
const idComun = (u) => {
  const m = u.pathname.match(ID_COMUN);
  return m ? m[1] || m[2] || m[3] : null;
};
// Los servidores con espejos cambian de dominio a menudo: se conserva el dominio que venía
const mismoHost = (ruta) => (id, u) => `https://${u.hostname}${ruta.replace('ID', encodeURIComponent(id))}`;

// Tabla de servidores. Para añadir uno: { nombre, dominios: [texto o regex], id(url), embed(id, url) }
// Un texto vale para el dominio exacto y sus subdominios; una regex se prueba contra el hostname.
export const SERVIDORES = [
  {
    nombre: 'YouTube',
    dominios: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    id: (u) => (u.hostname.endsWith('youtu.be') ? u.pathname.slice(1).split('/')[0]
      : u.searchParams.get('v') || (u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/) || [])[1]) || null,
    embed: (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`,
  },
  {
    nombre: 'Vimeo',
    dominios: ['vimeo.com'],
    id: (u) => (u.pathname.match(/(?:^|\/)(\d{5,})(?:\/|$)/) || [])[1] || null,
    embed: (id) => `https://player.vimeo.com/video/${id}`,
  },
  {
    nombre: 'Dailymotion',
    dominios: ['dailymotion.com', 'dai.ly'],
    id: (u) => (u.hostname.endsWith('dai.ly') ? u.pathname.slice(1) : (u.pathname.match(/\/video\/([a-z0-9]+)/i) || [])[1]) || null,
    embed: (id) => `https://www.dailymotion.com/embed/video/${encodeURIComponent(id)}`,
  },
  {
    nombre: 'Byse',
    dominios: [/^byse\./i, /^byse[a-z0-9]*\./i],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Streamwish',
    dominios: [/^(?:streamwish|wishembed|swdyu|strwish|playerwish|embedwish|awish|dwish|sfastwish|wishfast|flaswish|obeywish|cdnwish|mwish|jodwish|hlswish|swhoi|streamhg|hglink)\./i],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Voe',
    dominios: [/^voe\./i, /^voe[a-z0-9-]*\./i],
    id: idComun,
    embed: (id) => `https://voe.sx/e/${encodeURIComponent(id)}`,
  },
  {
    nombre: 'Filelions',
    dominios: [/^(?:filelions|alions|dlions|vidhide|vidhidepro|vidhideplus|vidhidevip|filelion|lionzz|mivalyo|dinisglows|callistanise)[a-z0-9]*\./i],
    id: idComun,
    embed: mismoHost('/v/ID'),
  },
  {
    nombre: 'Doodstream',
    dominios: [/^(?:dood|doodstream|dooood|d0000d|d000d|ds2play|ds2video|do0od|dood\w*)\./i],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Streamtape',
    dominios: [/^(?:streamtape|strtape|stape|streamta|tapecontent|streamadblocker)\w*\./i],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Mixdrop',
    dominios: [/^(?:mixdrop|mixdroop|mxdrop|md3b0j6hj|mixdrp)\w*\./i],
    id: idComun,
    embed: mismoHost('/e/ID'),
  },
  {
    nombre: 'Uqload',
    dominios: [/^uqload\w*\./i],
    id: idComun,
    embed: mismoHost('/embed-ID.html'),
  },
  {
    nombre: 'Upstream',
    dominios: [/^upstream\w*\./i],
    id: idComun,
    embed: mismoHost('/embed-ID.html'),
  },
];

// Parámetros de seguimiento que se quitan en los enlaces genéricos
const SEGUIMIENTO = /^(utm_\w+|fbclid|gclid|dclid|msclkid|igshid|si|ref|ref_src|feature|_ga)$/i;

const escapar = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// El iframe que se devuelve: siempre el mismo y sin copiar nada del original (onload, style…)
export function iframeDe(url) {
  return `<iframe src="${escapar(url)}" width="100%" height="100%" frameborder="0" allowfullscreen `
    + 'allow="autoplay; fullscreen; picture-in-picture" referrerpolicy="no-referrer" loading="lazy"></iframe>';
}

const coincide = (host, d) => (typeof d === 'string' ? host === d || host.endsWith(`.${d}`) : d.test(host));
const servidorDe = (host) => SERVIDORES.find((s) => s.dominios.some((d) => coincide(host, d))) || null;

// De un trozo de texto, la dirección: el src de un iframe (comillas dobles, simples o sin
// comillas) o la propia URL. Las que empiezan por // se toman como https.
function extraerUrl(texto) {
  let t = String(texto ?? '').trim();
  if (!t) return null;
  const src = t.match(/<iframe\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (src) t = src[1] ?? src[2] ?? src[3];
  // (entidades HTML del atributo: luego se vuelven a escapar al montar el iframe)
  t = t.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  if (t.startsWith('//')) t = `https:${t}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[\w-]+(\.[\w-]+)+\//.test(t)) t = `https://${t}`; // «voe.sx/e/abc»
  let u;
  try { u = new URL(t); } catch (e) { return null; }
  // Solo http/https: fuera javascript:, data:, file:…
  return /^https?:$/.test(u.protocol) ? u : null;
}

// Un enlace → { servidor, id, url, iframe } o null si no es una dirección válida
export function analizarEnlace(texto) {
  const u = extraerUrl(texto);
  if (!u) return null;
  // (para reconocer el servidor: sin «www.» ni «m.»; la dirección genérica se deja como venía,
  // con su http si lo era: p. ej. un servidor de vídeos de la red de casa)
  const limpio = new URL(u.href);
  limpio.protocol = 'https:';
  limpio.hostname = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const s = servidorDe(limpio.hostname);
  const id = s ? s.id(limpio) : null;
  let url;
  if (s && id) url = s.embed(id, limpio);
  else {
    // Genérico (o servidor conocido del que no se reconoce el ID): la misma dirección, sin seguimiento
    for (const k of [...u.searchParams.keys()]) if (SEGUIMIENTO.test(k)) u.searchParams.delete(k);
    url = u.href;
  }
  return { servidor: s && id ? s.nombre : 'Genérico', id: id || null, url, iframe: iframeDe(url) };
}

// Texto con muchos enlaces (uno por línea, separados por comas o espacios, o iframes enteros)
// o un array de ellos → lista sin repetidos
export function analizarEnlaces(entrada) {
  const textos = (Array.isArray(entrada) ? entrada : [entrada]).flatMap((t) => {
    const s = String(t ?? '');
    // Los iframes completos van enteros (llevan espacios dentro); el resto, trozo a trozo. En el
    // mismo orden que en el texto: el primero es el principal y los demás, de reserva
    return s.split(/(<iframe\b[^>]*>(?:\s*<\/iframe>)?)/i).flatMap((trozo, n) => (n % 2 ? [trozo] : trozo.split(/[\s,;]+/)));
  });
  const vistos = new Set();
  const lista = [];
  for (const t of textos) {
    const r = analizarEnlace(t);
    if (!r || vistos.has(r.url)) continue;
    vistos.add(r.url);
    lista.push(r);
  }
  return lista;
}
