// Lectura rápida de vídeos de e2.
// e2 limita cada conexión a ~0,5 MB/s (4-5 Mbit/s, medido el 2026-11-08): un vídeo 1080p pide
// más que eso en las escenas movidas y se paraba a trozos. Aquí se pide cada vídeo en trozos con
// varias conexiones a la vez (VISOR_E2_CONEXIONES, 8 por defecto: ~30 Mbit/s) y se entrega en
// orden, como si fuera un archivo normal: admite «Range» para saltar de minuto.
// Los primeros trozos son pequeños para que empiece enseguida; luego van creciendo.

const A_LA_VEZ = Math.min(16, Math.max(2, Number(process.env.VISOR_E2_CONEXIONES) || 8));
const TROZOS = [256 * 1024, 512 * 1024, 1024 * 1024]; // los primeros; después, 2 MB
const TROZO = 2 * 1024 * 1024;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// `url`: la dirección firmada de e2; `tam`: lo que pesa el archivo; `tipo`: su content-type
export async function servirRango(req, res, url, tam, tipo) {
  let ini = 0;
  let fin = tam - 1;
  let parcial = false;
  const m = String(req.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] !== '' || m[2] !== '')) {
    parcial = true;
    if (m[1] === '') ini = Math.max(0, tam - Number(m[2]));
    else { ini = Number(m[1]); if (m[2] !== '') fin = Math.min(Number(m[2]), tam - 1); }
  }
  if (!(tam > 0) || ini > fin || ini >= tam) {
    res.writeHead(416, { 'content-range': `bytes */${tam}` });
    return res.end();
  }
  res.writeHead(parcial ? 206 : 200, {
    'content-type': tipo,
    'content-length': fin - ini + 1,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    ...(parcial && { 'content-range': `bytes ${ini}-${fin}/${tam}` }),
  });
  if (req.method === 'HEAD') return res.end();

  // Si quien lo pide se va (cierra el vídeo, salta a otro minuto), se cancela todo lo pendiente
  const control = new AbortController();
  let cerrado = false;
  const alCerrar = new Promise((ok) => res.once('close', () => { cerrado = true; control.abort(); ok(); }));

  const pedir = async (a, b, intento = 0) => {
    try {
      const r = await fetch(url, { headers: { range: `bytes=${a}-${b}` }, signal: control.signal });
      if (r.status !== 206 && r.status !== 200) { r.body?.cancel().catch(() => {}); throw new Error(`e2 respondió ${r.status}`); }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length !== b - a + 1) throw new Error('trozo incompleto');
      return buf;
    } catch (e) {
      // Un corte de e2 en un trozo se reintenta (hasta 4 veces) sin que se note
      if (cerrado || intento >= 4) throw e;
      await espera(400 * (intento + 1));
      return pedir(a, b, intento + 1);
    }
  };

  const cola = [];
  let siguiente = ini;
  let n = 0;
  const llenar = () => {
    while (cola.length < A_LA_VEZ && siguiente <= fin) {
      const a = siguiente;
      const b = Math.min(fin, a + (TROZOS[n++] ?? TROZO) - 1);
      siguiente = b + 1;
      const p = pedir(a, b);
      p.catch(() => {});
      cola.push(p);
    }
  };
  try {
    llenar();
    while (cola.length && !cerrado) {
      const buf = await Promise.race([cola[0], alCerrar]);
      if (cerrado) break;
      cola.shift();
      llenar();
      // Si el reproductor va lleno (pausa), se espera: como mucho quedan A_LA_VEZ trozos en memoria
      if (!res.write(buf)) await Promise.race([new Promise((ok) => res.once('drain', ok)), alCerrar]);
    }
    if (!cerrado) res.end();
  } catch (e) {
    if (!cerrado) { console.error(`e2rapido: ${e.message}`); res.destroy(); }
  }
}
