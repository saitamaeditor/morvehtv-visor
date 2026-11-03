// Avisos de contenido nuevo en un grupo de Telegram con temas: cada sección de subida (carpeta
// de primer nivel de e2: «SERIES», «Estrenos 2026»…) tiene su tema, que se crea solo, también
// para las carpetas nuevas. Los episodios de una misma serie subidos juntos van en un mensaje.
//
// Se configura con variables de entorno (nunca en el código: el repositorio es público):
//  · TELEGRAM_TOKEN: el del bot de @BotFather. El bot tiene que ser administrador del grupo con
//    permiso para gestionar temas.
//  · TELEGRAM_CHAT (opcional): id del grupo. Si no está, se busca solo: basta con añadir el bot
//    al grupo (con los temas activados) y escribir cualquier cosa.
//  · TELEGRAM_AVISAR: «1» o «0». Por defecto solo avisa el servidor de Render, para que el de
//    casa no repita los mensajes.
// Lo que hay que recordar (grupo, temas y hasta qué fecha se ha avisado) se guarda en el archivo
// de cuentas de e2, el único que MorvehTV escribe, así que sobrevive a los reinicios de Render.
// Al despertar se avisa también de lo subido mientras dormía.
import * as meta from './metadatos.js';

const TOKEN = String(process.env.TELEGRAM_TOKEN ?? '').trim();
// Se puede cambiar para hacer pruebas con un Telegram simulado
const API = (process.env.TELEGRAM_API ?? 'https://api.telegram.org').replace(/\/$/, '');
const WEB = (process.env.VISOR_URL ?? 'https://morvehtv-visor.onrender.com').replace(/\/$/, '');
const COLORES = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047]; // los que admite Telegram

let activo = false;
let leer = null; let guardar = null; let esVideo = () => false;
let datos = null; // { chat, chatNombre, temas: { 'SERIES/': { id, nombre } }, ultimo }
let ocupado = false;
export let estado = 'desactivado';

async function llamar(metodo, cuerpo = {}, reintento = true) {
  const r = await fetch(`${API}/bot${TOKEN}/${metodo}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(20000),
  });
  const d = await r.json().catch(() => ({}));
  // Demasiados mensajes seguidos: Telegram dice cuánto esperar
  if (d.error_code === 429 && reintento) {
    await espera(((d.parameters?.retry_after ?? 5) + 1) * 1000);
    return llamar(metodo, cuerpo, false);
  }
  if (!d.ok) throw new Error(d.description ?? `error ${r.status}`);
  return d.result;
}
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const html = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const guardarDatos = () => guardar('telegram', datos);

export async function iniciar(opciones) {
  ({ leer, guardar, esVideo } = opciones);
  const quiere = process.env.TELEGRAM_AVISAR ? process.env.TELEGRAM_AVISAR === '1' : opciones.nube;
  if (!TOKEN || !quiere) {
    estado = TOKEN ? 'desactivado en este servidor' : 'sin TELEGRAM_TOKEN';
    return;
  }
  try {
    const yo = await llamar('getMe');
    datos = { temas: {}, ...(await leer('telegram')) };
    if (process.env.TELEGRAM_CHAT && String(process.env.TELEGRAM_CHAT) !== String(datos.chat)) {
      datos = { ...datos, chat: String(process.env.TELEGRAM_CHAT).trim(), chatNombre: null, temas: {} };
    }
    activo = true;
    estado = datos.chat ? 'ok' : 'falta el grupo';
    console.log(`Telegram: bot @${yo.username}${datos.chat ? `, grupo ${datos.chatNombre ?? datos.chat}` : ' (añádelo a un grupo con temas y escribe algo)'}`);
  } catch (e) {
    estado = `error: ${e.message}`;
    console.error(`Telegram: ${e.message}`);
  }
}

// Busca el grupo con temas en los mensajes recientes del bot
async function buscarGrupo() {
  const updates = await llamar('getUpdates', { allowed_updates: ['message', 'my_chat_member'] });
  const grupos = updates.map((u) => u.message?.chat ?? u.my_chat_member?.chat).filter((c) => c && c.is_forum);
  const g = grupos.at(-1);
  if (!g) return false;
  datos = { ...datos, chat: String(g.id), chatNombre: g.title ?? null, temas: {} };
  await guardarDatos();
  console.log(`Telegram: grupo encontrado, «${g.title}»`);
  return true;
}

// ---------- Temas ----------
// Nombre bonito y emoji de cada sección a partir del nombre de su carpeta
const ACENTOS = { peliculas: 'películas', pelicula: 'película', animacion: 'animación', musica: 'música', ninos: 'niños', tv: 'TV', hbo: 'HBO' };
const EMOJIS = [[/anime/, '🍥'], [/docu/, '🌍'], [/infantil|niñ|nin[oa]s|kids|anima/, '🧸'], [/turc/, '🇹🇷'], [/novela/, '💞'],
  [/music|músic|concierto/, '🎵'], [/programa|\btv\b|reality/, '📡'], [/terror|miedo/, '👻'], [/deport|futbol|fútbol/, '⚽'],
  [/estreno|nuevo/, '🆕'], [/serie/, '📺'], [/pel[ií]cula|cine|movie/, '🎬']];
// (también lo usa xtream.js para los nombres de las categorías)
export function nombreSeccion(carpeta) {
  const texto = carpeta.replace(/\/$/, '').toLowerCase().split(/\s+/).map((p) => ACENTOS[p] ?? p).join(' ');
  const emoji = (EMOJIS.find(([re]) => re.test(texto)) ?? [null, '📁'])[1];
  return { emoji, nombre: texto.charAt(0).toUpperCase() + texto.slice(1) };
}

async function crearTema(carpeta) {
  const { emoji, nombre } = nombreSeccion(carpeta);
  const color = COLORES[Object.keys(datos.temas).length % COLORES.length];
  const t = await llamar('createForumTopic', { chat_id: datos.chat, name: `${emoji} ${nombre}`.slice(0, 128), icon_color: color });
  datos.temas[carpeta] = { id: t.message_thread_id, nombre: t.name };
  await guardarDatos();
  console.log(`Telegram: tema creado, «${t.name}»`);
  // Un primer mensaje para que el tema no quede vacío
  await llamar('sendMessage', { chat_id: datos.chat, message_thread_id: t.message_thread_id, parse_mode: 'HTML',
    text: `${emoji} <b>${html(nombre)}</b>\nAquí aparecerá todo lo nuevo que se suba a esta sección de MorvehTV.` }).catch(() => {});
  return datos.temas[carpeta];
}

// Un tema por cada carpeta de primer nivel que aún no lo tenga
async function temasAlDia(carpetas) {
  for (const c of carpetas) {
    if (datos.temas[c]) continue;
    await crearTema(c);
    await espera(1500);
  }
}

// ---------- Mensajes ----------
function tamano(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}
const limpio = (key) => key.split('/').pop().replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
const corto = (t, n) => (t && t.length > n ? `${t.slice(0, n - 1).trim()}…` : t);

// Un grupo es una película o los episodios de una misma serie: [{ key, tamano, fecha }]
async function mensaje(carpeta, clave, archivos) {
  const seccion = nombreSeccion(carpeta);
  const m = await meta.deArchivo(archivos[0].key).catch(() => null);
  const total = archivos.reduce((s, a) => s + (a.tamano || 0), 0);
  const ver = clave.endsWith('/') ? clave : clave.slice(0, clave.lastIndexOf('/') + 1);
  const boton = { reply_markup: { inline_keyboard: [[{ text: '▶ Ver en MorvehTV', url: `${WEB}/#${encodeURIComponent(ver)}` }]] } };
  const datosTitulo = (f) => [f.valoracion && `⭐ ${Number(f.valoracion).toFixed(1)}`, f.anio, ...(f.generos ?? []).slice(0, 3)].filter(Boolean).join(' · ');

  if (!m || !m.encontrado) {
    const nombres = archivos.slice(0, 8).map((a) => `• ${html(limpio(a.key))}`);
    if (archivos.length > 8) nombres.push(`• y ${archivos.length - 8} más`);
    const texto = `${seccion.emoji} <b>${archivos.length === 1 ? 'Nuevo' : `${archivos.length} nuevos`} en ${html(seccion.nombre)}</b>\n\n${nombres.join('\n')}\n\n📦 ${tamano(total)}`;
    return { texto, foto: null, boton };
  }

  let cabecera, cuerpo = '';
  if (m.episodio) {
    const eps = await Promise.all(archivos.map((a) => (a === archivos[0] ? m : meta.deArchivo(a.key).catch(() => null))));
    const lista = eps.map((e, i) => (e?.episodio
      ? { t: e.episodio.temporada, n: e.episodio.numero, titulo: e.episodio.titulo }
      : { t: 0, n: 0, titulo: limpio(archivos[i].key) }))
      .sort((a, b) => a.t - b.t || a.n - b.n);
    cabecera = lista.length === 1 ? `📺 <b>Nuevo episodio en ${html(seccion.nombre)}</b>` : `📺 <b>${lista.length} episodios nuevos en ${html(seccion.nombre)}</b>`;
    const lineas = lista.slice(0, 8).map((e) => (e.n ? `▸ T${e.t}·E${String(e.n).padStart(2, '0')} ${html(e.titulo)}` : `▸ ${html(e.titulo)}`));
    if (lista.length > 8) lineas.push(`▸ y ${lista.length - 8} más`);
    cuerpo = lineas.join('\n');
    if (lista.length === 1 && m.episodio.sinopsis) cuerpo += `\n\n<i>${html(corto(m.episodio.sinopsis, 280))}</i>`;
    else if (m.sinopsis) cuerpo += `\n\n<i>${html(corto(m.sinopsis, 220))}</i>`;
  } else {
    cabecera = `${seccion.emoji} <b>Nuevo en ${html(seccion.nombre)}</b>`;
    if (m.sinopsis) cuerpo = `<i>${html(corto(m.sinopsis, 320))}</i>`;
  }
  const texto = [cabecera, '', `<b>${html(m.titulo)}</b>`, html(datosTitulo(m)), cuerpo && `\n${cuerpo}`, `\n📦 ${tamano(total)}`]
    .filter((l) => l !== '' && l != null).join('\n');
  // El cartel de TMDB, en un tamaño que se vea bien en Telegram
  const foto = (m.poster ?? m.fondo ?? '').replace(/\/t\/p\/w\d+\//, '/t/p/w780/') || null;
  return { texto: corto(texto, 1024), foto, boton };
}

async function enviar(tema, { texto, foto, boton }) {
  const base = { chat_id: datos.chat, message_thread_id: tema.id, parse_mode: 'HTML', ...boton };
  if (foto) {
    try {
      return await llamar('sendPhoto', { ...base, photo: foto, caption: texto });
    } catch (e) {
      if (/thread|topic/i.test(e.message)) throw e;
      // Si Telegram no puede bajar el cartel, va solo el texto
    }
  }
  return llamar('sendMessage', { ...base, text: texto, link_preview_options: { is_disabled: true } });
}

// Lo que el panel de gestión solo ha movido o renombrado no es contenido nuevo (al copiarlo en
// e2 cambia de fecha): esas claves no se avisan
const ignorados = new Map(); // key → hasta cuándo
export function ignorar(keys) {
  for (const k of keys) ignorados.set(k, Date.now() + 3600000);
}

// ---------- Cada repaso del bucket ----------
// `foto`: Map key → "tamaño:fecha" de todo el bucket. Avisa de los vídeos con fecha posterior al
// último aviso (así también de lo subido mientras el servidor dormía).
export async function repaso(foto) {
  if (!activo || ocupado) return;
  ocupado = true;
  try {
    if (!datos.chat && !(await buscarGrupo())) return;
    const carpetas = [...new Set([...foto.keys()].filter((k) => k.includes('/')).map((k) => `${k.split('/')[0]}/`))];
    await temasAlDia(carpetas);
    const videos = [...foto].filter(([k]) => esVideo(k) && k.includes('/'))
      .map(([key, v]) => { const [t, ms] = v.split(':'); return { key, tamano: Number(t), fecha: Number(ms) }; });
    const masNueva = Math.max(0, ...videos.map((v) => v.fecha));
    // La primera vez no se avisa de todo el catálogo: solo de lo que llegue a partir de ahora
    if (!datos.ultimo) { datos.ultimo = masNueva || Date.now(); await guardarDatos(); estado = 'ok'; return; }
    for (const [k, hasta] of ignorados) if (hasta < Date.now()) ignorados.delete(k);
    const todos = videos.filter((v) => v.fecha > datos.ultimo);
    const nuevos = todos.filter((v) => !ignorados.has(v.key)).sort((a, b) => a.fecha - b.fecha);
    if (!nuevos.length) {
      // Solo había cosas movidas: se dan por vistas
      if (todos.length) { datos.ultimo = Math.max(datos.ultimo, ...todos.map((v) => v.fecha)); await guardarDatos(); }
      estado = 'ok';
      return;
    }

    // Agrupados por sección y por título (la carpeta de la serie, como en la portada)
    const grupos = new Map();
    for (const v of nuevos) {
      const partes = v.key.split('/');
      let i = 1;
      while (i < partes.length - 1 && meta.esAgrupadora(partes[i])) i++;
      const clave = i < partes.length - 1 ? `${partes.slice(0, i + 1).join('/')}/` : v.key;
      const id = `${partes[0]}/|${clave}`;
      if (!grupos.has(id)) grupos.set(id, { carpeta: `${partes[0]}/`, clave, archivos: [] });
      grupos.get(id).archivos.push(v);
    }
    for (const g of grupos.values()) {
      const m = await mensaje(g.carpeta, g.clave, g.archivos);
      let tema = datos.temas[g.carpeta] ?? await crearTema(g.carpeta);
      try {
        await enviar(tema, m);
      } catch (e) {
        // Si alguien borró el tema, se vuelve a crear
        if (!/thread|topic/i.test(e.message)) throw e;
        delete datos.temas[g.carpeta];
        tema = await crearTema(g.carpeta);
        await enviar(tema, m);
      }
      // Hasta aquí avisado: si algo falla después no se repite lo ya enviado
      datos.ultimo = Math.max(datos.ultimo, ...g.archivos.map((a) => a.fecha));
      await guardarDatos();
      console.log(`Telegram: aviso en «${tema.nombre}» (${g.archivos.length} archivo${g.archivos.length === 1 ? '' : 's'})`);
      await espera(1500);
    }
    estado = 'ok';
  } catch (e) {
    estado = `error: ${e.message}`;
    console.error(`Telegram: ${e.message}`);
  } finally {
    ocupado = false;
  }
}
