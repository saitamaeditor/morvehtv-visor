// Episodios de una serie para «Subir» del gestor: la lista de temporadas y episodios sale de TVmaze
// (API pública, sin clave; se busca por el código de IMDb o, si no hay, por el título y el año) y se
// marca cuáles ya están en e2 mirando los «S01E02» de la carpeta de la serie.
import * as e2 from './e2.js';

const error = (status, message) => Object.assign(new Error(message), { status });
const BASE = process.env.TVMAZE_URL || 'https://api.tvmaze.com';
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg)$/i;
const cache = new Map(); // ruta de TVmaze → { hasta, datos }
const HORAS = 6 * 3600e3;

async function tvmaze(ruta) {
  const c = cache.get(ruta);
  if (c && c.hasta > Date.now()) return c.datos;
  let r;
  try { r = await fetch(BASE + ruta, { headers: { 'user-agent': 'MorvehTV-Cuentas' }, signal: AbortSignal.timeout(12000) }); } catch { throw error(502, 'No se pudo consultar la lista de episodios (TVmaze)'); }
  if (r.status === 404) { cache.set(ruta, { hasta: Date.now() + 600e3, datos: null }); return null; }
  if (!r.ok) throw error(502, `La lista de episodios no responde (TVmaze ${r.status})`);
  const datos = await r.json();
  if (cache.size > 300) cache.clear();
  cache.set(ruta, { hasta: Date.now() + HORAS, datos });
  return datos;
}

async function buscarSerie({ imdb, nombre, ano }) {
  if (/^tt\d{6,10}$/i.test(imdb ?? '')) {
    const s = await tvmaze(`/lookup/shows?imdb=${imdb.toLowerCase()}`);
    if (s) return s;
  }
  const n = String(nombre ?? '').trim();
  if (!n) return null;
  const lista = (await tvmaze(`/search/shows?q=${encodeURIComponent(n)}`)) ?? [];
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const iguales = lista.map((x) => x.show).filter((s) => norm(s.name) === norm(n));
  return iguales.find((s) => !ano || String(s.premiered ?? '').startsWith(String(ano))) ?? (ano ? null : iguales[0]) ?? null;
}

// { imdb, nombre, ano, carpeta, serie } → { serie, temporadas: [{ n, episodios: [{ e, titulo, fecha, ya }] }] }
export async function listar({ imdb, nombre, ano, carpeta, serie }) {
  const show = await buscarSerie({ imdb, nombre, ano });
  // Lo que ya está subido: «… S01E02 …» (y los dobles «S01E01-E02») de la carpeta de la serie
  const ya = new Set();
  if (carpeta && serie) {
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
  }
  if (!show) return { serie: null, temporadas: [], subidos: ya.size };
  const eps = (await tvmaze(`/shows/${show.id}/episodes`)) ?? [];
  const porTemp = new Map();
  for (const x of eps) {
    if (!Number.isInteger(x.season) || !Number.isInteger(x.number)) continue;
    if (!porTemp.has(x.season)) porTemp.set(x.season, []);
    porTemp.get(x.season).push({ e: x.number, titulo: x.name ?? '', fecha: x.airdate || null, ya: ya.has(`${x.season}x${x.number}`) });
  }
  const temporadas = [...porTemp.entries()].sort((a, b) => a[0] - b[0])
    .map(([n, episodios]) => ({ n, episodios: episodios.sort((a, b) => a.e - b.e) }));
  return { serie: { nombre: show.name, ano: show.premiered ? Number(show.premiered.slice(0, 4)) : null, imdb: show.externals?.imdb ?? null }, temporadas, subidos: ya.size };
}
