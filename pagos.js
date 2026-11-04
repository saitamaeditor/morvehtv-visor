// Planes de MorvehTV: «Básico» (gratis, con anuncios) y «Premium» (sin anuncios). Premium se paga
// en Patreon (patreon.com/morvehtv): el cliente se une al nivel de MorvehTV y conecta su cuenta
// de Patreon desde «Mi cuenta»; Patreon cobra (tarjeta, PayPal, Apple Pay…) y gestiona el IVA.
// La web nunca ve ni guarda datos de pago. Se activa con variables de entorno (nunca en el
// código: el repositorio es público):
//  · PATREON_CLIENT_ID y PATREON_CLIENT_SECRET: los del cliente de API (patreon.com/portal),
//    con la dirección de vuelta https://…/api/pago/patreon/vuelta
//  · PATREON_WEBHOOK_SECRET: el secreto del webhook que apunta a /api/pago/webhook
//  · PATREON_URL (opcional): la página para unirse; por defecto https://www.patreon.com/morvehtv
//  · PATREON_TIER_ID (opcional): si hay varios niveles, solo ese da Premium
//  · PATREON_PRECIO (opcional): el texto del precio para enseñar, p. ej. «3,99 €/mes»
// Al conectar, el servidor pregunta a Patreon en ese momento si es miembro activo (Premium al
// instante); el webhook mantiene al día cobros, impagos y bajas.
//
// Anuncios del plan Básico: vídeos propios (subidos desde el gestor) o, en la web, anuncios de
// vídeo de Google (ANUNCIOS_VAST) antes de reproducir; además banners: AdSense
// (ANUNCIOS_ADSENSE + ANUNCIOS_ADSENSE_SLOT) o los propios del gestor.
import { createHmac, timingSafeEqual } from 'node:crypto';

const ID = String(process.env.PATREON_CLIENT_ID ?? '').trim();
const SECRETO = String(process.env.PATREON_CLIENT_SECRET ?? '').trim();
const SECRETO_WEBHOOK = String(process.env.PATREON_WEBHOOK_SECRET ?? '').trim();
const PAGINA = String(process.env.PATREON_URL ?? 'https://www.patreon.com/morvehtv').trim().replace(/[?#].*$/, '');
const VANIDAD = (PAGINA.match(/patreon\.com\/(?:c\/|cw\/)?([\w.-]+)/i)?.[1] ?? '').toLowerCase();
const NIVEL = String(process.env.PATREON_TIER_ID ?? '').trim();
const PRECIO = String(process.env.PATREON_PRECIO ?? '').trim() || null;
const WEB = (process.env.PATREON_WEB ?? 'https://www.patreon.com').replace(/\/$/, ''); // para pruebas
const API = (process.env.PATREON_API ?? 'https://www.patreon.com').replace(/\/$/, ''); // para pruebas
export const activo = Boolean(ID && SECRETO);
// Qué falta, con el nombre exacto de cada variable (sin enseñar nunca sus valores). También avisa
// de nombres parecidos mal escritos (minúsculas, espacios…), que Render guarda tal cual.
const faltan = [['PATREON_CLIENT_ID', ID], ['PATREON_CLIENT_SECRET', SECRETO], ['PATREON_WEBHOOK_SECRET', SECRETO_WEBHOOK]].filter(([, v]) => !v).map(([n]) => n);
const parecidas = Object.keys(process.env).filter((k) => /patreon/i.test(k) && !/^PATREON_(CLIENT_ID|CLIENT_SECRET|WEBHOOK_SECRET|URL|TIER_ID|PRECIO|API|WEB)$/.test(k));
export const estado = (faltan.length ? `faltan ${faltan.join(', ')}` : `ok (patreon.com/${VANIDAD})`)
  + (parecidas.length ? ` · nombres mal escritos: ${parecidas.map((k) => JSON.stringify(k)).join(', ')}` : '');

let p; // perfiles.js
let firmar = async () => null; // enlaces firmados de e2 (vídeos de anuncios)
export function iniciar(opciones) { ({ perfiles: p } = opciones); firmar = opciones.firmar ?? firmar; }

const error = (status, message) => Object.assign(new Error(message), { status });
export const precioTexto = async () => PRECIO;

// Dirección pública de MorvehTV (para volver desde Patreon)
function base(req) {
  if (process.env.VISOR_URL) return process.env.VISOR_URL.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}
const vuelta = (req) => `${base(req)}/api/pago/patreon/vuelta`;

// ¿Premium? Miembro activo del nivel, dentro del periodo pagado (con 3 días de margen)
export function esPremium(plan) {
  if (!plan || plan.proveedor !== 'patreon') return false;
  return plan.estado === 'active_patron' && (!plan.hasta || plan.hasta > Date.now() - 3 * 864e5);
}

// ---------- Conectar la cuenta de Patreon (OAuth) ----------
// «state» firmado con el secreto: dice qué cuenta de MorvehTV pidió conectar (y caduca en 30 min),
// así la vuelta funciona aunque Patreon se abra en otro navegador
const firma = (t) => createHmac('sha256', SECRETO).update(`patreon:${t}`).digest('base64url');
function estadoDe(cuenta) {
  const t = Buffer.from(JSON.stringify({ c: cuenta.id, t: Date.now() })).toString('base64url');
  return `${t}.${firma(t)}`;
}
function leerEstado(s) {
  const [t, f] = String(s ?? '').split('.');
  if (!t || !f) return null;
  const esperada = firma(t);
  if (f.length !== esperada.length || !timingSafeEqual(Buffer.from(f), Buffer.from(esperada))) return null;
  const d = JSON.parse(Buffer.from(t, 'base64url').toString());
  return Date.now() - d.t < 30 * 60000 ? d.c : null;
}

// Lo que dice Patreon de esa persona: su membresía en MorvehTV
async function membresia(token) {
  const q = 'include=memberships.campaign,memberships.currently_entitled_tiers'
    + '&fields%5Bmember%5D=patron_status,next_charge_date,last_charge_status,last_charge_date'
    + '&fields%5Bcampaign%5D=vanity,url&fields%5Buser%5D=full_name';
  const r = await fetch(`${API}/api/oauth2/v2/identity?${q}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw error(502, `Patreon: ${d.errors?.[0]?.detail ?? r.status}`);
  const incluidos = d.included ?? [];
  const campanas = incluidos.filter((x) => x.type === 'campaign');
  const nuestra = campanas.find((c) => String(c.attributes?.vanity ?? '').toLowerCase() === VANIDAD
    || String(c.attributes?.url ?? '').toLowerCase().replace(/[?#].*$/, '').endsWith(`/${VANIDAD}`));
  const miembro = nuestra && incluidos.find((x) => x.type === 'member' && x.relationships?.campaign?.data?.id === nuestra.id);
  return { usuario: d.data?.id, miembro, campana: nuestra?.id };
}

function datosMiembro(usuario, m) {
  const niveles = (m?.relationships?.currently_entitled_tiers?.data ?? []).map((x) => x.id);
  const nivelOk = !NIVEL || niveles.includes(NIVEL);
  const estadoP = m?.attributes?.patron_status ?? 'former_patron';
  const siguiente = m?.attributes?.next_charge_date ? Date.parse(m.attributes.next_charge_date) : null;
  return { proveedor: 'patreon', suscripcion: `patreon:${usuario}`, miembro: m?.id ?? null,
    estado: estadoP === 'active_patron' && !nivelOk ? 'sin_nivel' : estadoP, cancelado: false, ...(siguiente ? { hasta: siguiente } : {}) };
}

// ---------- Anuncios ----------
const ADSENSE = String(process.env.ANUNCIOS_ADSENSE ?? '').trim();
const ADSENSE_SLOT = String(process.env.ANUNCIOS_ADSENSE_SLOT ?? '').trim();
const VAST = String(process.env.ANUNCIOS_VAST ?? '').trim();
async function anuncios() {
  const propios = ((await p.leerAjuste('anuncios')) ?? []).filter((a) => a.activo !== false);
  return {
    adsense: /^ca-pub-\d+$/.test(ADSENSE) ? { cliente: ADSENSE, slot: ADSENSE_SLOT || null } : null,
    vast: /^https:\/\//.test(VAST) ? VAST : null,
    propios: await Promise.all(propios.map(async ({ id, imagen, enlace, texto, titulo, video }) => ({
      id, imagen, enlace, texto, titulo,
      // El vídeo del anuncio: un archivo subido desde el gestor (en e2) o una dirección https
      video: !video ? null : /^https:\/\//.test(video) ? video : await firmar(video, { segundos: 6 * 3600 }),
    }))),
  };
}

// ---------- Rutas (con sesión) ----------
export const RUTAS = ['/api/pago/info', '/api/pago/patreon/conectar', '/api/pago/patreon/desconectar'];
export async function atender(ruta, req, res, json, cuenta) {
  if (ruta === '/api/pago/info') {
    const plan = await p.planDe(cuenta);
    const pl = cuenta.plan?.proveedor === 'patreon' ? cuenta.plan : null;
    return json(res, 200, {
      activo, proveedor: 'patreon', pagina: PAGINA, plan: plan.tipo, hasta: plan.hasta ?? null, admin: !!plan.admin,
      conectado: Boolean(pl), estadoPatreon: pl?.estado ?? null,
      precio: PRECIO,
      // Premium no ve anuncios: ni se le manda la configuración
      anuncios: plan.tipo === 'premium' ? null : await anuncios(),
    });
  }
  if (req.method !== 'POST') throw error(405, 'Método no permitido');
  let cuerpo = '';
  for await (const t of req) { cuerpo += t; if (cuerpo.length > 10000) throw error(413, 'Demasiado grande'); }
  const datos = cuerpo ? JSON.parse(cuerpo) : {};
  if (!activo) throw error(503, 'Los pagos no están activados todavía');

  // Conectar: la página de Patreon donde la persona autoriza a MorvehTV a ver su membresía
  if (ruta === '/api/pago/patreon/conectar') {
    if ((await p.planDe(cuenta)).tipo === 'premium' && cuenta.plan?.proveedor === 'patreon') throw error(409, 'Ya tienes Premium con Patreon');
    if (datos.acepta !== true) throw error(400, 'Tienes que aceptar las condiciones y el inicio inmediato del servicio');
    await p.anotarAceptacion(cuenta.id, 'premium');
    const u = new URL(`${WEB}/oauth2/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', ID);
    u.searchParams.set('redirect_uri', vuelta(req));
    u.searchParams.set('scope', 'identity identity.memberships');
    u.searchParams.set('state', estadoDe(cuenta));
    return json(res, 200, { url: u.href });
  }

  // Desconectar Patreon de esta cuenta (la membresía en Patreon se gestiona allí)
  if (ruta === '/api/pago/patreon/desconectar') {
    if (cuenta.plan?.proveedor !== 'patreon') throw error(404, 'No tienes Patreon conectado');
    await p.ponerPlan({ id: cuenta.id }, { proveedor: null, suscripcion: null, miembro: null, estado: null, hasta: null });
    return json(res, 200, { plan: (await p.planDe({ ...cuenta, plan: null })).tipo });
  }
  throw error(404, 'No existe');
}

// Vuelta de Patreon (sin sesión: la cuenta va en el «state» firmado). Termina en la portada con
// ?pago=ok (Premium), ?pago=sin-suscripcion (no es miembro activo) o ?pago=error.
export async function alVolver(req, res, url) {
  const ir = (q) => { res.writeHead(302, { location: `/?pago=${q}`, 'cache-control': 'no-store' }); res.end(); };
  if (!activo) return ir('error');
  const cuentaId = leerEstado(url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!cuentaId || !code) return ir(url.searchParams.get('error') ? 'cancelado' : 'error');
  try {
    const r = await fetch(`${API}/api/oauth2/token`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: ID, client_secret: SECRETO, redirect_uri: vuelta(req) }).toString(),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) throw error(502, `Patreon: ${t.error_description ?? t.error ?? r.status}`);
    const m = await membresia(t.access_token);
    if (!m.usuario) throw error(502, 'Patreon no ha dicho quién eres');
    // Una cuenta de Patreon solo vale para una cuenta de MorvehTV
    const plan = await p.ponerPlan({ id: cuentaId }, datosMiembro(m.usuario, m.miembro), { unicaSuscripcion: true });
    console.log(`Pagos: cuenta ${cuentaId} conecta Patreon (${m.miembro?.attributes?.patron_status ?? 'sin membresía'})`);
    return ir(esPremium(plan) ? 'ok' : 'sin-suscripcion');
  } catch (e) {
    console.error(`Pagos: vuelta de Patreon: ${e.message}`);
    return ir(e.status === 409 ? 'otra-cuenta' : 'error');
  }
}

// Al borrar una cuenta no se puede cancelar desde aquí: la membresía es de Patreon (se avisa)
export async function cancelarDe() {}

// ---------- Webhook: Patreon avisa de cada alta, cobro, impago o baja ----------
function firmaValida(cuerpo, cabecera) {
  if (!SECRETO_WEBHOOK || !cabecera) return false;
  const esperada = createHmac('md5', SECRETO_WEBHOOK).update(cuerpo).digest('hex');
  const v = String(cabecera).trim().toLowerCase();
  return v.length === esperada.length && timingSafeEqual(Buffer.from(v), Buffer.from(esperada));
}

export async function webhook(req, res, json) {
  let cuerpo = '';
  for await (const trozo of req) { cuerpo += trozo; if (cuerpo.length > 1e6) throw error(413, 'Demasiado grande'); }
  if (!activo || !firmaValida(cuerpo, req.headers['x-patreon-signature'])) return json(res, 400, { error: 'Firma no válida' });
  const evento = String(req.headers['x-patreon-event'] ?? '');
  const ev = JSON.parse(cuerpo);
  const m = ev.data ?? {};
  const usuario = m.relationships?.user?.data?.id;
  try {
    if (usuario && /^members:/.test(evento)) {
      const datos = /:delete$/.test(evento) ? { ...datosMiembro(usuario, m), estado: 'former_patron' } : datosMiembro(usuario, m);
      // Solo se actualiza si esa cuenta de Patreon está conectada a alguna cuenta de MorvehTV
      await p.ponerPlan({ suscripcion: `patreon:${usuario}` }, datos, { soloSiExiste: true });
    }
  } catch (e) {
    console.error(`Pagos: webhook ${evento}: ${e.message}`);
    return json(res, 500, { error: 'No se pudo guardar' }); // Patreon lo reintenta
  }
  return json(res, 200, { ok: true });
}
