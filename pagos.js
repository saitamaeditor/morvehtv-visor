// Planes de MorvehTV: «Básico» (gratis, con anuncios) y «Premium» (de pago cada mes, sin
// anuncios). El cobro lo hace Stripe (tarjeta, Apple Pay, Google Pay…): la web nunca ve ni
// guarda datos de pago. Se activa con variables de entorno (nunca en el código: el repositorio
// es público):
//  · STRIPE_SECRET_KEY: la clave secreta (sk_live_… para cobrar de verdad; sk_test_… para probar)
//  · STRIPE_PRICE_ID: el precio mensual de Premium (price_…)
//  · STRIPE_WEBHOOK_SECRET: el secreto del webhook (whsec_…) que apunta a /api/pago/webhook
// Sin ellas no se cobra nada: todos ven el plan Básico y el botón de Premium no sale.
// Al volver de pagar, el servidor pregunta a Stripe en ese momento (no espera al webhook), así
// que Premium se activa al instante; el webhook mantiene al día renovaciones y cancelaciones.
//
// Anuncios del plan Básico: vídeos propios (subidos desde el gestor) o, en la web, anuncios de
// vídeo de Google (ANUNCIOS_VAST: la dirección VAST de Google Ad Manager / AdSense para vídeo)
// antes de reproducir; además banners: AdSense (ANUNCIOS_ADSENSE + ANUNCIOS_ADSENSE_SLOT) o
// los propios del gestor.
import { createHmac, timingSafeEqual } from 'node:crypto';

const CLAVE = String(process.env.STRIPE_SECRET_KEY ?? '').trim();
const PRECIO = String(process.env.STRIPE_PRICE_ID ?? '').trim();
const SECRETO_WEBHOOK = String(process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();
const API = (process.env.STRIPE_API ?? 'https://api.stripe.com').replace(/\/$/, ''); // para pruebas
const MODO = /^sk_live_|^rk_live_/.test(CLAVE) ? 'live' : 'prueba';
export const activo = Boolean(CLAVE && PRECIO);
// Qué falta, con el nombre exacto de cada variable (sin enseñar nunca sus valores). También avisa
// de nombres parecidos mal escritos (minúsculas, espacios…), que Render guarda tal cual.
const faltan = [['STRIPE_SECRET_KEY', CLAVE], ['STRIPE_PRICE_ID', PRECIO], ['STRIPE_WEBHOOK_SECRET', SECRETO_WEBHOOK]].filter(([, v]) => !v).map(([n]) => n);
const parecidas = Object.keys(process.env).filter((k) => /stripe/i.test(k) && !/^STRIPE_(SECRET_KEY|PRICE_ID|WEBHOOK_SECRET|API)$/.test(k));
const claveRara = CLAVE && !/^(sk|rk)_(live|test)_/.test(CLAVE) ? ' · STRIPE_SECRET_KEY no parece una clave secreta (sk_live_…)' : '';
const precioRaro = PRECIO && !/^price_/.test(PRECIO) ? ' · STRIPE_PRICE_ID tiene que empezar por price_' : '';
export const estado = (faltan.length ? `faltan ${faltan.join(', ')}` : `ok (${MODO})`) + claveRara + precioRaro
  + (parecidas.length ? ` · nombres mal escritos: ${parecidas.map((k) => JSON.stringify(k)).join(', ')}` : '');

let p; // perfiles.js
let firmar = async () => null; // enlaces firmados de e2 (vídeos de anuncios)
export function iniciar(opciones) { ({ perfiles: p } = opciones); firmar = opciones.firmar ?? firmar; }

const error = (status, message) => Object.assign(new Error(message), { status });

// ---------- API de Stripe (formulario con claves anidadas: a[b][0]=c) ----------
function formulario(datos, prefijo = '', partes = []) {
  for (const [k, v] of Object.entries(datos)) {
    if (v == null) continue;
    const clave = prefijo ? `${prefijo}[${k}]` : k;
    if (typeof v === 'object') formulario(v, clave, partes);
    else partes.push(`${encodeURIComponent(clave)}=${encodeURIComponent(v)}`);
  }
  return partes.join('&');
}
async function stripe(metodo, ruta, datos) {
  const r = await fetch(`${API}/v1${ruta}`, {
    method: metodo, signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${CLAVE}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: datos ? formulario(datos) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw error(502, `Stripe: ${d.error?.message ?? r.status}`);
  return d;
}

// Precio para enseñar («3,99 €/mes»), leído de Stripe una vez por hora
let precio = { texto: null, hasta: 0 };
async function textoPrecio() {
  if (!activo) return null;
  if (precio.hasta > Date.now()) return precio.texto;
  try {
    const d = await stripe('GET', `/prices/${encodeURIComponent(PRECIO)}`);
    const moneda = new Intl.NumberFormat('es-ES', { style: 'currency', currency: (d.currency || 'eur').toUpperCase() }).format((d.unit_amount ?? 0) / 100);
    const u = d.recurring?.interval;
    const cada = u === 'year' ? 'año' : u === 'week' ? 'semana' : u === 'day' ? 'día' : 'mes';
    precio = { texto: `${moneda}/${cada}`, hasta: Date.now() + 3600000 };
  } catch (e) {
    console.error(`Pagos: no se pudo leer el precio (${e.message})`);
    precio.hasta = Date.now() + 300000;
  }
  return precio.texto;
}
export const precioTexto = () => textoPrecio();

// Dirección pública de MorvehTV (para volver desde Stripe)
function base(req) {
  if (process.env.VISOR_URL) return process.env.VISOR_URL.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

// Lo que se guarda en la cuenta a partir de una suscripción de Stripe
function datosSuscripcion(s) {
  const fin = s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null;
  return { proveedor: 'stripe', suscripcion: s.id, cliente: s.customer, estado: s.status, cancelado: Boolean(s.cancel_at_period_end) || s.status === 'canceled',
    ...(fin ? { hasta: fin * 1000 } : {}) };
}

// ¿Premium? Suscripción al día (o en su primer cobro reintentándose) dentro del periodo pagado.
// (Las de PayPal de antes del cambio siguen valiendo hasta que acabe su mes.)
export function esPremium(plan) {
  if (!plan) return false;
  if (plan.proveedor === 'stripe') {
    if (['active', 'trialing', 'past_due'].includes(plan.estado)) return !plan.hasta || plan.hasta > Date.now() - 3 * 864e5;
    return false;
  }
  if (plan.proveedor === 'paypal') return ['ACTIVE', 'CANCELLED'].includes(plan.estado) && Boolean(plan.hasta && plan.hasta > Date.now());
  return false;
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
export const RUTAS = ['/api/pago/info', '/api/pago/suscribir', '/api/pago/confirmar', '/api/pago/cancelar', '/api/pago/portal'];
export async function atender(ruta, req, res, json, cuenta) {
  if (ruta === '/api/pago/info') {
    const plan = await p.planDe(cuenta);
    return json(res, 200, {
      activo, proveedor: 'stripe', plan: plan.tipo, hasta: plan.hasta ?? null, cancelado: plan.cancelado ?? false, admin: !!plan.admin,
      portal: Boolean(cuenta.plan?.proveedor === 'stripe' && cuenta.plan?.cliente),
      precio: await textoPrecio(),
      // Premium no ve anuncios: ni se le manda la configuración
      anuncios: plan.tipo === 'premium' ? null : await anuncios(),
    });
  }
  if (req.method !== 'POST') throw error(405, 'Método no permitido');
  let cuerpo = '';
  for await (const t of req) { cuerpo += t; if (cuerpo.length > 10000) throw error(413, 'Demasiado grande'); }
  const datos = cuerpo ? JSON.parse(cuerpo) : {};
  if (!activo) throw error(503, 'Los pagos no están activados todavía');

  // Hacerse Premium: la página de pago de Stripe (tarjeta, Apple Pay, Google Pay…)
  if (ruta === '/api/pago/suscribir') {
    if ((await p.planDe(cuenta)).tipo === 'premium') throw error(409, 'Ya tienes Premium');
    if (datos.acepta !== true) throw error(400, 'Tienes que aceptar las condiciones y el inicio inmediato del servicio');
    await p.anotarAceptacion(cuenta.id, 'premium');
    const b = base(req);
    const s = await stripe('POST', '/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: PRECIO, quantity: 1 }],
      client_reference_id: cuenta.id,
      ...(cuenta.plan?.proveedor === 'stripe' && cuenta.plan?.cliente ? { customer: cuenta.plan.cliente } : {}),
      subscription_data: { metadata: { cuenta: cuenta.id, usuario: cuenta.usuario } },
      metadata: { cuenta: cuenta.id },
      locale: 'es',
      allow_promotion_codes: 'true',
      // {CHECKOUT_SESSION_ID} lo rellena Stripe: al volver se confirma el pago con él
      success_url: `${b}/?pago=ok&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${b}/?pago=cancelado`,
    });
    console.log(`Pagos: ${cuenta.usuario} abre el pago de Premium`);
    return json(res, 200, { url: s.url });
  }

  // Vuelta de Stripe (?pago=ok&session_id=cs_…): se comprueba con Stripe ahora mismo
  if (ruta === '/api/pago/confirmar') {
    const id = String(datos.sesion ?? '');
    if (!/^cs_[A-Za-z0-9_]{8,200}$/.test(id)) throw error(400, 'Pago no válido');
    const s = await stripe('GET', `/checkout/sessions/${encodeURIComponent(id)}?expand[]=subscription`);
    if (s.client_reference_id !== cuenta.id) throw error(403, 'Ese pago no es de esta cuenta');
    if (s.status !== 'complete' || !s.subscription) throw error(409, 'El pago todavía no se ha completado');
    const sub = typeof s.subscription === 'string' ? await stripe('GET', `/subscriptions/${encodeURIComponent(s.subscription)}`) : s.subscription;
    const plan = await p.ponerPlan({ id: cuenta.id }, datosSuscripcion(sub));
    return json(res, 200, { plan: esPremium(plan) ? 'premium' : 'basico' });
  }

  // Cancelar: deja de cobrarse; Premium sigue hasta el final del mes ya pagado
  if (ruta === '/api/pago/cancelar') {
    const pl = cuenta.plan;
    if (pl?.proveedor !== 'stripe' || !pl.suscripcion || !esPremium(pl) || pl.cancelado) throw error(404, 'No tienes ninguna suscripción activa');
    const s = await stripe('POST', `/subscriptions/${encodeURIComponent(pl.suscripcion)}`, { cancel_at_period_end: 'true' });
    const plan = await p.ponerPlan({ id: cuenta.id }, datosSuscripcion(s));
    console.log(`Pagos: ${cuenta.usuario} cancela Premium`);
    return json(res, 200, { plan: esPremium(plan) ? 'premium' : 'basico', hasta: plan.hasta ?? null });
  }

  // Gestionar el pago (cambiar la tarjeta, ver facturas): el portal de clientes de Stripe
  if (ruta === '/api/pago/portal') {
    if (cuenta.plan?.proveedor !== 'stripe' || !cuenta.plan?.cliente) throw error(404, 'No tienes ninguna suscripción');
    const s = await stripe('POST', '/billing_portal/sessions', { customer: cuenta.plan.cliente, return_url: `${base(req)}/`, locale: 'es' });
    return json(res, 200, { url: s.url });
  }
  throw error(404, 'No existe');
}

// Al borrar una cuenta se cancela su suscripción al momento (para no seguir cobrando)
export async function cancelarDe(cuenta) {
  if (!activo || cuenta?.plan?.proveedor !== 'stripe' || !cuenta.plan.suscripcion || !esPremium(cuenta.plan)) return;
  try { await stripe('DELETE', `/subscriptions/${encodeURIComponent(cuenta.plan.suscripcion)}`); } catch (e) {
    console.error(`Pagos: no se pudo cancelar la suscripción de ${cuenta.usuario} (${e.message})`);
  }
}

// ---------- Webhook: Stripe avisa de cada cobro, renovación o cancelación ----------
function firmaValida(cuerpo, cabecera) {
  if (!SECRETO_WEBHOOK) return false;
  const partes = String(cabecera ?? '').split(',').map((x) => x.trim());
  const t = Number((partes.find((x) => x.startsWith('t=')) ?? '').slice(2));
  if (!t || Math.abs(Date.now() / 1000 - t) > 600) return false;
  const esperada = createHmac('sha256', SECRETO_WEBHOOK).update(`${t}.${cuerpo}`).digest('hex');
  return partes.filter((x) => x.startsWith('v1=')).map((x) => x.slice(3))
    .some((v) => v.length === esperada.length && timingSafeEqual(Buffer.from(v), Buffer.from(esperada)));
}

export async function webhook(req, res, json) {
  let cuerpo = '';
  for await (const trozo of req) { cuerpo += trozo; if (cuerpo.length > 1e6) throw error(413, 'Demasiado grande'); }
  if (!activo || !firmaValida(cuerpo, req.headers['stripe-signature'])) return json(res, 400, { error: 'Firma no válida' });
  const ev = JSON.parse(cuerpo);
  const o = ev.data?.object ?? {};
  try {
    let id = null; let cuenta = null;
    if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') { id = o.subscription; cuenta = o.client_reference_id; }
    else if (ev.type?.startsWith('customer.subscription.')) id = o.id;
    else if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_failed') id = o.subscription ?? o.parent?.subscription_details?.subscription;
    if (id) {
      // Siempre el estado actual según Stripe (los avisos pueden llegar desordenados)
      const s = await stripe('GET', `/subscriptions/${encodeURIComponent(id)}`);
      await p.ponerPlan({ id: cuenta || s.metadata?.cuenta, suscripcion: s.id }, datosSuscripcion(s));
    }
  } catch (e) {
    console.error(`Pagos: webhook ${ev.type}: ${e.message}`);
    return json(res, 500, { error: 'No se pudo guardar' }); // Stripe lo reintenta
  }
  return json(res, 200, { ok: true });
}
