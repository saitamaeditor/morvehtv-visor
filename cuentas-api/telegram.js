// Avisos de contenido nuevo de Emby en un grupo de Telegram con temas.
//
// Qué hace:
//  · Cada 5 minutos mira lo que Emby ha añadido. Espera a que una cosa lleve 10 minutos en Emby
//    antes de avisar, para que ya tenga su ficha completa (cartel, sinopsis, reparto…).
//  · Cada biblioteca de Emby tiene su tema en el grupo, que se crea solo. Si el grupo ya tenía
//    los temas de la web antigua (uno por carpeta de e2), se reutilizan.
//  · Película → un aviso con cartel, nota, duración, géneros, dirección, reparto, sinopsis y
//    botones «Ver en Emby» y «Tráiler».
//  · Serie nueva → un aviso con todos los episodios que han llegado juntos.
//  · Episodios nuevos de una serie que ya estaba → un aviso corto con la lista de episodios.
//  · Si llegan muchas cosas a la vez a una biblioteca (más de 12), un solo resumen en vez de
//    llenar el tema de mensajes.
//  · Igual que antes: tema «💬 Chat» abierto para hablar, temas de avisos cerrados, bienvenida a
//    quien entra y /anuncio (los administradores del grupo, en privado al bot) → tema «📢 Avisos».
//
// Se configura en /etc/morvehtv-cuentas/cuentas.env (nunca en el código: el repositorio es público):
//  · TELEGRAM_TOKEN: el del bot de @BotFather. El bot tiene que ser administrador del grupo con
//    permiso para gestionar temas.
//  · TELEGRAM_CHAT (opcional): id del grupo. Si no está, se busca solo: basta con añadir el bot
//    al grupo (con los temas activados) y escribir cualquier cosa.
// Lo que hay que recordar (grupo, temas, hasta cuándo se ha avisado) va en el ajuste «telegram».
import * as emby from './emby.js';

const TOKEN = String(process.env.TELEGRAM_TOKEN ?? '').trim();
const API = (process.env.TELEGRAM_API ?? 'https://api.telegram.org').replace(/\/$/, '');
const CADA = Number(process.env.TELEGRAM_CADA_MS ?? 5 * 60000);
const MADURO = Number(process.env.TELEGRAM_ESPERA_MS ?? 10 * 60000); // tiempo en Emby antes de avisar
const MUCHOS = 12; // más avisos que esto en una biblioteca y un repaso → un resumen
const PAUSA = Number(process.env.TELEGRAM_PAUSA_MS ?? 3000); // entre mensajes (Telegram limita ~20/min por grupo)
const COLORES = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047]; // los que admite Telegram

let p = null;
let activo = false;
let datos = null; // { chat, chatNombre, temas: { 'lib:<id>' | 'SERIES/': { id, nombre } }, charla, avisos, ultimoEmby }
let ocupado = false;
let servidorId = null;
export let estado = 'sin TELEGRAM_TOKEN';

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const html = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const guardarDatos = () => p.guardarAjuste('telegram', datos);

async function llamar(metodo, cuerpo = {}, reintento = true) {
  const multipart = cuerpo instanceof FormData;
  const r = await fetch(`${API}/bot${TOKEN}/${metodo}`, {
    method: 'POST',
    ...(multipart ? { body: cuerpo } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) }),
    signal: AbortSignal.timeout(30000),
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

export async function iniciar(opciones) {
  p = opciones.perfiles;
  if (!TOKEN) return;
  if (!emby.configurado()) { estado = 'Emby sin configurar'; return; }
  try {
    const yo = await llamar('getMe');
    datos = { temas: {}, ...(await p.leerAjuste('telegram')) };
    if (process.env.TELEGRAM_CHAT && String(process.env.TELEGRAM_CHAT).trim() !== String(datos.chat)) {
      datos = { ...datos, chat: String(process.env.TELEGRAM_CHAT).trim(), chatNombre: null, temas: {}, charla: null, avisos: null };
    }
    activo = true;
    estado = datos.chat ? 'ok' : 'falta el grupo';
    await llamar('deleteMyCommands', {}).catch(() => {});
    await llamar('setMyCommands', { commands: [{ command: 'anuncio', description: 'Publicar un aviso en el grupo (solo administradores)' }],
      scope: { type: 'all_private_chats' } }).catch(() => {});
    console.log(`Telegram: bot @${yo.username}${datos.chat ? `, grupo ${datos.chatNombre ?? datos.chat}` : ' (añádelo a un grupo con temas y escribe algo)'}`);
    setTimeout(repaso, 15000).unref();
    setInterval(repaso, CADA).unref();
  } catch (e) {
    estado = `error: ${e.message}`;
    console.error(`Telegram: ${e.message}`);
  }
}

// Busca el grupo con temas en los mensajes recientes del bot
async function buscarGrupo() {
  const updates = await llamar('getUpdates', { allowed_updates: ['message', 'my_chat_member'] });
  const g = updates.map((u) => u.message?.chat ?? u.my_chat_member?.chat).filter((c) => c && c.is_forum).at(-1);
  if (!g) return false;
  datos = { ...datos, chat: String(g.id), chatNombre: g.title ?? null, temas: {}, charla: null, avisos: null };
  await guardarDatos();
  console.log(`Telegram: grupo encontrado, «${g.title}»`);
  return true;
}

// ---------- Temas (uno por biblioteca de Emby) ----------
const ACENTOS = { peliculas: 'películas', pelicula: 'película', animacion: 'animación', musica: 'música', ninos: 'niños', tv: 'TV', hbo: 'HBO' };
const EMOJIS = [[/anime/, '🍥'], [/docu/, '🌍'], [/infantil|niñ|nin[oa]s|kids|anima/, '🧸'], [/turc/, '🇹🇷'], [/novela/, '💞'],
  [/music|músic|concierto/, '🎵'], [/programa|\btv\b|reality/, '📡'], [/terror|miedo/, '👻'], [/deport|futbol|fútbol/, '⚽'],
  [/estreno|nuevo/, '🆕'], [/serie/, '📺'], [/pel[ií]cula|cine|movie/, '🎬']];
function nombreSeccion(nombre) {
  const texto = String(nombre).replace(/\/$/, '').toLowerCase().split(/\s+/).map((x) => ACENTOS[x] ?? x).join(' ');
  const emoji = (EMOJIS.find(([re]) => re.test(texto)) ?? [null, '📁'])[1];
  return { emoji, nombre: texto.charAt(0).toUpperCase() + texto.slice(1) };
}

async function cerrarTema(id) {
  try { await llamar('closeForumTopic', { chat_id: datos.chat, message_thread_id: id }); } catch (e) {
    if (!/not_modified|TOPIC_NOT_MODIFIED/i.test(e.message)) console.error(`Telegram: no se pudo cerrar un tema (${e.message})`);
  }
}

async function crearTema(lib) {
  const { emoji, nombre } = nombreSeccion(lib.nombre);
  const color = COLORES[Object.keys(datos.temas).length % COLORES.length];
  const t = await llamar('createForumTopic', { chat_id: datos.chat, name: `${emoji} ${nombre}`.slice(0, 128), icon_color: color });
  datos.temas[lib.clave] = { id: t.message_thread_id, nombre: t.name };
  await guardarDatos();
  console.log(`Telegram: tema creado, «${t.name}»`);
  await llamar('sendMessage', { chat_id: datos.chat, message_thread_id: t.message_thread_id, parse_mode: 'HTML',
    text: `${emoji} <b>${html(nombre)}</b>\nAquí aparecerá todo lo nuevo que llegue a esta biblioteca.${datos.charla ? '\n💬 Para hablar, el tema «Chat».' : ''}` }).catch(() => {});
  await cerrarTema(t.message_thread_id);
  return datos.temas[lib.clave];
}

// El tema de una biblioteca: el suyo, el de su carpeta en la web antigua, o uno nuevo
async function temaDe(lib) {
  if (datos.temas[lib.clave]) return datos.temas[lib.clave];
  const viejo = lib.carpetas.map((c) => datos.temas[c]).find(Boolean);
  if (viejo) {
    datos.temas[lib.clave] = viejo;
    await guardarDatos();
    console.log(`Telegram: la biblioteca «${lib.nombre}» usa el tema que ya había, «${viejo.nombre}»`);
    return viejo;
  }
  return crearTema(lib);
}

// Bibliotecas de Emby con su carpeta de e2 (/e2/SERIES → «SERIES/», como los temas antiguos)
async function bibliotecas() {
  const lista = (await emby.consultar('/Library/VirtualFolders')) ?? [];
  return lista.filter((b) => b.ItemId).map((b) => ({
    id: String(b.ItemId),
    clave: `lib:${b.ItemId}`,
    nombre: b.Name,
    tipo: b.CollectionType ?? '',
    carpetas: (b.Locations ?? []).map((l) => String(l).replace(/\\/g, '/').match(/^\/e2\/([^/]+)/)?.[1]).filter(Boolean).map((c) => `${c}/`),
  }));
}

// ---------- Tema «💬 Chat», abierto para que hable todo el grupo ----------
let charlaReintento = 0;
async function charlaAlDia() {
  if (datos.charla?.listo) return;
  if (!datos.charla?.id) {
    const t = await llamar('createForumTopic', { chat_id: datos.chat, name: '💬 Chat', icon_color: 16766590 });
    datos.charla = { id: t.message_thread_id };
    await guardarDatos();
    const m = await llamar('sendMessage', { chat_id: datos.chat, message_thread_id: t.message_thread_id, parse_mode: 'HTML',
      text: '💬 <b>Chat de MorvehTV</b>\nEste tema es para hablar: pide películas o series, comenta lo nuevo o avisa si algo no va.\nLos demás temas son solo para los avisos de contenido nuevo.' }).catch(() => null);
    if (m) await llamar('pinChatMessage', { chat_id: datos.chat, message_id: m.message_id, disable_notification: true }).catch(() => {});
  }
  try {
    const g = await llamar('getChat', { chat_id: datos.chat });
    if (g.permissions && !g.permissions.can_send_messages) {
      await llamar('setChatPermissions', { chat_id: datos.chat, permissions: { ...g.permissions, can_send_messages: true }, use_independent_chat_permissions: true });
    }
  } catch (e) { console.error(`Telegram: no se pudieron cambiar los permisos del grupo (${e.message})`); }
  datos.charla.listo = true;
  await guardarDatos();
}

// ---------- Mensajes ----------
const SEPARADOR = '━━━━━━━━━━━━━━━━━━';
const corto = (t, n) => (t && t.length > n ? `${t.slice(0, n - 1).trim()}…` : t);
const etiqueta = (g) => `#${String(g).replace(/(^|\s)(\p{L})/gu, (_, e, l) => l.toUpperCase()).replace(/[^\p{L}\p{N}]+/gu, '')}`;
const lista = (xs, n) => (xs ?? []).filter(Boolean).slice(0, n).map(html).join(', ');
function duracionTexto(ticks) {
  const min = Math.round(Number(ticks ?? 0) / 6e8);
  if (!min) return null;
  return min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`;
}
const enlaceEmby = (id) => `${emby.direccionPublica()}/web/index.html#!/item?id=${encodeURIComponent(id)}${servidorId ? `&serverId=${encodeURIComponent(servidorId)}` : ''}`;
const botones = (id, trailer) => ({ reply_markup: { inline_keyboard: [[
  { text: '▶ Ver en Emby', url: enlaceEmby(id) },
  ...(trailer && /^https:\/\//.test(trailer) ? [{ text: '🎞️ Tráiler', url: trailer }] : []),
]] } });

// Qué es, según la biblioteca: el encabezado del aviso
function tipoDeAviso(lib, serie, nuevosEpisodios) {
  const t = `${lib.nombre} ${lib.tipo}`.toLowerCase();
  if (nuevosEpisodios) return ['🆕', 'NUEVOS EPISODIOS'];
  if (serie) {
    if (/docuserie/.test(t)) return ['🎞️', 'NUEVA DOCUSERIE'];
    if (/anime/.test(t)) return ['🐉', 'NUEVA SERIE ANIME'];
    if (/novela|turc/.test(t)) return ['🌙', 'NUEVA NOVELA'];
    if (/programa|\btv\b|reality/.test(t)) return ['📡', 'NUEVO PROGRAMA'];
    if (/infantil|kids/.test(t)) return ['🧸', 'NUEVA SERIE INFANTIL'];
    return ['📺', 'NUEVA SERIE'];
  }
  if (/documental/.test(t)) return ['🌍', 'NUEVO DOCUMENTAL'];
  if (/anime/.test(t)) return ['🍥', 'NUEVA PELÍCULA ANIME'];
  if (/infantil|kids/.test(t)) return ['🧸', 'NUEVA PELÍCULA INFANTIL'];
  if (/concierto|music/.test(t)) return ['🎵', 'NUEVO CONCIERTO'];
  if (/estreno/.test(t)) return ['🎟️', 'ESTRENO'];
  return ['🎬', 'NUEVA PELÍCULA'];
}

// Recorta la sinopsis hasta que quepa (Telegram admite 1024 caracteres junto a una foto)
function montar(partes, sinopsis, max) {
  for (const largo of [420, 280, 160, 0]) {
    const s = largo && sinopsis ? `<blockquote expandable>${html(corto(sinopsis, largo))}</blockquote>` : null;
    const texto = partes(s).filter((l) => l != null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (texto.replace(/<[^>]+>/g, '').length <= max) return texto;
  }
  return corto(partes(null).filter((l) => l != null).join('\n'), max);
}

const temporadasTexto = (nums) => (nums.length === 1 ? `Temporada ${nums[0]}` : `Temporadas ${nums.join(', ')}`);
// «E1–E4, E7» a partir de los números de episodio
function rangos(nums) {
  const n = [...new Set(nums.filter((x) => Number.isInteger(x)))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(j > i ? `E${n[i]}–E${n[j]}` : `E${n[i]}`);
    i = j;
  }
  return out.join(', ');
}

// La ficha (película o serie) → aviso. `episodios`: los que han llegado (si es serie)
function aviso(lib, ficha, { episodios = null, nuevosEpisodios = false } = {}) {
  const esSerie = Boolean(episodios);
  const [emoji, que] = tipoDeAviso(lib, esSerie, nuevosEpisodios);
  const seccion = nombreSeccion(lib.nombre);
  const anio = ficha.ProductionYear ? ` (${ficha.ProductionYear})` : '';
  const original = ficha.OriginalTitle && ficha.OriginalTitle.toLowerCase() !== String(ficha.Name).toLowerCase() ? `<i>${html(ficha.OriginalTitle)}</i>` : null;
  const nota = ficha.CommunityRating ? `⭐ <b>${Number(ficha.CommunityRating).toFixed(1)}</b>/10` : null;
  const edad = ficha.OfficialRating ? `🔖 ${html(ficha.OfficialRating)}` : null;
  const duracion = esSerie ? null : (duracionTexto(ficha.RunTimeTicks) && `⏱ ${duracionTexto(ficha.RunTimeTicks)}`);
  const generos = (ficha.Genres ?? []).slice(0, 3);
  const gente = (tipo) => (ficha.People ?? []).filter((x) => x.Type === tipo).map((x) => x.Name);
  const autor = esSerie ? null : (gente('Director').length ? `🎬 Dirección: ${lista(gente('Director'), 2)}` : null);
  const reparto = gente('Actor').length ? `👥 Reparto: ${lista(gente('Actor'), 4)}` : null;

  let eps = null;
  if (esSerie) {
    const temps = [...new Set(episodios.map((e) => e.ParentIndexNumber).filter(Number.isInteger))].sort((a, b) => a - b);
    if (nuevosEpisodios) {
      // Lista corta: «T2 · E5 · Título»
      const orden = [...episodios].sort((a, b) => (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
      const lineas = orden.slice(0, 8).map((e) => `▫️ ${[Number.isInteger(e.ParentIndexNumber) && `T${e.ParentIndexNumber}`, Number.isInteger(e.IndexNumber) && `E${e.IndexNumber}`].filter(Boolean).join(' · ')}${e.Name && !/^episod/i.test(e.Name) ? ` — ${html(corto(e.Name, 40))}` : ''}`);
      if (orden.length > 8) lineas.push(`▫️ y ${orden.length - 8} más`);
      eps = [`📀 ${episodios.length} episodio${episodios.length === 1 ? '' : 's'} nuevo${episodios.length === 1 ? '' : 's'}`, ...lineas].join('\n');
    } else {
      const porTemp = temps.map((t) => `${temps.length > 1 ? `T${t}: ` : ''}${rangos(episodios.filter((e) => e.ParentIndexNumber === t).map((e) => e.IndexNumber))}`).filter((x) => !/: ?$/.test(x));
      eps = `📀 ${episodios.length} episodio${episodios.length === 1 ? '' : 's'}${temps.length ? `  ·  ${temporadasTexto(temps)}` : ''}${porTemp.length && episodios.length <= 40 ? `\n     ${porTemp.join('  ·  ')}` : ''}`;
    }
  }
  const etiquetas = [esSerie ? '#Serie' : '#Película', ...generos.map(etiqueta)].join(' ');
  const partes = (sinopsis) => [
    `${emoji} <b>${que}</b>  ·  ${html(seccion.nombre)}`,
    SEPARADOR,
    `<b>${html(ficha.Name)}</b>${html(anio)}`,
    original,
    '',
    [nota, duracion, edad].filter(Boolean).join('   ') || null,
    generos.length ? `🎭 ${generos.map(html).join(' · ')}` : null,
    nuevosEpisodios ? null : autor,
    nuevosEpisodios ? null : reparto,
    eps,
    sinopsis && !nuevosEpisodios ? `\n${sinopsis}` : null,
    '',
    etiquetas,
  ];
  return {
    texto: montar(partes, ficha.Overview, 1024),
    fotoDe: ficha.Id,
    boton: botones(ficha.Id, ficha.RemoteTrailers?.[0]?.Url),
  };
}

// Muchas cosas a la vez: un resumen con la lista
function resumen(lib, grupos) {
  const seccion = nombreSeccion(lib.nombre);
  const lineas = grupos.slice(0, 30).map((g) => `▫️ ${html(g.ficha.Name)}${g.ficha.ProductionYear ? ` (${g.ficha.ProductionYear})` : ''}${g.episodios ? ` — ${g.episodios.length} ep.` : ''}`);
  if (grupos.length > 30) lineas.push(`▫️ y ${grupos.length - 30} más`);
  return {
    texto: [`🆕 <b>${grupos.length} NOVEDADES</b>  ·  ${html(seccion.nombre)}`, SEPARADOR, ...lineas].join('\n').slice(0, 4096),
    fotoDe: null,
    boton: { reply_markup: { inline_keyboard: [[{ text: '▶ Abrir Emby', url: `${emby.direccionPublica()}/web/index.html` }]] } },
  };
}

async function enviar(tema, { texto, fotoDe, boton }) {
  const base = { chat_id: datos.chat, message_thread_id: tema.id, parse_mode: 'HTML', ...boton };
  const foto = fotoDe ? await emby.imagen(`/Items/${encodeURIComponent(fotoDe)}/Images/Primary?maxWidth=780&quality=90`) : null;
  if (foto) {
    // El cartel se sube desde Emby (Telegram no puede bajarlo: Emby pide la clave)
    const f = new FormData();
    for (const [k, v] of Object.entries(base)) f.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    f.append('caption', texto);
    f.append('photo', new Blob([foto.datos], { type: foto.tipo }), 'cartel.jpg');
    try { return await llamar('sendPhoto', f); } catch (e) {
      if (/thread|topic/i.test(e.message)) throw e;
      // Si falla la foto, va solo el texto
    }
  }
  return llamar('sendMessage', { ...base, text: texto, link_preview_options: { is_disabled: true } });
}

async function mandarA(lib, m) {
  let tema = await temaDe(lib);
  try { await enviar(tema, m); } catch (e) {
    // Si alguien borró el tema, se crea de nuevo
    if (!/thread|topic/i.test(e.message)) throw e;
    for (const [k, t] of Object.entries(datos.temas)) if (t.id === tema.id) delete datos.temas[k];
    tema = await crearTema(lib);
    await enviar(tema, m);
  }
  return tema;
}

// ---------- Lo nuevo de Emby ----------
const CAMPOS = 'DateCreated,Overview,Genres,People,ProductionYear,CommunityRating,OfficialRating,RunTimeTicks,RemoteTrailers,OriginalTitle,SeriesId,SeriesName,ParentIndexNumber,IndexNumber';
const fecha = (x) => Date.parse(x?.DateCreated ?? '') || 0;

async function novedades(lib, desde, hasta) {
  const r = await emby.consultar(`/Items?ParentId=${encodeURIComponent(lib.id)}&Recursive=true&IncludeItemTypes=Movie,Episode&SortBy=DateCreated&SortOrder=Descending&Limit=300&Fields=${CAMPOS}`);
  return (r?.Items ?? []).filter((x) => fecha(x) > desde && fecha(x) <= hasta);
}
async function fichas(ids) {
  if (!ids.length) return new Map();
  const r = await emby.consultar(`/Items?Ids=${ids.map(encodeURIComponent).join(',')}&Fields=${CAMPOS}`);
  return new Map((r?.Items ?? []).map((x) => [String(x.Id), x]));
}

export async function repaso() {
  if (!activo || ocupado) return;
  ocupado = true;
  try {
    if (!datos.chat && !(await buscarGrupo())) { estado = 'falta el grupo'; return; }
    if (!servidorId) servidorId = (await emby.consultar('/System/Info').catch(() => null))?.Id ?? null;
    if (Date.now() > charlaReintento) {
      try { await charlaAlDia(); } catch (e) { charlaReintento = Date.now() + 600000; console.error(`Telegram: no se pudo crear el tema «Chat» (${e.message})`); }
    }
    if (!escuchando) escuchar();
    const hasta = Date.now() - MADURO;
    // La primera vez no se avisa de todo el catálogo: solo de lo que llegue a partir de ahora
    if (!datos.ultimoEmby) { datos.ultimoEmby = hasta; await guardarDatos(); estado = 'ok'; return; }
    const desde = datos.ultimoEmby;

    const pendientes = []; // { lib, grupos }
    for (const lib of await bibliotecas()) {
      const items = await novedades(lib, desde, hasta);
      if (!items.length) continue;
      const pelis = items.filter((x) => x.Type === 'Movie').map((x) => ({ ficha: x, cuando: fecha(x) }));
      const porSerie = new Map();
      for (const e of items.filter((x) => x.Type === 'Episode' && x.SeriesId)) {
        if (!porSerie.has(e.SeriesId)) porSerie.set(e.SeriesId, []);
        porSerie.get(e.SeriesId).push(e);
      }
      const series = await fichas([...porSerie.keys()]);
      const grupos = [...pelis];
      for (const [sid, eps] of porSerie) {
        const s = series.get(String(sid));
        if (!s) continue;
        // Serie que ya estaba antes del último aviso → «nuevos episodios»
        grupos.push({ ficha: s, episodios: eps, nuevosEpisodios: fecha(s) <= desde, cuando: Math.max(...eps.map(fecha)) });
      }
      if (grupos.length) pendientes.push({ lib, grupos: grupos.sort((a, b) => a.cuando - b.cuando) });
    }

    // Lo ya enviado en un repaso que falló a medias no se repite
    const hecho = new Set(datos.enviados ?? []);
    const marcar = async (k) => { hecho.add(k); datos.enviados = [...hecho].slice(-500); await guardarDatos(); };
    const marca = (g) => `${g.ficha.Id}:${g.cuando}`;
    for (const p0 of pendientes) p0.grupos = p0.grupos.filter((g) => !hecho.has(marca(g)));
    for (const { lib, grupos } of pendientes) {
      if (!grupos.length) continue;
      if (grupos.length > MUCHOS) {
        const tema = await mandarA(lib, resumen(lib, grupos));
        for (const g of grupos) hecho.add(marca(g));
        await marcar(`resumen:${lib.id}:${hasta}`);
        console.log(`Telegram: resumen de ${grupos.length} novedades en «${tema.nombre}»`);
        await espera(PAUSA);
        continue;
      }
      for (const g of grupos) {
        const tema = await mandarA(lib, aviso(lib, g.ficha, g));
        await marcar(marca(g));
        console.log(`Telegram: aviso en «${tema.nombre}»: ${g.ficha.Name}${g.episodios ? ` (${g.episodios.length} ep.)` : ''}`);
        await espera(PAUSA);
      }
    }
    // Todo lo de este repaso queda avisado (si algo falla antes, se repite en el siguiente)
    datos.ultimoEmby = hasta;
    datos.enviados = [];
    await guardarDatos();
    estado = 'ok';
  } catch (e) {
    estado = `error: ${e.message}`;
    console.error(`Telegram: ${e.message}`);
  } finally {
    ocupado = false;
  }
}

// ---------- Bienvenida y /anuncio (el bot escucha a Telegram) ----------
let escuchando = false;
const saludados = new Map();
const ENTRADA_VIEJA = 6 * 3600;

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
        await ordenAnuncio(u).catch((e) => console.error(`Telegram: anuncio (${e.message})`));
      }
    } catch (e) {
      console.error(`Telegram: escuchando (${e.message})`);
      await espera(/conflict/i.test(e.message) ? 60000 : 10000);
    }
  }
  escuchando = false;
}

async function entrada(u) {
  let gente = []; let cuando = 0;
  const m = u.message;
  if (m?.new_chat_members && String(m.chat.id) === String(datos.chat)) { gente = m.new_chat_members; cuando = m.date; }
  const c = u.chat_member;
  if (c && String(c.chat.id) === String(datos.chat)) {
    const dentro = (s) => ['member', 'administrator', 'creator'].includes(s.status) || (s.status === 'restricted' && s.is_member);
    if (!dentro(c.old_chat_member) && dentro(c.new_chat_member)) { gente = [c.new_chat_member.user]; cuando = c.date; }
  }
  const ahora = Date.now();
  for (const [id, t] of saludados) if (ahora - t > 600000) saludados.delete(id);
  gente = gente.filter((x) => !x.is_bot && !saludados.has(x.id));
  if (!gente.length || Date.now() / 1000 - cuando > ENTRADA_VIEJA) return;
  gente.forEach((x) => saludados.set(x.id, ahora));
  await bienvenida(gente);
}

const enlaceTema = (id) => `https://t.me/c/${String(datos.chat).replace(/^-100/, '')}/${id}`;
async function bienvenida(gente) {
  const nombres = gente.map((x) => `<a href="tg://user?id=${x.id}">${html([x.first_name, x.last_name].filter(Boolean).join(' ') || x.username || 'nuevo miembro')}</a>`);
  const quien = nombres.length === 1 ? nombres[0] : `${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)}`;
  const secciones = [...new Set(Object.values(datos.temas).map((t) => t.nombre))].slice(0, 20);
  const texto = [
    `👋 <b>¡Bienvenid${gente.length === 1 ? 'o/a' : 'os/as'} a MorvehTV, ${quien}!</b>`,
    '',
    'Nos alegra tenerte aquí. Esto es lo que encontrarás en el grupo:',
    '',
    secciones.length ? `🔔 <b>Avisos de contenido nuevo</b>, cada biblioteca en su tema:\n${secciones.map((s) => `   ${html(s)}`).join('\n')}` : '🔔 <b>Avisos de contenido nuevo</b>, cada biblioteca en su tema.',
    datos.avisos?.id ? '📢 <b>Avisos</b>: mantenimientos y novedades importantes.' : null,
    datos.charla?.id ? '💬 <b>Chat</b>: el sitio para hablar, pedir películas o series y avisar si algo no funciona.' : null,
    '',
    '📌 <b>Normas</b>: respeto ante todo, nada de spam ni enlaces ajenos, y las peticiones en el Chat.',
    '',
    'Para ver el contenido, entra en Emby con tu cuenta. ¡Disfruta! 🍿',
  ].filter((l) => l != null).join('\n');
  const fila = [{ text: '▶ Abrir Emby', url: `${emby.direccionPublica()}/web/index.html` }];
  if (datos.charla?.id && /^-100\d+$/.test(String(datos.chat))) fila.push({ text: '💬 Ir al Chat', url: enlaceTema(datos.charla.id) });
  await llamar('sendMessage', { chat_id: datos.chat, parse_mode: 'HTML', text: texto, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [fila] } });
}

const ORDEN = /^\/(anuncio|aviso)(@\w+)?(\s+|$)/i;
async function esAdminGrupo(usuario) {
  if (!datos.chat || !usuario) return false;
  try {
    const m = await llamar('getChatMember', { chat_id: datos.chat, user_id: usuario });
    return m.status === 'creator' || m.status === 'administrator';
  } catch { return false; }
}
async function temaAvisos() {
  if (datos.avisos?.id) return datos.avisos;
  const t = await llamar('createForumTopic', { chat_id: datos.chat, name: '📢 Avisos', icon_color: 16478047 });
  datos.avisos = { id: t.message_thread_id };
  await guardarDatos();
  await cerrarTema(t.message_thread_id);
  return datos.avisos;
}
async function publicarAviso(texto, foto) {
  const cuerpo = `📢 <b>Aviso de MorvehTV</b>\n\n${html(texto)}`;
  const base = (id) => ({ chat_id: datos.chat, message_thread_id: id, parse_mode: 'HTML' });
  const mandar = (id) => (foto ? llamar('sendPhoto', { ...base(id), photo: foto, caption: cuerpo.slice(0, 1024) })
    : llamar('sendMessage', { ...base(id), text: cuerpo.slice(0, 4096), link_preview_options: { is_disabled: true } }));
  let tema = await temaAvisos();
  try { return await mandar(tema.id); } catch (e) {
    if (!/thread|topic/i.test(e.message)) throw e;
    datos.avisos = null;
    tema = await temaAvisos();
    return mandar(tema.id);
  }
}
async function ordenAnuncio(u) {
  const m = u.message;
  if (!m || m.chat?.type !== 'private') return;
  const escrito = m.text ?? m.caption ?? '';
  if (!ORDEN.test(escrito)) return;
  if (!(await esAdminGrupo(m.from?.id))) return;
  const responder = (t) => llamar('sendMessage', { chat_id: m.chat.id, text: t, parse_mode: 'HTML' }).catch(() => {});
  if (!datos.chat) return responder('Todavía no hay grupo: añade el bot a un grupo con temas.');
  const texto = escrito.replace(ORDEN, '').trim();
  const foto = m.photo?.length ? m.photo[m.photo.length - 1].file_id : null;
  if (!texto && !foto) return responder('Escribe el aviso detrás del comando, por ejemplo:\n<code>/anuncio Esta noche de 2:00 a 3:00 Emby estará en mantenimiento.</code>\n\nTambién puedes mandar una foto con <code>/anuncio texto</code> como pie.');
  await publicarAviso(texto, foto);
  return responder('✅ Publicado en el tema «📢 Avisos» del grupo.');
}
