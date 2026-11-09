// Fichas para «Subir» del gestor: a partir de un enlace o código de IMDb (tt1234567), de TMDB
// (themoviedb.org/movie/123, /tv/456 o el número) o de un título, busca la película o serie con los
// proveedores de metadatos de Emby y devuelve título en español, año, códigos y cartel. Con eso el
// gestor nombra la carpeta como la entiende Emby: «Título (Año) [imdbid=tt1234567]».
import * as emby from './emby.js';

const error = (status, message) => Object.assign(new Error(message), { status });

// Qué ha escrito: código de IMDb, de TMDB (con el tipo si viene en el enlace) o un título (con año opcional)
export function interpretar(texto, tipo) {
  const t = String(texto ?? '').trim();
  if (!t) throw error(400, 'Escribe un enlace o código de IMDb o TMDB, o el título');
  if (t.length > 300) throw error(400, 'Demasiado largo');
  const imdb = /\btt\d{6,10}\b/i.exec(t)?.[0].toLowerCase();
  if (imdb) return { tipo, info: { ProviderIds: { Imdb: imdb } }, por: 'imdb' };
  const enlace = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(t);
  if (enlace) return { tipo: enlace[1].toLowerCase() === 'tv' ? 'serie' : 'pelicula', info: { ProviderIds: { Tmdb: enlace[2] } }, por: 'tmdb' };
  if (/^\d{1,8}$/.test(t)) return { tipo, info: { ProviderIds: { Tmdb: t } }, por: 'tmdb' };
  const conAno = /^(.*?)[\s(]+((?:19|20)\d{2})\)?$/.exec(t);
  return { tipo, info: conAno ? { Name: conAno[1].trim(), Year: Number(conAno[2]) } : { Name: t }, por: 'titulo' };
}

export async function buscar(texto, tipo) {
  if (!emby.configurado()) throw error(503, 'Emby no está conectado: no se pueden buscar fichas');
  const q = interpretar(texto, tipo === 'serie' ? 'serie' : 'pelicula');
  const r = await emby.buscarFicha(q.tipo === 'serie' ? 'Series' : 'Movie', q.info);
  const lista = (Array.isArray(r) ? r : r?.Items ?? []).slice(0, 10).map((x) => {
    const ids = Object.fromEntries(Object.entries(x.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
      nombre: String(x.Name ?? '').trim(),
      ano: x.ProductionYear ?? (x.PremiereDate ? Number(String(x.PremiereDate).slice(0, 4)) : null),
      imdb: /^tt\d+$/.test(ids.imdb ?? '') ? ids.imdb : null,
      tmdb: /^\d+$/.test(ids.tmdb ?? '') ? ids.tmdb : null,
      cartel: /^https:\/\//.test(x.ImageUrl ?? '') ? x.ImageUrl : null,
      resumen: x.Overview ? String(x.Overview).slice(0, 300) : null,
    };
  }).filter((x) => x.nombre && (x.imdb || x.tmdb));
  return { tipo: q.tipo, por: q.por, resultados: lista };
}
