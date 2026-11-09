// TMDB (opcional: TMDB_API_KEY en cuentas.env, clave v3 o token v4 de lectura). Lo usan la lista de
// episodios de «Subir» y los avisos de Telegram, para poner el cartel cuando Emby aún no lo tiene.
const BASE = process.env.TMDB_URL || 'https://api.themoviedb.org/3';
const IMG = process.env.TMDB_IMG || 'https://image.tmdb.org/t/p/w780';
const CLAVE = (process.env.TMDB_API_KEY ?? '').trim();
const error = (status, message) => Object.assign(new Error(message), { status });
const cache = new Map(); // dirección → { hasta, datos }
export const configurado = () => Boolean(CLAVE);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// GET a la API (en español). null si no existe
export async function tmdb(ruta, q = {}) {
  if (!CLAVE) throw error(503, 'Falta la clave de TMDB');
  const v4 = CLAVE.length > 40;
  const url = `${BASE}${ruta}?${new URLSearchParams({ language: 'es-ES', ...q, ...(v4 ? {} : { api_key: CLAVE }) })}`;
  const c = cache.get(url);
  if (c && c.hasta > Date.now()) return c.datos;
  let r;
  try {
    r = await fetch(url, { headers: { 'user-agent': 'MorvehTV-Cuentas', accept: 'application/json', ...(v4 ? { authorization: `Bearer ${CLAVE}` } : {}) }, signal: AbortSignal.timeout(12000) });
  } catch { throw error(502, 'No se pudo consultar TMDB'); }
  if (r.status === 404) { cache.set(url, { hasta: Date.now() + 600e3, datos: null }); return null; }
  if (r.status === 401) throw error(502, 'TMDB no acepta la clave (TMDB_API_KEY)');
  if (!r.ok) throw error(502, `TMDB no responde (${r.status})`);
  const datos = await r.json();
  if (cache.size > 500) cache.clear();
  cache.set(url, { hasta: Date.now() + 6 * 3600e3, datos });
  return datos;
}

// La ficha de TMDB de una película o serie: por su código de TMDB, de IMDb o por título (y año)
//   tipo: 'movie' | 'tv'
export async function buscar({ tipo, tmdb: id, imdb, nombre, ano }) {
  if (/^\d{1,9}$/.test(String(id ?? ''))) { const d = await tmdb(`/${tipo}/${id}`); if (d) return d; }
  if (/^tt\d{6,10}$/i.test(imdb ?? '')) {
    const f = await tmdb(`/find/${imdb.toLowerCase()}`, { external_source: 'imdb_id' });
    const x = (tipo === 'tv' ? f?.tv_results : f?.movie_results)?.[0];
    if (x) return x;
  }
  if (!nombre) return null;
  const q = { query: nombre, ...(ano ? (tipo === 'tv' ? { first_air_date_year: ano } : { primary_release_year: ano }) : {}) };
  const lista = (await tmdb(`/search/${tipo}`, q))?.results ?? [];
  const igual = lista.find((x) => [x.title, x.name, x.original_title, x.original_name].some((t) => t && norm(t) === norm(nombre)));
  return igual ?? (ano && lista.length ? lista[0] : null);
}

// El cartel (JPEG) de una película o serie → { datos, tipo } o null. Nunca lanza error.
export async function cartel(datos) {
  if (!CLAVE) return null;
  try {
    const x = await buscar(datos);
    if (!x?.poster_path) return null;
    const r = await fetch(`${IMG}${x.poster_path}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 1000 ? { datos: b, tipo: r.headers.get('content-type') || 'image/jpeg', sinopsis: x.overview || '' } : null;
  } catch { return null; }
}
