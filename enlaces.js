// Subir a e2 desde un enlace: el servidor descarga el archivo (un enlace directo a un vídeo o un
// subtítulo: Google Drive, Dropbox, OneDrive, un servidor propio…) y lo va subiendo a e2 por
// trozos según llega, sin guardarlo entero ni en memoria ni en disco. No saca vídeos de páginas
// web ni de listas .m3u8: el enlace tiene que llevar al archivo.
//
// Seguridad: solo direcciones públicas de internet (nunca la red interna del servidor: localhost,
// 10.x, 192.168.x, la de Docker, la de metadatos de la nube…), comprobado también en cada
// redirección.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';

const error = (status, message) => Object.assign(new Error(message), { status });

function ipPrivada(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapeada = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapeada) return ipPrivada(mapeada[1]);
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

async function comprobarUrl(texto) {
  let u;
  try { u = new URL(texto); } catch { throw error(400, 'Ese enlace no es válido'); }
  if (!/^https?:$/.test(u.protocol)) throw error(400, 'El enlace tiene que empezar por http:// o https://');
  if (u.username || u.password) throw error(400, 'El enlace no puede llevar usuario y contraseña');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length) throw error(400, 'No se encuentra esa web');
  if (ips.some(ipPrivada)) throw error(400, 'Ese enlace apunta a una dirección interna: no se permite');
  return u;
}

// Abre el enlace (siguiendo hasta 6 redirecciones, cada una comprobada) y devuelve la respuesta
export async function abrir(texto) {
  let url = texto;
  for (let i = 0; i < 7; i++) {
    const u = await comprobarUrl(url);
    const control = new AbortController();
    const espera = setTimeout(() => control.abort(), 30000); // solo hasta que empiece a llegar
    const r = await fetch(u, { redirect: 'manual', signal: control.signal, headers: { 'user-agent': 'Mozilla/5.0 (MorvehTV)', accept: '*/*' } })
      .catch(() => { throw error(502, 'No se pudo conectar con ese enlace'); })
      .finally(() => clearTimeout(espera));
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      r.body?.cancel().catch(() => {});
      url = new URL(r.headers.get('location'), u).href;
      continue;
    }
    if (!r.ok) { r.body?.cancel().catch(() => {}); throw error(502, `El enlace respondió con un error (${r.status})`); }
    return { r, url: u.href, control };
  }
  throw error(502, 'El enlace redirige demasiadas veces');
}

// El nombre del archivo: el que diga el servidor (Content-Disposition) o el del final del enlace
export function nombreDe(r, url) {
  const cd = r.headers.get('content-disposition') ?? '';
  const utf = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const simple = cd.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  let n = '';
  try { n = utf ? decodeURIComponent(utf) : simple || decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { n = simple || ''; }
  return n.replace(/[\\/]/g, ' ').replace(/[\u0000-\u001f]/g, '').trim();
}

// ¿Es un archivo (y no una página web)?
export function esArchivo(r) {
  const tipo = String(r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return !/^text\/html|^application\/(xhtml|json)|mpegurl/.test(tipo);
}

// Va subiendo a e2 lo que llega, en trozos de 16 MB, 8 a la vez (e2 limita cada conexión: con
// varias va mucho más rápido). `estado` se actualiza (bajado, total) y con `estado.cancelar` se para.
export async function subirDesde(r, { s3, bucket, key, contentType, estado, control }) {
  const PARTE = 16 * 1024 * 1024;
  const A_LA_VEZ = 8;
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
  const partes = [];
  const enVuelo = new Set();
  let numero = 0;
  let fallo = null;
  const mandar = (trozo) => {
    const n = ++numero;
    if (n > 10000) throw error(413, 'El archivo es demasiado grande (más de 160 GB)');
    const p = (async () => {
      for (let intento = 1; ; intento++) {
        try {
          const res = await s3.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: n, Body: trozo }));
          partes.push({ PartNumber: n, ETag: res.ETag });
          return;
        } catch (e) { if (intento >= 3) throw e; await new Promise((ok) => setTimeout(ok, 2000 * intento)); }
      }
    })().catch((e) => { fallo = fallo || e; }).finally(() => enVuelo.delete(p));
    enVuelo.add(p);
  };
  try {
    let trozos = []; let llenos = 0;
    for await (const t of r.body) {
      if (estado.cancelar) throw error(499, 'Cancelada');
      if (fallo) throw fallo;
      const b = Buffer.from(t);
      estado.bajado += b.length;
      trozos.push(b); llenos += b.length;
      if (llenos >= PARTE) {
        const todo = Buffer.concat(trozos);
        trozos = [todo.subarray(PARTE)]; llenos = todo.length - PARTE;
        mandar(todo.subarray(0, PARTE));
        // Sin pasarse de 8 trozos en el aire: si no, se espera (y la descarga también)
        while (enVuelo.size >= A_LA_VEZ) await Promise.race(enVuelo);
      }
    }
    if (llenos > 0 || numero === 0) mandar(Buffer.concat(trozos));
    await Promise.all(enVuelo);
    if (fallo) throw fallo;
    if (estado.cancelar) throw error(499, 'Cancelada');
    partes.sort((a, b) => a.PartNumber - b.PartNumber);
    await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId, MultipartUpload: { Parts: partes } }));
  } catch (e) {
    control?.abort();
    await Promise.allSettled(enVuelo);
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId })).catch(() => {});
    throw e;
  }
}
