// Metadatos de TMDB para cada vídeo y carpeta del bucket: carátula, sinopsis, año, géneros,
// reparto… Saca el título del nombre del archivo (misma lógica que el importador de
// MorvehTV) y guarda lo encontrado en data/metadatos.json, así cada archivo nuevo se busca
// una sola vez. Es una caché local: no toca el catálogo de MorvehTV.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Se leen al usarlas: server.js carga el .env después de importar este módulo
const tmdbKey = () => process.env.TMDB_KEY ?? '';
const IMG = 'https://image.tmdb.org/t/p';
const img = (ruta, tam) => (ruta ? `${IMG}/${tam}${ruta}` : null);

// ---------- Caché en disco ----------
let archivoCache;
let cache = { archivos: {}, carpetas: {}, correcciones: {} };
let guardando = null;

export async function iniciar(dir) {
  archivoCache = path.join(dir, 'data', 'metadatos.json');
  try {
    cache = { ...cache, ...JSON.parse(await readFile(archivoCache, 'utf8')) };
  } catch {}
  // Los «no encontrado» de antes se vuelven a buscar (ahora se busca mejor)
  for (const seccion of ['archivos', 'carpetas']) {
    for (const [clave, valor] of Object.entries(cache[seccion])) if (!valor) delete cache[seccion][clave];
  }
}

function guardar() {
  clearTimeout(guardando);
  guardando = setTimeout(async () => {
    await mkdir(path.dirname(archivoCache), { recursive: true });
    await writeFile(archivoCache, JSON.stringify(cache));
  }, 1000);
}

// ---------- TMDB ----------
async function pedir(ruta, params = {}) {
  const TMDB_KEY = tmdbKey();
  if (!TMDB_KEY) throw Object.assign(new Error('Falta TMDB_KEY en el .env'), { status: 503 });
  const url = new URL(`https://api.themoviedb.org/3${ruta}`);
  url.searchParams.set('language', process.env.TMDB_IDIOMA || 'es-ES');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Un token v4 es un JWT largo; una clave v3 son 32 caracteres hex
  const headers = {};
  if (TMDB_KEY.length > 40) headers.Authorization = `Bearer ${TMDB_KEY}`;
  else url.searchParams.set('api_key', TMDB_KEY);
  const r = await fetch(url, { headers });
  if (!r.ok) throw Object.assign(new Error(`TMDB respondió ${r.status} en ${ruta}`), { status: r.status === 404 ? 404 : 502 });
  return r.json();
}

// ---------- Carpetas de plataforma («PELICULAS NETFLIX», «SERIES PRIME VIDEO»…) ----------
// No son un título: no se buscan en TMDB y su tarjeta lleva el logo y los colores de la plataforma
const PAIS = process.env.TMDB_PAIS || 'ES';
const NOMBRES = [
  [/netflix/i, 'Netflix'], [/amazon|prime video/i, 'Prime Video'], [/disney/i, 'Disney+'],
  [/hbo|\bmax\b(?! ?\d)/i, 'Max'], [/movistar/i, 'Movistar Plus+'], [/apple ?tv/i, 'Apple TV+'],
  [/skyshowtime/i, 'SkyShowtime'], [/filmin/i, 'Filmin'], [/rakuten/i, 'Rakuten TV'],
  [/atres ?player/i, 'Atresplayer'], [/mitele/i, 'Mitele'], [/rtve/i, 'RTVE Play'],
];
const nombrePlataforma = (n) => NOMBRES.find(([re]) => re.test(n))?.[1] ?? null;
// Las mismas reglas para la web
export const patronesPlataforma = () => NOMBRES.map(([re, n]) => [re.source, re.flags, n]);

// Las plataformas del país con su logo y sus códigos de TMDB (Netflix tiene varios: con
// anuncios, básico…)
let todas = null;
export function listaPlataformas() {
  if (!todas) {
    todas = pedir('/watch/providers/movie', { watch_region: PAIS }).then((d) => {
      const vistas = new Map();
      for (const p of (d.results ?? []).sort((a, b) => (a.display_priorities?.[PAIS] ?? a.display_priority) - (b.display_priorities?.[PAIS] ?? b.display_priority))) {
        const nombre = nombrePlataforma(p.provider_name);
        if (!nombre) continue;
        if (!vistas.has(nombre)) vistas.set(nombre, { nombre, logo: img(p.logo_path, 'w154'), ids: [] });
        vistas.get(nombre).ids.push(p.provider_id);
      }
      return [...vistas.values()];
    });
    todas.catch(() => { todas = null; });
  }
  return todas;
}

// Fondo de una carpeta de plataforma («pl:pelicula:Netflix»): lo más visto de esa plataforma
async function descubrirPlataforma(id) {
  const [, tipo, nombre] = id.split(':');
  const p = (await listaPlataformas()).find((x) => x.nombre === nombre);
  if (!p) return null;
  return [tipo === 'serie' ? '/discover/tv' : '/discover/movie', { with_watch_providers: p.ids.join('|'), watch_region: PAIS }];
}

// Las fichas de TMDB se reutilizan entre todos los episodios de una serie
const fichas = new Map();
const temporadas = new Map();

function ficha(tmdbId, tipo) {
  const clave = `${tipo}:${tmdbId}`;
  if (!fichas.has(clave)) {
    const p = pedir(`/${tipo === 'serie' ? 'tv' : 'movie'}/${tmdbId}`, { append_to_response: 'videos,credits' }).then((d) => {
      const trailer = (d.videos?.results ?? []).find((v) => v.site === 'YouTube' && v.type === 'Trailer');
      return {
        tmdbId: d.id,
        tipo,
        titulo: d.title ?? d.name,
        tituloOriginal: d.original_title ?? d.original_name,
        sinopsis: d.overview,
        anio: (d.release_date ?? d.first_air_date ?? '').slice(0, 4),
        duracion: d.runtime ?? d.episode_run_time?.[0] ?? null,
        generos: (d.genres ?? []).map((g) => g.name),
        valoracion: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
        poster: img(d.poster_path, 'w342'),
        fondo: img(d.backdrop_path, 'w1280'),
        reparto: (d.credits?.cast ?? []).slice(0, 8).map((c) => c.name),
        direccion: (d.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name),
        creadores: (d.created_by ?? []).map((c) => c.name),
        temporadas: d.number_of_seasons ?? null,
        trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
        tmdb: `https://www.themoviedb.org/${tipo === 'serie' ? 'tv' : 'movie'}/${d.id}`,
      };
    });
    p.catch(() => fichas.delete(clave));
    fichas.set(clave, p);
  }
  return fichas.get(clave);
}

function temporada(tmdbId, numero) {
  const clave = `${tmdbId}:${numero}`;
  if (!temporadas.has(clave)) {
    const p = pedir(`/tv/${tmdbId}/season/${numero}`);
    p.catch(() => temporadas.delete(clave));
    temporadas.set(clave, p);
  }
  return temporadas.get(clave);
}

export async function buscar(q, tipo, anio) {
  const ruta = tipo === 'serie' ? '/search/tv' : tipo === 'pelicula' ? '/search/movie' : '/search/multi';
  const filtroAnio = anio && (tipo === 'serie' ? { first_air_date_year: anio } : tipo === 'pelicula' ? { year: anio } : {});
  const { results = [] } = await pedir(ruta, { query: q, include_adult: 'false', ...filtroAnio });
  return results
    .filter((r) => r.media_type !== 'person')
    .map((r) => ({
      tmdbId: r.id,
      tipo: tipo === 'serie' || r.media_type === 'tv' ? 'serie' : 'pelicula',
      titulo: r.title ?? r.name,
      original: r.original_title ?? r.original_name ?? '',
      anio: (r.release_date ?? r.first_air_date ?? '').slice(0, 4),
      poster: img(r.poster_path, 'w185'),
    }));
}

// ---------- Nombres de archivo ----------
// Quita extensión, calidad, idioma y separadores: «El.Regalo.2026.1080p.WEB-DL» → «El Regalo»
function limpiarNombre(texto) {
  return texto
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr|web[- ]?dl|webrip|bluray|brrip|hdtv|x264|x265|h264|h265|hevc|aac|ac3|dual|castellano|español|spanish|latino|vose|subs?)\b.*$/i, '')
    // Etiquetas de webs de descarga pegadas al título: «Mi mejor amiga Cinubo» → «Mi mejor amiga»
    .replace(/\b(cinubo|cinecalidad|pelisplus|pelis ?24|gnula|mejortorrent|dontorrent|divxtotal|elitetorrent|grantorrent|pctfenix|pctmix|newpct\d*|yts|yify|rarbg|cuevana\d*|repelis|pelismart|zonaleros|hdfull|tioanime|animeflv|jkanime)\b.*$/i, '')
    .replace(/^\d+(?:[.,]\d+)?\s+(?=\S)/, '') // numeración delante: «0.56 Qué le pasó…»
    .replace(/\s+/g, ' ')
    .trim();
}

// Año entre paréntesis, o el último número tipo año: «Blade Runner 2049 (2017)» → 2017
function separarAnio(base) {
  const paren = base.match(/[([]((?:19|20)\d{2})[)\]]/);
  if (paren) return { anio: paren[1], antes: base.slice(0, paren.index) };
  const ult = [...base.matchAll(/[ ._-]((?:19|20)\d{2})(?=[ ._-]|$)/g)].at(-1);
  return ult ? { anio: ult[1], antes: base.slice(0, ult.index) } : { anio: undefined, antes: base };
}

const CARPETA_SERIE = /serie|programa|novela|turc/i;
const CARPETA_TEMPORADA = /^(?:temporada|season|temp|t|s)\s*0*(\d{1,2})$/i;

export function analizar(key) {
  const partes = key.split('/');
  const archivo = partes.at(-1);
  const carpetas = partes.slice(0, -1);
  const ep = archivo.match(/^(.*?)[ ._-]*(?<![a-z0-9])(?:S(\d{1,2})[ ._-]?E(\d{1,3})|(\d{1,2})x(\d{2,3})(?!\d)|T(\d{1,2})[ ._-]?E(\d{1,3}))/i);
  const carpetaSerie = carpetas.some((c) => CARPETA_SERIE.test(c));

  if (ep || carpetaSerie) {
    const carpetaTemp = carpetas.map((c) => c.match(CARPETA_TEMPORADA)).find(Boolean);
    const temporada = Number(ep?.[2] ?? ep?.[4] ?? ep?.[6] ?? carpetaTemp?.[1] ?? 1);
    const episodio = Number(ep?.[3] ?? ep?.[5] ?? ep?.[7] ?? archivo.match(/(\d{1,3})/)?.[1]);
    // La carpeta de la serie manda sobre el nombre del archivo, que suele venir sin tildes
    const nombreCarpeta = [...carpetas].reverse().find((c) => !CARPETA_SERIE.test(c) && !CARPETA_TEMPORADA.test(c));
    const { anio, antes } = separarAnio(nombreCarpeta || ep?.[1] || '');
    const nombre = limpiarNombre(antes.replace(/^[¡¿]/, ''));
    if (!nombre || !episodio) return null;
    return { tipo: 'serie', nombre, anio, temporada, episodio, carpeta: nombreCarpeta ? carpetas.slice(0, carpetas.indexOf(nombreCarpeta) + 1).join('/') + '/' : null };
  }

  const { anio, antes } = separarAnio(archivo.replace(/\.[a-z0-9]{2,4}$/i, ''));
  const nombre = limpiarNombre(antes) || limpiarNombre(archivo);
  return nombre ? { tipo: 'pelicula', nombre, anio } : null;
}

// Si el nombre completo no aparece en TMDB, se prueba quitando palabras del final (suelen ser
// etiquetas de la web de descarga o del grupo que lo subió) y, por último, sin fijar el tipo
function variantes(nombre) {
  const palabras = nombre.split(/\s+/).filter(Boolean);
  const lista = [nombre];
  for (let n = palabras.length - 1; n >= 1 && lista.length < 4; n--) {
    const v = palabras.slice(0, n).join(' ');
    if (v.length >= 4) lista.push(v);
  }
  return [...new Set(lista)];
}

// TMDB ordena por popularidad: con «Mi mejor amiga» sale antes «La boda de mi mejor amiga».
// Entre los resultados se prefiere el que se llama exactamente igual (en español o en el
// original) y el del año del archivo; a igualdad, el más popular.
const comparable = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

function mejor(lista, nombre, anio) {
  const buscado = comparable(nombre);
  let elegido = null;
  let puntos = -1;
  lista.slice(0, 10).forEach((r, i) => {
    const titulos = [comparable(r.titulo), comparable(r.original)];
    let p = 0;
    if (titulos.includes(buscado)) p += 4;
    else if (titulos.some((t) => t.startsWith(buscado) || buscado.startsWith(t))) p += 1;
    if (anio && r.anio === String(anio)) p += 3;
    p -= i * 0.01; // a igualdad, el que TMDB pone antes
    if (p > puntos) { puntos = p; elegido = r; }
  });
  return elegido;
}

async function encontrar({ nombre, tipo, anio }) {
  for (const n of variantes(nombre)) {
    const conAnio = anio ? await buscar(n, tipo, anio) : [];
    const lista = conAnio.length ? conAnio : await buscar(n, tipo);
    const r = mejor(lista, n, anio);
    if (r) return r;
  }
  if (tipo) {
    const r = mejor(await buscar(nombre), nombre, anio);
    if (r) return r;
  }
  return null;
}

// ---------- Lo que pide la interfaz ----------
// Qué título de TMDB es cada vídeo o carpeta: corrección a mano > caché > búsqueda
async function identificar(clave, seccion, datos) {
  if (cache.correcciones[clave]) return cache.correcciones[clave];
  if (clave in cache[seccion]) return cache[seccion][clave];
  const r = await encontrar(datos);
  // Solo se guarda lo encontrado: lo que no aparece se vuelve a buscar la próxima vez
  if (!r) return null;
  cache[seccion][clave] = { tmdbId: r.tmdbId, tipo: r.tipo };
  guardar();
  return cache[seccion][clave];
}

export async function deArchivo(key) {
  const datos = analizar(key);
  if (!datos) return null;
  // Los episodios heredan la serie de su carpeta (o de otro episodio ya identificado)
  const id = datos.tipo === 'serie' && datos.carpeta
    ? await identificar(datos.carpeta, 'carpetas', datos)
    : await identificar(key, 'archivos', datos);
  if (!id) return { encontrado: false, buscado: datos.nombre };
  const f = await ficha(id.tmdbId, id.tipo);
  if (id.tipo !== 'serie') return { encontrado: true, ...f };

  const s = await temporada(id.tmdbId, datos.temporada).catch(() => null);
  const e = s?.episodes?.find((x) => x.episode_number === datos.episodio);
  return {
    encontrado: true,
    ...f,
    episodio: {
      temporada: datos.temporada,
      numero: datos.episodio,
      titulo: e?.name ?? `Episodio ${datos.episodio}`,
      sinopsis: e?.overview ?? '',
      imagen: img(e?.still_path, 'w300'),
      fecha: e?.air_date ?? null,
      duracion: e?.runtime ?? null,
    },
  };
}

// Carpeta de una serie («SERIES ANIME/¡A por Jiro!/») o de una de sus temporadas
// («…/Temporada 2/»: la ficha de la serie más el póster, la sinopsis y los episodios de esa
// temporada). Las de categoría no tienen.
export async function deCarpeta(prefijo) {
  const partes = prefijo.replace(/\/$/, '').split('/');
  const n = partes.at(-1);
  if (partes.length < 2 || nombrePlataforma(n)) return null;
  const numero = n.match(CARPETA_TEMPORADA)?.[1];
  if (numero) {
    if (partes.length < 3) return null;
    const serie = await deCarpeta(partes.slice(0, -1).join('/') + '/');
    if (!serie?.encontrado || serie.tipo !== 'serie') return serie;
    const s = await temporada(serie.tmdbId, Number(numero)).catch(() => null);
    return {
      ...serie,
      temporada: {
        numero: Number(numero),
        nombre: s?.name || `Temporada ${Number(numero)}`,
        sinopsis: s?.overview ?? '',
        poster: img(s?.poster_path, 'w342'),
        anio: (s?.air_date ?? '').slice(0, 4),
        episodios: s?.episodes?.length ?? null,
        valoracion: s?.vote_average ? Math.round(s.vote_average * 10) / 10 : null,
      },
    };
  }
  const { anio, antes } = separarAnio(n);
  const tipo = partes.slice(0, -1).some((c) => CARPETA_SERIE.test(c)) ? 'serie' : null;
  const id = await identificar(prefijo, 'carpetas', { nombre: limpiarNombre(antes.replace(/^[¡¿]/, '')), tipo, anio });
  return id ? { encontrado: true, ...(await ficha(id.tmdbId, id.tipo)) } : { encontrado: false };
}

// Imágenes de fondo para las categorías de la portada que aún no tienen vídeos con ficha:
// lo más popular de ese tipo en TMDB (una vez al día como mucho)
const DESCUBRIR = {
  pelicula: ['/discover/movie', { without_genres: '16,99' }],
  serie: ['/discover/tv', { without_genres: '16,99,10764,10767' }],
  documental: ['/discover/movie', { with_genres: '99' }],
  docuserie: ['/discover/tv', { with_genres: '99' }],
  'anime-pelicula': ['/discover/movie', { with_genres: '16', with_original_language: 'ja' }],
  'anime-serie': ['/discover/tv', { with_genres: '16', with_original_language: 'ja' }],
  programa: ['/discover/tv', { with_genres: '10764' }],
  'novela-turca': ['/discover/tv', { with_original_language: 'tr' }],
};
const portadas = new Map(); // categoría → { hasta, fondos, carteles }

export async function portadaCategoria(id) {
  const c = portadas.get(id);
  if (c && c.hasta > Date.now()) return { fondos: c.fondos, carteles: c.carteles };
  const desc = id.startsWith('pl:') ? await descubrirPlataforma(id) : DESCUBRIR[id];
  if (!desc) throw Object.assign(new Error('Categoría desconocida'), { status: 400 });
  const [ruta, filtro] = desc;
  const { results = [] } = await pedir(ruta, { sort_by: 'popularity.desc', 'vote_count.gte': '100', include_adult: 'false', ...filtro });
  const fondos = results.filter((r) => r.backdrop_path).slice(0, 8).map((r) => img(r.backdrop_path, 'w780'));
  // Los carteles, para el mosaico de las carpetas de plataforma
  const carteles = results.filter((r) => r.poster_path).slice(0, 8).map((r) => img(r.poster_path, 'w342'));
  portadas.set(id, { hasta: Date.now() + 24 * 3600000, fondos, carteles });
  return { fondos, carteles };
}

// Elegir a mano el título correcto cuando la búsqueda automática se equivoca
export function corregir(clave, tmdbId, tipo) {
  if (tmdbId) cache.correcciones[clave] = { tmdbId: Number(tmdbId), tipo: tipo === 'serie' ? 'serie' : 'pelicula' };
  else delete cache.correcciones[clave];
  guardar();
  return { ok: true };
}

// La clave que identifica a un vídeo: la carpeta de la serie para los episodios
export function claveDe(key) {
  const d = analizar(key);
  return d?.tipo === 'serie' && d.carpeta ? d.carpeta : key;
}
