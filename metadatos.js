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

// ---------- Carpetas que solo agrupan ----------
// «PELICULAS NETFLIX», «NETFLIX», «PELICULAS NETFLIX INFANTILES»…: no son un título, solo
// ordenan. Dentro de una categoría se muestra su contenido directamente, todo junto, y no se
// buscan en TMDB. Lo son si TODAS sus palabras son de este vocabulario, así que «Mad Max» o
// «El alma intranquila» nunca lo son.
const AGRUPAN = new Set(`pelicula peliculas peli pelis cine movies movie serie series anime animes infantil infantiles
  kids ninos nino familia familiar familiares documental documentales docuserie docuseries programa programas tv
  novela novelas turca turcas netflix prime video amazon disney plus hbo max movistar apple skyshowtime sky showtime
  filmin rakuten atresplayer atres player mitele rtve play crunchyroll paramount dazn originales original estrenos
  estreno 4k hd uhd y e de del la las los el en otras otros varias varios mas nuevas nuevos`.split(/\s+/));
export function esAgrupadora(nombre) {
  const palabras = String(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/^\d+\s*[-_.]?\s*/, '').split(/[^a-z0-9]+/).filter(Boolean);
  return palabras.length > 0 && palabras.every((p) => AGRUPAN.has(p));
}

// Las fichas de TMDB se reutilizan entre todos los episodios de una serie
const fichas = new Map();
const temporadas = new Map();

function ficha(tmdbId, tipo) {
  const clave = `${tipo}:${tmdbId}`;
  if (!fichas.has(clave)) {
    const ruta = `/${tipo === 'serie' ? 'tv' : 'movie'}/${tmdbId}`;
    const p = pedir(ruta, { append_to_response: 'videos,credits' }).then(async (d) => {
      const trailer = (d.videos?.results ?? []).find((v) => v.site === 'YouTube' && v.type === 'Trailer');
      // Sin sinopsis o cartel en español: los de la ficha en inglés
      const en = !d.overview || !d.poster_path ? await pedir(ruta, { language: 'en-US' }).catch(() => null) : null;
      return {
        tmdbId: d.id,
        tipo,
        fuente: 'TMDB',
        titulo: d.title ?? d.name,
        tituloOriginal: d.original_title ?? d.original_name,
        sinopsis: d.overview || en?.overview || '',
        anio: (d.release_date ?? d.first_air_date ?? '').slice(0, 4),
        duracion: d.runtime ?? d.episode_run_time?.[0] ?? null,
        generos: (d.genres ?? []).map((g) => g.name),
        valoracion: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
        poster: img(d.poster_path || en?.poster_path, 'w342'),
        fondo: img(d.backdrop_path || en?.backdrop_path, 'w1280'),
        reparto: (d.credits?.cast ?? []).slice(0, 8).map((c) => c.name),
        direccion: (d.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name),
        creadores: (d.created_by ?? []).map((c) => c.name),
        temporadas: d.number_of_seasons ?? null,
        trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
        tmdb: `https://www.themoviedb.org/${tipo === 'serie' ? 'tv' : 'movie'}/${d.id}`,
        web: `https://www.themoviedb.org/${tipo === 'serie' ? 'tv' : 'movie'}/${d.id}`,
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

// Para /api/salud: «ok», «falta» (no hay TMDB_KEY) o «error» (TMDB no la acepta o no responde).
// Se comprueba como mucho una vez cada 10 minutos.
let estadoTmdb = null;
export function saludTmdb() {
  if (!tmdbKey()) return Promise.resolve('falta');
  if (!estadoTmdb || estadoTmdb.hasta < Date.now()) {
    // Con tope de 4 s: Render usa /api/salud para saber si el servicio está vivo
    const tope = new Promise((ok) => setTimeout(() => ok('error tiempo'), 4000));
    estadoTmdb = { hasta: Date.now() + 600000, p: Promise.race([pedir('/configuration').then(() => 'ok', (e) => `error ${e.message.match(/\d{3}/)?.[0] ?? ''}`.trim()), tope]) };
  }
  return estadoTmdb.p;
}

// ---------- Otras fuentes (gratis y sin clave) ----------
// Si TMDB no encuentra un título, o lo encuentra a medias (episodios sin nombre, sin resumen o
// sin imagen), se completa con TVmaze (series y programas), AniList (anime) y Wikipedia.
async function pedirJson(url, opciones = {}) {
  const r = await fetch(url, { ...opciones, headers: { 'user-agent': 'MorvehTV/1.0 (visor privado)', ...opciones.headers }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} respondió ${r.status}`), { status: 502 });
  return r.json();
}
const sinHtml = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\n{3,}/g, '\n\n').trim();
const recordar = (clave, crear) => {
  if (!fichas.has(clave)) { const p = crear(); p.catch(() => fichas.delete(clave)); fichas.set(clave, p); }
  return fichas.get(clave);
};

// TVmaze
async function buscarTvmaze(q) {
  const lista = await pedirJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
  return lista.map(({ show: s }) => ({ fuente: 'tvmaze', id: s.id, tipo: 'serie', titulo: s.name, original: s.name, anio: (s.premiered ?? '').slice(0, 4) }));
}
const showTvmaze = (id) => recordar(`tvmaze-show:${id}`, () =>
  pedirJson(`https://api.tvmaze.com/shows/${id}?embed[]=episodes&embed[]=cast&embed[]=seasons&embed[]=images`));
async function fichaTvmaze(id) {
  const s = await showTvmaze(id);
  const imagenes = s._embedded?.images ?? [];
  const fondo = imagenes.find((i) => i.type === 'background') ?? imagenes.find((i) => i.type === 'banner');
  return {
    tipo: 'serie', fuente: 'TVmaze', id,
    titulo: s.name, tituloOriginal: s.name, sinopsis: sinHtml(s.summary),
    anio: (s.premiered ?? '').slice(0, 4), duracion: s.averageRuntime ?? s.runtime ?? null,
    generos: s.genres ?? [], valoracion: s.rating?.average ?? null,
    poster: s.image?.original ?? s.image?.medium ?? null, fondo: fondo?.resolutions?.original?.url ?? null,
    reparto: (s._embedded?.cast ?? []).slice(0, 8).map((c) => c.person.name), direccion: [], creadores: [],
    temporadas: (s._embedded?.seasons ?? []).filter((t) => t.number > 0).length || null,
    trailer: null, web: s.url,
  };
}
async function temporadaTvmaze(id, numero) {
  const s = await showTvmaze(id);
  const t = (s._embedded?.seasons ?? []).find((x) => x.number === numero);
  return {
    nombre: t?.name || null, sinopsis: sinHtml(t?.summary), poster: t?.image?.original ?? null,
    anio: (t?.premiereDate ?? '').slice(0, 4), valoracion: null,
    episodios: (s._embedded?.episodes ?? []).filter((e) => e.season === numero).map((e) => ({
      numero: e.number, titulo: GENERICO.test(e.name ?? '') ? '' : e.name, sinopsis: sinHtml(e.summary), imagen: e.image?.original ?? e.image?.medium ?? null,
      fecha: e.airdate || null, duracion: e.runtime ?? null,
    })),
  };
}
// La serie de TMDB en TVmaze: por su código de IMDb o TheTVDB y, si no, por su título original
const tvmazeDeTmdb = (tmdbId) => recordar(`tvmaze-de:${tmdbId}`, async () => {
  const ext = await pedir(`/tv/${tmdbId}/external_ids`).catch(() => ({}));
  for (const [k, v] of [['imdb', ext.imdb_id], ['thetvdb', ext.tvdb_id]]) {
    if (!v) continue;
    const s = await pedirJson(`https://api.tvmaze.com/lookup/shows?${k}=${v}`).catch(() => null);
    if (s?.id) return s.id;
  }
  const f = await ficha(tmdbId, 'serie');
  for (const n of new Set([f.tituloOriginal, f.titulo])) {
    const r = mejor(await buscarTvmaze(n).catch(() => []), n, f.anio, true);
    if (r) return r.id;
  }
  return null;
});

// AniList (anime)
const CAMPOS_ANILIST = `id format title { romaji english native } synonyms startDate { year } description(asHtml: false)
  genres averageScore duration episodes coverImage { extraLarge } bannerImage siteUrl trailer { id site }
  streamingEpisodes { title thumbnail } studios(isMain: true) { nodes { name } }`;
const anilist = (query, variables) => pedirJson('https://graphql.anilist.co', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
}).then((d) => d.data);
async function buscarAnilist(q, tipo) {
  const d = await anilist(`query($q: String) { Page(perPage: 10) { media(search: $q, type: ANIME) { ${CAMPOS_ANILIST} } } }`, { q });
  return (d?.Page?.media ?? []).map((m) => {
    recordar(`anilist-media:${m.id}`, () => Promise.resolve(m));
    const serie = !['MOVIE', 'SPECIAL', 'MUSIC'].includes(m.format);
    return { fuente: 'anilist', id: m.id, tipo: serie ? 'serie' : 'pelicula', titulo: m.title.english || m.title.romaji,
      original: m.title.romaji, otros: [m.title.native, ...(m.synonyms ?? [])], anio: String(m.startDate?.year ?? '') };
  }).filter((r) => !tipo || r.tipo === tipo);
}
const mediaAnilist = (id) => recordar(`anilist-media:${id}`, () =>
  anilist(`query($id: Int) { Media(id: $id) { ${CAMPOS_ANILIST} } }`, { id: Number(id) }).then((d) => d.Media));
async function fichaAnilist(id, tipo) {
  const m = await mediaAnilist(id);
  return {
    tipo, fuente: 'AniList', id,
    titulo: m.title.english || m.title.romaji, tituloOriginal: m.title.native || m.title.romaji,
    sinopsis: sinHtml(m.description), anio: String(m.startDate?.year ?? ''), duracion: m.duration ?? null,
    generos: m.genres ?? [], valoracion: m.averageScore ? m.averageScore / 10 : null,
    poster: m.coverImage?.extraLarge ?? null, fondo: m.bannerImage ?? null,
    reparto: [], direccion: (m.studios?.nodes ?? []).map((s) => s.name), creadores: [],
    temporadas: tipo === 'serie' ? 1 : null,
    trailer: m.trailer?.site === 'youtube' ? `https://www.youtube.com/watch?v=${m.trailer.id}` : null, web: m.siteUrl,
  };
}
async function temporadaAnilist(id) {
  const m = await mediaAnilist(id);
  // «Episode 3 - Título»: el número sale del propio título
  const episodios = (m.streamingEpisodes ?? []).map((e, i) => {
    const r = e.title?.match(/^Episode\s+(\d+)\s*-\s*(.*)$/i);
    return { numero: r ? Number(r[1]) : i + 1, titulo: r ? r[2] : e.title, sinopsis: '', imagen: e.thumbnail ?? null, fecha: null, duracion: m.duration ?? null };
  });
  return { nombre: null, sinopsis: '', poster: null, anio: '', valoracion: null, episodios };
}

// Wikipedia en español (lo último: documentales, programas, estrenos que aún no están en otras)
const PISTA_WIKI = { serie: 'serie', pelicula: 'película' };
async function buscarWikipedia(q, tipo) {
  const d = await pedirJson(`https://es.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=8&srsearch=${encodeURIComponent(`${q} ${PISTA_WIKI[tipo] ?? ''}`.trim())}`);
  return (d.query?.search ?? []).map((r) => {
    const aclaracion = r.title.match(/\(([^)]*)\)\s*$/)?.[1] ?? '';
    const deQue = /serie|programa|telenovela|anime|docuserie|reality|concurso/i.test(aclaracion) ? 'serie'
      : /pel[ií]cula|film|documental/i.test(aclaracion) ? 'pelicula' : (tipo ?? 'pelicula');
    return { fuente: 'wikipedia', id: r.title, tipo: deQue, titulo: r.title.replace(/\s*\([^)]*\)\s*$/, ''), original: '', anio: aclaracion.match(/(?:19|20)\d{2}/)?.[0] ?? '' };
  }).filter((r) => !tipo || r.tipo === tipo);
}
async function fichaWikipedia(titulo, tipo) {
  const d = await pedirJson(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titulo.replace(/ /g, '_'))}`);
  return {
    tipo, fuente: 'Wikipedia', id: titulo,
    titulo: d.title.replace(/\s*\([^)]*\)\s*$/, ''), tituloOriginal: null, sinopsis: d.extract ?? '',
    anio: (d.description ?? '').match(/(?:19|20)\d{2}/)?.[0] ?? '', duracion: null, generos: [], valoracion: null,
    poster: d.originalimage?.source ?? d.thumbnail?.source ?? null, fondo: null,
    reparto: [], direccion: [], creadores: [], temporadas: null, trailer: null, web: d.content_urls?.desktop?.page ?? null,
  };
}

const RESPALDO = {
  tvmaze: { buscar: async (q, tipo) => (tipo === 'pelicula' ? [] : buscarTvmaze(q)), ficha: (id) => fichaTvmaze(id) },
  anilist: { buscar: buscarAnilist, ficha: fichaAnilist },
  wikipedia: { buscar: buscarWikipedia, ficha: fichaWikipedia },
};
// Anime → AniList primero; series y programas → TVmaze; lo demás → Wikipedia
const ordenRespaldo = ({ tipo, anime }) => (anime ? ['anilist', 'tvmaze', 'wikipedia'] : tipo === 'pelicula' ? ['wikipedia'] : ['tvmaze', 'wikipedia']);

// La ficha de un título, venga de donde venga
function fichaDe(id) {
  if (!id.fuente) return ficha(id.tmdbId, id.tipo);
  return recordar(`${id.fuente}:${id.tipo}:${id.id}`, () => RESPALDO[id.fuente].ficha(id.id, id.tipo));
}

// Una temporada con sus episodios. Con TMDB: el español, y lo que falte (nombre «Episodio 3»,
// sin resumen, sin imagen), del inglés y, si aún falta, de TVmaze.
const GENERICO = /^(?:episodio|episode|cap[ií]tulo|ep\.?)\s*\d+$/i;
const tmdbEpisodio = (e) => ({
  numero: e.episode_number, titulo: GENERICO.test(e.name ?? '') ? '' : e.name ?? '', sinopsis: e.overview ?? '',
  imagen: img(e.still_path, 'w300'), fecha: e.air_date ?? null, duracion: e.runtime ?? null,
});
function temporadaDe(id, numero) {
  if (id.fuente === 'tvmaze') return recordar(`tvmaze-temp:${id.id}:${numero}`, () => temporadaTvmaze(id.id, numero));
  if (id.fuente === 'anilist') return recordar(`anilist-temp:${id.id}`, () => temporadaAnilist(id.id));
  if (id.fuente) return Promise.resolve(null);
  return recordar(`tmdb-temp:${id.tmdbId}:${numero}`, async () => {
    const es = await temporada(id.tmdbId, numero).catch(() => null);
    const t = {
      nombre: es?.name || null, sinopsis: es?.overview ?? '', poster: img(es?.poster_path, 'w342'),
      anio: (es?.air_date ?? '').slice(0, 4), valoracion: es?.vote_average ? Math.round(es.vote_average * 10) / 10 : null,
      episodios: (es?.episodes ?? []).map(tmdbEpisodio),
    };
    const incompleto = () => !t.episodios.length || t.episodios.some((e) => !e.titulo || !e.sinopsis || !e.imagen);
    const completar = (otros) => {
      for (const o of otros) {
        const e = t.episodios.find((x) => x.numero === o.numero);
        if (!e) { t.episodios.push({ ...o, titulo: GENERICO.test(o.titulo ?? '') ? '' : o.titulo }); continue; }
        for (const k of ['titulo', 'sinopsis', 'imagen', 'fecha', 'duracion']) {
          if (!e[k] && o[k] && !(k === 'titulo' && GENERICO.test(o[k]))) e[k] = o[k];
        }
      }
      t.episodios.sort((a, b) => a.numero - b.numero);
    };
    if (incompleto()) {
      const en = await pedir(`/tv/${id.tmdbId}/season/${numero}`, { language: 'en-US' }).catch(() => null);
      if (en) {
        completar((en.episodes ?? []).map(tmdbEpisodio));
        if (!t.sinopsis) t.sinopsis = en.overview ?? '';
        if (!t.poster) t.poster = img(en.poster_path, 'w342');
      }
    }
    if (incompleto()) {
      const tv = await tvmazeDeTmdb(id.tmdbId).catch(() => null);
      const otra = tv && await temporadaTvmaze(tv, numero).catch(() => null);
      if (otra) { completar(otra.episodios); if (!t.poster) t.poster = otra.poster; }
    }
    return t;
  });
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
    .replace(/[\s\-–—:,.]+$/, '') // el « - » que queda al quitar el año: «Circe - 2026»
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
// También la parte de antes de « - » o «:» («A rienda suelta - Día de San Valentín») y, en los
// títulos largos, cada vez más corto hasta 3 palabras («Mobile Suit Gundam Hathaway La
// hechicería de la ninfa Circe» → … → «Mobile Suit Gundam Hathaway»)
function variantes(nombre) {
  const palabras = nombre.split(/\s+/).filter(Boolean);
  const lista = [nombre];
  for (let n = palabras.length - 1; n >= 1 && lista.length < 4; n--) {
    const v = palabras.slice(0, n).join(' ');
    if (v.length >= 4) lista.push(v);
  }
  const antes = nombre.split(/\s+[-–—]\s+|:\s*/)[0].trim();
  if (antes.length >= 4) lista.push(antes);
  for (let n = palabras.length - 4; n >= 3 && lista.length < 9; n--) lista.push(palabras.slice(0, n).join(' '));
  return [...new Set(lista)];
}

// TMDB ordena por popularidad: con «Mi mejor amiga» sale antes «La boda de mi mejor amiga».
// Entre los resultados se prefiere el que se llama exactamente igual (en español o en el
// original) y el del año del archivo; a igualdad, el más popular.
const comparable = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Con «estricto» (las otras fuentes, menos precisas que TMDB) el título tiene que coincidir
// entero y el año, si lo hay, no puede diferir en más de uno: si no, mejor sin ficha que con
// la de otra cosa
function mejor(lista, nombre, anio, estricto = false) {
  const buscado = comparable(nombre);
  let elegido = null;
  let puntos = -1;
  lista.slice(0, 10).forEach((r, i) => {
    const principales = [r.titulo, r.original].map(comparable).filter(Boolean);
    const titulos = [...principales, ...(r.otros ?? []).map(comparable)].filter(Boolean);
    if (estricto && (!titulos.includes(buscado) || (anio && r.anio && Math.abs(Number(r.anio) - Number(anio)) > 1))) return;
    let p = 0;
    if (principales.includes(buscado)) p += 4;
    else if (titulos.includes(buscado)) p += 2; // por un nombre alternativo: vale menos
    else if (titulos.some((t) => t.startsWith(buscado) || buscado.startsWith(t))) p += 1;
    if (anio && r.anio === String(anio)) p += 3;
    p -= i * 0.01; // a igualdad, el que TMDB pone antes
    if (p > puntos) { puntos = p; elegido = r; }
  });
  return elegido;
}

async function encontrarTmdb({ nombre, tipo, anio }) {
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

// TMDB primero; si no lo tiene (o no responde), las demás fuentes por orden
async function encontrar(datos) {
  const r = await encontrarTmdb(datos).catch(() => null);
  if (r) return { tmdbId: r.tmdbId, tipo: r.tipo };
  // Aquí sin recortar palabras («Love is in the Air» no puede acabar en «Love is»)
  const nombres = [...new Set([datos.nombre, datos.nombre.split(/\s+[-–—]\s+|:\s*/)[0].trim()])].filter((n) => n.length >= 2);
  for (const fuente of ordenRespaldo(datos)) {
    for (const n of nombres) {
      const lista = await RESPALDO[fuente].buscar(n, datos.tipo).catch(() => []);
      const o = mejor(lista, n, datos.anio, true);
      if (o) return { fuente: o.fuente, id: o.id, tipo: o.tipo };
    }
  }
  return null;
}

// ---------- Lo que pide la interfaz ----------
// Qué título es cada vídeo o carpeta: corrección a mano > caché > búsqueda. Se guarda
// { tmdbId, tipo } o, si lo encontró otra fuente, { fuente, id, tipo }
async function identificar(clave, seccion, datos) {
  if (cache.correcciones[clave]) return cache.correcciones[clave];
  if (clave in cache[seccion]) return cache[seccion][clave];
  const r = await encontrar(datos);
  // Solo se guarda lo encontrado: lo que no aparece se vuelve a buscar la próxima vez
  if (!r) return null;
  cache[seccion][clave] = r;
  guardar();
  return cache[seccion][clave];
}

export async function deArchivo(key) {
  const datos = analizar(key);
  if (!datos) return null;
  datos.anime = /anime/i.test(key);
  // Los episodios heredan la serie de su carpeta (o de otro episodio ya identificado)
  const id = datos.tipo === 'serie' && datos.carpeta
    ? await identificar(datos.carpeta, 'carpetas', datos)
    : await identificar(key, 'archivos', datos);
  if (!id) return { encontrado: false, buscado: datos.nombre };
  const f = await fichaDe(id);
  if (id.tipo !== 'serie') return { encontrado: true, ...f };

  const s = await temporadaDe(id, datos.temporada).catch(() => null);
  const e = s?.episodios.find((x) => x.numero === datos.episodio);
  return {
    encontrado: true,
    ...f,
    episodio: {
      temporada: datos.temporada,
      numero: datos.episodio,
      titulo: e?.titulo || `Episodio ${datos.episodio}`,
      sinopsis: e?.sinopsis ?? '',
      imagen: e?.imagen ?? null,
      fecha: e?.fecha ?? null,
      duracion: e?.duracion ?? null,
    },
  };
}

// Carpeta de una serie («SERIES/¡A por Jiro!/») o de una de sus temporadas
// («…/Temporada 2/»: la ficha de la serie más el póster, la sinopsis y los episodios de esa
// temporada). Las de categoría no tienen.
export async function deCarpeta(prefijo) {
  const partes = prefijo.replace(/\/$/, '').split('/');
  const n = partes.at(-1);
  if (partes.length < 2 || esAgrupadora(n)) return null;
  const numero = n.match(CARPETA_TEMPORADA)?.[1];
  if (numero) {
    if (partes.length < 3) return null;
    const padre = partes.slice(0, -1).join('/') + '/';
    const serie = await deCarpeta(padre);
    if (!serie?.encontrado || serie.tipo !== 'serie') return serie;
    const id = cache.correcciones[padre] ?? cache.carpetas[padre];
    const s = id && await temporadaDe(id, Number(numero)).catch(() => null);
    return {
      ...serie,
      temporada: {
        numero: Number(numero),
        nombre: s?.nombre || `Temporada ${Number(numero)}`,
        sinopsis: s?.sinopsis ?? '',
        poster: s?.poster ?? null,
        anio: s?.anio ?? '',
        episodios: s?.episodios.length || null,
        valoracion: s?.valoracion ?? null,
      },
    };
  }
  const { anio, antes } = separarAnio(n);
  const tipo = partes.slice(0, -1).some((c) => CARPETA_SERIE.test(c)) ? 'serie' : null;
  const id = await identificar(prefijo, 'carpetas', { nombre: limpiarNombre(antes.replace(/^[¡¿]/, '')), tipo, anio, anime: /anime/i.test(prefijo) });
  return id ? { encontrado: true, ...(await fichaDe(id)) } : { encontrado: false };
}

// Imágenes de fondo para las categorías de la portada que aún no tienen vídeos con ficha:
// lo más popular de ese tipo en TMDB (una vez al día como mucho)
const DESCUBRIR = {
  pelicula: ['/discover/movie', { without_genres: '16,99' }],
  serie: ['/discover/tv', { without_genres: '16,99,10764,10767' }],
  documental: ['/discover/movie', { with_genres: '99' }],
  docuserie: ['/discover/tv', { with_genres: '99' }],
  programa: ['/discover/tv', { with_genres: '10764' }],
  'novela-turca': ['/discover/tv', { with_original_language: 'tr' }],
  // Para las demás carpetas que vayas creando, según su nombre
  'anime-pelicula': ['/discover/movie', { with_genres: '16', with_original_language: 'ja' }],
  'anime-serie': ['/discover/tv', { with_genres: '16', with_original_language: 'ja' }],
  anime: ['/discover/tv', { with_genres: '16', with_original_language: 'ja' }],
  infantil: ['/discover/movie', { with_genres: '10751' }],
  musica: ['/discover/movie', { with_genres: '10402' }],
  terror: ['/discover/movie', { with_genres: '27' }],
};
const portadas = new Map(); // categoría → { hasta, fondos, carteles }

export async function portadaCategoria(id) {
  const c = portadas.get(id);
  if (c && c.hasta > Date.now()) return { fondos: c.fondos, carteles: c.carteles };
  const desc = DESCUBRIR[id];
  if (!desc) throw Object.assign(new Error('Categoría desconocida'), { status: 400 });
  const [ruta, filtro] = desc;
  const { results = [] } = await pedir(ruta, { sort_by: 'popularity.desc', 'vote_count.gte': '100', include_adult: 'false', ...filtro });
  const fondos = results.filter((r) => r.backdrop_path).slice(0, 8).map((r) => img(r.backdrop_path, 'w780'));
  // Los carteles, para el abanico de la tarjeta de la categoría
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
