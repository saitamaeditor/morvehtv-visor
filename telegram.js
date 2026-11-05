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
const WEB = (process.env.VISOR_URL ?? 'https://morvehtv.com').replace(/\/$/, '');
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
      datos = { ...datos, chat: String(process.env.TELEGRAM_CHAT).trim(), chatNombre: null, temas: {}, charla: null };
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
  datos = { ...datos, chat: String(g.id), chatNombre: g.title ?? null, temas: {}, charla: null };
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
    text: `${emoji} <b>${html(nombre)}</b>\nAquí aparecerá todo lo nuevo que se suba a esta sección de MorvehTV.${datos.charla ? '\n💬 Para hablar, el tema «Chat».' : ''}` }).catch(() => {});
  await cerrarTema(t.message_thread_id);
  return datos.temas[carpeta];
}

// Los temas de avisos quedan cerrados: en ellos solo escriben el bot y los administradores, así
// no se pierden los avisos entre mensajes. (Si al bot le falta el permiso, se quedan abiertos.)
async function cerrarTema(id) {
  try { await llamar('closeForumTopic', { chat_id: datos.chat, message_thread_id: id }); } catch (e) {
    if (!/not_modified|TOPIC_NOT_MODIFIED/i.test(e.message)) console.error(`Telegram: no se pudo cerrar un tema (${e.message})`);
  }
}

// ---------- Tema «💬 Chat», abierto para que hable todo el grupo ----------
let charlaReintento = 0;
async function charlaAlDia() {
  if (datos.charla?.listo) return;
  if (!datos.charla?.id) {
    const t = await llamar('createForumTopic', { chat_id: datos.chat, name: '💬 Chat', icon_color: 16766590 });
    datos.charla = { id: t.message_thread_id };
    await guardarDatos();
    console.log('Telegram: tema «💬 Chat» creado');
    const m = await llamar('sendMessage', { chat_id: datos.chat, message_thread_id: t.message_thread_id, parse_mode: 'HTML',
      text: '💬 <b>Chat de MorvehTV</b>\nEste tema es para hablar: pide películas o series, comenta lo nuevo o avisa si algo no va.\nLos demás temas son solo para los avisos de contenido nuevo.' }).catch(() => null);
    if (m) await llamar('pinChatMessage', { chat_id: datos.chat, message_id: m.message_id, disable_notification: true }).catch(() => {});
  }
  // Que los miembros puedan escribir (si el grupo lo tenía quitado) y los temas de avisos, cerrados
  try {
    const g = await llamar('getChat', { chat_id: datos.chat });
    if (g.permissions && !g.permissions.can_send_messages) {
      await llamar('setChatPermissions', { chat_id: datos.chat, permissions: { ...g.permissions, can_send_messages: true }, use_independent_chat_permissions: true });
      console.log('Telegram: los miembros ya pueden escribir en el grupo');
    }
  } catch (e) { console.error(`Telegram: no se pudieron cambiar los permisos del grupo (${e.message})`); }
  for (const t of Object.values(datos.temas)) { await cerrarTema(t.id); await espera(500); }
  datos.charla.listo = true;
  await guardarDatos();
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
const limpio = (key) => key.split('/').pop().replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
const corto = (t, n) => (t && t.length > n ? `${t.slice(0, n - 1).trim()}…` : t);

// Un grupo es una película o los episodios de una misma serie: [{ key, tamano, fecha }]
async function mensaje(carpeta, clave, archivos) {
  const seccion = nombreSeccion(carpeta);
  const m = await meta.deArchivo(archivos[0].key).catch(() => null);
  const ver = clave.endsWith('/') ? clave : clave.slice(0, clave.lastIndexOf('/') + 1);
  // En qué carpeta de e2 está (en vez del peso)
  const carpetaE2 = `📁 <code>${html(ver || carpeta)}</code>`;
  const boton = { reply_markup: { inline_keyboard: [[{ text: '▶ Ver en MorvehTV', url: `${WEB}/#${encodeURIComponent(ver)}` }]] } };
  const datosTitulo = (f) => [f.valoracion && `⭐ ${Number(f.valoracion).toFixed(1)}`, f.anio, ...(f.generos ?? []).slice(0, 3)].filter(Boolean).join(' · ');

  if (!m || !m.encontrado) {
    const nombres = archivos.slice(0, 8).map((a) => `• ${html(limpio(a.key))}`);
    if (archivos.length > 8) nombres.push(`• y ${archivos.length - 8} más`);
    const texto = `${seccion.emoji} <b>${archivos.length === 1 ? 'Nuevo' : `${archivos.length} nuevos`} en ${html(seccion.nombre)}</b>\n\n${nombres.join('\n')}\n\n${carpetaE2}`;
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
  const texto = [cabecera, '', `<b>${html(m.titulo)}</b>`, html(datosTitulo(m)), cuerpo && `\n${cuerpo}`, `\n${carpetaE2}`]
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

// ---------- Bienvenida a quien entra en el grupo (en el tema General) ----------
// El bot escucha a Telegram (getUpdates): las entradas llegan como mensaje de servicio y como
// cambio de miembro; las dos cosas pasan con la misma persona, así que se saluda una sola vez.
let escuchando = false;
const saludados = new Map(); // id de usuario → cuándo
const ENTRADA_VIEJA = 6 * 3600; // si el servidor estuvo dormido, no se saluda con horas de retraso

async function escuchar() {
  escuchando = true;
  let offset;
  while (activo) {
    try {
      const r = await fetch(`${API}/bot${TOKEN}/getUpdates`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 25, allowed_updates: ['message', 'chat_member'] }),
        signal: AbortSignal.timeout(40000),
      });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) throw new Error(d.description ?? `error ${r.status}`);
      for (const u of d.result) {
        offset = u.update_id + 1;
        await entrada(u).catch((e) => console.error(`Telegram: bienvenida (${e.message})`));
      }
    } catch (e) {
      // 409: hay otro servidor escuchando al mismo bot; se vuelve a probar más tarde
      console.error(`Telegram: escuchando (${e.message})`);
      await espera(/conflict/i.test(e.message) ? 60000 : 10000);
    }
  }
  escuchando = false;
}

async function entrada(u) {
  let gente = []; let fecha = 0;
  const m = u.message;
  if (m?.new_chat_members && String(m.chat.id) === String(datos.chat)) { gente = m.new_chat_members; fecha = m.date; }
  const c = u.chat_member;
  if (c && String(c.chat.id) === String(datos.chat)) {
    const dentro = (s) => ['member', 'administrator', 'creator'].includes(s.status) || (s.status === 'restricted' && s.is_member);
    if (!dentro(c.old_chat_member) && dentro(c.new_chat_member)) { gente = [c.new_chat_member.user]; fecha = c.date; }
  }
  const ahora = Date.now();
  for (const [id, cuando] of saludados) if (ahora - cuando > 600000) saludados.delete(id);
  gente = gente.filter((p) => !p.is_bot && !saludados.has(p.id));
  if (!gente.length || Date.now() / 1000 - fecha > ENTRADA_VIEJA) return;
  gente.forEach((p) => saludados.set(p.id, ahora));
  await bienvenida(gente);
}

function enlaceTema(id) {
  // Grupo privado: -100123… → t.me/c/123…/tema
  const interno = String(datos.chat).replace(/^-100/, '');
  return `https://t.me/c/${interno}/${id}`;
}

async function bienvenida(gente) {
  const nombres = gente.map((p) => `<a href="tg://user?id=${p.id}">${html([p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'nuevo miembro')}</a>`);
  const quien = nombres.length === 1 ? nombres[0] : `${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)}`;
  const secciones = Object.values(datos.temas).map((t) => t.nombre).slice(0, 8);
  const texto = [
    `👋 <b>¡Bienvenid${gente.length === 1 ? 'o/a' : 'os/as'} a MorvehTV, ${quien}!</b>`,
    '',
    'Nos alegra tenerte aquí. Esto es lo que encontrarás en el grupo:',
    '',
    secciones.length ? `🔔 <b>Avisos de contenido nuevo</b>, cada sección en su tema:\n${secciones.map((s) => `   ${html(s)}`).join('\n')}` : '🔔 <b>Avisos de contenido nuevo</b>, cada sección en su tema.',
    datos.charla?.id ? '💬 <b>Chat</b>: el sitio para hablar, pedir películas o series y avisar si algo no funciona.' : null,
    '',
    '📌 <b>Normas</b>: respeto ante todo, nada de spam ni enlaces ajenos, y las peticiones en el Chat.',
    '',
    'Para ver el contenido, entra en MorvehTV con tu cuenta. ¡Disfruta! 🍿',
  ].filter((l) => l != null).join('\n');
  const botones = [[{ text: '▶ Abrir MorvehTV', url: WEB }]];
  if (datos.charla?.id && /^-100\d+$/.test(String(datos.chat))) botones[0].push({ text: '💬 Ir al Chat', url: enlaceTema(datos.charla.id) });
  // Sin tema: va al General
  await llamar('sendMessage', { chat_id: datos.chat, parse_mode: 'HTML', text: texto,
    link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: botones } });
  console.log(`Telegram: bienvenida a ${gente.length} persona${gente.length === 1 ? '' : 's'}`);
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
    // (si falla, no frena los avisos: se reintenta dentro de 10 minutos)
    if (Date.now() > charlaReintento) {
      try { await charlaAlDia(); } catch (e) { charlaReintento = Date.now() + 600000; console.error(`Telegram: no se pudo crear el tema «Chat» (${e.message})`); }
    }
    if (!escuchando) escuchar();
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
