// Detección de la intro de las series, como hacen las plataformas: la sintonía suena igual en
// todos los capítulos de una temporada (aunque empiece en un momento distinto), así que se saca la
// huella de audio (chromaprint, con ffmpeg) del principio de cada capítulo y se busca el tramo
// que se repite entre capítulos vecinos. Ese tramo es la intro: el reproductor ofrece saltarla.
import { execFile } from 'node:child_process';

// Cada punto de la huella de chromaprint dura unos 0,1238 s
export const PUNTO = 0.1238;

// ¿Este ffmpeg sabe sacar huellas? (el de Jellyfin sí)
export function hayChromaprint(ffmpeg = 'ffmpeg') {
  return new Promise((ok) => execFile(ffmpeg, ['-hide_banner', '-muxers'], { maxBuffer: 1e7 }, (e, salida) => ok(!e && /\bchromaprint\b/.test(String(salida)))));
}

// La huella de los primeros `segundos` de un vídeo (URL o archivo): un Uint32Array
export function huella(origen, segundos, ffmpeg = 'ffmpeg') {
  return new Promise((ok, mal) => execFile(ffmpeg,
    ['-v', 'error', '-t', String(Math.round(segundos)), '-i', origen, '-map', '0:a:0', '-ac', '2', '-f', 'chromaprint', '-fp_format', 'raw', '-'],
    { encoding: 'buffer', maxBuffer: 1e8, timeout: 240000 },
    (e, salida) => {
      if (e) return mal(new Error(String(e.message).split('\n')[0]));
      const util = salida.length - (salida.length % 4);
      const copia = Buffer.from(salida.subarray(0, util));
      ok(new Uint32Array(copia.buffer, copia.byteOffset, util / 4));
    }));
}

const bits = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

// El tramo común más largo de dos huellas: { a: { inicio, fin }, b: { inicio, fin } } en
// segundos, o null si no hay ninguno de una duración razonable para una intro
export function comparar(a, b, { maxDif = 6, minSeg = 12, maxSeg = 200, hueco = 3.5 } = {}) {
  if (!a?.length || !b?.length) return null;
  // Desplazamientos candidatos: donde un valor de A aparece igual en B
  const indice = new Map();
  b.forEach((x, j) => { const l = indice.get(x); if (l) { if (l.length < 8) l.push(j); } else indice.set(x, [j]); });
  const votos = new Map();
  a.forEach((x, i) => { for (const j of indice.get(x) ?? []) votos.set(j - i, (votos.get(j - i) ?? 0) + 1); });
  // Los desplazamientos más votados (y sus vecinos, por si la huella va medio punto desfasada)
  const candidatos = new Set();
  [...votos].sort((x, y) => y[1] - x[1]).slice(0, 40).forEach(([d]) => { candidatos.add(d - 1); candidatos.add(d); candidatos.add(d + 1); });
  const saltoMax = Math.round(hueco / PUNTO);
  let mejor = null;
  for (const d of candidatos) {
    // Tramos de puntos parecidos (pocas diferencias de bits), admitiendo huecos cortos
    let inicio = -1; let ultimo = -1;
    const cerrar = () => {
      if (inicio < 0 || (mejor && ultimo - inicio <= mejor.fin - mejor.inicio)) return;
      // Una sintonía tiene una huella muy variada; un silencio o un tono fijo, muy repetitiva (y
      // «coincide» con cualquier otro silencio): esos tramos no son la intro
      const distintos = new Set();
      for (let i = inicio; i <= ultimo; i++) distintos.add(a[i] >>> 4);
      if (distintos.size / (ultimo - inicio + 1) < 0.5) return;
      mejor = { inicio, fin: ultimo, d };
    };
    const desde = Math.max(0, -d); const hasta = Math.min(a.length, b.length - d);
    for (let i = desde; i < hasta; i++) {
      if (bits(a[i] ^ b[i + d]) > maxDif) continue;
      if (inicio < 0 || i - ultimo > saltoMax) { cerrar(); inicio = i; }
      ultimo = i;
    }
    cerrar();
  }
  if (!mejor) return null;
  const dura = (mejor.fin - mejor.inicio) * PUNTO;
  if (dura < minSeg || dura > maxSeg) return null;
  const s = (n) => Math.round(n * PUNTO * 10) / 10;
  return { a: { inicio: s(mejor.inicio), fin: s(mejor.fin) }, b: { inicio: s(mejor.inicio + mejor.d), fin: s(mejor.fin + mejor.d) }, segundos: Math.round(dura) };
}

// La intro de cada capítulo de una temporada (huellas en orden de capítulos): se compara cada uno
// con los vecinos (anterior, siguiente y el de dos más allá, por si un capítulo no la tiene) y se
// queda el tramo más largo. Devuelve un array con { inicio, fin } o null por capítulo.
export function introsDeTemporada(huellas) {
  const res = huellas.map(() => null);
  const anotar = (i, t) => { if (t && (!res[i] || t.fin - t.inicio > res[i].fin - res[i].inicio)) res[i] = t; };
  for (let i = 0; i < huellas.length; i++) {
    for (const j of [i + 1, i + 2]) {
      if (j >= huellas.length) continue;
      const r = comparar(huellas[i], huellas[j]);
      if (r) { anotar(i, r.a); anotar(j, r.b); }
    }
  }
  return res;
}
