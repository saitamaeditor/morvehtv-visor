// Mide a qué velocidad sube el servidor a e2, con 1, 12 y 32 conexiones a la vez, y la subida
// del servidor a internet (test de Cloudflare) para comparar. Se lanza a mano en la VPS:
//   docker exec morvehtv-visor node deploy/medir-e2.mjs
// Sube trozos de relleno a una subida por partes en «_morvehtv/prueba-velocidad» que nunca se
// completa: al terminar cada prueba se cancela y e2 los descarta (no queda ningún archivo).
import https from 'node:https';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const { E2_ENDPOINT, E2_REGION = 'us-east-1', E2_BUCKET, E2_ACCESS_KEY_ID, E2_SECRET_ACCESS_KEY } = process.env;
if (!(E2_ENDPOINT && E2_BUCKET && E2_ACCESS_KEY_ID && E2_SECRET_ACCESS_KEY)) { console.error('Faltan las variables de e2'); process.exit(1); }
const s3 = new S3Client({
  endpoint: /^https?:\/\//.test(E2_ENDPOINT) ? E2_ENDPOINT : `https://${E2_ENDPOINT}`,
  region: E2_REGION, forcePathStyle: true,
  credentials: { accessKeyId: E2_ACCESS_KEY_ID, secretAccessKey: E2_SECRET_ACCESS_KEY },
  requestHandler: new NodeHttpHandler({ httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 64 }) }),
});
const MB = 1024 * 1024;
const TROZO = 8 * MB;
const relleno = Buffer.alloc(TROZO, 7);
const KEY = '_morvehtv/prueba-velocidad';

async function prueba(conexiones, trozos) {
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: E2_BUCKET, Key: KEY }));
  try {
    const pendientes = Array.from({ length: trozos }, (_, i) => i + 1);
    const t0 = Date.now();
    await Promise.all(Array.from({ length: conexiones }, async () => {
      while (pendientes.length) {
        const n = pendientes.shift();
        await s3.send(new UploadPartCommand({ Bucket: E2_BUCKET, Key: KEY, UploadId, PartNumber: n, Body: relleno, ContentLength: TROZO }));
      }
    }));
    const s = (Date.now() - t0) / 1000;
    console.log(`e2 con ${String(conexiones).padStart(2)} conexiones: ${(trozos * TROZO / MB / s).toFixed(1)} MB/s (${trozos * 8} MB en ${s.toFixed(1)} s)`);
  } finally {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: E2_BUCKET, Key: KEY, UploadId })).catch(() => {});
  }
}

async function cloudflare(conexiones) {
  const t0 = Date.now();
  await Promise.all(Array.from({ length: conexiones }, () => fetch('https://speed.cloudflare.com/__up', { method: 'POST', body: Buffer.alloc(20 * MB) }).then((r) => r.arrayBuffer())));
  const s = (Date.now() - t0) / 1000;
  console.log(`Internet (Cloudflare) con ${conexiones} conexiones: ${(conexiones * 20 / s).toFixed(1)} MB/s`);
}

console.log('Midiendo… (tarda uno o dos minutos)');
await cloudflare(1).catch((e) => console.log(`Cloudflare: ${e.message}`));
await cloudflare(8).catch((e) => console.log(`Cloudflare: ${e.message}`));
await prueba(1, 4);
await prueba(12, 24);
await prueba(32, 64);
console.log('Hecho: las subidas de prueba están canceladas (no queda nada en e2).');
