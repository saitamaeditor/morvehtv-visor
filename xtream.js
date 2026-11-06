// Compatibilidad con reproductores tipo «Xtream Codes» (apps de iOS, Android, teles…): piden
// servidor, usuario y contraseña, y con eso ven cada sección de e2 como categoría de Películas o
// de Series, con carátulas y sinopsis. Se entra con la misma cuenta de MorvehTV.
//
//   /player_api.php?username=…&password=…[&action=…]   datos (categorías, títulos, fichas)
//   /movie/USUARIO/CLAVE/ID.ext  y  /series/…          reproducir: redirige al vídeo en e2
//   /get.php?username=…&password=…                      lista M3U con todo
//   /xmltv.php                                          guía de TV (vacía: no hay canales)
import { createHash } from 'node:crypto';
import * as defensa from './defensa.js';
import * as meta from './metadatos.js';
import { nombreSeccion } from './telegram.js';

let foto; let firmar; let esVideo; let credenciales; let esAdmin = async () => false;
// Quién puede usarlos: todas las cuentas, salvo que el servidor diga otra cosa (XTREAM_SOLO_VIP=1)
let permitido = async () => true;
export function iniciar(opciones) {
  ({ foto, firmar, esVideo, credenciales } = opciones);
  esAdmin = opciones.esAdmin ?? esAdmin;
  permitido = opciones.permitido ?? permitido;
}

export const esRuta = (ruta) => ['/player_api.php', '/get.php', '/xmltv.php'].includes(ruta)
  || /^\/(movie|series)\/[^/]+\/[^/]+\/\d+(\.\w+)?$/.test(ruta);

// Números fijos para cada cosa (estas apps quieren ids numéricos): salen del nombre, así que no
// cambian entre reinicios ni entre el servidor de casa y el de Render
const idDe = (texto) => parseInt(createHash('sha1').update(texto).digest('hex').slice(0, 7), 16);
const ext = (key) => (key.match(/\.(\w+)$/)?.[1] ?? 'mp4').toLowerCase();
const segundos = (fecha) => String(Math.floor(fecha / 1000));
const limpio = (key) => key.replace(/\/$/, '').split('/').pop().replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
const CARPETA_TEMPORADA = /^(?:temporada|season|temp|t|s)\s*(\d{1,2})$/i;

// ---------- El catálogo, a partir de la foto del bucket ----------
let modeloCache = { de: null, m: null };
async function modelo() {
  const f = await foto();
  if (modeloCache.de === f) return modeloCache.m;
  const m = { secciones: new Map(), peliculas: [], series: new Map(), porId: new Map() };
  for (const [key, v] of f) {
    const partes = key.split('/');
    if (partes.length < 2 || !esVideo(key)) continue;
    const seccion = `${partes[0]}/`;
    if (!m.secciones.has(seccion)) m.secciones.set(seccion, { id: idDe(seccion), carpeta: seccion, nombre: nombreSeccion(seccion).nombre });
    const fecha = Number(v.split(':')[1]);
    // Como en la portada: las carpetas que solo agrupan se saltan; si queda carpeta, es una serie
    let i = 1;
    while (i < partes.length - 1 && meta.esAgrupadora(partes[i])) i++;
    if (i >= partes.length - 1) {
      const p = { tipo: 'pelicula', id: idDe(key), key, seccion, fecha, nombre: limpio(key) };
      m.peliculas.push(p); m.porId.set(p.id, p);
      continue;
    }
    const clave = `${partes.slice(0, i + 1).join('/')}/`;
    if (!m.series.has(clave)) {
      const s = { tipo: 'serie', id: idDe(clave), clave, seccion, fecha, nombre: limpio(clave), episodios: [] };
      m.series.set(clave, s); m.porId.set(s.id, s);
    }
    const s = m.series.get(clave);
    s.fecha = Math.max(s.fecha, fecha);
    const a = meta.analizar(key);
    const temporadaCarpeta = partes.slice(i + 1, -1).map((c) => c.match(CARPETA_TEMPORADA)?.[1]).find(Boolean);
    const e = { tipo: 'episodio', id: idDe(key), key, serie: s, fecha,
      temporada: a?.tipo === 'serie' ? a.temporada : Number(temporadaCarpeta ?? 1), episodio: a?.tipo === 'serie' ? a.episodio : 0 };
    s.episodios.push(e); m.porId.set(e.id, e);
  }
  // Episodios sin número: van detrás, en el orden de sus nombres
  for (const s of m.series.values()) {
    s.episodios.sort((a, b) => a.temporada - b.temporada || (a.episodio || 1e4) - (b.episodio || 1e4) || a.key.localeCompare(b.key, 'es', { numeric: true }));
    const porTemp = {};
    for (const e of s.episodios) { porTemp[e.temporada] = (porTemp[e.temporada] ?? 0) + 1; if (!e.episodio) e.episodio = porTemp[e.temporada]; }
  }
  m.peliculas.sort((a, b) => b.fecha - a.fecha);
  modeloCache = { de: f, m };
  return m;
}

// Fichas (TMDB y demás): con tiempo límite, para que una búsqueda lenta no deje la app esperando
const fichas = new Map();
function ficha(x) {
  const id = x.tipo === 'serie' ? `c:${x.clave}` : `a:${x.key}`;
  if (!fichas.has(id)) {
    const p = (x.tipo === 'serie' ? meta.deCarpeta(x.clave) : meta.deArchivo(x.key)).catch(() => null);
    fichas.set(id, p);
    p.then((r) => { if (!r) fichas.delete(id); });
  }
  return Promise.race([fichas.get(id), new Promise((ok) => setTimeout(() => ok(null), 8000))]);
}
async function conFichas(lista, fn) {
  const fuera = new Array(lista.length);
  let siguiente = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (siguiente < lista.length) {
      const i = siguiente++;
      fuera[i] = fn(lista[i], await ficha(lista[i]));
    }
  }));
  return fuera;
}

const nota = (f) => (f?.valoracion ? Number(f.valoracion).toFixed(1) : '');
const nombre = (x, f) => (f?.encontrado ? `${f.titulo}${f.anio ? ` (${f.anio})` : ''}` : x.nombre);
const fondos = (f) => (f?.fondo ? [f.fondo] : []);
function duracion(min) {
  const s = Math.round((min || 0) * 60);
  return { duration_secs: s, duration: `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:00` };
}

// ---------- Respuestas ----------
const categorias = (m, deQue) => [...m.secciones.values()]
  .filter((c) => (deQue === 'pelicula' ? m.peliculas : [...m.series.values()]).some((x) => x.seccion === c.carpeta))
  .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  .map((c) => ({ category_id: String(c.id), category_name: c.nombre, parent_id: 0 }));

const deCategoria = (lista, m, categoria) => (categoria
  ? lista.filter((x) => String(m.secciones.get(x.seccion)?.id) === String(categoria)) : lista);

const peliculas = (m, categoria) => conFichas(deCategoria(m.peliculas, m, categoria), (p, f) => ({
  num: 0, name: nombre(p, f), stream_type: 'movie', stream_id: p.id, stream_icon: f?.poster ?? '',
  rating: nota(f), rating_5based: f?.valoracion ? Number((f.valoracion / 2).toFixed(1)) : 0, added: segundos(p.fecha),
  category_id: String(m.secciones.get(p.seccion).id), category_ids: [m.secciones.get(p.seccion).id],
  container_extension: ext(p.key), custom_sid: null, direct_source: '',
})).then((l) => l.map((x, i) => ({ ...x, num: i + 1 })));

const series = (m, categoria) => conFichas(deCategoria([...m.series.values()].sort((a, b) => b.fecha - a.fecha), m, categoria), (s, f) => ({
  num: 0, name: nombre(s, f), series_id: s.id, cover: f?.poster ?? '', plot: f?.sinopsis ?? '',
  cast: (f?.reparto ?? []).join(', '), director: (f?.direccion ?? f?.creadores ?? []).join(', '), genre: (f?.generos ?? []).join(', '),
  releaseDate: f?.anio ?? '', last_modified: segundos(s.fecha), rating: nota(f),
  rating_5based: f?.valoracion ? Number((f.valoracion / 2).toFixed(1)) : 0, backdrop_path: fondos(f), youtube_trailer: '',
  episode_run_time: String(f?.duracion ?? ''), category_id: String(m.secciones.get(s.seccion).id), category_ids: [m.secciones.get(s.seccion).id],
})).then((l) => l.map((x, i) => ({ ...x, num: i + 1 })));

async function infoPelicula(m, id) {
  const p = m.porId.get(Number(id));
  if (!p || p.tipo !== 'pelicula') return { info: {}, movie_data: {} };
  const f = await ficha(p);
  return {
    info: {
      name: nombre(p, f), o_name: f?.tituloOriginal ?? '', cover_big: f?.poster ?? '', movie_image: f?.poster ?? '',
      tmdb_id: f?.fuente === 'TMDB' ? String(f.id ?? '') : '', youtube_trailer: '', genre: (f?.generos ?? []).join(', '),
      plot: f?.sinopsis ?? '', description: f?.sinopsis ?? '', cast: (f?.reparto ?? []).join(', '), actors: (f?.reparto ?? []).join(', '),
      director: (f?.direccion ?? []).join(', '), releasedate: f?.anio ?? '', rating: nota(f), backdrop_path: fondos(f), ...duracion(f?.duracion),
    },
    movie_data: { stream_id: p.id, name: nombre(p, f), added: segundos(p.fecha), category_id: String(m.secciones.get(p.seccion).id),
      container_extension: ext(p.key), custom_sid: null, direct_source: '' },
  };
}

async function infoSerie(m, id) {
  const s = m.porId.get(Number(id));
  if (!s || s.tipo !== 'serie') return { seasons: [], info: {}, episodes: {} };
  const f = await ficha(s);
  const eps = await conFichas(s.episodios, (e, fe) => {
    const ep = fe?.episodio;
    return {
      id: String(e.id), episode_num: e.episodio, season: e.temporada, container_extension: ext(e.key),
      title: ep?.titulo && !/^Episodio \d+$/.test(ep.titulo) ? (/^\d/.test(ep.titulo) ? ep.titulo : `${e.episodio}. ${ep.titulo}`) : `Episodio ${e.episodio}`,
      info: { movie_image: ep?.imagen ?? f?.fondo ?? '', plot: ep?.sinopsis ?? '', releasedate: ep?.fecha ?? '', rating: '', ...duracion(ep?.duracion ?? f?.duracion) },
      custom_sid: '', added: segundos(e.fecha), direct_source: '',
    };
  });
  const episodes = {};
  for (const e of eps) (episodes[e.season] ??= []).push(e);
  return {
    seasons: Object.keys(episodes).map(Number).sort((a, b) => a - b).map((n) => ({
      season_number: n, name: `Temporada ${n}`, episode_count: episodes[n].length, cover: f?.poster ?? '', cover_big: f?.poster ?? '', overview: '', air_date: '',
    })),
    info: {
      name: nombre(s, f), cover: f?.poster ?? '', plot: f?.sinopsis ?? '', cast: (f?.reparto ?? []).join(', '),
      director: (f?.direccion ?? f?.creadores ?? []).join(', '), genre: (f?.generos ?? []).join(', '), releaseDate: f?.anio ?? '',
      last_modified: segundos(s.fecha), rating: nota(f), rating_5based: f?.valoracion ? Number((f.valoracion / 2).toFixed(1)) : 0,
      backdrop_path: fondos(f), youtube_trailer: '', episode_run_time: String(f?.duracion ?? ''), category_id: String(m.secciones.get(s.seccion).id),
    },
    episodes,
  };
}

// ---------- Rutas ----------
function base(req, nube) {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  const https = nube || req.headers['x-forwarded-proto'] === 'https';
  const [nombreHost, puerto] = host.split(':');
  return { url: `${https ? 'https' : 'http'}://${host}`, nombreHost, puerto: puerto ?? (https ? '443' : '80'), https };
}

export async function atender(ruta, req, res, json, { ip, nube }) {
  const url = new URL(req.url, 'http://x');
  if (ruta === '/xmltv.php') {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="MorvehTV"></tv>\n');
  }
  const ver = ruta.match(/^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)/);
  const usuario = ver ? decodeURIComponent(ver[2]) : url.searchParams.get('username');
  const clave = ver ? decodeURIComponent(ver[3]) : url.searchParams.get('password');
  let cuenta = null;
  let demasiadas = false;
  try {
    cuenta = await credenciales(usuario, clave, ip);
  } catch (e) {
    if (e.status !== 429) throw e;
    demasiadas = true;
  }
  // Registro para ver qué pide cada reproductor y por qué falla (sin IP ni contraseña); se lee con
  // «docker logs morvehtv-visor». Los vídeos no se apuntan (serían demasiadas líneas).
  if (!ver) {
    const accion = url.searchParams.get('action') || (ruta === '/get.php' ? `m3u ${url.searchParams.get('type') || ''}` : 'entrar');
    const resultado = cuenta ? 'ok' : demasiadas ? 'demasiados intentos' : !usuario ? 'sin usuario' : 'usuario o contraseña incorrectos';
    console.log(`Xtream: ${accion} · usuario «${String(usuario ?? '').slice(0, 30)}» · ${resultado} · app ${String(req.headers['user-agent'] ?? '¿?').slice(0, 80)}`);
  }

  const vetado = cuenta && !(await permitido(cuenta));
  if (vetado) {
    if (ver || ruta === '/get.php') { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Los reproductores externos son solo para cuentas VIP'); }
    return json(res, 200, { user_info: { auth: 0, status: 'Disabled', message: 'Los reproductores externos son solo para cuentas VIP' } });
  }

  // Reproducir: al vídeo en e2 con un enlace firmado (de 12 horas, para películas largas)
  if (ver) {
    if (!cuenta) { res.writeHead(401); return res.end(); }
    const x = (await modelo()).porId.get(Number(ver[4]));
    if (!x || x.tipo === 'serie' || (ver[1] === 'movie') !== (x.tipo === 'pelicula')) { res.writeHead(404); return res.end(); }
    // La misma vigilancia que en la web: cuentas compartidas o descargas masivas
    try { defensa.permitirVideo(cuenta, ip, x.key, await esAdmin(cuenta)); } catch (e) {
      res.writeHead(e.status ?? 429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(e.message);
    }
    res.writeHead(302, { location: await firmar(x.key, { segundos: 12 * 3600 }), 'cache-control': 'no-store' });
    return res.end();
  }

  const b = base(req, nube);
  if (ruta === '/get.php') {
    if (!cuenta) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Usuario o contraseña incorrectos'); }
    return m3u(req, res, b, usuario, clave);
  }

  if (!cuenta) return json(res, 200, { user_info: { auth: 0, status: 'Disabled', message: 'Usuario o contraseña incorrectos' } });
  const m = await modelo();
  switch (url.searchParams.get('action')) {
    case 'get_vod_categories': return json(res, 200, categorias(m, 'pelicula'));
    case 'get_series_categories': return json(res, 200, categorias(m, 'serie'));
    case 'get_live_categories': case 'get_live_streams': return json(res, 200, []);
    case 'get_vod_streams': return json(res, 200, await peliculas(m, url.searchParams.get('category_id')));
    case 'get_series': return json(res, 200, await series(m, url.searchParams.get('category_id')));
    case 'get_vod_info': return json(res, 200, await infoPelicula(m, url.searchParams.get('vod_id')));
    case 'get_series_info': return json(res, 200, await infoSerie(m, url.searchParams.get('series_id')));
    case 'get_short_epg': case 'get_simple_data_table': return json(res, 200, { epg_listings: [] });
    default: {
      const ahora = new Date();
      return json(res, 200, {
        user_info: {
          username: cuenta.usuario, password: clave, message: 'Bienvenido a MorvehTV', auth: 1, status: 'Active',
          exp_date: null, is_trial: '0', active_cons: '0', created_at: segundos(new Date(cuenta.creado).getTime()),
          max_connections: '5', allowed_output_formats: ['m3u8', 'ts'],
        },
        server_info: {
          url: b.nombreHost, port: b.https ? '80' : b.puerto, https_port: b.https ? b.puerto : '443', server_protocol: b.https ? 'https' : 'http',
          rtmp_port: '0', timezone: 'Europe/Madrid', timestamp_now: Math.floor(ahora / 1000),
          time_now: ahora.toISOString().slice(0, 19).replace('T', ' '),
        },
      });
    }
  }
}

// Lista M3U con todo (para los reproductores que solo aceptan una URL de lista)
async function m3u(req, res, b, usuario, clave) {
  const m = await modelo();
  const u = encodeURIComponent(usuario); const c = encodeURIComponent(clave);
  const linea = (nombreX, logo, grupo, enlace) =>
    `#EXTINF:-1 tvg-name="${nombreX.replace(/"/g, "'")}" tvg-logo="${logo ?? ''}" group-title="${grupo.replace(/"/g, "'")}",${nombreX}\n${enlace}`;
  const lineas = ['#EXTM3U'];
  lineas.push(...await conFichas(m.peliculas, (p, f) =>
    linea(nombre(p, f), f?.poster, m.secciones.get(p.seccion).nombre, `${b.url}/movie/${u}/${c}/${p.id}.${ext(p.key)}`)));
  for (const s of m.series.values()) {
    const f = await ficha(s);
    for (const e of s.episodios) {
      lineas.push(linea(`${nombre(s, f)} S${String(e.temporada).padStart(2, '0')}E${String(e.episodio).padStart(2, '0')}`,
        f?.poster, m.secciones.get(s.seccion).nombre, `${b.url}/series/${u}/${c}/${e.id}.${ext(e.key)}`));
    }
  }
  res.writeHead(200, { 'content-type': 'audio/x-mpegurl; charset=utf-8', 'content-disposition': 'inline; filename="morvehtv.m3u"', 'cache-control': 'no-store' });
  res.end(`${lineas.join('\n')}\n`);
}
