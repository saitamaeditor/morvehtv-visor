// Planes de MorvehTV: «Básico» (gratis, con anuncios) y «Premium» (sin anuncios). Premium se
// consigue con una donación en USDC por la red Base: cada importe da unos meses de Premium
// (por defecto, 5,50 USDC ≈ 5 € = 12 meses). No hay suscripción ni cobros automáticos: se paga cuando se
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
//  · CRIPTO_PRECIOS (opcional): «USDC:meses» separados por comas; por defecto 5.5:12 (un año
//    por 5,50 USDC, unos 5 €, un único pago al año)
//  · CRIPTO_EUR_POR_USD (opcional): cuántos euros vale un dólar, solo para enseñar el precio
//    aproximado en euros (por defecto 0.92)
//  · CRIPTO_RPC (opcional): nodo de Base para leer la blockchain; por defecto el público
//    https://mainnet.base.org
//
// Anuncios del plan Básico: vídeos propios (subidos desde el gestor) o, en la web, anuncios de
// vídeo de Google (ANUNCIOS_VAST) antes de reproducir; además banners: AdSense
// (ANUNCIOS_ADSENSE + ANUNCIOS_ADSENSE_SLOT) o los propios del gestor.
import { randomUUID, createHash, timingSafeEqual, randomInt } from 'node:crypto';
import QRCode from 'qrcode';

export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const CADENA = 8453;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const DIRECCION = String(process.env.CRIPTO_DIRECCION ?? '').trim().toLowerCase();
// Nodos de Base para leer la blockchain: varios públicos que se turnan (el de Base limita las
// peticiones por IP y Render comparte IP con muchos servicios). CRIPTO_RPC puede poner los tuyos
// (separados por comas), por ejemplo uno gratuito de Alchemy o QuickNode con tu clave.
const RPCS = String(process.env.CRIPTO_RPC ?? '').split(',').map((x) => x.trim()).filter((x) => /^https:\/\//.test(x) || /^http:\/\/127\./.test(x));
if (!RPCS.length) RPCS.push('https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base');
const OPCIONES = String(process.env.CRIPTO_PRECIOS ?? '5.5:12').split(',').map((x) => x.trim().split(':').map(Number))
  .filter(([u, m]) => u > 0 && m > 0 && Number.isFinite(u) && Number.isInteger(m))
  .map(([usdc, meses], i) => ({ id: String(i + 1), usdc, meses }));
const MES = 30 * 864e5;
// Premium es un pago de 12 meses que NO se renueva solo: al terminar hay que volver a pagar. Se
// puede renovar a partir de 30 días antes de que acabe (el año nuevo empieza cuando termine el
// actual, así no se pierde ningún día); antes de eso no se puede volver a pagar.
const RENOVAR_ANTES = 30 * 864e5;
const puedeRenovar = (plan) => !esPremium(plan) || plan.hasta - Date.now() <= RENOVAR_ANTES;
const CADUCA = 60 * 60000; // un pedido se puede pagar durante 1 hora…
const RECONOCE = 48 * 3600000; // …y aun así se reconoce si llega en las 48 h siguientes
const CONFIRMACIONES = 3; // bloques de margen (~6 s) antes de dar un pago por bueno
// Direcciones que NO son una cartera y donde un pago se perdería: los contratos de las monedas
// (USDC y USDT en las redes más usadas), la dirección cero y la de «quemar»
const PROHIBIDAS = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC en Ethereum
  USDC_BASE, // USDC en Base
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC (puente) en Base
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC en Polygon
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC en Arbitrum
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85', '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC en Optimism
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', // USDC en Avalanche
  '0xdac17f958d2ee523a2206206994597c13d831ec7', '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
  '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead',
]);
const valida = /^0x[0-9a-f]{40}$/.test(DIRECCION);
// Sin CRIPTO_DIRECCION no hay pagos: la web no enseña nada de Premium (solo plan gratuito con anuncios)
let problema = !DIRECCION ? 'desactivados (sin CRIPTO_DIRECCION)'
  : !valida ? 'CRIPTO_DIRECCION no es una dirección válida (0x y 40 caracteres)'
    : PROHIBIDAS.has(DIRECCION) ? 'CRIPTO_DIRECCION es la dirección de un CONTRATO DE MONEDA, no de tu cartera: los pagos se perderían. Pon la dirección pública de tu cartera en Base'
      : !OPCIONES.length ? 'CRIPTO_PRECIOS no es válido (formato 4:1,10:3,40:12)' : null;
// ---------- Ko-fi ----------
// VIP pagado en Ko-fi (tarjeta, PayPal, Apple Pay…). Cada pedido lleva un código (MV7K3P9Q) que
// la persona pega en el mensaje del pago; Ko-fi avisa al servidor (webhook) y el VIP se activa
// solo. Los meses salen del importe pagado (KOFI_PLANES). Si alguien paga desde el mismo correo
// que una vez anterior, se reconoce aunque no ponga el código (se guarda solo una huella del
// correo, no el correo). Lo que llegue sin poder identificarse queda para asignarlo a mano.
//  · KOFI_TOKEN: el «Verification Token» de Ko-fi (Ajustes → API). Sin él, no hay Ko-fi
//  · KOFI_URL (opcional): la página de Ko-fi; por defecto https://ko-fi.com/morvehtv
//  · KOFI_PLANES (opcional): «euros:meses» separados por comas; por defecto 5:1,10:6,15:12
const KOFI_TOKEN = String(process.env.KOFI_TOKEN ?? '').trim();
const KOFI_URL = /^https:\/\/(www\.)?ko-fi\.com\/[\w-]+\/?$/.test(String(process.env.KOFI_URL ?? '').trim()) ? String(process.env.KOFI_URL).trim() : 'https://ko-fi.com/morvehtv';
const KOFI_PLANES = String(process.env.KOFI_PLANES ?? '5:1,10:6,15:12').split(',').map((x) => x.trim().split(':').map(Number))
  .filter(([e, m]) => e > 0 && m > 0 && Number.isFinite(e) && Number.isInteger(m))
  .map(([euros, meses], i) => ({ id: String(i + 1), euros, meses }));
export const KOFI = KOFI_TOKEN.length >= 8 && KOFI_PLANES.length > 0;
const eur = (n) => `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })} €`;
const mesesTexto = (m) => (m === 12 ? '1 año' : m === 1 ? '1 mes' : `${m} meses`);
const KOFI_CADUCA = 30 * 864e5; // un código sirve durante 30 días

let usdc = !problema;
export let activo = usdc || KOFI;
const estadoUsdc = () => (usdc ? `USDC en Base · ${DIRECCION.slice(0, 6)}…${DIRECCION.slice(-4)}` : null);
export let estado = activo ? `ok (${[KOFI ? 'Ko-fi' : null, estadoUsdc()].filter(Boolean).join(' y ')})` : problema;
function desactivar(motivo) {
  problema = motivo; usdc = false; activo = KOFI;
  estado = KOFI ? `ok (Ko-fi) · USDC: ${motivo}` : motivo;
  console.error(`Pagos: ${motivo}`);
}

// Al arrancar, se pregunta a Base si la dirección es una moneda (responde a «symbol()»): si lo
// es, los pagos se desactivan para que nadie envíe nada a donde se perdería
async function comprobarDireccion() {
  try {
    const r = await rpc('eth_call', [{ to: DIRECCION, data: '0x95d89b41' }, 'latest']);
    if (r && r !== '0x' && r.length >= 130) desactivar('CRIPTO_DIRECCION es el contrato de una moneda o token, no tu cartera: los pagos se perderían. Pon la dirección pública de tu cartera en Base');
  } catch { /* si Base no responde ahora, se sigue: la lista de arriba ya cubre las monedas conocidas */ }
}

let p; // perfiles.js
let firmar = async () => null; // enlaces firmados de e2 (vídeos de anuncios)
export function iniciar(opciones) {
  ({ perfiles: p } = opciones);
  firmar = opciones.firmar ?? firmar;
  if (usdc) comprobarDireccion().then(() => { if (usdc) setTimeout(vigilar, 5000); });
}

const error = (status, message) => Object.assign(new Error(message), { status });
const EUR_POR_USD = Number(process.env.CRIPTO_EUR_POR_USD) > 0 ? Number(process.env.CRIPTO_EUR_POR_USD) : 0.92;
// «5,50 USDC (unos 5 €) / 12 meses»
const euros = (usdc) => { const e = Math.round(usdc * EUR_POR_USD * 2) / 2; return `unos ${e.toLocaleString('es-ES', { maximumFractionDigits: 2 })} €`; };
export const precioTexto = async () => (KOFI ? KOFI_PLANES.map((o) => `${eur(o.euros)} ${o.meses === 1 ? 'al mes' : o.meses === 12 ? 'al año' : `${o.meses} meses`}`).join(', ').replace(/, ([^,]*)$/, ' o $1')
  : OPCIONES[0] ? `${fmt(OPCIONES[0].usdc * 1e6)} USDC (${euros(OPCIONES[0].usdc)}) / ${OPCIONES[0].meses === 1 ? 'mes' : `${OPCIONES[0].meses} meses`}` : null);

// Importes en «micro-USDC» (enteros, sin decimales: 4,37 USDC = 4370000) para no perder céntimos
const fmt = (micro) => (Number(micro) / 1e6).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const conPunto = (micro) => (Number(micro) / 1e6).toFixed(6).replace(/0{1,4}$/, '');

// ¿Premium? Pagado y dentro del tiempo comprado
export function esPremium(plan) {
  return Boolean(plan && (plan.proveedor === 'usdc' || plan.proveedor === 'kofi') && plan.hasta && plan.hasta > Date.now());
}

// ---------- Estado guardado (en el archivo de cuentas: sobrevive a los reinicios de Render) ----------
// { ultimoBloque, pedidos: [...], sueltos: [...] }
async function leerEstado() { return { pedidos: [], sueltos: [], kpedidos: [], ksueltos: [], kvistos: [], kclientes: {}, ...((await p.leerAjuste('cripto')) ?? {}) }; }
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
  kpedidos: e.kpedidos.filter((x) => Date.now() - x.creado < 90 * 864e5).slice(-1000),
  ksueltos: e.ksueltos.filter((x) => Date.now() - x.fecha < 180 * 864e5).slice(-300),
  kvistos: e.kvistos.slice(-2000),
});

// ---------- Lectura de la blockchain (JSON-RPC de Base) ----------
// Si un nodo falla o dice que se ha pasado del límite, se prueba el siguiente
let nodo = 0;
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function rpc(metodo, params) {
  let ultimoError;
  for (let intento = 0; intento < RPCS.length; intento++) {
    const url = RPCS[(nodo + intento) % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: metodo, params }) });
      const d = await r.json().catch(() => ({}));
      if (d.error || !r.ok || d.result === undefined) throw new Error(d.error?.message ?? `HTTP ${r.status}`);
      nodo = (nodo + intento) % RPCS.length; // el que funcionó, primero la próxima vez
      return d.result;
    } catch (e) {
      ultimoError = e;
      await pausa(300);
    }
  }
  throw new Error(`Base: ${ultimoError?.message ?? 'sin respuesta'}`);
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
  // De 1000 en 1000 bloques (los nodos públicos no dejan pedir más de golpe) y con una pausa entre
  // peticiones para no pasarse de su límite
  const logs = [];
  for (let a = desde; a <= ultimo; a += 1000) {
    const b = Math.min(ultimo, a + 999);
    logs.push(...await rpc('eth_getLogs', [{ address: USDC_BASE, fromBlock: hex(a), toBlock: hex(b), topics: [TRANSFER, null, tema(DIRECCION)] }]));
    if (b < ultimo) await pausa(250);
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
export async function darMeses(cuentaId, meses, pago, proveedor = 'usdc') {
  const yo = await p.cuentaPorId(cuentaId);
  if (!yo) throw error(404, 'Esa cuenta ya no existe');
  const desde = Math.max(Date.now(), esPremium(yo.plan) ? yo.plan.hasta : 0);
  const antes = (yo.plan?.proveedor === 'usdc' || yo.plan?.proveedor === 'kofi') ? yo.plan.pagos ?? [] : [];
  const pagos = [...antes, { ...pago, meses, fecha: Date.now() }].slice(-50);
  // Meses de calendario (12 meses = un año exacto: del 4 de noviembre al 4 de noviembre)
  const fin = new Date(desde);
  fin.setMonth(fin.getMonth() + meses);
  return p.ponerPlan({ id: cuentaId }, { proveedor, estado: 'pagado', hasta: fin.getTime(), pagos });
}

// Repaso automático: cada 15 s si hay pedidos esperando; si no, cada 10 min (solo para apuntar
// pagos que lleguen sin pedido). Si Base no responde, se espera cada vez más (hasta 5 min).
let fallos = 0;
async function vigilar() {
  if (!usdc) return;
  let espera = 600000;
  try {
    const e = await leerEstado();
    if (e.pedidos.some((x) => !x.tx && Date.now() - x.creado < RECONOCE)) espera = 15000;
    await repasar();
    fallos = 0;
  } catch (err) {
    fallos++;
    if (fallos === 1 || fallos % 10 === 0) console.error(`Pagos: no se pudo leer Base (${err.message}); se reintenta`);
    espera = Math.min(300000, 15000 * 2 ** Math.min(fallos, 5));
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
// Solo anuncios en vídeo ANTES DE REPRODUCIR, de redes de anuncios externas que no son Google
// (Adsterra, ExoClick, HilltopAds, Monetag…): en ANUNCIOS_VAST, la etiqueta (dirección) VAST que
// da la red. Se pueden poner varias separadas por espacios o saltos de línea: si la primera no
// tiene anuncio para ese usuario, se prueba la siguiente. Ni anuncios propios ni de Google: las
// direcciones de Google (doubleclick, googlesyndication…) se ignoran.
const ES_GOOGLE = /(^|\.)(google|googlesyndication|googleadservices|doubleclick|googlevideo|gstatic|2mdn|youtube)\.[a-z.]+$/i;
const VAST = String(process.env.ANUNCIOS_VAST ?? '').split(/\s+/).filter((u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && !ES_GOOGLE.test(x.hostname); } catch (e) { return false; }
}).slice(0, 6);
// Cuántos anuncios seguidos antes de cada vídeo (ANUNCIOS_PREVIOS, 1 a 3) y a los cuántos
// segundos se pueden saltar si el anuncio no dice otra cosa (ANUNCIOS_SALTAR, 5 por defecto;
// si la red marca el suyo, manda el de la red)
const PREVIOS = Math.min(3, Math.max(1, Number(process.env.ANUNCIOS_PREVIOS) || 1));
const SALTAR = Math.min(30, Math.max(0, Number(process.env.ANUNCIOS_SALTAR ?? 5) || 0));
// Si ninguna red da vídeo (o no hay VAST), un banner de una red externa en la pantalla previa
// (p. ej. el «Banner 300x250» de Adsterra): ANUNCIOS_BANNER_KEY (la «key» de su código) y
// ANUNCIOS_BANNER_SRC (la dirección del <script src> de su código); ANUNCIOS_BANNER_TAMANO, 300x250
const BANNER_KEY = String(process.env.ANUNCIOS_BANNER_KEY ?? '').trim();
const BANNER_SRC = String(process.env.ANUNCIOS_BANNER_SRC ?? '').trim();
const [BANNER_ANCHO, BANNER_ALTO] = (/^(\d{2,4})x(\d{2,4})$/.exec(String(process.env.ANUNCIOS_BANNER_TAMANO ?? '300x250').trim()) ?? [0, 300, 250]).slice(1).map(Number);
const BANNER = /^[\w-]{8,80}$/.test(BANNER_KEY) && (() => {
  try { const x = new URL(BANNER_SRC); return x.protocol === 'https:' && !ES_GOOGLE.test(x.hostname); } catch (e) { return false; }
})();
// Anuncios apagados salvo que se pida ANUNCIOS=1 (y haya alguna etiqueta VAST o un banner)
export const CON_ANUNCIOS = process.env.ANUNCIOS === '1' && (VAST.length > 0 || BANNER);
async function anuncios() {
  if (!CON_ANUNCIOS) return null;
  // «sonda»: el script de la red, para saber si un bloqueador (o el DNS) lo impide
  return { vast: VAST, banner: BANNER ? { ancho: BANNER_ANCHO, alto: BANNER_ALTO } : null, sonda: BANNER ? BANNER_SRC : null,
    previos: { cantidad: PREVIOS, esperaMin: 0 }, saltarEn: SALTAR, durante: { cadaMin: 0 }, pausa: false, banners: false, propios: [] };
}

// La página que va dentro del marco aislado del banner (sin sesión ni datos de nadie: solo el
// código de la red). Si el código de la red no carga (bloqueador), se avisa a la web para no
// tener al usuario mirando un hueco vacío.
export function paginaBanner() {
  if (!CON_ANUNCIOS || !BANNER) return null;
  const opciones = JSON.stringify({ key: BANNER_KEY, format: 'iframe', height: BANNER_ALTO, width: BANNER_ANCHO, params: {} });
  const fuente = BANNER_SRC.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;display:flex;align-items:center;justify-content:center;width:100%;height:100%}</style>
</head><body>
<script>atOptions = ${opciones};
function avisar(m) { try { parent.postMessage(m, '*'); } catch (e) {} }
function sinAnuncio() { avisar('morvehtv-previo-vacio'); }
// En cuanto la red pinta algo de verdad, se avisa a la web (si no llega el aviso, la web no
// espera). Solo cuenta lo que se ve con tamaño de anuncio: sin anuncio que dar, la red mete a
// veces un píxel de seguimiento o un marco invisible, y eso dejaba un hueco negro.
function pintado() {
  var l = document.querySelectorAll('iframe, img, ins, a, video, canvas');
  for (var i = 0; i < l.length; i++) {
    var r = l[i].getBoundingClientRect();
    var s = getComputedStyle(l[i]);
    if (r.width >= 120 && r.height >= 60 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1) return true;
  }
  return false;
}
var mirar = setInterval(function () { if (pintado()) { clearInterval(mirar); clearTimeout(limite); avisar('morvehtv-previo-listo'); } }, 200);
var limite = setTimeout(function () { clearInterval(mirar); sinAnuncio(); }, 3500);
// Si el código de la red llega vacío (no tiene anuncio), no se espera a que pase el tiempo
function cargado() { setTimeout(function () { if (!pintado() && !document.querySelector('iframe, ins')) { clearInterval(mirar); clearTimeout(limite); sinAnuncio(); } }, 800); }</script>
<script src="${fuente}" onload="cargado()" onerror="sinAnuncio()"></script>
</body></html>`;
}

// ads.txt: algunas redes piden publicar sus líneas; se pone tal cual en ANUNCIOS_ADSTXT
// (con \n para separar líneas)
export function adsTxt() {
  if (!CON_ANUNCIOS) return null;
  const propio = String(process.env.ANUNCIOS_ADSTXT ?? '').trim();
  return propio ? propio.replace(/\\n/g, '\n') + '\n' : null;
}

// ---------- Rutas (con sesión) ----------
export const RUTAS = ['/api/pago/info', '/api/pago/usdc/pedido', '/api/pago/usdc/estado', '/api/pago/usdc/cancelar',
  '/api/pago/kofi/pedido', '/api/pago/kofi/estado', '/api/pago/kofi/cancelar'];
const importeTexto = (x) => (x.euros != null ? eur(x.euros) : x.importe ? `${fmt(x.importe)} USDC` : null);
export async function atender(ruta, req, res, json, cuenta) {
  const url = new URL(req.url, 'http://x');
  if (ruta === '/api/pago/info') {
    const plan = await p.planDe(cuenta);
    let pendiente = null;
    if (KOFI) {
      const e = await leerEstado();
      const x = e.kpedidos.filter((y) => y.cuenta === cuenta.id && !y.tx && Date.now() - y.creado < KOFI_CADUCA).at(-1);
      if (x) pendiente = paraKofi(x);
    } else if (usdc) {
      const e = await leerEstado();
      const x = e.pedidos.filter((y) => y.cuenta === cuenta.id && !y.tx && Date.now() - y.creado < CADUCA).at(-1);
      if (x) pendiente = await paraPagar(x);
    }
    const conPlan = cuenta.plan?.proveedor === 'usdc' || cuenta.plan?.proveedor === 'kofi';
    return json(res, 200, {
      activo, proveedor: KOFI ? 'kofi' : 'usdc', red: 'Base', plan: plan.tipo, hasta: plan.hasta ?? null, admin: !!plan.admin,
      // Renovación: con Ko-fi se puede pagar siempre (los meses se suman); con USDC, sin VIP o en su último mes
      puedeRenovar: !plan.admin && (KOFI || puedeRenovar(cuenta.plan)),
      vencio: conPlan && cuenta.plan.hasta && cuenta.plan.hasta <= Date.now() ? cuenta.plan.hasta : null,
      opciones: KOFI ? KOFI_PLANES.map((o) => ({ ...o, texto: eur(o.euros), titulo: mesesTexto(o.meses) }))
        : OPCIONES.map((o) => ({ ...o, texto: `${fmt(o.usdc * 1e6)} USDC` })),
      precio: await precioTexto(), pendiente,
      pagos: (conPlan ? cuenta.plan.pagos ?? [] : []).slice(-5).reverse()
        .map((x) => ({ fecha: x.fecha, meses: x.meses, importe: x.importe ? fmt(x.importe) : null, importeTexto: importeTexto(x), tx: x.tx ?? null })),
      // Premium no ve anuncios: ni se le manda la configuración
      anuncios: plan.tipo === 'premium' ? null : await anuncios(),
    });
  }
  if (!activo) throw error(503, 'Los pagos no están activados todavía');
  if (ruta.startsWith('/api/pago/kofi/')) return atenderKofi(ruta, req, res, json, cuenta, url);
  if (!usdc) throw error(503, 'El pago con USDC no está activado');

  // Cómo va un pedido (la pantalla de pago lo mira cada pocos segundos; si hace falta, repasa ya)
  if (ruta === '/api/pago/usdc/estado') {
    const id = String(url.searchParams.get('id') ?? '');
    let e = await leerEstado();
    let x = e.pedidos.find((y) => y.id === id && y.cuenta === cuenta.id);
    if (!x) throw error(404, 'Ese pedido no existe');
    if (!x.tx && Date.now() - ultimoRepaso > 12000) {
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
    if (plan.admin) throw error(409, 'Los administradores ya son VIP de por vida');
    if (!puedeRenovar(cuenta.plan)) {
      throw error(409, `Ya eres VIP hasta el ${new Date(cuenta.plan.hasta).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}. Podrás renovarlo en su último mes.`);
    }
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
    estado, direccion: usdc ? DIRECCION : null, opciones: OPCIONES,
    pedidos: e.pedidos.slice(-100).reverse().map((x) => ({ id: x.id, usuario: x.usuario, meses: x.meses, importe: fmt(x.importe), creado: x.creado, tx: x.tx ?? null, pagado: x.pagado ?? null })),
    sueltos: [
      ...e.ksueltos.map((x) => ({ tx: x.tx, de: `Ko-fi · ${x.nombre || 'sin nombre'}${x.mensaje ? ` · «${x.mensaje}»` : ''}`, importe: `${x.euros} ${x.moneda}`, fecha: x.fecha, asignado: x.asignado ?? null })),
      ...e.sueltos.map((x) => ({ tx: x.tx, de: x.de, importe: fmt(x.importe), fecha: x.fecha, asignado: x.asignado ?? null })),
    ].sort((a, b) => b.fecha - a.fecha),
    kofi: KOFI ? { url: KOFI_URL, planes: KOFI_PLANES, pedidos: e.kpedidos.slice(-100).reverse().map((x) => ({ codigo: x.codigo, usuario: x.usuario, meses: x.meses, euros: x.euros, creado: x.creado, pagado: x.pagado ?? null })) } : null,
  };
}
// Un pago sin identificar se asigna a una cuenta (meses a mano)
export function asignarSuelto(tx, cuentaId, meses, quien) {
  return conEstado(async (e) => {
    const k = e.ksueltos.find((x) => x.tx === tx);
    const s = k ?? e.sueltos.find((x) => x.tx === tx);
    if (!s) throw error(404, 'Ese pago no está en la lista');
    if (s.asignado) throw error(409, 'Ese pago ya se asignó');
    if (k) {
      await darMeses(cuentaId, meses, { kofi: tx, euros: k.euros, asignadoPor: quien }, 'kofi');
      if (k.cliente) e.kclientes[k.cliente] = cuentaId; // la próxima vez desde ese correo, sola
    } else await darMeses(cuentaId, meses, { tx, importe: s.importe, de: s.de, asignadoPor: quien });
    s.asignado = { cuenta: cuentaId, meses, por: quien, fecha: Date.now() };
  });
}

// Sin suscripciones: al borrar una cuenta no hay nada que cancelar
export async function cancelarDe() {}

// ---------- Ko-fi: pedidos, aviso de pago y activación ----------
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I/L, que se confunden
const nuevoCodigo = () => 'MV' + Array.from({ length: 6 }, () => LETRAS[randomInt(LETRAS.length)]).join('');
const paraKofi = (x) => ({ id: x.id, codigo: x.codigo, meses: x.meses, titulo: mesesTexto(x.meses), euros: x.euros, importeTexto: eur(x.euros), url: KOFI_URL, estado: x.tx ? 'pagado' : 'esperando' });
// Meses según lo pagado: el plan más largo cuyo precio alcanza
const mesesPorImporte = (euros) => KOFI_PLANES.filter((o) => euros + 0.005 >= o.euros).sort((a, b) => b.meses - a.meses)[0]?.meses ?? 0;
const huella = (correo) => (correo ? createHash('sha256').update(`morvehtv-kofi:${String(correo).trim().toLowerCase()}`).digest('hex').slice(0, 32) : null);

async function atenderKofi(ruta, req, res, json, cuenta, url) {
  if (!KOFI) throw error(503, 'El pago con Ko-fi no está activado');
  if (ruta === '/api/pago/kofi/estado') {
    const id = String(url.searchParams.get('id') ?? '');
    const x = (await leerEstado()).kpedidos.find((y) => y.id === id && y.cuenta === cuenta.id);
    if (!x) throw error(404, 'Ese pedido no existe');
    return json(res, 200, { estado: x.tx ? 'pagado' : 'esperando', plan: (await p.planDe(await p.cuentaPorId(cuenta.id))).tipo });
  }
  if (req.method !== 'POST') throw error(405, 'Método no permitido');
  let cuerpo = '';
  for await (const t of req) { cuerpo += t; if (cuerpo.length > 10000) throw error(413, 'Demasiado grande'); }
  const datos = cuerpo ? JSON.parse(cuerpo) : {};
  if (ruta === '/api/pago/kofi/pedido') {
    const plan = await p.planDe(cuenta);
    if (plan.admin) throw error(409, 'Los administradores ya son VIP de por vida');
    if (datos.acepta !== true) throw error(400, 'Marca la casilla para continuar');
    const o = KOFI_PLANES.find((x) => x.id === String(datos.opcion));
    if (!o) throw error(400, 'Elige una de las opciones');
    await p.anotarAceptacion(cuenta.id, 'premium');
    const x = await conEstado((e) => {
      // Un pedido abierto por cuenta: el nuevo sustituye al anterior sin pagar
      e.kpedidos = e.kpedidos.filter((y) => !(y.cuenta === cuenta.id && !y.tx));
      let codigo;
      do codigo = nuevoCodigo(); while (e.kpedidos.some((y) => y.codigo === codigo));
      const nuevo = { id: randomUUID(), codigo, cuenta: cuenta.id, usuario: cuenta.usuario, meses: o.meses, euros: o.euros, creado: Date.now() };
      e.kpedidos.push(nuevo);
      return nuevo;
    });
    console.log(`Pagos: ${cuenta.usuario} pide ${mesesTexto(o.meses)} de VIP por Ko-fi (${eur(o.euros)}, código ${x.codigo})`);
    return json(res, 200, paraKofi(x));
  }
  if (ruta === '/api/pago/kofi/cancelar') {
    await conEstado((e) => { e.kpedidos = e.kpedidos.filter((x) => !(x.id === String(datos.id) && x.cuenta === cuenta.id && !x.tx)); });
    return json(res, 200, { ok: true });
  }
  throw error(404, 'No existe');
}

// Aviso de Ko-fi (POST /api/kofi/webhook, sin sesión): un formulario con «data» = JSON del pago.
// Se comprueba su token; cada pago se apunta una sola vez (Ko-fi puede repetir el aviso).
export async function webhookKofi(req, res, json) {
  if (!KOFI) return json(res, 404, { error: 'Ko-fi no está activado' });
  if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido' });
  let cuerpo = '';
  for await (const t of req) { cuerpo += t; if (cuerpo.length > 50000) return json(res, 413, { error: 'Demasiado grande' }); }
  let d;
  try { d = JSON.parse(new URLSearchParams(cuerpo).get('data') ?? cuerpo); } catch { return json(res, 400, { error: 'Formato no válido' }); }
  const token = Buffer.from(String(d?.verification_token ?? ''));
  const bueno = Buffer.from(KOFI_TOKEN);
  if (token.length !== bueno.length || !timingSafeEqual(token, bueno)) {
    console.warn('Pagos: aviso de Ko-fi con un token que no es el tuyo (ignorado)');
    return json(res, 403, { error: 'Token no válido' });
  }
  const tx = String(d.kofi_transaction_id ?? d.message_id ?? '').slice(0, 80);
  const euros = Math.round(Number(String(d.amount ?? '0').replace(',', '.')) * 100) / 100;
  const moneda = String(d.currency ?? '').toUpperCase().slice(0, 5);
  const mensaje = String(d.message ?? '').slice(0, 300);
  const cliente = huella(d.email);
  if (!tx) return json(res, 400, { error: 'Sin identificador de pago' });
  const r = await conEstado(async (e) => {
    if (e.kvistos.includes(tx)) return 'repetido';
    e.kvistos.push(tx);
    const m = /MV[\s-]*([A-Z0-9]{6})/i.exec(`${mensaje} ${d.from_name ?? ''}`);
    let pedido = m ? e.kpedidos.find((x) => x.codigo === `MV${m[1].toUpperCase()}`) : null;
    const meses = moneda === 'EUR' ? mesesPorImporte(euros) : 0;
    // Sin código: si ese correo ya pagó antes, es de la misma cuenta
    let cuentaId = pedido?.cuenta ?? (cliente ? e.kclientes[cliente] : null);
    if (cuentaId && !(await p.cuentaPorId(cuentaId))) cuentaId = null;
    if (!cuentaId || !meses) {
      e.ksueltos.push({ tx, euros, moneda, nombre: String(d.from_name ?? '').slice(0, 60), mensaje, cliente, fecha: Date.now() });
      console.log(`Pagos: Ko-fi ${euros} ${moneda} sin poder asignarlo (${!cuentaId ? 'sin código' : 'importe por debajo del plan más barato o en otra moneda'})`);
      return 'suelto';
    }
    await darMeses(cuentaId, meses, { kofi: tx, euros }, 'kofi');
    if (pedido) { pedido.tx = tx; pedido.pagado = Date.now(); }
    if (cliente) e.kclientes[cliente] = cuentaId;
    console.log(`Pagos: Ko-fi ${eur(euros)} → ${mesesTexto(meses)} de VIP${pedido ? ` (código ${pedido.codigo})` : ' (mismo correo que antes)'}`);
    return 'activado';
  });
  return json(res, 200, { ok: true, resultado: r });
}
