const $ = (s) => document.querySelector(s);
const leer = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const estado = {
  prefijo: '', carpetas: [], archivos: [], token: null, buscando: '',
  vista: leer('vista', 'rejilla'), internas: leer('internas', '0') === '1', orden: leer('orden', 'nombre'),
};

const TIPOS = [
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
  if (r.status === 401) { location.href = '/entrar.html'; throw new Error('Falta el PIN'); }
  const d = await r.json();
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

async function cargar(mas = false) {
  const items = $('#items');
  if (!mas) {
    estado.carpetas = []; estado.archivos = []; estado.token = null;
    items.innerHTML = '<div class="vacio">Cargando…</div>';
    pintarCabecera(estado.prefijo);
  }
  pintarMigas();
  try {
    const d = await api('/api/listar', { prefijo: estado.prefijo, token: estado.token ?? '' });
    estado.carpetas.push(...d.carpetas);
    estado.archivos.push(...d.archivos);
    estado.token = d.siguiente;
    pintar();
  } catch (e) {
    items.innerHTML = `<div class="vacio error">No se pudo leer el bucket: ${e.message}</div>`;
  }
}

async function buscar(q) {
  estado.buscando = q;
  if (!q) return cargar();
  const items = $('#items');
  items.innerHTML = '<div class="vacio">Buscando…</div>';
  $('#mas').hidden = true;
  try {
    const d = await api('/api/buscar', { prefijo: estado.prefijo, q });
    if (estado.buscando !== q) return;
    estado.carpetas = []; estado.archivos = d.archivos; estado.token = null;
    pintar(d.recortado ? 'Mostrando los primeros 500 resultados.' : '');
  } catch (e) {
    items.innerHTML = `<div class="vacio error">${e.message}</div>`;
  }
}

function pintarMigas() {
  const partes = estado.prefijo.split('/').filter(Boolean);
  const m = $('#migas'); m.innerHTML = '';
  const enlace = (texto, pref) => {
    const a = document.createElement('a'); a.textContent = texto; a.onclick = () => irA(pref); m.append(a);
  };
  enlace('🏠 Inicio', '');
  partes.forEach((p, i) => {
    const s = document.createElement('span'); s.textContent = '›'; m.append(s);
    enlace(p, partes.slice(0, i + 1).join('/') + '/');
  });
}

function ordenados() {
  const a = [...estado.archivos];
  const cmp = {
    nombre: (x, y) => x.key.localeCompare(y.key, 'es', { numeric: true }),
    fecha: (x, y) => new Date(y.fecha) - new Date(x.fecha),
    tamano: (x, y) => y.tamano - x.tamano,
  }[estado.orden];
  return a.sort(cmp);
}

function visibles() {
  const carpetas = estado.carpetas.filter((c) => estado.internas || !nombre(c).startsWith('_'));
  const archivos = ordenados().filter((f) => estado.internas || !f.key.slice(estado.prefijo.length).split('/').some((p) => p.startsWith('_')));
  return { carpetas, archivos };
}

function pintar(nota = '') {
  const { carpetas, archivos } = visibles();
  const items = $('#items');
  items.className = estado.vista;
  items.innerHTML = '';
  const total = archivos.reduce((s, f) => s + f.tamano, 0);

  const est = $('#estado');
  est.innerHTML = '';
  const txt = document.createElement('span');
  txt.textContent = estado.buscando
    ? `${archivos.length} resultado(s) para «${estado.buscando}» · ${bytes(total)}`
    : `${carpetas.length} carpeta(s) · ${archivos.length} archivo(s) · ${bytes(total)}${estado.token ? ' (hay más)' : ''}`;
  est.append(txt);
  if (nota) { const n = document.createElement('span'); n.textContent = nota; est.append(n); }
  if (!estado.buscando) {
    const b = document.createElement('button'); b.className = 'boton'; b.textContent = '📊 Tamaño total de la carpeta';
    b.onclick = async () => {
      b.disabled = true; b.textContent = 'Calculando…';
      try { const d = await api('/api/tamano', { prefijo: estado.prefijo }); b.textContent = `📊 ${d.objetos} objetos · ${bytes(d.bytes)}`; }
      catch (e) { b.textContent = 'Error: ' + e.message; }
    };
    est.append(b);
  }

  let otras = carpetas;
  if (!estado.prefijo && !estado.buscando) {
    otras = carpetas.filter((c) => !categoriaDe(c));
    items.append(portada(carpetas));
    if (otras.length || archivos.length) items.append(el('h2', 'seccion', 'Otras carpetas y archivos'));
  }
  for (const c of otras) {
    const t = tarjeta({ icono: '📁', titulo: nombre(c), meta: 'Carpeta', alPulsar: () => irA(c), nuevo: [...nuevas].some((k) => k.startsWith(c)) });
    items.append(t);
    if (estado.prefijo || estado.buscando) conMeta(t, 'carpeta', c);
  }
  archivos.forEach((f, i) => {
    const [, clase, icono] = tipo(f.key);
    const titulo = estado.buscando ? f.key.slice(estado.prefijo.length) : nombre(f.key);
    const t = tarjeta({ icono, titulo, miniatura: f.miniatura, meta: `${bytes(f.tamano)} · ${fecha(f.fecha)}`, alPulsar: () => abrir(i), nuevo: nuevas.has(f.key) });
    t.dataset.key = f.key;
    items.append(t);
    if (clase.startsWith('video')) conMeta(t, 'archivo', f.key);
  });
  if (!carpetas.length && !archivos.length) items.innerHTML = '<div class="vacio">No hay nada aquí.</div>';
  $('#mas').hidden = !estado.token;
  // En la tele siempre hay algo con foco para que el mando funcione desde el principio
  const conMando = esTele || document.documentElement.classList.contains('usa-mando');
  if (conMando && actual < 0 && (!document.activeElement || document.activeElement === document.body)) moverFoco('abajo');
}

// ---------- Portada por categorías ----------
// Las mismas categorías que MorvehTV. Cada carpeta de primer nivel del bucket se asigna a
// una por su nombre («05 - DOCUMENTALES», «SERIES ANIME», «Peliculas»…); la regla más
// concreta va primero para que «SERIES ANIME» no caiga en Series.
const CATEGORIAS = [
  { id: 'pelicula', nombre: 'Películas', icono: '🎬', color: '#e5484d', es: (n) => /pelicul|cine|movie/.test(n) && !/anime/.test(n) },
  { id: 'serie', nombre: 'Series', icono: '📺', color: '#4f8cff', es: (n) => /serie/.test(n) && !/anime|docu|turc/.test(n) },
  { id: 'documental', nombre: 'Documentales', icono: '🌍', color: '#30a46c', es: (n) => /documental/.test(n) },
  { id: 'docuserie', nombre: 'Docuseries', icono: '🎞️', color: '#12a594', es: (n) => /docuserie/.test(n) },
  { id: 'anime-pelicula', nombre: 'Películas anime', icono: '🍥', color: '#d6409f', es: (n) => /anime/.test(n) && !/serie/.test(n) },
  { id: 'anime-serie', nombre: 'Series anime', icono: '🐉', color: '#8e4ec6', es: (n) => /anime/.test(n) && /serie/.test(n) },
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

function tarjeta({ icono, titulo, miniatura, meta, alPulsar, nuevo }) {
  const d = document.createElement('div'); d.className = 'item'; d.title = titulo;
  d.tabIndex = 0; d.setAttribute('role', 'button');
  const mini = document.createElement('div'); mini.className = 'mini';
  if (miniatura && estado.vista === 'rejilla') {
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
  : `${d.titulo}${d.anio ? ` (${d.anio})` : ''}`;

// Cambia la tarjeta del archivo por la carátula y el título de TMDB
async function conMeta(t, clase, clave) {
  const d = await pedirMeta(clase, clave);
  if (!d?.encontrado || !t.isConnected) return;
  const imagen = d.episodio?.imagen ?? d.poster;
  const mini = t.querySelector('.mini');
  if (imagen && estado.vista === 'rejilla') {
    const img = el('img'); img.loading = 'lazy'; img.src = imagen; img.alt = '';
    mini.replaceChildren(img);
    mini.classList.add(d.episodio?.imagen ? 'ancha' : 'cartel');
  }
  t.querySelector('.nombre').textContent = tituloDe(d);
  if (d.valoracion) t.querySelector('.meta').textContent = `★ ${d.valoracion} · ${t.querySelector('.meta').textContent}`;
}

// Cabecera con fondo, cartel y sinopsis al entrar en la carpeta de una serie
async function pintarCabecera(prefijo) {
  const c = $('#cabecera');
  c.hidden = true; c.innerHTML = '';
  // En «Serie/Temporada 2/» la cabecera es la de la serie
  const partes = prefijo.split('/').filter(Boolean);
  if (/^(?:temporada|season|temp|t|s)\s*\d{1,2}$/i.test(partes.at(-1) ?? '')) partes.pop();
  if (partes.length < 2) return;
  const d = await pedirMeta('carpeta', partes.join('/') + '/');
  if (!d?.encontrado || estado.prefijo !== prefijo) return;
  c.append(fichaHtml(d, { clave: partes.join('/') + '/' }));
  if (d.fondo) c.style.backgroundImage = `linear-gradient(90deg, var(--fondo) 30%, rgba(15,17,21,.75)), url("${d.fondo}")`;
  c.hidden = false;
}

const pista = (p, n) => [(p.titulo || p.idioma || `Pista ${n + 1}`).toUpperCase(), p.codec].filter(Boolean).join(' · ');

// Ficha completa: datos de TMDB + datos técnicos del archivo (si se pasan)
function fichaHtml(d, { archivo, medio, clave } = {}) {
  const f = el('div', 'ficha');
  if (d?.encontrado && (d.episodio?.imagen || d.poster)) {
    const img = el('img', 'cartel'); img.src = d.poster ?? d.episodio.imagen; img.alt = ''; f.append(img);
  }
  const cuerpo = el('div', 'cuerpo');
  f.append(cuerpo);

  if (d?.encontrado) {
    cuerpo.append(el('h2', null, `${d.titulo}${d.anio ? ` (${d.anio})` : ''}`));
    if (d.tituloOriginal && d.tituloOriginal !== d.titulo) cuerpo.append(el('div', 'suave', d.tituloOriginal));
    const chips = el('div', 'chips');
    const chip = (t) => t && chips.append(el('span', 'chip', t));
    chip(d.valoracion && `★ ${d.valoracion}`);
    chip(d.tipo === 'serie' ? `Serie${d.temporadas ? ` · ${d.temporadas} temp.` : ''}` : 'Película');
    chip((d.episodio?.duracion ?? d.duracion) && `${d.episodio?.duracion ?? d.duracion} min`);
    d.generos.forEach(chip);
    cuerpo.append(chips);
    if (d.episodio) {
      cuerpo.append(el('h3', null, `Temporada ${d.episodio.temporada} · Episodio ${d.episodio.numero}: ${d.episodio.titulo}`));
      if (d.episodio.fecha) cuerpo.append(el('div', 'suave', `Emitido el ${new Date(d.episodio.fecha).toLocaleDateString('es-ES')}`));
      if (d.episodio.sinopsis) cuerpo.append(el('p', null, d.episodio.sinopsis));
    }
    if (d.sinopsis) cuerpo.append(el('p', d.episodio ? 'suave' : null, d.sinopsis));
    const linea = (t, v) => {
      if (!v?.length) return;
      const l = el('div', 'linea');
      l.append(el('b', null, `${t}: `), v.join(', '));
      cuerpo.append(l);
    };
    linea('Dirección', d.direccion);
    linea('Creada por', d.creadores);
    linea('Reparto', d.reparto);
    const enlaces = el('div', 'chips');
    if (d.trailer) enlaces.append(Object.assign(el('a', 'boton', '▶ Tráiler'), { href: d.trailer, target: '_blank', rel: 'noopener' }));
    enlaces.append(Object.assign(el('a', 'boton', 'TMDB ↗'), { href: d.tmdb, target: '_blank', rel: 'noopener' }));
    cuerpo.append(enlaces);
  } else if (d) {
    cuerpo.append(el('h2', null, 'Sin datos de TMDB'));
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

// iPhone/iPad (Safari sin MediaSource clásico) reproducen HLS por sí mismos; el resto
// (Android, smart TV, ordenador) lo hace con hls.js
const hlsNativo = (v) => !(window.Hls && Hls.isSupported()) && !!v.canPlayType('application/vnd.apple.mpegurl');

function pantallaCompleta(caja, v) {
  const fuera = document.exitFullscreen || document.webkitExitFullscreen;
  if (document.fullscreenElement || document.webkitFullscreenElement) return fuera.call(document);
  const entrar = caja.requestFullscreen || caja.webkitRequestFullscreen;
  if (entrar) return entrar.call(caja);
  if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone: solo el vídeo puede ir a pantalla completa
}

// Reproductor del vídeo convertido: el servidor prepara HLS desde el segundo pedido, así que
// la barra es propia. Saltar dentro de lo ya preparado es inmediato; más lejos, se pide de
// nuevo desde ese punto.
function reproductor(key, m) {
  const caja = el('div', 'repro');
  const v = el('video'); v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', '');
  const barra = el('div', 'controles');
  const bPlay = el('button', 'boton', '▶');
  const bAtras = el('button', 'boton', '⟲ 10');
  const bAdelante = el('button', 'boton', '10 ⟳');
  const rango = el('input'); rango.type = 'range'; rango.min = 0; rango.max = Math.floor(m.duracion) || 0; rango.step = 10; rango.value = 0;
  const tiempo = el('span', 'tiempo', `0:00 / ${hms(m.duracion)}`);
  const bSonido = el('button', 'boton', '🔊');
  const bPantalla = el('button', 'boton', '⛶');
  barra.append(bPlay, bAtras, bAdelante, rango, tiempo);

  let selAudio = null;
  if (m.audios.length > 1) {
    selAudio = el('select');
    m.audios.forEach((a, n) => selAudio.append(new Option(`🗣 ${(a.titulo || a.idioma || `Pista ${n + 1}`).toUpperCase()}`, n)));
    barra.append(selAudio);
  }
  barra.append(bSonido, bPantalla);
  const cargando = el('div', 'cargando', 'Preparando vídeo…');
  caja.append(v, cargando, barra);

  let desde = 0;
  let sesion = null;
  let hls = null;
  let turno = 0;
  let arrastrando = false;
  const ahora = () => desde + v.currentTime;
  const preparado = () => (v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0);
  const parar = (id) => id && fetch(`/api/hls-parar?id=${id}`, { keepalive: true }).catch(() => {});

  // «inicio»: segundo de la lista por el que empezar (se prepara un poco antes del punto pedido).
  // «reproducir»: falso al recuperarse de un corte con el vídeo en pausa (sigue en pausa)
  function fuente(url, inicio, reproducir) {
    if (hls) { hls.destroy(); hls = null; }
    const arrancar = () => reproducir && v.play().catch(() => {});
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

  async function ir(t, reproducir = true) {
    t = Math.min(Math.max(0, t), Math.max(0, m.duracion - 5));
    if (sesion && t >= desde && t - desde < preparado() - 2) { v.currentTime = t - desde; return; }
    const mio = ++turno;
    cargando.hidden = false; cargando.textContent = 'Preparando vídeo…';
    try {
      // Empieza 20 s antes: así retroceder un poco es instantáneo
      const antes = Math.min(20, Math.floor(t));
      const r = await api('/api/hls', { key, desde: Math.floor(t) - antes, margen: antes, audio: selAudio ? selAudio.value : 0 });
      if (mio !== turno || !caja.isConnected) return parar(r.id);
      parar(sesion);
      sesion = r.id; desde = r.desde;
      fuente(r.url, t - r.desde, reproducir);
    } catch (e) {
      if (mio === turno) cargando.textContent = e.message;
    }
  }
  const pintarTiempo = (t) => (tiempo.textContent = `${hms(t)} / ${hms(m.duracion)}`);

  v.ontimeupdate = () => { if (!arrastrando) { rango.value = ahora(); pintarTiempo(ahora()); } };
  // Si se queda esperando más de 15 s (corte de red, servidor reiniciado…), retoma solo
  // desde el mismo segundo en vez de quedarse parado
  let vigia = null;
  function retomar() {
    clearTimeout(vigia);
    const t = ahora();
    const seguir = !v.paused;
    parar(sesion); sesion = null;
    ir(t, seguir);
  }
  v.onwaiting = () => {
    cargando.hidden = false; cargando.textContent = 'Cargando…';
    clearTimeout(vigia);
    vigia = setTimeout(() => { if (caja.isConnected && !v.paused && v.readyState < 3) retomar(); }, 15000);
  };
  v.onplaying = () => { cargando.hidden = true; clearTimeout(vigia); };
  v.onplay = () => { bPlay.textContent = '❚❚'; mantenerPantalla(true); };
  v.onpause = () => { bPlay.textContent = '▶'; mantenerPantalla(false); };
  // La lista se va alargando mientras se prepara: si se alcanza el final provisional, se pide
  // más desde ese punto
  v.onended = () => { if (ahora() < m.duracion - 10) ir(ahora()); };
  const alternar = () => (v.paused ? v.play().catch(() => {}) : v.pause());
  bPlay.onclick = alternar;
  v.onclick = alternar;
  bAtras.onclick = () => ir(ahora() - 10);
  bAdelante.onclick = () => ir(ahora() + 10);
  rango.oninput = () => { arrastrando = true; pintarTiempo(Number(rango.value)); };
  rango.onchange = () => { arrastrando = false; ir(Number(rango.value)); };
  if (selAudio) selAudio.onchange = () => { const t = ahora(); parar(sesion); sesion = null; ir(t); };
  bSonido.onclick = () => { v.muted = !v.muted; bSonido.textContent = v.muted ? '🔇' : '🔊'; };
  bPantalla.onclick = () => pantallaCompleta(caja, v);
  caja.irA = ir;
  caja.saltar = (s) => ir(ahora() + s);
  caja.alternar = alternar;
  caja.parar = () => { turno++; clearTimeout(vigia); mantenerPantalla(false); if (hls) hls.destroy(); hls = null; parar(sesion); sesion = null; };
  ir(0);
  return caja;
}

// Vídeo MP4 que va directo desde e2. Si la red se corta, vuelve a pedirlo (con un enlace
// nuevo) desde el mismo segundo en vez de quedarse parado.
function videoDirecto(key, url, alFallar) {
  const v = el('video'); v.controls = true; v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', '');
  let intentos = 0;
  let vigia = null;
  async function retomar() {
    if (!v.isConnected || intentos++ > 5) return;
    const t = v.currentTime;
    const r = await api('/api/url', { key }).catch(() => null);
    if (!r || !v.isConnected) return;
    v.src = r.url;
    v.addEventListener('loadedmetadata', () => { v.currentTime = t; v.play().catch(() => {}); }, { once: true });
  }
  v.onerror = () => (v.error && v.error.code === 2 ? retomar() : alFallar()); // 2 = error de red
  v.onwaiting = () => {
    clearTimeout(vigia);
    vigia = setTimeout(() => { if (!v.paused && v.readyState < 3) retomar(); }, 15000);
  };
  v.onplaying = () => { clearTimeout(vigia); intentos = 0; };
  v.onplay = () => mantenerPantalla(true);
  v.onpause = () => mantenerPantalla(false);
  v.src = url;
  return v;
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

async function abrir(i) {
  pararMedios();
  const lista = visibles().archivos;
  if (i < 0 || i >= lista.length) return;
  actual = i;
  actualKey = lista[i].key;
  const f = lista[i];
  const [, clase] = tipo(f.key);
  $('#visor').classList.add('abierto');
  $('#vtitulo').textContent = f.key;
  $('#vmeta').textContent = `${bytes(f.tamano)} · ${fecha(f.fecha)}`;
  $('#ant').hidden = i === 0; $('#sig').hidden = i === lista.length - 1;
  const c = $('#vcontenido'); c.innerHTML = '<div class="vacio">Cargando…</div>';

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
      if (m && !directo) c.append(reproductor(f.key, m));
      else {
        c.append(videoDirecto(f.key, url, () => {
          c.innerHTML = '<div class="vacio">Este dispositivo no puede reproducir este formato.</div>';
        }));
      }
      enfocarVisor();
      const d = await pedirMeta('archivo', f.key);
      if (actual === i) c.append(fichaHtml(d || { encontrado: false }, { archivo: f, medio: m, clave: f.key }));
    } else if (clase === 'imagen') {
      const img = el('img'); img.src = url; img.alt = nombre(f.key); c.append(img);
    } else if (clase === 'audio') {
      const a = el('audio'); a.src = url; a.controls = true; a.autoplay = true; c.append(a);
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

function cerrar() {
  pararMedios();
  $('#visor').classList.remove('abierto');
  $('#vcontenido').innerHTML = '';
  if (actual >= 0) {
    actual = -1;
    // Con el mando, el foco vuelve a la tarjeta del archivo que se estaba viendo
    const t = [...document.querySelectorAll('#items .item')].find((x) => x.dataset.key === actualKey);
    if (t) t.focus();
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

const ENFOCABLES_APP = '#migas a, .herr input, .herr select, .herr .boton, #estado .boton, #cabecera summary, #cabecera a, .cat:not(.vacia), #items .item, #mas:not([hidden])';
const ENFOCABLES_VISOR = '#visor .barra .boton, #visor .flecha:not([hidden]), .controles .boton, .controles select, .controles input, #vcontenido > video, .ficha a, .ficha summary, .ficha input, .ficha select, .ficha button';

const visible = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

function moverFoco(dir) {
  const enVisor = actual >= 0;
  const cands = [...document.querySelectorAll(enVisor ? ENFOCABLES_VISOR : ENFOCABLES_APP)].filter(visible);
  const a = document.activeElement;
  if (!a || a === document.body || !cands.includes(a)) {
    const primero = enVisor ? cands[0] : (document.querySelector('.cat:not(.vacia), #items .item') || cands[0]);
    if (primero) { primero.focus(); primero.scrollIntoView({ block: 'nearest' }); }
    return;
  }
  const r = a.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let mejor = null, puntos = Infinity;
  for (const c of cands) {
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
    mejor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// Al abrir un vídeo con el mando, el foco va al botón de play
function enfocarVisor() {
  if (!esTele && !document.documentElement.classList.contains('usa-mando')) return;
  const b = document.querySelector('.controles .boton') || document.querySelector('#vcontenido > video') || $('#vcerrar');
  if (b) b.focus();
}

// Un paso atrás: cerrar panel o vídeo, quitar la búsqueda o subir de carpeta. Devuelve false
// si ya está en la portada (la app de Android usa eso para salir con el botón Atrás).
function atras() {
  if (window.morvehSaltarIntro && window.morvehSaltarIntro()) return true;
  if (!$('#dispositivos').hidden) { $('#dispositivos').hidden = true; return true; }
  if (actual >= 0) { cerrar(); return true; }
  if (estado.buscando) { $('#q').value = ''; buscar(''); return true; }
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
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    e.preventDefault();
    atras();
    return;
  }
  if (escribiendo) {
    // En el buscador, ↑ ↓ salen hacia los botones o las tarjetas
    if (a.tagName === 'INPUT' && (k === 'arriba' || k === 'abajo')) { e.preventDefault(); moverFoco(k); }
    return;
  }
  if (k === 'ok' && a && a.matches('.item, .cat')) { e.preventDefault(); a.click(); return; }

  if (actual >= 0) {
    const repro = document.querySelector('#vcontenido .repro');
    const video = document.querySelector('#vcontenido video');
    // «Libre» = el foco no está en un botón: ← → mueven el vídeo y OK pausa
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

let espera;
$('#q').oninput = (e) => { clearTimeout(espera); espera = setTimeout(() => buscar(e.target.value.trim()), 400); };

$('#orden').value = estado.orden;
$('#orden').onchange = (e) => { estado.orden = e.target.value; guardar('orden', estado.orden); pintar(); };

const pintarVista = () => ($('#vista').textContent = estado.vista === 'rejilla' ? '☷ Lista' : '▦ Cuadrícula');
pintarVista();
$('#vista').onclick = () => { estado.vista = estado.vista === 'rejilla' ? 'lista' : 'rejilla'; guardar('vista', estado.vista); pintarVista(); pintar(); };

$('#internas').classList.toggle('activo', estado.internas);
$('#internas').onclick = () => {
  estado.internas = !estado.internas; guardar('internas', estado.internas ? '1' : '0');
  $('#internas').classList.toggle('activo', estado.internas); pintar();
};

// ---------- Actualización automática ----------
// El servidor repasa el bucket cada 20 s y avisa de lo que se sube, cambia o se borra:
// la carpeta que estás viendo se vuelve a pintar sin recargar la página.
const nuevas = new Set(); // lo subido mientras la app está abierta (lleva la etiqueta NUEVO)
let actualKey = null;

async function refrescar({ nuevos, cambiados, borrados }) {
  nuevos.forEach((k) => nuevas.add(k));
  tamanos.clear();
  const archivosNuevos = nuevos.filter((k) => !k.endsWith('/'));
  if (archivosNuevos.length) {
    aviso(archivosNuevos.length === 1 ? `Nuevo: ${nombre(archivosNuevos[0])}` : `${archivosNuevos.length} archivos nuevos`, 5000);
  }
  if (![...nuevos, ...cambiados, ...borrados].some((k) => k.startsWith(estado.prefijo))) return;
  if (estado.buscando) return buscar(estado.buscando);
  const d = await api('/api/listar', { prefijo: estado.prefijo });
  estado.carpetas = d.carpetas; estado.archivos = d.archivos; estado.token = d.siguiente;
  pintar();
  // Si hay un vídeo abierto, las flechas siguen apuntando a sus vecinos de la nueva lista
  if (actual >= 0) {
    const lista = visibles().archivos;
    actual = lista.findIndex((f) => f.key === actualKey);
    $('#ant').hidden = actual <= 0;
    $('#sig').hidden = actual < 0 || actual >= lista.length - 1;
  }
}

const eventos = new EventSource('/api/eventos');
eventos.onopen = () => { $('#directo').classList.add('vivo'); $('#directo').textContent = 'en directo'; };
eventos.onerror = () => { $('#directo').classList.remove('vivo'); $('#directo').textContent = 'sin conexión'; };
eventos.addEventListener('cambios', (e) => refrescar(JSON.parse(e.data)).catch(() => {}));

window.addEventListener('hashchange', () => {
  estado.prefijo = decodeURIComponent(location.hash.slice(1));
  estado.buscando = ''; $('#q').value = ''; cerrar(); cargar();
});

// El nombre del bucket solo se muestra si no es el mismo que el de la app
api('/api/info').then((d) => { if (d.bucket.toLowerCase() !== 'morvehtv') $('#bucket').textContent = d.bucket; }).catch(() => {});
estado.prefijo = decodeURIComponent(location.hash.slice(1));
cargar();

// ---------- Ver en otros dispositivos ----------
// Solo en el ordenador donde corre el servidor (el único al que se le enseña el PIN)
api('/api/red').then((d) => {
  if (!d.pin || !d.urls.length) return;
  const url = d.urls[0];
  $('#otros').hidden = false;
  $('#otros').onclick = () => {
    $('#urlred').textContent = d.urls.join('  ·  ');
    $('#pinred').textContent = d.pin;
    if (window.qrcode && !$('#qr').firstChild) {
      const q = qrcode(0, 'M');
      q.addData(url);
      q.make();
      $('#qr').innerHTML = q.createImgTag(6, 0);
    }
    $('#dispositivos').hidden = false;
    $('#cerrarotros').focus();
  };
}).catch(() => {});
$('#cerrarotros').onclick = () => { $('#dispositivos').hidden = true; };
$('#dispositivos').onclick = (e) => { if (e.target.id === 'dispositivos') $('#dispositivos').hidden = true; };

// En internet las carpetas internas no se pueden ver: sobra el botón «Ocultas»
fetch('/api/modo').then((r) => r.json()).then((d) => { if (d.nube) $('#internas').hidden = true; }).catch(() => {});
