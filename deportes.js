// Portadas y fichas de lo que se sube a DEPORTES. TMDB no tiene carreras ni partidos, así que:
//  1. Si el nombre (archivo o carpeta) dice de qué competición es («MotoGP GP Jerez 2026.mp4»,
//     «LaLiga/Real Madrid vs Barcelona.mkv»), se usan el póster, el fondo y el escudo de esa
//     competición en TheSportsDB; en un partido «A vs B» se intenta además la imagen del partido.
//  2. Si no, la portada es un fotograma del propio vídeo (/api/fotograma, ver server.js).
// Lo encontrado se guarda en data/deportes.json: TheSportsDB gratis corta enseguida por exceso
// de consultas, así que cada competición y cada partido se piden una sola vez.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://www.thesportsdb.com/api/v1/json/123';

// La regla más concreta primero («moto2» antes que «motogp», «champions» antes que «liga»)
const LIGAS = [
  { id: 4436, re: /\bmoto\s*2\b/ },
  { id: 4407, re: /\bmoto\s*gp\b|mundial de motociclismo/ },
  { id: 4370, re: /\bf(ormula)?\s*-?\s*1\b|formula uno|\bgp de f1\b/ },
  { id: 4480, re: /champions/ },
  { id: 4335, re: /\blaliga\b|\bla liga\b|liga (ea|santander|espanola)|primera division/ },
  { id: 4387, re: /\bnba\b/ },
  { id: 4443, re: /\bufc\b/ },
];

let archivo;
let cache = { ligas: {}, partidos: {} };
let guardando = null;

export async function iniciar(dir) {
  archivo = path.join(dir, 'data', 'deportes.json');
  try { cache = { ...cache, ...JSON.parse(await readFile(archivo, 'utf8')) }; } catch {}
}

function guardar() {
  clearTimeout(guardando);
  guardando = setTimeout(async () => {
    await mkdir(path.dirname(archivo), { recursive: true });
    await writeFile(archivo, JSON.stringify(cache));
  }, 1000);
}

// Una consulta cada 2,5 s como mucho y, si TheSportsDB corta (429), 10 minutos sin preguntar
let turno = Promise.resolve();
let bloqueadoHasta = 0;
function pedir(ruta) {
  const p = turno.then(async () => {
    if (Date.now() < bloqueadoHasta) throw new Error('TheSportsDB en pausa');
    const r = await fetch(`${API}${ruta}`, { signal: AbortSignal.timeout(10000) });
    if (r.status === 429) { bloqueadoHasta = Date.now() + 10 * 60000; throw new Error('TheSportsDB: demasiadas consultas'); }
    if (!r.ok) throw new Error(`TheSportsDB: HTTP ${r.status}`);
    return r.json();
  });
  turno = p.catch(() => {}).then(() => new Promise((ok) => setTimeout(ok, 2500)));
  return p;
}

const normal = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[._]+/g, ' ');

async function liga(id) {
  if (cache.ligas[id]) return cache.ligas[id];
  const l = (await pedir(`/lookupleague.php?id=${id}`)).leagues?.[0];
  if (!l) return null;
  const datos = {
    nombre: l.strLeague,
    deporte: l.strSport,
    poster: l.strPoster || null,
    fondo: l.strFanart1 || l.strBanner || null,
    escudo: l.strBadge || l.strLogo || null,
    sinopsis: (l.strDescriptionES || l.strDescriptionEN || '').split(/\r?\n/)[0].slice(0, 500),
  };
  cache.ligas[id] = datos;
  guardar();
  return datos;
}

// «Real Madrid vs Barcelona» → imagen de ese partido (el más reciente con ese nombre)
async function partido(nombre) {
  const m = nombre.match(/(.+?)\s+(?:vs?\.?|contra)\s+(.+)/i);
  if (!m) return null;
  const q = `${m[1].trim()} vs ${m[2].trim()}`;
  if (q in cache.partidos) return cache.partidos[q];
  const eventos = (await pedir(`/searchevents.php?e=${encodeURIComponent(q.replace(/ /g, '_'))}`)).event ?? [];
  const e = eventos.find((x) => x.strThumb || x.strPoster);
  const datos = e ? { imagen: e.strThumb || null, poster: e.strPoster || null, liga: e.strLeague, fecha: e.dateEvent } : null;
  cache.partidos[q] = datos;
  guardar();
  return datos;
}

// Título legible del nombre del archivo: sin extensión, sin puntos ni guiones bajos y sin
// etiquetas de calidad
const titulo = (n) => n.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ')
  .replace(/\b(1080p|720p|2160p|4k|hdtv|web-?dl|webrip|x26[45]|h26[45]|hevc|aac)\b/gi, '').replace(/\s{2,}/g, ' ').trim();

// key: un vídeo («DEPORTES/…/x.mp4») o una carpeta («DEPORTES/MotoGP 2026/»)
export async function ficha(key, { carpeta = false } = {}) {
  const partes = key.replace(/\/$/, '').split('/');
  const nombre = partes.at(-1);
  const texto = normal(partes.slice(1).join(' '));
  const regla = LIGAS.find((l) => l.re.test(texto));
  const anio = nombre.match(/\b(19|20)\d{2}\b/)?.[0];
  const base = {
    encontrado: true, deporte: true, tipo: 'deporte', titulo: titulo(nombre), anio: anio ? Number(anio) : null,
    generos: [], poster: null, fondo: null,
  };
  let l = null;
  if (regla) l = await liga(regla.id).catch(() => null);
  if (l) {
    Object.assign(base, { poster: l.poster, fondo: l.fondo, escudo: l.escudo, liga: l.nombre, sinopsis: l.sinopsis });
    base.generos = [l.nombre, l.deporte].filter(Boolean);
  }
  if (!carpeta) {
    const p = await partido(titulo(nombre)).catch(() => null);
    if (p) {
      if (p.imagen) { base.imagen = p.imagen; base.fondo = p.imagen; }
      if (p.poster) base.poster = p.poster;
      if (!base.liga && p.liga) base.generos = [p.liga];
    }
    // Sin nada mejor, un fotograma del propio vídeo
    if (!base.poster && !base.imagen) base.imagen = `/api/fotograma?key=${encodeURIComponent(key)}`;
  }
  if (!base.poster && !base.imagen) return null;
  return base;
}
