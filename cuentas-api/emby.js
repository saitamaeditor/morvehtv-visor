// Cuentas del servidor de Emby (emby.morvehtv.com), gestionadas desde «MorvehTV Cuentas».
// Habla con la API de Emby con una clave de API que solo está en el servidor (EMBY_URL y
// EMBY_API_KEY en /etc/morvehtv-cuentas/cuentas.env): el navegador del gestor nunca la ve.
// Lo que Emby no sabe guardar (fecha de caducidad, nota y dueño de cada cuenta) va en el archivo
// de datos de este servidor, en el ajuste «emby». Las cuentas caducadas se desactivan solas.
// Las cuentas de administrador de Emby no se pueden tocar desde aquí (ni editar, ni borrar).

const BASE = String(process.env.EMBY_URL ?? '').trim().replace(/\/+$/, '');
const CLAVE = String(process.env.EMBY_API_KEY ?? '').trim();
const PUBLICA = String(process.env.EMBY_PUBLICA ?? 'https://emby.morvehtv.com').trim().replace(/\/+$/, '');
const AJUSTE = 'emby';
const PANTALLAS_MAX = 10;

let p = null;
const error = (status, message) => Object.assign(new Error(message), { status });
export const configurado = () => Boolean(BASE && CLAVE);

export function iniciar(opciones) {
  p = opciones.perfiles;
  // Repasa las caducadas cada 10 minutos (solo el servidor de verdad, y solo si Emby está configurado)
  if (opciones.nube && configurado()) {
    setTimeout(repasarCaducadas, 60000).unref();
    setInterval(repasarCaducadas, 10 * 60000).unref();
  }
}

async function llamar(ruta, { metodo = 'GET', datos } = {}) {
  if (!configurado()) throw error(503, 'Emby no está conectado: falta poner EMBY_URL y EMBY_API_KEY en el servidor');
  let r;
  try {
    r = await fetch(BASE + ruta, {
      method: metodo,
      headers: { 'X-Emby-Token': CLAVE, accept: 'application/json', ...(datos && { 'content-type': 'application/json' }) },
      body: datos ? JSON.stringify(datos) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw error(502, `No se pudo conectar con Emby (${e.name === 'TimeoutError' ? 'no responde' : e.cause?.code || e.message})`);
  }
  const texto = await r.text().catch(() => '');
  if (r.status === 401 || r.status === 403) throw error(502, 'Emby ha rechazado la clave de API: revisa EMBY_API_KEY');
  if (!r.ok) throw error(r.status === 404 ? 404 : 502, `Emby respondió ${r.status}${texto ? `: ${texto.slice(0, 160)}` : ''}`);
  if (!texto) return null;
  try { return JSON.parse(texto); } catch { return texto; }
}

// Para otros módulos (avisos de Telegram): la API de Emby y sus imágenes, con la clave del servidor
export const consultar = (ruta) => llamar(ruta);
// Escanear las bibliotecas (tras subir algo a e2 desde el gestor)
export const escanear = () => llamar('/Library/Refresh', { metodo: 'POST' });
export const direccionPublica = () => PUBLICA;
export async function imagen(ruta) {
  if (!configurado()) return null;
  try {
    const r = await fetch(BASE + ruta, { headers: { 'X-Emby-Token': CLAVE }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return { datos: Buffer.from(await r.arrayBuffer()), tipo: r.headers.get('content-type') || 'image/jpeg' };
  } catch { return null; }
}

// ---------- Datos propios (caducidad y nota) ----------
const extras = async () => (await p.leerAjuste(AJUSTE)) ?? {};
async function cambiarExtra(id, cambio) {
  const todo = await extras();
  if (cambio === null) delete todo[id];
  else todo[id] = { ...(todo[id] ?? {}), ...cambio };
  await p.guardarAjuste(AJUSTE, todo);
}

// ---------- Validación ----------
const idValido = (id) => {
  const s = String(id ?? '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) throw error(400, 'Cuenta no válida');
  return s;
};
const nombreValido = (n) => {
  const s = String(n ?? '').trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._@-]{1,31}$/u.test(s)) throw error(400, 'El usuario debe tener de 2 a 32 caracteres: letras, números, espacio, punto, guion, guion bajo o @');
  return s;
};
const claveValida = (c) => {
  const s = String(c ?? '');
  if (s.length < 6 || s.length > 128) throw error(400, 'La contraseña debe tener entre 6 y 128 caracteres');
  return s;
};
const pantallasValidas = (n) => {
  const v = Number(n ?? 0);
  if (!Number.isInteger(v) || v < 0 || v > PANTALLAS_MAX) throw error(400, `Pantallas a la vez: de 0 (sin límite) a ${PANTALLAS_MAX}`);
  return v;
};
// Caducidad: null (nunca), o una fecha (AAAA-MM-DD o ISO) en el futuro
function caducidadValida(c) {
  if (c == null || c === '') return null;
  const f = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(c)) ? `${c}T23:59:59` : String(c));
  if (Number.isNaN(f.getTime())) throw error(400, 'Fecha de caducidad no válida');
  if (f.getTime() < Date.now() - 60000) throw error(400, 'La fecha de caducidad ya ha pasado');
  if (f.getTime() > Date.now() + 20 * 365 * 864e5) throw error(400, 'Fecha de caducidad demasiado lejana');
  return f.toISOString();
}

// ---------- Bibliotecas ----------
async function bibliotecas() {
  const lista = (await llamar('/Library/SelectableMediaFolders')) ?? [];
  return lista.map((b) => ({ id: String(b.Guid || b.Id), ids: [b.Id, b.Guid].filter(Boolean).map(String), nombre: b.Name }));
}
// Las elegidas en el gestor → los identificadores que guarda Emby (se mandan los dos: Id y Guid)
function carpetasElegidas(elegidas, todas) {
  if (elegidas == null) return null; // todas
  if (!Array.isArray(elegidas)) throw error(400, 'Bibliotecas no válidas');
  const marcadas = todas.filter((b) => elegidas.map(String).includes(b.id));
  if (!marcadas.length) throw error(400, 'Elige al menos una biblioteca (o «Todas»)');
  return marcadas.flatMap((b) => b.ids);
}

// ---------- Permisos de una cuenta normal ----------
// Lo justo para ver contenido: sin borrar, sin administrar, oculta en la pantalla de inicio de
// sesión (hay que escribir el usuario) y con los límites que se elijan en el gestor.
function politica(base, { carpetas, pantallas, descargas, desactivada }) {
  return {
    ...base,
    IsAdministrator: false,
    IsHidden: true,
    IsHiddenRemotely: true,
    IsDisabled: Boolean(desactivada),
    EnableRemoteAccess: true,
    EnableMediaPlayback: true,
    EnableUserPreferenceAccess: true,
    EnableContentDeletion: false,
    EnableContentDeletionFromFolders: [],
    EnableLiveTvManagement: false,
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    EnablePublicSharing: false,
    EnableSubtitleManagement: false,
    EnableMediaConversion: false,
    AllowCameraUpload: false,
    ...(descargas != null && { EnableContentDownloading: Boolean(descargas), EnableSyncTranscoding: Boolean(descargas) }),
    ...(pantallas != null && { SimultaneousStreamLimit: pantallas }),
    ...(carpetas !== undefined && (carpetas === null
      ? { EnableAllFolders: true, EnabledFolders: [] }
      : { EnableAllFolders: false, EnabledFolders: carpetas })),
  };
}

async function usuario(id) {
  const u = await llamar(`/Users/${encodeURIComponent(id)}`);
  if (!u?.Id) throw error(404, 'Esa cuenta ya no existe en Emby');
  return u;
}
async function noAdmin(id) {
  const u = await usuario(id);
  if (u.Policy?.IsAdministrator) throw error(403, 'Las cuentas de administrador de Emby solo se cambian desde el propio Emby');
  return u;
}
const ponerPolitica = (id, pol) => llamar(`/Users/${encodeURIComponent(id)}/Policy`, { metodo: 'POST', datos: pol });
const ponerClave = (id, clave) => llamar(`/Users/${encodeURIComponent(id)}/Password`, { metodo: 'POST', datos: { Id: id, NewPw: clave, ResetPassword: false } });

// ---------- Lo que ve el gestor ----------
export async function resumen() {
  if (!configurado()) return { configurado: false, servidor: PUBLICA, usuarios: [], bibliotecas: [] };
  const [consulta, libs, sesiones, extra, info] = await Promise.all([
    llamar('/Users/Query'),
    bibliotecas().catch(() => []),
    llamar('/Sessions').catch(() => []),
    extras(),
    llamar('/System/Info').catch(() => null),
  ]);
  const ahora = Date.now();
  const nombreLib = new Map(libs.flatMap((b) => b.ids.map((i) => [i, b.nombre])));
  const usuarios = (consulta?.Items ?? []).map((u) => {
    const pol = u.Policy ?? {};
    const x = extra[u.Id] ?? {};
    const viendo = (sesiones ?? []).filter((s) => s.UserId === u.Id && s.NowPlayingItem)
      .map((s) => {
        const it = s.NowPlayingItem; const pos = s.PlayState?.PositionTicks ?? 0; const total = it.RunTimeTicks ?? 0;
        return {
          titulo: [it.SeriesName, it.Name].filter(Boolean).join(' · '),
          tipo: it.Type === 'Episode' ? 'episodio' : it.Type === 'Movie' ? 'pelicula' : 'otro',
          dispositivo: [s.Client, s.DeviceName].filter(Boolean).join(' · '),
          progreso: total ? Math.min(100, Math.round((pos / total) * 100)) : null,
          pausado: Boolean(s.PlayState?.IsPaused),
          convertido: Boolean(s.TranscodingInfo && s.TranscodingInfo.IsVideoDirect === false),
        };
      });
    const conectado = (sesiones ?? []).some((s) => s.UserId === u.Id && ahora - new Date(s.LastActivityDate).getTime() < 10 * 60000);
    return {
      id: u.Id,
      nombre: u.Name,
      admin: Boolean(pol.IsAdministrator),
      desactivada: Boolean(pol.IsDisabled),
      caduca: x.caduca ?? null,
      dueno: x.dueno ?? null,
      desde: x.desde ?? x.creada ?? u.DateCreated ?? null,
      caducada: Boolean(x.caduca && new Date(x.caduca).getTime() <= ahora),
      nota: x.nota ?? '',
      creada: u.DateCreated ?? x.creada ?? null,
      por: x.por ?? null,
      ultimoAcceso: u.LastActivityDate || u.LastLoginDate || null,
      conClave: Boolean(u.HasPassword ?? u.HasConfiguredPassword),
      todas: pol.EnableAllFolders !== false,
      bibliotecas: pol.EnableAllFolders === false ? [...new Set((pol.EnabledFolders ?? []).map((i) => nombreLib.get(String(i))).filter(Boolean))] : [],
      bibliotecasIds: pol.EnableAllFolders === false ? libs.filter((b) => b.ids.some((i) => (pol.EnabledFolders ?? []).map(String).includes(i))).map((b) => b.id) : [],
      pantallas: pol.SimultaneousStreamLimit ?? 0,
      descargas: Boolean(pol.EnableContentDownloading),
      conectado,
      viendo,
    };
  }).sort((a, b) => Number(b.admin) - Number(a.admin) || a.nombre.localeCompare(b.nombre, 'es'));
  return {
    configurado: true,
    servidor: PUBLICA,
    nombreServidor: info?.ServerName ?? null,
    version: info?.Version ?? null,
    bibliotecas: libs.map(({ id, nombre }) => ({ id, nombre })),
    usuarios,
  };
}

// ---------- Acciones ----------
export async function crear(datos, por, dueno = null) {
  const nombre = nombreValido(datos.usuario);
  const clave = claveValida(datos.clave);
  const pantallas = pantallasValidas(datos.pantallas);
  const caduca = caducidadValida(datos.caduca);
  const nota = String(datos.nota ?? '').trim().slice(0, 200);
  const libs = await bibliotecas();
  const carpetas = carpetasElegidas(datos.bibliotecas ?? null, libs);
  const existentes = (await llamar('/Users/Query'))?.Items ?? [];
  if (existentes.some((u) => u.Name.toLowerCase() === nombre.toLowerCase())) throw error(409, `Ya hay una cuenta «${nombre}» en Emby`);

  const nuevo = await llamar('/Users/New', { metodo: 'POST', datos: { Name: nombre } });
  if (!nuevo?.Id) throw error(502, 'Emby no ha devuelto la cuenta nueva');
  try {
    await ponerClave(nuevo.Id, clave);
    const actual = await usuario(nuevo.Id);
    await ponerPolitica(nuevo.Id, politica(actual.Policy ?? {}, { carpetas, pantallas, descargas: Boolean(datos.descargas), desactivada: false }));
  } catch (e) {
    // A medias no sirve: se borra para que no quede una cuenta sin contraseña
    await llamar(`/Users/${encodeURIComponent(nuevo.Id)}`, { metodo: 'DELETE' }).catch(() => {});
    throw e;
  }
  const ahora = new Date().toISOString();
  await cambiarExtra(nuevo.Id, { caduca, nota, creada: ahora, desde: ahora, por, ...(dueno && { dueno }) });
  return { id: nuevo.Id, usuario: nombre };
}

export async function editar(id, datos) {
  id = idValido(id);
  const u = await noAdmin(id);
  const cambios = {};
  if ('pantallas' in datos) cambios.pantallas = pantallasValidas(datos.pantallas);
  if ('descargas' in datos) cambios.descargas = Boolean(datos.descargas);
  if ('bibliotecas' in datos) cambios.carpetas = carpetasElegidas(datos.bibliotecas, await bibliotecas());
  const extra = {};
  if ('nota' in datos) extra.nota = String(datos.nota ?? '').trim().slice(0, 200);
  if ('caduca' in datos) { extra.caduca = caducidadValida(datos.caduca); extra.desde = new Date().toISOString(); }
  // Con una fecha nueva en el futuro (o sin caducidad), la cuenta vuelve a funcionar
  const reactivar = 'caduca' in datos && (await extras())[id]?.caducadaSola;
  await ponerPolitica(id, politica(u.Policy ?? {}, { ...cambios, desactivada: reactivar ? false : u.Policy?.IsDisabled }));
  if ('nombre' in datos) {
    const nombre = nombreValido(datos.nombre);
    if (nombre !== u.Name) {
      const existentes = (await llamar('/Users/Query'))?.Items ?? [];
      if (existentes.some((x) => x.Id !== id && x.Name.toLowerCase() === nombre.toLowerCase())) throw error(409, `Ya hay una cuenta «${nombre}» en Emby`);
      await llamar(`/Users/${encodeURIComponent(id)}`, { metodo: 'POST', datos: { ...u, Name: nombre } });
    }
  }
  if (Object.keys(extra).length || reactivar) await cambiarExtra(id, { ...extra, ...(reactivar && { caducadaSola: false }) });
  return { ok: true };
}

export async function cambiarClave(id, clave) {
  id = idValido(id);
  await noAdmin(id);
  await ponerClave(id, claveValida(clave));
  return { ok: true };
}

export async function activar(id, activa) {
  id = idValido(id);
  const u = await noAdmin(id);
  const x = (await extras())[id] ?? {};
  if (activa && x.caduca && new Date(x.caduca).getTime() <= Date.now()) throw error(409, 'Esta cuenta ha caducado: renuévala para activarla');
  await ponerPolitica(id, { ...u.Policy, IsDisabled: !activa });
  if (x.caducadaSola) await cambiarExtra(id, { caducadaSola: false });
  return { ok: true };
}

// Renovar: suma días desde hoy (o desde la caducidad, si aún no ha llegado) y la vuelve a activar
export async function renovar(id, { dias, fecha } = {}) {
  id = idValido(id);
  const u = await noAdmin(id);
  const x = (await extras())[id] ?? {};
  let caduca;
  if (fecha !== undefined) caduca = caducidadValida(fecha);
  else {
    const n = Number(dias);
    if (!Number.isInteger(n) || n < 1 || n > 3660) throw error(400, 'Días no válidos');
    const desde = Math.max(Date.now(), x.caduca ? new Date(x.caduca).getTime() : 0);
    caduca = new Date(desde + n * 864e5).toISOString();
  }
  await ponerPolitica(id, { ...u.Policy, IsDisabled: false });
  await cambiarExtra(id, { caduca, desde: x.caduca && new Date(x.caduca).getTime() > Date.now() ? (x.desde ?? new Date().toISOString()) : new Date().toISOString(), caducadaSola: false });
  return { ok: true, caduca };
}

export async function borrar(id) {
  id = idValido(id);
  const u = await noAdmin(id);
  await llamar(`/Users/${encodeURIComponent(id)}`, { metodo: 'DELETE' });
  await cambiarExtra(id, null);
  return { ok: true, usuario: u.Name };
}

// Cierra lo que esté viendo (por ejemplo, para echar a alguien que comparte la cuenta)
export async function cortar(id) {
  id = idValido(id);
  await noAdmin(id);
  const sesiones = ((await llamar('/Sessions')) ?? []).filter((s) => s.UserId === id && s.NowPlayingItem);
  for (const s of sesiones) await llamar(`/Sessions/${encodeURIComponent(s.Id)}/Playing/Stop`, { metodo: 'POST' }).catch(() => {});
  return { ok: true, cortadas: sesiones.length };
}

// ---------- Para los revendedores ----------
export const extrasEmby = () => extras();
export async function cambiarDueno(id, dueno) {
  id = idValido(id);
  await noAdmin(id);
  const todo = await extras();
  todo[id] = { ...(todo[id] ?? {}) };
  if (dueno) todo[id].dueno = dueno; else delete todo[id].dueno;
  await p.guardarAjuste(AJUSTE, todo);
}
// Pasa las cuentas de unos revendedores a otro (o al administrador, con null)
export async function reasignar(de, a) {
  const todo = await extras();
  let n = 0;
  for (const x of Object.values(todo)) if (x.dueno && de.has(x.dueno)) { if (a) x.dueno = a; else delete x.dueno; n += 1; }
  if (n) await p.guardarAjuste(AJUSTE, todo);
  return n;
}

// ---------- Caducidad automática ----------
export async function repasarCaducadas() {
  try {
    const extra = await extras();
    const ahora = Date.now();
    for (const [id, x] of Object.entries(extra)) {
      if (!x.caduca || new Date(x.caduca).getTime() > ahora || x.caducadaSola) continue;
      try {
        const u = await usuario(id);
        if (u.Policy?.IsAdministrator) continue;
        if (!u.Policy?.IsDisabled) await ponerPolitica(id, { ...u.Policy, IsDisabled: true });
        await cambiarExtra(id, { caducadaSola: true });
        console.log(`Emby: cuenta ${u.Name} desactivada (caducó)`);
      } catch (e) {
        if (e.status === 404) await cambiarExtra(id, null);
        else console.error(`Emby: no se pudo desactivar una cuenta caducada (${e.message})`);
      }
    }
  } catch (e) { console.error(`Emby: no se pudieron repasar las caducadas (${e.message})`); }
}
