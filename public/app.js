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
const consulta = (params = {}) => Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');

async function api(ruta, params) {
  const r = await fetch(`${ruta}?${consulta(params)}`, { credentials: 'same-origin' });
  const d = await r.json();
  // Sin el PIN de la app, a la pantalla de entrada; sin perfil, a «¿Quién está viendo?»
  if (r.status === 401 && d.error === 'Falta el PIN') { location.href = '/entrar.html'; throw new Error('Falta el PIN'); }
  if (r.status === 401 && ruta !== '/api/yo' && typeof elegirPerfil === 'function') elegirPerfil();
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

// Cada carga lleva un número: si mientras llega la respuesta ha empezado otra (elegir perfil y
// cambiar de carpeta a la vez, doble pulsación en «Cargar más»…), la vieja se descarta. Antes
// las dos se sumaban a la lista y los archivos salían duplicados.
let cargaActual = 0;

async function cargar(mas = false) {
  if (mas && cargar.ocupado) return;
  const n = ++cargaActual;
  const items = $('#items');
  pintarPestanas();
  // «Seguir viendo» y «Favoritos» (pestañas de arriba): listas del perfil, no carpetas de e2
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

function pintarMigas() {
  const partes = estado.prefijo.split('/').filter(Boolean);
  const m = $('#migas'); m.innerHTML = '';
  const enlace = (texto, pref) => {
    // Con href: así el enlace recibe el foco del mando y se abre con OK
    const a = document.createElement('a'); a.textContent = texto; a.href = `#${encodeURIComponent(pref)}`; m.append(a);
  };
  enlace('🏠 Inicio', '');
  if (estado.prefijo.startsWith(':')) {
    const s = document.createElement('span'); s.textContent = '›'; m.append(s);
    m.append(el('span', 'actual', VISTAS_PERFIL[estado.prefijo.slice(1)]?.titulo ?? ''));
    return;
  }
  partes.forEach((p, i) => {
    const s = document.createElement('span'); s.textContent = '›'; m.append(s);
    enlace(p, partes.slice(0, i + 1).join('/') + '/');
  });
}

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
  return natural(a, b);
}

// Por temporada y episodio, si no por nombre en orden natural, y sin las carpetas internas
// que empiezan por «_»
function visibles() {
  const interna = (k) => k.slice(estado.prefijo.length).split('/').some((p) => p.startsWith('_'));
  const carpetas = estado.carpetas.filter((c) => !nombre(c).startsWith('_')).sort(natural);
  const archivos = estado.archivos.filter((f) => !interna(f.key)).sort((x, y) => porCapitulo(x.key, y.key));
  return { carpetas, archivos };
}

function pintar() {
  const { carpetas, archivos } = visibles();
  const items = $('#items');
  items.className = 'rejilla';
  items.innerHTML = '';

  let otras = carpetas;
  if (!estado.prefijo) {
    otras = carpetas.filter((c) => !categoriaDe(c));
    items.append(portada(carpetas));
    if (otras.length || archivos.length) items.append(el('h2', 'seccion', 'Otras carpetas y archivos'));
  }
  for (const c of otras) {
    const t = tarjeta({ icono: '📁', titulo: nombre(c), meta: 'Carpeta', alPulsar: () => irA(c), nuevo: [...nuevas].some((k) => k.startsWith(c)) });
    items.append(t);
    if (estado.prefijo) { conMeta(t, 'carpeta', c); estrella(t, c); }
    marcarPlataforma(t, c);
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

// ---------- Portada por categorías ----------
// Las mismas categorías que MorvehTV. Cada carpeta de primer nivel del bucket se asigna a
// una por su nombre («05 - DOCUMENTALES», «Peliculas»…); la regla más concreta va primero
// para que «DOCUSERIES» o «SERIES TURCAS» no caigan en Series. El anime no tiene categoría
// propia: va en Películas o Series (p. ej. «PELICULAS/PELICULAS NETFLIX ANIME/»).
const CATEGORIAS = [
  { id: 'pelicula', nombre: 'Películas', icono: '🎬', color: '#e5484d', es: (n) => /pelicul|cine|movie/.test(n) },
  { id: 'serie', nombre: 'Series', icono: '📺', color: '#4f8cff', es: (n) => /serie/.test(n) && !/docu|turc/.test(n) },
  { id: 'documental', nombre: 'Documentales', icono: '🌍', color: '#30a46c', es: (n) => /documental/.test(n) },
  { id: 'docuserie', nombre: 'Docuseries', icono: '🎞️', color: '#12a594', es: (n) => /docuserie/.test(n) },
  { id: 'programa', nombre: 'Programas de TV', icono: '📡', color: '#f76b15', es: (n) => /programa|\btv\b/.test(n) },
  { id: 'novela-turca', nombre: 'Novelas turcas', icono: '🌙', color: '#ffb224', es: (n) => /novela|turc/.test(n) },
];

const limpiar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^\d+\s*[-_.]?\s*/, '').trim();

function categoriaDe(carpeta) {
  const n = limpiar(nombre(carpeta));
  return CATEGORIAS.find((c) => c.es(n)) ?? null;
}

const tamanos = new Map();

// Imagen de fondo de cada categoría: la de uno de tus títulos (su ficha de TMDB) y, si aún
// no hay ninguno, la de algo popular de ese tipo. Se elige una vez por visita.
const fondos = new Map();
function fondoCategoria(cat, suyas) {
  if (!fondos.has(cat.id)) {
    const azar = (lista) => lista[Math.floor(Math.random() * lista.length)];
    fondos.set(cat.id, (async () => {
      for (const c of suyas) {
        const d = await api('/api/buscar', { prefijo: c, q: '' }).catch(() => null);
        const videos = ((d && d.archivos) || []).filter((f) => tipo(f.key)[1].startsWith('video')).slice(0, 4);
        const metas = await Promise.all(videos.map((f) => pedirMeta('archivo', f.key)));
        const suyos = metas.filter((m) => m && m.encontrado && m.fondo).map((m) => m.fondo);
        if (suyos.length) return azar(suyos);
      }
      const r = await api('/api/portada', { cat: cat.id }).catch(() => null);
      return r && r.fondos.length ? azar(r.fondos) : null;
    })());
  }
  return fondos.get(cat.id);
}

function portada(carpetas) {
  const caja = el('div', 'categorias');
  for (const cat of CATEGORIAS) {
    const suyas = carpetas.filter((c) => categoriaDe(c) === cat);
    const t = el('div', 'cat' + (suyas.length ? '' : ' vacia'));
    if (suyas.length) { t.tabIndex = 0; t.setAttribute('role', 'button'); }
    t.style.setProperty('--c', cat.color);
    const meta = el('div', 'meta', suyas.length ? 'Contando…' : 'Sin contenido aún');
    t.append(el('div', 'icono', cat.icono), el('div', 'nombre', cat.nombre), meta);
    fondoCategoria(cat, suyas).then((url) => {
      if (!url) return;
      // Se precarga para que aparezca de golpe con un fundido, no a trozos
      const img = new Image();
      img.onload = () => { t.style.setProperty('--img', `url("${url}")`); t.classList.add('con-imagen'); };
      img.src = url;
    });
    if (suyas.length) {
      t.title = suyas.map(nombre).join(', ');
      t.onclick = () => irA(suyas[0]);
      // Archivos y espacio de la categoría (se calcula una vez por sesión)
      Promise.all(suyas.map((c) => {
        if (!tamanos.has(c)) tamanos.set(c, api('/api/tamano', { prefijo: c }).catch(() => null));
        return tamanos.get(c);
      })).then((r) => {
        const ok = r.filter(Boolean);
        meta.textContent = ok.length
          ? `${ok.reduce((s, d) => s + d.objetos, 0)} archivos · ${bytes(ok.reduce((s, d) => s + d.bytes, 0))}`
          : nombre(suyas[0]);
      });
    }
    caja.append(t);
  }
  return caja;
}

// ---------- Carpetas de plataforma ----------
// Una carpeta con el nombre de una plataforma («PELICULAS NETFLIX», «SERIES PRIME VIDEO»…)
// lleva una portada propia: un mosaico con los carteles de lo que hay dentro (completado con
// lo más visto de esa plataforma si aún hay pocos) y, abajo, el logo, el nombre y el color de
// la plataforma
const COLORES_PLATAFORMA = {
  Netflix: '#e50914', 'Prime Video': '#00a8e1', 'Disney+': '#113ccf', Max: '#5822b4', 'Movistar Plus+': '#019df4',
  'Apple TV+': '#6e7480', SkyShowtime: '#ff2d6f', Filmin: '#e6007e', 'Rakuten TV': '#bf0000', Atresplayer: '#ff6a00',
  Mitele: '#00b3e3', 'RTVE Play': '#e2001a',
};
let plataformasConocidas = null;

// Hasta 4 carteles distintos: primero los de tus títulos de esa carpeta (los episodios de una
// serie comparten cartel), luego los populares de la plataforma
const cartelesPl = new Map();
function cartelesPlataforma(id, carpeta) {
  if (!cartelesPl.has(carpeta)) {
    cartelesPl.set(carpeta, (async () => {
      const d = await api('/api/buscar', { prefijo: carpeta, q: '' }).catch(() => null);
      const videos = ((d && d.archivos) || []).filter((f) => tipo(f.key)[1].startsWith('video')).slice(0, 16);
      const metas = await Promise.all(videos.map((f) => pedirMeta('archivo', f.key)));
      const lista = [];
      const meter = (u) => { if (u && lista.indexOf(u) < 0 && lista.length < 4) lista.push(u); };
      metas.forEach((m) => m && m.encontrado && meter(m.poster));
      if (lista.length < 4) {
        const r = await api('/api/portada', { cat: id }).catch(() => null);
        ((r && r.carteles) || []).forEach(meter);
      }
      return lista;
    })());
  }
  return cartelesPl.get(carpeta);
}

async function marcarPlataforma(t, carpeta) {
  if (!plataformasConocidas) plataformasConocidas = api('/api/plataformas').catch(() => { plataformasConocidas = null; return null; });
  const d = await plataformasConocidas;
  if (!d || !t.isConnected) return;
  const regla = d.patrones.map(([src, flags, n]) => [new RegExp(src, flags), n]).find(([re]) => re.test(nombre(carpeta)));
  if (!regla) return;
  const n = regla[1];
  const pl = d.plataformas.find((p) => p.nombre === n);
  t.classList.add('carpeta-plataforma');
  t.style.setProperty('--c', COLORES_PLATAFORMA[n] || 'var(--acento)');
  const mini = t.querySelector('.mini');
  mini.className = 'mini cartel'; // mismo tamaño que los carteles de las películas de al lado
  mini.textContent = '';
  const serie = /serie|novela|program/.test(limpiar(`${estado.prefijo} ${nombre(carpeta)}`));
  const mosaico = el('div', 'mosaico');
  const sello = el('div', 'sello');
  if (pl && pl.logo) { const i = el('img', 'logo-plataforma'); i.src = pl.logo; i.alt = ''; sello.append(i); }
  sello.append(el('div', 'nombre-plataforma', n), el('div', 'tipo-plataforma', serie ? 'Series' : 'Películas'));
  mini.append(mosaico, el('div', 'velo'), sello);
  const meta = t.querySelector('.meta');
  meta.textContent = n;
  if (!tamanos.has(carpeta)) tamanos.set(carpeta, api('/api/tamano', { prefijo: carpeta }).catch(() => null));
  tamanos.get(carpeta).then((r) => { if (r) meta.textContent = r.objetos ? `${r.objetos} archivos · ${bytes(r.bytes)}` : 'Vacía'; });
  const urls = await cartelesPlataforma(`pl:${serie ? 'serie' : 'pelicula'}:${n}`, carpeta);
  if (!t.isConnected || !urls.length) return;
  // Con 1–3 carteles se repiten para llenar las 4 casillas
  for (let i = 0; i < 4; i++) {
    const c = el('div', 'casilla');
    const img = new Image();
    img.onload = () => { c.style.backgroundImage = `url("${img.src}")`; c.classList.add('cargada'); };
    img.src = urls[i % urls.length];
    mosaico.append(c);
  }
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
// 4 para no saturar TMDB con carpetas grandes.
const metas = new Map();
let enVuelo = 0;
const cola = [];

function pedirMeta(clase, clave) {
  const id = `${clase}:${clave}`;
  if (!metas.has(id)) {
    metas.set(id, new Promise((ok) => {
      cola.push(() => (clase === 'carpeta' ? api('/api/meta-carpeta', { prefijo: clave }) : api('/api/meta', { key: clave }))
        .catch(() => null).then(ok));
      siguienteMeta();
    }));
  }
  return metas.get(id);
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
async function conMeta(t, clase, clave) {
  const d = await pedirMeta(clase, clave);
  if (!d?.encontrado || !t.isConnected) return;
  const temp = d.temporada;
  const imagen = d.episodio?.imagen ?? temp?.poster ?? d.poster;
  const mini = t.querySelector('.mini');
  if (imagen) {
    const img = el('img'); img.loading = 'lazy'; img.src = imagen; img.alt = '';
    const visto = mini.querySelector('.visto'); // la barra de lo que ya has visto se queda
    mini.replaceChildren(img);
    if (visto) mini.append(visto);
    mini.classList.add(d.episodio?.imagen ? 'ancha' : 'cartel');
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
  c.append(fichaHtml(d, { clave: partes.join('/') + '/' }));
  if (d.fondo) c.style.backgroundImage = `linear-gradient(90deg, var(--fondo) 30%, rgba(15,17,21,.75)), url("${d.fondo}")`;
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
// Cada perfil recuerda por dónde iba en cada vídeo (se guarda en el servidor, así sigue igual en
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
function reproductor(key, m, urlDirecto = null, renovar = () => api('/api/url', { key }).then((r) => r.url)) {
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
  v.onplay = () => { bPlay.innerHTML = icono('pausa'); bGrande.hidden = true; if (bDeCero) { bDeCero.remove(); bDeCero = null; } mantenerPantalla(true); };
  v.onpause = () => { quiere = false; bPlay.innerHTML = icono('play'); bGrande.hidden = false; mantenerPantalla(false); guardar(); };
  v.oncanplay = () => { cargando.hidden = true; };
  // La lista se va alargando mientras se prepara: si se alcanza el final provisional, se pide
  // más desde ese punto
  v.onended = () => { if (!directo && ahora() < total() - 10) ir(ahora(), true); };
  const alternar = () => {
    if (v.paused) { quiere = true; v.play().catch(() => {}); } else { quiere = false; v.pause(); }
  };
  bGrande.onclick = alternar;
  bPlay.onclick = alternar;
  // En pantallas táctiles tocar la imagen solo enseña u oculta los controles (no pausa, como en
  // las apps de vídeo); con ratón, un clic sobre el vídeo sí pausa
  v.onclick = () => {
    if (!matchMedia('(pointer: coarse)').matches) return alternar();
    const visor = $('#visor');
    if (visor.classList.contains('reposo') || v.paused) return despertar();
    visor.classList.add('reposo');
  };
  bAtras.onclick = () => ir(ahora() - 10);
  bAdelante.onclick = () => ir(ahora() + 10);
  rango.oninput = () => { arrastrando = true; pintarTiempo(Number(rango.value)); };
  rango.onchange = () => { arrastrando = false; ir(Number(rango.value)); };
  if (selAudio) selAudio.onchange = () => { const t = ahora(); parar(sesion); sesion = null; ir(t); };
  bSonido.onclick = () => { v.muted = !v.muted; bSonido.textContent = v.muted ? '🔇' : '🔊'; };
  bPantalla.onclick = () => ($('#visor').classList.contains('cine') ? salirCine() : entrarCine());
  caja.irA = ir;
  caja.saltar = (s) => ir(ahora() + s);
  caja.alternar = alternar;
  caja.parar = () => { if (v.currentTime > 0) guardar(); turno++; clearTimeout(vigia); mantenerPantalla(false); if (hls) hls.destroy(); hls = null; parar(sesion); sesion = null; };
  // Un stream HLS de otro sitio (.m3u8) va por hls.js; el resto, directo al <video>
  if (directo && /\.m3u8(\?|#|$)/i.test(urlDirecto)) cargarHls().then(() => caja.isConnected && fuente(urlDirecto, inicio, false));
  else if (directo) {
    v.preload = 'auto'; v.src = urlDirecto;
    if (inicio) v.addEventListener('loadedmetadata', () => { v.currentTime = inicio; }, { once: true });
  } else ir(inicio, false);
  return caja;
}

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
  $('#ant').hidden = i === 0; $('#sig').hidden = i === lista.length - 1;
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
      c.append(reproductor(f.key, m || { duracion: 0, audios: [] }, directo || !m ? url : null));
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
  MediaTrackNext: 'siguiente', MediaTrackPrevious: 'anterior',
};
// Códigos de los mandos de Samsung y LG que no traen nombre de tecla
const CODIGOS = { 10009: 'atras', 461: 'atras', 415: 'play', 19: 'play', 10252: 'play', 412: 'retroceder', 417: 'avanzar', 38: 'arriba', 40: 'abajo', 37: 'izq', 39: 'der', 13: 'ok' };
const tecla = (e) => TECLAS[e.key] || CODIGOS[e.keyCode] || null;

const ENFOCABLES_APP = '#pestanas button, #perfil-actual, #salir-app, #migas a, #cabecera summary, #cabecera a, .cat:not(.vacia), #items .item, #mas:not([hidden])';
// (la barra de progreso no: con el mando se avanza y retrocede desde el propio vídeo con ← →)
const ENFOCABLES_VISOR = '.repro .de-cero, #visor .barra .boton:not([hidden]), #visor .flecha:not([hidden]), .controles .boton, .controles select, #vcontenido > video, .repro video, .ficha a, .ficha summary, .ficha input, .ficha select, .ficha button, .fallo-enlace button, #vcontenido > iframe.incrustado';

// Lo escondido (la barra de progreso viendo el vídeo) no cuenta para el mando
const visible = (x) => {
  const r = x.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const e = getComputedStyle(x);
  return e.visibility !== 'hidden' && e.pointerEvents !== 'none';
};

function moverFoco(dir) {
  const enPerfiles = document.documentElement.classList.contains('con-perfiles');
  const enVisor = !enPerfiles && actual >= 0;
  const cands = [...document.querySelectorAll(enPerfiles ? '#perfiles button, #perfiles input' : enVisor ? ENFOCABLES_VISOR : ENFOCABLES_APP)].filter(visible);
  const a = document.activeElement;
  if (!a || a === document.body || !cands.includes(a)) {
    const primero = enVisor || enPerfiles ? cands[0] : (document.querySelector('.cat:not(.vacia), #items .item') || cands[0]);
    if (primero) { primero.focus(); primero.scrollIntoView({ block: 'nearest' }); }
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
    const p = principal + lateral * 2.5;
    if (p < puntos) { puntos = p; mejor = c; }
  }
  if (mejor) {
    mejor.focus();
    // El menú de arriba está fijo: al subir hasta él, la página vuelve al principio
    if (mejor.closest('header')) scrollTo({ top: 0, behavior: 'smooth' });
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
  const escribiendo = a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type !== 'range'));
  if (['arriba', 'abajo', 'izq', 'der'].includes(k)) document.documentElement.classList.add('usa-mando');

  if (k === 'atras') {
    if (escribiendo && e.key === 'Backspace') return;
    if (document.documentElement.classList.contains('con-perfiles')) return; // ahí «Atrás» no navega
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
    if (k === 'siguiente') return abrir(actual + 1);
    if (k === 'anterior') return abrir(actual - 1);
    if (libre && (k === 'izq' || k === 'der')) {
      e.preventDefault();
      if (video) saltar(k === 'izq' ? -10 : 10);
      else abrir(actual + (k === 'izq' ? -1 : 1));
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
$('#ant').onclick = () => abrir(actual - 1);
$('#sig').onclick = () => abrir(actual + 1);

// ---------- Actualización automática ----------
// El servidor repasa el bucket cada 20 s y avisa de lo que se sube, cambia o se borra:
// la carpeta que estás viendo se vuelve a pintar sin recargar la página.
const nuevas = new Set(); // lo subido mientras la app está abierta (lleva la etiqueta NUEVO)
let actualKey = null;

// Mientras ves algo no se toca nada (ni avisos, ni redibujar la portada, ni pedir datos): en
// teles y móviles modestos ese trabajo cortaba la reproducción. Lo nuevo se guarda y se
// aplica al cerrar el vídeo.
let pendientes = null;

async function refrescar({ nuevos, cambiados, borrados }) {
  nuevos.forEach((k) => nuevas.add(k));
  if (actual >= 0) {
    pendientes = pendientes || { nuevos: [], cambiados: [], borrados: [] };
    pendientes.nuevos.push(...nuevos); pendientes.cambiados.push(...cambiados); pendientes.borrados.push(...borrados);
    return;
  }
  tamanos.clear();
  if (![...nuevos, ...cambiados, ...borrados].some((k) => k.startsWith(estado.prefijo))) return;
  const d = await api('/api/listar', { prefijo: estado.prefijo });
  if (actual >= 0) return; // se abrió un vídeo mientras tanto: ya se aplicará al cerrarlo
  estado.carpetas = d.carpetas; estado.archivos = d.archivos; estado.token = d.siguiente;
  pintar();
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

const eventos = new EventSource('/api/eventos');
// El aviso de conexión solo aparece si se corta (su sitio lo ocupan las pestañas del perfil)
eventos.onopen = () => { $('#directo').hidden = true; };
eventos.onerror = () => { $('#directo').hidden = false; };
eventos.addEventListener('cambios', (e) => refrescar(JSON.parse(e.data)).catch(() => {}));
// Al publicar una versión nueva el servidor se reinicia y la conexión vuelve con otra versión:
// la app se recarga sola para usarla (la tele y el móvil no se quedan con la antigua). Si estás
// viendo algo, espera a que cierres el vídeo.
let versionServidor = null;
let recargarAlCerrar = false;
eventos.addEventListener('version', (e) => {
  const v = JSON.parse(e.data);
  if (versionServidor && v !== versionServidor) {
    if (actual >= 0) recargarAlCerrar = true;
    else location.reload();
  }
  versionServidor = v;
});

window.addEventListener('hashchange', () => {
  estado.prefijo = decodeURIComponent(location.hash.slice(1));
  cerrar(); cargar();
});

// El nombre del bucket solo se muestra si no es el mismo que el de la app
api('/api/info').then((d) => { if (d.bucket.toLowerCase() !== 'morvehtv') $('#bucket').textContent = d.bucket; }).catch(() => {});
estado.prefijo = decodeURIComponent(location.hash.slice(1));
// Antes de nada, «¿Quién está viendo?» (perfiles.js, que se carga detrás de este archivo)
document.addEventListener('DOMContentLoaded', () => empezar());

