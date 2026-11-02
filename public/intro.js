// Intro de MorvehTV: se ve al abrir la app (una vez por pestaña; al recargar no se repite).
// Clic, toque, tecla, «Saltar» o el botón Atrás de la app la terminan al momento.
//
// Tres niveles de calidad para que vaya fluida en todas partes:
//   alta  → ordenador: más estrellas, resolución completa y brillos
//   media → móvil, tablet y app: resolución completa (nítida en pantallas densas) y sin desenfoques
//   baja  → smart TV y aparatos modestos: lienzo a 3/4 de resolución y menos estrellas
// Si aun así va a tirones (se mide en los primeros fotogramas), baja un nivel sola.
(() => {
  let vista = false;
  try { vista = sessionStorage.getItem('intro') === '1'; sessionStorage.setItem('intro', '1'); } catch (e) {}
  if (vista || /[?&]sinintro\b/.test(location.search)) return;

  const reducir = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esTele = /SMART-?TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey|HbbTV|VIDAA|Roku|PhilipsTV|Hisense/i.test(navigator.userAgent);
  const esMovil = !esTele && matchMedia('(pointer: coarse)').matches;
  const modesto = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 2;
  let calidad = esTele || (esMovil && modesto) ? 'baja' : esMovil || modesto ? 'media' : 'alta';
  const AJUSTES = {
    alta: { estrellas: 520, escala: 1, maxPixeles: 3e6, chispas: 22 },
    media: { estrellas: 340, escala: 1, maxPixeles: 2.6e6, chispas: 18 },
    baja: { estrellas: 200, escala: 0.75, maxPixeles: 0.9e6, chispas: 12 },
  };
  const DURACION = reducir ? 1500 : 3900;

  const intro = document.createElement('div');
  intro.id = 'intro';
  intro.className = `calidad-${calidad}${esTele ? ' en-tele' : ''}`;
  intro.innerHTML = `
    <canvas></canvas>
    <div class="intro-nebulosa"></div>
    <div class="intro-centro">
      <div class="intro-marca">
        <div class="intro-halo"></div>
        <div class="intro-rayo"></div>
        <div class="intro-chispas"></div>
        <div class="intro-destello"></div>
        <div class="intro-anillo"></div><div class="intro-anillo dos"></div>
        <svg class="intro-logo" viewBox="0 0 128 92" aria-hidden="true">
          <defs>
            <linearGradient id="intro-relleno" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#4f8cff"/><stop offset=".55" stop-color="#8e4ec6"/><stop offset="1" stop-color="#d6409f"/>
            </linearGradient>
          </defs>
          <path class="nube" d="M34 80 H98 A22 22 0 0 0 100 36 A30 30 0 0 0 44 26 A24 24 0 0 0 34 80 Z"/>
          <path class="play" d="M56 38 L76 51 L56 64 Z"/>
          <clipPath id="intro-recorte"><path d="M34 80 H98 A22 22 0 0 0 100 36 A30 30 0 0 0 44 26 A24 24 0 0 0 34 80 Z"/></clipPath>
          <rect class="brillo" clip-path="url(#intro-recorte)" x="-60" y="0" width="40" height="92" fill="url(#intro-brillo)"/>
          <defs>
            <linearGradient id="intro-brillo" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div class="intro-texto">
        <div class="intro-resplandor"></div>
        <h1 class="intro-titulo" aria-label="MorvehTV"></h1>
      </div>
      <div class="intro-sub">TU CONTENIDO · EN TU NUBE</div>
    </div>
    <button class="intro-saltar" type="button">${esTele ? 'Pulsa OK para saltar' : 'Saltar ›'}</button>`;
  document.body.insertBefore(intro, document.body.firstChild);
  document.documentElement.style.overflow = 'hidden';

  // Chispas que salen disparadas de la nube cuando se completa el logo
  const chispas = intro.querySelector('.intro-chispas');
  const COLORES_CHISPA = ['#ffffff', '#8fb4ff', '#c58bff', '#ff8fcf'];
  const tamLogo = intro.querySelector('.intro-marca').offsetWidth || 150;
  for (let i = 0, n = AJUSTES[calidad].chispas; i < n && !reducir; i++) {
    const c = document.createElement('i');
    const angulo = (360 / n) * i + Math.random() * 14;
    c.style.setProperty('--a', `${angulo}deg`);
    c.style.setProperty('--d', `${Math.round(tamLogo * (0.65 + Math.random() * 0.75))}px`);
    c.style.background = c.style.color = COLORES_CHISPA[i % COLORES_CHISPA.length];
    c.style.animationDelay = `${1.22 + Math.random() * 0.12}s`;
    chispas.appendChild(c);
  }

  // Letras con entrada escalonada; el destello las cruza de izquierda a derecha
  const titulo = intro.querySelector('.intro-titulo');
  ['M', 'O', 'R', 'V', 'E', 'H', 'TV'].forEach((t, i) => {
    const s = document.createElement('span');
    s.textContent = t;
    if (t === 'TV') s.className = 'tv';
    s.style.animationDelay = `${1.45 + i * 0.08}s, ${2.25 + i * 0.07}s`;
    titulo.appendChild(s);
  });

  // ---------- Campo de estrellas en 3D: lento al principio, salto a la velocidad de la luz al final ----------
  const lienzo = intro.querySelector('canvas');
  const ctx = lienzo.getContext('2d', { alpha: false });
  const COLORES = ['#ffffff', '#cfe0ff', '#8fb4ff', '#d6a8ff', '#ff9fd2'];
  const NIVELES = 3; // lejos / medio / cerca: cada uno con su grosor y brillo
  let ancho = 0, alto = 0, px = 1;
  let estrellas = [];

  const nueva = (alAzar) => ({
    x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: alAzar ? Math.random() : 1, pz: 1,
    c: (Math.random() * COLORES.length) | 0,
  });
  function preparar() {
    const a = AJUSTES[calidad];
    // Resolución interna del lienzo: limitada para no pintar millones de píxeles por fotograma
    // (en una tele 4K el navegador dice tener 3840×2160)
    px = Math.min(devicePixelRatio || 1, 2) * a.escala;
    const total = innerWidth * innerHeight * px * px;
    if (total > a.maxPixeles) px *= Math.sqrt(a.maxPixeles / total);
    ancho = lienzo.width = Math.max(1, Math.round(innerWidth * px));
    alto = lienzo.height = Math.max(1, Math.round(innerHeight * px));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ancho, alto);
    ctx.lineCap = 'round';
    const n = reducir ? 0 : a.estrellas;
    while (estrellas.length < n) estrellas.push(nueva(true));
    estrellas.length = n;
  }
  preparar();
  addEventListener('resize', preparar);

  const inicio = performance.now();
  let saliendo = null;
  // Velocidad según el momento: deriva suave, frenazo en el destello y aceleración final
  function velocidad(t) {
    if (saliendo) return 0.02 + Math.min(1, (t - saliendo) / 600) * 0.09;
    if (t < 1200) return 0.004 + (t / 1200) * 0.01;
    if (t < 1500) return 0.03;
    if (t < DURACION - 700) return 0.006;
    return 0.006 + ((t - (DURACION - 700)) / 700) * 0.08;
  }

  // Las estrellas se agrupan por color y distancia: unas pocas pinceladas por fotograma en vez
  // de una por estrella (lo que más cuesta en los navegadores de teles y móviles)
  const grupos = Array.from({ length: COLORES.length * NIVELES }, () => []);
  let anterior = inicio;
  const tiempos = [];

  function cuadro(ahora) {
    if (!intro.parentNode) return;
    const t = ahora - inicio;
    medirFluidez(ahora - anterior);
    anterior = ahora;
    const v = velocidad(t);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(0,0,0,${v > 0.03 ? 0.35 : 0.9})`; // rastro cuando va rápido
    ctx.fillRect(0, 0, ancho, alto);
    const cx = ancho / 2, cy = alto / 2, f = Math.max(ancho, alto) * 0.5;
    for (const g of grupos) g.length = 0;
    for (const e of estrellas) {
      e.pz = e.z;
      e.z -= v;
      if (e.z <= 0.01) { Object.assign(e, nueva(false)); continue; }
      const x = cx + (e.x / e.z) * f, y = cy + (e.y / e.z) * f;
      if (x < 0 || x > ancho || y < 0 || y > alto) { Object.assign(e, nueva(false)); continue; }
      const nivel = Math.min(NIVELES - 1, ((1 - e.z) * NIVELES) | 0);
      grupos[e.c * NIVELES + nivel].push(cx + (e.x / e.pz) * f, cy + (e.y / e.pz) * f, x, y);
    }
    for (let i = 0; i < grupos.length; i++) {
      const g = grupos[i];
      if (!g.length) continue;
      const nivel = i % NIVELES;
      ctx.strokeStyle = COLORES[(i / NIVELES) | 0];
      ctx.globalAlpha = [0.35, 0.7, 1][nivel];
      ctx.lineWidth = [0.8, 1.6, 2.6][nivel] * px;
      ctx.beginPath();
      for (let j = 0; j < g.length; j += 4) { ctx.moveTo(g[j], g[j + 1]); ctx.lineTo(g[j + 2], g[j + 3]); }
      ctx.stroke();
    }
    requestAnimationFrame(cuadro);
  }

  // Si los primeros fotogramas van lentos (menos de ~45 por segundo), baja la calidad una vez
  function medirFluidez(ms) {
    if (calidad === 'baja' || tiempos.length > 45) return;
    tiempos.push(ms);
    if (tiempos.length === 45) {
      const mediana = tiempos.slice(10).sort((a, b) => a - b)[17];
      if (mediana > 22) {
        calidad = calidad === 'alta' ? 'media' : 'baja';
        intro.className = intro.className.replace(/calidad-\w+/, `calidad-${calidad}`);
        preparar();
      }
    }
  }
  requestAnimationFrame(cuadro);

  // ---------- Final ----------
  function terminar(rapido) {
    if (saliendo) return;
    saliendo = performance.now() - inicio;
    intro.classList.add('salto');
    setTimeout(() => intro.classList.add('fuera'), rapido ? 150 : 450);
    setTimeout(() => {
      if (intro.parentNode) intro.parentNode.removeChild(intro);
      document.documentElement.style.overflow = '';
      removeEventListener('resize', preparar);
      removeEventListener('keydown', alTeclear, true);
    }, rapido ? 850 : 1150);
  }
  function alTeclear(e) { e.preventDefault(); e.stopPropagation(); terminar(true); }

  setTimeout(() => terminar(false), DURACION - 700);
  // pointerdown responde al instante al tocar la pantalla (el «click» del móvil llega tarde)
  intro.addEventListener(window.PointerEvent ? 'pointerdown' : 'click', () => terminar(true));
  addEventListener('keydown', alTeclear, true);
  // El botón Atrás de la app de Android también la salta (en vez de cerrar la app)
  window.morvehSaltarIntro = () => { if (!intro.parentNode || saliendo) return false; terminar(true); return true; };
})();
