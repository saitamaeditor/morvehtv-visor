// Episodios de una serie para «Subir» del gestor. La lista de temporadas y episodios sale de:
//  1) TMDB, si la VPS tiene TMDB_API_KEY en cuentas.env (clave v3 o token v4 de lectura; títulos en
//     español y casi todo el contenido, también el español), por su código de TMDB o IMDb o por título
//  2) TVmaze (API pública, sin clave; títulos en inglés y poco contenido español), si no
// y se marca cuáles ya están en e2 mirando los «S01E02» de la carpeta de la serie.
import * as e2 from './e2.js';

const error = (status, message) => Object.assign(new Error(message), { status });
const TVMAZE = process.env.TVMAZE_URL || 'https://api.tvmaze.com';
const TMDB = process.env.TMDB_URL || 'https://api.themoviedb.org/3';
const CLAVE_TMDB = (process.env.TMDB_API_KEY ?? '').trim();
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg)$/i;
const cache = new Map(); // dirección → { hasta, datos }
const HORAS = 6 * 3600e3;
export const conTmdb = () => Boolean(CLAVE_TMDB);

async function pedir(url, nombre, cabeceras = {}) {
  const c = cache.get(url);
  if (c && c.hasta > Date.now()) return c.datos;
  let r;
  try { r = await fetch(url, { headers: { 'user-agent': 'MorvehTV-Cuentas', accept: 'application/json', ...cabeceras }, signal: AbortSignal.timeout(12000) }); } catch { throw error(502, `No se pudo consultar la lista de episodios (${nombre})`); }
  if (r.status === 404) { cache.set(url, { hasta: Date.now() + 600e3, datos: null }); return null; }
  if (r.status === 401) throw error(502, `${nombre} no acepta la clave (TMDB_API_KEY)`);
  if (!r.ok) throw error(502, `La lista de episodios no responde (${nombre} ${r.status})`);
  const datos = await r.json();
  if (cache.size > 500) cache.clear();
  cache.set(url, { hasta: Date.now() + HORAS, datos });
  return datos;
}
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---- TMDB ----
// Clave v3 (32 caracteres) por ?api_key=; token v4 (largo) por la cabecera Authorization
function tmdb(ruta, q = {}) {
  const v4 = CLAVE_TMDB.length > 40;
  const p = new URLSearchParams({ language: 'es-ES', ...q, ...(v4 ? {} : { api_key: CLAVE_TMDB }) });
  return pedir(`${TMDB}${ruta}?${p}`, 'TMDB', v4 ? { authorization: `Bearer ${CLAVE_TMDB}` } : {});
}
async function serieTmdb({ tmdbId, imdb, nombre, ano }) {
  if (/^\d{1,9}$/.test(tmdbId ?? '')) return Number(tmdbId);
  if (/^tt\d{6,10}$/i.test(imdb ?? '')) {
    const f = await tmdb(`/find/${imdb.toLowerCase()}`, { external_source: 'imdb_id' });
    if (f?.tv_results?.[0]) return f.tv_results[0].id;
  }
  if (!nombre) return null;
  const r = (await tmdb('/search/tv', { query: nombre, ...(ano ? { first_air_date_year: ano } : {}) }))?.results ?? [];
  const igual = r.find((x) => norm(x.name) === norm(nombre) || norm(x.original_name) === norm(nombre));
  return (igual ?? (r.length === 1 ? r[0] : null))?.id ?? null;
}
async function deTmdb(datos) {
  const id = await serieTmdb(datos);
  if (!id) return null;
  const s = await tmdb(`/tv/${id}`);
  if (!s) return null;
  const temporadas = [];
  for (const t of (s.seasons ?? []).filter((x) => Number.isInteger(x.season_number) && x.episode_count > 0)) {
    const d = await tmdb(`/tv/${id}/season/${t.season_number}`);
    const episodios = (d?.episodes ?? []).filter((x) => Number.isInteger(x.episode_number))
      .map((x) => ({ e: x.episode_number, titulo: x.name ?? '', fecha: x.air_date || null }));
    // Si TMDB aún no tiene el detalle, al menos los números
    if (!episodios.length) for (let e = 1; e <= t.episode_count; e++) episodios.push({ e, titulo: '', fecha: null });
    temporadas.push({ n: t.season_number, episodios });
  }
  return { serie: { nombre: s.name, ano: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) : null, tmdb: String(id) }, temporadas, fuente: 'TMDB' };
}

// ---- TVmaze ----
async function deTvmaze({ imdb, nombre, ano }) {
  let show = null;
  if (/^tt\d{6,10}$/i.test(imdb ?? '')) show = await pedir(`${TVMAZE}/lookup/shows?imdb=${imdb.toLowerCase()}`, 'TVmaze');
  if (!show && nombre) {
    const lista = (await pedir(`${TVMAZE}/search/shows?q=${encodeURIComponent(nombre)}`, 'TVmaze')) ?? [];
    const iguales = lista.map((x) => x.show).filter((s) => norm(s.name) === norm(nombre));
    show = iguales.find((s) => !ano || String(s.premiered ?? '').startsWith(String(ano))) ?? (ano ? null : iguales[0]) ?? null;
  }
  if (!show) return null;
  const eps = (await pedir(`${TVMAZE}/shows/${show.id}/episodes`, 'TVmaze')) ?? [];
  const porTemp = new Map();
  for (const x of eps) {
    if (!Number.isInteger(x.season) || !Number.isInteger(x.number)) continue;
    if (!porTemp.has(x.season)) porTemp.set(x.season, []);
    porTemp.get(x.season).push({ e: x.number, titulo: x.name ?? '', fecha: x.airdate || null });
  }
  const temporadas = [...porTemp.entries()].map(([n, episodios]) => ({ n, episodios }));
  return { serie: { nombre: show.name, ano: show.premiered ? Number(show.premiered.slice(0, 4)) : null, imdb: show.externals?.imdb ?? null }, temporadas, fuente: 'TVmaze' };
}

// Lo que ya está subido: «… S01E02 …» (y los dobles «S01E01-E02») de la carpeta de la serie → ['1x2', …]
async function subidos(carpeta, serie) {
  const ya = new Set();
  if (!carpeta || !serie) return ya;
  let lista = [];
  try { lista = await e2.archivos(`${carpeta}/${serie}`); } catch (e) { if (e.status === 400 || e.status === 403) throw e; }
  for (const k of lista) {
    const nombreArchivo = k.split('/').pop();
    if (!VIDEO.test(nombreArchivo)) continue;
    const m = /S(\d{1,2})E(\d{1,4})(?:-?E(\d{1,4}))?/i.exec(nombreArchivo);
    if (!m) continue;
    const s = Number(m[1]); const hasta = Number(m[3] ?? m[2]);
    for (let e = Number(m[2]); e <= hasta && e - Number(m[2]) < 20; e++) ya.add(`${s}x${e}`);
  }
  return ya;
}

// { tmdb, imdb, nombre, ano, carpeta, serie } → { serie, fuente, temporadas: [{ n, episodios: [{ e, titulo, fecha, ya }] }], ya, tmdb }
export async function listar({ tmdb: tmdbId, imdb, nombre, ano, carpeta, serie }) {
  const ya = await subidos(carpeta, serie);
  const datos = { tmdbId, imdb, nombre: String(nombre ?? '').trim(), ano };
  let r = null; let fallo = null;
  if (CLAVE_TMDB) { try { r = await deTmdb(datos); } catch (e) { fallo = e; } }
  if (!r || !r.temporadas.length) { try { r = (await deTvmaze(datos)) ?? r; } catch (e) { fallo ??= e; } }
  if (!r && fallo) throw fallo;
  const temporadas = (r?.temporadas ?? []).sort((a, b) => a.n - b.n).map((t) => ({
    n: t.n, episodios: t.episodios.sort((a, b) => a.e - b.e).map((x) => ({ ...x, ya: ya.has(`${t.n}x${x.e}`) })),
  }));
  return { serie: r?.serie ?? null, fuente: r?.fuente ?? null, temporadas, ya: [...ya], tmdb: Boolean(CLAVE_TMDB) };
}
