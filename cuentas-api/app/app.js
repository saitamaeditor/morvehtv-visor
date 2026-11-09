// MorvehTV: interfaz propia sobre el servidor de Emby. Habla con la API de Emby en /emby/… (el mismo
// dominio: Caddy la pasa a Emby) con la sesión de cada usuario (su cuenta de Emby). Pantallas:
// entrar, inicio (destacado + carruseles), biblioteca, ficha (con temporadas y episodios), buscar
// y el reproductor propio (hls.js si Emby tiene que convertir). Funciona con ratón, táctil y el
// mando de la tele (flechas para moverse, OK, Atrás).
(() => {
  const API = '/emby';
  const VERSION = '1.0.0';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, clase, texto) => { const e = document.createElement(tag); if (clase) e.className = clase; if (texto != null) e.textContent = texto; return e; };
  const svg = (d, clase = '') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = d; if (clase) s.setAttribute('class', clase); return s; };
  const ICO = {
    play: '<path class="relleno" d="M7 4.5v15l12.5-7.5z"/>',
    pausa: '<rect class="relleno" x="6" y="4.5" width="4" height="15" rx="1"/><rect class="relleno" x="14" y="4.5" width="4" height="15" rx="1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    tráiler: '<rect x="3" y="5" width="18" height="14" rx="2"/><path class="relleno" d="m10 9 5 3-5 3z"/>',
    ok: '<path d="M20 6 9 17l-5-5"/>',
    desde0: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  };
  const TELE = /Android TV|SmartTV|AFT[A-Z]|BRAVIA|GoogleTV/i.test(navigator.userAgent);
  const EN_APP = /Morveh-App/.test(navigator.userAgent);
  if (TELE) document.documentElement.classList.add('tele');

  const guardado = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const guardar = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let sesion = guardado('morveh-sesion'); // { token, usuario, nombre }
  let aparato = guardado('morveh-aparato');
  if (!aparato) { aparato = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, ''); guardar('morveh-aparato', aparato); }

  // ---------- API de Emby ----------
  const autorizacion = () => `MediaBrowser Client="MorvehTV", Device="${TELE ? 'Android TV' : EN_APP ? 'Android' : 'Navegador'}", DeviceId="${aparato}", Version="${VERSION}"${sesion?.token ? `, Token="${sesion.token}"` : ''}`;
  async function api(ruta, datos, metodo) {
    let r;
    try {
      r = await fetch(API + ruta, {
        method: metodo || (datos ? 'POST' : 'GET'),
        headers: { 'X-Emby-Authorization': autorizacion(), accept: 'application/json', ...(datos && { 'content-type': 'application/json' }) },
        body: datos ? JSON.stringify(datos) : undefined,
      });
    } catch { throw new Error('No se pudo conectar con el servidor'); }
    if (r.status === 401 && sesion && !ruta.includes('AuthenticateByName')) { salir('Tu sesión ha caducado: vuelve a entrar'); throw new Error('Sesión caducada'); }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw Object.assign(new Error(r.status === 401 ? 'Usuario o contraseña incorrectos' : t && t.length < 200 ? t : `Error ${r.status}`), { status: r.status });
    }
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  const uid = () => sesion.usuario;
  const CAMPOS = 'PrimaryImageAspectRatio,ProductionYear,Overview,Genres,CommunityRating,OfficialRating,RunTimeTicks,ChildCount,BasicSyncInfo,UserData';

  // Imágenes (Emby las sirve sin sesión; la marca «tag» hace que el navegador las guarde)
  function imagen(item, tipo = 'Primary', alto = 480) {
    if (!item) return null;
    let id = item.Id; let tag = null;
    if (tipo === 'Backdrop') {
      tag = item.BackdropImageTags?.[0];
      if (!tag && item.ParentBackdropImageTags?.[0]) { id = item.ParentBackdropItemId; tag = item.ParentBackdropImageTags[0]; }
    } else if (tipo === 'Thumb') {
      tag = item.ImageTags?.Thumb;
      if (!tag && item.ParentThumbImageTag) { id = item.ParentThumbItemId; tag = item.ParentThumbImageTag; }
      if (!tag) return imagen(item, 'Backdrop', alto);
    } else if (tipo === 'Logo') {
      tag = item.ImageTags?.Logo;
      if (!tag && item.ParentLogoImageTag) { id = item.ParentLogoItemId; tag = item.ParentLogoImageTag; }
    } else {
      tag = item.ImageTags?.Primary;
      if (!tag && item.SeriesPrimaryImageTag) { id = item.SeriesId; tag = item.SeriesPrimaryImageTag; }
    }
    if (!tag) return null;
    return `${API}/Items/${id}/Images/${tipo}?${tipo === 'Backdrop' ? `maxWidth=${alto}` : `maxHeight=${alto}`}&tag=${tag}&quality=88`;
  }
  const fondo = (e, url) => { if (url) e.style.backgroundImage = `url("${url}")`; };

  // ---------- Formato ----------
  const minutos = (ticks) => Math.round((ticks ?? 0) / 6e8);
  const duracion = (ticks) => { const m = minutos(ticks); return !m ? '' : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
  const reloj = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  const nombreEp = (e) => `${e.ParentIndexNumber != null ? `T${e.ParentIndexNumber}` : ''}${e.IndexNumber != null ? `·E${e.IndexNumber}` : ''}`.replace(/^·/, '');

  function aviso(texto, mal = false) {
    const a = el('div', `aviso${mal ? ' mal' : ''}`, texto);
    $('#avisos').append(a);
    setTimeout(() => a.remove(), 3500);
  }

  // ---------- Entrar y salir ----------
  function mostrarEntrar(error = '') {
    $('#app').hidden = true; $('#reproductor').hidden = true; $('#entrar').hidden = false;
    $('#e-error').textContent = error;
    setTimeout(() => $('#e-usuario').focus(), 50);
  }
  function salir(motivo = '') {
    if (sesion?.token) api('/Sessions/Logout', {}).catch(() => {});
    sesion = null; guardar('morveh-sesion', null); vistas = null;
    cerrarReproductor(true);
    history.replaceState(null, '', '#/');
    mostrarEntrar(motivo);
  }
  $('#f-entrar').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button'); b.disabled = true; b.textContent = 'Entrando…';
    $('#e-error').textContent = '';
    try {
      const r = await api('/Users/AuthenticateByName', { Username: $('#e-usuario').value.trim(), Pw: $('#e-clave').value });
      sesion = { token: r.AccessToken, usuario: r.User.Id, nombre: r.User.Name };
      guardar('morveh-sesion', sesion);
      $('#e-clave').value = '';
      arrancar();
    } catch (err) {
      $('#e-error').textContent = err.status === 401 ? 'Usuario o contraseña incorrectos (o la cuenta está desactivada)' : err.message;
    }
    b.disabled = false; b.textContent = 'Entrar';
  };

  let vistas = null; // bibliotecas del usuario
  async function arrancar() {
    $('#entrar').hidden = true; $('#app').hidden = false;
    $('#yo').textContent = (sesion.nombre || '?')[0].toUpperCase();
    try { vistas = (await api(`/Users/${uid()}/Views`)).Items.filter((v) => ['movies', 'tvshows', 'homevideos', 'musicvideos', 'mixed', undefined, null].includes(v.CollectionType)); }
    catch (e) { vistas = []; if (!sesion) return; aviso(e.message, true); }
    pintarMenu();
    ir();
  }
  function pintarMenu() {
    const m = $('#menu'); m.innerHTML = '';
    const a = el('a', null, 'Inicio'); a.href = '#/'; a.dataset.ruta = '/'; m.append(a);
    for (const v of vistas ?? []) { const x = el('a', null, v.Name.replace(/^\d+\s*[-–.]\s*/, '')); x.href = `#/b/${v.Id}`; x.dataset.ruta = `/b/${v.Id}`; m.append(x); }
  }
  const nombreVista = (v) => v.Name.replace(/^\d+\s*[-–.]\s*/, '');

  // Menú de la cuenta
  $('#yo').onclick = () => {
    if ($('.menu-cuenta')) { $('.menu-cuenta').remove(); return; }
    const m = el('div', 'menu-cuenta');
    m.append(el('b', null, sesion.nombre), el('small', null, EN_APP ? 'App MorvehTV' : 'MorvehTV'));
    const s = el('button', null, 'Cerrar sesión'); s.onclick = () => { m.remove(); salir(); };
    m.append(s); document.body.append(m); s.focus();
    setTimeout(() => document.addEventListener('click', function fuera(ev) { if (!m.contains(ev.target) && ev.target !== $('#yo')) { m.remove(); document.removeEventListener('click', fuera); } }), 0);
  };

  // Cabecera transparente sobre el destacado y sólida al bajar
  const cab = $('#cabecera');
  window.addEventListener('scroll', () => cab.classList.toggle('solida', window.scrollY > 40 || !$('#vista').classList.contains('con-destacado')), { passive: true });

  // ---------- Rutas (#/…) ----------
  let generacion = 0; // para descartar respuestas de una pantalla que ya no está
  function ir() {
    if (!sesion) return mostrarEntrar();
    const [ruta, q] = location.hash.slice(1).split('?');
    const p = new URLSearchParams(q ?? '');
    const partes = (ruta || '/').split('/').filter(Boolean);
    if (partes[0] === 'ver') { abrirReproductor(partes[1], { desde: p.get('t') != null ? Number(p.get('t')) : null }); return; }
    cerrarReproductor();
    $('.menu-cuenta')?.remove();
    const v = $('#vista'); const g = ++generacion;
    const actual = partes[0] === 'b' ? `/b/${partes[1]}` : partes.length ? null : '/';
    for (const a of $('#menu').children) a.classList.toggle('activa', a.dataset.ruta === actual);
    v.className = ''; v.innerHTML = '';
    cab.classList.add('solida');
    window.scrollTo(0, 0);
    const vivo = () => g === generacion;
    const pantalla = !partes.length ? inicio(v, vivo) : partes[0] === 'b' ? biblioteca(v, partes[1], p, vivo) : partes[0] === 'i' ? ficha(v, partes[1], vivo)
      : partes[0] === 'buscar' ? buscar(v, p.get('q') ?? '', vivo) : inicio(v, vivo);
    pantalla.catch((e) => { if (vivo() && sesion) { v.innerHTML = ''; v.append(el('p', 'vacio', `No se pudo cargar: ${e.message}`)); } });
  }
  window.addEventListener('hashchange', ir);
  const esqueleto = () => { const e = el('div', 'esqueleto'); e.append(el('div', 'hueso alto')); for (let i = 0; i < 2; i++) { const f = el('div', 'fila-huesos'); for (let j = 0; j < 9; j++) f.append(el('div', 'hueso')); e.append(f); } return e; };

  // ---------- Tarjetas ----------
  function tarjeta(item, { ancha = false } = {}) {
    const a = el('a', `tarjeta${ancha ? ' ancha' : ''}`);
    const esEp = item.Type === 'Episode';
    a.href = esEp && ancha ? `#/ver/${item.Id}` : `#/i/${esEp ? item.SeriesId : item.Id}`;
    if (esEp && !ancha) a.href = `#/i/${item.Id}`;
    const img = el('div', 'img');
    const url = ancha ? (esEp ? imagen(item, 'Primary', 360) ?? imagen(item, 'Thumb', 640) : imagen(item, 'Thumb', 640)) : imagen(item, 'Primary', 420);
    if (url) fondo(img, url); else img.append(el('span', 'sin', item.Name));
    const ud = item.UserData ?? {};
    if (ud.PlayedPercentage > 0 && ud.PlayedPercentage < 100) { const pr = el('div', 'progreso'); const i = el('i'); i.style.width = `${ud.PlayedPercentage}%`; pr.append(i); img.append(pr); }
    else if (ud.Played && item.Type !== 'Series') { const v = el('span', 'visto'); v.append(svg(ICO.ok)); img.append(v); }
    a.append(img);
    if (esEp) a.append(el('b', null, item.SeriesName ?? item.Name), el('small', null, `${nombreEp(item)} · ${item.Name}`));
    else a.append(el('b', null, item.Name), el('small', null, [item.ProductionYear, item.Type === 'Series' && item.ChildCount ? `${item.ChildCount} temp.` : null].filter(Boolean).join(' · ')));
    a.title = item.Name;
    return a;
  }
  function fila(titulo, items, op = {}) {
    const f = el('section', 'fila');
    const h = el('h2');
    // (el título lleva a la biblioteca con ratón o toque; con el mando se salta: ↓ va directo a las tarjetas)
    if (op.enlace) { const a = el('a', null, titulo); a.href = op.enlace; a.tabIndex = -1; h.append(a); } else h.append(titulo);
    const c = el('div', 'carrusel');
    for (const it of items) c.append(tarjeta(it, op));
    f.append(h, c);
    return f;
  }

  // ---------- Inicio ----------
  async function inicio(v, vivo) {
    v.append(esqueleto());
    if (!vistas) return;
    const camposCortos = `Fields=${CAMPOS}&EnableImageTypes=Primary,Backdrop,Thumb,Logo&ImageTypeLimit=1`;
    const [seguir, siguientes, ...ultimos] = await Promise.all([
      api(`/Users/${uid()}/Items/Resume?Limit=20&MediaTypes=Video&${camposCortos}`).then((r) => r.Items).catch(() => []),
      api(`/Shows/NextUp?UserId=${uid()}&Limit=20&${camposCortos}`).then((r) => r.Items).catch(() => []),
      ...vistas.map((x) => api(`/Users/${uid()}/Items/Latest?ParentId=${x.Id}&Limit=20&GroupItems=true&${camposCortos}`).catch(() => [])),
    ]);
    if (!vivo()) return;
    v.innerHTML = '';
    // Destacado: algo reciente con imagen de fondo
    const candidatos = ultimos.flat().filter((x) => (x.Type === 'Movie' || x.Type === 'Series') && x.BackdropImageTags?.length);
    const d = candidatos.length ? candidatos[Math.floor(Math.random() * Math.min(candidatos.length, 8))] : null;
    if (d) { v.classList.add('con-destacado'); cab.classList.remove('solida'); v.append(destacado(d)); }
    const enCurso = [...seguir];
    for (const n of siguientes) if (!enCurso.some((x) => x.Id === n.Id || (x.SeriesId && x.SeriesId === n.SeriesId))) enCurso.push(n);
    if (enCurso.length) v.append(fila('Seguir viendo', enCurso, { ancha: true }));
    vistas.forEach((x, i) => { if (ultimos[i]?.length) v.append(fila(`Novedades en ${nombreVista(x)}`, ultimos[i], { enlace: `#/b/${x.Id}` })); });
    if (!v.querySelector('.tarjeta')) v.append(el('p', 'vacio', 'Todavía no hay nada que ver. En cuanto se añadan películas o series aparecerán aquí.'));
    if (TELE) (v.querySelector('.destacado .boton') ?? v.querySelector('.tarjeta'))?.focus();
  }
  function destacado(d) {
    const s = el('section', 'destacado');
    const f = el('div', 'destacado-fondo'); fondo(f, imagen(d, 'Backdrop', 1920)); s.append(f);
    const t = el('div', 'destacado-texto');
    const logo = imagen(d, 'Logo', 300);
    if (logo) { const i = el('img', 'destacado-logo'); i.src = logo; i.alt = d.Name; t.append(i); } else t.append(el('h1', null, d.Name));
    t.append(datos(d));
    if (d.Overview) t.append(el('p', null, d.Overview));
    const acc = el('div', 'acciones');
    const ver = el('a', 'boton primario'); ver.append(svg(ICO.play), el('span', null, 'Reproducir'));
    ver.href = d.Type === 'Series' ? `#/i/${d.Id}` : `#/ver/${d.Id}`;
    if (d.Type === 'Series') ver.onclick = (e) => { e.preventDefault(); verSerie(d.Id); };
    const mas = el('a', 'boton'); mas.href = `#/i/${d.Id}`; mas.append(svg(ICO.info), el('span', null, 'Más información'));
    acc.append(ver, mas); t.append(acc);
    s.append(t);
    return s;
  }
  function datos(x) {
    const d = el('div', 'datos');
    if (x.CommunityRating) d.append(el('span', 'nota', `★ ${x.CommunityRating.toFixed(1)}`));
    if (x.ProductionYear) d.append(el('span', null, String(x.ProductionYear)));
    if (x.Type !== 'Series' && x.RunTimeTicks) d.append(el('span', null, duracion(x.RunTimeTicks)));
    if (x.Type === 'Series' && x.ChildCount) d.append(el('span', null, `${x.ChildCount} ${x.ChildCount === 1 ? 'temporada' : 'temporadas'}`));
    if (x.OfficialRating) d.append(el('span', 'chip', x.OfficialRating));
    return d;
  }

  // ---------- Biblioteca ----------
  const ORDENES = [['DateCreated,SortName', 'Descending', 'Añadidas recientemente'], ['SortName', 'Ascending', 'Por nombre'], ['ProductionYear,SortName', 'Descending', 'Más nuevas'], ['CommunityRating,SortName', 'Descending', 'Mejor valoradas']];
  async function biblioteca(v, id, p, vivo) {
    const vista = vistas?.find((x) => x.Id === id);
    const tipos = vista?.CollectionType === 'movies' ? 'Movie' : vista?.CollectionType === 'tvshows' ? 'Series' : 'Movie,Series,Video';
    const cab_ = el('div', 'cab-pagina'); const h = el('h1', null, vista ? nombreVista(vista) : 'Biblioteca'); const cuenta = el('small'); h.append(cuenta);
    const orden = el('select'); orden.setAttribute('aria-label', 'Ordenar');
    const elegido = Number(p.get('o') ?? 0);
    ORDENES.forEach(([, , t], i) => { const o = el('option', null, t); o.value = i; o.selected = i === elegido; orden.append(o); });
    orden.onchange = () => { location.hash = `#/b/${id}?o=${orden.value}`; };
    cab_.append(h, orden); v.append(cab_);
    const rej = el('div', 'rejilla'); v.append(rej);
    const fin = el('div'); fin.style.height = '1px'; v.append(fin);
    let desde = 0; let total = Infinity; let cargando = false;
    const [sortBy, sortOrder] = ORDENES[elegido] ?? ORDENES[0];
    const mas = async () => {
      if (cargando || desde >= total || !vivo()) return;
      cargando = true;
      try {
        const r = await api(`/Users/${uid()}/Items?ParentId=${id}&Recursive=true&IncludeItemTypes=${tipos}&SortBy=${sortBy}&SortOrder=${sortOrder}&StartIndex=${desde}&Limit=60&Fields=${CAMPOS}&ImageTypeLimit=1&EnableImageTypes=Primary`);
        if (!vivo()) return;
        total = r.TotalRecordCount; desde += r.Items.length;
        cuenta.textContent = `${total} ${tipos === 'Series' ? (total === 1 ? 'serie' : 'series') : (total === 1 ? 'título' : 'títulos')}`;
        for (const it of r.Items) rej.append(tarjeta(it));
        if (!total) rej.replaceWith(el('p', 'vacio', 'Esta biblioteca está vacía.'));
      } finally { cargando = false; }
      if (fin.getBoundingClientRect().top < innerHeight + 600) mas();
    };
    new IntersectionObserver((e) => { if (e[0].isIntersecting) mas(); }, { rootMargin: '600px' }).observe(fin);
    await mas();
    if (TELE) rej.querySelector('.tarjeta')?.focus();
  }

  // ---------- Buscar ----------
  async function buscar(v, q, vivo) {
    const c = el('div', 'buscador'); const i = el('input'); i.type = 'search'; i.placeholder = 'Películas, series, episodios…'; i.value = q; i.setAttribute('aria-label', 'Buscar');
    const cp = el('div', 'cab-pagina'); cp.append(el('h1', null, 'Buscar'));
    c.append(i); v.append(cp, c);
    const res = el('div'); v.append(res);
    let t = null;
    const lanzar = async () => {
      const texto = i.value.trim();
      history.replaceState(null, '', `#/buscar?q=${encodeURIComponent(texto)}`);
      res.innerHTML = '';
      if (texto.length < 2) { res.append(el('p', 'vacio', 'Escribe al menos dos letras.')); return; }
      const r = await api(`/Users/${uid()}/Items?SearchTerm=${encodeURIComponent(texto)}&Recursive=true&IncludeItemTypes=Movie,Series,Episode&Limit=60&Fields=${CAMPOS}&ImageTypeLimit=1&EnableImageTypes=Primary`);
      if (!vivo() || texto !== i.value.trim()) return;
      res.innerHTML = '';
      if (!r.Items.length) { res.append(el('p', 'vacio', `Nada con «${texto}».`)); return; }
      const rej = el('div', 'rejilla'); for (const it of r.Items) rej.append(tarjeta(it)); res.append(rej);
    };
    i.oninput = () => { clearTimeout(t); t = setTimeout(() => lanzar().catch(() => {}), 300); };
    i.onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(t); lanzar().catch(() => {}); i.blur(); res.querySelector('.tarjeta')?.focus(); } };
    i.focus();
    if (q) await lanzar();
  }

  // ---------- Ficha ----------
  async function ficha(v, id, vivo) {
    v.append(esqueleto());
    const x = await api(`/Users/${uid()}/Items/${id}?Fields=${CAMPOS},People,Studios,RemoteTrailers,OriginalTitle,Taglines`);
    if (!vivo()) return;
    v.innerHTML = ''; v.classList.add('con-destacado'); cab.classList.remove('solida');
    const f = el('div', 'ficha');
    const fo = el('div', 'ficha-fondo'); fondo(fo, imagen(x, 'Backdrop', 1920)); f.append(fo);
    const cuerpo = el('div', 'ficha-cuerpo');
    const po = el('div', 'ficha-poster'); fondo(po, imagen(x, 'Primary', 600)); cuerpo.append(po);
    const t = el('div', 'ficha-texto');
    if (x.Type === 'Episode') t.append(el('div', 'generos', `${x.SeriesName} · ${nombreEp(x)}`));
    t.append(el('h1', null, x.Name));
    if (x.OriginalTitle && x.OriginalTitle.toLowerCase() !== x.Name.toLowerCase()) t.append(el('div', 'original', x.OriginalTitle));
    t.append(datos(x));
    if (x.Genres?.length) t.append(el('div', 'generos', x.Genres.slice(0, 4).join(' · ')));
    // Botones
    const acc = el('div', 'acciones');
    const ud = x.UserData ?? {};
    if (x.Type === 'Series') {
      const b = el('button', 'boton primario'); b.append(svg(ICO.play), el('span', null, 'Ver')); b.onclick = () => verSerie(x.Id); acc.append(b);
      // El texto del botón se afina cuando se sabe por qué episodio va
      api(`/Shows/NextUp?UserId=${uid()}&SeriesId=${x.Id}&Limit=1`).then((r) => { const n = r.Items[0]; if (n && vivo()) b.lastChild.textContent = n.UserData?.PlaybackPositionTicks ? `Continuar ${nombreEp(n)}` : `Ver ${nombreEp(n)}`; }).catch(() => {});
    } else {
      const b = el('a', 'boton primario'); b.href = `#/ver/${x.Id}`;
      b.append(svg(ICO.play), el('span', null, ud.PlaybackPositionTicks ? `Continuar (quedan ${duracion(x.RunTimeTicks - ud.PlaybackPositionTicks) || 'unos segundos'})` : 'Reproducir'));
      acc.append(b);
      if (ud.PlaybackPositionTicks) { const c = el('a', 'boton'); c.href = `#/ver/${x.Id}?t=0`; c.append(svg(ICO.desde0), el('span', null, 'Desde el principio')); acc.append(c); }
    }
    const tr = x.RemoteTrailers?.[0]?.Url;
    if (tr && !TELE) { const b = el('a', 'boton'); b.href = tr; b.target = '_blank'; b.rel = 'noopener'; b.append(svg(ICO.tráiler), el('span', null, 'Tráiler')); acc.append(b); }
    t.append(acc);
    if (x.Overview) t.append(el('p', 'sinopsis', x.Overview));
    const gente = (tipo, n) => (x.People ?? []).filter((p) => p.Type === tipo).slice(0, n).map((p) => p.Name).join(', ');
    const eq = el('div', 'equipo');
    if (gente('Director', 2)) { const l = el('div'); l.append(el('b', null, 'Dirección: '), gente('Director', 2)); eq.append(l); }
    if (gente('Actor', 6)) { const l = el('div'); l.append(el('b', null, 'Reparto: '), gente('Actor', 6)); eq.append(l); }
    if (eq.children.length) t.append(eq);
    cuerpo.append(t); f.append(cuerpo);
    v.append(f);
    if (x.Type === 'Series') await temporadas(f, x, vivo);
    // Más como esto
    api(`/Items/${x.Type === 'Episode' ? x.SeriesId : x.Id}/Similar?UserId=${uid()}&Limit=16&Fields=${CAMPOS}`).then((r) => {
      if (vivo() && r.Items.length) f.append(fila('Más como esto', r.Items));
    }).catch(() => {});
    if (TELE) acc.querySelector('.boton')?.focus();
  }
  async function temporadas(f, serie, vivo) {
    const r = await api(`/Shows/${serie.Id}/Seasons?UserId=${uid()}&Fields=${CAMPOS}`);
    if (!vivo() || !r.Items.length) return;
    const barra = el('div', 'temporadas'); const lista = el('div', 'episodios');
    f.append(barra, lista);
    const elegir = async (t, boton) => {
      for (const b of barra.children) b.classList.toggle('activa', b === boton);
      lista.innerHTML = '';
      const e = await api(`/Shows/${serie.Id}/Episodes?UserId=${uid()}&SeasonId=${t.Id}&Fields=${CAMPOS}`);
      if (!vivo()) return;
      lista.innerHTML = '';
      for (const ep of e.Items) {
        const a = el('a', 'episodio'); a.href = `#/ver/${ep.Id}`;
        const img = el('div', 'img'); fondo(img, imagen(ep, 'Primary', 300) ?? imagen(serie, 'Backdrop', 600));
        const ud = ep.UserData ?? {};
        if (ud.PlayedPercentage > 0 && ud.PlayedPercentage < 100) { const pr = el('div', 'progreso'); const i = el('i'); i.style.width = `${ud.PlayedPercentage}%`; pr.append(i); img.append(pr); }
        else if (ud.Played) { const vv = el('span', 'visto'); vv.append(svg(ICO.ok)); img.append(vv); }
        const tx = el('div', 'ep-texto');
        tx.append(el('b', null, `${ep.IndexNumber != null ? `${ep.IndexNumber}. ` : ''}${ep.Name}`), el('small', null, duracion(ep.RunTimeTicks)));
        if (ep.Overview) tx.append(el('p', null, ep.Overview));
        a.append(img, tx); lista.append(a);
      }
    };
    // Se abre en la temporada por la que vas (o la primera)
    let actual = r.Items[0];
    try { const n = (await api(`/Shows/NextUp?UserId=${uid()}&SeriesId=${serie.Id}&Limit=1`)).Items[0]; if (n) actual = r.Items.find((s) => s.Id === n.SeasonId) ?? actual; } catch {}
    for (const t of r.Items) {
      const b = el('button', null, t.Name); b.onclick = () => elegir(t, b).catch(() => {}); barra.append(b);
      if (t === actual) elegir(t, b).catch(() => {});
    }
  }
  // «Ver» una serie: el siguiente episodio que toca (o el primero)
  async function verSerie(id) {
    try {
      let ep = (await api(`/Shows/NextUp?UserId=${uid()}&SeriesId=${id}&Limit=1`)).Items[0];
      if (!ep) ep = (await api(`/Shows/${id}/Episodes?UserId=${uid()}&Limit=1`)).Items[0];
      if (ep) location.hash = `#/ver/${ep.Id}`; else aviso('Esta serie todavía no tiene episodios', true);
    } catch (e) { aviso(e.message, true); }
  }

  // ---------- Reproductor ----------
  // Lo que el aparato puede reproducir tal cual; lo demás, Emby lo convierte a HLS (H.264 + AAC).
  // MKV con H.264 se «remuxa» (sin recodificar el vídeo: casi no gasta CPU en el servidor)
  const PERFIL = {
    MaxStreamingBitrate: 40000000, MaxStaticBitrate: 100000000, MusicStreamingTranscodingBitrate: 192000,
    DirectPlayProfiles: [
      { Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3' },
      { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9', AudioCodec: 'opus,vorbis' },
    ],
    TranscodingProfiles: [{ Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: '2', MinSegments: '1', BreakOnNonKeyFrames: true }],
    ContainerProfiles: [],
    CodecProfiles: [{ Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '51' }, { Condition: 'NotEquals', Property: 'IsInterlaced', Value: 'true' }] }],
    SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
    ResponseProfiles: [],
  };
  const video = $('#video'); const rep = $('#reproductor');
  let R = null; // reproducción actual: { item, fuente, sesionId, metodo, hls, siguiente, audio, sub, ... }
  let hlsCargando = null;
  const cargarHls = () => hlsCargando ??= new Promise((ok, mal) => { const s = el('script'); s.src = 'hls.min.js'; s.onload = () => ok(window.Hls); s.onerror = () => { hlsCargando = null; mal(new Error('No se pudo cargar el reproductor')); }; document.head.append(s); });

  function pantallaCompleta(si) {
    try {
      if (si && !document.fullscreenElement) rep.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {});
      if (!si && document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
    } catch {}
  }

  async function abrirReproductor(id, { desde = null, audio = null, sub = undefined } = {}) {
    if (R?.item?.Id === id && !rep.hidden && desde == null && audio == null) return;
    await pararReproduccion();
    $('#app').hidden = true; rep.hidden = false; rep.classList.add('cargando');
    $('#rep-menu').hidden = true; $('#rep-aviso').hidden = true;
    pantallaCompleta(true);
    const yo = R = { item: null, empezado: false };
    try {
      const item = await api(`/Users/${uid()}/Items/${id}?Fields=${CAMPOS},MediaStreams`);
      if (R !== yo) return;
      yo.item = item;
      $('#rep-titulo').textContent = item.Type === 'Episode' ? item.SeriesName : item.Name;
      $('#rep-sub').textContent = item.Type === 'Episode' ? `${nombreEp(item)} · ${item.Name}` : [item.ProductionYear, duracion(item.RunTimeTicks)].filter(Boolean).join(' · ');
      const inicioTicks = desde != null ? desde : (item.UserData?.PlaybackPositionTicks ?? 0);
      const q = new URLSearchParams({ UserId: uid(), StartTimeTicks: '0', IsPlayback: 'true', AutoOpenLiveStream: 'true', MaxStreamingBitrate: String(PERFIL.MaxStreamingBitrate) });
      if (audio != null) q.set('AudioStreamIndex', audio);
      const info = await api(`/Items/${id}/PlaybackInfo?${q}`, { DeviceProfile: PERFIL });
      if (R !== yo) return;
      if (info.ErrorCode) throw new Error(info.ErrorCode === 'NotAllowed' ? 'Tu cuenta no puede ver esto' : `Emby no puede reproducirlo (${info.ErrorCode})`);
      const f = info.MediaSources?.[0];
      if (!f) throw new Error('Este vídeo no tiene ninguna fuente');
      yo.fuente = f; yo.sesionId = info.PlaySessionId;
      yo.audio = audio ?? f.DefaultAudioStreamIndex ?? null;
      const directo = f.SupportsDirectPlay && audio == null && !f.TranscodingUrl;
      yo.metodo = directo ? 'DirectPlay' : 'Transcode';
      const url = directo
        ? `${API}/Videos/${id}/stream.${(f.Container || 'mp4').split(',')[0]}?static=true&MediaSourceId=${f.Id}&PlaySessionId=${yo.sesionId}&api_key=${sesion.token}`
        : `${API}${f.TranscodingUrl}`;
      const segundos = inicioTicks / 1e7;
      // Subtítulos de texto (Emby los da en WebVTT)
      video.querySelectorAll('track').forEach((t) => t.remove());
      yo.subs = (f.MediaStreams ?? []).filter((s) => s.Type === 'Subtitle' && s.DeliveryMethod === 'External' && s.DeliveryUrl);
      for (const s of yo.subs) {
        const tr = el('track'); tr.kind = 'subtitles'; tr.label = s.DisplayTitle || s.Language || `Subtítulos ${s.Index}`; tr.srclang = (s.Language || 'und').slice(0, 2); tr.src = API + s.DeliveryUrl; tr.dataset.indice = s.Index;
        video.append(tr);
      }
      const subElegido = sub !== undefined ? sub : (f.DefaultSubtitleStreamIndex ?? -1);
      const ponerSub = () => { for (const t of video.textTracks) t.mode = 'disabled'; const i = yo.subs.findIndex((s) => s.Index === subElegido); if (i >= 0 && video.textTracks[i]) video.textTracks[i].mode = 'showing'; yo.sub = i >= 0 ? subElegido : -1; };
      const esHls = !directo && /\.m3u8/i.test(url);
      const Hls = esHls ? await cargarHls().catch(() => null) : null;
      if (R !== yo) return;
      if (esHls && Hls?.isSupported()) {
        const hls = new Hls({ startPosition: segundos, maxBufferLength: 40, backBufferLength: 60 });
        yo.hls = hls;
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR && (yo.reintentos = (yo.reintentos ?? 0) + 1) <= 3) hls.startLoad();
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && (yo.medios = (yo.medios ?? 0) + 1) <= 2) hls.recoverMediaError();
          else falloVideo('Se cortó la reproducción');
        });
        hls.loadSource(url); hls.attachMedia(video);
      } else {
        video.src = url;
        if (segundos > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = segundos; }, { once: true });
      }
      setTimeout(ponerSub, 300);
      video.play().catch(() => {});
      // Siguiente episodio
      $('#rep-siguiente').hidden = true; yo.siguiente = null;
      if (item.Type === 'Episode') {
        api(`/Shows/${item.SeriesId}/Episodes?UserId=${uid()}&StartItemId=${item.Id}&Limit=2&Fields=${CAMPOS}`).then((r) => {
          if (R !== yo) return;
          yo.siguiente = r.Items.find((e) => e.Id !== item.Id) ?? null;
          $('#rep-siguiente').hidden = !yo.siguiente;
        }).catch(() => {});
      }
      mostrarControles();
    } catch (e) {
      if (R === yo) falloVideo(e.message);
    }
  }

  function falloVideo(texto) {
    rep.classList.remove('cargando');
    const a = $('#rep-aviso'); a.innerHTML = ''; a.hidden = false;
    a.append(el('b', null, 'No se puede reproducir'), el('span', null, texto));
    const acc = el('div', 'acciones');
    const r = el('button', 'boton primario', 'Reintentar'); r.onclick = () => { const id = R?.item?.Id ?? location.hash.split('/')[2]; const pos = Math.floor((video.currentTime || 0) * 1e7); R = null; abrirReproductor(id, { desde: pos || null }); };
    const c = el('button', 'boton', 'Volver'); c.onclick = cerrarDesdeBoton;
    acc.append(r, c); a.append(acc); r.focus();
  }

  // Avisos a Emby: así sabe por dónde vas («Seguir viendo») y el panel lo ve en «En directo»
  const ticks = () => Math.floor((video.currentTime || 0) * 1e7);
  const estadoRep = () => R?.fuente && { ItemId: R.item.Id, MediaSourceId: R.fuente.Id, PlaySessionId: R.sesionId, PositionTicks: ticks(), IsPaused: video.paused, CanSeek: true, PlayMethod: R.metodo, AudioStreamIndex: R.audio, SubtitleStreamIndex: R.sub ?? -1 };
  let latido = null;
  video.addEventListener('playing', () => {
    rep.classList.remove('cargando');
    if (R && !R.empezado) { R.empezado = true; api('/Sessions/Playing', estadoRep()).catch(() => {}); clearInterval(latido); latido = setInterval(() => { if (R?.empezado) api('/Sessions/Playing/Progress', { ...estadoRep(), EventName: 'TimeUpdate' }).catch(() => {}); }, 10000); }
    pintarPlay();
  });
  video.addEventListener('waiting', () => rep.classList.add('cargando'));
  video.addEventListener('canplay', () => rep.classList.remove('cargando'));
  video.addEventListener('pause', () => { pintarPlay(); mostrarControles(); if (R?.empezado) api('/Sessions/Playing/Progress', { ...estadoRep(), EventName: 'Pause' }).catch(() => {}); });
  video.addEventListener('play', () => pintarPlay());
  video.addEventListener('error', () => { if (R && !R.hls && video.error) falloVideo(`El aparato no puede abrir este vídeo (código ${video.error.code})`); });
  video.addEventListener('ended', () => { if (R?.siguiente) cuentaAtras(); else cerrarDesdeBoton(); });
  video.addEventListener('timeupdate', pintarTiempo);
  video.addEventListener('durationchange', pintarTiempo);

  async function pararReproduccion() {
    clearInterval(latido); clearInterval(cuenta);
    const r = R; R = null;
    if (r?.empezado) {
      const e = { ItemId: r.item.Id, MediaSourceId: r.fuente.Id, PlaySessionId: r.sesionId, PositionTicks: ticks() };
      api('/Sessions/Playing/Stopped', e).catch(() => {});
    }
    if (r?.metodo === 'Transcode' && r.sesionId) api(`/Videos/ActiveEncodings?DeviceId=${aparato}&PlaySessionId=${r.sesionId}`, null, 'DELETE').catch(() => {});
    if (r?.hls) { try { r.hls.destroy(); } catch {} }
    video.pause(); video.removeAttribute('src'); video.querySelectorAll('track').forEach((t) => t.remove()); try { video.load(); } catch {}
  }
  function cerrarReproductor(sinVolver = false) {
    if (rep.hidden && !R) return;
    pararReproduccion();
    rep.hidden = true; $('#rep-menu').hidden = true; $('#rep-aviso').hidden = true;
    $('#app').hidden = !sesion || sinVolver;
    pantallaCompleta(false);
  }
  // Volver: si se llegó desde la app, atrás en el historial (vuelve a la ficha); si se abrió el enlace directo, a la ficha
  function cerrarDesdeBoton() {
    const item = R?.item;
    if (history.length > 1 && cerrarDesdeBoton.vieneDeApp) history.back();
    else location.replace(item ? `#/i/${item.Type === 'Episode' ? item.SeriesId : item.Id}` : '#/');
  }
  cerrarDesdeBoton.vieneDeApp = false;
  window.addEventListener('hashchange', (e) => { if (/#\/ver\//.test(e.newURL)) cerrarDesdeBoton.vieneDeApp = !/#\/ver\//.test(e.oldURL); });

  // Controles
  const pintarPlay = () => { const i = video.paused ? ICO.play : ICO.pausa; $('#rep-play-ico').innerHTML = i; $('#rep-centro-ico').innerHTML = i.replace(/ class="relleno"/g, ''); };
  const totalSeg = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (R?.item?.RunTimeTicks ?? 0) / 1e7);
  let arrastrando = false;
  function pintarTiempo() {
    const t = totalSeg();
    $('#rep-actual').textContent = reloj(video.currentTime); $('#rep-total').textContent = reloj(t);
    if (!arrastrando) { const p = t ? (video.currentTime / t) * 1000 : 0; $('#rep-pos').value = p; $('#rep-pos').style.setProperty('--p', `${p / 10}%`); }
  }
  let quieto = null;
  function mostrarControles() {
    rep.classList.remove('quieto');
    clearTimeout(quieto);
    quieto = setTimeout(() => { if (!video.paused && $('#rep-menu').hidden && $('#rep-aviso').hidden) { rep.classList.add('quieto'); if (TELE) $('#rep-centro').focus(); } }, 3500);
  }
  const alternar = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); mostrarControles(); };
  const saltar = (s) => { video.currentTime = Math.max(0, Math.min(totalSeg() - 1, video.currentTime + s)); mostrarControles(); };
  rep.addEventListener('mousemove', mostrarControles);
  rep.addEventListener('touchstart', mostrarControles, { passive: true });
  $('#rep-centro').onclick = alternar; $('#rep-play').onclick = alternar;
  video.onclick = () => (rep.classList.contains('quieto') ? mostrarControles() : alternar());
  $('#rep-menos').onclick = () => saltar(-10); $('#rep-mas').onclick = () => saltar(10);
  $('#rep-cerrar').onclick = cerrarDesdeBoton;
  $('#rep-completa').onclick = () => pantallaCompleta(!document.fullscreenElement);
  $('#rep-siguiente').onclick = () => { if (R?.siguiente) location.replace(`#/ver/${R.siguiente.Id}`); };
  const pos = $('#rep-pos');
  pos.oninput = () => { arrastrando = true; pos.style.setProperty('--p', `${pos.value / 10}%`); $('#rep-actual').textContent = reloj((pos.value / 1000) * totalSeg()); mostrarControles(); };
  pos.onchange = () => { arrastrando = false; video.currentTime = (pos.value / 1000) * totalSeg(); };

  // Audio y subtítulos
  $('#rep-pistas').onclick = () => {
    const m = $('#rep-menu');
    if (!m.hidden) { m.hidden = true; return; }
    m.innerHTML = '';
    const audios = (R?.fuente?.MediaStreams ?? []).filter((s) => s.Type === 'Audio');
    if (audios.length > 1) {
      m.append(el('h3', null, 'Audio'));
      for (const a of audios) {
        const b = el('button', a.Index === R.audio ? 'activa' : null, a.DisplayTitle || a.Language || `Pista ${a.Index}`);
        b.onclick = () => { m.hidden = true; if (a.Index !== R.audio) abrirReproductor(R.item.Id, { desde: ticks(), audio: a.Index, sub: R.sub }); };
        m.append(b);
      }
    }
    m.append(el('h3', null, 'Subtítulos'));
    const no = el('button', R?.sub === -1 || R?.sub == null ? 'activa' : null, 'Sin subtítulos');
    no.onclick = () => { for (const t of video.textTracks) t.mode = 'disabled'; R.sub = -1; m.hidden = true; };
    m.append(no);
    (R?.subs ?? []).forEach((s, i) => {
      const b = el('button', s.Index === R.sub ? 'activa' : null, s.DisplayTitle || s.Language || `Subtítulos ${i + 1}`);
      b.onclick = () => { for (const t of video.textTracks) t.mode = 'disabled'; if (video.textTracks[i]) video.textTracks[i].mode = 'showing'; R.sub = s.Index; m.hidden = true; };
      m.append(b);
    });
    if (!(R?.subs ?? []).length) m.append(el('button', null, 'Este vídeo no tiene subtítulos de texto')).disabled = true;
    m.hidden = false; (m.querySelector('.activa') ?? m.querySelector('button'))?.focus();
    mostrarControles();
  };

  // Siguiente episodio al terminar
  let cuenta = null;
  function cuentaAtras() {
    const sig = R.siguiente; let n = 10;
    const a = $('#rep-aviso'); a.innerHTML = ''; a.hidden = false;
    const t = el('span'); const pinta = () => { t.textContent = `${sig.SeriesName} · ${nombreEp(sig)} · ${sig.Name} — empieza en ${n} s`; };
    pinta();
    const acc = el('div', 'acciones');
    const ya = el('button', 'boton primario'); ya.append(svg(ICO.play), el('span', null, 'Siguiente episodio')); ya.onclick = () => { clearInterval(cuenta); location.replace(`#/ver/${sig.Id}`); };
    const no = el('button', 'boton', 'Cancelar'); no.onclick = () => { clearInterval(cuenta); a.hidden = true; cerrarDesdeBoton(); };
    acc.append(ya, no); a.append(el('b', null, 'Siguiente episodio'), t, acc); ya.focus();
    clearInterval(cuenta);
    cuenta = setInterval(() => { n -= 1; pinta(); if (n <= 0) { clearInterval(cuenta); location.replace(`#/ver/${sig.Id}`); } }, 1000);
  }
  window.addEventListener('pagehide', () => { if (R?.empezado) navigator.sendBeacon?.(`${API}/Sessions/Playing/Stopped?api_key=${sesion?.token}`, new Blob([JSON.stringify(estadoRep())], { type: 'application/json' })); });

  // ---------- Teclado y mando ----------
  const ENFOCABLE = 'a[href], button:not([disabled]), input, select, [tabindex="0"]';
  const visible = (e) => { if (e.closest('[hidden]') || e.tabIndex < 0) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function mover(dir) {
    const raiz = !rep.hidden ? rep : !$('#entrar').hidden ? $('#entrar') : document;
    const todos = [...raiz.querySelectorAll(ENFOCABLE)].filter(visible);
    const actual = document.activeElement;
    if (!actual || actual === document.body || !todos.includes(actual)) { todos[0]?.focus(); return; }
    const a = actual.getBoundingClientRect(); const ax = a.left + a.width / 2; const ay = a.top + a.height / 2;
    // La cabecera está fija arriba: solo se va a ella cuando ya no hay nada más en esa dirección
    const enCab = (e) => Boolean(e.closest('#cabecera'));
    const desdeCab = enCab(actual);
    let mejor = null; let puntos = Infinity; let mejorCab = null; let puntosCab = Infinity;
    for (const e of todos) {
      if (e === actual) continue;
      const r = e.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      const dx = x - ax; const dy = y - ay;
      let principal; let lateral;
      if (dir === 'ArrowRight') { if (r.left < a.right - 8 && dx <= 4) continue; principal = dx; lateral = dy; }
      else if (dir === 'ArrowLeft') { if (r.right > a.left + 8 && dx >= -4) continue; principal = -dx; lateral = dy; }
      else if (dir === 'ArrowDown') { if (r.top < a.bottom - 8 && dy <= 4) continue; principal = dy; lateral = dx; }
      else { if (r.bottom > a.top + 8 && dy >= -4) continue; principal = -dy; lateral = dx; }
      if (principal <= 0) continue;
      const vertical = dir === 'ArrowDown' || dir === 'ArrowUp';
      // ← → solo dentro de la misma fila (que se solapen en vertical): no saltan a la cabecera
      if (!vertical && !(r.bottom > a.top + 4 && r.top < a.bottom - 4)) continue;
      // Distancia entre bordes (la fila de al lado gana a una más lejana) y, de lado, cuánto se aleja
      const hueco = vertical ? Math.max(0, dir === 'ArrowDown' ? r.top - a.bottom : a.top - r.bottom) : Math.max(0, dir === 'ArrowRight' ? r.left - a.right : a.left - r.right);
      const fuera = vertical ? Math.max(0, r.left - a.right, a.left - r.right) : Math.max(0, r.top - a.bottom, a.top - r.bottom);
      const p = hueco * 2 + fuera * 3 + Math.abs(lateral) * 0.15;
      if (enCab(e) && !desdeCab) { if (p < puntosCab) { puntosCab = p; mejorCab = e; } }
      else if (p < puntos) { puntos = p; mejor = e; }
    }
    mejor ??= mejorCab;
    if (mejor) { mejor.focus({ preventScroll: true }); mejor.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); if (dir === 'ArrowUp' && mejor.closest('#cabecera')) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    // Reproductor
    if (!rep.hidden) {
      const enMenu = !$('#rep-menu').hidden || !$('#rep-aviso').hidden;
      const oculto = rep.classList.contains('quieto');
      if (['MediaPlayPause', 'MediaPlay', 'MediaPause', ' '].includes(k) || (k === 'Enter' && oculto)) { e.preventDefault(); if (k === 'MediaPlay') video.play(); else if (k === 'MediaPause') video.pause(); else alternar(); return; }
      if (k === 'MediaFastForward') { saltar(30); return; }
      if (k === 'MediaRewind') { saltar(-30); return; }
      if (k === 'MediaTrackNext' && R?.siguiente) { location.replace(`#/ver/${R.siguiente.Id}`); return; }
      if (k === 'MediaStop') { cerrarDesdeBoton(); return; }
      if (k === 'Escape' || k === 'Backspace') {
        e.preventDefault();
        // Primero se cierra el menú de pistas; si hay un aviso (siguiente episodio, error), se sale
        if (!$('#rep-menu').hidden) { $('#rep-menu').hidden = true; $('#rep-pistas').focus(); return; }
        clearInterval(cuenta); $('#rep-aviso').hidden = true;
        cerrarDesdeBoton(); return;
      }
      if (k.startsWith('Arrow')) {
        // Con los controles escondidos: ← → saltan 10 s; ↑ ↓ los muestran
        if (oculto && !enMenu) { e.preventDefault(); if (k === 'ArrowLeft') saltar(-10); else if (k === 'ArrowRight') saltar(10); else { mostrarControles(); $('#rep-play').focus(); } return; }
        if (document.activeElement === pos && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); saltar(k === 'ArrowLeft' ? -10 : 10); return; }
        e.preventDefault(); mostrarControles(); mover(k); return;
      }
      mostrarControles();
      return;
    }
    if (k === 'Escape' && $('.menu-cuenta')) { $('.menu-cuenta').remove(); $('#yo').focus(); return; }
    if (!k.startsWith('Arrow')) return;
    const a = document.activeElement;
    if (a?.matches('input, select') && (k === 'ArrowLeft' || k === 'ArrowRight' || (a.tagName === 'SELECT' && !TELE))) return;
    e.preventDefault();
    mover(k);
  });
  // Atrás del navegador/mando desde una pantalla interna lleva a la anterior; desde Inicio, la app pregunta si salir
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !rep.hidden && TELE) { /* la tele sale de pantalla completa con Atrás */ } });

  // ---------- Arranque ----------
  if (sesion?.token) {
    // Comprueba que la sesión sigue valiendo antes de enseñar nada
    api(`/Users/${uid()}`).then((u) => { sesion.nombre = u.Name; guardar('morveh-sesion', sesion); arrancar(); }).catch((e) => { if (sesion) { $('#app').hidden = true; mostrarEntrar(e.status ? '' : e.message); } });
  } else mostrarEntrar();
})();
