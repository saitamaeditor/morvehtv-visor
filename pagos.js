// Planes de MorvehTV: «Básico» (gratis, con anuncios) y «Premium» (de pago cada mes, sin
// anuncios). El cobro lo hace Stripe: la web nunca ve ni guarda datos de tarjetas. Se activa
// con variables de entorno (nunca en el código: el repositorio es público):
//  · STRIPE_SECRET_KEY: la clave secreta de Stripe (sk_live_… o, para probar, sk_test_…)
//  · STRIPE_PRICE_ID: el precio mensual de Premium creado en Stripe (price_…)
//  · STRIPE_WEBHOOK_SECRET: el secreto del webhook (whsec_…) que apunta a /api/pago/webhook
// Sin ellas no se cobra nada: todos ven el plan Básico y el botón de Premium no sale.
// Anuncios: ANUNCIOS_ADSENSE (ca-pub-…) y ANUNCIOS_ADSENSE_SLOT para Google AdSense en la web;
// además, los anuncios propios que se añaden desde el gestor (y, si no hay ninguno, un aviso
// de Premium).
import { createHmac, timingSafeEqual } from 'node:crypto';

const CLAVE = String(process.env.STRIPE_SECRET_KEY ?? '').trim();
const PRECIO = String(process.env.STRIPE_PRICE_ID ?? '').trim();
const SECRETO_WEBHOOK = String(process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();
const API = (process.env.STRIPE_API ?? 'https://api.stripe.com').replace(/\/$/, ''); // para pruebas
export const activo = Boolean(CLAVE && PRECIO);
export const estado = !CLAVE ? 'sin STRIPE_SECRET_KEY' : !PRECIO ? 'sin STRIPE_PRICE_ID' : !SECRETO_WEBHOOK ? 'falta STRIPE_WEBHOOK_SECRET' : 'ok';

let p; // perfiles.js
export function iniciar(perfiles) { p = perfiles; }

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
    method: metodo,
    headers: { authorization: `Bearer ${CLAVE}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: datos ? formulario(datos) : undefined,
    signal: AbortSignal.timeout(20000),
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
    const cantidad = (d.unit_amount ?? 0) / 100;
    const moneda = new Intl.NumberFormat('es-ES', { style: 'currency', currency: (d.currency || 'eur').toUpperCase() }).format(cantidad);
    const cada = d.recurring?.interval === 'year' ? 'año' : d.recurring?.interval === 'week' ? 'semana' : 'mes';
    precio = { texto: `${moneda}/${cada}`, hasta: Date.now() + 3600000 };
  } catch (e) {
    console.error(`Pagos: no se pudo leer el precio (${e.message})`);
    precio.hasta = Date.now() + 300000;
  }
  return precio.texto;
}

// Dirección pública de MorvehTV (para volver desde Stripe)
function base(req) {
  if (process.env.VISOR_URL) return process.env.VISOR_URL.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

// ---------- Anuncios ----------
const ADSENSE = String(process.env.ANUNCIOS_ADSENSE ?? '').trim();
const ADSENSE_SLOT = String(process.env.ANUNCIOS_ADSENSE_SLOT ?? '').trim();
async function anuncios() {
  const propios = ((await p.leerAjuste('anuncios')) ?? []).filter((a) => a.activo !== false);
  return {
    adsense: /^ca-pub-\d+$/.test(ADSENSE) ? { cliente: ADSENSE, slot: ADSENSE_SLOT || null } : null,
    propios: propios.map(({ id, imagen, enlace, texto, titulo }) => ({ id, imagen, enlace, texto, titulo })),
  };
}

// ---------- Rutas (con sesión) ----------
export const RUTAS = ['/api/pago/info', '/api/pago/suscribir', '/api/pago/portal'];
export async function atender(ruta, req, res, json, cuenta) {
  if (ruta === '/api/pago/info') {
    const plan = await p.planDe(cuenta);
    return json(res, 200, {
      activo, plan: plan.tipo, hasta: plan.hasta ?? null, cancelado: plan.cancelado ?? false,
      precio: await textoPrecio(),
      // Premium no ve anuncios: ni se le manda la configuración
      anuncios: plan.tipo === 'premium' ? null : await anuncios(),
    });
  }
  if (req.method !== 'POST') throw error(405, 'Método no permitido');
  if (!activo) throw error(503, 'Los pagos no están activados todavía');

  // Hacerse Premium: una página de pago de Stripe (tarjeta, Apple Pay, Google Pay…)
  if (ruta === '/api/pago/suscribir') {
    const plan = await p.planDe(cuenta);
    if (plan.tipo === 'premium') throw error(409, 'Ya tienes Premium');
    const b = base(req);
    const s = await stripe('POST', '/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: PRECIO, quantity: 1 }],
      client_reference_id: cuenta.id,
      ...(cuenta.plan?.cliente ? { customer: cuenta.plan.cliente } : {}),
      subscription_data: { metadata: { cuenta: cuenta.id, usuario: cuenta.usuario } },
      metadata: { cuenta: cuenta.id },
      allow_promotion_codes: 'true',
      success_url: `${b}/?pago=ok`,
      cancel_url: `${b}/?pago=cancelado`,
    });
    console.log(`Pagos: ${cuenta.usuario} abre el pago de Premium`);
    return json(res, 200, { url: s.url });
  }
  // Gestionar la suscripción (cambiar tarjeta, ver facturas, cancelar): el portal de Stripe
  if (ruta === '/api/pago/portal') {
    if (!cuenta.plan?.cliente) throw error(404, 'No tienes ninguna suscripción');
    const s = await stripe('POST', '/billing_portal/sessions', { customer: cuenta.plan.cliente, return_url: `${base(req)}/` });
    return json(res, 200, { url: s.url });
  }
  throw error(404, 'No existe');
}

// Al borrar una cuenta se cancela su suscripción (para no seguir cobrando)
export async function cancelarDe(cuenta) {
  if (!activo || !cuenta?.plan?.suscripcion) return;
  try { await stripe('DELETE', `/subscriptions/${encodeURIComponent(cuenta.plan.suscripcion)}`); } catch (e) {
    console.error(`Pagos: no se pudo cancelar la suscripción de ${cuenta.usuario} (${e.message})`);
  }
}

// ---------- Webhook: Stripe avisa de cada pago, renovación o cancelación ----------
function firmaValida(cuerpo, cabecera) {
  if (!SECRETO_WEBHOOK) return false;
  const partes = Object.fromEntries(String(cabecera ?? '').split(',').map((x) => x.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(partes.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 600) return false;
  const esperada = createHmac('sha256', SECRETO_WEBHOOK).update(`${t}.${cuerpo}`).digest('hex');
  const v1s = String(cabecera).split(',').filter((x) => x.trim().startsWith('v1=')).map((x) => x.trim().slice(3));
  return v1s.some((v) => v.length === esperada.length && timingSafeEqual(Buffer.from(v), Buffer.from(esperada)));
}

const ACTIVOS = ['active', 'trialing', 'past_due'];
function datosSuscripcion(s) {
  const fin = s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null;
  return { suscripcion: s.id, cliente: s.customer, estado: s.status, hasta: fin ? fin * 1000 : null, cancelado: Boolean(s.cancel_at_period_end) };
}

export async function webhook(req, res, json) {
  let cuerpo = '';
  for await (const trozo of req) { cuerpo += trozo; if (cuerpo.length > 1e6) throw error(413, 'Demasiado grande'); }
  if (!firmaValida(cuerpo, req.headers['stripe-signature'])) return json(res, 400, { error: 'Firma no válida' });
  const ev = JSON.parse(cuerpo);
  const o = ev.data?.object ?? {};
  try {
    if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
      const s = await stripe('GET', `/subscriptions/${encodeURIComponent(o.subscription)}`);
      await p.ponerPlan({ id: o.client_reference_id || o.metadata?.cuenta }, datosSuscripcion(s));
    } else if (ev.type?.startsWith('customer.subscription.')) {
      await p.ponerPlan({ id: o.metadata?.cuenta, cliente: o.customer }, datosSuscripcion(o));
    }
  } catch (e) {
    console.error(`Pagos: webhook ${ev.type}: ${e.message}`);
    return json(res, 500, { error: 'No se pudo guardar' }); // Stripe lo reintenta
  }
  return json(res, 200, { ok: true });
}

export const esPremium = (plan) => Boolean(plan && ACTIVOS.includes(plan.estado) && (!plan.hasta || plan.hasta > Date.now() - 3 * 864e5));
