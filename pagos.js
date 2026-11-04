// Planes de MorvehTV: «Básico» (gratis, con anuncios) y «Premium» (de pago cada mes, sin
// anuncios). El cobro lo hace PayPal (suscripción mensual: con cuenta de PayPal o con tarjeta):
// la web nunca ve ni guarda datos de pago. Se activa con variables de entorno (nunca en el
// código: el repositorio es público):
//  · PAYPAL_CLIENT_ID y PAYPAL_SECRET: los de tu app de PayPal (developer.paypal.com)
//  · PAYPAL_PLAN_ID: el plan mensual de Premium (P-…)
//  · PAYPAL_WEBHOOK_ID: el id del webhook que apunta a /api/pago/webhook
//  · PAYPAL_MODO: «sandbox» para probar con cuentas de prueba; por defecto, «live»
// Sin ellas no se cobra nada: todos ven el plan Básico y el botón de Premium no sale.
// Al volver de pagar, el servidor pregunta a PayPal en ese momento (no espera al webhook), así
// que Premium se activa al instante; el webhook mantiene al día renovaciones y cancelaciones.
//
// Anuncios del plan Básico: vídeos propios (subidos desde el gestor) o, en la web, anuncios de
// vídeo de Google (ANUNCIOS_VAST: la dirección VAST de Google Ad Manager / AdSense para vídeo)
// antes de reproducir; además banners: AdSense (ANUNCIOS_ADSENSE + ANUNCIOS_ADSENSE_SLOT) o
// los propios del gestor.

const ID = String(process.env.PAYPAL_CLIENT_ID ?? '').trim();
const SECRETO = String(process.env.PAYPAL_SECRET ?? '').trim();
const PLAN = String(process.env.PAYPAL_PLAN_ID ?? '').trim();
const WEBHOOK = String(process.env.PAYPAL_WEBHOOK_ID ?? '').trim();
const MODO = String(process.env.PAYPAL_MODO ?? 'live').trim().toLowerCase();
const API = (process.env.PAYPAL_API ?? (MODO === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com')).replace(/\/$/, '');
export const activo = Boolean(ID && SECRETO && PLAN);
// Qué falta, con el nombre exacto de cada variable (sin enseñar nunca sus valores). También avisa
// de nombres parecidos mal escritos (minúsculas, espacios…), que Render guarda tal cual.
const faltan = [['PAYPAL_CLIENT_ID', ID], ['PAYPAL_SECRET', SECRETO], ['PAYPAL_PLAN_ID', PLAN], ['PAYPAL_WEBHOOK_ID', WEBHOOK]].filter(([, v]) => !v).map(([n]) => n);
const parecidas = Object.keys(process.env).filter((k) => /paypal/i.test(k) && !/^PAYPAL_(CLIENT_ID|SECRET|PLAN_ID|WEBHOOK_ID|MODO|API)$/.test(k));
export const estado = (faltan.length ? `faltan ${faltan.join(', ')}` : `ok (${MODO})`)
  + (parecidas.length ? ` · nombres mal escritos: ${parecidas.map((k) => JSON.stringify(k)).join(', ')}` : '');

let p; // perfiles.js
let firmar = async () => null; // enlaces firmados de e2 (vídeos de anuncios)
export function iniciar(opciones) { ({ perfiles: p } = opciones); firmar = opciones.firmar ?? firmar; }

const error = (status, message) => Object.assign(new Error(message), { status });

// ---------- API de PayPal ----------
let token = { valor: null, hasta: 0 };
async function tokenPaypal() {
  if (token.hasta > Date.now()) return token.valor;
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20000),
    headers: { authorization: `Basic ${Buffer.from(`${ID}:${SECRETO}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw error(502, `PayPal: ${d.error_description ?? r.status}`);
  token = { valor: d.access_token, hasta: Date.now() + Math.max(60, (d.expires_in ?? 3000) - 120) * 1000 };
  return token.valor;
}
async function paypal(metodo, ruta, datos) {
  const r = await fetch(`${API}${ruta}`, {
    method: metodo, signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${await tokenPaypal()}`, 'content-type': 'application/json', prefer: 'return=representation' },
    body: datos ? JSON.stringify(datos) : undefined,
  });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw error(502, `PayPal: ${d.message ?? d.details?.[0]?.description ?? r.status}`);
  return d;
}

// Precio para enseñar («3,99 €/mes»), leído del plan de PayPal una vez por hora
let precio = { texto: null, hasta: 0 };
async function textoPrecio() {
  if (!activo) return null;
  if (precio.hasta > Date.now()) return precio.texto;
  try {
    const d = await paypal('GET', `/v1/billing/plans/${encodeURIComponent(PLAN)}`);
    const ciclo = (d.billing_cycles ?? []).find((c) => c.tenure_type === 'REGULAR') ?? d.billing_cycles?.[0];
    const fijo = ciclo?.pricing_scheme?.fixed_price;
    const moneda = new Intl.NumberFormat('es-ES', { style: 'currency', currency: fijo?.currency_code || 'EUR' }).format(Number(fijo?.value ?? 0));
    const u = ciclo?.frequency?.interval_unit;
    const cada = u === 'YEAR' ? 'año' : u === 'WEEK' ? 'semana' : u === 'DAY' ? 'día' : 'mes';
    precio = { texto: `${moneda}/${cada}`, hasta: Date.now() + 3600000 };
  } catch (e) {
    console.error(`Pagos: no se pudo leer el precio (${e.message})`);
    precio.hasta = Date.now() + 300000;
  }
  return precio.texto;
}

// Dirección pública de MorvehTV (para volver desde PayPal)
function base(req) {
  if (process.env.VISOR_URL) return process.env.VISOR_URL.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

// Lo que se guarda en la cuenta a partir de una suscripción de PayPal
function datosSuscripcion(s) {
  const siguiente = s.billing_info?.next_billing_time ? Date.parse(s.billing_info.next_billing_time) : null;
  return { proveedor: 'paypal', suscripcion: s.id, estado: s.status, cancelado: s.status === 'CANCELLED', ...(siguiente ? { hasta: siguiente } : {}) };
}

// ¿Premium? Al día (ACTIVE) o cancelada pero con el mes ya pagado sin acabar
export function esPremium(plan) {
  if (!plan || plan.proveedor !== 'paypal') return false;
  if (plan.estado === 'ACTIVE') return !plan.hasta || plan.hasta > Date.now() - 3 * 864e5;
  if (plan.estado === 'CANCELLED') return Boolean(plan.hasta && plan.hasta > Date.now());
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
export const RUTAS = ['/api/pago/info', '/api/pago/suscribir', '/api/pago/confirmar', '/api/pago/cancelar'];
export async function atender(ruta, req, res, json, cuenta) {
  if (ruta === '/api/pago/info') {
    const plan = await p.planDe(cuenta);
    return json(res, 200, {
      activo, proveedor: 'paypal', plan: plan.tipo, hasta: plan.hasta ?? null, cancelado: plan.cancelado ?? false, admin: !!plan.admin,
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

  // Hacerse Premium: la página de PayPal para aprobar la suscripción mensual
  if (ruta === '/api/pago/suscribir') {
    if ((await p.planDe(cuenta)).tipo === 'premium') throw error(409, 'Ya tienes Premium');
    const b = base(req);
    const s = await paypal('POST', '/v1/billing/subscriptions', {
      plan_id: PLAN,
      custom_id: cuenta.id,
      application_context: {
        brand_name: 'MorvehTV', locale: 'es-ES', shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW',
        return_url: `${b}/?pago=ok`, cancel_url: `${b}/?pago=cancelado`,
      },
    });
    const url = (s.links ?? []).find((l) => l.rel === 'approve')?.href;
    if (!url) throw error(502, 'PayPal no ha dado la página de pago');
    console.log(`Pagos: ${cuenta.usuario} abre el pago de Premium`);
    return json(res, 200, { url });
  }

  // Vuelta de PayPal (?pago=ok&subscription_id=I-…): se comprueba con PayPal ahora mismo
  if (ruta === '/api/pago/confirmar') {
    const id = String(datos.suscripcion ?? '');
    if (!/^I-[A-Z0-9]{6,40}$/.test(id)) throw error(400, 'Suscripción no válida');
    const s = await paypal('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
    if (s.custom_id !== cuenta.id) throw error(403, 'Esa suscripción no es de esta cuenta');
    if (!['ACTIVE', 'APPROVED'].includes(s.status)) throw error(409, `La suscripción está ${s.status}`);
    // APPROVED = recién aprobada; PayPal la pasa a ACTIVE en segundos (y lo avisa por el webhook)
    const plan = await p.ponerPlan({ id: cuenta.id }, { ...datosSuscripcion(s), estado: 'ACTIVE' });
    return json(res, 200, { plan: esPremium(plan) ? 'premium' : 'basico' });
  }

  // Cancelar: deja de cobrarse; Premium sigue hasta el final del mes ya pagado
  if (ruta === '/api/pago/cancelar') {
    const id = cuenta.plan?.suscripcion;
    if (!id || cuenta.plan?.estado !== 'ACTIVE') throw error(404, 'No tienes ninguna suscripción activa');
    await paypal('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: 'Cancelada por el usuario desde MorvehTV' });
    const plan = await p.ponerPlan({ id: cuenta.id }, { estado: 'CANCELLED', cancelado: true });
    console.log(`Pagos: ${cuenta.usuario} cancela Premium`);
    return json(res, 200, { plan: esPremium(plan) ? 'premium' : 'basico', hasta: plan.hasta ?? null });
  }
  throw error(404, 'No existe');
}

// Al borrar una cuenta se cancela su suscripción (para no seguir cobrando)
export async function cancelarDe(cuenta) {
  if (!activo || !cuenta?.plan?.suscripcion || cuenta.plan.estado !== 'ACTIVE') return;
  try { await paypal('POST', `/v1/billing/subscriptions/${encodeURIComponent(cuenta.plan.suscripcion)}/cancel`, { reason: 'Cuenta borrada' }); } catch (e) {
    console.error(`Pagos: no se pudo cancelar la suscripción de ${cuenta.usuario} (${e.message})`);
  }
}

// ---------- Webhook: PayPal avisa de cada cobro, renovación o cancelación ----------
async function firmaValida(req, evento) {
  if (!WEBHOOK) return false;
  const h = (n) => req.headers[n];
  const d = await paypal('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
    webhook_id: WEBHOOK, webhook_event: evento,
  }).catch(() => ({}));
  return d.verification_status === 'SUCCESS';
}

export async function webhook(req, res, json) {
  let cuerpo = '';
  for await (const trozo of req) { cuerpo += trozo; if (cuerpo.length > 1e6) throw error(413, 'Demasiado grande'); }
  let ev;
  try { ev = JSON.parse(cuerpo); } catch { return json(res, 400, { error: 'JSON no válido' }); }
  if (!activo || !(await firmaValida(req, ev))) return json(res, 400, { error: 'Firma no válida' });
  const o = ev.resource ?? {};
  try {
    let id = null;
    if (ev.event_type?.startsWith('BILLING.SUBSCRIPTION.')) id = o.id;
    else if (ev.event_type === 'PAYMENT.SALE.COMPLETED') id = o.billing_agreement_id;
    if (id) {
      // Siempre el estado actual según PayPal (los avisos pueden llegar desordenados)
      const s = await paypal('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
      await p.ponerPlan({ id: s.custom_id, suscripcion: s.id }, datosSuscripcion(s));
    }
  } catch (e) {
    console.error(`Pagos: webhook ${ev.event_type}: ${e.message}`);
    return json(res, 500, { error: 'No se pudo guardar' }); // PayPal lo reintenta
  }
  return json(res, 200, { ok: true });
}
