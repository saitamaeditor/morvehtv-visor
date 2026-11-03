// ---------- Favoritos y «Seguir viendo» ----------
// Una sola lista para todos (sin perfiles ni PIN), guardada en el servidor: es la misma en la web,
// el móvil y la tele.
let yo = null; // { id, nombre, favoritos: [...], posiciones: {...} }

async function enviar(ruta, datos) {
  const r = await fetch(ruta, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(datos || {}),
  });
  const d = await r.json();
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
  cargar();
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
