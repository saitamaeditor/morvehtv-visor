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
  if (yo && typeof planInfo !== 'undefined' && planInfo && planInfo.plan === 'premium') b.append(el('span', 'insignia', 'PREMIUM'));
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

  // Plan: Básico o Premium
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
    if (!confirm('¿Seguro que quieres borrar tu cuenta? No se puede deshacer.' + (planInfo && planInfo.plan === 'premium' && !planInfo.admin ? ' Perderás el tiempo de Premium que te quede.' : ''))) return;
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

// ---------- Planes: Básico (con anuncios) y Premium (sin anuncios) ----------
// El servidor dice el plan de la cuenta, el precio y, solo al plan Básico, qué anuncios poner.
// Se paga con USDC (red Base); en cuanto llega el pago, Premium se activa al momento y el servidor avisa a todas las
// pestañas y aparatos abiertos de la cuenta (evento «plan») para quitar los anuncios ya.
let planInfo = null; // { activo, plan, hasta, cancelado, precio, anuncios }
const enApp = () => !!window.MorvehApp;

async function cargarPlan() {
  try { planInfo = await api('/api/pago/info'); } catch (e) { planInfo = null; }
  document.documentElement.classList.toggle('premium', !!(planInfo && planInfo.plan === 'premium'));
  pintarBotonCuenta();
  return planInfo;
}
const conAnuncios = () => !!(planInfo && planInfo.plan !== 'premium' && planInfo.anuncios);

// El plan ha cambiado (pago, cancelación, aviso de otro aparato): se repinta sin anuncios (o con)
async function planCambiado(avisar) {
  const antes = planInfo && planInfo.plan;
  await cargarPlan();
  const ahora = planInfo && planInfo.plan;
  if (antes === ahora && !avisar) return;
  document.querySelectorAll('.anuncio, .anuncio-previo').forEach((x) => { if (ahora === 'premium') x.remove(); });
  if (ahora === 'premium' && antes !== 'premium') aviso('⭐ ¡Ya eres Premium! Sin anuncios en la web y la app', 5000);
  if (document.documentElement.classList.contains('con-cuenta')) abrirCuenta();
  if (actual < 0) cargar();
}
// Al volver a la app (estaba en segundo plano mientras se pagaba) se mira el plan otra vez
document.addEventListener('visibilitychange', () => { if (!document.hidden && yo) planCambiado(false); });

// (Premium con USDC no sale de la web: no hay vuelta de ninguna página de pago)
function vueltaDelPago() {}

let adsenseCargado = false;
function cargarAdsense(cliente) {
  if (adsenseCargado) return;
  adsenseCargado = true;
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(cliente);
  document.head.append(s);
}

const azar = (lista) => lista[Math.floor(Math.random() * lista.length)];

// Banner: AdSense (solo en la web: dentro de la app de Android no está permitido), uno propio
// con imagen al azar o, si no hay ninguno, el aviso de Premium
function contenidoBanner() {
  const a = planInfo.anuncios;
  if (a.adsense && a.adsense.slot && !enApp()) {
    cargarAdsense(a.adsense.cliente);
    const ins = el('ins', 'adsbygoogle');
    ins.style.display = 'block';
    ins.setAttribute('data-ad-client', a.adsense.cliente);
    ins.setAttribute('data-ad-slot', a.adsense.slot);
    ins.setAttribute('data-ad-format', 'auto');
    ins.setAttribute('data-full-width-responsive', 'true');
    setTimeout(() => { try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {} }, 0);
    return ins;
  }
  const conImagen = (a.propios || []).filter((x) => x.imagen || x.titulo);
  if (conImagen.length) return tarjetaAnuncio(azar(conImagen));
  return promoPremium(true);
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
function promoPremium(conBoton) {
  if (!planInfo.activo) return null;
  const c = el('div', 'anuncio-propio promo');
  const t = el('div', 'texto');
  t.append(el('b', null, '⭐ MorvehTV Premium'), el('span', null, 'Todo sin anuncios en la web y la app' + (planInfo.precio ? ' por ' + planInfo.precio : '') + '.'));
  c.append(t);
  if (conBoton) {
    const b = el('button', 'boton boton-acento', 'Quitar anuncios');
    b.onclick = (e) => { e.stopPropagation(); abrirCuenta(); };
    c.append(b);
  }
  return c;
}

function anuncioBanner(donde) {
  if (!conAnuncios()) return null;
  const contenido = contenidoBanner();
  if (!contenido) return null;
  const caja = el('aside', 'anuncio anuncio-' + donde);
  caja.append(el('small', 'etiqueta-anuncio', 'Anuncio'), contenido);
  return caja;
}

// ---------- Anuncio antes de reproducir (plan Básico) ----------
// Un anuncio en vídeo antes de cada vídeo: de Google (VAST, solo en la web) o uno de los tuyos
// subidos desde el gestor. Se puede saltar a los 5 s y, si acaba antes, el vídeo empieza solo.
// Si no hay anuncios en vídeo, uno con imagen durante 5 s. Como mucho uno cada 5 minutos, para
// no cortar cada capítulo seguido. Devuelve una promesa que se cumple cuando hay que seguir.
const ESPERA_ENTRE_ANUNCIOS = 5 * 60000;
const SALTAR_EN = 5;
let ultimoPrevio = 0;

function capaAnuncio() {
  const capa = el('div', 'anuncio-previo');
  const caja = el('div', 'caja');
  const arriba = el('div', 'arriba');
  const etiqueta = el('small', 'etiqueta-anuncio', 'Anuncio');
  arriba.append(etiqueta);
  const escena = el('div', 'escena');
  const pie = el('div', 'pie');
  const saltar = el('button', 'boton saltar', 'Saltar en ' + SALTAR_EN + ' s');
  saltar.disabled = true;
  if (planInfo.activo) {
    const pr = el('button', 'boton', '⭐ Sin anuncios' + (planInfo.precio ? ' · ' + planInfo.precio : ''));
    pr.onclick = () => { capa._fin(); cerrar(); abrirCuenta(); };
    pie.append(pr);
  }
  pie.append(saltar);
  caja.append(arriba, escena, pie);
  capa.append(caja);
  return { capa, escena, saltar, etiqueta, arriba, pie };
}

function cuentaAtras(c, terminar) {
  let s = SALTAR_EN;
  const reloj = setInterval(() => {
    if (!$('#visor').classList.contains('abierto')) return terminar();
    if (--s > 0) { c.saltar.textContent = 'Saltar en ' + s + ' s'; return; }
    clearInterval(reloj);
    c.saltar.disabled = false; c.saltar.textContent = 'Saltar anuncio ›'; c.saltar.classList.add('boton-acento');
    c.saltar.focus();
  }, 1000);
  return () => clearInterval(reloj);
}

function anuncioPrevio() {
  if (!conAnuncios() || Date.now() - ultimoPrevio < ESPERA_ENTRE_ANUNCIOS) return Promise.resolve();
  const a = planInfo.anuncios;
  const videos = (a.propios || []).filter((x) => x.video);
  ultimoPrevio = Date.now();
  if (a.vast && !enApp()) return anuncioVast(a.vast).then((hecho) => (hecho ? null : videos.length ? anuncioVideo(azar(videos)) : anuncioImagen()));
  if (videos.length) return anuncioVideo(azar(videos));
  return anuncioImagen();
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

// Sin vídeos: uno con imagen (o el aviso de Premium) durante 5 s
function anuncioImagen() {
  const a = planInfo.anuncios;
  const conImagen = (a.propios || []).filter((x) => x.imagen || x.titulo);
  const contenido = conImagen.length ? tarjetaAnuncio(azar(conImagen)) : promoPremium(false);
  if (!contenido) return Promise.resolve();
  return new Promise((listo) => {
    const c = capaAnuncio();
    c.escena.append(contenido);
    let hecho = false;
    const parar = cuentaAtras(c, () => terminar());
    function terminar() { if (hecho) return; hecho = true; parar(); c.capa.remove(); listo(); }
    c.capa._fin = terminar;
    c.saltar.onclick = terminar;
    $('#visor').append(c.capa);
  });
}

// Anuncio de Google en vídeo (VAST, con el SDK IMA de Google). Devuelve true si se mostró
// (o se intentó y terminó); false si no se pudo (sin anuncio disponible, bloqueador…)
let imaCargado = null;
function cargarIma() {
  if (!imaCargado) {
    imaCargado = new Promise((ok, mal) => {
      const s = document.createElement('script');
      s.src = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';
      s.onload = () => (window.google && google.ima ? ok() : mal(new Error('IMA')));
      s.onerror = () => { imaCargado = null; mal(new Error('IMA bloqueado')); };
      document.head.append(s);
    });
  }
  return imaCargado;
}
function anuncioVast(etiqueta) {
  return new Promise((listo) => {
    let hecho = false;
    let mostrado = false;
    const c = capaAnuncio();
    c.saltar.hidden = true; // los anuncios de Google traen su propio «Saltar»
    const v = el('video'); v.playsInline = true; v.setAttribute('playsinline', '');
    const zona = el('div', 'ima');
    c.escena.classList.add('con-ima');
    c.escena.append(v, zona);
    let gestor = null;
    function terminar() {
      if (hecho) return; hecho = true;
      try { if (gestor) gestor.destroy(); } catch (e) {}
      c.capa.remove(); listo(mostrado);
    }
    c.capa._fin = terminar;
    $('#visor').append(c.capa);
    const limite = setTimeout(() => { if (!mostrado) terminar(); }, 8000);
    cargarIma().then(() => {
      const ima = google.ima;
      try { ima.settings.setLocale('es'); } catch (e) {}
      const contenedor = new ima.AdDisplayContainer(zona, v);
      contenedor.initialize();
      const cargador = new ima.AdsLoader(contenedor);
      cargador.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, terminar);
      cargador.addEventListener(ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (e) => {
        gestor = e.getAdsManager(v);
        gestor.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, terminar);
        gestor.addEventListener(ima.AdEvent.Type.STARTED, () => { mostrado = true; clearTimeout(limite); });
        gestor.addEventListener(ima.AdEvent.Type.ALL_ADS_COMPLETED, terminar);
        gestor.addEventListener(ima.AdEvent.Type.SKIPPED, terminar);
        try {
          const r = zona.getBoundingClientRect();
          gestor.init(Math.max(320, r.width), Math.max(180, r.height), ima.ViewMode.NORMAL);
          gestor.start();
        } catch (err) { terminar(); }
      });
      const pedido = new ima.AdsRequest();
      pedido.adTagUrl = etiqueta;
      const r = zona.getBoundingClientRect();
      pedido.linearAdSlotWidth = Math.max(320, r.width); pedido.linearAdSlotHeight = Math.max(180, r.height);
      cargador.requestAds(pedido);
    }).catch(terminar);
  });
}

// ---------- Premium con USDC (red Base) ----------
// Se paga una sola vez por un tiempo (sin suscripción): se elige cuánto, se envía el importe
// exacto a la dirección y el servidor lo ve en la blockchain y activa Premium solo.
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
  const titulo = el('p', 'pago-paso', `Para ${d.meses} ${d.meses === 1 ? 'mes' : 'meses'} de Premium, envía exactamente:`);
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
  const enCartera = el('a', 'boton boton-acento', 'Abrir en mi cartera');
  enCartera.href = d.enlace;
  const qrTexto = el('small', 'suave', 'Escanéalo con MetaMask, Coinbase Wallet o tu cartera: el importe, la moneda y la red ya van puestos.');
  const lado = el('div', 'pago-qr-texto'); lado.append(qrTexto, enCartera);
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
        estado.innerHTML = '✅ <b>¡Pago recibido!</b> Premium activado. ' + (r.tx ? `<a href="https://basescan.org/tx/${r.tx}" target="_blank" rel="noopener">Ver el pago en basescan.org ↗</a>` : '');
        await planCambiado(true);
      }
    } catch (e) {}
  }, 1000);
}

function bloquePlan() {
  if (!planInfo) return null;
  clearInterval(vigiaPago);
  const premium = planInfo.plan === 'premium';
  let texto;
  if (premium && planInfo.admin) texto = 'Premium de por vida (administrador): sin anuncios y sin pagar nunca.';
  else if (premium) texto = `Premium hasta el ${fechaLarga(planInfo.hasta)}: sin anuncios en la web y la app. No hay cobros automáticos; cuando quieras, amplíalo y los meses se suman.`;
  else texto = 'Básico: gratis, con anuncios.' + (planInfo.activo ? ' Con Premium lo ves todo sin anuncios, en la web y la app. Se paga una sola vez con USDC (un dólar digital) por el tiempo que elijas: sin suscripción ni cobros automáticos.' : '');
  const b = bloque('Plan', texto);
  b.s.classList.add(premium ? 'plan-premium' : 'plan-basico');

  // Un pago a medias: se vuelve a su pantalla
  if (planInfo.activo && planInfo.pendiente) {
    pantallaPago(b, planInfo.pendiente);
    b.s.append(guiaUsdc(false), b.msg);
    return b.s;
  }
  if (planInfo.activo && !planInfo.admin) {
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
    txt.innerHTML = 'Acepto las <a href="/legal.html#condiciones" target="_blank">condiciones</a> y pido que Premium empiece <b>en cuanto llegue el pago</b>, por lo que <b>pierdo el derecho de desistimiento</b> de 14 días.';
    acepto.append(casilla, txt);
    const seguir = el('button', 'boton boton-acento', premium ? '⭐ Ampliar Premium con USDC' : '⭐ Hazte Premium con USDC');
    seguir.onclick = () => accion(seguir, b.msg, async () => {
      if (!casilla.checked) { casilla.focus(); throw new Error('Marca la casilla de las condiciones para continuar'); }
      const d = await enviar('/api/pago/usdc/pedido', { opcion: elegida, acepta: true });
      opciones.remove(); acepto.remove(); seguir.remove();
      pantallaPago(b, d);
    });
    const unica = planInfo.opciones.length === 1;
    b.s.append(el('p', 'pago-paso', premium ? (unica ? 'Ampliar un año más:' : 'Ampliar:') : (unica ? 'Un año de Premium, en un solo pago:' : 'Elige cuánto tiempo:')), opciones, acepto, seguir);
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
