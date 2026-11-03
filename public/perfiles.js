// ---------- Perfiles de la familia ----------
// «¿Quién está viendo?» al abrir MorvehTV: cada persona entra en su perfil con su PIN de 4
// cifras y tiene su lista («Mi lista») y su «Seguir viendo». Todo se maneja con el ratón, con el
// dedo o con el mando de la tele (flechas + OK, y los números del mando para el PIN).
let yo = null; // { id, nombre, avatar, color, favoritos: [...], posiciones: {...} }
let catalogoPerfiles = null; // { avatares, colores }

async function enviar(ruta, datos) {
  const r = await fetch(ruta, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(datos || {}),
  });
  if (r.status === 401 && ruta !== '/api/perfil-entrar' && ruta !== '/api/perfil-editar' && ruta !== '/api/perfil-borrar') {
    const d = await r.json().catch(() => ({}));
    if (d.error === 'Falta el PIN') location.href = '/entrar.html';
    else elegirPerfil();
    throw new Error(d.error || 'Elige tu perfil');
  }
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

async function empezar() {
  // La intro va primero (y fluida): mientras tanto no se dibuja nada
  if (window.morvehIntroFin) { await window.morvehIntroFin; window.morvehIntroFin = null; }
  try {
    const d = await api('/api/perfiles');
    catalogoPerfiles = d;
    if (d.actual) {
      yo = await api('/api/yo');
      pintarPerfilActual();
      return cargar();
    }
  } catch (e) {
    return mostrarError(`No se pudieron leer los perfiles: ${e.message}`);
  }
  elegirPerfil();
}

function mostrarError(texto) {
  const p = pantallaPerfiles();
  p.innerHTML = '';
  p.append(el('h1', null, 'MorvehTV'), el('p', 'perfiles-error', texto));
  const b = el('button', 'boton', 'Reintentar');
  b.onclick = () => location.reload();
  p.append(b);
  b.focus();
}

// Capa a pantalla completa donde van la elección de perfil, el PIN y los formularios
function pantallaPerfiles() {
  let p = $('#perfiles');
  if (!p) {
    p = el('div');
    p.id = 'perfiles';
    document.body.append(p);
  }
  p.hidden = false;
  document.documentElement.classList.add('con-perfiles');
  return p;
}
function cerrarPerfiles() {
  const p = $('#perfiles');
  if (p) p.hidden = true;
  document.documentElement.classList.remove('con-perfiles');
}

function avatarHtml(p, clase) {
  const a = el('div', `avatar ${clase || ''}`, p.avatar);
  a.style.background = p.color;
  return a;
}

// ---------- ¿Quién está viendo? ----------
async function elegirPerfil(administrar = false) {
  if (actual >= 0) cerrar();
  const p = pantallaPerfiles();
  p.innerHTML = '<div class="vacio">Cargando…</div>';
  let d;
  try {
    d = await api('/api/perfiles');
    catalogoPerfiles = d;
  } catch (e) {
    return mostrarError(`No se pudieron leer los perfiles: ${e.message}`);
  }
  p.innerHTML = '';
  const logo = el('div', 'perfiles-logo');
  logo.innerHTML = '☁️ Morveh<span class="tv">TV</span>';
  p.append(logo, el('h1', null, administrar ? 'Administrar perfiles' : '¿Quién está viendo?'));
  if (!d.perfiles.length) p.append(el('p', 'perfiles-sub', 'Crea un perfil para cada persona de la familia: cada uno tendrá su lista y seguirá por donde se quedó.'));
  const rejilla = el('div', 'perfiles-rejilla');
  for (const perfil of d.perfiles) {
    const b = el('button', 'perfil');
    b.append(avatarHtml(perfil), el('span', 'perfil-nombre', perfil.nombre));
    if (administrar) b.append(el('span', 'perfil-editar', '✎'));
    b.onclick = () => entrarEn(perfil, administrar);
    rejilla.append(b);
  }
  if (d.perfiles.length < 10) {
    const nuevo = el('button', 'perfil perfil-nuevo');
    nuevo.append(el('div', 'avatar', '+'), el('span', 'perfil-nombre', 'Añadir perfil'));
    nuevo.onclick = () => formularioPerfil(null);
    rejilla.append(nuevo);
  }
  p.append(rejilla);
  if (d.perfiles.length) {
    const adm = el('button', 'boton perfiles-admin', administrar ? 'Listo' : 'Administrar perfiles');
    adm.onclick = () => elegirPerfil(!administrar);
    p.append(adm);
  }
  const primero = p.querySelector('.perfil');
  if (primero) primero.focus();
}

async function entrarEn(perfil, administrar) {
  const pin = await pedirPin(perfil, administrar ? `PIN de ${perfil.nombre} para editarlo` : `Hola, ${perfil.nombre}. Pon tu PIN`);
  if (pin === null) return elegirPerfil(administrar);
  try {
    await enviar('/api/perfil-entrar', { id: perfil.id, pin });
  } catch (e) {
    return entrarEn(Object.assign({}, perfil, { error: e.message }), administrar);
  }
  yo = await api('/api/yo');
  if (administrar) return formularioPerfil(yo, pin);
  cerrarPerfiles();
  pintarPerfilActual();
  metas.clear();
  cargar();
}

// ---------- Teclado del PIN (4 cifras) ----------
function pedirPin(perfil, titulo) {
  return new Promise((listo) => {
    const p = pantallaPerfiles();
    p.innerHTML = '';
    if (perfil) p.append(avatarHtml(perfil, 'grande'));
    p.append(el('h2', null, titulo));
    const puntos = el('div', 'pin-puntos');
    for (let n = 0; n < 4; n++) puntos.append(el('span'));
    const fallo = el('div', 'pin-error', (perfil && perfil.error) || '');
    p.append(puntos, fallo);
    let pin = '';
    const pintarPuntos = () => [...puntos.children].forEach((s, n) => s.classList.toggle('lleno', n < pin.length));
    const terminar = (valor) => { document.removeEventListener('keydown', teclas, true); listo(valor); };
    const pulsar = (c) => {
      if (c === '⌫') pin = pin.slice(0, -1);
      else if (pin.length < 4) pin += c;
      fallo.textContent = '';
      pintarPuntos();
      if (pin.length === 4) setTimeout(() => terminar(pin), 150);
    };
    const teclado = el('div', 'pin-teclado');
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '✕', '0', '⌫'].forEach((c) => {
      const b = el('button', 'pin-tecla', c);
      b.onclick = () => (c === '✕' ? terminar(null) : pulsar(c));
      if (c === '✕') b.title = 'Volver';
      teclado.append(b);
    });
    p.append(teclado);
    // Números del teclado o del mando; Atrás vuelve
    function teclas(e) {
      if (/^\d$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); pulsar(e.key); }
      else if (e.keyCode >= 48 && e.keyCode <= 57) { e.preventDefault(); e.stopPropagation(); pulsar(String(e.keyCode - 48)); }
      else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); pulsar('⌫'); }
      else if (e.key === 'Escape' || e.key === 'GoBack' || e.keyCode === 10009 || e.keyCode === 461) { e.preventDefault(); e.stopPropagation(); terminar(null); }
    }
    document.addEventListener('keydown', teclas, true);
    teclado.children[0].focus();
  });
}

// ---------- Crear o editar un perfil ----------
function formularioPerfil(perfil, pinActual) {
  const p = pantallaPerfiles();
  p.innerHTML = '';
  const avatares = catalogoPerfiles.avatares;
  const colores = catalogoPerfiles.colores;
  const elegido = { avatar: perfil ? perfil.avatar : avatares[Math.floor(Math.random() * avatares.length)],
    color: perfil ? perfil.color : colores[Math.floor(Math.random() * colores.length)] };
  p.append(el('h1', null, perfil ? 'Editar perfil' : 'Nuevo perfil'));
  const muestra = avatarHtml(elegido, 'grande');
  p.append(muestra);
  const form = el('form', 'perfil-form');
  const campo = (texto, input) => { const l = el('label', null, texto); l.append(input); form.append(l); return input; };
  const nombreIn = campo('Nombre', Object.assign(el('input'), { maxLength: 20, value: perfil ? perfil.nombre : '', placeholder: 'Por ejemplo: Mamá', autocomplete: 'off' }));
  const fila = (lista, clase, alElegir) => {
    const f = el('div', `elegir ${clase}`);
    lista.forEach((v) => {
      const b = el('button', 'opcion', clase === 'avatares' ? v : '');
      b.type = 'button';
      if (clase === 'colores') b.style.background = v;
      b.onclick = () => { alElegir(v); [...f.children].forEach((x) => x.classList.toggle('activa', x === b)); };
      if (v === elegido.avatar || v === elegido.color) b.classList.add('activa');
      f.append(b);
    });
    form.append(f);
  };
  form.append(el('div', 'etiqueta', 'Avatar'));
  fila(avatares, 'avatares', (v) => { elegido.avatar = v; muestra.textContent = v; });
  form.append(el('div', 'etiqueta', 'Color'));
  fila(colores, 'colores', (v) => { elegido.color = v; muestra.style.background = v; });
  const pinIn = campo(perfil ? 'PIN nuevo (déjalo vacío para no cambiarlo)' : 'PIN de 4 números',
    Object.assign(el('input'), { type: 'password', inputMode: 'numeric', maxLength: 4, pattern: '\\d{4}', autocomplete: 'new-password' }));
  const pin2In = campo('Repite el PIN', Object.assign(el('input'), { type: 'password', inputMode: 'numeric', maxLength: 4, autocomplete: 'new-password' }));
  const error = el('div', 'pin-error');
  form.append(error);
  const botones = el('div', 'perfil-botones');
  const guardar = el('button', 'boton boton-principal', perfil ? 'Guardar' : 'Crear perfil');
  guardar.type = 'submit';
  const volver = el('button', 'boton', 'Cancelar');
  volver.type = 'button';
  volver.onclick = () => elegirPerfil(!!perfil);
  botones.append(guardar, volver);
  if (perfil) {
    const borrar = el('button', 'boton boton-peligro', 'Borrar perfil');
    borrar.type = 'button';
    borrar.onclick = async () => {
      if (!confirm(`¿Borrar el perfil de ${perfil.nombre}? Se pierden su lista y su progreso.`)) return;
      try {
        await enviar('/api/perfil-borrar', { pin: pinActual });
        yo = null;
        pintarPerfilActual();
        elegirPerfil();
      } catch (e) { error.textContent = e.message; }
    };
    botones.append(borrar);
  }
  form.append(botones);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const nombre = nombreIn.value.trim();
    if (!nombre) return (error.textContent = 'Pon un nombre');
    if ((!perfil || pinIn.value) && !/^\d{4}$/.test(pinIn.value)) return (error.textContent = 'El PIN tiene que ser de 4 números');
    if (pinIn.value !== pin2In.value) return (error.textContent = 'Los dos PIN no coinciden');
    guardar.disabled = true;
    try {
      if (perfil) {
        await enviar('/api/perfil-editar', { pinActual, nombre, avatar: elegido.avatar, color: elegido.color, pin: pinIn.value || undefined });
        yo = await api('/api/yo');
        pintarPerfilActual();
        elegirPerfil(true);
      } else {
        await enviar('/api/perfil-crear', { nombre, avatar: elegido.avatar, color: elegido.color, pin: pinIn.value });
        yo = await api('/api/yo');
        cerrarPerfiles();
        pintarPerfilActual();
        cargar();
      }
    } catch (err) {
      error.textContent = err.message;
      guardar.disabled = false;
    }
  };
  p.append(form);
  nombreIn.focus();
}

// ---------- Perfil en la barra de arriba ----------
function pintarPerfilActual() {
  let b = $('#perfil-actual');
  if (!b) {
    b = el('button', 'boton');
    b.id = 'perfil-actual';
    b.title = 'Cambiar de perfil';
    b.onclick = async () => {
      await enviar('/api/perfil-salir').catch(() => {});
      yo = null;
      pintarPerfilActual();
      pintarPestanas();
      elegirPerfil();
    };
    $('header').insertBefore(b, $('#salir-app'));
  }
  b.hidden = !yo;
  b.innerHTML = '';
  if (yo) b.append(avatarHtml(yo, 'mini-avatar'), el('span', 'txt', yo.nombre));
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
    for (const [id, v] of Object.entries(VISTAS_PERFIL)) {
      const b = el('button', 'pestana', v.corto);
      b.dataset.vista = id;
      b.onclick = () => irA(estado.prefijo === `:${id}` ? '' : `:${id}`);
      nav.append(b);
    }
    $('#directo').after(nav);
  }
  nav.hidden = !yo;
  nav.querySelectorAll('button').forEach((b) => b.classList.toggle('activa', estado.prefijo === `:${b.dataset.vista}`));
}

function pintarVistaPerfil(vista) {
  const items = $('#items');
  items.className = 'rejilla';
  items.innerHTML = '';
  if (!yo) return;
  if (vista === 'seguir') {
    const lista = Object.keys(yo.posiciones)
      .map((key) => Object.assign({ key }, yo.posiciones[key]))
      .filter((p) => p.t > 0)
      .sort((a, b) => b.cuando - a.cuando)
      .map((p) => ({ key: p.key, tamano: p.tamano, fecha: p.fecha }));
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

function tarjetaPerfil(f, alPulsar, carpeta) {
  const [, , icono] = tipo(f.key);
  const t = tarjeta({ icono: carpeta ? '📁' : icono, titulo: nombre(f.key), meta: carpeta ? 'Serie' : (f.tamano ? bytes(f.tamano) : ''), alPulsar });
  t.classList.add('de-perfil');
  if (!carpeta) { t.dataset.key = f.key; if (f.tamano) t.dataset.tamano = f.tamano; barraVisto(t); }
  conMeta(t, carpeta ? 'carpeta' : 'archivo', f.key);
  estrella(t, f.key, carpeta ? null : f);
  return t;
}
