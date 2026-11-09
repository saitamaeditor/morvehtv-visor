// Revendedores de cuentas de Emby, con créditos. Tres papeles:
//   · administrador (las cuentas de administrador del panel): todo, y crea créditos de la nada
//   · superrevendedor: crea revendedores y les pasa créditos de su saldo; también crea cuentas
//   · revendedor: crea y renueva cuentas de Emby gastando créditos (1 crédito = 1 mes)
// Cada uno solo ve y toca sus cuentas (y las de sus revendedores, si es super). Entran en el panel
// con su propio usuario y contraseña y reciben un token «rv_…» de 30
// días. Todo se guarda en el archivo de datos del servidor: «embyRevendedores» (sin contraseñas
// en claro: scrypt con sal; de los tokens solo su huella) y «embyMovimientos» (los últimos 1000).
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import * as emby from './emby.js';

const AJ_REV = 'embyRevendedores';
const AJ_MOV = 'embyMovimientos';
export const COSTE_MES = 1;
const MAX_CREDITOS = 100000;
const DIAS_TOKEN = 30;
// Demos (cuentas de prueba gratis): los revendedores, con límites; el administrador, sin ellos
export const DEMO = { horasRevendedor: [1, 3, 6, 12, 24], horasAdmin: [1, 3, 6, 12, 24, 48, 72], activasMax: 3, alDiaMax: 5 };

let p = null;
export function iniciar(opciones) { p = opciones.perfiles; }
const error = (status, message) => Object.assign(new Error(message), { status });

// Una operación con créditos a la vez (así nadie gasta dos veces el mismo saldo)
let cola = Promise.resolve();
const enCola = (fn) => { const r = cola.then(fn, fn); cola = r.catch(() => {}); return r; };

const todos = async () => (await p.leerAjuste(AJ_REV)) ?? {};
const guardar = (t) => p.guardarAjuste(AJ_REV, t);
const huella = (t) => createHash('sha256').update(t).digest('hex');
function cifrar(clave) { const sal = randomBytes(16).toString('hex'); return `${sal}:${scryptSync(String(clave), sal, 32).toString('hex')}`; }
function claveOk(clave, guardada) {
  const [sal, hx] = String(guardada ?? '').split(':');
  if (!sal || !hx) return false;
  const a = scryptSync(String(clave ?? ''), sal, 32); const b = Buffer.from(hx, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
const usuarioValido = (u) => {
  const s = String(u ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(s)) throw error(400, 'El usuario debe tener de 3 a 20 caracteres: letras, números, punto, guion o guion bajo');
  return s;
};
const claveValida = (c) => { const s = String(c ?? ''); if (s.length < 8 || s.length > 128) throw error(400, 'La contraseña debe tener al menos 8 caracteres'); return s; };
const enteroValido = (n, min, max, que) => { const v = Number(n); if (!Number.isInteger(v) || v < min || v > max) throw error(400, `${que} no válido`); return v; };

// El revendedor y todos los que cuelgan de él
function subarbol(t, id) {
  const ids = new Set([id]);
  let crece = true;
  while (crece) { crece = false; for (const r of Object.values(t)) if (r.padre && ids.has(r.padre) && !ids.has(r.id)) { ids.add(r.id); crece = true; } }
  return ids;
}
// Activo él y todos los que tiene por encima
function activoEnCadena(t, r) { for (let x = r, n = 0; x && n < 10; x = t[x.padre], n++) if (!x.activo) return false; return true; }

async function movimiento(quien, accion, extra = {}) {
  try {
    const lista = (await p.leerAjuste(AJ_MOV)) ?? [];
    lista.unshift({ fecha: new Date().toISOString(), quien: quien.admin ? null : quien.id, usuario: quien.admin ? quien.usuario : quien.usuario, admin: Boolean(quien.admin), accion, ...extra });
    await p.guardarAjuste(AJ_MOV, lista.slice(0, 1000));
  } catch (e) { console.error(`Revendedores: no se pudo apuntar el movimiento (${e.message})`); }
}

// ---------- Entrar ----------
const fallos = new Map(); // usuario → { n, hasta } (solo en memoria)
export async function entrar(datos) {
  const usuario = String(datos.usuario ?? '').trim().toLowerCase();
  const f = fallos.get(usuario);
  if (f && f.hasta > Date.now() && f.n >= 6) throw error(429, 'Demasiados intentos: espera 15 minutos');
  const t = await todos();
  const r = Object.values(t).find((x) => x.usuario === usuario);
  if (!r || !claveOk(datos.clave, r.clave)) {
    const n = (f && f.hasta > Date.now() ? f.n : 0) + 1;
    fallos.set(usuario, { n, hasta: Date.now() + 15 * 60000 });
    if (fallos.size > 5000) fallos.clear();
    throw error(401, 'Usuario o contraseña incorrectos');
  }
  if (!activoEnCadena(t, r)) throw error(403, 'Tu cuenta de revendedor está suspendida');
  fallos.delete(usuario);
  const token = `rv_${randomBytes(32).toString('hex')}`;
  await enCola(async () => {
    const t2 = await todos(); const x = t2[r.id]; if (!x) return;
    x.sesiones = [...(x.sesiones ?? []).filter((s) => s.caduca > Date.now()).slice(-4), { h: huella(token), caduca: Date.now() + DIAS_TOKEN * 864e5 }];
    x.ultimoAcceso = new Date().toISOString();
    await guardar(t2);
  });
  return { token, usuario: r.usuario, nombre: r.nombre, rol: r.rol };
}

export async function actorDeToken(token) {
  if (!/^rv_[a-f0-9]{64}$/.test(String(token))) return null;
  const h = huella(token);
  const t = await todos();
  const r = Object.values(t).find((x) => (x.sesiones ?? []).some((s) => s.h === h && s.caduca > Date.now()));
  if (!r || !activoEnCadena(t, r)) return null;
  return { ...r, admin: false };
}
export const yo = (a) => ({ usuario: a.usuario, nombre: a.nombre || a.usuario, rol: a.rol, creditos: a.creditos ?? 0 });

export async function salir(token) {
  const h = huella(String(token));
  await enCola(async () => {
    const t = await todos();
    for (const r of Object.values(t)) if ((r.sesiones ?? []).some((s) => s.h === h)) { r.sesiones = r.sesiones.filter((s) => s.h !== h); await guardar(t); return; }
  });
}

// ---------- Créditos ----------
async function gastar(actor, n, accion, extra) {
  if (actor.admin || !n) return;
  await enCola(async () => {
    const t = await todos(); const r = t[actor.id];
    if (!r) throw error(403, 'Tu cuenta de revendedor ya no existe');
    if ((r.creditos ?? 0) < n) throw error(402, `No tienes créditos suficientes: hacen falta ${n} y te ${(r.creditos ?? 0) === 1 ? 'queda' : 'quedan'} ${r.creditos ?? 0}`);
    r.creditos -= n;
    await guardar(t);
    await movimiento(actor, accion, { creditos: -n, saldo: r.creditos, ...extra });
  });
}
async function devolver(actor, n, accion) {
  if (actor.admin || !n) return;
  await enCola(async () => {
    const t = await todos(); const r = t[actor.id]; if (!r) return;
    r.creditos = (r.creditos ?? 0) + n;
    await guardar(t);
    await movimiento(actor, accion, { creditos: n, saldo: r.creditos });
  });
}
const mesesADias = (m) => (m === 12 ? 365 : m * 30);

// ---------- Lo que cada uno puede ver ----------
async function alcance(actor) {
  if (actor.admin) return null; // todo
  return subarbol(await todos(), actor.id);
}
async function puedeCuenta(actor, id) {
  if (actor.admin) return;
  const x = (await emby.extrasEmby())[id];
  const ids = await alcance(actor);
  if (!x?.dueno || !ids.has(x.dueno)) throw error(403, 'Esa cuenta no es tuya');
}

async function resumen(actor) {
  const r = await emby.resumen();
  const t = await todos();
  const ids = await alcance(actor);
  const nombre = (id) => (t[id] ? t[id].nombre || t[id].usuario : null);
  const usuarios = r.usuarios
    .filter((u) => !ids || (!u.admin && u.dueno && ids.has(u.dueno)))
    .map((u) => ({ ...u, duenoNombre: u.dueno ? nombre(u.dueno) ?? 'Revendedor borrado' : null }));
  const visibles = Object.values(t).filter((x) => (!ids || ids.has(x.id)) && (actor.admin || x.id !== actor.id));
  const fresco = actor.admin ? null : t[actor.id];
  return {
    ...r, usuarios,
    yo: actor.admin ? { rol: 'admin', usuario: actor.usuario } : yo(fresco ?? actor),
    revendedores: visibles.map((x) => ({ id: x.id, usuario: x.usuario, nombre: x.nombre || x.usuario, rol: x.rol })),
    costeMes: COSTE_MES,
    demo: { horas: actor.admin ? DEMO.horasAdmin : DEMO.horasRevendedor, ...(actor.admin ? {} : { activasMax: DEMO.activasMax, alDiaMax: DEMO.alDiaMax, hoy: (fresco?.demos ?? []).filter((f) => Date.now() - f < 24 * 3600e3).length }) },
  };
}

// ---------- Revendedores ----------
async function listar(actor) {
  const t = await todos();
  const ids = await alcance(actor);
  const extra = await emby.extrasEmby();
  const ahora = Date.now();
  return Object.values(t)
    .filter((r) => (!ids || ids.has(r.id)) && (actor.admin || r.id !== actor.id))
    .map((r) => {
      const suyas = Object.values(extra).filter((x) => x.dueno === r.id);
      return {
        id: r.id, usuario: r.usuario, nombre: r.nombre || r.usuario, rol: r.rol, creditos: r.creditos ?? 0, activo: r.activo !== false,
        creado: r.creado, por: r.por, ultimoAcceso: r.ultimoAcceso ?? null, padre: r.padre ?? null, padreNombre: r.padre ? (t[r.padre]?.nombre || t[r.padre]?.usuario || null) : null,
        cuentas: suyas.length, activas: suyas.filter((x) => !x.caduca || new Date(x.caduca).getTime() > ahora).length,
        hijos: Object.values(t).filter((x) => x.padre === r.id).length,
      };
    })
    .sort((a, b) => (a.rol === b.rol ? a.usuario.localeCompare(b.usuario) : a.rol === 'super' ? -1 : 1));
}
// Uno que el actor pueda gestionar (por debajo de él; nunca él mismo)
async function gestionable(actor, id) {
  const t = await todos();
  const r = t[String(id ?? '')];
  if (!r) throw error(404, 'Ese revendedor no existe');
  if (!actor.admin && (r.id === actor.id || !subarbol(t, actor.id).has(r.id))) throw error(403, 'Ese revendedor no es tuyo');
  return r;
}

async function crearRevendedor(actor, datos) {
  if (!actor.admin && actor.rol !== 'super') throw error(403, 'Solo los superrevendedores pueden crear revendedores');
  const usuario = usuarioValido(datos.usuario);
  const clave = claveValida(datos.clave);
  const rol = actor.admin && datos.rol === 'super' ? 'super' : 'revendedor';
  const creditos = enteroValido(datos.creditos ?? 0, 0, MAX_CREDITOS, 'Número de créditos');
  const nombre = String(datos.nombre ?? '').trim().slice(0, 40) || usuario;
  return enCola(async () => {
    const t = await todos();
    if (Object.values(t).some((x) => x.usuario === usuario)) throw error(409, `Ya hay un revendedor «${usuario}»`);
    if (!actor.admin) {
      const yo2 = t[actor.id];
      if ((yo2.creditos ?? 0) < creditos) throw error(402, `No tienes créditos suficientes: tienes ${yo2.creditos ?? 0}`);
      yo2.creditos -= creditos;
    }
    const id = randomBytes(8).toString('hex');
    t[id] = { id, usuario, nombre, rol, clave: cifrar(clave), creditos, activo: true, padre: actor.admin ? null : actor.id, creado: new Date().toISOString(), por: actor.usuario, sesiones: [] };
    await guardar(t);
    await movimiento(actor, `crea ${rol === 'super' ? 'el superrevendedor' : 'el revendedor'} ${usuario}`, { creditos: actor.admin ? 0 : -creditos, ...(actor.admin ? {} : { saldo: t[actor.id].creditos }), para: id, paraUsuario: usuario, ...(creditos && { dados: creditos }) });
    return { id, usuario };
  });
}

async function moverCreditos(actor, datos) {
  const cantidad = enteroValido(datos.cantidad, -MAX_CREDITOS, MAX_CREDITOS, 'Número de créditos');
  if (!cantidad) throw error(400, 'Pon cuántos créditos');
  const r = await gestionable(actor, datos.id);
  return enCola(async () => {
    const t = await todos(); const x = t[r.id];
    if (cantidad < 0 && (x.creditos ?? 0) < -cantidad) throw error(409, `${x.usuario} solo tiene ${x.creditos ?? 0} créditos`);
    if (!actor.admin) {
      const yo2 = t[actor.id];
      if (cantidad > 0 && (yo2.creditos ?? 0) < cantidad) throw error(402, `No tienes créditos suficientes: tienes ${yo2.creditos ?? 0}`);
      yo2.creditos = (yo2.creditos ?? 0) - cantidad;
    }
    x.creditos = (x.creditos ?? 0) + cantidad;
    await guardar(t);
    await movimiento(actor, cantidad > 0 ? `da ${cantidad} ${cantidad === 1 ? 'crédito' : 'créditos'} a ${x.usuario}` : `quita ${-cantidad} ${cantidad === -1 ? 'crédito' : 'créditos'} a ${x.usuario}`,
      { creditos: actor.admin ? 0 : -cantidad, ...(actor.admin ? {} : { saldo: t[actor.id].creditos }), para: x.id, paraUsuario: x.usuario, dados: cantidad, saldoPara: x.creditos });
    return { ok: true, creditos: x.creditos };
  });
}

async function claveRevendedor(actor, datos) {
  const r = await gestionable(actor, datos.id);
  const clave = claveValida(datos.clave);
  await enCola(async () => { const t = await todos(); t[r.id].clave = cifrar(clave); t[r.id].sesiones = []; await guardar(t); });
  await movimiento(actor, `cambia la contraseña de ${r.usuario}`, { para: r.id, paraUsuario: r.usuario });
  return { ok: true };
}
async function activarRevendedor(actor, datos) {
  const r = await gestionable(actor, datos.id);
  const activo = Boolean(datos.activo);
  await enCola(async () => { const t = await todos(); t[r.id].activo = activo; if (!activo) t[r.id].sesiones = []; await guardar(t); });
  await movimiento(actor, `${activo ? 'reactiva' : 'suspende'} a ${r.usuario}`, { para: r.id, paraUsuario: r.usuario });
  return { ok: true };
}
// Al borrarlo, sus cuentas y sus revendedores pasan a quien tenía por encima; si tenía créditos
// y estaba debajo de un super, vuelven a ese super
async function borrarRevendedor(actor, datos) {
  const r = await gestionable(actor, datos.id);
  return enCola(async () => {
    const t = await todos(); const x = t[r.id];
    const padre = x.padre && t[x.padre] ? x.padre : null;
    for (const h of Object.values(t)) if (h.padre === x.id) h.padre = padre;
    if (padre && x.creditos) t[padre].creditos = (t[padre].creditos ?? 0) + x.creditos;
    delete t[x.id];
    await guardar(t);
    const cuentas = await emby.reasignar(new Set([x.id]), padre);
    const destino = padre ? t[padre].usuario : 'administración';
    const partes = [cuentas ? `${cuentas === 1 ? 'su cuenta pasa' : `sus ${cuentas} cuentas pasan`} a ${destino}` : '', padre && x.creditos ? `sus ${x.creditos} créditos vuelven a ${destino}` : ''].filter(Boolean);
    await movimiento(actor, `borra a ${x.usuario}${partes.length ? ` (${partes.join('; ')})` : ''}`,
      { para: x.id, paraUsuario: x.usuario, ...(padre === actor.id && x.creditos && { creditos: x.creditos, saldo: t[padre].creditos }) });
    return { ok: true, cuentas };
  });
}

async function movimientos(actor) {
  const lista = (await p.leerAjuste(AJ_MOV)) ?? [];
  const ids = await alcance(actor);
  // «creditos» pasa a ser el efecto en el saldo de quien mira; lo que mueven otros va en «ajeno»
  return lista.filter((m) => !ids || (m.quien && ids.has(m.quien)) || (m.para && ids.has(m.para))).slice(0, 300).map(({ creditos, dados, saldo, saldoPara, ...m }) => {
    if (actor.admin) return { ...m, ajeno: dados ?? creditos ?? 0 };
    if (m.quien === actor.id) return { ...m, creditos: creditos ?? 0, saldo };
    if (m.para === actor.id) return { ...m, creditos: dados ?? 0, saldo: saldoPara };
    return { ...m, ajeno: creditos ?? 0 };
  });
}

// ---------- Rutas de /api/panel/emby (para administradores y revendedores) ----------
// Devuelve { datos, registro } — «registro» es lo que se apunta en el registro del panel (o nada)
export async function atender(ruta, metodo, datos, actor) {
  const r = (d, registro) => ({ datos: d, registro });
  const quien = (n) => String(n ?? '').slice(0, 40);
  if (ruta === '/api/panel/emby' && metodo === 'GET') return r(await resumen(actor));

  // Cuentas de Emby
  if (ruta === '/api/panel/emby/crear') {
    if (actor.admin) { const c = await emby.crear(datos, actor.usuario, datos.dueno && (await todos())[datos.dueno] ? datos.dueno : null); return r(c, `crea la cuenta de Emby ${c.usuario}`); }
    const meses = enteroValido(datos.meses, 1, 12, 'Duración');
    const pantallas = enteroValido(datos.pantallas ?? 1, 1, 4, 'Número de pantallas');
    const coste = meses * COSTE_MES;
    const nombreCuenta = String(datos.usuario ?? '').trim();
    await gastar(actor, coste, `crea la cuenta ${nombreCuenta} (${meses} ${meses === 1 ? 'mes' : 'meses'})`);
    try {
      const c = await emby.crear({ ...datos, pantallas, caduca: new Date(Date.now() + mesesADias(meses) * 864e5).toISOString() }, actor.usuario, actor.id);
      return r({ ...c, coste }, `crea la cuenta de Emby ${c.usuario} (revendedor ${actor.usuario})`);
    } catch (e) { await devolver(actor, coste, `devolución: no se pudo crear ${nombreCuenta}`); throw e; }
  }
  // Demo: gratis, 1 pantalla, unas horas. Usuario y contraseña los genera el gestor (se pueden cambiar)
  if (ruta === '/api/panel/emby/demo') {
    const horas = Number(datos.horas);
    if (!(actor.admin ? DEMO.horasAdmin : DEMO.horasRevendedor).includes(horas)) throw error(400, 'Duración de la demo no válida');
    const caduca = new Date(Date.now() + horas * 3600e3).toISOString();
    const crearla = () => emby.crear({ usuario: datos.usuario, clave: datos.clave, nota: datos.nota, bibliotecas: datos.bibliotecas ?? null, pantallas: 1, descargas: false, caduca },
      actor.usuario, actor.admin ? null : actor.id, { demo: true });
    const texto = `${horas} ${horas === 1 ? 'hora' : 'horas'}`;
    if (actor.admin) { const c = await crearla(); return r({ ...c, caduca }, `crea la demo de Emby ${c.usuario} (${texto})`); }
    // Límites del revendedor: demos activas a la vez y demos en las últimas 24 h (se cuentan aunque las borre)
    return enCola(async () => {
      const ahora = Date.now();
      const activas = Object.values(await emby.extrasEmby()).filter((x) => x.demo && x.dueno === actor.id && x.caduca && new Date(x.caduca).getTime() > ahora).length;
      if (activas >= DEMO.activasMax) throw error(429, `Ya tienes ${activas} demos activas: espera a que caduque alguna (máximo ${DEMO.activasMax} a la vez)`);
      const t = await todos(); const yo2 = t[actor.id];
      if (!yo2) throw error(403, 'Tu cuenta de revendedor ya no existe');
      yo2.demos = (yo2.demos ?? []).filter((f) => ahora - f < 24 * 3600e3);
      if (yo2.demos.length >= DEMO.alDiaMax) throw error(429, `Ya has creado ${yo2.demos.length} demos en las últimas 24 horas (máximo ${DEMO.alDiaMax})`);
      const c = await crearla();
      yo2.demos.push(ahora); await guardar(t);
      await movimiento(actor, `crea la demo ${c.usuario} (${texto})`);
      return r({ ...c, caduca }, `crea la demo de Emby ${c.usuario} (${texto}, revendedor ${actor.usuario})`);
    });
  }
  if (ruta === '/api/panel/emby/renovar') {
    await puedeCuenta(actor, datos.id);
    if (actor.admin) return r(await emby.renovar(datos.id, { dias: datos.dias, ...('fecha' in datos && { fecha: datos.fecha }) }), `renueva la cuenta de Emby ${quien(datos.nombre)}`);
    const meses = enteroValido(datos.meses ?? Math.round(Number(datos.dias) / 30), 1, 12, 'Duración');
    const coste = meses * COSTE_MES;
    await gastar(actor, coste, `renueva ${quien(datos.nombre)} (${meses} ${meses === 1 ? 'mes' : 'meses'})`);
    try { return r({ ...(await emby.renovar(datos.id, { dias: mesesADias(meses) })), coste }, `renueva la cuenta de Emby ${quien(datos.nombre)} (revendedor ${actor.usuario})`); }
    catch (e) { await devolver(actor, coste, `devolución: no se pudo renovar ${quien(datos.nombre)}`); throw e; }
  }
  if (ruta === '/api/panel/emby/editar') {
    await puedeCuenta(actor, datos.id);
    const cambios = { ...(datos.cambios ?? {}) };
    if (!actor.admin) {
      delete cambios.caduca; // la fecha solo se cambia renovando (con créditos)
      if ('pantallas' in cambios) cambios.pantallas = enteroValido(cambios.pantallas, 1, 4, 'Número de pantallas');
    }
    await emby.editar(datos.id, cambios);
    return r({ ok: true }, `cambia la cuenta de Emby ${quien(datos.nombre ?? datos.id)}${actor.admin ? '' : ` (revendedor ${actor.usuario})`}`);
  }
  if (ruta === '/api/panel/emby/clave') {
    await puedeCuenta(actor, datos.id);
    await emby.cambiarClave(datos.id, datos.clave);
    return r({ ok: true }, `cambia la contraseña de la cuenta de Emby ${quien(datos.nombre ?? datos.id)}${actor.admin ? '' : ` (revendedor ${actor.usuario})`}`);
  }
  if (ruta === '/api/panel/emby/activar') {
    await puedeCuenta(actor, datos.id);
    await emby.activar(datos.id, Boolean(datos.activa));
    return r({ ok: true }, `${datos.activa ? 'activa' : 'desactiva'} la cuenta de Emby ${quien(datos.nombre ?? datos.id)}${actor.admin ? '' : ` (revendedor ${actor.usuario})`}`);
  }
  if (ruta === '/api/panel/emby/cortar') { await puedeCuenta(actor, datos.id); return r(await emby.cortar(datos.id)); }
  if (ruta === '/api/panel/emby/borrar') {
    await puedeCuenta(actor, datos.id);
    const b = await emby.borrar(datos.id);
    if (!actor.admin) await movimiento(actor, `borra la cuenta ${b.usuario}`);
    return r(b, `borra la cuenta de Emby ${b.usuario}${actor.admin ? '' : ` (revendedor ${actor.usuario})`}`);
  }
  // Pasar una cuenta a otro revendedor (solo administradores)
  if (ruta === '/api/panel/emby/dueno') {
    if (!actor.admin) throw error(403, 'Solo los administradores pueden cambiar el dueño de una cuenta');
    const t = await todos();
    const a = datos.dueno ? t[String(datos.dueno)] : null;
    if (datos.dueno && !a) throw error(404, 'Ese revendedor no existe');
    await emby.cambiarDueno(datos.id, a ? a.id : null);
    return r({ ok: true }, `pasa la cuenta de Emby ${quien(datos.nombre ?? datos.id)} a ${a ? a.usuario : 'administración'}`);
  }

  // Revendedores
  if (ruta === '/api/panel/emby/revendedores' && metodo === 'GET') {
    if (!actor.admin && actor.rol !== 'super') throw error(403, 'No tienes revendedores');
    return r(await listar(actor));
  }
  if (ruta === '/api/panel/emby/revendedores/crear') { const x = await crearRevendedor(actor, datos); return r(x, `crea el revendedor ${x.usuario}`); }
  if (ruta === '/api/panel/emby/revendedores/creditos') { const x = await moverCreditos(actor, datos); return r(x, `${datos.cantidad > 0 ? 'da' : 'quita'} ${Math.abs(datos.cantidad)} créditos a un revendedor`); }
  if (ruta === '/api/panel/emby/revendedores/clave') return r(await claveRevendedor(actor, datos), 'cambia la contraseña de un revendedor');
  if (ruta === '/api/panel/emby/revendedores/activar') return r(await activarRevendedor(actor, datos), `${datos.activo ? 'reactiva' : 'suspende'} a un revendedor`);
  if (ruta === '/api/panel/emby/revendedores/borrar') return r(await borrarRevendedor(actor, datos), 'borra un revendedor');
  if (ruta === '/api/panel/emby/movimientos' && metodo === 'GET') return r(await movimientos(actor));
  throw error(404, 'No existe');
}
