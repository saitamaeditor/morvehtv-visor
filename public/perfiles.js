// ---------- Cuenta del usuario ----------
// Cada uno entra con su usuario y contraseña (entrar.html) y tiene su «Seguir viendo» y sus
// favoritos, guardados en el servidor: son los mismos en la web, el móvil y la tele.
let yo = null; // { id, usuario, nombre, creado, favoritos: [...], posiciones: {...} }

async function enviar(ruta, datos) {
  const r = await fetch(ruta, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(datos || {}),
  });
  const d = await r.json();
  // La sesión caducó o se cerró desde otro aparato (no confundir con «contraseña actual incorrecta»)
  if (r.status === 401 && d.error === 'Inicia sesión') { location.replace('/entrar.html'); throw new Error(d.error); }
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

async function empezar() {
  // La intro va primero (y fluida): mientras tanto no se dibuja nada
  if (window.morvehIntroFin) { await window.morvehIntroFin; window.morvehIntroFin = null; }
  try {
    yo = await api('/api/yo');
  } catch (e) {
    aviso('No se pudo leer «Seguir viendo» ni los favoritos', 4000);
  }
  // El plan (y con él, si hay anuncios) antes de pintar nada
  if (yo) await cargarPlan();
  pintarBotonCuenta();
  cargar();
  vueltaDelPago();
  ofertaVipAlEntrar();
}

const inicial = (c) => (c.nombre || c.usuario || '?').trim().charAt(0).toUpperCase();

// Botón redondo con la inicial, arriba a la derecha
function pintarBotonCuenta() {
  let b = $('#mi-cuenta');
  if (!b) {
    b = el('button', 'boton');
    b.id = 'mi-cuenta';
    b.title = 'Mi cuenta';
    b.onclick = abrirCuenta;
    $('header').insertBefore(b, $('#salir-app'));
  }
  b.hidden = !yo;
  b.innerHTML = '';
  if (yo) b.append(el('span', 'inicial', inicial(yo)), el('span', 'txt', yo.nombre || yo.usuario));
  if (yo && typeof planInfo !== 'undefined' && planInfo && planInfo.activo && planInfo.plan === 'premium') b.append(el('span', 'insignia', 'VIP'));
}

function campo(etiqueta, tipo, auto) {
  const l = el('label', null, etiqueta);
  const i = el('input');
  i.type = tipo; i.autocomplete = auto; i.maxLength = tipo === 'password' ? 200 : 30;
  l.append(i);
  return { l, i };
}

// Un bloque del panel con su título, sus campos, un botón y su línea de mensaje
function bloque(titulo, texto) {
  const s = el('section', 'cuenta-bloque');
  s.append(el('h3', null, titulo));
  if (texto) s.append(el('p', 'cuenta-texto', texto));
  const msg = el('p', 'cuenta-msg');
  return { s, msg };
}

async function accion(boton, msg, fn, exito) {
  msg.className = 'cuenta-msg'; msg.textContent = '';
  boton.disabled = true;
  try {
    await fn();
    if (exito) { msg.classList.add('bien'); msg.textContent = exito; }
  } catch (e) {
    msg.classList.add('mal'); msg.textContent = e.message;
  }
  boton.disabled = false;
}

function abrirCuenta() {
  if (!yo) return;
  let p = $('#cuenta');
  if (!p) {
    p = el('div');
    p.id = 'cuenta';
    p.onclick = (e) => { if (e.target === p) cerrarCuenta(); };
    document.body.append(p);
  }
  p.innerHTML = '';
  p.hidden = false;
  document.documentElement.classList.add('con-cuenta');
  const caja = el('div', 'cuenta-caja');
  p.append(caja);

  // Cabecera: inicial, nombre, @usuario y desde cuándo
  const cab = el('div', 'cuenta-cab');
  const datos = el('div');
  const desde = yo.creado ? new Date(yo.creado).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  datos.append(el('h2', null, yo.nombre || yo.usuario), el('p', 'cuenta-texto', `@${yo.usuario}${desde ? ` · desde el ${desde}` : ''}`));
  const x = el('button', 'boton cuenta-cerrar', '✕');
  x.title = 'Cerrar';
  x.onclick = cerrarCuenta;
  cab.append(el('div', 'inicial grande', inicial(yo)), datos, x);
  caja.append(cab);

  // Plan: Básico o VIP
  const bp = typeof bloquePlan === 'function' ? bloquePlan() : null;
  if (bp) caja.append(bp);

  // Nombre visible
  const bn = bloque('Nombre', 'Es el que se ve arriba. Tu usuario para entrar no cambia.');
  const n = campo('Nombre', 'text', 'nickname');
  n.i.value = yo.nombre || '';
  const gn = el('button', 'boton', 'Guardar nombre');
  gn.onclick = () => accion(gn, bn.msg, async () => {
    const r = await enviar('/api/cuenta-nombre', { nombre: n.i.value });
    yo.nombre = r.nombre;
    pintarBotonCuenta();
    cab.querySelector('h2').textContent = r.nombre;
    cab.querySelector('.inicial').textContent = inicial(yo);
  }, 'Nombre guardado');
  bn.s.append(n.l, gn, bn.msg);
  caja.append(bn.s);

  // Contraseña
  const bc = bloque('Contraseña', 'Al cambiarla se cierra la sesión en tus otros aparatos.');
  const actualC = campo('Contraseña actual', 'password', 'current-password');
  const nueva = campo('Contraseña nueva (mínimo 8 caracteres)', 'password', 'new-password');
  const otra = campo('Repite la contraseña nueva', 'password', 'new-password');
  const gc = el('button', 'boton', 'Cambiar contraseña');
  gc.onclick = () => accion(gc, bc.msg, async () => {
    if (nueva.i.value.length < 8) throw new Error('La contraseña nueva debe tener al menos 8 caracteres');
    if (nueva.i.value !== otra.i.value) throw new Error('Las contraseñas nuevas no coinciden');
    await enviar('/api/cuenta-clave', { actual: actualC.i.value, nueva: nueva.i.value });
    actualC.i.value = nueva.i.value = otra.i.value = '';
  }, 'Contraseña cambiada');
  bc.s.append(actualC.l, nueva.l, otra.l, gc, bc.msg);
  caja.append(bc.s);

  // Sesiones
  const bs = bloque('Sesiones');
  const todas = el('button', 'boton', 'Cerrar sesión en los demás aparatos');
  todas.onclick = () => accion(todas, bs.msg, () => enviar('/api/cuenta-cerrar-todas'), 'Listo: los demás aparatos tendrán que volver a entrar');
  const salir = el('button', 'boton boton-acento', 'Cerrar sesión');
  salir.onclick = async () => {
    await enviar('/api/salir').catch(() => {});
    location.replace('/entrar.html');
  };
  const filaS = el('div', 'cuenta-botones');
  filaS.append(salir, todas);
  bs.s.append(filaS, bs.msg);
  caja.append(bs.s);

  // Borrar la cuenta
  const bb = bloque('Borrar cuenta', 'Se borran tu cuenta, tus favoritos y lo que tenías a medias. No se puede deshacer.');
  bb.s.classList.add('peligro');
  const cb = campo('Escribe tu contraseña para confirmar', 'password', 'current-password');
  const borrar = el('button', 'boton boton-peligro', 'Borrar mi cuenta');
  borrar.onclick = () => accion(borrar, bb.msg, async () => {
    if (!cb.i.value) throw new Error('Escribe tu contraseña');
    if (!confirm('¿Seguro que quieres borrar tu cuenta? No se puede deshacer.' + (planInfo && planInfo.plan === 'premium' && !planInfo.admin ? ' Perderás el tiempo de VIP que te quede.' : ''))) return;
    await enviar('/api/cuenta-borrar', { actual: cb.i.value });
    location.replace('/entrar.html#registro');
  });
  bb.s.append(cb.l, borrar, bb.msg);
  caja.append(bb.s);

  // Información legal
  const leg = el('p', 'cuenta-legal');
  leg.innerHTML = '<a href="/legal.html#aviso-legal" target="_blank">Aviso legal</a> · <a href="/legal.html#condiciones" target="_blank">Condiciones</a> · <a href="/legal.html#privacidad" target="_blank">Privacidad</a> · <a href="/legal.html#cookies" target="_blank">Cookies</a>';
  caja.append(leg);

  x.focus();
}

function cerrarCuenta() {
  const p = $('#cuenta');
  if (p) { p.hidden = true; p.innerHTML = ''; }
  document.documentElement.classList.remove('con-cuenta');
  const b = $('#mi-cuenta');
  if (b) b.focus();
}

// ---------- Favoritos ----------
const esFavorito = (key) => !!(yo && yo.favoritos.some((f) => f.key === key));

// Pone o quita de favoritos y repinta todos los botones de ese título que haya a la vista
async function alternarFavorito(key, archivo) {
  const si = !esFavorito(key);
  try {
    const r = await enviar('/api/favorito', { key, si, tamano: archivo && archivo.tamano, fecha: archivo && archivo.fecha });
    yo.favoritos = r.favoritos;
  } catch (e) { return aviso('No se pudo guardar en favoritos'); }
  aviso(si ? '★ Añadido a favoritos' : 'Quitado de favoritos');
  document.querySelectorAll('[data-fav]').forEach((b) => b.dataset.fav === key && b.pintarFav());
  if (estado.prefijo === ':favoritos' && actual < 0) pintarVistaPerfil('favoritos');
}

function botonFavorito(key, archivo) {
  const b = el('button', 'boton favorito');
  b.dataset.fav = key;
  b.pintarFav = () => {
    const si = esFavorito(key);
    b.textContent = si ? '★ En favoritos' : '☆ Añadir a favoritos';
    b.classList.toggle('activo', si);
  };
  b.pintarFav();
  b.onclick = () => alternarFavorito(key, archivo);
  return b;
}

// Estrella en la esquina de cada tarjeta (vídeos y carpetas de series)
function estrella(t, key, archivo) {
  if (!yo) return;
  const b = el('button', 'estrella');
  b.dataset.fav = key;
  b.tabIndex = -1; // con el mando se usa el botón de la ficha o el del reproductor
  b.pintarFav = () => {
    const si = esFavorito(key);
    b.textContent = si ? '★' : '☆';
    b.classList.toggle('activo', si);
    b.title = si ? 'Quitar de favoritos' : 'Añadir a favoritos';
  };
  b.pintarFav();
  b.onclick = (e) => { e.stopPropagation(); alternarFavorito(key, archivo); };
  t.append(b);
}

// Botón ☆ en la barra de arriba del reproductor
function pintarFavVisor(f) {
  const b = $('#vfav');
  b.hidden = !yo;
  if (!yo) return;
  b.dataset.fav = f.key;
  b.pintarFav = () => {
    const si = esFavorito(f.key);
    b.textContent = si ? '★' : '☆';
    b.classList.toggle('activo', si);
    b.title = si ? 'Quitar de favoritos' : 'Añadir a favoritos';
  };
  b.pintarFav();
  b.onclick = () => alternarFavorito(f.key, f);
}

// ---------- Pestañas «Seguir viendo» y «Favoritos» ----------
const VISTAS_PERFIL = {
  seguir: { titulo: '▶ Seguir viendo', corto: '▶ Seguir viendo' },
  favoritos: { titulo: '★ Favoritos', corto: '★ Favoritos' },
};

function pintarPestanas() {
  let nav = $('#pestanas');
  if (!nav) {
    nav = el('nav');
    nav.id = 'pestanas';
    const inicio = el('button', 'pestana', '⌂ Inicio');
    inicio.dataset.vista = '';
    inicio.onclick = () => irA('');
    nav.append(inicio);
    for (const [id, v] of Object.entries(VISTAS_PERFIL)) {
      const b = el('button', 'pestana', v.corto);
      b.dataset.vista = id;
      b.onclick = () => irA(estado.prefijo === `:${id}` ? '' : `:${id}`);
      nav.append(b);
    }
    $('#directo').after(nav);
  }
  nav.hidden = !yo;
  nav.querySelectorAll('button').forEach((b) => b.classList.toggle('activa',
    b.dataset.vista ? estado.prefijo === `:${b.dataset.vista}` : !estado.prefijo));
}

function pintarVistaPerfil(vista) {
  const items = $('#items');
  items.className = 'rejilla';
  items.innerHTML = '';
  if (!yo) return;
  if (vista === 'seguir') {
    const lista = listaSeguir();
    if (!lista.length) items.innerHTML = `<div class="vacio">Aquí aparecerá lo que empieces a ver, ${yo.nombre}.</div>`;
    lista.forEach((f, i) => items.append(tarjetaPerfil(f, () => abrir(i, lista))));
  } else {
    const archivos = yo.favoritos.filter((f) => f.tipo === 'archivo');
    if (!yo.favoritos.length) items.innerHTML = '<div class="vacio">Aún no tienes favoritos. Pulsa ☆ en cualquier título para añadirlo.</div>';
    for (const f of yo.favoritos) {
      items.append(f.tipo === 'carpeta'
        ? tarjetaPerfil(f, () => irA(f.key), true)
        : tarjetaPerfil(f, () => abrir(archivos.indexOf(f), archivos)));
    }
  }
  const conMando = esTele || document.documentElement.classList.contains('usa-mando');
  if (conMando && actual < 0) { const p = $('#items .item') || $('#pestanas .activa'); if (p) p.focus(); }
}

// Lo que el perfil dejó a medias, lo último primero
function listaSeguir() {
  if (!yo) return [];
  return Object.keys(yo.posiciones)
    .map((key) => Object.assign({ key }, yo.posiciones[key]))
    .filter((p) => p.t > 0)
    .sort((a, b) => b.cuando - a.cuando)
    .map((p) => ({ key: p.key, tamano: p.tamano, fecha: p.fecha }));
}

// «ancha»: con la imagen apaisada (fondo de la película o imagen del episodio), como en la
// fila «Seguir viendo» del inicio
function tarjetaPerfil(f, alPulsar, carpeta, ancha) {
  const [, , icono] = tipo(f.key);
  const t = tarjeta({ icono: carpeta ? '📁' : icono, titulo: nombre(f.key), meta: carpeta ? 'Serie' : (f.tamano ? bytes(f.tamano) : ''), alPulsar });
  t.classList.add('de-perfil');
  if (!carpeta) { t.dataset.key = f.key; if (f.tamano) t.dataset.tamano = f.tamano; barraVisto(t); }
  conMeta(t, carpeta ? 'carpeta' : 'archivo', f.key, { ancha });
  estrella(t, f.key, carpeta ? null : f);
  return t;
}

// ---------- Planes: Básico (con anuncios) y VIP (sin anuncios) ----------
// El servidor dice el plan de la cuenta, el precio y, solo al plan Básico, qué anuncios poner.
// Se paga con USDC (red Base); en cuanto llega el pago, VIP se activa al momento y el servidor avisa a todas las
// pestañas y aparatos abiertos de la cuenta (evento «plan») para quitar los anuncios ya.
let planInfo = null; // { activo, plan, hasta, cancelado, precio, anuncios }
const enApp = () => !!window.MorvehApp;

async function cargarPlan() {
  try { planInfo = await api('/api/pago/info'); } catch (e) { planInfo = null; }
  // Sin pagos no hay planes: nadie lleva la marca de VIP
  document.documentElement.classList.toggle('premium', !!(planInfo && planInfo.activo && planInfo.plan === 'premium'));
  pintarBotonCuenta();
  avisoRenovar();
  return planInfo;
}
// Recordatorio de renovación (una vez al día por aparato): en el último mes de VIP y cuando
// ya ha terminado
function avisoRenovar() {
  if (!planInfo || !planInfo.activo || planInfo.admin) return;
  let t = null;
  if (planInfo.plan === 'premium' && planInfo.puedeRenovar) {
    const dias = Math.ceil((planInfo.hasta - Date.now()) / 864e5);
    t = `⭐ Tu VIP termina en ${dias} ${dias === 1 ? 'día' : 'días'}. Renuévalo en «Mi cuenta» para seguir sin anuncios.`;
  } else if (planInfo.plan !== 'premium' && planInfo.vencio) {
    t = '⭐ Tu VIP ha terminado. Renuévalo en «Mi cuenta» para volver a verlo todo sin anuncios.';
  }
  if (!t) return;
  const hoy = new Date().toISOString().slice(0, 10);
  try { if (localStorage.getItem('morvehtv-aviso-renovar') === hoy) return; localStorage.setItem('morvehtv-aviso-renovar', hoy); } catch (e) {}
  setTimeout(() => aviso(t, 7000), 2500);
}
const conAnuncios = () => !!(planInfo && planInfo.plan !== 'premium' && planInfo.anuncios);

// El plan ha cambiado (pago, cancelación, aviso de otro aparato): se repinta sin anuncios (o con)
async function planCambiado(avisar) {
  const antes = planInfo && planInfo.plan;
  await cargarPlan();
  const ahora = planInfo && planInfo.plan;
  if (antes === ahora && !avisar) return;
  document.querySelectorAll('.anuncio, .anuncio-previo').forEach((x) => { if (ahora === 'premium') x.remove(); });
  if (ahora === 'premium' && antes !== 'premium') aviso('⭐ ¡Ya eres VIP! Sin anuncios en la web y la app', 5000);
  if (document.documentElement.classList.contains('con-cuenta')) abrirCuenta();
  if (actual < 0) cargar();
}
// Al volver a la app (estaba en segundo plano mientras se pagaba) se mira el plan otra vez
document.addEventListener('visibilitychange', () => { if (!document.hidden && yo) planCambiado(false); });

// (VIP con USDC no sale de la web: no hay vuelta de ninguna página de pago)
function vueltaDelPago() {}

const azar = (lista) => lista[Math.floor(Math.random() * lista.length)];

// Banner (apagado: solo hay anuncios antes de reproducir)
function contenidoBanner() {
  const conImagen = (planInfo.anuncios.propios || []).filter((x) => x.imagen || x.titulo);
  return conImagen.length ? tarjetaAnuncio(azar(conImagen)) : null;
}
function tarjetaAnuncio(x) {
  const c = el(x.enlace ? 'a' : 'div', 'anuncio-propio');
  if (x.enlace) { c.href = x.enlace; c.target = '_blank'; c.rel = 'sponsored noopener'; }
  if (x.imagen) { const im = el('img'); im.src = x.imagen; im.alt = x.titulo || ''; im.loading = 'lazy'; c.append(im); }
  const t = el('div', 'texto');
  if (x.titulo) t.append(el('b', null, x.titulo));
  if (x.texto) t.append(el('span', null, x.texto));
  c.append(t);
  return c;
}
function promoVIP(conBoton) {
  if (!planInfo.activo) return null;
  const c = el('div', 'anuncio-propio promo');
  const t = el('div', 'texto');
  t.append(el('b', null, '⭐ MorvehTV VIP'), el('span', null, 'Todo sin anuncios en la web y la app' + (planInfo.precio ? ' por ' + planInfo.precio : '') + '.'));
  c.append(t);
  if (conBoton) {
    const b = el('button', 'boton boton-acento', 'Quitar anuncios');
    b.onclick = (e) => { e.stopPropagation(); abrirCuenta(); };
    c.append(b);
  }
  return c;
}

function anuncioBanner(donde) {
  // Banners en la portada y las carpetas: solo si están activados (ANUNCIOS_BANNERS=1)
  if (!conAnuncios() || !planInfo.anuncios.banners) return null;
  const contenido = contenidoBanner();
  if (!contenido) return null;
  const caja = el('aside', 'anuncio anuncio-' + donde);
  caja.append(el('small', 'etiqueta-anuncio', 'Anuncio'), contenido);
  return caja;
}

// ---------- Anuncios antes de reproducir (plan Básico) ----------
// Antes de cada vídeo, en la web y en la app, uno o varios anuncios en vídeo (VAST) de las redes
// externas que diga el servidor (nunca de Google ni propios). Se saltan cuando la red lo permite
// o, si no lo dice, a los ANUNCIOS_SALTAR segundos. Si ninguna red tiene anuncio, el vídeo empieza
// sin más. Devuelve una promesa que se cumple cuando hay que empezar el vídeo.
const SALTAR_EN = 5;
let ultimoPrevio = 0;
let marcaAnuncio = 'Anuncio';

// El botón «Saltar anuncio»: grande, encima del anuncio (abajo a la derecha), con la cuenta
// atrás dentro y el foco puesto desde el principio, así funciona igual con el dedo, el ratón, el
// teclado (Intro o Espacio) y el OK del mando de la tele. Mientras cuenta no hace nada (pero se
// puede enfocar: un botón «disabled» no recibe el foco del mando); al llegar a 0 se ilumina.
function botonSaltar() {
  const b = el('button', 'saltar-anuncio');
  b.type = 'button';
  b.setAttribute('aria-live', 'polite');
  b.setAttribute('aria-disabled', 'true');
  b.innerHTML = '<span class="saltar-texto"></span><span class="saltar-icono" aria-hidden="true">⏭</span>';
  b._listo = false;
  b.pintar = (texto, listo) => {
    b._listo = !!listo;
    b.querySelector('.saltar-texto').textContent = texto;
    b.setAttribute('aria-disabled', listo ? 'false' : 'true');
    b.classList.toggle('listo', !!listo);
  };
  b.addEventListener('click', (e) => { if (!b._listo) { e.preventDefault(); e.stopImmediatePropagation(); b.classList.remove('aviso'); void b.offsetWidth; b.classList.add('aviso'); } }, true);
  return b;
}

function capaAnuncio() {
  const capa = el('div', 'anuncio-previo');
  capa.setAttribute('role', 'dialog');
  capa.setAttribute('aria-label', marcaAnuncio);
  const caja = el('div', 'caja');
  const arriba = el('div', 'arriba');
  const etiqueta = el('small', 'etiqueta-anuncio', marcaAnuncio);
  arriba.append(etiqueta);
  const escena = el('div', 'escena');
  const pie = el('div', 'pie');
  const saltar = botonSaltar();
  saltar.pintar('Saltar en ' + SALTAR_EN + ' s', false);
  escena.append(saltar);
  if (planInfo.activo) {
    const pr = el('button', 'boton', '⭐ Sin anuncios' + (planInfo.precio ? ' · ' + planInfo.precio : ''));
    pr.onclick = () => { capa._fin(); cerrar(); abrirCuenta(); };
    pie.append(pr);
  }
  caja.append(arriba, escena, pie);
  capa.append(caja);
  // Foco en «Saltar» desde el principio (mando y teclado)
  setTimeout(() => { if (capa.isConnected) saltar.focus(); }, 50);
  return { capa, escena, saltar, etiqueta, arriba, pie };
}

function cuentaAtras(c, terminar, segundos = SALTAR_EN) {
  let s = Math.max(1, Math.round(segundos));
  c.saltar.pintar('Saltar en ' + s + ' s', false);
  const reloj = setInterval(() => {
    if (!$('#visor').classList.contains('abierto')) return terminar();
    if (--s > 0) { c.saltar.pintar('Saltar en ' + s + ' s', false); return; }
    clearInterval(reloj);
    c.saltar.pintar('Saltar anuncio', true);
    c.saltar.focus();
  }, 1000);
  return () => clearInterval(reloj);
}

const barajar = (l) => l.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
// ---------- Bloqueadores de anuncios ----------
// La web es gratis gracias a los anuncios: con un bloqueador activo no se reproduce. Se mira de
// tres formas: un «cebo» con aspecto de anuncio que los bloqueadores esconden, un archivo con
// nombre de anuncio (/ads.js) que no dejan cargar y el script de la red de anuncios (lo frenan
// los bloqueadores del navegador y los de DNS, como AdGuard o el «DNS privado» del móvil).
async function hayBloqueador() {
  const cebo = el('div', 'adsbox ad-banner ad-placement pub_300x250 text-ad textads banner-ads');
  cebo.innerHTML = '&nbsp;';
  cebo.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:250px;';
  document.body.append(cebo);
  const sondas = [
    fetch('/ads.js?' + Date.now(), { cache: 'no-store', credentials: 'same-origin' }).then((r) => !r.ok, () => true),
  ];
  const s = planInfo.anuncios && planInfo.anuncios.sonda;
  if (s) sondas.push(fetch(s, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'origin' }).then(() => false, () => true));
  await new Promise((r) => setTimeout(r, 150));
  const escondido = !cebo.isConnected || cebo.offsetHeight === 0 || cebo.offsetParent === null || getComputedStyle(cebo).display === 'none' || getComputedStyle(cebo).visibility === 'hidden';
  cebo.remove();
  const bloqueos = await Promise.all(sondas.map((p) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), 5000))])));
  return escondido || bloqueos.some(Boolean);
}

// Pantalla «Desactiva el bloqueador o hazte VIP». Devuelve 'reintentar', 'vip' o 'cerrado'.
function muroBloqueador() {
  return new Promise((listo) => {
    const capa = el('div', 'anuncio-previo muro-bloqueo');
    capa.setAttribute('role', 'dialog');
    capa.setAttribute('aria-label', 'Bloqueador de anuncios');
    const caja = el('div', 'caja');
    const t = el('div', 'muro-texto');
    t.innerHTML = '<b>🛑 Tienes un bloqueador de anuncios</b>'
      + '<span>MorvehTV es gratis gracias a un anuncio corto antes de cada vídeo. Desactiva el bloqueador para esta web (o el DNS que bloquea anuncios) y pulsa «Ya lo he desactivado».</span>'
      + (planInfo.activo ? `<span>O hazte <b>VIP</b>${planInfo.precio ? ' por ' + planInfo.precio : ''} y míralo todo sin anuncios.</span>` : '');
    const pie = el('div', 'pie');
    const otra = el('button', 'boton', '🔄 Ya lo he desactivado');
    pie.append(otra);
    if (planInfo.activo) {
      const vip = el('button', 'boton boton-acento', '⭐ Hazte VIP');
      vip.onclick = () => fin('vip');
      pie.append(vip);
    }
    caja.append(t, pie);
    capa.append(caja);
    let hecho = false;
    const vigia = setInterval(() => { if (!$('#visor').classList.contains('abierto')) fin('cerrado'); }, 500);
    function fin(r) {
      if (hecho) return; hecho = true;
      clearInterval(vigia); capa.remove();
      if (r === 'vip') { cerrar(); abrirCuenta(); }
      listo(r);
    }
    capa._fin = () => fin('cerrado');
    otra.onclick = () => fin('reintentar');
    $('#visor').append(capa);
    setTimeout(() => { if (capa.isConnected) otra.focus(); }, 50);
  });
}

async function anuncioPrevio() {
  if (!conAnuncios()) return;
  // Con bloqueador no hay vídeo: o lo quita, o se hace VIP, o cierra
  while (await hayBloqueador()) {
    if (!$('#visor').classList.contains('abierto')) return;
    const r = await muroBloqueador();
    if (r !== 'reintentar') { if ($('#visor').classList.contains('abierto')) cerrar(); return; }
    // (al volver a mirar, «Ya lo he desactivado» suele necesitar recargar el bloqueador: se da un respiro)
    await new Promise((ok) => setTimeout(ok, 300));
  }
  const conf = planInfo.anuncios.previos || { cantidad: 3, esperaMin: 0 };
  if (Date.now() - ultimoPrevio < conf.esperaMin * 60000) return;
  ultimoPrevio = Date.now();
  await tandaAnuncios(conf.cantidad, 'Anuncio');
}

// Una tanda de «cantidad» anuncios seguidos; «nombre» es lo que pone la etiqueta («Anuncio»,
// «Pausa publicitaria»…). Devuelve cuando han acabado (o se cerró el vídeo).
async function tandaAnuncios(cantidad, nombre) {
  const etiquetas = planInfo.anuncios.vast || [];
  for (let n = 0; n < cantidad; n++) {
    let salio = false;
    // Si una red no tiene anuncio para este usuario, se prueba la siguiente
    for (const etiqueta of etiquetas) {
      // Si se cerró el vídeo, no siguen los anuncios
      if (!$('#visor').classList.contains('abierto')) { marcaAnuncio = 'Anuncio'; return; }
      marcaAnuncio = cantidad > 1 ? `${nombre} · ${n + 1} de ${cantidad}` : nombre;
      if (await anuncioVast(etiqueta)) { salio = true; break; }
    }
    // Ninguna red dio vídeo: el banner de la pantalla previa
    if (!salio && planInfo.anuncios.banner && $('#visor').classList.contains('abierto')) {
      marcaAnuncio = cantidad > 1 ? `${nombre} · ${n + 1} de ${cantidad}` : nombre;
      salio = await anuncioBannerPrevio(planInfo.anuncios.banner);
    }
    if (!salio) break;
  }
  marcaAnuncio = 'Anuncio';
}

// El banner de la red externa (p. ej. Adsterra 300x250) en la pantalla previa, con la cuenta
// atrás de «Saltar». Va en un marco aislado (sandbox, sin acceso a la web ni a la sesión): solo
// puede abrir la web del anunciante en otra pestaña al tocarlo. Si la red no da anuncio, el
// vídeo empieza sin esperar. Devuelve true si se mostró.
function anuncioBannerPrevio(b) {
  return new Promise((listo) => {
    const c = capaAnuncio();
    c.escena.classList.add('sin-video', 'con-banner');
    const fr = el('iframe', 'marco-previo');
    fr.title = 'Anuncio';
    fr.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    fr.setAttribute('scrolling', 'no');
    fr.width = b.ancho; fr.height = b.alto;
    fr.style.setProperty('--ancho', b.ancho + 'px'); fr.style.setProperty('--alto', b.alto + 'px');
    fr.src = '/marco-previo.html';
    c.escena.insertBefore(fr, c.saltar);
    let hecho = false;
    let vacio = false;
    let listoBanner = false;
    const alMensaje = (e) => {
      if (e.source !== fr.contentWindow) return;
      if (e.data === 'morvehtv-previo-listo') listoBanner = true;
      if (e.data === 'morvehtv-previo-vacio') { vacio = true; terminar(); }
    };
    // Si un bloqueador quita el marco o la red no pinta nada en 4 s, no se espera más
    const sinRespuesta = setTimeout(() => { if (!listoBanner) { vacio = true; terminar(); } }, 4000);
    window.addEventListener('message', alMensaje);
    const parar = cuentaAtras(c, () => terminar(), planInfo.anuncios.saltarEn || SALTAR_EN);
    function terminar() {
      if (hecho) return; hecho = true;
      parar(); clearTimeout(sinRespuesta); window.removeEventListener('message', alMensaje);
      c.capa.remove(); listo(!vacio);
    }
    c.capa._fin = terminar;
    c.saltar.onclick = () => { if (c.saltar._listo) terminar(); };
    $('#visor').append(c.capa);
  });
}

// Uno de tus vídeos de anuncio
function anuncioVideo(x) {
  return new Promise((listo) => {
    const c = capaAnuncio();
    const v = el('video');
    v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto'; v.src = x.video;
    c.escena.append(v);
    const resto = el('span', 'resto');
    c.arriba.append(resto);
    if (x.enlace) {
      const mas = el('a', 'boton', 'Más información ↗');
      mas.href = x.enlace; mas.target = '_blank'; mas.rel = 'sponsored noopener';
      c.pie.insertBefore(mas, c.pie.firstChild);
    }
    // Sin sonido no arranca en algunos móviles: entonces se pone en silencio con un botón para activarlo
    const sonido = el('button', 'boton sonido-anuncio', '🔇 Activar sonido');
    sonido.hidden = true;
    sonido.onclick = () => { v.muted = false; sonido.hidden = true; };
    c.arriba.append(sonido);
    v.ontimeupdate = () => { if (v.duration) resto.textContent = ' · ' + Math.max(0, Math.ceil(v.duration - v.currentTime)) + ' s'; };
    let hecho = false;
    const parar = cuentaAtras(c, () => terminar());
    function terminar() { if (hecho) return; hecho = true; parar(); v.pause(); v.removeAttribute('src'); c.capa.remove(); listo(); }
    c.capa._fin = terminar;
    c.saltar.onclick = terminar;
    v.onended = terminar;
    v.onerror = terminar; // si el anuncio no carga, no se queda nadie esperando
    $('#visor').append(c.capa);
    v.play().catch(() => { v.muted = true; sonido.hidden = false; v.play().catch(terminar); });
    // Por si el vídeo se queda colgado
    setTimeout(() => { if (!hecho && v.currentTime === 0) terminar(); }, 15000);
  });
}

// Un anuncio con imagen (o, sin «x», el aviso de VIP) durante 5 s
function anuncioImagen(x) {
  const contenido = x ? tarjetaAnuncio(x) : promoVIP(false);
  if (!contenido) return Promise.resolve();
  return new Promise((listo) => {
    const c = capaAnuncio();
    // (en los de imagen el botón va debajo del anuncio, no encima, para no tapar el texto)
    c.escena.classList.add('sin-video');
    c.escena.insertBefore(contenido, c.saltar);
    let hecho = false;
    const parar = cuentaAtras(c, () => terminar());
    function terminar() { if (hecho) return; hecho = true; parar(); c.capa.remove(); listo(); }
    c.capa._fin = terminar;
    c.saltar.onclick = terminar;
    $('#visor').append(c.capa);
  });
}

// ---------- Anuncio en vídeo VAST (redes externas, sin SDK de nadie) ----------
// Se lee el XML VAST de la red aquí mismo (siguiendo sus «Wrapper», hasta 5), se elige el MP4 o
// WebM que mejor va y se reproduce en nuestro propio reproductor, con nuestro botón «Saltar» (que
// funciona con el dedo, el ratón y el mando de la tele, también en la app). Se avisan a la red
// las impresiones, los cuartiles, el clic, el salto y los errores, como pide VAST.
const SEG_VAST = (t) => { const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(t || '').trim()); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
function macrosVast(u, extra = {}) {
  const azarNum = String(Math.floor(Math.random() * 1e10));
  const valores = { CACHEBUSTING: azarNum, CACHEBUSTER: azarNum, RANDOM: azarNum, TIMESTAMP: new Date().toISOString(),
    PAGEURL: location.origin + '/', PAGE_URL: location.origin + '/', REFERRER_URL: location.origin + '/', DOMAIN: location.hostname,
    WIDTH: String(Math.round(innerWidth)), HEIGHT: String(Math.round(innerHeight)), ...extra };
  return String(u).trim()
    .replace(/\[([A-Z_]+)\]/g, (m, k) => (k in valores ? encodeURIComponent(valores[k]) : m))
    .replace(/%%CACHEBUSTER%%|\{cachebuster\}|\{random\}/gi, azarNum)
    .replace(/\{timestamp\}/gi, String(Date.now()));
}
// Avisos a la red (píxeles): sin cookies ni datos nuestros, solo la dirección que dio la red
function pixelVast(urls, extra) {
  (urls || []).forEach((u) => { try { const i = new Image(); i.referrerPolicy = 'origin'; i.src = macrosVast(u, extra); } catch (e) {} });
}
const textosVast = (raiz, sel) => [...raiz.querySelectorAll(sel)].map((n) => n.textContent.trim()).filter((t) => /^https?:\/\//.test(t));

async function leerVast(url, nivel = 0, acum = { impresiones: [], errores: [], eventos: {}, clics: [] }) {
  if (nivel > 5) throw Object.assign(new Error('Demasiados saltos'), { codigo: 302 });
  const ctl = new AbortController();
  const reloj = setTimeout(() => ctl.abort(), 6000);
  let texto;
  try {
    const r = await fetch(macrosVast(url), { credentials: 'omit', signal: ctl.signal, referrerPolicy: 'origin' });
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { codigo: 301 });
    texto = await r.text();
  } finally { clearTimeout(reloj); }
  const xml = new DOMParser().parseFromString(texto, 'text/xml');
  if (xml.querySelector('parsererror')) throw Object.assign(new Error('XML'), { codigo: 100 });
  acum.errores.push(...textosVast(xml, 'VAST > Error'));
  const ad = [...xml.querySelectorAll('VAST > Ad')].find((x) => x.querySelector('InLine, Wrapper'));
  if (!ad) throw Object.assign(new Error('Sin anuncio'), { codigo: 303 });
  acum.impresiones.push(...textosVast(ad, 'Impression'));
  acum.errores.push(...textosVast(ad, ':scope > * > Error'));
  ad.querySelectorAll('Linear TrackingEvents Tracking').forEach((t) => {
    const ev = t.getAttribute('event'); const u = t.textContent.trim();
    if (ev && /^https?:\/\//.test(u)) (acum.eventos[ev] = acum.eventos[ev] || []).push(u);
  });
  acum.clics.push(...textosVast(ad, 'Linear VideoClicks ClickTracking'));
  const wrapper = ad.querySelector('Wrapper');
  if (wrapper) {
    const sig = textosVast(wrapper, 'VASTAdTagURI')[0];
    if (!sig) throw Object.assign(new Error('Wrapper vacío'), { codigo: 303 });
    return leerVast(sig, nivel + 1, acum);
  }
  const lineal = ad.querySelector('InLine Creative Linear');
  if (!lineal) throw Object.assign(new Error('Sin vídeo'), { codigo: 201 });
  // Solo vídeo de verdad (MP4/WebM): ni VPAID (código de la red) ni streaming
  const prueba = document.createElement('video');
  const medios = [...lineal.querySelectorAll('MediaFile')].map((m) => ({
    url: m.textContent.trim(), tipo: (m.getAttribute('type') || '').toLowerCase(), ancho: +m.getAttribute('width') || 0,
    entrega: (m.getAttribute('delivery') || 'progressive').toLowerCase(), api: m.getAttribute('apiFramework'),
  })).filter((m) => /^https:\/\//.test(m.url) && /^video\/(mp4|webm)$/.test(m.tipo) && m.entrega === 'progressive' && !m.api && prueba.canPlayType(m.tipo));
  if (!medios.length) throw Object.assign(new Error('Sin vídeo compatible'), { codigo: 403 });
  // El más cercano al ancho de la pantalla (sin pasarse mucho: ahorra datos en el móvil)
  const quiero = Math.min(1920, innerWidth * (devicePixelRatio || 1));
  medios.sort((x, y) => Math.abs(x.ancho - quiero) - Math.abs(y.ancho - quiero));
  const duracion = SEG_VAST(lineal.querySelector('Duration')?.textContent);
  const so = lineal.getAttribute('skipoffset');
  let saltarEn = null;
  if (so) saltarEn = /%$/.test(so) ? (duracion ? duracion * parseFloat(so) / 100 : null) : SEG_VAST(so);
  const clic = textosVast(lineal, 'VideoClicks ClickThrough')[0] || null;
  return { ...acum, video: medios[0].url, duracion, saltarEn, clic };
}

// Devuelve true si se vio el anuncio (aunque se saltara); false si no hubo anuncio
function anuncioVast(etiqueta) {
  return new Promise((listo) => {
    let hecho = false;
    let mostrado = false;
    let datos = null;
    // (lo que se va leyendo, para avisar de errores aunque el VAST falle a medias)
    const acum = { impresiones: [], errores: [], eventos: {}, clics: [] };
    const c = capaAnuncio();
    c.saltar.pintar('Cargando anuncio…', false);
    const v = el('video'); v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    c.escena.append(v);
    const resto = el('span', 'resto');
    c.arriba.append(resto);
    const sonido = el('button', 'boton sonido-anuncio', '🔇 Activar sonido');
    sonido.hidden = true;
    sonido.onclick = () => { v.muted = false; sonido.hidden = true; if (datos) pixelVast(datos.eventos.unmute); };
    c.arriba.append(sonido);
    let reloj = null;
    function terminar() {
      if (hecho) return; hecho = true;
      clearInterval(reloj); clearTimeout(limite);
      v.pause(); v.removeAttribute('src'); v.load();
      c.capa.remove(); listo(mostrado);
    }
    function fallo(codigo) {
      pixelVast(acum.errores, { ERRORCODE: String(codigo || 900) });
      terminar();
    }
    c.capa._fin = terminar;
    $('#visor').append(c.capa);
    // Si la red tarda o el vídeo no arranca, no se queda nadie esperando
    const limite = setTimeout(() => { if (!mostrado) fallo(402); }, 12000);
    leerVast(etiqueta, 0, acum).then((d) => {
      if (hecho) return;
      datos = d;
      const saltarEn = d.saltarEn != null ? d.saltarEn : (planInfo.anuncios.saltarEn ?? SALTAR_EN);
      const dados = new Set();
      const evento = (n) => { if (!dados.has(n)) { dados.add(n); pixelVast(d.eventos[n]); } };
      v.onplaying = () => {
        if (mostrado) return;
        mostrado = true; clearTimeout(limite);
        pixelVast(d.impresiones); evento('creativeView'); evento('start');
      };
      v.ontimeupdate = () => {
        const tot = v.duration || d.duracion || 0;
        const t = v.currentTime;
        if (tot) {
          resto.textContent = ' · ' + Math.max(0, Math.ceil(tot - t)) + ' s';
          if (t >= tot / 4) evento('firstQuartile');
          if (t >= tot / 2) evento('midpoint');
          if (t >= tot * 3 / 4) evento('thirdQuartile');
        }
        if (saltarEn > 0 && (!tot || saltarEn < tot - 1)) {
          if (t >= saltarEn) { if (!c.saltar._listo) { c.saltar.pintar('Saltar anuncio', true); c.saltar.focus(); } }
          else c.saltar.pintar('Saltar en ' + Math.ceil(saltarEn - t) + ' s', false);
        } else c.saltar.pintar(tot ? `El anuncio acaba en ${Math.max(0, Math.ceil(tot - t))} s` : 'Anuncio', false);
      };
      v.onended = () => { evento('complete'); terminar(); };
      v.onerror = () => fallo(405);
      v.onpause = () => { if (mostrado && !v.ended && !hecho) evento('pause'); };
      c.saltar.onclick = () => { if (c.saltar._listo) { evento('skip'); terminar(); } };
      // Al tocar el anuncio (o «Más información») se abre la web del anunciante en otra pestaña
      // (en la app, en el navegador del móvil)
      if (d.clic) {
        const abrirClic = () => { pixelVast(d.clics); window.open(d.clic, '_blank', 'noopener'); };
        const mas = el('button', 'boton', 'Más información ↗');
        mas.onclick = abrirClic;
        c.pie.insertBefore(mas, c.pie.firstChild);
        v.style.cursor = 'pointer';
        v.onclick = abrirClic;
      }
      v.src = d.video;
      v.play().catch(() => { v.muted = true; sonido.hidden = false; pixelVast(d.eventos.mute); v.play().catch(() => fallo(400)); });
      // Si se queda colgado sin avanzar
      reloj = setInterval(() => { if (!$('#visor').classList.contains('abierto')) terminar(); }, 1000);
    }).catch((e) => fallo(e && e.codigo));
  });
}

// ---------- Anuncios durante el vídeo y al pausar (plan Básico) ----------
// Durante: una pausa publicitaria cada «cadaMin» minutos de vídeo visto (nunca en los primeros
// 5 minutos ni en los 3 últimos; si empiezas a mitad, cuenta desde donde empiezas). Se para el
// vídeo, sale la tanda y sigue solo donde estaba.
// En la pausa: un anuncio pequeño en una esquina, que se cierra con ✕ y se va al seguir.
function anunciosDelReproductor(caja) {
  if (!conAnuncios()) return;
  const a = planInfo.anuncios;
  const v = caja.querySelector('video');
  if (!v) return;
  let enAnuncio = false;
  const cada = (a.durante && a.durante.cadaMin) || 0;
  let siguiente = null;
  if (cada > 0) {
    caja.alTiempo = async (t, total) => {
      if (enAnuncio || v.paused || !caja.isConnected) return;
      if (siguiente === null) siguiente = Math.max(t, 0) + cada * 60;
      if (t < siguiente) return;
      siguiente = t + cada * 60;
      if (t < 300 || (total && total - t < 180)) return; // ni al principio ni casi al final
      enAnuncio = true;
      quitarPausa();
      v.pause();
      await tandaAnuncios((a.durante && a.durante.cantidad) || 1, 'Pausa publicitaria');
      enAnuncio = false;
      if (caja.isConnected && $('#visor').classList.contains('abierto')) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
    };
  }
  // Anuncio en la pausa
  let tarjetaPausa = null;
  function quitarPausa() { if (tarjetaPausa) { tarjetaPausa.remove(); tarjetaPausa = null; } }
  if (a.pausa !== false) {
    caja.alPausar = () => {
      setTimeout(() => {
        if (enAnuncio || !v.paused || v.ended || v.seeking || tarjetaPausa || !caja.isConnected || v.currentTime < 2) return;
        const conImagen = (a.propios || []).filter((x) => !x.video && (x.imagen || x.titulo));
        const contenido = conImagen.length ? tarjetaAnuncio(azar(conImagen)) : promoVIP(true);
        if (!contenido) return;
        tarjetaPausa = el('aside', 'anuncio-pausa');
        const cab = el('div', 'anuncio-pausa-cab');
        const x = el('button', 'cerrar-anuncio', '✕');
        x.setAttribute('aria-label', 'Cerrar el anuncio');
        x.onclick = (e) => { e.stopPropagation(); quitarPausa(); };
        cab.append(el('small', 'etiqueta-anuncio', 'Anuncio'), x);
        tarjetaPausa.append(cab, contenido);
        caja.append(tarjetaPausa);
      }, 700);
    };
    caja.alSeguir = quitarPausa;
  }
}

// ---------- VIP con USDC (red Base) ----------
// Se paga una sola vez por un tiempo (sin suscripción): se elige cuánto, se envía el importe
// exacto a la dirección y el servidor lo ve en la blockchain y activa VIP solo.
function fechaLarga(ms) { return new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }); }
function copiar(texto, boton) {
  const listo = () => { const t = boton.textContent; boton.textContent = '✓ Copiado'; setTimeout(() => { boton.textContent = t; }, 1600); };
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(texto).then(listo, () => copiarViejo(texto, listo));
  copiarViejo(texto, listo);
}
function copiarViejo(texto, listo) {
  const t = el('textarea'); t.value = texto; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.append(t);
  t.select(); try { document.execCommand('copy'); listo(); } catch (e) {} t.remove();
}

// Explicación sencilla de qué es USDC, por qué es de fiar y cómo pagar (sale en «Mi cuenta»)
function guiaUsdc(abierta) {
  const d = el('details', 'guia-usdc');
  d.open = !!abierta;
  d.append(el('summary', null, '¿Qué es USDC y cómo pago? (guía sencilla)'));
  const c = el('div', 'guia-cuerpo');
  c.innerHTML = [
    '<h4>💵 ¿Qué es USDC?</h4>',
    '<p>Es un <b>dólar digital</b>: 1 USDC vale siempre 1 dólar (unos 0,92 €). No sube ni baja como el bitcoin. Lo emite <b>Circle</b>, una empresa regulada en EE. UU. y autorizada en la Unión Europea como dinero electrónico, que guarda 1 dólar de reserva por cada USDC y lo publica auditado cada mes.</p>',
    '<h4>🛣️ ¿Qué es «Base»?</h4>',
    '<p>Es la «carretera» por la que viaja el USDC hasta nosotros: la red de <b>Coinbase</b>. El envío llega en segundos y la comisión es de céntimos (desde la app de Coinbase, gratis).</p>',
    '<h4>🛡️ ¿Por qué es seguro?</h4>',
    '<ul>',
    '<li><b>No es una suscripción:</b> pagas una vez por el tiempo que eliges. Nunca se te cobrará nada sin que tú lo envíes.</li>',
    '<li><b>No damos ni guardamos datos de tu banco ni de tu tarjeta:</b> solo vemos que ha llegado el pago.</li>',
    '<li><b>Todo es comprobable:</b> cada pago queda registrado públicamente y puedes verlo en <a href="https://basescan.org" target="_blank" rel="noopener">basescan.org</a>.</li>',
    '<li><b>MorvehTV nunca te pedirá tu frase secreta, tu contraseña de Coinbase ni que instales nada.</b> Si alguien te lo pide en nuestro nombre, es una estafa.</li>',
    '</ul>',
    '<h4>✅ Cómo pagar (por ejemplo, con la app de Coinbase)</h4>',
    '<ol>',
    '<li>Compra USDC en la app (con tarjeta o transferencia).</li>',
    '<li>Pulsa <b>Enviar</b> → <b>USDC</b>.</li>',
    '<li>Pega nuestra <b>dirección</b> (o escanea el QR).</li>',
    '<li>Como red elige <b>Base</b>.</li>',
    '<li>Escribe el <b>importe exacto, con los céntimos</b>, y envía.</li>',
    '</ol>',
    '<p>Sirve cualquier plataforma que deje <b>enviar USDC por la red Base</b> (Coinbase, Binance, Kraken…: comprueba que aparece «Base» al enviar). Con una cartera propia como MetaMask o Coinbase Wallet también: necesitarás unos céntimos de ETH en Base para la comisión.</p>',
    '<h4>⚠️ Tres cosas importantes</h4>',
    '<ul>',
    '<li><b>Solo USDC y solo por la red Base.</b> Si lo envías por otra red (Ethereum, Solana, Polygon, Tron…) o envías otra moneda, se puede perder.</li>',
    '<li><b>El importe exacto, con sus céntimos:</b> es lo que nos dice que el pago es tuyo. Si envías otra cantidad no se pierde, pero hay que activarlo a mano: avísanos.</li>',
    '<li>Los envíos en blockchain <b>no se pueden deshacer</b>: revisa la dirección antes de enviar.</li>',
    '</ul>',
    '<p class="suave">¿Dudas o algún problema? Escríbenos (contacto en la <a href="/legal.html#aviso-legal" target="_blank">información legal</a>).</p>',
  ].join('');
  d.append(c);
  return d;
}

// Pantalla de pago de un pedido: importe exacto, red, dirección, QR y aviso en cuanto llega
let vigiaPago = null;
function pantallaPago(b, d) {
  clearInterval(vigiaPago);
  const caja = el('div', 'pago-usdc');
  const titulo = el('p', 'pago-paso', `Para ${d.meses} ${d.meses === 1 ? 'mes' : 'meses'} de VIP, envía exactamente:`);
  const importe = el('div', 'pago-importe');
  importe.append(el('b', null, d.importeTexto), el('span', null, ' USDC'));
  const cImporte = el('button', 'boton', 'Copiar importe'); cImporte.onclick = () => copiar(d.importeExacto, cImporte);
  importe.append(cImporte);
  const red = el('p', 'pago-red');
  red.innerHTML = 'Red: <b>Base</b> · Moneda: <b>USDC</b> &nbsp;⚠️ Solo por la red Base';
  const dirT = el('p', 'pago-paso', 'A esta dirección:');
  const dir = el('div', 'pago-direccion');
  dir.append(el('code', null, d.direccion));
  const cDir = el('button', 'boton', 'Copiar dirección'); cDir.onclick = () => copiar(d.direccion, cDir);
  dir.append(cDir);
  const comprueba = el('small', 'suave', `Comprueba al pegarla que empieza por ${d.direccion.slice(0, 6)} y acaba por ${d.direccion.slice(-4)}.`);
  const qr = el('div', 'pago-qr');
  qr.innerHTML = d.qr;
  const enCartera = el('a', 'boton', 'Abrir en otra cartera');
  enCartera.href = d.enlace;
  const qrTexto = el('small', 'suave', 'Escanéalo con MetaMask, Coinbase Wallet o tu cartera: el importe, la moneda y la red ya van puestos.');
  const lado = el('div', 'pago-qr-texto'); lado.append(qrTexto, botonMetaMask(d), enCartera);
  const qrFila = el('div', 'pago-qr-fila'); qrFila.append(qr, lado);
  const estado = el('div', 'pago-estado');
  const cancelar = el('button', 'boton', 'Cancelar este pago');
  cancelar.onclick = async () => { clearInterval(vigiaPago); await enviar('/api/pago/usdc/cancelar', { id: d.id }).catch(() => {}); await planCambiado(false); abrirCuenta(); };
  caja.append(titulo, importe, red, dirT, dir, comprueba, qrFila, estado, cancelar);
  b.s.append(caja);

  const pintarEspera = () => {
    const falta = Math.max(0, d.caduca - Date.now());
    const m = Math.floor(falta / 60000), s = Math.floor((falta % 60000) / 1000);
    estado.className = 'pago-estado esperando';
    estado.innerHTML = falta > 0
      ? '<span class="girando"></span> Esperando tu pago… Se detecta solo unos segundos después de enviarlo. Puedes dejar esta pantalla abierta o volver más tarde.'
        + `<br><small>Este importe está reservado para ti ${m}:${String(s).padStart(2, '0')} más.</small>`
      : 'El tiempo para este importe ha terminado. Si ya lo enviaste, se reconocerá igualmente en las próximas horas; si no, cancela y empieza otro.';
  };
  pintarEspera();
  let n = 0;
  vigiaPago = setInterval(async () => {
    if (!caja.isConnected) return clearInterval(vigiaPago);
    pintarEspera();
    if (++n % 5) return; // cada 5 s se pregunta al servidor
    try {
      const r = await api('/api/pago/usdc/estado', { id: d.id });
      if (r.estado === 'pagado') {
        clearInterval(vigiaPago);
        estado.className = 'pago-estado hecho';
        estado.innerHTML = '✅ <b>¡Pago recibido!</b> VIP activado. ' + (r.tx ? `<a href="https://basescan.org/tx/${r.tx}" target="_blank" rel="noopener">Ver el pago en basescan.org ↗</a>` : '');
        await planCambiado(true);
      }
    } catch (e) {}
  }, 1000);
}

// «Pagar con MetaMask»: en el ordenador (extensión) o dentro del navegador de MetaMask, prepara el
// envío de USDC por Base con todo puesto (red, moneda, dirección e importe exacto) y solo hay que
// confirmarlo en MetaMask. En el móvil sin extensión abre la app de MetaMask con el pago ya
// preparado; en la app de MorvehTV, el enlace «ethereum:» que abre MetaMask directamente.
const BASE_HEX = '0x2105'; // 8453
function botonMetaMask(d) {
  const b = el('button', 'boton boton-acento boton-metamask', '🦊 Pagar con MetaMask');
  b.type = 'button';
  const msg = el('small', 'suave');
  const caja = el('div', 'pago-metamask'); caja.append(b, msg);
  b.onclick = async () => {
    const eth = window.ethereum;
    if (!eth) {
      if (enApp()) { location.href = d.enlace; return; }
      // Móvil o navegador sin la extensión: la app de MetaMask con el pago preparado
      const enlace = `https://metamask.app.link/send/${d.contrato}@8453/transfer?address=${d.direccion}&uint256=${d.importe}`;
      if (/Android|iPhone|iPad/i.test(navigator.userAgent)) { window.open(enlace, '_blank', 'noopener'); return; }
      msg.innerHTML = 'No encuentro MetaMask en este navegador. Instala la extensión desde <a href="https://metamask.io/download/" target="_blank" rel="noopener">metamask.io</a> o escanea el QR con la app del móvil.';
      return;
    }
    b.disabled = true;
    try {
      msg.textContent = 'Abre MetaMask y conecta tu cartera…';
      const [cuenta] = await eth.request({ method: 'eth_requestAccounts' });
      if (!cuenta) throw new Error('Sin cartera');
      // La red Base (si no la tiene, se le propone añadirla)
      if ((await eth.request({ method: 'eth_chainId' })) !== BASE_HEX) {
        msg.textContent = 'Cambia a la red Base en MetaMask…';
        try {
          await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_HEX }] });
        } catch (e) {
          if (e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
            await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: BASE_HEX, chainName: 'Base', rpcUrls: ['https://mainnet.base.org'],
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://basescan.org'] }] });
          } else throw e;
        }
      }
      // transfer(dirección, importe) del contrato de USDC: el importe exacto con sus céntimos
      const datos = '0xa9059cbb' + d.direccion.replace(/^0x/, '').toLowerCase().padStart(64, '0')
        + BigInt(d.importe).toString(16).padStart(64, '0');
      msg.textContent = `Confirma en MetaMask el envío de ${d.importeTexto} USDC…`;
      const tx = await eth.request({ method: 'eth_sendTransaction', params: [{ from: cuenta, to: d.contrato, data: datos, value: '0x0' }] });
      msg.innerHTML = `✅ Enviado. En unos segundos se activa VIP solo. <a href="https://basescan.org/tx/${encodeURIComponent(tx)}" target="_blank" rel="noopener">Ver el envío ↗</a>`;
    } catch (e) {
      b.disabled = false;
      msg.textContent = e && e.code === 4001 ? 'Has cancelado el pago en MetaMask. Puedes volver a intentarlo.'
        : /insufficient|fondos/i.test((e && e.message) || '') ? 'No tienes USDC o ETH suficiente en la red Base (hace falta un poco de ETH en Base para la comisión).'
          : 'No se pudo preparar el pago en MetaMask: ' + ((e && e.message) || 'error desconocido');
    }
  };
  return caja;
}

// Al crear la cuenta pulsando «Hazte VIP» se llega con ?vip=1: se abre «Mi cuenta» en el plan
function ofertaVipAlEntrar() {
  if (!/[?&]vip=1\b/.test(location.search)) return;
  try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
  if (!planInfo || !planInfo.activo || planInfo.plan === 'premium') return;
  abrirCuenta();
  setTimeout(() => {
    const plan = document.querySelector('.cuenta-bloque.plan-basico, .cuenta-bloque[class*="plan"]');
    if (plan) plan.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 150);
}

function bloquePlan() {
  if (!planInfo) return null;
  clearInterval(vigiaPago);
  const premium = planInfo.plan === 'premium';
  // Pagos apagados: no se habla de planes (salvo a quien aún tiene VIP pagado)
  if (!planInfo.activo && (!premium || planInfo.admin)) return null;
  let texto;
  if (premium && planInfo.admin) texto = 'VIP de por vida (administrador): sin anuncios y sin pagar nunca.';
  else if (premium && !planInfo.activo) texto = `VIP hasta el ${fechaLarga(planInfo.hasta)}: sin anuncios en la web y la app.`;
  else if (premium) {
    const dias = Math.ceil((planInfo.hasta - Date.now()) / 864e5);
    texto = `VIP hasta el ${fechaLarga(planInfo.hasta)}: sin anuncios en la web y la app. Es un pago de 12 meses que no se renueva solo: `
      + (planInfo.puedeRenovar ? `termina en ${dias} ${dias === 1 ? 'día' : 'días'}, ya puedes renovarlo (el año nuevo empieza cuando acabe este).` : 'podrás renovarlo en su último mes.');
  }
  else texto = (planInfo.vencio ? `Tu VIP terminó el ${fechaLarga(planInfo.vencio)}: renuévalo para volver a verlo todo sin anuncios. ` : '')
    + 'Básico: gratis, con anuncios.' + (planInfo.activo ? ' Con VIP lo ves todo sin anuncios, en la web y la app, durante 12 meses. Se paga una vez con USDC (un dólar digital) y no se renueva solo: al terminar, tú decides si renovarlo.' : '');
  const b = bloque('Plan', texto);
  b.s.classList.add(premium ? 'plan-premium' : 'plan-basico');

  // Un pago a medias: se vuelve a su pantalla
  if (planInfo.activo && planInfo.pendiente) {
    pantallaPago(b, planInfo.pendiente);
    b.s.append(guiaUsdc(false), b.msg);
    return b.s;
  }
  if (planInfo.activo && !planInfo.admin && planInfo.puedeRenovar) {
    const opciones = el('div', 'opciones-usdc');
    let elegida = planInfo.opciones[0] && planInfo.opciones[0].id;
    planInfo.opciones.forEach((o, i) => {
      const op = el('button', 'opcion-usdc' + (i === 0 ? ' activa' : ''));
      const porMes = Math.round((o.usdc / o.meses) * 100) / 100;
      op.innerHTML = `<b>${o.meses} ${o.meses === 1 ? 'mes' : 'meses'}</b><span>${o.texto}</span>${o.meses > 1 ? `<small>${porMes.toLocaleString('es-ES')} USDC/mes</small>` : ''}`;
      op.onclick = () => { elegida = o.id; opciones.querySelectorAll('.opcion-usdc').forEach((x) => x.classList.remove('activa')); op.classList.add('activa'); };
      opciones.append(op);
    });
    const acepto = el('label', 'acepto-premium');
    const casilla = el('input'); casilla.type = 'checkbox';
    const txt = el('span');
    txt.innerHTML = 'Acepto las <a href="/legal.html#condiciones" target="_blank">condiciones</a> y pido que VIP empiece <b>en cuanto llegue el pago</b>, por lo que <b>pierdo el derecho de desistimiento</b> de 14 días.';
    acepto.append(casilla, txt);
    const seguir = el('button', 'boton boton-acento', premium || planInfo.vencio ? '⭐ Renovar VIP con USDC' : '⭐ Hazte VIP con USDC');
    seguir.onclick = () => accion(seguir, b.msg, async () => {
      if (!casilla.checked) { casilla.focus(); throw new Error('Marca la casilla de las condiciones para continuar'); }
      const d = await enviar('/api/pago/usdc/pedido', { opcion: elegida, acepta: true });
      opciones.remove(); acepto.remove(); seguir.remove();
      pantallaPago(b, d);
    });
    const unica = planInfo.opciones.length === 1;
    b.s.append(el('p', 'pago-paso', premium || planInfo.vencio ? 'Renovar 12 meses más:' : (unica ? 'Un año de VIP, en un solo pago:' : 'Elige cuánto tiempo:')), opciones, acepto, seguir);
  }
  // Últimos pagos, con su enlace público
  if (planInfo.pagos && planInfo.pagos.length) {
    const l = el('ul', 'pagos-hechos');
    planInfo.pagos.forEach((x) => {
      const li = el('li');
      li.innerHTML = `${fechaLarga(x.fecha)} · ${x.meses} ${x.meses === 1 ? 'mes' : 'meses'}${x.importe ? ` · ${x.importe} USDC` : ''}`
        + (x.tx ? ` · <a href="https://basescan.org/tx/${x.tx}" target="_blank" rel="noopener">ver ↗</a>` : '');
      l.append(li);
    });
    b.s.append(el('p', 'pago-paso', 'Tus pagos:'), l);
  }
  if (planInfo.activo && !planInfo.admin) b.s.append(guiaUsdc(!premium && !(planInfo.pagos && planInfo.pagos.length)));
  b.s.append(b.msg);
  return b.s;
}
