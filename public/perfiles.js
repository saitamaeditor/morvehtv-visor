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
  if (yo && planInfo && planInfo.plan === 'premium') b.append(el('span', 'insignia', 'PREMIUM'));
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
  const bp = bloquePlan();
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
    if (!confirm('¿Seguro que quieres borrar tu cuenta? No se puede deshacer.')) return;
    await enviar('/api/cuenta-borrar', { actual: cb.i.value });
    location.replace('/entrar.html#registro');
  });
  bb.s.append(cb.l, borrar, bb.msg);
  caja.append(bb.s);

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
// El servidor dice el plan de la cuenta, el precio y, solo al plan Básico, qué anuncios poner
// (Google AdSense en la web, anuncios propios del gestor o, si no hay, un aviso de Premium).
let planInfo = null; // { activo, plan, hasta, cancelado, precio, anuncios }
const enApp = () => !!window.MorvehApp;

async function cargarPlan() {
  try { planInfo = await api('/api/pago/info'); } catch (e) { planInfo = null; }
  document.documentElement.classList.toggle('premium', !!(planInfo && planInfo.plan === 'premium'));
  pintarBotonCuenta();
  return planInfo;
}
const conAnuncios = () => !!(planInfo && planInfo.plan !== 'premium' && planInfo.anuncios);

// Vuelta de la página de pago de Stripe (?pago=ok / ?pago=cancelado)
async function vueltaDelPago() {
  const q = new URLSearchParams(location.search).get('pago');
  if (!q) return;
  history.replaceState(null, '', location.pathname + location.hash);
  if (q !== 'ok') return aviso('Pago cancelado: sigues con el plan Básico', 4000);
  aviso('¡Gracias! Activando Premium…', 4000);
  // Stripe avisa al servidor en unos segundos: se mira hasta que llega
  for (let n = 0; n < 10; n++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    await cargarPlan();
    if (planInfo && planInfo.plan === 'premium') { aviso('¡Ya eres Premium! Sin anuncios en la web y la app', 5000); return cargar(); }
  }
}

let adsenseCargado = false;
function cargarAdsense(cliente) {
  if (adsenseCargado) return;
  adsenseCargado = true;
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(cliente);
  document.head.append(s);
}

// Un anuncio: AdSense (solo en la web: dentro de la app de Android no está permitido), uno
// propio al azar o el aviso de Premium. «donde» cambia el tamaño (franja o recuadro).
function contenidoAnuncio(donde) {
  const a = planInfo.anuncios;
  if (a.adsense && a.adsense.slot && !enApp()) {
    cargarAdsense(a.adsense.cliente);
    const ins = el('ins', 'adsbygoogle');
    ins.style.display = 'block';
    ins.setAttribute('data-ad-client', a.adsense.cliente);
    ins.setAttribute('data-ad-slot', a.adsense.slot);
    ins.setAttribute('data-ad-format', donde === 'previo' ? 'rectangle' : 'auto');
    ins.setAttribute('data-full-width-responsive', 'true');
    setTimeout(() => { try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {} }, 0);
    return ins;
  }
  if (a.propios && a.propios.length) {
    const x = a.propios[Math.floor(Math.random() * a.propios.length)];
    const c = el(x.enlace ? 'a' : 'div', 'anuncio-propio');
    if (x.enlace) { c.href = x.enlace; c.target = '_blank'; c.rel = 'sponsored noopener'; }
    if (x.imagen) { const im = el('img'); im.src = x.imagen; im.alt = x.titulo || ''; im.loading = 'lazy'; c.append(im); }
    const t = el('div', 'texto');
    if (x.titulo) t.append(el('b', null, x.titulo));
    if (x.texto) t.append(el('span', null, x.texto));
    c.append(t);
    return c;
  }
  if (!planInfo.activo) return null;
  // Sin anuncios configurados: el hueco anuncia Premium
  const c = el('div', 'anuncio-propio promo');
  const t = el('div', 'texto');
  t.append(el('b', null, '⭐ MorvehTV Premium'), el('span', null, 'Todo sin anuncios en la web y la app' + (planInfo.precio ? ' por ' + planInfo.precio : '') + '.'));
  c.append(t);
  // (antes del vídeo ya lleva su propio botón «Sin anuncios» abajo)
  if (donde !== 'previo') {
    const b = el('button', 'boton boton-acento', 'Quitar anuncios');
    b.onclick = (e) => { e.stopPropagation(); abrirCuenta(); };
    c.append(b);
  }
  return c;
}

function anuncioBanner(donde) {
  if (!conAnuncios()) return null;
  const contenido = contenidoAnuncio(donde);
  if (!contenido) return null;
  const caja = el('aside', 'anuncio anuncio-' + donde);
  caja.append(el('small', 'etiqueta-anuncio', 'Anuncio'), contenido);
  return caja;
}

// Antes de un vídeo (plan Básico): un anuncio de 5 s que luego se puede saltar. Como mucho uno
// cada 10 minutos, para no cortar cada capítulo. Devuelve una promesa que se cumple al acabar.
let ultimoPrevio = 0;
function anuncioPrevio() {
  if (!conAnuncios() || Date.now() - ultimoPrevio < 10 * 60000) return Promise.resolve();
  const contenido = contenidoAnuncio('previo');
  if (!contenido) return Promise.resolve();
  ultimoPrevio = Date.now();
  return new Promise((listo) => {
    const capa = el('div', 'anuncio-previo');
    const caja = el('div', 'caja');
    const arriba = el('div', 'arriba');
    arriba.append(el('small', 'etiqueta-anuncio', 'Anuncio'));
    const saltar = el('button', 'boton', 'El vídeo empieza en 5 s');
    saltar.disabled = true;
    caja.append(arriba, contenido);
    const pie = el('div', 'pie');
    if (planInfo.activo) {
      const pr = el('button', 'boton', '⭐ Sin anuncios' + (planInfo.precio ? ' · ' + planInfo.precio : ''));
      pr.onclick = () => { terminar(); cerrar(); abrirCuenta(); };
      pie.append(pr);
    }
    pie.append(saltar);
    caja.append(pie);
    capa.append(caja);
    $('#visor').append(capa);
    let s = 5;
    const reloj = setInterval(() => {
      if (!$('#visor').classList.contains('abierto')) return terminar();
      if (--s > 0) { saltar.textContent = 'El vídeo empieza en ' + s + ' s'; return; }
      clearInterval(reloj);
      saltar.disabled = false; saltar.textContent = 'Ver el vídeo ›'; saltar.classList.add('boton-acento');
      saltar.focus();
    }, 1000);
    function terminar() { clearInterval(reloj); capa.remove(); listo(); }
    saltar.onclick = terminar;
  });
}

// Ir a la página de Stripe (pagar o gestionar). En la app de Android solo se puede salir a otra
// web con un toque, así que allí se enseña un botón que lleva a ella.
async function irAPago(ruta, boton, msg) {
  await accion(boton, msg, async () => {
    const r = await enviar(ruta);
    if (!enApp()) { location.href = r.url; return; }
    const a = el('a', 'boton boton-acento', 'Continuar en la página de pago segura ›');
    a.href = r.url;
    boton.replaceWith(a);
    a.focus();
  });
}

function fechaLarga(ms) { return new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }); }

function bloquePlan() {
  if (!planInfo) return null;
  const premium = planInfo.plan === 'premium';
  const precio = planInfo.precio ? ' (' + planInfo.precio + ')' : '';
  const texto = premium
    ? (yo && yo.admin ? 'Premium (administrador): sin anuncios.'
      : 'Premium: sin anuncios en la web y la app.' + (planInfo.hasta ? ' ' + (planInfo.cancelado ? 'Termina' : 'Se renueva') + ' el ' + fechaLarga(planInfo.hasta) + '.' : ''))
    : 'Básico: gratis, con anuncios.' + (planInfo.activo ? ' Con Premium' + precio + ' lo ves todo sin anuncios, en la web y la app. Se cancela cuando quieras.' : '');
  const b = bloque('Plan', texto);
  b.s.classList.add(premium ? 'plan-premium' : 'plan-basico');
  const fila = el('div', 'cuenta-botones');
  if (!premium && planInfo.activo) {
    const ir = el('button', 'boton boton-acento', '⭐ Hazte Premium' + (planInfo.precio ? ' · ' + planInfo.precio : ''));
    ir.onclick = () => irAPago('/api/pago/suscribir', ir, b.msg);
    fila.append(ir);
  }
  if (premium && !(yo && yo.admin) && planInfo.activo) {
    const g = el('button', 'boton', 'Gestionar suscripción (tarjeta, facturas, cancelar)');
    g.onclick = () => irAPago('/api/pago/portal', g, b.msg);
    fila.append(g);
  }
  if (fila.children.length) b.s.append(fila);
  b.s.append(b.msg);
  return b.s;
}
