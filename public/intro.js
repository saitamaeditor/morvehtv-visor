// Intro de MorvehTV: se ve al abrir la app (una vez por pestaña; al recargar no se repite).
// Clic, toque, tecla, «Saltar» o el botón Atrás de la app la terminan al momento.
//
// Corta y con golpe, como la cabecera de una plataforma de streaming (unos 3 s):
//   1. una línea de luz se abre en negro
//   2. la nube con el ▶ entra de golpe y debajo sube «MORVEHTV» letra a letra
//   3. latido: tres haces de luz con los colores del logo cruzan por detrás
//   4. la cámara se mete dentro de la nube, la pantalla se llena de su color y aparece la app
// Todo se anima con transform y opacity (lo que móviles y teles mueven sin esfuerzo), sin
// lienzos ni desenfoques.
//
// Las clases de estado llevan el prefijo «intro-»: la app ya usa «salto» (el aviso de ±10 s del
// reproductor) y antes se mezclaban, así que al final la intro se movía y se apagaba de golpe.
//
// No empieza hasta que la página ha terminado de arrancar (se queda en negro, en pausa): así el
// primer segundo no compite con la carga y en la app de Android no se pierde el principio.
// Mientras suena, la app no dibuja la portada (window.morvehIntroFin).
(() => {
  let vista = false;
  try { vista = sessionStorage.getItem('intro') === '1'; sessionStorage.setItem('intro', '1'); } catch (e) {}
  if (vista || /[?&]sinintro\b/.test(location.search)) return;

  const reducir = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esTele = /SMART-?TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey|HbbTV|VIDAA|Roku|PhilipsTV|Hisense/i.test(navigator.userAgent);
  // Momento en que la cámara entra en la nube (el resto de la intro va antes)
  const DURACION = reducir ? 1200 : 2250;

  const intro = document.createElement('div');
  intro.id = 'intro';
  intro.className = `${esTele ? 'intro-en-tele ' : ''}intro-esperando`;
  intro.innerHTML = `
    <div class="intro-cintas"><i></i><i></i><i></i></div>
    <div class="intro-linea"></div>
    <div class="intro-grupo">
      <div class="intro-camara">
      <div class="intro-halo"></div>
      <svg class="intro-logo" viewBox="0 0 128 92" aria-hidden="true">
        <defs>
          <linearGradient id="intro-relleno" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#4f8cff"/><stop offset=".55" stop-color="#8e4ec6"/><stop offset="1" stop-color="#d6409f"/>
          </linearGradient>
        </defs>
        <path class="nube" d="M34 80 H98 A22 22 0 0 0 100 36 A30 30 0 0 0 44 26 A24 24 0 0 0 34 80 Z"/>
        <path class="play" d="M56 38 L76 51 L56 64 Z"/>
      </svg>
      </div>
      <h1 class="intro-titulo" aria-label="MorvehTV"></h1>
    </div>
    <button class="intro-saltar" type="button">${esTele ? 'Pulsa OK para saltar' : 'Saltar ›'}</button>`;
  document.body.insertBefore(intro, document.body.firstChild);
  document.documentElement.style.overflow = 'hidden';

  // Letras que suben una a una desde debajo de una línea invisible
  const titulo = intro.querySelector('.intro-titulo');
  ['M', 'O', 'R', 'V', 'E', 'H', 'T', 'V'].forEach((t, i) => {
    const caja = document.createElement('span');
    caja.className = i >= 6 ? 'letra tv' : 'letra';
    const s = document.createElement('span');
    s.textContent = t;
    s.style.animationDelay = `${0.78 + i * 0.045}s`;
    caja.appendChild(s);
    titulo.appendChild(caja);
  });

  let empezada = false;
  let saliendo = false;
  let avisarFin;
  window.morvehIntroFin = new Promise((ok) => (avisarFin = ok));

  // ---------- Arranque: cuando la página ya está lista ----------
  function empezar() {
    if (empezada || !intro.parentNode) return;
    empezada = true;
    intro.classList.remove('intro-esperando');
    // La app de Android quita entonces su pantalla de «Conectando…»
    try { if (window.MorvehApp && window.MorvehApp.introEmpieza) window.MorvehApp.introEmpieza(); } catch (e) {}
    setTimeout(() => terminar(false), DURACION);
  }
  const trasDosFotogramas = () => requestAnimationFrame(() => requestAnimationFrame(empezar));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', trasDosFotogramas);
  else trasDosFotogramas();
  setTimeout(empezar, 2500); // por si algo tarda demasiado

  // ---------- Final: la cámara entra en la nube y se funde con la app ----------
  function terminar(rapido) {
    if (saliendo) return;
    saliendo = true;
    empezada = true;
    intro.classList.remove('intro-esperando');
    avisarFin(); // la portada se dibuja debajo mientras tanto
    intro.classList.add(rapido ? 'intro-rapido' : 'intro-salto');
    setTimeout(() => intro.classList.add('intro-fuera'), rapido ? 80 : 520);
    setTimeout(() => {
      if (intro.parentNode) intro.parentNode.removeChild(intro);
      document.documentElement.style.overflow = '';
      removeEventListener('keydown', alTeclear, true);
    }, rapido ? 520 : 1000);
  }
  function alTeclear(e) { e.preventDefault(); e.stopPropagation(); terminar(true); }

  // pointerdown responde al instante al tocar la pantalla (el «click» del móvil llega tarde)
  intro.addEventListener(window.PointerEvent ? 'pointerdown' : 'click', () => terminar(true));
  addEventListener('keydown', alTeclear, true);
  // El botón Atrás de la app de Android también la salta (en vez de cerrar la app)
  window.morvehSaltarIntro = () => { if (!intro.parentNode || saliendo) return false; terminar(true); return true; };
})();
