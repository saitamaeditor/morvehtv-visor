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
  // Web en mantenimiento: al recargar sale su pantalla
  if (r.status === 503 && d.mantenimiento) { location.reload(); throw new Error(d.error); }
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
  if (!m) {
    // «Capitulo_05» / «Episodio 5» dentro de una carpeta «Temporada_02» (como los sube el bot)
    const c = nombre(k).match(/(?:^|[^a-z0-9])(?:cap[ií]tulo|episodio|ep)[ ._-]*0*(\d{1,3})(?!\d)/i);
    const t = c && numTemporada(padre(k));
    return c && t !== null ? t * 1000 + Number(c[1]) : null;
  }
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
    enfocarAlLlegar();
    return;
  }
  // Plan Básico: un anuncio a lo ancho encima de la carpeta
  const banner = typeof anuncioBanner === 'function' && anuncioBanner('carpeta');
  if (banner) items.append(banner);
  // En una sección (Películas, Series…): su catálogo completo de una vez
  if (raiz && !pintar.soloCarpeta) { pintarSeccion(items); return; }
  pintar.soloCarpeta = false;
  for (const c of carpetas) {
    const t = tarjeta({ icono: '📁', titulo: nombre(c), meta: 'Carpeta', alPulsar: () => irA(c), nuevo: [...nuevas].some((k) => k.startsWith(c)) });
    t.dataset.carpeta = c;
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
  enfocarAlLlegar();
}

// ---------- Sección entera ----------
// Todas las películas y series de la sección (también las de sus subcarpetas que solo agrupan,
// como «PELICULAS NETFLIX»), sin páginas ni «Cargar más», con el número exacto de títulos y el
// orden a elegir. Si el catálogo no llega, se ve la carpeta como antes.
let ordenSeccion = (() => { try { return localStorage.getItem('morvehtv-orden-seccion') || 'recientes'; } catch (e) { return 'recientes'; } })();
async function pintarSeccion(items) {
  const pref = estado.prefijo;
  $('#mas').hidden = true;
  const espera = el('div', 'vacio', 'Cargando el catálogo…');
  espera.style.gridColumn = '1 / -1';
  items.append(espera);
  let d = null;
  try { d = await api('/api/catalogo', { seccion: pref }); } catch (e) { d = null; }
  if (estado.prefijo !== pref || !items.isConnected) return;
  espera.remove();
  if (!d || !Array.isArray(d.titulos)) { pintar.soloCarpeta = true; return pintar(); }
  const titulos = d.titulos;
  const cuenta = items.querySelector('.biblioteca-cuenta');
  if (cuenta) cuenta.textContent = `${titulos.length} ${titulos.length === 1 ? 'título' : 'títulos'}`;
  if (!titulos.length) { items.append(el('div', 'vacio', 'Aún no hay nada en esta sección.')); return enfocarAlLlegar(); }
  // Orden: lo último subido primero, o de la A a la Z
  const orden = el('nav', 'categorias-chips orden-seccion');
  const tarjetas = [];
  const colocar = () => {
    const lista = ordenSeccion === 'az'
      ? [...titulos].sort((a, b) => nombre(a.key).localeCompare(nombre(b.key), 'es', { numeric: true }))
      : titulos;
    tarjetas.forEach((t) => t.remove());
    tarjetas.length = 0;
    const pelis = lista.filter((x) => x.tipo !== 'carpeta');
    for (const x of lista) {
      let t;
      if (x.tipo === 'carpeta') {
        t = tarjeta({ icono: '📺', titulo: nombre(x.key), meta: 'Serie', alPulsar: () => irA(x.key), nuevo: nuevas.has(x.ultimo) });
        t.dataset.carpeta = x.key;
        conMeta(t, 'carpeta', x.key); estrella(t, x.key);
      } else {
        const [, , icono] = tipo(x.key);
        t = tarjeta({ icono, titulo: nombre(x.key), meta: bytes(x.tamano), alPulsar: () => abrir(pelis.indexOf(x), pelis), nuevo: nuevas.has(x.key) });
        t.dataset.key = x.key; t.dataset.tamano = x.tamano;
        barraVisto(t);
        conMeta(t, 'archivo', x.key); estrella(t, x.key, x);
      }
      tarjetas.push(t);
      items.append(t);
    }
  };
  for (const [id, texto] of [['recientes', 'Más recientes'], ['az', 'A-Z']]) {
    const b = el('button', `chip-cat${id === ordenSeccion ? ' activa' : ''}`, texto);
    b.onclick = () => {
      if (ordenSeccion === id) return;
      ordenSeccion = id;
      try { localStorage.setItem('morvehtv-orden-seccion', id); } catch (e) {}
      orden.querySelectorAll('button').forEach((x) => x.classList.toggle('activa', x === b));
      colocar();
    };
    orden.append(b);
  }
  items.append(orden);
  colocar();
  enfocarAlLlegar();
}

// En la tele siempre hay algo con foco para que el mando funcione desde el principio. Al volver
// atrás (de una serie a su sección, de una sección a la portada) el foco cae en la carpeta o la
// categoría de la que vienes, como en las apps de la tele; al entrar, en lo primero.
let vengoDe = null;
function enfocarAlLlegar() {
  const conMando = esTele || document.documentElement.classList.contains('usa-mando');
  const a = document.activeElement;
  if (!conMando || actual >= 0 || (a && a !== document.body && siguienteFoco === null)) return;
  const de = vengoDe;
  vengoDe = null;
  let t = null;
  if (de && de !== estado.prefijo && de.startsWith(estado.prefijo)) {
    t = [...document.querySelectorAll('#items .item[data-carpeta]')].find((x) => de.startsWith(x.dataset.carpeta))
      || [...document.querySelectorAll('.cat[data-carpetas], .chip-cat[data-carpetas]')].find((x) => x.dataset.carpetas.split('|').some((c) => de.startsWith(c)));
  }
  // Tras «Cargar más» con el mando: a la primera tarjeta nueva
  if (siguienteFoco !== null) {
    const lista = document.querySelectorAll('#items > .item');
    t = lista[Math.min(siguienteFoco, lista.length - 1)];
    siguienteFoco = null;
  }
  if (t && visible(t)) { t.focus({ preventScroll: true }); t.scrollIntoView({ block: 'center', inline: 'nearest' }); return; }
  moverFoco('abajo');
}
let siguienteFoco = null;

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

// ---------- Listas de la portada ----------
// Tarjeta con el póster, la nota y si es película o serie arriba, y el título y el año debajo;
// en el Top 10, su número grande al lado
function tarjetaLista(x, lista, puesto) {
  const pelis = lista.filter((y) => y.tipo === 'archivo');
  const t = tarjeta({
    icono: x.tipo === 'carpeta' ? '📺' : '🎬', titulo: x.titulo, miniatura: x.poster,
    meta: [x.anio, x.temporadas && `${x.temporadas} temporada${x.temporadas > 1 ? 's' : ''}`].filter(Boolean).join(' · '),
    alPulsar: x.tipo === 'carpeta' ? () => irA(x.key) : () => abrir(pelis.indexOf(x), pelis),
    nuevo: nuevas.has(x.tipo === 'carpeta' ? x.ultimo : x.key),
  });
  t.classList.add('tarjeta-lista');
  const mini = t.querySelector('.mini');
  mini.classList.add('cartel');
  if (x.valoracion) mini.append(el('span', 'nota-cartel', `★ ${Number(x.valoracion).toFixed(1)}`));
  mini.append(el('span', 'tipo-cartel', x.serie ? 'Serie' : 'Película'));
  if (puesto) { t.classList.add('top'); t.prepend(el('span', 'puesto', String(puesto))); }
  if (x.tipo === 'archivo') { t.dataset.key = x.key; barraVisto(t); }
  return t;
}
async function pintarListas(sitio) {
  const d = await api('/api/listas-portada').catch(() => null);
  if (!d || !sitio.isConnected) return;
  const filas = [
    ['Tendencias de películas', d.peliculas.tendencias, true],
    ['Películas mejor valoradas', d.peliculas.valoradas],
    ['Películas populares', d.peliculas.populares],
    ['Tendencias de series', d.series.tendencias, true],
    ['Series mejor valoradas', d.series.valoradas],
    ['Series populares', d.series.populares],
  ];
  let puestas = 0;
  for (const [nombreFila, lista, top] of filas) {
    if (!lista || lista.length < 3) continue;
    const f = fila(nombreFila, null, top ? 'top10' : '');
    f.s.classList.add(top ? 'fila-top' : 'fila-lista');
    lista.forEach((x, n) => f.c.append(tarjetaLista(x, lista, top ? n + 1 : 0)));
    sitio.append(f.s);
    // Plan Básico: un anuncio cada tres filas
    if (++puestas % 3 === 0) { const b = typeof anuncioBanner === 'function' && anuncioBanner('fila'); if (b) sitio.append(b); }
  }
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
  // A la medida de la pantalla (en el móvil, la mitad de peso) y cada fondo se descarga cuando
  // le toca (y el siguiente, para que el cambio sea instantáneo), no los seis de golpe
  const tam = (window.innerWidth || 1280) * (window.devicePixelRatio || 1) > 1400 ? 'w1280' : 'w780';
  const imgs = con.map((f) => { const im = el('div', 'destacado-img'); im._fondo = f.m.fondo.replace(/\/t\/p\/w\d+\//, `/t/p/${tam}/`); fondos.append(im); return im; });
  const cargarFondo = (k) => { const im = imgs[(k + imgs.length) % imgs.length]; if (im._fondo) { im.style.backgroundImage = `url("${im._fondo}")`; im._fondo = null; } };
  const pts = con.map((f, n) => { const p = el('button', 'punto'); p.setAttribute('aria-label', `Destacado ${n + 1}`); p.tabIndex = -1; p.onclick = () => ver(n, true); puntos.append(p); return p; });
  function ver(n, aMano) {
    i = (n + con.length) % con.length;
    cargarFondo(i); setTimeout(() => cargarFondo(i + 1), 1500);
    imgs.forEach((im, k) => im.classList.toggle('visible', k === i));
    pts.forEach((p, k) => p.classList.toggle('activo', k === i));
    const { x, m } = con[i];
    const serie = x.tipo === 'carpeta';
    texto.innerHTML = '';
    texto.append(el('span', 'destacado-etiqueta', serie ? 'SERIE · NUEVO EN MORVEHTV' : 'NUEVO EN MORVEHTV'), el('h1', null, m.titulo));
    // Insignias: la calidad (por el nombre del archivo: 4K, HDR, Full HD…) y la nota de TMDB
    const insignias = el('div', 'destacado-insignias');
    const nombreArchivo = String(x.key || '');
    const calidad = /2160|\b4k\b|uhd/i.test(nombreArchivo) ? '4K UHD' : /1080/.test(nombreArchivo) ? 'Full HD' : /720/.test(nombreArchivo) ? 'HD' : null;
    if (calidad) insignias.append(el('span', 'insignia calidad', calidad));
    if (/hdr|dolby.?vision|\bdv\b/i.test(nombreArchivo)) insignias.append(el('span', 'insignia', 'HDR'));
    if (/atmos/i.test(nombreArchivo)) insignias.append(el('span', 'insignia', 'Dolby Atmos'));
    if (m.valoracion) {
      const nota = el('span', 'insignia nota', '★ ');
      nota.append(el('b', null, Number(m.valoracion).toFixed(1)), document.createTextNode(' TMDB'));
      insignias.append(nota);
    }
    if (insignias.childNodes.length) texto.append(insignias);
    const datos = [m.anio,
      serie ? (m.temporadas && `${m.temporadas} temporada${m.temporadas > 1 ? 's' : ''}`) : m.duracion && `${Math.floor(m.duracion / 60) ? `${Math.floor(m.duracion / 60)} h ` : ''}${m.duracion % 60} min`,
      (m.generos || []).slice(0, 3).join(' · ')].filter(Boolean);
    texto.append(el('div', 'destacado-datos', datos.join('   ·   ')));
    if (m.sinopsis) texto.append(el('p', 'destacado-sinopsis', m.sinopsis));
    const bs = el('div', 'destacado-botones');
    const ver1 = el('button', 'boton reproducir', '▶ Reproducir');
    ver1.onclick = () => (serie ? irA(x.key) : abrir(0, [x], { ver: true, reproducir: true }));
    const info = el('button', 'boton info', 'ℹ Más información');
    info.onclick = () => (serie ? irA(x.key) : abrir(0, [x]));
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
  // (La fila de botones de categorías ya no sale: a cada categoría se llega por el «Ver todo ›»
  // de su fila de novedades)
  // Plan Básico: un anuncio debajo de las categorías
  const banner = typeof anuncioBanner === 'function' && anuncioBanner('inicio');
  if (banner) items.append(banner);

  // Favoritos, si se pudo leer la lista («Seguir viendo» ya no sale en la portada: está en su
  // pestaña de arriba)
  if (typeof yo !== 'undefined' && yo) {
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
  // Tendencias (Top 10), mejor valoradas y populares, de películas y de series
  const listasSitio = el('div', 'listas-portada');
  items.append(listasSitio);
  pintarListas(listasSitio);
  const sitio = el('div', 'ultimos');
  items.append(sitio);
  // Solo los 20 últimos de cada categoría: con mucho contenido el catálogo entero pesaría demasiado
  catalogoPedido = catalogoPedido || api('/api/catalogo', { max: 20 }).catch(() => null);
  const pedido = catalogoPedido;
  pedido.then((d) => {
    if (catalogoPedido === pedido) catalogoPedido = null; // la próxima vez, datos frescos
    if (!d || estado.prefijo || !sitio.isConnected) return;
    pintarDestacado(destacado, d, carpetas).catch(() => {});
    // (Las filas de cada sección ya no salen: las secciones están en el menú de arriba)
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
    t.dataset.carpetas = suyas.join('|');
    t.onclick = () => irA(suyas[0]);
    // Se precarga todo para que aparezca de golpe con un fundido, no a trozos
    arteCategoria(cat, suyas).then(async ({ carteles, fondo }) => {
      const [f, ...cs] = await Promise.all([fondo ? precargar(fondo) : null, ...carteles.map(precargar)]);
      if (f) { t.style.setProperty('--img', `url("${f}")`); t.classList.add('con-imagen'); }
      cs.filter(Boolean).forEach((u, i) => {
        const img = el('img', `cartel-cat c${i + 1}`);
        img.decoding = 'async'; img.src = u; img.alt = '';
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
    const img = document.createElement('img'); img.loading = 'lazy'; img.decoding = 'async'; img.src = miniatura; img.alt = '';
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
  if (!d?.encontrado || !d.titulo || !t.isConnected) return;
  const temp = d.temporada;
  const apaisada = d.episodio?.imagen ?? (ancha ? d.fondo : null);
  const imagen = apaisada ?? temp?.poster ?? d.poster;
  const mini = t.querySelector('.mini');
  if (imagen) {
    const img = el('img'); img.loading = 'lazy'; img.decoding = 'async'; img.src = imagen; img.alt = '';
    // Si el fotograma del capítulo no se pudo sacar, la imagen de la serie
    const otra = d.fondo || d.poster;
    if (otra && otra !== imagen) img.onerror = () => { img.onerror = null; img.src = otra; };
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
  // Película o serie: solo el cartel (el título y los datos se ven en la ficha y al pasar por encima)
  if (imagen) t.classList.add('con-imagen');
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
      const videos = archivos.filter((x) => tipo(x.key)[1].startsWith('video') || tipo(x.key)[1] === 'enlace');
      if (videos.length) {
        const i = videos.findIndex((x) => posicionDe(x.key));
        abrir(Math.max(0, i), videos, { ver: true, reproducir: true });
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
// Diseño «héroe»: título grande, eslogan, una línea de datos (nota, año, duración, géneros),
// los botones y la sinopsis con «Ver más»; detrás, el fondo de la película a lo grande
function fichaHtml(d, { archivo, medio, clave } = {}) {
  const f = el('div', 'ficha heroe');
  const poster = d?.encontrado && (d.temporada?.poster ?? d.poster ?? d.episodio?.imagen);
  // Con fondo grande (película en el visor) el póster no hace falta; en la cabecera de una
  // serie el fondo lo pone #cabecera
  if (d?.encontrado && d.fondo && archivo) { f.classList.add('con-fondo'); f.style.setProperty('--fondo-img', `url("${d.fondo}")`); }
  if (poster) {
    const img = el('img', 'cartel'); img.src = poster; img.alt = ''; f.append(img);
  }
  const cuerpo = el('div', 'cuerpo');
  f.append(cuerpo);

  if (d?.encontrado) {
    // En el visor (película): «← Volver» arriba, como en las webs de cine
    if (archivo) {
      const volver = el('button', 'boton volver-ficha', '← Volver');
      volver.onclick = () => cerrar();
      cuerpo.append(volver);
    }
    cuerpo.append(el('h2', 'titulo-heroe', d.titulo));
    if (d.tituloOriginal && d.tituloOriginal !== d.titulo) cuerpo.append(el('div', 'suave original', d.tituloOriginal));
    if (d.eslogan) cuerpo.append(el('p', 'eslogan', `«${d.eslogan.replace(/^["«“]|["»”]$/g, '')}»`));
    const chips = el('div', 'chips datos');
    if (d.valoracion) {
      // La nota en %, con color según lo buena que sea
      const pct = Math.round(Number(d.valoracion) * 10);
      chips.append(el('span', `nota-pct ${pct >= 70 ? 'alta' : pct >= 50 ? 'media' : 'baja'}`, `★ ${pct}%`));
    }
    if (d.anio) chips.append(el('span', 'dato', d.anio));
    const dur = d.episodio?.duracion ?? d.duracion;
    if (d.tipo === 'serie' && d.temporadas) chips.append(el('span', 'dato', `${d.temporadas} temporada${d.temporadas > 1 ? 's' : ''}`));
    if (dur) chips.append(el('span', 'dato duracion', `${Math.floor(dur / 60) ? `${Math.floor(dur / 60)} h ` : ''}${dur % 60} min`));
    d.generos.forEach((g) => chips.append(el('span', 'chip', g)));
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
    // Botones (aquí se pone delante «▶ Reproducir»): favoritos, tráiler y de dónde salen los datos
    const enlaces = el('div', 'chips acciones');
    const objetivo = archivo ? archivo.key : clave;
    if (yo && objetivo) enlaces.append(botonFavorito(objetivo, archivo));
    if (d.trailer) {
      const t = Object.assign(el('a', 'boton trailer'), { href: d.trailer, target: '_blank', rel: 'noopener' });
      t.innerHTML = '<svg class="icono" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/></svg>TRÁILER';
      enlaces.append(t);
    }
    // (TMDB o, si no lo tenía, TVmaze, AniList o Wikipedia)
    const web = d.web || d.tmdb;
    if (web) enlaces.append(Object.assign(el('a', 'boton fuente', `${d.fuente || 'TMDB'} ↗`), { href: web, target: '_blank', rel: 'noopener' }));
    cuerpo.append(enlaces);
    if (d.sinopsis) cuerpo.append(el('p', `sinopsis${d.episodio || (d.temporada && d.temporada.sinopsis) ? ' suave' : ''}`, d.sinopsis));
    const linea = (t, v) => {
      if (!v?.length) return;
      const l = el('div', 'linea');
      l.append(el('b', null, `${t}: `), v.join(', '));
      cuerpo.append(l);
    };
    linea('Dirección', d.direccion);
    linea('Creada por', d.creadores);
    linea('Reparto', d.reparto);
    // La sinopsis se recorta a 3 líneas (y el reparto se esconde) hasta pulsar «Ver más»
    const mas = el('button', 'ver-mas', 'Ver más ▾');
    mas.onclick = () => { const si = f.classList.toggle('entera'); mas.textContent = si ? 'Ver menos ▴' : 'Ver más ▾'; };
    cuerpo.append(mas);
    // Compartir: el enlace a su carpeta (el mismo que el «Ver ahora» de Telegram)
    const carpeta = objetivo ? (objetivo.endsWith('/') ? objetivo : objetivo.slice(0, objetivo.lastIndexOf('/') + 1)) : '';
    if (carpeta) {
      const comp = el('div', 'compartir');
      comp.append(el('span', null, `Compartir ${d.tipo === 'serie' ? 'serie' : 'película'} en:`));
      const b = el('button', 'boton compartir-boton');
      b.title = 'Compartir'; b.setAttribute('aria-label', 'Compartir');
      b.innerHTML = '<svg class="icono" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>';
      b.onclick = async () => {
        const url = `${location.origin}/#${encodeURIComponent(carpeta)}`;
        const datos = { title: `${d.titulo} · MorvehTV`, text: `Mira «${d.titulo}» en MorvehTV`, url };
        try {
          if (navigator.share) return await navigator.share(datos);
        } catch (e) { if (e && e.name === 'AbortError') return; }
        try { await navigator.clipboard.writeText(url); aviso('Enlace copiado'); } catch (e) { prompt('Copia el enlace:', url); }
      };
      comp.append(b);
      cuerpo.append(comp);
    }
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
      const nombres = nombresAudio(medio.audios, archivo.key, medio.nombresAudio);
      fila('Audio', medio.audios.map((p, n) => [nombres[n], p.codec && p.codec.toUpperCase()].filter(Boolean).join(' · ')).join(' | '));
      fila('Subtítulos', medio.subtitulos?.map(pista).join(' | '));
    }
    // Los datos del archivo, plegados: no son lo primero que se busca en la ficha
    const det = el('details', 'detalles-tecnicos');
    det.append(el('summary', null, 'Detalles técnicos'), tec);
    cuerpo.append(det);
  }
  if (clave && d && typeof yo !== 'undefined' && yo && yo.admin) cuerpo.append(corrector(clave, d));
  return f;
}

// «¿No es esta?»: busca en TMDB y guarda el título correcto para este vídeo o serie
function corrector(clave, d) {
  const caja = el('details', 'corrector');
  caja.append(el('summary', null, d.encontrado ? '¿No es esta? Corregir' : '🔎 Buscar la ficha'));
  const fila = el('div', 'chips');
  const q = el('input'); q.type = 'search'; q.placeholder = 'Título…'; q.value = d.encontrado ? '' : (d.buscado ?? '');
  const sel = el('select');
  sel.append(new Option('Película o serie', ''), new Option('Película', 'pelicula'), new Option('Serie', 'serie'));
  // Dónde buscar: TMDB o las demás fuentes (series y programas, anime, Wikipedia)
  const fuente = el('select');
  [['tmdb', 'TMDB'], ['tvmaze', 'TVmaze (series y programas)'], ['anilist', 'AniList (anime)'], ['kitsu', 'Kitsu (anime)'], ['wikipedia', 'Wikipedia']]
    .forEach(([v, t]) => fuente.append(new Option(t, v)));
  const b = el('button', 'boton', 'Buscar');
  const res = el('div', 'resultados');
  fila.append(q, sel, fuente, b);
  caja.append(fila, res);
  const elegir = async (r) => {
    await api('/api/corregir', { key: clave, tmdbId: r.tmdbId ?? '', tipo: r.tipo, fuente: r.fuente || 'tmdb', id: r.id ?? '' });
    metas.clear();
    aviso(`Guardado: ${r.titulo}`);
    if (actual >= 0) abrir(actual); else pintarCabecera(estado.prefijo);
    pintar();
  };
  b.onclick = async () => {
    res.textContent = 'Buscando…';
    try {
      const lista = await api('/api/tmdb-buscar', { q: q.value, tipo: sel.value, fuente: fuente.value });
      res.innerHTML = '';
      if (!lista.length) res.textContent = 'Sin resultados.';
      for (const r of lista.slice(0, 12)) {
        const o = el('button', 'resultado');
        if (r.poster) { const i = el('img'); i.src = r.poster; i.alt = ''; o.append(i); }
        o.append(el('span', null, `${r.titulo}${r.anio ? ` (${r.anio})` : ''} · ${r.tipo === 'serie' ? 'Serie' : 'Película'}${r.fuente && r.fuente !== 'tmdb' ? ` · ${fuente.options[fuente.selectedIndex].text.split(' (')[0]}` : ''}`));
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

// ¿Este aparato decodifica HEVC (H.265)? Casi todas las Android TV / Google TV, muchos móviles y
// los ordenadores con aceleración. 8 o 10 bits según el vídeo; el 4:2:2 / 4:4:4 no.
const HEVC_DIRECTO = false;
const HEVC_CODECS = { 8: ['hvc1.1.6.L120.90', 'hev1.1.6.L120.90'], 10: ['hvc1.2.4.L120.90', 'hev1.2.4.L120.90'] };
const bitsHevc = (pix) => (/^yuv420p$|^yuvj420p$|^$/.test(pix || '') ? 8 : /^yuv420p10/.test(pix) ? 10 : 0);
const hevcCache = {};
// Por partes (hls.js): lo que pregunta MediaSource
function abreHevc(pix) {
  const bits = bitsHevc(pix);
  if (!bits) return false;
  const k = `ms${bits}`;
  if (!(k in hevcCache)) {
    const MS = window.ManagedMediaSource || window.MediaSource;
    try { hevcCache[k] = !!MS && HEVC_CODECS[bits].some((c) => MS.isTypeSupported(`video/mp4; codecs="${c}"`)); } catch (e) { hevcCache[k] = false; }
  }
  return hevcCache[k];
}
// El archivo entero (MP4 directo de e2): lo que dice el propio <video>
function abreHevcDirecto(pix) {
  const bits = bitsHevc(pix);
  if (!bits) return false;
  const k = `v${bits}`;
  if (!(k in hevcCache)) {
    const v = document.createElement('video');
    try { hevcCache[k] = HEVC_CODECS[bits].some((c) => v.canPlayType(`video/mp4; codecs="${c}"`) === 'probably'); } catch (e) { hevcCache[k] = false; }
  }
  return hevcCache[k];
}

// ---------- Modo cine: el vídeo a pantalla completa nada más darle a reproducir ----------
// Se pide la pantalla completa del navegador (o de la app Android) en el mismo toque/clic que
// abre el vídeo, porque los navegadores solo la permiten en respuesta a una acción tuya. Donde
// no existe (iPhone) el vídeo igualmente ocupa toda la pantalla. Al salir se vuelve a la ficha.
let cineReal = false;
const enPantallaCompleta = () => document.fullscreenElement || document.webkitFullscreenElement;

// Dentro de la app de Android (y en la tele) el vídeo ocupa toda la pantalla dentro de la propia
// página, sin pedir la pantalla completa del sistema: esa abría una vista aparte. La app solo
// esconde las barras del móvil (y lo pone en horizontal).
const dentroDeApp = () => !!window.MorvehApp;
function barrasApp(ocultar) {
  try { if (window.MorvehApp && typeof window.MorvehApp.barras === 'function') window.MorvehApp.barras(ocultar); } catch (e) {}
}
function entrarCine() {
  const visor = $('#visor');
  visor.classList.add('cine');
  visor.classList.toggle('llenar', tactil() && quiereLlenar());
  document.querySelectorAll('.boton.ajuste').forEach((b) => pintarAjuste(b));
  despertar();
  if (dentroDeApp() || esTele) { barrasApp(true); return; }
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
  barrasApp(false);
  if (enPantallaCompleta()) {
    const salir = document.exitFullscreen || document.webkitExitFullscreen;
    try { const p = salir.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
}

// Salir del reproductor (Atrás, Esc, el gesto del móvil, ⛶): nada de quedarse con el vídeo en
// pequeño. Un capítulo lleva a la página de su serie (su ficha, con «▶ Reanudar»); una película
// deja su ficha a la vista con el vídeo en pausa y escondido, listo para seguir.
// La serie es la carpeta que tiene las temporadas, o la del capítulo si va suelto (S01E02)
function carpetaSerieDe(key) {
  const partes = String(key || '').split('/');
  if (partes.length < 3) return null; // suelto en la sección: película
  const carpetas = partes.slice(0, -1);
  const enTemporada = /^(temporada|season|temp\.?|especiales|specials|t\d+$|s\d+$)/i.test(carpetas[carpetas.length - 1]);
  if (enTemporada) carpetas.pop();
  else if (!/\bS\d{1,2}\s*E\d{1,3}\b|\b\d{1,2}x\d{2}\b/i.test(partes[partes.length - 1])) return null;
  return carpetas.length >= 2 ? `${carpetas.join('/')}/` : null;
}
function salirAFicha() {
  const serie = carpetaSerieDe(actualKey);
  // Capítulos y enlaces de otros servidores: se cierra el reproductor (en una serie, a su página)
  if (!serie && tipo(actualKey)[1] === 'enlace' && actual >= 0) return abrir(actual, listaVisor);
  if (serie || tipo(actualKey)[1] === 'enlace') {
    cerrar();
    if (serie && estado.prefijo !== serie) irA(serie);
    return;
  }
  salirCine();
  const v = document.querySelector('#vcontenido .repro video');
  if (v) v.pause();
  const b = document.querySelector('#vcontenido .ver-ahora');
  if (b) { b.textContent = v && v.currentTime > 5 ? '▶ Reanudar' : '▶ Reproducir'; b.focus({ preventScroll: true }); }
  $('#vcontenido').scrollTop = 0;
}
// En la ficha de una película (al salir del vídeo o desde «Información»): «▶ Reproducir» vuelve
// a la pantalla completa y sigue donde iba
function botonVerAhora(c) {
  if (!c.querySelector('.repro') || c.querySelector('.ver-ahora')) return;
  // (en sus botones de la ficha; si la ficha no los tiene, encima de ella)
  const chips = c.querySelector('.ficha .cuerpo > .chips:not(.datos)') || c.insertBefore(el('div', 'chips ver-ahora-sitio'), c.querySelector('.ficha') || null);
  // Con el botón puesto, fuera de la pantalla completa se ve solo la ficha (el vídeo, escondido)
  c.classList.add('solo-ficha');
  const v = c.querySelector('.repro video');
  const b = el('button', 'boton reproducir ver-ahora', v && v.currentTime > 5 ? '▶ Reanudar' : '▶ Reproducir');
  b.onclick = () => {
    entrarCine();
    const video = c.querySelector('.repro video');
    if (video) video.play().catch(() => {});
    enfocarVisor();
  };
  chips.prepend(b);
}

// Esc, el botón Atrás de la app o el gesto del móvil sacan de la pantalla completa: se sale
// también del reproductor, a la ficha
function alCambiarPantalla() {
  const giro = screen.orientation;
  if (enPantallaCompleta()) {
    cineReal = true;
    // En el móvil, el vídeo se ve en horizontal (el navegador solo lo permite en pantalla completa)
    if (giro && giro.lock && matchMedia('(pointer: coarse)').matches) giro.lock('landscape').catch(() => {});
    return;
  }
  if (giro && giro.unlock) try { giro.unlock(); } catch (e) {}
  if (cineReal) {
    cineReal = false;
    // (si lo ha quitado MorvehTV al salir, ya no está en modo cine y no hay nada más que hacer)
    if ($('#visor').classList.contains('cine') && actual >= 0) salirAFicha();
    else $('#visor').classList.remove('cine', 'reposo');
  }
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
  volumen: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/>',
  mudo: '<path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/>',
  idioma: '<path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>',
  llenar: '<path d="M19 12h-2v3h-3v2h5v-5zM7 9h3V7H5v5h2V9zm14-6H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.99h18v14.02z"/>',
  ajustar: '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9 8H7v2H5v2h4V8zm6 8h2v-2h2v-2h-4v4z"/>',
};

// Móvil y tablet: a pantalla completa, el vídeo llena la pantalla entera sea del tamaño que sea
// (recorta un poco por los lados o por arriba y abajo si la pantalla tiene otra forma). Con el
// botón ⛶ de al lado, o pellizcando la imagen, se vuelve a ver entero. Se recuerda en el aparato.
const tactil = () => matchMedia('(pointer: coarse)').matches && !esTele;
function quiereLlenar() { try { return localStorage.getItem('morvehtv-llenar') !== '0'; } catch (e) { return true; } }
function ponerLlenar(si) {
  try { localStorage.setItem('morvehtv-llenar', si ? '1' : '0'); } catch (e) {}
  $('#visor').classList.toggle('llenar', si && tactil());
  document.querySelectorAll('.boton.ajuste').forEach((b) => pintarAjuste(b));
}
function pintarAjuste(b) {
  const lleno = $('#visor').classList.contains('llenar');
  b.innerHTML = icono(lleno ? 'ajustar' : 'llenar');
  b.title = lleno ? 'Ver la imagen entera' : 'Llenar la pantalla';
  b.setAttribute('aria-label', b.title);
}
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
  // (deja de ser directo si este aparato no sabe abrir el archivo: entonces lo prepara el servidor)
  let directo = !!urlDirecto;
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
  const bSonido = boton('boton sonido', icono('volumen'), 'Silenciar');
  const bPantalla = boton('boton', icono('pantalla'), 'Pantalla completa');
  // Como en las apps de streaming: la barra de progreso a lo ancho arriba y, debajo, los botones
  // de reproducir a la izquierda y los de idioma, capítulos y pantalla a la derecha
  const filaProgreso = el('div', 'fila-progreso');
  const izq = el('div', 'grupo izq');
  const der = el('div', 'grupo der');
  // El idioma del audio va el primero, a la izquierda. Es un botón que abre una lista de botones
  // (no un desplegable del sistema: en Android TV / Google TV el mando no lo abría)
  let selAudio = null; // { value: número de pista (texto) }
  let bAudio = null;
  let nombresPistas = nombresAudio(m.audios, key, m.nombresAudio);
  // Etiqueta de color con las siglas del idioma (ES, LAT, EN…) y el nombre
  const etiquetaIdioma = (n) => {
    const f = document.createDocumentFragment();
    f.append(el('b', 'sigla', siglaDe(nombresPistas[n], n)), el('span', 'nombre-idioma', nombresPistas[n]));
    return f;
  };
  // En todos los vídeos con sonido (aunque tengan una sola pista: así se ve cuál es)
  if (m.audios.length >= 1) {
    selAudio = { value: '0' };
    // Sin idioma elegido antes: el español, si lo hay (si no, la primera pista)
    // (se guarda «idioma|título»: Castellano y Latino son los dos «spa»; los guardados antes,
    // solo con el idioma, también valen)
    const pref = leerIdioma();
    const [prefIdioma] = pref.split('|');
    let n = pref ? m.audios.findIndex((a) => claveAudio(a) === pref) : -1;
    if (n < 0 && pref) n = m.audios.findIndex((a) => (a.idioma || a.titulo || '').toLowerCase() === prefIdioma);
    if (n < 0) n = nombresPistas.findIndex((x) => x.startsWith('Castellano'));
    if (n < 0) n = nombresPistas.findIndex((x) => x.startsWith('Latino'));
    selAudio.value = String(Math.max(0, n));
    bAudio = boton('boton audio', '', 'Idioma del audio');
    const pintarAudio = () => { bAudio.innerHTML = ''; bAudio.append(etiquetaIdioma(Number(selAudio.value))); };
    pintarAudio();
    bAudio.onclick = () => menuAudio();
    bAudio.pintar = pintarAudio;
  }
  // La lista de idiomas, encima de los controles; el foco va al que suena
  function menuAudio() {
    const viejo = caja.querySelector('.menu-audio');
    if (viejo) return cerrarMenuAudio();
    const menu = el('div', 'menu-audio');
    menu.setAttribute('role', 'menu');
    caja.append(menu);
    pintarListaAudio(menu);
    // Con ratón o dedo, pulsar fuera la cierra
    fueraAudio = (e) => { if (!menu.contains(e.target) && !bAudio.contains(e.target)) cerrarMenuAudio(); };
    document.addEventListener('pointerdown', fueraAudio, true);
  }
  // La lista: cada idioma con su etiqueta; debajo, para la administración, poner los nombres
  function pintarListaAudio(menu) {
    menu.innerHTML = '';
    menu.classList.remove('editando');
    menu.append(el('h4', null, '🎧 Idioma del audio'));
    m.audios.forEach((a, n) => {
      const b = el('button', String(n) === selAudio.value ? 'activo' : '');
      b.type = 'button'; b.setAttribute('role', 'menuitemradio');
      b.append(etiquetaIdioma(n));
      if (a.canales > 2) b.append(el('small', null, a.canales === 6 ? '5.1' : a.canales === 8 ? '7.1' : `${a.canales} canales`));
      b.onclick = () => { cerrarMenuAudio(); if (String(n) !== selAudio.value) cambiarAudio(n); };
      menu.append(b);
    });
    if (typeof yo !== 'undefined' && yo && yo.admin) {
      const sinNombre = nombresPistas.some((x) => /^Audio/.test(x));
      const ed = el('button', 'editar-audios', sinNombre ? '✎ Poner el idioma de cada audio' : '✎ Cambiar los nombres');
      ed.type = 'button';
      ed.onclick = () => editarNombresAudio(menu);
      menu.append(ed);
    }
    (menu.querySelector('.activo') || menu.querySelector('button')).focus();
  }
  // (solo administración) El idioma de cada pista, a mano: cada botón pasa al siguiente idioma
  // al pulsarlo (con el mando, OK); se guarda para este capítulo o para toda la temporada
  function editarNombresAudio(menu) {
    menu.innerHTML = '';
    menu.classList.add('editando');
    menu.append(el('h4', null, '✎ ¿Qué idioma es cada audio?'));
    const elegidos = nombresPistas.map((x) => { const i = IDIOMAS_A_MANO.findIndex((y) => x.startsWith(y)); return i; });
    m.audios.forEach((a, n) => {
      const b = el('button', 'pista-a-mano');
      b.type = 'button';
      const pintar = () => {
        b.innerHTML = '';
        const idioma = elegidos[n] >= 0 ? IDIOMAS_A_MANO[elegidos[n]] : 'Sin decir';
        b.append(el('small', null, `Audio ${n + 1}${a.codec ? ` · ${a.codec.toUpperCase()}` : ''}${a.canales > 2 ? ` ${a.canales === 6 ? '5.1' : `${a.canales}ch`}` : ''}`),
          el('b', 'sigla', elegidos[n] >= 0 ? SIGLAS[idioma] : '?'), el('span', 'nombre-idioma', `${idioma} ›`));
      };
      b.onclick = () => { elegidos[n] = elegidos[n] + 1 >= IDIOMAS_A_MANO.length ? -1 : elegidos[n] + 1; pintar(); };
      pintar();
      menu.append(b);
    });
    // Para toda la carpeta (los capítulos de la temporada suelen tener las pistas en el mismo orden)
    let carpeta = key.split('/').length > 2;
    const bc = el('button', 'pista-a-mano carpeta');
    bc.type = 'button';
    const pintarCarpeta = () => { bc.textContent = carpeta ? '☑ Para toda esta carpeta (todos sus capítulos)' : '☐ Solo para este vídeo'; };
    bc.onclick = () => { carpeta = !carpeta; pintarCarpeta(); };
    pintarCarpeta();
    const msg = el('p', 'msg-audios');
    const guardar = el('button', 'guardar-audios', 'Guardar');
    guardar.type = 'button';
    guardar.onclick = async () => {
      guardar.disabled = true; msg.textContent = 'Guardando…';
      try {
        const nombres = elegidos.map((i) => (i >= 0 ? IDIOMAS_A_MANO[i] : ''));
        const r = await fetch('/api/audio-nombres', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, nombres, carpeta }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
        m.nombresAudio = d.nombres;
        nombresPistas = nombresAudio(m.audios, key, m.nombresAudio);
        bAudio.pintar();
        pintarListaAudio(menu);
      } catch (e) { guardar.disabled = false; msg.textContent = e.message; }
    };
    const volver = el('button', 'pista-a-mano', '‹ Volver');
    volver.type = 'button';
    volver.onclick = () => pintarListaAudio(menu);
    menu.append(bc, guardar, volver, msg);
    menu.querySelector('.pista-a-mano').focus();
  }
  let fueraAudio = null;
  function cerrarMenuAudio() {
    const menu = caja.querySelector('.menu-audio');
    if (fueraAudio) { document.removeEventListener('pointerdown', fueraAudio, true); fueraAudio = null; }
    if (!menu) return false;
    menu.remove();
    if (bAudio) bAudio.focus();
    return true;
  }
  caja.cerrarMenuAudio = cerrarMenuAudio;
  filaProgreso.append(rango, tiempo);
  izq.append(bPlay, bAtras, bAdelante, bSonido);
  if (bAudio) der.append(bAudio);
  // Móvil y tablet: llenar la pantalla o ver la imagen entera (también pellizcando la imagen)
  if (tactil()) {
    const bAjuste = boton('boton ajuste', icono('llenar'), 'Llenar la pantalla');
    bAjuste.onclick = () => ponerLlenar(!$('#visor').classList.contains('llenar'));
    pintarAjuste(bAjuste);
    der.append(bAjuste);
    let distancia0 = 0;
    const distancia = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    v.addEventListener('touchstart', (e) => { distancia0 = e.touches.length === 2 ? distancia(e.touches) : 0; }, { passive: true });
    v.addEventListener('touchmove', (e) => {
      if (!distancia0 || e.touches.length !== 2 || !$('#visor').classList.contains('cine')) return;
      const r = distancia(e.touches) / distancia0;
      if (r > 1.15 || r < 0.87) { ponerLlenar(r > 1); distancia0 = 0; }
    }, { passive: true });
  }
  der.append(bPantalla);
  barra.append(filaProgreso, izq, der);
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
  // HEVC copiado tal cual (si el aparato lo decodifica). Si aun así falla, se vuelve a pedir
  // convertido a H.264 desde el mismo segundo y ya no se intenta más con este vídeo.
  let sinHevc = false;
  let sesionHevc = false;
  let fallosMedia = 0;
  const pedirHevc = () => m.video === 'hevc' && !sinHevc && abreHevc(m.pix);
  function sinHevcDesdeAqui() {
    sinHevc = true; fallosMedia = 0;
    const t = ahora(); const seguir = quiere || !v.paused;
    if (directo) { directo = false; v.removeAttribute('src'); v.load(); }
    parar(sesion); sesion = null;
    ir(t, seguir);
  }
  // Hay aparatos que dicen que abren HEVC pero solo suena el audio (imagen negra): si al poco de
  // empezar no ha salido ni un fotograma, se pasa al vídeo convertido
  v.addEventListener('playing', () => {
    if (!(sesionHevc || (directo && m.video === 'hevc')) || sinHevc) return;
    setTimeout(() => {
      if (!caja.isConnected || v.paused || sinHevc) return;
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      if (!v.videoWidth || (q && q.totalVideoFrames === 0)) sinHevcDesdeAqui();
    }, 4000);
  });
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
    // Colchón de lo que queda por ver y reintentos generosos ante cortes de red. Lo ya visto se
    // suelta de la memoria (antes se guardaba la película entera: en teles de 1-2 GB acababa
    // dando tirones o cerrando la app). En la tele, colchón más corto y con tope de tamaño.
    hls = new Hls({
      startPosition: inicio,
      ...(esTele ? { maxBufferLength: 60, maxMaxBufferLength: 90, maxBufferSize: 60 * 1000 * 1000, backBufferLength: 20 }
        : { maxBufferLength: 120, maxMaxBufferLength: 180, backBufferLength: 60 }),
      fragLoadingMaxRetry: 8, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 8,
    });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, arrancar);
    hls.on(Hls.Events.ERROR, (_, d) => {
      // HEVC que el aparato no traga (códec incompatible o errores de imagen repetidos): al
      // vídeo convertido, desde el mismo segundo
      if (sesionHevc && (/incompatible|codec/i.test(String(d.details)) || (d.fatal && d.type === Hls.ErrorTypes.MEDIA_ERROR && ++fallosMedia >= 2))) return sinHevcDesdeAqui();
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
      const r = await api('/api/hls', { key, desde: Math.floor(t) - antes, margen: antes, audio: selAudio ? selAudio.value : 0, hevc: pedirHevc() ? 1 : 0 });
      if (mio !== turno || !caja.isConnected) return parar(r.id);
      parar(sesion);
      sesion = r.id; desde = r.desde; sesionHevc = !!r.hevc;
      await cargarHls();
      if (mio !== turno || !caja.isConnected) return;
      fuente(r.url, t - r.desde, reproducir);
    } catch (e) {
      if (mio === turno) { cargando.hidden = false; cargando.textContent = e.message; }
    }
  }
  // El tiempo y lo recorrido de la barra (relleno de color hasta el punto actual)
  const pintarTiempo = (t) => {
    tiempo.textContent = `${hms(t)} / ${hms(total())}`;
    rango.style.setProperty('--pct', `${total() ? Math.min(100, (t / total()) * 100) : 0}%`);
  };
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
    // El aparato no sabe abrir el archivo tal cual (p. ej. un MP4 de 10 bits): en vez de quedarse
    // ahí, se pasa al vídeo que prepara el servidor, desde el mismo segundo
    if (/\.m3u8(\?|#|$)/i.test(urlDirecto)) { cargando.hidden = false; cargando.textContent = 'Este dispositivo no puede reproducir este formato.'; return; }
    const t = v.currentTime > 0 ? ahora() : inicio;
    const seguir = quiere || !v.paused;
    // (si era un HEVC que el aparato decía abrir y no pudo, el servidor lo da ya convertido)
    if (m.video === 'hevc') sinHevc = true;
    directo = false;
    v.removeAttribute('src'); v.load();
    cargando.hidden = true;
    ir(t, seguir);
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
  // Otro idioma: el servidor prepara el vídeo con esa pista desde el mismo segundo
  function cambiarAudio(n) {
    selAudio.value = String(n);
    bAudio.pintar();
    guardarIdioma(claveAudio(m.audios[n]));
    const t = ahora(); parar(sesion); sesion = null; ir(t);
  }
  bSonido.onclick = () => {
    v.muted = !v.muted;
    bSonido.innerHTML = icono(v.muted ? 'mudo' : 'volumen');
    bSonido.title = v.muted ? 'Activar el sonido' : 'Silenciar'; bSonido.setAttribute('aria-label', bSonido.title);
  };
  bPantalla.onclick = () => ($('#visor').classList.contains('cine') ? salirAFicha() : entrarCine());
  caja.irA = ir;
  caja.saltar = (s) => ir(ahora() + s);
  caja.alternar = alternar;
  caja.controles = barra;
  caja.despues = bAdelante;
  caja.grupoDer = der; // ahí van ⏮ ⏭ (los pone abrir()), delante del idioma y la pantalla completa
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

// Nombre de cada pista de audio: el idioma en claro («Castellano», «Latino», «Inglés»…), sacado
// de su título («Spanish (Latin America)», «ESP AC3 5.1», «VO»…), de su código de idioma
// («spa», «es-419», «eng») o, si la pista no dice nada, del nombre del archivo («Dual
// Castellano-Inglés»). El español sin más es Castellano (salvo que algo diga latino).
const IDIOMAS = { spa: 'Castellano', es: 'Castellano', esp: 'Castellano', cas: 'Castellano', 'es-es': 'Castellano', lat: 'Latino', 'es-419': 'Latino', 'es-mx': 'Latino', 'es-la': 'Latino',
  eng: 'Inglés', en: 'Inglés', fre: 'Francés', fra: 'Francés', fr: 'Francés', ger: 'Alemán', deu: 'Alemán', de: 'Alemán', ita: 'Italiano', it: 'Italiano',
  por: 'Portugués', pt: 'Portugués', jpn: 'Japonés', ja: 'Japonés', kor: 'Coreano', ko: 'Coreano', tur: 'Turco', tr: 'Turco', cat: 'Catalán', ca: 'Catalán',
  rus: 'Ruso', ru: 'Ruso', chi: 'Chino', zho: 'Chino', zh: 'Chino', ara: 'Árabe', ar: 'Árabe', hin: 'Hindi', pol: 'Polaco', dut: 'Neerlandés', nld: 'Neerlandés',
  glg: 'Gallego', gl: 'Gallego', baq: 'Euskera', eus: 'Euskera', eu: 'Euskera' };
// Palabras que delatan el idioma en un título o en el nombre del archivo (el orden importa:
// «latino» antes que «español», que también lo contienen muchos títulos de latino)
const PALABRAS_IDIOMA = [
  ['Latino', /latin|latam|\blat\b|es[-_ ]?419|m[eé]xic|hispanoam/i],
  ['Castellano', /castellano|castilian|espa[ñn]a|\bspain\b|espa[ñn]ol|spanish|\besp\b|\bspa\b|\bcast\b/i],
  ['Inglés', /ingl[eé]s|english|\beng\b|^v\.?o\.?(s\.?e\.?)?$/i],
  ['Francés', /franc[eé]s|french|fran[cç]ais/i], ['Italiano', /italian/i], ['Alemán', /alem[aá]n|german|deutsch/i],
  ['Portugués', /portugu[eé]s|portuguese|brasil/i], ['Japonés', /japon[eé]s|japanese/i], ['Coreano', /coreano|korean/i], ['Catalán', /catal[aà]n?/i],
  ['Turco', /turco|turkish/i], ['Gallego', /gallego|galician/i], ['Euskera', /euskera|basque/i],
];
function idiomaDeTexto(t) { for (const [nombre, re] of PALABRAS_IDIOMA) if (re.test(t)) return nombre; return null; }
// Siglas para la etiqueta de color del idioma
const SIGLAS = { Castellano: 'ES', Latino: 'LAT', Inglés: 'EN', Francés: 'FR', Italiano: 'IT', Alemán: 'DE', Portugués: 'PT', Japonés: 'JA', Coreano: 'KO',
  Catalán: 'CA', Turco: 'TR', Gallego: 'GL', Euskera: 'EU', Ruso: 'RU', Chino: 'ZH', Árabe: 'AR', Hindi: 'HI', Polaco: 'PL', Neerlandés: 'NL' };
const siglaDe = (nombre, n) => SIGLAS[String(nombre).split(/[ ·]/)[0]] || (/^Audio/.test(nombre) ? String(n + 1) : String(nombre).slice(0, 2).toUpperCase());
// Los que se pueden elegir al poner nombre a mano (en este orden)
const IDIOMAS_A_MANO = ['Castellano', 'Latino', 'Inglés', 'Francés', 'Italiano', 'Alemán', 'Portugués', 'Japonés', 'Coreano', 'Catalán', 'Turco'];
// «manual»: los nombres que puso la administración a mano (mandan sobre todo lo demás)
function nombresAudio(audios, key, manual) {
  if (Array.isArray(manual) && manual.some(Boolean)) {
    const auto = nombresAudio(audios, key);
    return audios.map((a, n) => manual[n] || auto[n]);
  }
  // Del nombre del archivo, los idiomas en el orden en que salen («Dual Latino-Inglés»)
  const enNombre = [];
  const nombreArchivo = String(key || '').split('/').pop().replace(/\.[^.]+$/, '');
  for (const trozo of nombreArchivo.split(/[\s._\-+()[\]]+/)) { const i = idiomaDeTexto(trozo); if (i && !enNombre.includes(i)) enNombre.push(i); }
  const sinDatos = audios.filter((a) => !idiomaDeTexto(a.titulo || '') && !IDIOMAS[String(a.idioma || '').toLowerCase()]);
  const nombres = audios.map((a, n) => {
    const porTitulo = idiomaDeTexto(a.titulo || '');
    const codigo = IDIOMAS[String(a.idioma || '').toLowerCase()];
    // «spa» con un título que diga latino es Latino (el título manda sobre el código)
    let nombre = porTitulo || codigo || null;
    if (!nombre && enNombre.length) {
      const i = sinDatos.indexOf(a);
      nombre = enNombre[i] || (audios.length === 1 ? enNombre[0] : null);
    }
    return nombre || null;
  });
  // Sin nada que diga el idioma: el contenido de MorvehTV es en español, así que la primera pista
  // que no se sabe (o la única) es Castellano, si ninguna otra lo es ya; las demás, numeradas
  // (se les puede poner nombre a mano desde el reproductor)
  const primeraSinNombre = nombres.indexOf(null);
  if (primeraSinNombre >= 0 && !nombres.includes('Castellano')) nombres[primeraSinNombre] = 'Castellano';
  nombres.forEach((x, n) => { if (!x) nombres[n] = audios.length === 1 ? 'Audio' : `Audio ${n + 1}`; });
  // Si dos se llaman igual (Castellano 5.1 y Castellano estéreo), se distinguen por los canales
  // (y si también coinciden los canales, se numeran: «Inglés 1», «Inglés 2»)
  const canal = (c) => (c === 6 ? '5.1' : c === 8 ? '7.1' : c === 2 ? 'estéreo' : c === 1 ? 'mono' : '');
  return nombres.map((x, n) => {
    const iguales = nombres.map((y, i) => (y === x ? i : -1)).filter((i) => i >= 0);
    if (iguales.length < 2) return x;
    const c = canal(audios[n].canales);
    const mismoCanal = iguales.filter((i) => canal(audios[i].canales) === c);
    return c && mismoCanal.length < 2 ? `${x} · ${c}` : `${x} ${iguales.indexOf(n) + 1}`;
  });
}

const claveAudio = (a) => (a ? `${a.idioma || ''}|${a.titulo || ''}`.toLowerCase() : '');

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
  // Desde la pantalla completa (⏮ ⏭, fin del capítulo) se sigue viendo, sin pasar por la ficha
  const veniaDeCine = $('#visor').classList.contains('abierto') && $('#visor').classList.contains('cine');
  pararMedios();
  listaVisor = lista;
  if (i < 0 || i >= lista.length) return;
  actual = i;
  actualKey = lista[i].key;
  const f = lista[i];
  const [, clase] = tipo(f.key);
  $('#visor').classList.add('abierto');
  // El mismo reproductor en la web, el móvil y la app de Android
  // Una película (o un título de enlaces) se abre primero en su ficha; el reproductor, a pantalla
  // completa, solo al pulsar «▶ Reproducir». Los capítulos de una serie van directos al vídeo.
  const esTituloSuelto = (clase === 'video' || clase === 'video-raro' || clase === 'enlace') && !esEpisodio(f.key);
  const soloFicha = esTituloSuelto && !opciones.ver && !opciones.reproducir && !opciones.ficha && !veniaDeCine;
  if ((clase === 'video' || clase === 'video-raro') && !opciones.ficha && !soloFicha) entrarCine();
  else salirCine();
  $('#vtitulo').textContent = nombre(f.key);
  $('#vtitulo').title = f.key;
  pedirMeta('archivo', f.key).then((d) => { if (actual === i && d && d.encontrado) $('#vtitulo').textContent = tituloDe(d).replace(/^T(\d+)·E/, `${d.titulo} · T$1·E`); });
  $('#vmeta').textContent = `${bytes(f.tamano)} · ${fecha(f.fecha)}`;
  pintarFavVisor(f);
  actualizarFlechas(i);
  const c = $('#vcontenido'); c.innerHTML = '';
  c.classList.remove('solo-ficha');
  if (soloFicha) return pintarSoloFicha(f, i, lista, c);
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
      // En la tele, un audio de más de 2 canales (5.1, 7.1) también pasa por el servidor, que lo
      // deja en estéreo: muchas Android TV / Google TV lo reproducen sin sonido
      // (el HEVC directo está apagado, HEVC_DIRECTO: con él el audio y la imagen se desfasaban
      // en las teles; los MP4 en HEVC los convierte el servidor, como siempre)
      const directo = m && /\.(mp4|m4v|mov)$/i.test(f.key) && (m.videoNativo.includes(m.video) || (HEVC_DIRECTO && m.video === 'hevc' && abreHevcDirecto(m.pix)))
        && m.audios.length <= 1 && m.audios.every((a) => m.audioNativo.includes(a.codec) && !(esTele && a.canales > 2));
      // Mismo reproductor en los dos casos (si no se pudo analizar el archivo, se intenta directo)
      // Anuncio en vídeo (VAST de una red externa) antes de empezar, si están activados
      if (typeof anuncioPrevio === 'function') await anuncioPrevio();
      if (actual !== i) return;
      // El MP4 directo llega a través del servidor (/flujo), que lo baja de e2 a varias conexiones:
      // e2 limita cada conexión a ~4 Mbit/s y el vídeo se paraba a trozos
      const porServidor = `/flujo?key=${encodeURIComponent(f.key)}`;
      const caja = reproductor(f.key, m || { duracion: 0, audios: [] }, directo || !m ? porServidor : null, () => Promise.resolve(porServidor), { reproducir: opciones.reproducir });
      c.append(caja);
      navegacionReproductor(caja, i);
      // Plan Básico: pausas publicitarias durante el vídeo y anuncio pequeño al pausar
      if (typeof anunciosDelReproductor === 'function') anunciosDelReproductor(caja);
      avisoDelReproductor(caja);
      enfocarVisor();
      const d = await pedirMeta('archivo', f.key);
      if (actual === i) { c.append(fichaHtml(d || { encontrado: false }, { archivo: f, medio: m, clave: f.key })); botonVerAhora(c); }
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

// Ficha de una película sin preparar aún el vídeo (no se pone a convertir nada en el servidor
// hasta que se pulsa «▶ Reproducir», que lo abre a pantalla completa)
async function pintarSoloFicha(f, i, lista, c) {
  c.innerHTML = '<div class="vacio">Cargando…</div>';
  const d = await pedirMeta('archivo', f.key);
  if (actual !== i || actualKey !== f.key) return;
  c.innerHTML = '';
  c.classList.add('solo-ficha');
  c.append(fichaHtml(d || { encontrado: false }, { archivo: f, clave: f.key }));
  const sitio = c.querySelector('.ficha .cuerpo > .chips.acciones') || c.insertBefore(el('div', 'chips ver-ahora-sitio'), c.querySelector('.ficha'));
  const b = el('button', 'boton reproducir ver-ahora', posicionDe(f.key) ? '▶ Reanudar' : '▶ Reproducir');
  b.onclick = () => abrir(i, lista, { ver: true, reproducir: true });
  sitio.prepend(b);
  enfocarVisor();
  b.focus({ preventScroll: true });
}

// ---------- Pasar de un capítulo o película a otro ----------
// «Vecino»: el de al lado en la lista que se está viendo, saltando lo que no es vídeo (subtítulos,
// imágenes). Si es el último (o el primero) de una carpeta «Temporada N», sigue en la temporada
// siguiente (o anterior) de la misma serie.
const esVideoClave = (k) => { const c = tipo(k)[1]; return c === 'video' || c === 'video-raro'; };
const RE_TEMPORADA = /^(?:temporada|season|temp|t|s)[\s._-]*0*(\d{1,2})$/i;
const numTemporada = (carpeta) => { const m = nombre(carpeta).trim().match(RE_TEMPORADA); return m ? Number(m[1]) : (/^especiales?$/i.test(nombre(carpeta).trim()) ? 0 : null); };
// Es un episodio si lo dice el nombre (S01E02, 1x02…), si está en una carpeta «Temporada N» o si
// está dentro de la carpeta de una serie (cualquier subcarpeta de una sección que no sea de películas)
const esEpisodio = (k) => {
  if (capitulo(k) !== null || numTemporada(padre(k)) !== null) return true;
  const partes = k.split('/');
  return partes.length >= 3 && !/pel[ií]cula|cine|movie|film|documental|estreno/i.test(partes[0]);
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
// ---------- Avisos propios en el reproductor ----------
// Mensajes de MorvehTV (Telegram, novedades, mantenimientos…) que se escriben en el gestor. Al
// empezar a ver algo sale uno en una tarjeta pequeña abajo a la izquierda; se va sola a los 10 s
// o con la ✕. Como mucho uno cada 10 minutos en cada aparato, y sin quitar el foco al mando.
let avisosCargados = null;
function avisoDelReproductor(caja) {
  let ultimo = 0; let turno = 0;
  try { ultimo = Number(localStorage.getItem('aviso-reproductor-hora')) || 0; turno = Number(localStorage.getItem('aviso-reproductor-turno')) || 0; } catch {}
  if (Date.now() - ultimo < 600000) return;
  avisosCargados = avisosCargados || api('/api/avisos-reproductor').catch(() => []);
  const v = caja.querySelector('video');
  if (!v) return;
  v.addEventListener('playing', async () => {
    const lista = await avisosCargados;
    if (!lista?.length || !caja.isConnected) return;
    const aviso = lista[turno % lista.length];
    try { localStorage.setItem('aviso-reproductor-hora', String(Date.now())); localStorage.setItem('aviso-reproductor-turno', String(turno + 1)); } catch {}
    const t = el('div', 'aviso-repro');
    t.append(el('span', 'texto', aviso.texto));
    if (aviso.enlace) {
      const ir = el('a', 'boton', aviso.boton || 'Abrir');
      ir.href = aviso.enlace; ir.target = '_blank'; ir.rel = 'noopener';
      t.append(ir);
    }
    const cerrar = boton('boton cerrar', '✕', 'Cerrar el aviso');
    cerrar.onclick = () => t.remove();
    t.append(cerrar);
    caja.append(t);
    setTimeout(() => t.remove(), 10000);
  }, { once: true });
}

// «Saltar intro»: el servidor sabe dónde está la intro de cada capítulo (la busca comparando el
// audio de los capítulos de la temporada). Mientras suena, sale el botón; al pulsarlo, salta al
// final de la intro. Si aún la está buscando, se vuelve a preguntar cada 30 s (unos minutos).
function prepararIntro(caja, key, sigue) {
  let intro = null;
  let b = null;
  let intentos = 0;
  const pedir = () => api('/api/intro', { key }).then((r) => {
    if (!sigue()) return;
    if (r.inicio != null) intro = r;
    else if (r.pendiente && ++intentos <= 8) setTimeout(pedir, 30000);
  }).catch(() => {});
  pedir();
  const quitar = () => { if (b) { b.remove(); b = null; } };
  caja.alTiempo = (t) => {
    if (!intro || !sigue()) return quitar();
    const dentro = t >= intro.inicio - 1 && t < intro.fin - 3;
    if (dentro && !b) {
      b = boton('boton saltar-intro', `${icono('siguiente')}<span>Saltar intro</span>`, 'Saltar intro');
      b.onclick = () => { quitar(); caja.irA(intro.fin); };
      caja.append(b);
      // Con el mando, el foco va al botón: OK salta la intro
      if (esTele) b.focus({ preventScroll: true });
    } else if (!dentro) quitar();
  };
}

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
  if (caja.grupoDer) caja.grupoDer.prepend(bAnt, bSig); else caja.despues.after(bAnt, bSig);
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
  prepararIntro(caja, f.key, sigue);
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

async function abrirEnlace(f, i, c, opcion = 0) {
  const otraVez = () => { if (actual === i) abrirEnlace(f, i, c, opcion); };
  c.innerHTML = '<div class="vacio">Conectando…</div>';
  let d;
  try {
    d = await api('/api/enlace', { key: f.key, opcion });
  } catch (e) {
    if (actual === i) falloEnlace(c, e.message, otraVez);
    return;
  }
  if (actual !== i) return;
  // Al abrir el título (sin elegir servidor), el que eligió esta persona la última vez: mismo
  // servidor e idioma; si no está, el idioma; si no, el servidor (el que le fue fluido)
  if (opcion === 0 && d.opciones && d.opciones.length > 1) {
    let idioma = null, servidor = null;
    try { idioma = localStorage.getItem('morvehtv-idioma-enlace'); servidor = localStorage.getItem('morvehtv-servidor-enlace'); } catch (e) {}
    const buscar = (fn) => d.opciones.findIndex(fn);
    let n = -1;
    if (idioma && servidor) n = buscar((o) => o.idioma === idioma && o.servidor === servidor);
    if (n < 0 && idioma) n = buscar((o) => o.idioma === idioma);
    if (n < 0 && servidor) n = buscar((o) => o.servidor === servidor);
    if (n > 0) return abrirEnlace(f, i, c, n);
  }
  // Con varios servidores en el archivo, una fila para cambiar de uno a otro (siempre visible,
  // también cuando uno falla: así se prueba el siguiente), con su idioma y calidad
  const servidores = () => {
    if (!(d.opciones && d.opciones.length > 1)) return;
    const fila = el('div', 'servidores');
    fila.append(el('span', '', 'Servidor:'));
    d.opciones.forEach((o, n) => {
      const extra = [o.idioma, o.calidad].filter(Boolean).join(' · ');
      const b = el('button', `boton${n === d.opcion ? ' activo' : ''}`, `${o.servidor} ${n + 1}${extra ? ` · ${extra}` : ''}`);
      b.onclick = () => {
        try {
          if (o.idioma) localStorage.setItem('morvehtv-idioma-enlace', o.idioma);
          localStorage.setItem('morvehtv-servidor-enlace', o.servidor);
        } catch (e) {}
        if (n !== d.opcion) abrirEnlace(f, i, c, n);
      };
      fila.append(b);
    });
    c.prepend(fila);
  };
  // estado null: dirección de la red de casa, que el servidor no comprueba
  const bien = d.estado === null || (d.estado >= 200 && d.estado < 400);
  if (d.tipo === 'stream') {
    if (!bien) { falloEnlace(c, motivo(d), otraVez); return servidores(); }
    c.innerHTML = '';
    entrarCine();
    c.append(reproductor(f.key, { duracion: 0, audios: [] }, d.url, () => Promise.resolve(d.url)));
    servidores();
    return enfocarVisor();
  }
  if (!bien) { falloEnlace(c, motivo(d), otraVez, () => { incrustar(c, d.url, otraVez, d.servidor); servidores(); }); return servidores(); }
  // App antigua con un servidor que no funciona aislado (Byse…): en vez de su página de error,
  // se explica qué pasa y se ofrecen los otros servidores
  if (!sinAislarPermitido && !SERVIDORES_AISLADOS.includes(d.servidor)) {
    falloEnlace(c, `Para ver ${d.servidor} actualiza la app de MorvehTV (te lo ofrece al abrirla) o prueba otro servidor.`, otraVez,
      () => { incrustar(c, d.url, otraVez, d.servidor); servidores(); });
    return servidores();
  }
  incrustar(c, d.url, otraVez, d.servidor);
  servidores();
}

// Página con su propio reproductor, aislada: puede ejecutar su JavaScript y ponerse a pantalla
// completa, pero nunca cambiar la página de MorvehTV. Los servidores de vídeo (Voe, Streamwish,
// Doodstream…) no reproducen si notan que no pueden abrir ventanas (sus anuncios), así que se les
// deja: en el navegador sale como pestaña aparte; en la app, que sabe distinguir un toque en
// MorvehTV de uno dentro del reproductor, se descartan (las app antiguas sin ese aviso, no:
// allí se abrirían encima de MorvehTV, así que siguen sin permiso).
const ventanasEnIframe = !window.MorvehApp || typeof window.MorvehApp.permitir === 'function';
// Cada toque en la propia página de MorvehTV (no dentro de un iframe) se avisa a la app: solo en
// el segundo siguiente puede abrirse una ventana (Tráiler, TMDB, Ko-fi…)
document.addEventListener('click', () => { try { if (window.MorvehApp && window.MorvehApp.permitir) window.MorvehApp.permitir(); } catch (e) {} }, true);
// Algunos servidores (Byse…) no reproducen en un marco aislado, dé los permisos que dé. Los
// servidores de vídeo reconocidos van sin aislar donde MorvehTV sigue protegida igualmente: en el
// navegador (si el reproductor intenta llevarte a otra web, el navegador pregunta antes de salir)
// y en la app que bloquea las navegaciones que no vienen de un toque tuyo (sinAislar, 1.0.20+).
const sinAislarPermitido = !window.MorvehApp || typeof window.MorvehApp.sinAislar === 'function';
// (YouTube, Vimeo y Dailymotion funcionan aislados; el resto, también los servidores que no se
// reconocen, van sin aislar: los enlaces los pone solo la administración desde el gestor)
const SERVIDORES_AISLADOS = ['YouTube', 'Vimeo', 'Dailymotion'];
window.addEventListener('beforeunload', (e) => { if (document.querySelector('iframe.incrustado.libre')) { e.preventDefault(); e.returnValue = ''; } });
function incrustar(c, url, otraVez, servidor = 'Genérico') {
  c.innerHTML = '';
  const fr = el('iframe', 'incrustado');
  const libre = sinAislarPermitido && !SERVIDORES_AISLADOS.includes(servidor);
  if (libre) fr.classList.add('libre');
  else fr.setAttribute('sandbox', `allow-scripts allow-same-origin allow-presentation allow-forms${ventanasEnIframe ? ' allow-popups' : ''}`);
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
    // Con el mando, el foco vuelve a la tarjeta del archivo que se estaba viendo (la portada se
    // acaba de repintar y sus filas llegan enseguida: se espera hasta 3 s a que aparezca)
    const clave = actualKey;
    let intentos = 0;
    const volver = () => {
      if (actual >= 0) return;
      const t = [...document.querySelectorAll('#items .item')].find((x) => x.dataset.key === clave);
      const a = document.activeElement;
      if (t) { if (!a || a === document.body || a.closest('#pestanas') || !a.closest('#items')) { t.focus({ preventScroll: true }); t.scrollIntoView({ block: 'center', inline: 'nearest' }); } return; }
      if (++intentos < 15) setTimeout(volver, 200);
    };
    volver();
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
  MediaPlayPause: 'play', MediaPlay: 'reanudar', MediaPause: 'pausar', MediaStop: 'pausar', MediaRewind: 'retroceder', MediaFastForward: 'avanzar',
  MediaTrackNext: 'siguiente', MediaTrackPrevious: 'anterior', ChannelUp: 'siguiente', ChannelDown: 'anterior',
};
// Códigos de los mandos de Samsung y LG que no traen nombre de tecla
// (427/428: canal + y − de Samsung, que en el reproductor pasan de capítulo)
const CODIGOS = { 10009: 'atras', 461: 'atras', 415: 'play', 19: 'play', 10252: 'play', 412: 'retroceder', 417: 'avanzar', 38: 'arriba', 40: 'abajo', 37: 'izq', 39: 'der', 13: 'ok', 427: 'siguiente', 428: 'anterior', 176: 'siguiente', 177: 'anterior' };
// Mayús+N / Mayús+P en el teclado: siguiente / anterior (como en YouTube)
const tecla = (e) => (e.shiftKey && (e.key === 'N' || e.key === 'n') ? 'siguiente' : e.shiftKey && (e.key === 'P' || e.key === 'p') ? 'anterior' : null)
  || TECLAS[e.key] || CODIGOS[e.keyCode] || null;

const ENFOCABLES_APP = '.destacado .boton, #pestanas button, #mi-cuenta, #salir-app, #migas a, #cabecera summary, #cabecera a, #cabecera button, .chip-cat, .fila-titulo a, .cat:not(.vacia), #items .item, #mas:not([hidden])';
// (la barra de progreso no: con el mando se avanza y retrocede desde el propio vídeo con ← →)
const ENFOCABLES_VISOR = '.anuncio-pausa button, .anuncio-pausa a, .anuncio-previo button, .siguiente button, .repro .de-cero, #visor .barra .boton:not([hidden]), #visor .flecha:not([hidden]), .controles .boton, .controles select, #vcontenido > video, .repro video, .ficha a, .ficha summary, .ficha input, .ficha select, .ficha button, .fallo-enlace button, .servidores button, #vcontenido > iframe.incrustado';

// Lo escondido (la barra de progreso viendo el vídeo) no cuenta para el mando
const visible = (x) => {
  const r = x.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const e = getComputedStyle(x);
  return e.visibility !== 'hidden' && e.pointerEvents !== 'none';
};

// Todo lo que se puede pulsar en la pantalla de delante, para que el mando llegue a todas partes
// (no solo a una lista fija): botones, enlaces, campos, desplegables… de la portada, las
// secciones, las series, «Mi cuenta» o el reproductor. Fuera: lo que va dentro de una carátula
// (su estrella), lo que no se enfoca a propósito (tabindex -1, como las flechas ‹ › de las filas)
// y la barra de progreso del vídeo (con el mando se avanza con ← → desde el propio vídeo).
const PULSABLES = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';
function candidatosMando(enCuenta, enVisor, capaAnuncio) {
  const fijos = capaAnuncio ? capaAnuncio.querySelectorAll('button, a')
    : document.querySelectorAll(enCuenta ? '#cuenta button, #cuenta input, #cuenta a' : enVisor ? ENFOCABLES_VISOR : ENFOCABLES_APP);
  const zonas = capaAnuncio ? [] : enCuenta ? [$('#cuenta')] : enVisor ? [$('#visor')] : [document.querySelector('header'), document.querySelector('main')];
  const todos = new Set(fijos);
  for (const z of zonas) {
    if (!z) continue;
    for (const x of z.querySelectorAll(PULSABLES)) {
      if (x.disabled || x.tabIndex < 0) continue;
      if (x.parentElement && x.parentElement.closest('.item, .cat')) continue;
      if (x.type === 'range' && x.closest('.repro')) continue;
      todos.add(x);
    }
  }
  // Lo de un desplegable cerrado no se puede enfocar (solo su título, que lo abre con OK); el
  // botón grande ▶ del vídeo tampoco hace falta: OK sobre el propio vídeo hace lo mismo
  const cerrado = (x) => { const d = x.closest('details'); return d && !d.open && !(x.tagName === 'SUMMARY' && x.parentElement === d); };
  // En el orden de la página (para «Mi cuenta», que va en una columna)
  return [...todos].filter((x) => visible(x) && !cerrado(x) && !x.matches('.gran-play')).sort((p, q) => (p.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

function moverFoco(dir) {
  const enCuenta = document.documentElement.classList.contains('con-cuenta');
  const enVisor = !enCuenta && actual >= 0;
  // Con un anuncio en pantalla, el foco no sale de él (ni va a los controles del vídeo de detrás)
  // (lo mismo con la lista de idiomas del audio abierta: las flechas van de un idioma a otro)
  const capaAnuncio = enVisor && (document.querySelector('.anuncio-previo') || document.querySelector('.menu-audio'));
  const cands = candidatosMando(enCuenta, enVisor, capaAnuncio);
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
  // Del vídeo, ↓ baja siempre a ▶ (el primero de los controles), no al botón que quede debajo
  if (enVisor && dir === 'abajo' && a.tagName === 'VIDEO') {
    const play = a.closest('.repro') && a.closest('.repro').querySelector('.controles .grupo.izq .boton');
    if (play && visible(play)) { play.focus({ preventScroll: true }); return; }
  }
  const r = a.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let mejor = null, puntos = Infinity;
  // ← → no se salen de su fila: ni de la de botones del reproductor, ni de una fila de
  // carátulas (al llegar al final no salta a otra fila), ni de las categorías de arriba
  const horizontal = dir === 'izq' || dir === 'der';
  // (en la cuadrícula de una sección, ← → no se escapan al menú de arriba: siguen por las tarjetas)
  const fila = horizontal && a.closest && (a.closest('.controles, .carrusel, .categorias-chips, .destacado-botones') || (a.matches('#items > .item') && $('#items')));
  const opciones = [];
  for (const c of cands) {
    if (fila && !fila.contains(c)) continue;
    if (c === a) continue;
    const s = c.getBoundingClientRect();
    const x = s.left + s.width / 2, y = s.top + s.height / 2;
    const dx = x - cx, dy = y - cy;
    const principal = { arriba: -dy, abajo: dy, izq: -dx, der: dx }[dir];
    if (principal <= 2) continue;
    // ↑ ↓: lo de la misma fila (centros casi a la misma altura) no cuenta como «la de abajo»
    if (!horizontal && principal < Math.min(r.height, s.height) * 0.5) continue;
    // Los títulos de las filas («Novedades en…  Ver todo») no frenan al bajar o subir con el
    // mando (lo mismo hacen los botones de categoría de arriba)
    if (!horizontal && c.matches('.fila-titulo a')) continue;
    const lateral = horizontal ? Math.abs(dy) : Math.abs(dx);
    // Al subir, el menú de arriba (fijo) solo gana si no queda nada del contenido por encima:
    // así ↑ pasa de una fila del inicio a la anterior y no salta al menú
    const alMenu = dir === 'arriba' && !a.closest('header') && c.closest('header');
    // Lo que separa los bordes (no los centros): la fila de justo debajo/encima está a ~0
    const borde = Math.max(0, dir === 'abajo' ? s.top - r.bottom : dir === 'arriba' ? r.top - s.bottom : dir === 'der' ? s.left - r.right : r.left - s.right);
    opciones.push({ c, principal, lateral, alMenu, borde });
  }
  if (horizontal) {
    for (const o of opciones) { const p = o.principal + o.lateral * 2.5; if (p < puntos) { puntos = p; mejor = o.c; } }
  } else {
    // ↑ ↓ van siempre a la fila de al lado (la más cercana en esa dirección, aunque su carátula
    // esté al otro extremo de la pantalla) y, dentro de ella, a lo que quede más a la par
    const sinMenu = opciones.filter((o) => !o.alMenu);
    const lista = sinMenu.length ? sinMenu : opciones;
    const cerca = Math.min(...lista.map((o) => o.borde));
    for (const o of lista) {
      if (o.borde > cerca + 24) continue;
      const p = o.lateral * 4 + o.principal;
      if (p < puntos) { puntos = p; mejor = o.c; }
    }
  }
  // Al pasar a otra fila de carátulas se vuelve a la que tenías elegida en ella (como en las apps
  // de la tele), si sigue en la fila
  const filaVieja = a.closest('.carrusel');
  if (filaVieja) filaVieja._ultimo = a;
  // ← desde la primera carátula de una fila: a su título («Novedades en…  Ver todo ›»)
  if (!mejor && dir === 'izq' && filaVieja && a === filaVieja.firstElementChild) {
    const titulo = a.closest('.fila') && a.closest('.fila').querySelector('.fila-titulo a');
    if (titulo && visible(titulo)) mejor = titulo;
  }
  // Desde el título, → o ↓ entran en su fila (por la carátula que tenías elegida)
  if (a.matches('.fila-titulo a') && (dir === 'der' || dir === 'abajo')) {
    const suFila = a.closest('.fila') && a.closest('.fila').querySelector('.carrusel');
    const destino = suFila && (suFila._ultimo && suFila.contains(suFila._ultimo) ? suFila._ultimo : suFila.firstElementChild);
    if (destino && visible(destino)) mejor = destino;
  }
  if (mejor && !horizontal) {
    const filaNueva = mejor.closest('.carrusel');
    const recordada = filaNueva && filaNueva !== a.closest('.carrusel') && filaNueva._ultimo;
    if (recordada && recordada.isConnected && filaNueva.contains(recordada) && visible(recordada)) mejor = recordada;
  }
  // En la cuadrícula de una sección o una serie, ← → siguen de una fila a la siguiente (al final
  // de una fila, → pasa a la primera de la de abajo), como leyendo
  if (!mejor && horizontal && a.matches('#items > .item')) {
    const lista = [...document.querySelectorAll('#items > .item')].filter(visible);
    mejor = lista[lista.indexOf(a) + (dir === 'der' ? 1 : -1)] || null;
  }
  // Al bajar hasta «Cargar más» se carga solo y el foco sigue en la primera tarjeta nueva
  if (mejor && mejor.id === 'mas' && dir === 'abajo' && !cargar.ocupado) {
    siguienteFoco = document.querySelectorAll('#items > .item').length;
    a.blur();
    cargar(true).finally(() => { siguienteFoco = null; });
    return;
  }
  if (!mejor) { topar(a, dir); return; }
  mejor.focus({ preventScroll: true });
  // Con la flecha mantenida no se anima (si no, la página se queda atrás del foco)
  const comportamiento = rapido ? 'auto' : 'smooth';
  // El menú de arriba está fijo: al subir hasta él, la página vuelve al principio
  if (mejor.closest('header') || mejor.closest('.destacado')) scrollTo({ top: 0, behavior: comportamiento });
  else if (!enCuenta && !enVisor) {
    // Dentro de una fila de carátulas: siempre se ve un trozo de la siguiente (y de la anterior)
    // para saber que hay más; al final de la fila no queda pegada al borde
    const carrusel = mejor.closest('.carrusel');
    if (carrusel) {
      const c = carrusel.getBoundingClientRect(), s = mejor.getBoundingClientRect();
      const margen = Math.min(s.width * 0.6, c.width * 0.2);
      const dx = s.right > c.right - margen ? s.right - (c.right - margen) : s.left < c.left + margen ? s.left - (c.left + margen) : 0;
      if (dx) carrusel.scrollBy({ left: dx, behavior: comportamiento });
    }
    // Y en vertical, que se vea entera con aire alrededor (el menú de arriba es fijo y tapaba la
    // fila al subir): la fila de carátulas con su título, o la tarjeta
    if (!horizontal || !carrusel) {
      const caja = (!horizontal && mejor.closest('.fila')) || mejor;
      const r2 = caja.getBoundingClientRect();
      const cabecera = document.querySelector('header');
      const pegada = cabecera && /fixed|sticky/.test(getComputedStyle(cabecera).position);
      const aire = Math.min(innerHeight * 0.12, 90); // se asoma la fila de al lado
      const arriba = (pegada ? Math.max(0, cabecera.getBoundingClientRect().bottom) : 0) + aire;
      const abajo = innerHeight - aire;
      let dy = 0;
      if (r2.height > abajo - arriba) dy = r2.top - arriba; // más alta que la pantalla: su principio arriba
      else if (r2.bottom > abajo) dy = r2.bottom - abajo;
      else if (r2.top < arriba) dy = r2.top - arriba;
      if (dy) scrollBy({ top: dy, behavior: comportamiento });
    }
  } else mejor.scrollIntoView({ block: 'nearest', behavior: comportamiento });
}

// Al llegar a un borde (fin de una fila, lo más alto de la página…) la tarjeta da un pequeño
// rebote hacia ese lado: así se nota que el mando ha respondido y que no hay más
function topar(a, dir) {
  if (!a || !a.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const d = 6, [x, y] = { arriba: [0, -d], abajo: [0, d], izq: [-d, 0], der: [d, 0] }[dir] || [0, 0];
  const base = getComputedStyle(a).transform;
  const t = base && base !== 'none' ? `${base} ` : '';
  a.animate([{ transform: `${t}translate(0,0)` }, { transform: `${t}translate(${x}px,${y}px)` }, { transform: `${t}translate(0,0)` }], { duration: 180, easing: 'ease-out' });
}
// En la tele, al abrir la app el foco ya está en «▶ Reproducir» del destacado (o, si no hay, en la
// primera categoría): así el primer OK hace algo y se ve dónde estás sin tocar las flechas
if (esTele) {
  let intentos = 0;
  const vigia = setInterval(() => {
    const a = document.activeElement;
    if (++intentos > 50 || (a && a !== document.body)) return clearInterval(vigia);
    if (actual >= 0 || document.documentElement.classList.contains('con-cuenta')) return;
    const primero = document.querySelector('.destacado:not([hidden]) .boton.reproducir') || (intentos > 15 && document.querySelector('.chip-cat, .cat:not(.vacia), #items .item'));
    if (primero) { primero.focus({ preventScroll: true }); clearInterval(vigia); }
  }, 300);
}

// Cada fila de carátulas recuerda cuál fue la última elegida
let rapido = false;
let ultimaRepeticion = 0;
document.addEventListener('focusin', (e) => {
  const fila = e.target.closest && e.target.closest('.carrusel');
  if (fila) fila._ultimo = e.target;
}, true);

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
  // Con la lista de idiomas del audio abierta, Atrás solo la cierra
  const menuAudio = document.querySelector('.menu-audio');
  if (menuAudio) { const r = menuAudio.closest('.repro'); if (r && r.cerrarMenuAudio) r.cerrarMenuAudio(); else menuAudio.remove(); return true; }
  if ($('#visor').classList.contains('cine')) { if (actual >= 0) salirAFicha(); else salirCine(); return true; }
  if (actual >= 0) { cerrar(); return true; }
  if (estado.prefijo) { irA(padre(estado.prefijo)); return true; }
  // En la portada con el mando: el primer Atrás sube al principio (a «▶ Reproducir» del
  // destacado o al menú); solo desde ahí arriba se sale de la app
  if (esTele || document.documentElement.classList.contains('usa-mando')) {
    const inicio = document.querySelector('.destacado:not([hidden]) .boton.reproducir') || document.querySelector('#pestanas button');
    const a = document.activeElement;
    const yaArriba = scrollY < 40 && (!a || a === document.body || a === inicio || a.closest('header'));
    if (inicio && !yaArriba) { inicio.focus({ preventScroll: true }); scrollTo({ top: 0, behavior: 'smooth' }); return true; }
  }
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
  // Flecha mantenida: el mando repite la tecla muy deprisa; se va a un paso cada 110 ms (en el
  // vídeo, un salto cada 250 ms) para que el foco y la página no se queden atrás
  const flecha = ['arriba', 'abajo', 'izq', 'der'].includes(k);
  if (flecha || k === 'retroceder' || k === 'avanzar') {
    const ahora = Date.now();
    const enVideo = actual >= 0 && (!a || a === document.body || a.tagName === 'VIDEO') && (k === 'izq' || k === 'der' || !flecha);
    if (e.repeat && ahora - ultimaRepeticion < (enVideo ? 250 : 110)) { e.preventDefault(); return; }
    ultimaRepeticion = ahora;
    rapido = !!e.repeat;
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
    // Los mandos con ▶ y ❚❚ separados: cada uno hace solo lo suyo
    if (k === 'reanudar' || k === 'pausar') {
      e.preventDefault();
      const v = video || (repro && repro.querySelector('video'));
      if (v && (k === 'reanudar') === v.paused) alternar();
      return;
    }
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
  eventos.addEventListener('version', (e) => nuevaVersion(JSON.parse(e.data)));
  // El servidor acaba de medir lo que dura un vídeo que estaba sin duración: se pone en su ficha
  // guardada y en su tarjeta, sin recargar
  eventos.addEventListener('duracion', (e) => {
    const { key, duracion } = JSON.parse(e.data);
    const p = metas.get(`archivo:${key}`);
    if (!p) return;
    p.then((d) => {
      if (!d?.encontrado) return;
      if (d.episodio) { if (d.episodio.duracion) return; d.episodio.duracion = duracion; } else { if (d.duracion) return; d.duracion = duracion; }
      document.querySelectorAll('[data-key]').forEach((t) => {
        if (t.dataset.key !== key) return;
        const meta = t.querySelector('.meta');
        if (meta && !/\d+ min/.test(meta.textContent)) meta.textContent = [`${duracion} min`, meta.textContent].filter(Boolean).join(' · ');
      });
    });
  });
  // El gestor ha puesto la web en mantenimiento: a su pantalla (los administradores siguen dentro)
  eventos.addEventListener('mantenimiento', (e) => { if (JSON.parse(e.data).activo && !(typeof yo !== 'undefined' && yo && yo.admin)) location.reload(); });
}
// La versión con la que se cargó esta página (la del «app.js?v=…» que puso el servidor): así, aunque
// la primera conexión llegue ya con la versión nueva, se nota que esta página es vieja
versionServidor = ((document.querySelector('script[src*="app.js?v="]') || {}).src || '').match(/[?&]v=([^&#]+)/)?.[1] || null;
function nuevaVersion(v) {
  if (!v) return;
  if (versionServidor && v !== versionServidor) {
    // Si estás viendo algo, se espera a que cierres el vídeo
    if (actual >= 0) recargarAlCerrar = true;
    else return location.reload();
  }
  versionServidor = v;
}
conectar();
// Al volver a la app (iPhone con la web en la pantalla de inicio, móvil, tele): iOS congela la
// página en segundo plano y la conexión en directo puede seguir «abierta» pero muerta, así que no
// llegaría el aviso de versión nueva. Al volver se pregunta la versión directamente y, si estuvo
// fuera más de un minuto, se rehace la conexión.
let ocultaDesde = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { ocultaDesde = Date.now(); return; }
  if (eventos.readyState !== EventSource.OPEN || (ocultaDesde && Date.now() - ocultaDesde > 60000)) conectar();
  fetch('/api/salud', { cache: 'no-store' }).then((r) => r.json()).then((d) => nuevaVersion(d.version)).catch(() => {});
});
// iOS a veces devuelve la página desde su caché de «atrás/adelante» sin volver a cargarla
window.addEventListener('pageshow', (e) => { if (e.persisted) fetch('/api/salud', { cache: 'no-store' }).then((r) => r.json()).then((d) => nuevaVersion(d.version)).catch(() => {}); });

window.addEventListener('hashchange', () => {
  vengoDe = estado.prefijo;
  estado.prefijo = decodeURIComponent(location.hash.slice(1));
  cerrar(); cargar();
});

// El nombre del bucket solo se muestra si no es el mismo que el de la app
api('/api/info').then((d) => { if (d.bucket.toLowerCase() !== 'morvehtv') $('#bucket').textContent = d.bucket; }).catch(() => {});
estado.prefijo = decodeURIComponent(location.hash.slice(1));
// Lee la lista de favoritos y «Seguir viendo» y pinta el inicio (perfiles.js, que se carga detrás)
document.addEventListener('DOMContentLoaded', () => empezar());

