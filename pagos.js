// Planes de MorvehTV: «Básico» (gratis, con anuncios) y «Premium» (sin anuncios). Premium se
// consigue con una donación en USDC por la red Base: cada importe da unos meses de Premium
// (por ejemplo 4 USDC = 1 mes). No hay suscripción ni cobros automáticos: se paga cuando se
// quiere y, si se vuelve a pagar, los meses se suman.
//
// Por qué USDC en Base:
//  · USDC es el «dólar digital» de Circle: 1 USDC = 1 dólar, con reservas en efectivo y deuda
//    pública de EE. UU. que se auditan cada mes; en la UE está autorizado como dinero
//    electrónico (MiCA). Tiene 6 decimales.
//  · Base es la red de Coinbase: comisiones de céntimos, un bloque cada ~2 s y USDC «oficial»
//    (emitido por Circle en esa red, no una copia puente). Desde la app de Coinbase se envía
//    gratis por Base.
// Contrato de USDC en Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (cadena 8453).
//
// Cómo se sabe quién ha pagado: Base no deja poner un «concepto» en las transferencias, así que
// cada pedido lleva unos céntimos únicos (4,37 USDC…). El servidor lee la blockchain (solo lee:
// nunca tiene claves ni puede mover nada) y, cuando llega a tu dirección exactamente ese
// importe en USDC, da los meses a esa cuenta y avisa al momento a la web y la app.
// Lo que llegue sin poder identificarse queda apuntado para asignarlo a mano desde el gestor.
//
// Variables de entorno (nunca en el código: el repositorio es público):
//  · CRIPTO_DIRECCION: tu dirección de cartera en Base (0x…). Solo la dirección pública: la
//    frase secreta o la clave privada NUNCA van en ningún sitio.
//  · CRIPTO_PRECIOS (opcional): «USDC:meses» separados por comas; por defecto 4:1,10:3,40:12
//  · CRIPTO_RPC (opcional): nodo de Base para leer la blockchain; por defecto el público
//    https://mainnet.base.org
//
// Anuncios del plan Básico: vídeos propios (subidos desde el gestor) o, en la web, anuncios de
// vídeo de Google (ANUNCIOS_VAST) antes de reproducir; además banners: AdSense
// (ANUNCIOS_ADSENSE + ANUNCIOS_ADSENSE_SLOT) o los propios del gestor.
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';

export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const CADENA = 8453;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const DIRECCION = String(process.env.CRIPTO_DIRECCION ?? '').trim().toLowerCase();
const RPC = String(process.env.CRIPTO_RPC ?? 'https://mainnet.base.org').trim();
const OPCIONES = String(process.env.CRIPTO_PRECIOS ?? '4:1,10:3,40:12').split(',').map((x) => x.trim().split(':').map(Number))
  .filter(([u, m]) => u > 0 && m > 0 && Number.isFinite(u) && Number.isInteger(m))
  .map(([usdc, meses], i) => ({ id: String(i + 1), usdc, meses }));
const MES = 30 * 864e5;
const CADUCA = 60 * 60000; // un pedido se puede pagar durante 1 hora…
const RECONOCE = 48 * 3600000; // …y aun así se reconoce si llega en las 48 h siguientes
const CONFIRMACIONES = 3; // bloques de margen (~6 s) antes de dar un pago por bueno
const valida = /^0x[0-9a-f]{40}$/.test(DIRECCION);
export const activo = valida && OPCIONES.length > 0;
export const estado = !DIRECCION ? 'falta CRIPTO_DIRECCION'
  : !valida ? 'CRIPTO_DIRECCION no es una dirección válida (0x y 40 caracteres)'
    : !OPCIONES.length ? 'CRIPTO_PRECIOS no es válido (formato 4:1,10:3,40:12)' : `ok (USDC en Base · ${DIRECCION.slice(0, 6)}…${DIRECCION.slice(-4)})`;

let p; // perfiles.js
let firmar = async () => null; // enlaces firmados de e2 (vídeos de anuncios)
export function iniciar(opciones) {
  ({ perfiles: p } = opciones);
  firmar = opciones.firmar ?? firmar;
  if (activo) setTimeout(vigilar, 5000);
}

const error = (status, message) => Object.assign(new Error(message), { status });
export const precioTexto = async () => (OPCIONES[0] ? `${fmt(OPCIONES[0].usdc * 1e6)} USDC / ${OPCIONES[0].meses === 1 ? 'mes' : `${OPCIONES[0].meses} meses`}` : null);

// Importes en «micro-USDC» (enteros, sin decimales: 4,37 USDC = 4370000) para no perder céntimos
const fmt = (micro) => (Number(micro) / 1e6).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const conPunto = (micro) => (Number(micro) / 1e6).toFixed(6).replace(/0{1,4}$/, '');

// ¿Premium? Pagado y dentro del tiempo comprado
export function esPremium(plan) {
  return Boolean(plan && plan.proveedor === 'usdc' && plan.hasta && plan.hasta > Date.now());
}

// ---------- Estado guardado (en el archivo de cuentas: sobrevive a los reinicios de Render) ----------
// { ultimoBloque, pedidos: [...], sueltos: [...] }
async function leerEstado() { return { pedidos: [], sueltos: [], ...((await p.leerAjuste('cripto')) ?? {}) }; }
// Los cambios van de uno en uno (leer, cambiar y guardar): así un pedido nuevo y el repaso de la
// blockchain nunca se pisan
let cola = Promise.resolve();
function conEstado(fn) {
  const t = cola.then(async () => { const e = await leerEstado(); const r = await fn(e); await guardarEstado(e); return r; });
  cola = t.catch(() => {});
  return t;
}
const guardarEstado = (e) => p.guardarAjuste('cripto', {
  ...e,
  // Solo lo reciente: pedidos de 7 días y pagos sin identificar de 90
  pedidos: e.pedidos.filter((x) => Date.now() - x.creado < 7 * 864e5).slice(-500),
  sueltos: e.sueltos.filter((x) => Date.now() - x.fecha < 90 * 864e5).slice(-200),
});

// ---------- Lectura de la blockchain (JSON-RPC de Base) ----------
async function rpc(metodo, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: metodo, params }) });
  const d = await r.json().catch(() => ({}));
  if (d.error || !r.ok) throw new Error(`Base: ${d.error?.message ?? r.status}`);
  return d.result;
}
const hex = (n) => `0x${n.toString(16)}`;
const tema = (dir) => `0x${'0'.repeat(24)}${dir.slice(2)}`;

// Repasa los bloques nuevos buscando transferencias de USDC a tu dirección
let repasando = null; let ultimoRepaso = 0;
function repasar() {
  if (!repasando) repasando = repaso().finally(() => { repasando = null; ultimoRepaso = Date.now(); });
  return repasando;
}
async function repaso() {
  // Primero se lee la blockchain (puede tardar) y luego se apunta todo de una vez
  const { ultimoBloque } = await leerEstado();
  const ultimo = Number(await rpc('eth_blockNumber', [])) - CONFIRMACIONES;
  let desde = ultimoBloque ? ultimoBloque + 1 : ultimo - 1800; // la primera vez, la última hora
  if (ultimo - desde > 50000) desde = ultimo - 50000; // tras mucho tiempo dormido, como mucho ~28 h atrás
  if (desde > ultimo) return;
  const logs = [];
  for (let a = desde; a <= ultimo; a += 2000) {
    const b = Math.min(ultimo, a + 1999);
    logs.push(...await rpc('eth_getLogs', [{ address: USDC_BASE, fromBlock: hex(a), toBlock: hex(b), topics: [TRANSFER, null, tema(DIRECCION)] }]));
  }
  await conEstado(async (e) => {
    for (const l of logs) await recibido(e, l);
    e.ultimoBloque = Math.max(e.ultimoBloque ?? 0, ultimo);
  });
}

// Una transferencia recibida: se busca el pedido con ese importe exacto
async function recibido(e, l) {
  const tx = l.transactionHash;
  if (e.pedidos.some((x) => x.tx === tx) || e.sueltos.some((x) => x.tx === tx)) return false; // ya visto
  const importe = BigInt(l.data).toString();
  const de = `0x${l.topics[1].slice(26)}`;
  const ahora = Date.now();
  const pedido = e.pedidos
    .filter((x) => !x.tx && x.importe === importe && ahora - x.creado < RECONOCE)
    .sort((x, y) => y.creado - x.creado)[0];
  if (!pedido) {
    e.sueltos.push({ tx, de, importe, fecha: ahora, bloque: Number(l.blockNumber) });
    console.log(`Pagos: llegan ${fmt(importe)} USDC sin pedido (${tx})`);
    return true;
  }
  pedido.tx = tx; pedido.de = de; pedido.pagado = ahora;
  await darMeses(pedido.cuenta, pedido.meses, { tx, importe, de });
  console.log(`Pagos: pedido ${pedido.id} pagado (${fmt(importe)} USDC, ${pedido.meses} meses)`);
  return true;
}

// Suma meses de Premium a una cuenta (desde hoy o desde que acabe lo que ya tenía)
export async function darMeses(cuentaId, meses, pago) {
  const yo = await p.cuentaPorId(cuentaId);
  if (!yo) throw error(404, 'Esa cuenta ya no existe');
  const desde = Math.max(Date.now(), esPremium(yo.plan) ? yo.plan.hasta : 0);
  const pagos = [...((yo.plan?.proveedor === 'usdc' && yo.plan.pagos) || []), { ...pago, meses, fecha: Date.now() }].slice(-50);
  return p.ponerPlan({ id: cuentaId }, { proveedor: 'usdc', estado: 'pagado', hasta: desde + meses * MES, pagos });
}

// Repaso automático: cada 10 s si hay pedidos esperando; si no, cada 2 min
async function vigilar() {
  let espera = 120000;
  try {
    const e = await leerEstado();
    if (e.pedidos.some((x) => !x.tx && Date.now() - x.creado < RECONOCE)) espera = 10000;
    await repasar();
  } catch (err) {
    console.error(`Pagos: no se pudo leer Base (${err.message})`);
    espera = 30000;
  }
  setTimeout(vigilar, espera).unref?.();
}

// ---------- Pedidos ----------
// Céntimos únicos: entre los pedidos de las últimas 48 h no se repite ningún importe
function importeUnico(e, usdc) {
  const usados = new Set(e.pedidos.filter((x) => !x.tx && Date.now() - x.creado < RECONOCE).map((x) => x.importe));
  const base = Math.round(usdc * 1e6);
  const libres = [];
  for (let c = 1; c <= 99; c++) if (!usados.has(String(base + c * 10000))) libres.push(base + c * 10000);
  // Si se acabaran los céntimos, milésimas
  if (!libres.length) for (let c = 1; c <= 999; c++) if (!usados.has(String(base + c * 1000))) libres.push(base + c * 1000);
  if (!libres.length) throw error(503, 'Hay muchos pagos en marcha ahora mismo: prueba en un rato');
  return String(libres[Math.floor(Math.random() * libres.length)]);
}

// Lo que necesita la pantalla de pago: importe, dirección, enlace para la cartera y QR
async function paraPagar(x) {
  // EIP-681: lo abren MetaMask, Coinbase Wallet, Rainbow… con todo ya puesto (USDC, Base, importe)
  const enlace = `ethereum:${USDC_BASE}@${CADENA}/transfer?address=${DIRECCION}&uint256=${x.importe}`;
  return {
    id: x.id, meses: x.meses, importe: x.importe, importeTexto: fmt(x.importe), importeExacto: conPunto(x.importe),
    direccion: DIRECCION, red: 'Base', moneda: 'USDC', contrato: USDC_BASE, enlace,
    qr: await QRCode.toString(enlace, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    caduca: x.creado + CADUCA, estado: x.tx ? 'pagado' : Date.now() - x.creado > CADUCA ? 'caducado' : 'esperando', tx: x.tx ?? null,
  };
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
export const RUTAS = ['/api/pago/info', '/api/pago/usdc/pedido', '/api/pago/usdc/estado', '/api/pago/usdc/cancelar'];
export async function atender(ruta, req, res, json, cuenta) {
  const url = new URL(req.url, 'http://x');
  if (ruta === '/api/pago/info') {
    const plan = await p.planDe(cuenta);
    let pendiente = null;
    if (activo) {
      const e = await leerEstado();
      const x = e.pedidos.filter((y) => y.cuenta === cuenta.id && !y.tx && Date.now() - y.creado < CADUCA).at(-1);
      if (x) pendiente = await paraPagar(x);
    }
    return json(res, 200, {
      activo, proveedor: 'usdc', red: 'Base', plan: plan.tipo, hasta: plan.hasta ?? null, admin: !!plan.admin,
      opciones: OPCIONES.map((o) => ({ ...o, texto: `${fmt(o.usdc * 1e6)} USDC` })),
      precio: await precioTexto(), pendiente,
      pagos: (cuenta.plan?.proveedor === 'usdc' ? cuenta.plan.pagos ?? [] : []).slice(-5).reverse()
        .map((x) => ({ fecha: x.fecha, meses: x.meses, importe: x.importe ? fmt(x.importe) : null, tx: x.tx ?? null })),
      // Premium no ve anuncios: ni se le manda la configuración
      anuncios: plan.tipo === 'premium' ? null : await anuncios(),
    });
  }
  if (!activo) throw error(503, 'Los pagos no están activados todavía');

  // Cómo va un pedido (la pantalla de pago lo mira cada pocos segundos; si hace falta, repasa ya)
  if (ruta === '/api/pago/usdc/estado') {
    const id = String(url.searchParams.get('id') ?? '');
    let e = await leerEstado();
    let x = e.pedidos.find((y) => y.id === id && y.cuenta === cuenta.id);
    if (!x) throw error(404, 'Ese pedido no existe');
    if (!x.tx && Date.now() - ultimoRepaso > 5000) {
      await repasar().catch(() => {});
      e = await leerEstado();
      x = e.pedidos.find((y) => y.id === id);
    }
    return json(res, 200, { estado: x.tx ? 'pagado' : Date.now() - x.creado > CADUCA ? 'caducado' : 'esperando', tx: x.tx ?? null, plan: (await p.planDe(await p.cuentaPorId(cuenta.id))).tipo });
  }

  if (req.method !== 'POST') throw error(405, 'Método no permitido');
  let cuerpo = '';
  for await (const t of req) { cuerpo += t; if (cuerpo.length > 10000) throw error(413, 'Demasiado grande'); }
  const datos = cuerpo ? JSON.parse(cuerpo) : {};

  // Nuevo pedido: elige cuántos meses; devuelve el importe exacto y cómo pagarlo
  if (ruta === '/api/pago/usdc/pedido') {
    const plan = await p.planDe(cuenta);
    if (plan.admin) throw error(409, 'Los administradores ya tienen Premium de por vida');
    if (datos.acepta !== true) throw error(400, 'Tienes que aceptar las condiciones y el inicio inmediato del servicio');
    const o = OPCIONES.find((x) => x.id === String(datos.opcion));
    if (!o) throw error(400, 'Elige una de las opciones');
    await p.anotarAceptacion(cuenta.id, 'premium');
    const bloque = Number(await rpc('eth_blockNumber', [])) - CONFIRMACIONES - 5;
    const x = await conEstado((e) => {
      // Un pedido abierto por cuenta: el nuevo sustituye al anterior sin pagar
      e.pedidos = e.pedidos.filter((y) => !(y.cuenta === cuenta.id && !y.tx && Date.now() - y.creado < CADUCA));
      if (!e.ultimoBloque) e.ultimoBloque = bloque;
      const nuevo = { id: randomUUID(), cuenta: cuenta.id, usuario: cuenta.usuario, meses: o.meses, importe: importeUnico(e, o.usdc), creado: Date.now() };
      e.pedidos.push(nuevo);
      return nuevo;
    });
    console.log(`Pagos: ${cuenta.usuario} pide ${o.meses} mes(es) por ${fmt(x.importe)} USDC`);
    return json(res, 200, await paraPagar(x));
  }
  if (ruta === '/api/pago/usdc/cancelar') {
    await conEstado((e) => { e.pedidos = e.pedidos.filter((x) => !(x.id === String(datos.id) && x.cuenta === cuenta.id && !x.tx)); });
    return json(res, 200, { ok: true });
  }
  throw error(404, 'No existe');
}

// Para el gestor: pedidos recientes y pagos que llegaron sin poder identificarse
export async function resumenAdmin() {
  const e = await leerEstado();
  return {
    estado, direccion: activo ? DIRECCION : null, opciones: OPCIONES,
    pedidos: e.pedidos.slice(-100).reverse().map((x) => ({ id: x.id, usuario: x.usuario, meses: x.meses, importe: fmt(x.importe), creado: x.creado, tx: x.tx ?? null, pagado: x.pagado ?? null })),
    sueltos: e.sueltos.slice().reverse().map((x) => ({ tx: x.tx, de: x.de, importe: fmt(x.importe), fecha: x.fecha, asignado: x.asignado ?? null })),
  };
}
// Un pago sin identificar se asigna a una cuenta (meses a mano)
export function asignarSuelto(tx, cuentaId, meses, quien) {
  return conEstado(async (e) => {
    const s = e.sueltos.find((x) => x.tx === tx);
    if (!s) throw error(404, 'Ese pago no está en la lista');
    if (s.asignado) throw error(409, 'Ese pago ya se asignó');
    await darMeses(cuentaId, meses, { tx, importe: s.importe, de: s.de, asignadoPor: quien });
    s.asignado = { cuenta: cuentaId, meses, por: quien, fecha: Date.now() };
  });
}

// Sin suscripciones: al borrar una cuenta no hay nada que cancelar
export async function cancelarDe() {}
