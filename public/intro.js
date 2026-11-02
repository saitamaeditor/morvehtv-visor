// Intro de MorvehTV: se ve al abrir la app (una vez por pestaña; al recargar no se repite).
// Clic, tecla o «Saltar» la terminan al momento.
(() => {
  let vista = false;
  try { vista = sessionStorage.getItem('intro') === '1'; sessionStorage.setItem('intro', '1'); } catch {}
  if (vista || new URLSearchParams(location.search).has('sinintro')) return;

  const reducir = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DURACION = reducir ? 1500 : 3900;

  const intro = document.createElement('div');
  intro.id = 'intro';
  intro.innerHTML = `
    <canvas></canvas>
    <div class="intro-centro">
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
      </svg>
      <h1 class="intro-titulo" aria-label="MorvehTV"></h1>
      <div class="intro-sub">TU CONTENIDO · EN TU NUBE</div>
    </div>
    <button class="intro-saltar" type="button">Saltar ›</button>`;
  document.body.prepend(intro);
  document.documentElement.style.overflow = 'hidden';

  // Letras con entrada escalonada; el destello las cruza de izquierda a derecha
  const titulo = intro.querySelector('.intro-titulo');
  [...'MORVEH', 'TV'].forEach((t, i) => {
    const s = document.createElement('span');
    s.textContent = t;
    if (t === 'TV') s.className = 'tv';
    s.style.animation = `intro-letra .7s cubic-bezier(.2,.9,.3,1.2) ${1.45 + i * 0.08}s forwards, intro-barrido .5s ease-in-out ${2.25 + i * 0.07}s forwards`;
    titulo.append(s);
  });

  // ---------- Campo de estrellas en 3D: lento al principio, salto a la velocidad de la luz al final ----------
  const lienzo = intro.querySelector('canvas');
  const ctx = lienzo.getContext('2d');
  const COLORES = ['#ffffff', '#ffffff', '#cfe0ff', '#8fb4ff', '#d6a8ff', '#ff9fd2'];
  let ancho, alto, dpr;
  const estrellas = Array.from({ length: reducir ? 0 : 520 }, () => nueva(true));

  function nueva(alAzar) {
    return { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: alAzar ? Math.random() : 1, pz: null, c: COLORES[(Math.random() * COLORES.length) | 0] };
  }
  function medir() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    ancho = lienzo.width = innerWidth * dpr;
    alto = lienzo.height = innerHeight * dpr;
  }
  medir();
  addEventListener('resize', medir);

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

  function cuadro(ahora) {
    if (!intro.isConnected) return;
    const t = ahora - inicio;
    const v = velocidad(t);
    ctx.fillStyle = `rgba(0,0,0,${v > 0.03 ? 0.35 : 0.9})`; // rastro cuando va rápido
    ctx.fillRect(0, 0, ancho, alto);
    const cx = ancho / 2, cy = alto / 2, f = Math.max(ancho, alto) * 0.5;
    for (const e of estrellas) {
      e.pz = e.z;
      e.z -= v;
      if (e.z <= 0.01) { Object.assign(e, nueva(false)); continue; }
      const x = cx + (e.x / e.z) * f, y = cy + (e.y / e.z) * f;
      const px = cx + (e.x / e.pz) * f, py = cy + (e.y / e.pz) * f;
      if (x < 0 || x > ancho || y < 0 || y > alto) { Object.assign(e, nueva(false)); continue; }
      const brillo = Math.min(1, (1 - e.z) * 1.4);
      ctx.strokeStyle = e.c;
      ctx.globalAlpha = brillo;
      ctx.lineWidth = Math.max(0.6, (1 - e.z) * 3) * dpr;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Resplandor central que late con el destello del logo
    const pulso = Math.max(0, 1 - Math.abs(t - 1300) / 500);
    if (pulso > 0) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, f * 0.9);
      g.addColorStop(0, `rgba(120,160,255,${0.35 * pulso})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, ancho, alto);
    }
    requestAnimationFrame(cuadro);
  }
  requestAnimationFrame(cuadro);

  // ---------- Final ----------
  function terminar(rapido) {
    if (saliendo) return;
    saliendo = performance.now() - inicio;
    intro.classList.add('salto');
    setTimeout(() => intro.classList.add('fuera'), rapido ? 150 : 450);
    setTimeout(() => {
      intro.remove();
      document.documentElement.style.overflow = '';
      removeEventListener('resize', medir);
      removeEventListener('keydown', alTeclear, true);
    }, rapido ? 850 : 1150);
  }
  function alTeclear(e) { e.preventDefault(); e.stopPropagation(); terminar(true); }

  setTimeout(() => terminar(false), DURACION - 700);
  intro.addEventListener('click', () => terminar(true));
  addEventListener('keydown', alTeclear, true);
})();
