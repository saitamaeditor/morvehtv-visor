const $ = (s) => document.querySelector(s);
const estado = { prefijo: '', carpetas: [], archivos: [], token: null };

const TIPOS = [
  [/\.(url|strm)$/i, 'enlace', '🔗'],
  [/\.(mp4|m4v|webm|mov|mkv|ogv)$/i, 'video', '🎬'],
  [/\.(avi|ts|wmv|flv)$/i, 'video-raro', '🎞️'],
  [/\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i, 'imagen', '🖼️'],
  [/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i, 'audio', '🎵'],
  [/\.pdf$/i, 'pdf', '📕'],
  [/\.(txt|json|srt|vtt|md|csv|log|m3u8?|xml|html?|js|css|nfo|ini|yml|yaml)$/i, 'texto', '📄'],
  [/\.(zip|rar|7z|tar|gz)$/i, 'archivo', '🗜️'],
];
const tipo = (key) => (TIPOS.find(([re]) => re.test(key)) ?? [null, 'otro', '📦']);

const nombre = (key) => key.replace(/\/$/, '').split('/').pop();
const bytes = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};
const fecha = (f) => new Date(f).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });

// (la cadena se monta a mano: las teles antiguas no aceptan un objeto en URLSearchParams)
// (un valor que sea una lista se repite: key=a&key=b)
const consulta = (params = {}) => Object.keys(params).map((k) => [].concat(params[k]).map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')).join('&');

async function api(ruta, params) {
  const r = await fetch(`${ruta}?${consulta(params)}`, { credentials: 'same-origin' });
  const d = await r.json();
  // Sin sesión (caducó, o se cerró desde otro aparato): a la pantalla de entrar
  if (r.status === 401) { location.replace('/entrar.html'); throw new Error(d.error); }
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

function aviso(t, ms = 2000) {
  const a = $('#aviso'); a.textContent = t; a.style.display = 'block';
  clearTimeout(aviso.t); aviso.t = setTimeout(() => (a.style.display = 'none'), ms);
}

// ---------- Navegación ----------
function irA(prefijo) {
  location.hash = encodeURIComponent(prefijo);
}

// Cada carga lleva un número: si mientras llega la respuesta ha empezado otra (cambiar dos veces
// de carpeta muy seguido, doble pulsación en «Cargar más»…), la vieja se descarta. Antes
// las dos se sumaban a la lista y los archivos salían duplicados.
let cargaActual = 0;

async function cargar(mas = false) {
  if (mas && cargar.ocupado) return;
  const n = ++cargaActual;
  const items = $('#items');
  pintarPestanas();
  // «Seguir viendo» y «Favoritos» (pestañas de arriba): la lista común, no carpetas de e2
  if (estado.prefijo.startsWith(':')) {
    $('#cabecera').hidden = true; $('#mas').hidden = true;
    pintarMigas();
    return pintarVistaPerfil(estado.prefijo.slice(1));
  }
  if (!mas) {
    estado.carpetas = []; estado.archivos = []; estado.token = null;
    items.innerHTML = '<div class="vacio">Cargando…</div>';
    pintarCabecera(estado.prefijo);
  }
  pintarMigas();
  cargar.ocupado = true;
  try {
    const d = await api('/api/listar', { prefijo: estado.prefijo, token: estado.token ?? '' });
    if (n !== cargaActual) return;
    // Y por si acaso, nada que ya esté en la lista vuelve a entrar
    const hay = new Set(estado.carpetas.concat(estado.archivos.map((f) => f.key)));
    estado.carpetas.push(...d.carpetas.filter((c) => !hay.has(c)));
    estado.archivos.push(...d.archivos.filter((f) => !hay.has(f.key)));
    estado.token = d.siguiente;
    // Mientras suena la intro no se dibuja la portada (los datos ya se han pedido): así la
    // intro va fluida en la tele y el móvil
    if (window.morvehIntroFin) { await window.morvehIntroFin; window.morvehIntroFin = null; }
    pintar();
  } catch (e) {
    if (n === cargaActual) items.innerHTML = `<div class="vacio error">No se pudo leer el bucket: ${e.message}</div>`;
  } finally {
    if (n === cargaActual) cargar.ocupado = false;
  }
}

// Ruta de navegación: una sola fila de «pastillas» (Inicio › Sección › Serie › Temporada) con la
// carpeta actual resaltada. Los nombres largos se recortan con «…» (el nombre entero sale al
// pasar el ratón) y, si no cabe todo, la fila se desliza de lado mostrando siempre el final.
function pintarMigas() {
  const partes = estado.prefijo.split('/').filter(Boolean);
  const m = $('#migas'); m.innerHTML = '';
  // En el inicio la ruta sobra (solo diría «Inicio»): la pestaña ya lo marca
  m.hidden = !partes.length && !estado.prefijo.startsWith(':');
  const separador = () => { const s = el('span', 'sep', '›'); s.setAttribute('aria-hidden', 'true'); m.append(s); };
  const enlace = (texto, pref, actual) => {
    // Con href: así el enlace recibe el foco del mando y se abre con OK
    const a = document.createElement('a'); a.textContent = texto; a.title = texto; a.href = `#${encodeURIComponent(pref)}`;
    if (actual) { a.className = 'actual'; a.setAttribute('aria-current', 'page'); }
    m.append(a);
  };
  const casa = document.createElement('a'); casa.href = '#'; casa.className = 'casa'; casa.title = 'Inicio';
  casa.innerHTML = '<span aria-hidden="true">🏠</span><span class="txt-casa">Inicio</span>';
  m.append(casa);
  if (estado.prefijo.startsWith(':')) {
    separador();
    m.append(el('span', 'actual', VISTAS_PERFIL[estado.prefijo.slice(1)]?.titulo ?? ''));
  } else {
    partes.forEach((p, i) => { separador(); enlace(p, partes.slice(0, i + 1).join('/') + '/', i === partes.length - 1); });
  }
  // Que se vea siempre dónde estás (el final de la ruta)
  requestAnimationFrame(() => { m.scrollLeft = m.scrollWidth; });
}
// La cabecera, transparente sobre el destacado de la portada, se vuelve sólida al bajar
window.addEventListener('scroll', () => document.documentElement.classList.toggle('bajado', window.scrollY > 40), { passive: true });
// (también al girar el móvil o cambiar el tamaño de la ventana)
window.addEventListener('resize', () => { const m = $('#migas'); if (m && !m.hidden) m.scrollLeft = m.scrollWidth; });

// Orden natural hecho a mano («Episodio 2» antes que «Episodio 10»): el { numeric: true } de
// localeCompare no existe en los navegadores de muchas teles y allí salía E1, E10, E11, E2…
const trozos = (s) => s.toLowerCase().match(/\d+|\D+/g) ?? [];
function natural(a, b) {
  const x = trozos(a), y = trozos(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const nx = /^\d/.test(x[i]), ny = /^\d/.test(y[i]);
    const d = nx && ny ? Number(x[i]) - Number(y[i]) : nx !== ny ? (nx ? -1 : 1) : x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0;
    if (d) return d;
  }
  return x.length - y.length;
}

// Temporada y episodio sacados del nombre («S01E02», «1x02», «T1E2»): ordenan los capítulos
// aunque cada archivo esté nombrado de una forma
function capitulo(k) {
  const m = nombre(k).match(/(?:^|[^a-z0-9])(?:s(\d{1,2})[ ._-]?e(\d{1,3})|(\d{1,2})x(\d{2,3})(?!\d)|t(\d{1,2})[ ._-]?e(\d{1,3}))/i);
  if (!m) return null;
  const n = m.slice(1).filter(Boolean).map(Number);
  return n[0] * 1000 + n[1];
}

function porCapitulo(a, b) {
  const x = capitulo(a), y = capitulo(b);
  if (x !== null && y !== null && x !== y) return x - y;
  if ((x === null) !== (y === null)) return x === null ? 1 : -1;
  // Por el nombre del archivo y no por la ruta: con todo junto, las películas de distintas
  // subcarpetas («PELICULAS NETFLIX», «PELICULAS NETFLIX ANIME»…) se mezclan por título
  return natural(nombre(a), nombre(b)) || natural(a, b);
}

// Por temporada y episodio, si no por nombre en orden natural, y sin las carpetas internas
// que empiezan por «_»
function visibles() {
  const interna = (k) => k.slice(estado.prefijo.length).split('/').some((p) => p.startsWith('_'));
  const carpetas = estado.carpetas.filter((c) => !nombre(c).startsWith('_')).sort((a, b) => natural(nombre(a), nombre(b)) || natural(a, b));
  const archivos = estado.archivos.filter((f) => !interna(f.key)).sort((x, y) => porCapitulo(x.key, y.key));
  return { carpetas, archivos };
}

function pintar() {
  const { carpetas, archivos } = visibles();
  const items = $('#items');
  items.className = 'rejilla';
  items.innerHTML = '';
  document.documentElement.classList.toggle('en-portada', !estado.prefijo);
  const raiz = estado.prefijo && estado.prefijo.split('/').filter(Boolean).length === 1;
  // Cabecera de la biblioteca al entrar en una categoría (como en un servidor multimedia)
  if (raiz) {
    const cat = categoriasDe([estado.prefijo])[0].cat;
    const cab = el('div', 'biblioteca');
    cab.style.setProperty('--c', cat.color);
    const n = carpetas.length + archivos.length;
    cab.append(el('span', 'biblioteca-icono', cat.icono), el('h1', null, cat.nombre),
      el('span', 'biblioteca-cuenta', `${n}${estado.token ? '+' : ''} ${n === 1 ? 'título' : 'títulos'}`));
    items.append(cab);
  }

  if (!estado.prefijo) {
    pintarInicio(carpetas, archivos);
    $('#mas').hidden = true;
    const conMando = esTele || document.documentElement.classList.contains('usa-mando');
    if (conMando && actual < 0 && (!document.activeElement || document.activeElement === document.body)) moverFoco('abajo');
    return;
  }
  // Plan Básico: un anuncio a lo ancho encima de la carpeta
  const banner = typeof anuncioBanner === 'function' && anuncioBanner('carpeta');
  if (banner) items.append(banner);
  for (const c of carpetas) {
    const t = tarjeta({ icono: '📁', titulo: nombre(c), meta: 'Carpeta', alPulsar: () => irA(c), nuevo: [...nuevas].some((k) => k.startsWith(c)) });
    items.append(t);
    conMeta(t, 'carpeta', c); estrella(t, c);
  }
  archivos.forEach((f, i) => {
    const [, clase, icono] = tipo(f.key);
    const t = tarjeta({ icono, titulo: nombre(f.key), miniatura: f.miniatura, meta: bytes(f.tamano), alPulsar: () => abrir(i, archivos), nuevo: nuevas.has(f.key) });
    t.querySelector('.meta').append(el('span', 'fecha', ` · ${fecha(f.fecha)}`));
    t.dataset.key = f.key;
    t.dataset.tamano = f.tamano;
    barraVisto(t);
    items.append(t);
    if (clase.startsWith('video')) { conMeta(t, 'archivo', f.key); estrella(t, f.key, f); }
  });
  if (!carpetas.length && !archivos.length) items.innerHTML = '<div class="vacio">No hay nada aquí.</div>';
  $('#mas').hidden = !estado.token;
  // En la tele siempre hay algo con foco para que el mando funcione desde el principio
  const conMando = esTele || document.documentElement.classList.contains('usa-mando');
  if (conMando && actual < 0 && (!document.activeElement || document.activeElement === document.body)) moverFoco('abajo');
}

// ---------- Inicio: filas que se deslizan hacia los lados ----------
// «Mis medios» (las categorías), «Seguir viendo», «Favoritos» y, por cada categoría, lo último
// que has subido. Cada fila es un carrusel: con el ratón o el dedo se desliza y con el mando
// ← → pasan de una tarjeta a otra.
function fila(titulo, irAlPulsar, clase = '') {
  const s = el('section', 'fila');
  const h = el('h2', 'fila-titulo');
  if (irAlPulsar) {
    const a = el('a', null, titulo); a.href = '#'; a.onclick = (e) => { e.preventDefault(); irAlPulsar(); };
    const todo = el('span', 'ver-todo', 'Ver todo ›');
    a.append(todo);
    h.append(a);
  } else h.textContent = titulo;
  const c = el('div', `carrusel ${clase}`.trim());
  // Flechas ‹ › a los lados (con ratón): pasan una pantalla de la fila
  const caja = el('div', 'carrusel-caja');
  const ant = el('button', 'flecha-fila izq', '‹'); ant.setAttribute('aria-label', 'Anteriores'); ant.tabIndex = -1;
  const sig = el('button', 'flecha-fila der', '›'); sig.setAttribute('aria-label', 'Siguientes'); sig.tabIndex = -1;
  const mover = (dir) => c.scrollBy({ left: dir * c.clientWidth * 0.85, behavior: 'smooth' });
  ant.onclick = () => mover(-1); sig.onclick = () => mover(1);
  const pintarFlechas = () => {
    ant.classList.toggle('oculta', c.scrollLeft < 8);
    sig.classList.toggle('oculta', c.scrollLeft + c.clientWidth > c.scrollWidth - 8);
  };
  c.addEventListener('scroll', pintarFlechas, { passive: true });
  setTimeout(pintarFlechas, 400); setTimeout(pintarFlechas, 2500);
  caja.append(ant, c, sig);
  s.append(h, caja);
  return { s, c };
}

// ---------- Destacado de la portada ----------
// Un cartel grande con el fondo de lo último que has subido (con ficha de TMDB): título, datos,
// sinopsis y «▶ Reproducir» / «ℹ Más información». Cambia solo cada 9 s (se para mientras el
// ratón o el mando está encima) y tiene puntitos para elegir.
let rotarDestacado = null;
async function pintarDestacado(caja, d, carpetas) {
  clearInterval(rotarDestacado);
  // Los 2 más nuevos de cada categoría, del más nuevo al más antiguo
  const cand = [];
  for (const { suyas } of categoriasDe(carpetas)) {
    const e = d.carpetas.find((x) => x.carpeta === suyas[0]);
    if (e) cand.push(...e.titulos.slice(0, 2));
  }
  cand.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const fichas = await Promise.all(cand.slice(0, 12).map(async (x) => ({ x, m: await pedirMeta(x.tipo === 'carpeta' ? 'carpeta' : 'archivo', x.key) })));
  const con = fichas.filter((f) => f.m && f.m.encontrado && f.m.fondo).slice(0, 6);
  if (!con.length || !caja.isConnected) return;
  caja.innerHTML = '';
  const fondos = el('div', 'destacado-fondos');
  const texto = el('div', 'destacado-texto');
  const puntos = el('div', 'destacado-puntos');
  caja.append(fondos, texto, puntos);
  let i = 0;
  const imgs = con.map((f) => { const im = el('div', 'destacado-img'); im.style.backgroundImage = `url("${f.m.fondo.replace(/\/t\/p\/w\d+\//, '/t/p/w1280/')}")`; fondos.append(im); return im; });
  const pts = con.map((f, n) => { const p = el('button', 'punto'); p.setAttribute('aria-label', `Destacado ${n + 1}`); p.tabIndex = -1; p.onclick = () => ver(n, true); puntos.append(p); return p; });
  function ver(n, aMano) {
    i = (n + con.length) % con.length;
    imgs.forEach((im, k) => im.classList.toggle('visible', k === i));
    pts.forEach((p, k) => p.classList.toggle('activo', k === i));
    const { x, m } = con[i];
    const serie = x.tipo === 'carpeta';
    texto.innerHTML = '';
    texto.append(el('span', 'destacado-etiqueta', serie ? 'SERIE · NUEVO EN MORVEHTV' : 'NUEVO EN MORVEHTV'), el('h1', null, m.titulo));
    const datos = [m.valoracion && `★ ${Number(m.valoracion).toFixed(1)}`, m.anio,
      serie ? (m.temporadas && `${m.temporadas} temporada${m.temporadas > 1 ? 's' : ''}`) : m.duracion && `${Math.floor(m.duracion / 60) ? `${Math.floor(m.duracion / 60)} h ` : ''}${m.duracion % 60} min`,
      (m.generos || []).slice(0, 3).join(' · ')].filter(Boolean);
    texto.append(el('div', 'destacado-datos', datos.join('   ·   ')));
    if (m.sinopsis) texto.append(el('p', 'destacado-sinopsis', m.sinopsis));
    const bs = el('div', 'destacado-botones');
    const ver1 = el('button', 'boton reproducir', '▶ Reproducir');
    ver1.onclick = () => (serie ? irA(x.key) : abrir(0, [x]));
    const info = el('button', 'boton info', 'ℹ Más información');
    info.onclick = () => (serie ? irA(x.key) : abrir(0, [x], { ficha: true }));
    bs.append(ver1, info);
    texto.append(bs);
    if (aMano) reiniciar();
  }
  function reiniciar() {
    clearInterval(rotarDestacado);
    rotarDestacado = setInterval(() => {
      if (!caja.isConnected) return clearInterval(rotarDestacado);
      if (caja.matches(':hover') || caja.contains(document.activeElement) || actual >= 0) return;
      ver(i + 1);
    }, 9000);
  }
  ver(0);
  reiniciar();
  caja.hidden = false;
}

let catalogoPedido = null;
function pintarInicio(carpetas, archivos) {
  const items = $('#items');
  items.className = 'inicio';
  // Cartel destacado arriba (se rellena cuando llega el catálogo)
  const destacado = el('section', 'destacado');
  destacado.hidden = true;
  items.append(destacado);
  const medios = fila('Mis medios', null, 'medios');
  medios.c.append(...portada(carpetas).children);
  items.append(medios.s);
  // Plan Básico: un anuncio debajo de las categorías
  const banner = typeof anuncioBanner === 'function' && anuncioBanner('inicio');
  if (banner) items.append(banner);

  // Seguir viendo (imagen apaisada, con la barra de lo visto) y Favoritos, si se pudo leer la lista
  if (typeof yo !== 'undefined' && yo) {
    const seguir = listaSeguir();
    if (seguir.length) {
      const f = fila('Seguir viendo', () => irA(':seguir'), 'anchas');
      seguir.slice(0, 20).forEach((x, i) => f.c.append(tarjetaPerfil(x, () => abrir(i, seguir), false, true)));
      items.append(f.s);
    }
    if (yo.favoritos.length) {
      const f = fila('Favoritos', () => irA(':favoritos'));
      const sueltos = yo.favoritos.filter((x) => x.tipo === 'archivo');
      yo.favoritos.slice(0, 20).forEach((x) => f.c.append(x.tipo === 'carpeta'
        ? tarjetaPerfil(x, () => irA(x.key), true)
        : tarjetaPerfil(x, () => abrir(sueltos.indexOf(x), sueltos))));
      items.append(f.s);
    }
  }

  // Últimos añadidos de cada categoría, en el mismo orden que «Mis medios»
  const sitio = el('div', 'ultimos');
  items.append(sitio);
  // Solo los 20 últimos de cada categoría: con mucho contenido el catálogo entero pesaría demasiado
  catalogoPedido = catalogoPedido || api('/api/catalogo', { max: 20 }).catch(() => null);
  const pedido = catalogoPedido;
  pedido.then((d) => {
    if (catalogoPedido === pedido) catalogoPedido = null; // la próxima vez, datos frescos
    if (!d || estado.prefijo || !sitio.isConnected) return;
    pintarDestacado(destacado, d, carpetas).catch(() => {});
    let filasPuestas = 0;
    for (const { cat, suyas } of categoriasDe(carpetas)) {
      const entrada = d.carpetas.find((x) => x.carpeta === suyas[0]);
      const titulos = entrada ? entrada.titulos.slice(0, 20) : [];
      if (!titulos.length) continue;
      const f = fila(`Últimos añadidos en ${cat.nombre}`, () => irA(suyas[0]));
      const pelis = titulos.filter((x) => x.tipo === 'archivo');
      for (const x of titulos) {
        if (x.tipo === 'carpeta') {
          const t = tarjeta({ icono: '📺', titulo: nombre(x.key), meta: '', alPulsar: () => irA(x.key), nuevo: nuevas.has(x.ultimo) });
          f.c.append(t); conMeta(t, 'carpeta', x.key);
        } else {
          const t = tarjeta({ icono: '🎬', titulo: nombre(x.key), meta: '', alPulsar: () => abrir(pelis.indexOf(x), pelis), nuevo: nuevas.has(x.key) });
          t.dataset.key = x.key; barraVisto(t);
          f.c.append(t); conMeta(t, 'archivo', x.key);
        }
      }
      sitio.append(f.s);
      // Y otro cada tres filas
      if (++filasPuestas % 3 === 0) { const b = typeof anuncioBanner === 'function' && anuncioBanner('fila'); if (b) sitio.append(b); }
    }
  });

  if (archivos.length) {
    const f = fila('Archivos sueltos');
    archivos.forEach((x, i) => {
      const [, , icono] = tipo(x.key);
      f.c.append(tarjeta({ icono, titulo: nombre(x.key), miniatura: x.miniatura, meta: bytes(x.tamano), alPulsar: () => abrir(i, archivos) }));
    });
    items.append(f.s);
  }
}

// ---------- Portada por categorías ----------
// Cada carpeta de primer nivel de e2 es UNA categoría, ni más ni menos: si creas, renombras o
// borras una carpeta en e2, la portada cambia igual (sola, en unos segundos). Las reglas solo
// ponen nombre bonito, icono, color y carteles de relleno según el nombre de la carpeta; van de
// la más concreta a la más general («PELICULAS ANIME» antes que «PELICULAS», «DOCUSERIES» o
// «SERIES TURCAS» antes que «SERIES»). Una carpeta que no encaje en ninguna sale con su nombre.
const CATEGORIAS = [
  { id: 'anime-pelicula', orden: 2, nombre: 'Películas anime', icono: '🍥', color: '#d6409f', es: (n) => /anime/.test(n) && /pelicul|cine|movie/.test(n) },
  { id: 'anime-serie', orden: 3, nombre: 'Series anime', icono: '🐉', color: '#8e4ec6', es: (n) => /anime/.test(n) && /serie/.test(n) },
  { id: 'anime', orden: 4, nombre: 'Anime', icono: '🍥', color: '#d6409f', es: (n) => /anime/.test(n) },
  { id: 'docuserie', orden: 6, nombre: 'Docuseries', icono: '🎞️', color: '#12a594', es: (n) => /docuserie/.test(n) },
  { id: 'documental', orden: 5, nombre: 'Documentales', icono: '🌍', color: '#30a46c', es: (n) => /documental/.test(n) },
  { id: 'novela-turca', orden: 8, nombre: 'Novelas turcas', icono: '🌙', color: '#ffb224', es: (n) => /novela|turc/.test(n) },
  { id: 'infantil', orden: 9, nombre: 'Infantil', icono: '🧸', color: '#0090ff', es: (n) => /infantil|kids|nin[oa]s|familia|dibujos/.test(n) },
  { id: 'programa', orden: 7, nombre: 'Programas de TV', icono: '📡', color: '#f76b15', es: (n) => /programa|\btv\b|reality/.test(n) },
  { id: 'serie', orden: 1, nombre: 'Series', icono: '📺', color: '#4f8cff', es: (n) => /serie/.test(n) },
  { id: 'pelicula', orden: 0, nombre: 'Películas', icono: '🎬', color: '#e5484d', es: (n) => /pelicul|cine|movie/.test(n) },
  { id: 'musica', orden: 10, nombre: 'Música', icono: '🎵', color: '#7c66dc', es: (n) => /music|concierto|karaoke/.test(n), sinNombre: true },
  { id: 'terror', orden: 11, nombre: 'Terror', icono: '👻', color: '#6e56cf', es: (n) => /terror|miedo/.test(n), sinNombre: true },
  { id: 'deporte', orden: 12, nombre: 'Deportes', icono: '⚽', color: '#29a383', es: (n) => /deporte|futbol|f1|motogp|baloncesto|tenis/.test(n), tmdb: 'pelicula', sinNombre: true },
];
const PALETA = ['#d6409f', '#8e4ec6', '#0090ff', '#00a2c7', '#29a383', '#e54d2e', '#e2a336', '#7c66dc'];

const limpiar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^\d+\s*[-_.]?\s*/, '').trim();
// «PELICULAS DE ACCION» → «Peliculas de accion» (el nombre tal cual, en minúsculas)
const comoNombre = (carpeta) => { const b = nombre(carpeta).replace(/^\d+\s*[-_.]?\s*/, '').toLowerCase(); return b.charAt(0).toUpperCase() + b.slice(1); };

// Las categorías de la portada, una por carpeta: Películas, Series… (su «orden») y detrás las
// demás por nombre. El nombre bonito va a la carpeta de nombre más simple de cada tipo («PELICULAS»
// se llama «Películas» aunque también exista «PELICULAS 4K», que sale como «Peliculas 4k»).
function categoriasDe(carpetas) {
  const usadas = new Set();
  const porSencillez = carpetas.filter((c) => !nombre(c).startsWith('_'))
    .sort((a, b) => limpiar(nombre(a)).length - limpiar(nombre(b)).length);
  const lista = porSencillez.map((c) => {
    const n = limpiar(nombre(c));
    const regla = CATEGORIAS.find((r) => r.es(n));
    let h = 0;
    for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    // El nombre bonito, solo para la primera carpeta de cada tipo y si la regla lo da (las de
    // música, terror… se llaman como tu carpeta); si no, el de la carpeta
    const bonito = regla && !regla.sinNombre && !usadas.has(regla.id);
    if (regla) usadas.add(regla.id);
    const cat = {
      id: `carpeta:${c}`,
      nombre: bonito ? regla.nombre : comoNombre(c),
      icono: regla ? regla.icono : '📁',
      color: regla ? regla.color : PALETA[h % PALETA.length],
      tmdb: regla ? regla.tmdb || regla.id : 'pelicula',
    };
    return { cat, suyas: [c], orden: regla ? regla.orden : 99, principal: bonito };
  });
  return lista.sort((a, b) => a.orden - b.orden || b.principal - a.principal || natural(a.cat.nombre, b.cat.nombre));
}

const tamanos = new Map();

// La imagen de cada categoría: el fondo de uno de tus títulos y hasta 3 carteles distintos
// (los de tus títulos primero; si hay menos, lo más popular de ese tipo en TMDB). Se eligen
// una vez por visita.
const artes = new Map();
function arteCategoria(cat, suyas) {
  if (!artes.has(cat.id)) {
    artes.set(cat.id, (async () => {
      const carteles = [];
      const fondos = [];
      for (const c of suyas) {
        // 12 vídeos al azar de la categoría (el servidor los elige sin mandar la lista entera)
        const d = await api('/api/buscar', { prefijo: c, q: '', azar: 12 }).catch(() => null);
        const videos = ((d && d.archivos) || []).filter((f) => tipo(f.key)[1].startsWith('video'));
        // Al azar, para que la portada cambie de una visita a otra
        videos.sort(() => Math.random() - 0.5);
        const metas = await Promise.all(videos.slice(0, 12).map((f) => pedirMeta('archivo', f.key)));
        for (const m of metas) {
          if (!m || !m.encontrado) continue;
          if (m.poster && carteles.indexOf(m.poster) < 0) carteles.push(m.poster);
          if (m.fondo && fondos.indexOf(m.fondo) < 0) fondos.push(m.fondo);
        }
      }
      if (carteles.length < 3 || !fondos.length) {
        const r = await api('/api/portada', { cat: cat.tmdb || cat.id }).catch(() => null);
        if (r) {
          (r.carteles || []).forEach((u) => { if (carteles.length < 3 && carteles.indexOf(u) < 0) carteles.push(u); });
          if (!fondos.length && r.fondos.length) fondos.push(r.fondos[Math.floor(Math.random() * r.fondos.length)]);
        }
      }
      return { carteles: carteles.slice(0, 3), fondo: fondos[0] || null };
    })());
  }
  return artes.get(cat.id);
}

const precargar = (url) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(url); i.onerror = () => ok(null); i.src = url; });

function portada(carpetas) {
  const caja = el('div', 'categorias');
  for (const { cat, suyas } of categoriasDe(carpetas)) {
    const t = el('div', 'cat');
    t.tabIndex = 0; t.setAttribute('role', 'button');
    t.style.setProperty('--c', cat.color);
    const meta = el('div', 'meta', 'Contando…');
    const abanico = el('div', 'abanico');
    const texto = el('div', 'texto');
    texto.append(el('div', 'icono', cat.icono), el('div', 'nombre', cat.nombre), meta);
    t.append(abanico, texto);
    t.title = suyas.map(nombre).join(', ');
    t.onclick = () => irA(suyas[0]);
    // Se precarga todo para que aparezca de golpe con un fundido, no a trozos
    arteCategoria(cat, suyas).then(async ({ carteles, fondo }) => {
      const [f, ...cs] = await Promise.all([fondo ? precargar(fondo) : null, ...carteles.map(precargar)]);
      if (f) { t.style.setProperty('--img', `url("${f}")`); t.classList.add('con-imagen'); }
      cs.filter(Boolean).forEach((u, i) => {
        const img = el('img', `cartel-cat c${i + 1}`);
        img.src = u; img.alt = '';
        abanico.append(img);
      });
      if (cs.some(Boolean)) t.classList.add('con-carteles');
    });
    // Archivos y espacio de la categoría (se calcula una vez por sesión)
    Promise.all(suyas.map((c) => {
      if (!tamanos.has(c)) tamanos.set(c, api('/api/tamano', { prefijo: c }).catch(() => null));
      return tamanos.get(c);
    })).then((r) => {
      const ok = r.filter(Boolean);
      const n = ok.reduce((s, d) => s + d.objetos, 0);
      meta.textContent = !ok.length ? nombre(suyas[0]) : n ? `${n} archivos · ${bytes(ok.reduce((s, d) => s + d.bytes, 0))}` : 'Vacía de momento';
      if (ok.length && !n) t.classList.add('sin-nada');
    });
    caja.append(t);
  }
  return caja;
}

function tarjeta({ icono, titulo, miniatura, meta, alPulsar, nuevo }) {
  const d = document.createElement('div'); d.className = 'item'; d.title = titulo;
  d.tabIndex = 0; d.setAttribute('role', 'button');
  const mini = document.createElement('div'); mini.className = 'mini';
  if (miniatura) {
    const img = document.createElement('img'); img.loading = 'lazy'; img.src = miniatura; img.alt = '';
    img.onerror = () => { mini.textContent = icono; };
    mini.append(img);
  } else mini.textContent = icono;
  const n = document.createElement('div'); n.className = 'nombre'; n.textContent = titulo;
  const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta;
  d.append(mini, n, m); d.onclick = alPulsar;
  if (nuevo) d.append(el('span', 'nuevo', 'NUEVO'));
  return d;
}

// ---------- Metadatos de TMDB ----------
// El servidor reconoce cada vídeo por su nombre y lo guarda en caché; aquí se piden de 4 en
// 4 para no saturar TMDB con carpetas grandes. Las de vídeos van en grupos de hasta 20 por
// petición (una carpeta con cientos de capítulos no lanza cientos de peticiones).
const metas = new Map();
let enVuelo = 0;
const cola = [];
let lote = null; // { keys: [], oks: {} } de fichas de vídeo esperando a salir juntas

function pedirMeta(clase, clave) {
  const id = `${clase}:${clave}`;
  if (!metas.has(id)) {
    metas.set(id, new Promise((ok) => {
      if (clase === 'carpeta') {
        cola.push(() => api('/api/meta-carpeta', { prefijo: clave }).catch(() => null).then(ok));
        return siguienteMeta();
      }
      if (!lote) {
        const l = lote = { keys: [], oks: {} };
        // Se juntan las que se piden casi a la vez (al pintar una carpeta)
        setTimeout(() => { if (lote === l) soltarLote(); }, 40);
      }
      lote.keys.push(clave); lote.oks[clave] = ok;
      if (lote.keys.length >= 20) soltarLote();
    }));
  }
  return metas.get(id);
}
function soltarLote() {
  const l = lote; lote = null;
  if (!l || !l.keys.length) return;
  cola.push(() => api('/api/metas', { key: l.keys }).catch(() => ({}))
    .then((d) => { l.keys.forEach((k) => l.oks[k](d[k] || null)); }));
  siguienteMeta();
}

function siguienteMeta() {
  while (enVuelo < 4 && cola.length) {
    enVuelo++;
    cola.shift()().finally(() => { enVuelo--; siguienteMeta(); });
  }
}

const tituloDe = (d) => d.episodio
  ? `T${d.episodio.temporada}·E${d.episodio.numero} · ${d.episodio.titulo}`
  : `${d.titulo}${d.anio && !d.titulo.includes(d.anio) ? ` (${d.anio})` : ''}`;

// Cambia la tarjeta del archivo por la carátula y el título de TMDB
// Con { ancha: true } usa la imagen apaisada (la del episodio o el fondo de la película)
// La ficha se pide cuando la tarjeta está a punto de verse en pantalla, no antes: en una
// carpeta con cientos de títulos solo se buscan los que de verdad se miran
const observador = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entradas) => entradas.forEach((e) => {
    if (!e.isIntersecting) return;
    observador.unobserve(e.target);
    const listo = e.target._alVer; e.target._alVer = null;
    if (listo) listo();
  }), { rootMargin: '600px 600px' })
  : null;
const cuandoSeVea = (t) => (observador ? new Promise((ok) => { t._alVer = ok; observador.observe(t); }) : Promise.resolve());

async function conMeta(t, clase, clave, { ancha = false } = {}) {
  await cuandoSeVea(t);
  if (!t.isConnected) return;
  const d = await pedirMeta(clase, clave);
  if (!d?.encontrado || !t.isConnected) return;
  const temp = d.temporada;
  const apaisada = d.episodio?.imagen ?? (ancha ? d.fondo : null);
  const imagen = apaisada ?? temp?.poster ?? d.poster;
  const mini = t.querySelector('.mini');
  if (imagen) {
    const img = el('img'); img.loading = 'lazy'; img.src = imagen; img.alt = '';
    const visto = mini.querySelector('.visto'); // la barra de lo que ya has visto se queda
    mini.replaceChildren(img);
    if (visto) mini.append(visto);
    mini.classList.add(apaisada ? 'ancha' : 'cartel');
    // Los episodios (imagen apaisada) van en tarjetas más anchas para que se lea el título
    if (d.episodio?.imagen) { t.classList.add('episodio'); const r = t.closest('.rejilla'); if (r) r.classList.add('con-episodios'); }
  }
  const meta = t.querySelector('.meta');
  const tam = t.dataset.tamano && bytes(Number(t.dataset.tamano));
  if (temp) {
    // Temporada: su póster, su nombre y cuántos episodios tiene
    t.querySelector('.nombre').textContent = temp.nombre;
    meta.textContent = [temp.valoracion && `★ ${temp.valoracion}`, temp.anio,
      temp.episodios && `${temp.episodios} episodios`].filter(Boolean).join(' · ');
    if (temp.sinopsis) meta.after(el('p', 'resumen', temp.sinopsis));
    return;
  }
  t.querySelector('.nombre').textContent = tituloDe(d);
  if (d.episodio) {
    // Episodio: duración, fecha de emisión y de qué va
    meta.textContent = [d.episodio.duracion && `${d.episodio.duracion} min`,
      d.episodio.fecha && new Date(d.episodio.fecha).toLocaleDateString('es-ES'), tam].filter(Boolean).join(' · ');
    if (d.episodio.sinopsis) meta.after(el('p', 'resumen', d.episodio.sinopsis));
    return;
  }
  // Película o serie: nota, año, duración o temporadas y géneros
  meta.textContent = [d.valoracion && `★ ${d.valoracion}`,
    d.tipo === 'serie' ? (d.temporadas && `${d.temporadas} temporada${d.temporadas > 1 ? 's' : ''}`) : d.duracion && `${d.duracion} min`,
    d.generos.slice(0, 2).join(', '), tam].filter(Boolean).join(' · ');
  if (d.sinopsis) meta.after(el('p', 'resumen', d.sinopsis));
}

// Cabecera con fondo, cartel y sinopsis al entrar en la carpeta de una serie
async function pintarCabecera(prefijo) {
  const c = $('#cabecera');
  c.hidden = true; c.innerHTML = '';
  // En «Serie/Temporada 2/» la cabecera es la de la serie con el póster y los datos de esa temporada
  const partes = prefijo.split('/').filter(Boolean);
  if (/^(?:temporada|season|temp|t|s)\s*\d{1,2}$/i.test(partes.at(-1) ?? '')) partes.pop();
  if (partes.length < 2) return;
  const d = await pedirMeta('carpeta', partes.length < prefijo.split('/').filter(Boolean).length ? prefijo : partes.join('/') + '/');
  if (!d?.encontrado || estado.prefijo !== prefijo) return;
  const f = fichaHtml(d, { clave: partes.join('/') + '/' });
  // «▶ Reproducir» (o «Reanudar» si ya empezaste algún episodio de aquí)
  const enlaces = f.querySelector('.cuerpo > .chips:not(.datos)');
  if (enlaces) {
    const b = el('button', 'boton reproducir', '▶ Reproducir');
    const pintarB = () => { const { archivos } = visibles(); b.textContent = archivos.some((x) => posicionDe(x.key)) ? '▶ Reanudar' : '▶ Reproducir'; };
    b.onclick = () => {
      const { carpetas, archivos } = visibles();
      const videos = archivos.filter((x) => tipo(x.key)[1].startsWith('video'));
      if (videos.length) {
        const i = videos.findIndex((x) => posicionDe(x.key));
        abrir(Math.max(0, i), videos);
      } else if (carpetas.length) irA(carpetas[0]); // una serie con temporadas: a la primera
    };
    enlaces.prepend(b);
    setTimeout(pintarB, 1500);
  }
  c.append(f);
  // Fondo grande arriba, que se funde con la página (el degradado lo pone la hoja de estilos)
  c.classList.toggle('con-fondo', !!d.fondo);
  c.style.backgroundImage = '';
  if (d.fondo) c.style.setProperty('--fondo-img', `url("${d.fondo}")`);
  c.hidden = false;
}

const pista = (p, n) => [(p.titulo || p.idioma || `Pista ${n + 1}`).toUpperCase(), p.codec].filter(Boolean).join(' · ');

// Ficha completa: datos de TMDB + datos técnicos del archivo (si se pasan)
function fichaHtml(d, { archivo, medio, clave } = {}) {
  const f = el('div', 'ficha');
  const poster = d?.encontrado && (d.temporada?.poster ?? d.poster ?? d.episodio?.imagen);
  if (poster) {
    const img = el('img', 'cartel'); img.src = poster; img.alt = ''; f.append(img);
  }
  const cuerpo = el('div', 'cuerpo');
  f.append(cuerpo);

  if (d?.encontrado) {
    cuerpo.append(el('h2', null, `${d.titulo}${d.anio ? ` (${d.anio})` : ''}`));
    if (d.tituloOriginal && d.tituloOriginal !== d.titulo) cuerpo.append(el('div', 'suave', d.tituloOriginal));
    const chips = el('div', 'chips datos');
    const chip = (t) => t && chips.append(el('span', 'chip', t));
    chip(d.valoracion && `★ ${d.valoracion}`);
    chip(d.tipo === 'serie' ? `Serie${d.temporadas ? ` · ${d.temporadas} temp.` : ''}` : 'Película');
    chip((d.episodio?.duracion ?? d.duracion) && `${d.episodio?.duracion ?? d.duracion} min`);
    d.generos.forEach(chip);
    cuerpo.append(chips);
    if (d.temporada) {
      const t = d.temporada;
      cuerpo.append(el('h3', null, [t.nombre, t.anio, t.episodios && `${t.episodios} episodios`, t.valoracion && `★ ${t.valoracion}`].filter(Boolean).join(' · ')));
      if (t.sinopsis) cuerpo.append(el('p', null, t.sinopsis));
    }
    if (d.episodio) {
      cuerpo.append(el('h3', null, `Temporada ${d.episodio.temporada} · Episodio ${d.episodio.numero}: ${d.episodio.titulo}`));
      if (d.episodio.fecha) cuerpo.append(el('div', 'suave', `Emitido el ${new Date(d.episodio.fecha).toLocaleDateString('es-ES')}`));
      if (d.episodio.sinopsis) cuerpo.append(el('p', null, d.episodio.sinopsis));
    }
    if (d.sinopsis) cuerpo.append(el('p', d.episodio || (d.temporada && d.temporada.sinopsis) ? 'suave' : null, d.sinopsis));
    const linea = (t, v) => {
      if (!v?.length) return;
      const l = el('div', 'linea');
      l.append(el('b', null, `${t}: `), v.join(', '));
      cuerpo.append(l);
    };
    linea('Dirección', d.direccion);
    linea('Creada por', d.creadores);
    linea('Reparto', d.reparto);
    // En el móvil la sinopsis y el reparto se recortan para que se vea antes lo de debajo
    const mas = el('button', 'boton ver-mas', 'Ver más ▾');
    mas.onclick = () => { const si = f.classList.toggle('entera'); mas.textContent = si ? 'Ver menos ▴' : 'Ver más ▾'; };
    cuerpo.append(mas);
    const enlaces = el('div', 'chips');
    if (d.trailer) enlaces.append(Object.assign(el('a', 'boton', '▶ Tráiler'), { href: d.trailer, target: '_blank', rel: 'noopener' }));
    // De dónde salen los datos: TMDB o, si no lo tenía, TVmaze, AniList o Wikipedia
    const web = d.web || d.tmdb;
    if (web) enlaces.append(Object.assign(el('a', 'boton', `${d.fuente || 'TMDB'} ↗`), { href: web, target: '_blank', rel: 'noopener' }));
    const objetivo = archivo ? archivo.key : clave;
    if (yo && objetivo) enlaces.prepend(botonFavorito(objetivo, archivo));
    cuerpo.append(enlaces);
  } else if (d) {
    cuerpo.append(el('h2', null, 'Sin datos en ninguna fuente'));
    cuerpo.append(el('p', 'suave', d.buscado ? `No se encontró «${d.buscado}». Puedes buscarlo a mano:` : 'Puedes buscarlo a mano:'));
  }

  if (archivo) {
    const tec = el('div', 'tecnico');
    const fila = (t, v) => v && tec.append(el('span', null, `${t}: ${v}`));
    fila('Archivo', archivo.key);
    fila('Tamaño', bytes(archivo.tamano));
    fila('Subido', fecha(archivo.fecha));
    if (medio) {
      fila('Duración', medio.duracion && hms(medio.duracion));
      fila('Vídeo', [medio.resolucion, medio.video].filter(Boolean).join(' · '));
      fila('Audio', medio.audios.map(pista).join(' | '));
      fila('Subtítulos', medio.subtitulos?.map(pista).join(' | '));
    }
    cuerpo.append(tec);
  }
  if (clave && d) cuerpo.append(corrector(clave, d));
  return f;
}

// «¿No es esta?»: busca en TMDB y guarda el título correcto para este vídeo o serie
function corrector(clave, d) {
  const caja = el('details', 'corrector');
  caja.append(el('summary', null, d.encontrado ? '¿No es esta? Corregir' : '🔎 Buscar en TMDB'));
  const fila = el('div', 'chips');
  const q = el('input'); q.type = 'search'; q.placeholder = 'Título…'; q.value = d.encontrado ? '' : (d.buscado ?? '');
  const sel = el('select');
  sel.append(new Option('Película o serie', ''), new Option('Película', 'pelicula'), new Option('Serie', 'serie'));
  const b = el('button', 'boton', 'Buscar');
  const res = el('div', 'resultados');
  fila.append(q, sel, b);
  caja.append(fila, res);
  const elegir = async (r) => {
    await api('/api/corregir', { key: clave, tmdbId: r.tmdbId, tipo: r.tipo });
    metas.clear();
    aviso(`Guardado: ${r.titulo}`);
    if (actual >= 0) abrir(actual); else pintarCabecera(estado.prefijo);
    pintar();
  };
  b.onclick = async () => {
    res.textContent = 'Buscando…';
    try {
      const lista = await api('/api/tmdb-buscar', { q: q.value, tipo: sel.value });
      res.innerHTML = '';
      if (!lista.length) res.textContent = 'Sin resultados.';
      for (const r of lista.slice(0, 12)) {
        const o = el('button', 'resultado');
        if (r.poster) { const i = el('img'); i.src = r.poster; i.alt = ''; o.append(i); }
        o.append(el('span', null, `${r.titulo}${r.anio ? ` (${r.anio})` : ''} · ${r.tipo === 'serie' ? 'Serie' : 'Película'}`));
        o.onclick = () => elegir(r);
        res.append(o);
      }
    } catch (e) { res.textContent = e.message; }
  };
  q.onkeydown = (e) => e.key === 'Enter' && b.click();
  return caja;
}

// ---------- Vista previa ----------
let actual = -1;
// Corta el vídeo anterior: su descarga y, si era convertido, el ffmpeg del servidor
function pararMedios() {
  document.querySelectorAll('#vcontenido .repro').forEach((r) => r.parar && r.parar());
  document.querySelectorAll('#vcontenido video, #vcontenido audio').forEach((m) => {
    m.pause(); m.removeAttribute('src'); m.load();
  });
}

const hms = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

const el = (etiqueta, clase, texto) => {
  const e = document.createElement(etiqueta);
  if (clase) e.className = clase;
  if (texto != null) e.textContent = texto;
  return e;
};

// La librería de vídeo (hls.js, ~400 KB) se carga al abrir el primer vídeo, no al arrancar
let hlsCargando = null;
function cargarHls() {
  if (window.Hls) return Promise.resolve();
  if (!hlsCargando) {
    hlsCargando = new Promise((ok) => {
      const s = document.createElement('script');
      s.src = '/vendor/hls.min.js';
      s.onload = ok;
      s.onerror = () => { hlsCargando = null; ok(); };
      document.head.appendChild(s);
    });
  }
  return hlsCargando;
}

// iPhone/iPad (Safari sin MediaSource clásico) reproducen HLS por sí mismos; el resto
// (Android, smart TV, ordenador) lo hace con hls.js
const hlsNativo = (v) => !(window.Hls && Hls.isSupported()) && !!v.canPlayType('application/vnd.apple.mpegurl');

// ---------- Modo cine: el vídeo a pantalla completa nada más darle a reproducir ----------
// Se pide la pantalla completa del navegador (o de la app Android) en el mismo toque/clic que
// abre el vídeo, porque los navegadores solo la permiten en respuesta a una acción tuya. Donde
// no existe (iPhone) el vídeo igualmente ocupa toda la pantalla. Al salir se vuelve a la ficha.
let cineReal = false;
const enPantallaCompleta = () => document.fullscreenElement || document.webkitFullscreenElement;

function entrarCine() {
  const visor = $('#visor');
  visor.classList.add('cine');
  despertar();
  if (enPantallaCompleta()) return;
  const pedir = visor.requestFullscreen || visor.webkitRequestFullscreen;
  if (!pedir) return;
  try {
    const p = pedir.call(visor);
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

function salirCine() {
  const visor = $('#visor');
  visor.classList.remove('cine', 'reposo');
  if (enPantallaCompleta()) {
    const salir = document.exitFullscreen || document.webkitExitFullscreen;
    try { const p = salir.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
}

// Esc, el botón Atrás de la app o el gesto del móvil sacan de la pantalla completa: se sale
// también del modo cine y se ve la ficha
function alCambiarPantalla() {
  const giro = screen.orientation;
  if (enPantallaCompleta()) {
    cineReal = true;
    // En el móvil, el vídeo se ve en horizontal (el navegador solo lo permite en pantalla completa)
    if (giro && giro.lock && matchMedia('(pointer: coarse)').matches) giro.lock('landscape').catch(() => {});
    return;
  }
  if (giro && giro.unlock) try { giro.unlock(); } catch (e) {}
  if (cineReal) { cineReal = false; $('#visor').classList.remove('cine', 'reposo'); }
}
document.addEventListener('fullscreenchange', alCambiarPantalla);
document.addEventListener('webkitfullscreenchange', alCambiarPantalla);

// Viendo el vídeo, a los 3 s se esconden los controles (botones, barra de progreso y la barra de
// arriba) y vuelven al mover el ratón, tocar la pantalla o pulsar el mando. Con ellos escondidos,
// tocar la pantalla solo los enseña (no pausa); con el mando, cualquier tecla los enseña.
let reposo = null;
let tocadoEnReposo = false;
function despertar() {
  const visor = $('#visor');
  visor.classList.remove('reposo');
  clearTimeout(reposo);
  reposo = setTimeout(() => {
    const v = document.querySelector('#vcontenido video');
    if (visor.classList.contains('cine') && v && !v.paused) visor.classList.add('reposo');
  }, 3000);
}
['mousemove', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if ($('#visor').classList.contains('cine')) despertar(); }, true));
document.addEventListener('pointerdown', () => {
  const visor = $('#visor');
  if (!visor.classList.contains('cine')) return;
  tocadoEnReposo = visor.classList.contains('reposo');
  despertar();
}, true);
document.addEventListener('click', (e) => {
  const enControl = e.target.closest && e.target.closest('.controles, .barra, .gran-play');
  if (tocadoEnReposo && !enControl && e.target.closest && e.target.closest('#visor')) { e.stopPropagation(); e.preventDefault(); }
  tocadoEnReposo = false;
}, true);
document.addEventListener('play', (e) => { if (e.target.closest && e.target.closest('#vcontenido')) despertar(); }, true);
document.addEventListener('pause', () => { clearTimeout(reposo); $('#visor').classList.remove('reposo'); }, true);

// Reproductor del vídeo convertido: el servidor prepara HLS desde el segundo pedido, así que
// la barra es propia. Saltar dentro de lo ya preparado es inmediato; más lejos, se pide de
// nuevo desde ese punto.
// Iconos dibujados (SVG) en vez de símbolos de texto: muchas teles y móviles no tienen ⟲ ⟳ ⛶ ❚❚
const ICONOS = {
  play: '<path d="M8 5v14l11-7z"/>',
  pausa: '<path d="M6 19h4V5H6v14zM14 5v14h4V5h-4z"/>',
  atras: '<path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>',
  adelante: '<g transform="matrix(-1 0 0 1 24 0)"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></g>',
  pantalla: '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>',
  anterior: '<path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>',
  siguiente: '<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>',
};
const icono = (n) => `<svg class="icono" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${ICONOS[n]}</svg>`;
function boton(clase, html, titulo) {
  const b = el('button', clase);
  b.innerHTML = html;
  if (titulo) { b.title = titulo; b.setAttribute('aria-label', titulo); }
  return b;
}

// Un solo reproductor para todo el contenido. Con «urlDirecto» lee el archivo tal cual de e2
// (MP4 que cualquier aparato abre: saltos instantáneos); sin él, el servidor lo prepara en HLS.
// ---------- Seguir viendo ----------
// La lista común recuerda por dónde iba en cada vídeo (se guarda en el servidor, así sigue igual en
// la tele, el móvil o el ordenador). Al terminarlo (últimos 2 min o el 95 %) se olvida.
function posicionDe(key) {
  const p = yo && yo.posiciones[key];
  return p && p.t > 0 ? p : null;
}
function guardarPosicion(key, t, total) {
  if (!yo) return;
  const acabado = total > 0 && (t > total - 120 || t > total * 0.95);
  const f = listaVisor.find((x) => x.key === key) || {};
  const borrar = t < 15 || acabado;
  if (borrar) delete yo.posiciones[key];
  else yo.posiciones[key] = { t: Math.floor(t), total: Math.floor(total || 0), cuando: Date.now(), tamano: f.tamano, fecha: f.fecha };
  enviar('/api/posicion', { key, t, total, borrar, tamano: f.tamano, fecha: f.fecha }).catch(() => {});
}

// Barra roja bajo la carátula con lo que ya has visto de ese vídeo
function barraVisto(t) {
  const mini = t.querySelector('.mini');
  const vieja = mini.querySelector('.visto');
  if (vieja) vieja.remove();
  const visto = posicionDe(t.dataset.key);
  if (!visto || !visto.total) return;
  const barra = el('div', 'visto');
  const lleno = el('span');
  lleno.style.width = `${Math.min(100, (visto.t / visto.total) * 100)}%`;
  barra.append(lleno);
  mini.append(barra);
}

// «renovar»: cómo conseguir otra vez la dirección si se corta (un enlace de e2 nuevo, por si caducó)
function reproductor(key, m, urlDirecto = null, renovar = () => api('/api/url', { key }).then((r) => r.url), opciones = {}) {
  const directo = !!urlDirecto;
  const caja = el('div', 'repro');
  // No arranca solo: se prepara en segundo plano y empieza cuando pulsas ▶
  const v = el('video'); v.playsInline = true; v.setAttribute('playsinline', '');
  v.tabIndex = -1; // puede recibir el foco del mando
  const barra = el('div', 'controles');
  const bGrande = boton('gran-play', icono('play'), 'Reproducir');
  if (!directo) cargarHls(); // se adelanta mientras el servidor prepara el vídeo
  bGrande.setAttribute('aria-label', 'Reproducir');
  const bPlay = boton('boton', icono('play'), 'Reproducir o pausar');
  const bAtras = boton('boton', `${icono('atras')}<span>10</span>`, 'Retroceder 10 segundos');
  const bAdelante = boton('boton', `<span>10</span>${icono('adelante')}`, 'Adelantar 10 segundos');
  // Duración: la de ffprobe o, si no la hay, la que dé el propio vídeo
  const total = () => m.duracion || (isFinite(v.duration) ? v.duration : 0);
  const rango = el('input'); rango.type = 'range'; rango.min = 0; rango.max = Math.floor(total()) || 0; rango.step = 10; rango.value = 0;
  const tiempo = el('span', 'tiempo', `0:00 / ${hms(total())}`);
  const bSonido = el('button', 'boton sonido', '🔊');
  const bPantalla = boton('boton', icono('pantalla'), 'Pantalla completa');
  // El idioma del audio va el primero, a la izquierda
  let selAudio = null;
  if (m.audios.length > 1) {
    selAudio = el('select', 'audio');
    selAudio.title = 'Idioma del audio';
    m.audios.forEach((a, n) => selAudio.append(new Option(`🗣 ${(a.titulo || a.idioma || `Pista ${n + 1}`).toUpperCase()}`, n)));
    // El idioma elegido en un capítulo se mantiene en el siguiente
    const pref = leerIdioma();
    const n = pref ? m.audios.findIndex((a) => (a.idioma || a.titulo || '').toLowerCase() === pref) : -1;
    if (n >= 0) selAudio.value = String(n);
    barra.append(selAudio);
  }
  // Todos los botones a la izquierda y, detrás, la barra de progreso con el tiempo
  barra.append(bPlay, bAtras, bAdelante, bSonido, bPantalla, rango, tiempo);
  // Sin avisos de carga («Preparando vídeo…», «Cargando…»): solo se usa para errores reales
  const cargando = el('div', 'cargando');
  cargando.hidden = true;
  caja.append(v, bGrande, cargando, barra);
  // Si ya lo habías empezado, sigue por donde te quedaste (con opción de empezar de cero)
  const guardada = posicionDe(key);
  const inicio = guardada ? guardada.t : 0;
  let bDeCero = null;
  if (guardada) {
    bDeCero = el('button', 'boton de-cero', `Seguir desde ${hms(inicio)} · ↺ Empezar de cero`);
    bDeCero.onclick = () => { bDeCero.remove(); guardarPosicion(key, 0, total()); ir(0, !v.paused); };
    caja.append(bDeCero);
  }

  let desde = 0;
  let sesion = null;
  let hls = null;
  let turno = 0;
  let arrastrando = false;
  let quiere = false; // se pulsó ▶ antes de que el vídeo estuviera listo
  const ahora = () => desde + v.currentTime;
  const preparado = () => (v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0);
  const parar = (id) => id && fetch(`/api/hls-parar?id=${id}`, { keepalive: true }).catch(() => {});

  // «inicio»: segundo de la lista por el que empezar (se prepara un poco antes del punto pedido).
  // «reproducir»: falso al recuperarse de un corte con el vídeo en pausa (sigue en pausa)
  function fuente(url, inicio, reproducir) {
    if (hls) { hls.destroy(); hls = null; }
    const arrancar = () => (reproducir || quiere) && v.play().catch(() => {});
    if (hlsNativo(v)) {
      v.src = url;
      v.addEventListener('loadedmetadata', () => { v.currentTime = inicio; }, { once: true });
      arrancar();
      return;
    }
    // Colchón de hasta 3 minutos ya descargados y reintentos generosos ante cortes de red
    hls = new Hls({
      startPosition: inicio, maxBufferLength: 120, maxMaxBufferLength: 180,
      fragLoadingMaxRetry: 8, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 8,
    });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, arrancar);
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
      // La sesión ya no existe (servidor reiniciado…): se prepara otra desde el mismo punto
      if (d.response && d.response.code === 404) return retomar();
      setTimeout(() => hls && hls.startLoad(), 1500);
    });
  }

  // Saltar de minuto o cambiar de idioma mantiene el estado: si estaba en pausa, sigue en pausa
  async function ir(t, reproducir = !v.paused) {
    t = Math.min(Math.max(0, t), Math.max(0, total() - 5));
    if (directo) {
      rango.value = t; pintarTiempo(t);
      v.currentTime = t;
      if (reproducir && v.paused) v.play().catch(() => {});
      return;
    }
    if (sesion && t >= desde && t - desde < preparado() - 2) { v.currentTime = t - desde; return; }
    const mio = ++turno;
    // El reloj y la barra marcan ya el minuto elegido mientras se prepara
    rango.value = t; pintarTiempo(t);
    try {
      // Empieza 20 s antes: así retroceder un poco es instantáneo
      const antes = Math.min(20, Math.floor(t));
      const r = await api('/api/hls', { key, desde: Math.floor(t) - antes, margen: antes, audio: selAudio ? selAudio.value : 0 });
      if (mio !== turno || !caja.isConnected) return parar(r.id);
      parar(sesion);
      sesion = r.id; desde = r.desde;
      await cargarHls();
      if (mio !== turno || !caja.isConnected) return;
      fuente(r.url, t - r.desde, reproducir);
    } catch (e) {
      if (mio === turno) { cargando.hidden = false; cargando.textContent = e.message; }
    }
  }
  const pintarTiempo = (t) => (tiempo.textContent = `${hms(t)} / ${hms(total())}`);
  v.onloadedmetadata = () => { rango.max = Math.floor(total()) || 0; pintarTiempo(ahora()); };

  // Se guarda por dónde vas cada 5 s, al pausar y al cerrar
  let ultimoGuardado = 0;
  const guardar = () => { if (ahora() > 0) guardarPosicion(key, ahora(), total()); };
  v.ontimeupdate = () => {
    if (caja.alProgreso) caja.alProgreso(ahora(), total());
    if (caja.alTiempo) caja.alTiempo(ahora(), total());
    if (!arrastrando) { rango.value = ahora(); pintarTiempo(ahora()); }
    if (!v.paused && Date.now() - ultimoGuardado > 5000) { ultimoGuardado = Date.now(); guardar(); }
  };
  // Si se queda esperando más de 15 s (corte de red, servidor reiniciado…), retoma solo
  // desde el mismo segundo en vez de quedarse parado
  let vigia = null;
  let intentos = 0;
  async function retomar() {
    clearTimeout(vigia);
    const t = ahora();
    const seguir = !v.paused;
    if (directo) {
      // Enlace nuevo de e2 (el anterior pudo caducar) y se sigue desde el mismo segundo
      if (intentos++ > 5) return;
      const url = await renovar().catch(() => null);
      if (!url || !caja.isConnected) return;
      if (hls) return fuente(url, t, seguir);
      v.src = url;
      v.addEventListener('loadedmetadata', () => { v.currentTime = t; if (seguir) v.play().catch(() => {}); }, { once: true });
      return;
    }
    parar(sesion); sesion = null;
    ir(t, seguir);
  }
  v.onerror = () => {
    if (!directo || !v.getAttribute('src')) return;
    if (v.error && v.error.code === 2) return retomar(); // error de red
    cargando.hidden = false; cargando.textContent = 'Este dispositivo no puede reproducir este formato.';
  };
  v.onwaiting = () => {
    clearTimeout(vigia);
    vigia = setTimeout(() => { if (caja.isConnected && !v.paused && v.readyState < 3) retomar(); }, 15000);
  };
  v.onplaying = () => { cargando.hidden = true; clearTimeout(vigia); intentos = 0; };
  v.onplay = () => { bPlay.innerHTML = icono('pausa'); bGrande.hidden = true; if (bDeCero) { bDeCero.remove(); bDeCero = null; } mantenerPantalla(true); if (caja.alSeguir) caja.alSeguir(); };
  v.onpause = () => { quiere = false; bPlay.innerHTML = icono('play'); bGrande.hidden = false; mantenerPantalla(false); guardar(); if (caja.alPausar) caja.alPausar(); };
  v.oncanplay = () => { cargando.hidden = true; };
  // La lista se va alargando mientras se prepara: si se alcanza el final provisional, se pide
  // más desde ese punto
  v.onended = () => {
    if (!directo && ahora() < total() - 10) return ir(ahora(), true);
    if (caja.alAcabar) caja.alAcabar();
  };
  const alternar = () => {
    if (v.paused) { quiere = true; v.play().catch(() => {}); } else { quiere = false; v.pause(); }
  };
  bGrande.onclick = alternar;
  bPlay.onclick = alternar;
  // En pantallas táctiles tocar la imagen solo enseña u oculta los controles (no pausa, como en
  // las apps de vídeo); con ratón, un clic sobre el vídeo sí pausa
  // Doble toque en el lado izquierdo o derecho: 10 s atrás o adelante (como en las apps de vídeo)
  let toque = { t: 0, lado: 0 };
  let saltoTactil = 0;
  v.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const r = v.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const lado = x < 0.38 ? -1 : x > 0.62 ? 1 : 0;
    const ms = Date.now();
    if (lado && toque.lado === lado && ms - toque.t < 350) {
      saltoTactil = ms; toque = { t: 0, lado: 0 };
      ir(ahora() + lado * 10);
      senalSalto(lado);
      despertar();
      return;
    }
    toque = { t: ms, lado };
  });
  function senalSalto(lado) {
    const s = el('div', `salto ${lado < 0 ? 'izq' : 'der'}`);
    s.innerHTML = lado < 0 ? `${icono('atras')}<span>10 s</span>` : `<span>10 s</span>${icono('adelante')}`;
    caja.append(s);
    setTimeout(() => s.remove(), 650);
  }
  v.onclick = () => {
    if (Date.now() - saltoTactil < 500) return;
    if (!matchMedia('(pointer: coarse)').matches) return alternar();
    const visor = $('#visor');
    if (visor.classList.contains('reposo') || v.paused) return despertar();
    visor.classList.add('reposo');
  };
  bAtras.onclick = () => ir(ahora() - 10);
  bAdelante.onclick = () => ir(ahora() + 10);
  rango.oninput = () => { arrastrando = true; pintarTiempo(Number(rango.value)); };
  rango.onchange = () => { arrastrando = false; ir(Number(rango.value)); };
  if (selAudio) selAudio.onchange = () => {
    const a = m.audios[Number(selAudio.value)];
    guardarIdioma(a && (a.idioma || a.titulo));
    const t = ahora(); parar(sesion); sesion = null; ir(t);
  };
  bSonido.onclick = () => { v.muted = !v.muted; bSonido.textContent = v.muted ? '🔇' : '🔊'; };
  bPantalla.onclick = () => ($('#visor').classList.contains('cine') ? salirCine() : entrarCine());
  caja.irA = ir;
  caja.saltar = (s) => ir(ahora() + s);
  caja.alternar = alternar;
  caja.controles = barra;
  caja.despues = bAdelante; // tras él van ⏮ ⏭ (los pone abrir())
  // Al pasar de capítulo se sigue viendo sin tener que pulsar ▶
  const solo = !!opciones.reproducir;
  if (solo) quiere = true;
  caja.parar = () => { if (v.currentTime > 0) guardar(); turno++; clearTimeout(vigia); mantenerPantalla(false); if (hls) hls.destroy(); hls = null; parar(sesion); sesion = null; };
  // Un stream HLS de otro sitio (.m3u8) va por hls.js; el resto, directo al <video>
  if (directo && /\.m3u8(\?|#|$)/i.test(urlDirecto)) cargarHls().then(() => caja.isConnected && fuente(urlDirecto, inicio, false));
  else if (directo) {
    v.preload = 'auto'; v.src = urlDirecto;
    if (inicio) v.addEventListener('loadedmetadata', () => { v.currentTime = inicio; }, { once: true });
    if (solo) v.play().catch(() => { quiere = false; });
  } else ir(inicio, solo);
  return caja;
}

// Idioma de audio elegido (se recuerda en este aparato)
function leerIdioma() { try { return localStorage.getItem('morvehtv-idioma') || ''; } catch (e) { return ''; } }
function guardarIdioma(i) { try { if (i) localStorage.setItem('morvehtv-idioma', String(i).toLowerCase()); } catch (e) {} }

// Que la pantalla del móvil o la tablet no se apague mientras se ve algo (solo funciona en
// navegadores que lo permiten; en el resto el propio vídeo suele evitarlo)
let bloqueoPantalla = null;
async function mantenerPantalla(si) {
  // Dentro de la app de Android lo hace la propia app
  if (window.MorvehApp) { try { window.MorvehApp.pantalla(si); } catch (e) {} return; }
  try {
    if (si && !bloqueoPantalla && navigator.wakeLock) {
      bloqueoPantalla = await navigator.wakeLock.request('screen');
      bloqueoPantalla.addEventListener('release', () => (bloqueoPantalla = null));
    } else if (!si && bloqueoPantalla) {
      await bloqueoPantalla.release();
      bloqueoPantalla = null;
    }
  } catch (e) {}
}
// Al cerrar o recargar la página se avisa al servidor para que pare ffmpeg
window.addEventListener('pagehide', pararMedios);
// Al volver a la app, si había un vídeo en marcha, se vuelve a pedir
document.addEventListener('visibilitychange', () => {
  const v = document.querySelector('#vcontenido video');
  if (document.visibilityState === 'visible' && v && !v.paused) mantenerPantalla(true);
});

let listaVisor = [];
async function abrir(i, lista = listaVisor, opciones = {}) {
  pararMedios();
  listaVisor = lista;
  if (i < 0 || i >= lista.length) return;
  actual = i;
  actualKey = lista[i].key;
  const f = lista[i];
  const [, clase] = tipo(f.key);
  $('#visor').classList.add('abierto');
  // El mismo reproductor en la web, el móvil y la app de Android
  if ((clase === 'video' || clase === 'video-raro') && !opciones.ficha) entrarCine();
  else salirCine();
  $('#vtitulo').textContent = nombre(f.key);
  $('#vtitulo').title = f.key;
  pedirMeta('archivo', f.key).then((d) => { if (actual === i && d && d.encontrado) $('#vtitulo').textContent = tituloDe(d).replace(/^T(\d+)·E/, `${d.titulo} · T$1·E`); });
  $('#vmeta').textContent = `${bytes(f.tamano)} · ${fecha(f.fecha)}`;
  pintarFavVisor(f);
  actualizarFlechas(i);
  const c = $('#vcontenido'); c.innerHTML = '';
  if (clase === 'enlace') return abrirEnlace(f, i, c);

  try {
    const { url } = await api('/api/url', { key: f.key });
    if (actual !== i) return;
    c.innerHTML = '';
    if (clase === 'video' || clase === 'video-raro') {
      const m = await api('/api/medio', { key: f.key }).catch(() => null);
      if (actual !== i) return;
      c.innerHTML = '';
      // Directo de e2 solo si cualquier dispositivo lo abre: MP4/MOV con H.264 y un único
      // audio compatible. Lo demás (.mkv, .ts, AC3, varios idiomas…) pasa por el servidor.
      const directo = m && /\.(mp4|m4v|mov)$/i.test(f.key) && m.videoNativo.includes(m.video)
        && m.audios.length <= 1 && m.audios.every((a) => m.audioNativo.includes(a.codec));
      // Mismo reproductor en los dos casos (si no se pudo analizar el archivo, se intenta directo)
      // Plan Básico: un anuncio corto antes del vídeo (como mucho uno cada 10 minutos)
      if (typeof anuncioPrevio === 'function') await anuncioPrevio();
      if (actual !== i) return;
      const caja = reproductor(f.key, m || { duracion: 0, audios: [] }, directo || !m ? url : null, undefined, { reproducir: opciones.reproducir });
      c.append(caja);
      navegacionReproductor(caja, i);
      // Plan Básico: pausas publicitarias durante el vídeo y anuncio pequeño al pausar
      if (typeof anunciosDelReproductor === 'function') anunciosDelReproductor(caja);
      enfocarVisor();
      const d = await pedirMeta('archivo', f.key);
      if (actual === i) c.append(fichaHtml(d || { encontrado: false }, { archivo: f, medio: m, clave: f.key }));
    } else if (clase === 'imagen') {
      const img = el('img'); img.src = url; img.alt = nombre(f.key); c.append(img);
    } else if (clase === 'audio') {
      const a = el('audio'); a.src = url; a.controls = true; c.append(a);
    } else if (clase === 'pdf') {
      const fr = el('iframe'); fr.src = url; c.append(fr);
    } else if (clase === 'texto') {
      const d = await api('/api/texto', { key: f.key });
      const pre = el('pre');
      let t = d.texto;
      if (/\.json$/i.test(f.key)) { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch (e) {} }
      pre.textContent = t + (d.recortado ? '\n\n… (se muestran solo los primeros 2 MB)' : '');
      c.append(pre);
    } else {
      c.innerHTML = '<div class="vacio">Este tipo de archivo no tiene vista previa.</div>';
    }
    if (clase !== 'video' && clase !== 'video-raro') enfocarVisor();
  } catch (e) {
    c.innerHTML = `<div class="vacio error">${e.message}</div>`;
  }
}

// ---------- Pasar de un capítulo o película a otro ----------
// «Vecino»: el de al lado en la lista que se está viendo, saltando lo que no es vídeo (subtítulos,
// imágenes). Si es el último (o el primero) de una carpeta «Temporada N», sigue en la temporada
// siguiente (o anterior) de la misma serie.
const esVideoClave = (k) => { const c = tipo(k)[1]; return c === 'video' || c === 'video-raro'; };
const RE_TEMPORADA = /^(?:temporada|season|temp|t|s)\s*0*(\d{1,2})$/i;
const numTemporada = (carpeta) => { const m = nombre(carpeta).trim().match(RE_TEMPORADA); return m ? Number(m[1]) : (/^especiales?$/i.test(nombre(carpeta).trim()) ? 0 : null); };
// Es un episodio si lo dice el nombre (S01E02, 1x02…), si está en una carpeta «Temporada N» o si
// está dentro de la carpeta de una serie (cualquier subcarpeta de una sección que no sea de películas)
const esEpisodio = (k) => {
  if (capitulo(k) !== null || numTemporada(padre(k)) !== null) return true;
  const partes = k.split('/');
  return partes.length >= 3 && !/pel[ií]cula|cine|movie|film/i.test(partes[0]);
};

async function listarTodo(prefijo) {
  const r = { carpetas: [], archivos: [] };
  let token = '';
  for (let n = 0; n < 10; n++) {
    const d = await api('/api/listar', { prefijo, token });
    r.carpetas.push(...d.carpetas); r.archivos.push(...d.archivos);
    if (!d.siguiente) break;
    token = d.siguiente;
  }
  return r;
}

const vecinosHechos = new Map(); // `${key}|${dir}` → promesa de { lista, i } o null
function vecino(dir, i = actual, lista = listaVisor) {
  const f = lista[i];
  if (!f) return Promise.resolve(null);
  const id = `${f.key}|${dir}`;
  if (vecinosHechos.has(id)) return vecinosHechos.get(id);
  const p = (async () => {
    const soloVideos = esVideoClave(f.key);
    for (let j = i + dir; j >= 0 && j < lista.length; j += dir) {
      if (!soloVideos || esVideoClave(lista[j].key)) return { lista, i: j };
    }
    // Fin de la temporada: la de al lado de la misma serie
    if (!soloVideos) return null;
    const carpeta = padre(f.key);
    const n = numTemporada(carpeta);
    if (n === null) return null;
    const serie = padre(carpeta);
    const temporadas = (await listarTodo(serie)).carpetas
      .map((c) => ({ c, n: numTemporada(c) })).filter((x) => x.n !== null)
      // Los especiales (temporada 0) no se meten entre medias: solo se llega a ellos a propósito
      .filter((x) => x.n > 0 || n === 0)
      .sort((a, b) => a.n - b.n);
    const k = temporadas.findIndex((x) => x.c === carpeta);
    const otra = k >= 0 ? temporadas[k + dir] : null;
    if (!otra) return null;
    const videos = (await listarTodo(otra.c)).archivos.filter((x) => esVideoClave(x.key)).sort((a, b) => porCapitulo(a.key, b.key));
    if (!videos.length) return null;
    return { lista: videos, i: dir > 0 ? 0 : videos.length - 1 };
  })().catch(() => null);
  vecinosHechos.set(id, p);
  if (vecinosHechos.size > 200) vecinosHechos.delete(vecinosHechos.keys().next().value);
  return p;
}

// Nombre para enseñar del de al lado: «T1·E3 · Nombre» si TMDB lo conoce, si no el del archivo
async function etiquetaDe(f) {
  const d = await pedirMeta('archivo', f.key).catch(() => null);
  return d && d.encontrado ? tituloDe(d) : nombre(f.key).replace(/\.[^.]+$/, '');
}

let navegando = false;
async function irVecino(dir, opciones = {}) {
  if (navegando || actual < 0) return;
  navegando = true;
  try {
    const v = await vecino(dir);
    if (v) await abrir(v.i, v.lista, opciones);
    else aviso(dir > 0 ? 'Es el último' : 'Es el primero');
  } finally { navegando = false; }
}

// Flechas ‹ › de los lados (fuera del vídeo a pantalla completa) con el nombre de lo que viene
function actualizarFlechas(i) {
  const lista = listaVisor;
  [['#ant', -1, 'Anterior'], ['#sig', 1, 'Siguiente']].forEach(([sel, dir, texto]) => {
    const b = $(sel);
    b.hidden = true;
    vecino(dir, i, lista).then(async (v) => {
      if (actual !== i || listaVisor !== lista || !v) return;
      b.hidden = false;
      const t = `${texto}: ${await etiquetaDe(v.lista[v.i])}`;
      b.title = t; b.setAttribute('aria-label', t);
    });
  });
}

// En el reproductor: botones ⏮ ⏭ junto a los de 10 s y, al final de cada capítulo, la tarjeta
// «Siguiente episodio» (en los últimos 30 s se ofrece; al acabar, cuenta 10 s y sigue sola).
// En películas no hay tarjeta (solo los botones ⏮ ⏭).
function navegacionReproductor(caja, i) {
  const lista = listaVisor;
  const f = lista[i];
  const serie = esEpisodio(f.key);
  const bAnt = boton('boton', icono('anterior'), 'Anterior');
  // En series, con su texto a la vista: «⏭ Siguiente episodio»
  const bSig = boton(serie ? 'boton con-texto' : 'boton', serie ? `${icono('siguiente')}<span>Siguiente episodio</span>` : icono('siguiente'), serie ? 'Siguiente episodio' : 'Siguiente');
  bAnt.hidden = true; bSig.hidden = true;
  bAnt.onclick = () => irVecino(-1, { reproducir: true });
  bSig.onclick = () => irVecino(1, { reproducir: true });
  caja.despues.after(bAnt, bSig);
  const sigue = () => caja.isConnected && actual === i && listaVisor === lista;
  [[bAnt, -1, 'Anterior'], [bSig, 1, serie ? 'Siguiente episodio' : 'Siguiente']].forEach(([b, dir, texto]) => {
    vecino(dir, i, lista).then(async (v) => {
      if (!sigue() || !v) return;
      b.hidden = false;
      const t = `${texto}: ${await etiquetaDe(v.lista[v.i])}`;
      b.title = t; b.setAttribute('aria-label', t);
    });
  });

  let tarjeta = null;
  let descartada = false;
  let cuenta = null;
  async function mostrar(alAcabar) {
    if (descartada || !sigue()) return;
    const v = await vecino(1, i, lista);
    if (!v || !sigue()) return;
    const otro = v.lista[v.i];
    // Se adelanta el análisis del siguiente: así arranca antes
    api('/api/medio', { key: otro.key }).catch(() => {});
    if (!tarjeta) {
      tarjeta = el('div', 'siguiente');
      const info = el('div', 'info');
      tarjeta._que = el('small', null, serie ? 'Siguiente episodio' : 'Siguiente');
      tarjeta._titulo = el('b', null, nombre(otro.key));
      info.append(tarjeta._que, tarjeta._titulo);
      etiquetaDe(otro).then((t) => { if (tarjeta) tarjeta._titulo.textContent = t; });
      const ver = boton('boton primario', `${icono('play')}<span>Ver ahora</span>`, 'Ver ahora');
      ver.onclick = () => { quitar(); irVecino(1, { reproducir: true }); };
      const no = boton('boton', '✕', 'Ahora no');
      no.onclick = () => { descartada = true; quitar(); };
      const bs = el('div', 'acciones'); bs.append(ver, no);
      tarjeta.append(info, bs);
      tarjeta._ver = ver;
      caja.append(tarjeta);
    }
    if (alAcabar && serie && !cuenta) {
      let s = 10;
      const pintar = () => { tarjeta._que.textContent = `Siguiente episodio en ${s} s`; };
      pintar();
      cuenta = setInterval(() => {
        if (!sigue() || !tarjeta) return quitar();
        if (--s <= 0) { quitar(); irVecino(1, { reproducir: true }); } else pintar();
      }, 1000);
    }
    // Con el mando, al acabar el foco va a «Ver ahora»: OK lo abre
    if (alAcabar) tarjeta._ver.focus();
    despertar();
  }
  function quitar() {
    clearInterval(cuenta); cuenta = null;
    if (tarjeta) { tarjeta.remove(); tarjeta = null; }
  }
  // La tarjeta «Siguiente episodio» es solo para series: en películas no sale
  if (!serie) return;
  caja.alProgreso = (t, total) => {
    if (total > 90 && total - t <= 30 && t > 0) mostrar(false);
    // Si se vuelve atrás, la tarjeta se va (y puede volver a salir)
    else if (tarjeta && !cuenta && total - t > 35) { quitar(); descartada = false; }
  };
  caja.alAcabar = () => mostrar(true);
}

// En el móvil, fuera del vídeo a pantalla completa (ficha, imágenes…), deslizar el dedo a los
// lados pasa al anterior o al siguiente
(() => {
  let x0 = null, y0 = 0, t0 = 0;
  const zona = () => $('#vcontenido');
  document.addEventListener('touchstart', (e) => {
    const visor = $('#visor');
    if (!visor.classList.contains('abierto') || visor.classList.contains('cine') || e.touches.length !== 1) { x0 = null; return; }
    if (!zona().contains(e.target) || e.target.closest('input, select, textarea, .controles, .resultados, iframe')) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Date.now() - t0 < 600 && Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) * 0.5) irVecino(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

// ---------- Enlaces a vídeos de otros sitios (.url / .strm) ----------
// Aviso de fallo con «Reintentar» (y, para una página que el servidor no pudo comprobar,
// «Abrir igualmente»: algunas webs solo responden a navegadores)
function falloEnlace(c, texto, reintentar, igualmente) {
  c.innerHTML = '';
  const caja = el('div', 'vacio error fallo-enlace');
  caja.append(el('p', '', texto));
  const b = el('button', 'boton', '↻ Reintentar'); b.onclick = reintentar; caja.append(b);
  if (igualmente) { const o = el('button', 'boton', 'Abrir igualmente'); o.onclick = igualmente; caja.append(o); }
  c.append(caja);
  enfocarVisor();
}

const motivo = (d) => d.fallo || (d.estado ? `El sitio respondió con un error (HTTP ${d.estado})` : 'No se pudo conectar');

async function abrirEnlace(f, i, c) {
  const otraVez = () => { if (actual === i) abrirEnlace(f, i, c); };
  c.innerHTML = '<div class="vacio">Conectando…</div>';
  let d;
  try {
    d = await api('/api/enlace', { key: f.key });
  } catch (e) {
    if (actual === i) falloEnlace(c, e.message, otraVez);
    return;
  }
  if (actual !== i) return;
  // estado null: dirección de la red de casa, que el servidor no comprueba
  const bien = d.estado === null || (d.estado >= 200 && d.estado < 400);
  if (d.tipo === 'stream') {
    if (!bien) return falloEnlace(c, motivo(d), otraVez);
    c.innerHTML = '';
    entrarCine();
    c.append(reproductor(f.key, { duracion: 0, audios: [] }, d.url, () => Promise.resolve(d.url)));
    return enfocarVisor();
  }
  if (!bien) return falloEnlace(c, motivo(d), otraVez, () => incrustar(c, d.url, otraVez));
  incrustar(c, d.url, otraVez);
}

// Página con su propio reproductor, aislada: puede ejecutar su JavaScript y ponerse a pantalla
// completa, pero no abrir ventanas ni pestañas nuevas ni cambiar la página de MorvehTV
function incrustar(c, url, otraVez) {
  c.innerHTML = '';
  const fr = el('iframe', 'incrustado');
  fr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-forms');
  fr.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
  fr.setAttribute('allowfullscreen', '');
  fr.referrerPolicy = 'strict-origin-when-cross-origin';
  // Un iframe no avisa si falla: si en 20 s no ha cargado, se ofrece reintentar
  const espera = setTimeout(() => { if (fr.isConnected) falloEnlace(c, 'El reproductor no termina de cargar.', otraVez); }, 20000);
  fr.onload = () => clearTimeout(espera);
  fr.src = url;
  c.append(fr);
  enfocarVisor();
}

function cerrar() {
  salirCine();
  pararMedios();
  $('#visor').classList.remove('abierto');
  $('#vcontenido').innerHTML = '';
  if (actual >= 0) {
    actual = -1;
    if (recargarAlCerrar) return location.reload();
    if (!estado.prefijo) pintar();
    document.querySelectorAll('#items .item[data-key]').forEach(barraVisto);
    // Con el mando, el foco vuelve a la tarjeta del archivo que se estaba viendo
    const t = [...document.querySelectorAll('#items .item')].find((x) => x.dataset.key === actualKey);
    if (t) t.focus();
    aplicarPendientes();
  }
}

// ---------- Mando de la tele y teclado ----------
// Las flechas mueven el foco a la tarjeta o botón más cercano en esa dirección; OK abre y
// Atrás cierra el vídeo o sube de carpeta. Vale para el mando de Samsung (Tizen), LG
// (webOS), Android TV y para el teclado del ordenador.
const esTele = /SMART-?TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey|HbbTV|VIDAA|Roku|PhilipsTV|Hisense/i.test(navigator.userAgent);
if (esTele) document.documentElement.classList.add('tele');

const TECLAS = {
  ArrowUp: 'arriba', Up: 'arriba', ArrowDown: 'abajo', Down: 'abajo', ArrowLeft: 'izq', Left: 'izq', ArrowRight: 'der', Right: 'der',
  Enter: 'ok', Escape: 'atras', Esc: 'atras', Backspace: 'atras', GoBack: 'atras', BrowserBack: 'atras',
  MediaPlayPause: 'play', MediaPlay: 'play', MediaPause: 'play', MediaRewind: 'retroceder', MediaFastForward: 'avanzar',
  MediaTrackNext: 'siguiente', MediaTrackPrevious: 'anterior', ChannelUp: 'siguiente', ChannelDown: 'anterior',
};
// Códigos de los mandos de Samsung y LG que no traen nombre de tecla
// (427/428: canal + y − de Samsung, que en el reproductor pasan de capítulo)
const CODIGOS = { 10009: 'atras', 461: 'atras', 415: 'play', 19: 'play', 10252: 'play', 412: 'retroceder', 417: 'avanzar', 38: 'arriba', 40: 'abajo', 37: 'izq', 39: 'der', 13: 'ok', 427: 'siguiente', 428: 'anterior', 176: 'siguiente', 177: 'anterior' };
// Mayús+N / Mayús+P en el teclado: siguiente / anterior (como en YouTube)
const tecla = (e) => (e.shiftKey && (e.key === 'N' || e.key === 'n') ? 'siguiente' : e.shiftKey && (e.key === 'P' || e.key === 'p') ? 'anterior' : null)
  || TECLAS[e.key] || CODIGOS[e.keyCode] || null;

const ENFOCABLES_APP = '.destacado .boton, #pestanas button, #mi-cuenta, #salir-app, #migas a, #cabecera summary, #cabecera a, #cabecera button, .fila-titulo a, .cat:not(.vacia), #items .item, #mas:not([hidden])';
// (la barra de progreso no: con el mando se avanza y retrocede desde el propio vídeo con ← →)
const ENFOCABLES_VISOR = '.anuncio-pausa button, .anuncio-pausa a, .anuncio-previo button, .siguiente button, .repro .de-cero, #visor .barra .boton:not([hidden]), #visor .flecha:not([hidden]), .controles .boton, .controles select, #vcontenido > video, .repro video, .ficha a, .ficha summary, .ficha input, .ficha select, .ficha button, .fallo-enlace button, #vcontenido > iframe.incrustado';

// Lo escondido (la barra de progreso viendo el vídeo) no cuenta para el mando
const visible = (x) => {
  const r = x.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const e = getComputedStyle(x);
  return e.visibility !== 'hidden' && e.pointerEvents !== 'none';
};

function moverFoco(dir) {
  const enCuenta = document.documentElement.classList.contains('con-cuenta');
  const enVisor = !enCuenta && actual >= 0;
  // Con un anuncio en pantalla, el foco no sale de él (ni va a los controles del vídeo de detrás)
  const capaAnuncio = enVisor && document.querySelector('.anuncio-previo');
  const cands = [...(capaAnuncio ? capaAnuncio.querySelectorAll('button, a') : document.querySelectorAll(enCuenta ? '#cuenta button, #cuenta input, #cuenta a' : enVisor ? ENFOCABLES_VISOR : ENFOCABLES_APP))].filter(visible);
  const a = document.activeElement;
  if (!a || a === document.body || !cands.includes(a)) {
    // En la portada, el foco empieza en «▶ Reproducir» del destacado (si lo hay)
    const primero = enVisor || enCuenta ? cands[0] : (document.querySelector('.destacado:not([hidden]) .boton.reproducir, .cat:not(.vacia), #items .item') || cands[0]);
    if (primero) { primero.focus(); primero.scrollIntoView({ block: 'nearest' }); }
    return;
  }
  // En «Mi cuenta» todo va en una columna: ↑ ↓ siguen el orden (campo, su botón, el siguiente…)
  if (enCuenta && (dir === 'arriba' || dir === 'abajo')) {
    const otro = cands[cands.indexOf(a) + (dir === 'abajo' ? 1 : -1)];
    if (otro) { otro.focus(); otro.scrollIntoView({ block: 'nearest' }); }
    return;
  }
  const r = a.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let mejor = null, puntos = Infinity;
  // En la fila de botones del reproductor, ← → solo pasan de un botón a otro
  const fila = (dir === 'izq' || dir === 'der') && a.closest && a.closest('.controles');
  for (const c of cands) {
    if (fila && !fila.contains(c)) continue;
    if (c === a) continue;
    const s = c.getBoundingClientRect();
    const x = s.left + s.width / 2, y = s.top + s.height / 2;
    const dx = x - cx, dy = y - cy;
    const principal = { arriba: -dy, abajo: dy, izq: -dx, der: dx }[dir];
    if (principal <= 2) continue;
    const lateral = dir === 'arriba' || dir === 'abajo' ? Math.abs(dx) : Math.abs(dy);
    // Al subir, el menú de arriba (fijo) solo gana si no queda nada del contenido por encima:
    // así ↑ pasa de una fila del inicio a la anterior y no salta al menú
    const alMenu = dir === 'arriba' && !a.closest('header') && c.closest('header') ? 100000 : 0;
    const p = principal + lateral * 2.5 + alMenu;
    if (p < puntos) { puntos = p; mejor = c; }
  }
  if (mejor) {
    mejor.focus();
    // El menú de arriba está fijo: al subir hasta él, la página vuelve al principio
    if (mejor.closest('header') || mejor.closest('.destacado')) scrollTo({ top: 0, behavior: 'smooth' });
    else mejor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

// Al abrir un vídeo con el mando, el foco va al propio vídeo: OK lo reproduce y ← → lo mueven
function enfocarVisor() {
  if (!esTele && !document.documentElement.classList.contains('usa-mando')) return;
  const b = document.querySelector('#vcontenido video') || document.querySelector('.fallo-enlace button') || document.querySelector('#vcontenido > iframe') || document.querySelector('.controles .boton') || $('#vcerrar');
  if (b) b.focus();
}

// Un paso atrás: cerrar panel o vídeo, quitar la búsqueda o subir de carpeta. Devuelve false
// si ya está en la portada (la app de Android usa eso para salir con el botón Atrás).
function atras() {
  if (window.morvehSaltarIntro && window.morvehSaltarIntro()) return true;
  if (document.documentElement.classList.contains('con-cuenta')) { cerrarCuenta(); return true; }
  if ($('#visor').classList.contains('cine')) { salirCine(); return true; }
  if (actual >= 0) { cerrar(); return true; }
  if (estado.prefijo) { irA(padre(estado.prefijo)); return true; }
  return false;
}
window.morvehAtras = atras;

function padre(p) {
  const partes = p.split('/').filter(Boolean);
  partes.pop();
  return partes.length ? partes.join('/') + '/' : '';
}

document.addEventListener('keydown', (e) => {
  const k = tecla(e);
  if (!k) return;
  const a = document.activeElement;
  // OK del mando sobre una casilla (condiciones de Premium): la marca o desmarca
  if (k === 'ok' && a && a.type === 'checkbox') { e.preventDefault(); a.click(); return; }
  const escribiendo = a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox'));
  if (['arriba', 'abajo', 'izq', 'der'].includes(k)) document.documentElement.classList.add('usa-mando');

  if (k === 'atras') {
    if (escribiendo && e.key === 'Backspace') return;
    // Esc ya lo gestiona el navegador para salir de la pantalla completa
    if (enPantallaCompleta() && (e.key === 'Escape' || e.key === 'Esc')) return;
    e.preventDefault();
    atras();
    return;
  }
  if (escribiendo) {
    const flecha = ['arriba', 'abajo', 'izq', 'der'].includes(k);
    // En el selector de idioma del reproductor las flechas pasan a otro botón (si no, la tele
    // cambiaría de idioma sin querer); OK abre la lista de idiomas
    if (flecha && a.tagName === 'SELECT' && a.closest('.controles')) { e.preventDefault(); moverFoco(k); return; }
    // En los campos de texto, ↑ ↓ salen hacia los botones o las tarjetas
    if (a.tagName === 'INPUT' && (k === 'arriba' || k === 'abajo')) { e.preventDefault(); moverFoco(k); }
    return;
  }
  if (k === 'ok' && a && a.matches('.item, .cat')) { e.preventDefault(); a.click(); return; }

  if (actual >= 0) {
    // Durante un anuncio: las flechas mueven entre sus botones, OK pulsa el que tiene el foco
    // («Saltar anuncio») y las teclas del vídeo (play, avanzar…) no hacen nada debajo
    if (document.querySelector('.anuncio-previo')) {
      if (['arriba', 'abajo', 'izq', 'der'].includes(k)) { e.preventDefault(); moverFoco(k); }
      else if (k !== 'ok') e.preventDefault();
      return;
    }
    const repro = document.querySelector('#vcontenido .repro');
    const video = document.querySelector('#vcontenido video');
    // «Libre» = el foco no está en un botón: ← → mueven el vídeo y OK pausa
    // Con el foco en el vídeo, ← → lo mueven y OK pausa; ↓ baja a los botones (audio, ▶, ⛶…),
    // donde ← → pasan de uno a otro, y ↑ vuelve al vídeo
    const libre = !a || a === document.body || a.tagName === 'VIDEO';
    const alternar = () => (repro ? repro.alternar() : video && (video.paused ? video.play() : video.pause()));
    const saltar = (s) => (repro ? repro.saltar(s) : video && (video.currentTime += s));
    if (k === 'play' || (k === 'ok' && libre) || (e.key === ' ' && libre)) { e.preventDefault(); return alternar(); }
    if (k === 'retroceder') return saltar(-30);
    if (k === 'avanzar') return saltar(30);
    if (k === 'siguiente') { e.preventDefault(); return irVecino(1, { reproducir: !!video }); }
    if (k === 'anterior') { e.preventDefault(); return irVecino(-1, { reproducir: !!video }); }
    if (libre && (k === 'izq' || k === 'der')) {
      e.preventDefault();
      if (video) saltar(k === 'izq' ? -10 : 10);
      else irVecino(k === 'izq' ? -1 : 1);
      return;
    }
    if (a && a.type === 'range' && (k === 'izq' || k === 'der')) return; // la barra de progreso usa ← →
    if (['arriba', 'abajo', 'izq', 'der'].includes(k)) { e.preventDefault(); moverFoco(k); }
    return;
  }
  if (['arriba', 'abajo', 'izq', 'der'].includes(k)) { e.preventDefault(); moverFoco(k); }
});
$('#mas').onclick = () => cargar(true);
$('#vcerrar').onclick = cerrar;
$('#salircine').onclick = salirCine;
$('#ant').onclick = () => irVecino(-1);
$('#sig').onclick = () => irVecino(1);

// ---------- Actualización automática ----------
// El servidor repasa el bucket cada 5 s y avisa al momento de lo que se sube, cambia o se borra:
// la carpeta que estás viendo se vuelve a pintar sin recargar la página.
const nuevas = new Set(); // lo subido mientras la app está abierta (lleva la etiqueta NUEVO)
let actualKey = null;

// Mientras ves algo no se toca nada (ni avisos, ni redibujar la portada, ni pedir datos): en
// teles y móviles modestos ese trabajo cortaba la reproducción. Lo nuevo se guarda y se
// aplica al cerrar el vídeo.
let pendientes = null;

async function refrescar({ nuevos, cambiados, borrados, todo = false }) {
  nuevos.forEach((k) => nuevas.add(k));
  if (actual >= 0) {
    pendientes = pendientes || { nuevos: [], cambiados: [], borrados: [], todo: false };
    pendientes.nuevos.push(...nuevos); pendientes.cambiados.push(...cambiados); pendientes.borrados.push(...borrados);
    pendientes.todo = pendientes.todo || todo;
    return;
  }
  // Contadores y portadas de las categorías, de nuevo: si has quitado o movido títulos, que no
  // sigan saliendo sus carteles
  tamanos.clear();
  artes.clear();
  // Fichas guardadas de lo que ha cambiado (el vídeo y las carpetas que lo contienen), para que
  // se vuelvan a pedir
  const tocadas = [...nuevos, ...cambiados, ...borrados];
  for (const id of [...metas.keys()]) {
    const [clase, ...resto] = id.split(':');
    const clave = resto.join(':');
    if (clase === 'archivo' ? tocadas.includes(clave) : tocadas.some((k) => k.startsWith(clave))) metas.delete(id);
  }
  if (estado.prefijo.startsWith(':')) return; // «Seguir viendo», «Favoritos»: no salen del bucket
  if (!todo && !tocadas.some((k) => k.startsWith(estado.prefijo))) return;
  const prefijo = estado.prefijo;
  const d = await api('/api/listar', { prefijo });
  if (actual >= 0 || estado.prefijo !== prefijo) return; // abriste un vídeo u otra carpeta mientras tanto
  estado.carpetas = d.carpetas; estado.archivos = d.archivos; estado.token = d.siguiente;
  sinMoverse(pintar);
}

// Vuelve a pintar sin que la página salte: misma altura, cada fila deslizada donde estaba y el
// foco (mando de la tele) en la misma tarjeta
function sinMoverse(pintarDeNuevo) {
  const y = window.scrollY;
  const filas = [...document.querySelectorAll('#items .carrusel')].map((c) => c.scrollLeft);
  const a = document.activeElement;
  const enItems = a && a !== document.body && $('#items').contains(a);
  const clave = enItems && (a.dataset.key || a.closest('[data-key]')?.dataset.key);
  const todos = () => [...document.querySelectorAll('#items .item, #items a, #items button')];
  const indice = enItems ? todos().indexOf(a) : -1;
  pintarDeNuevo();
  const volver = () => {
    document.querySelectorAll('#items .carrusel').forEach((c, i) => { if (filas[i]) c.scrollLeft = filas[i]; });
    window.scrollTo(0, y);
  };
  volver();
  setTimeout(volver, 400); // las filas de «Últimos añadidos» llegan un poco después
  if (enItems) {
    const lista = todos();
    const destino = (clave && lista.find((x) => x.dataset.key === clave)) || lista[Math.min(indice, lista.length - 1)];
    if (destino) destino.focus({ preventScroll: true });
  }
}

function aplicarPendientes() {
  if (!pendientes) return;
  const p = pendientes;
  pendientes = null;
  refrescar(p).catch(() => {});
}

// Botón para salir de la app (solo en la app de Android, que es quien sabe cerrarse)
if (window.MorvehApp && typeof window.MorvehApp.salir === 'function') {
  $('#salir-app').hidden = false;
  $('#salir-app').onclick = () => window.MorvehApp.salir();
}

// Al publicar una versión nueva el servidor se reinicia y la conexión vuelve con otra versión:
// la app se recarga sola para usarla (la tele y el móvil no se quedan con la antigua). Si estás
// viendo algo, espera a que cierres el vídeo.
let versionServidor = null;
let recargarAlCerrar = false;
// Huella del contenido del bucket: si al reconectar no es la misma (la app estuvo en segundo
// plano, sin red o el servidor dormido), algo cambió sin que llegara el aviso: se repinta todo
let huellaContenido = null;
let eventos = null;

function conectar() {
  if (eventos) eventos.close();
  eventos = new EventSource('/api/eventos');
  // El aviso de conexión solo aparece si se corta (su sitio lo ocupan las pestañas)
  eventos.onopen = () => { $('#directo').hidden = true; };
  eventos.onerror = () => {
    $('#directo').hidden = false;
    // Si el navegador se rinde (el servidor contestó con un error al despertar), otro intento
    if (eventos.readyState === EventSource.CLOSED) setTimeout(conectar, 5000);
  };
  eventos.addEventListener('cambios', (e) => {
    const d = JSON.parse(e.data);
    if (d.huella) huellaContenido = d.huella;
    refrescar(d).catch(() => {});
  });
  eventos.addEventListener('contenido', (e) => {
    const h = JSON.parse(e.data);
    if (huellaContenido && h !== huellaContenido) refrescar({ nuevos: [], cambiados: [], borrados: [], todo: true }).catch(() => {});
    huellaContenido = h;
  });
  // Pago hecho o cancelado (aquí o en otro aparato): quitar o poner los anuncios ya
  eventos.addEventListener('plan', () => { if (typeof planCambiado === 'function') planCambiado(true); });
  eventos.addEventListener('version', (e) => {
    const v = JSON.parse(e.data);
    if (versionServidor && v !== versionServidor) {
      if (actual >= 0) recargarAlCerrar = true;
      else location.reload();
    }
    versionServidor = v;
  });
}
conectar();
// Al volver a la app (móvil, tele) se reconecta si la conexión se había perdido
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && eventos.readyState !== EventSource.OPEN) conectar();
});

window.addEventListener('hashchange', () => {
  estado.prefijo = decodeURIComponent(location.hash.slice(1));
  cerrar(); cargar();
});

// El nombre del bucket solo se muestra si no es el mismo que el de la app
api('/api/info').then((d) => { if (d.bucket.toLowerCase() !== 'morvehtv') $('#bucket').textContent = d.bucket; }).catch(() => {});
estado.prefijo = decodeURIComponent(location.hash.slice(1));
// Lee la lista de favoritos y «Seguir viendo» y pinta el inicio (perfiles.js, que se carga detrás)
document.addEventListener('DOMContentLoaded', () => empezar());

