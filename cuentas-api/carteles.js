// Carteles en Emby: que TODAS las películas y series tengan su cartel.
//  1) Cada biblioteca debe tener activados los proveedores de metadatos e imágenes de internet
//     (las creadas por la API pueden quedarse sin ellos): si no, se activan y se refresca la biblioteca.
//  2) Lo que lleva un rato en Emby sin cartel: se le pide a Emby que refresque su ficha y, si TMDB
//     tiene el cartel (por los códigos de Emby, el «[imdbid=…]» de la carpeta o título y año), se le
//     pone directamente. Si no se encuentra, se vuelve a probar al día siguiente.
// Repasa cada CARTELES_CADA_MS (20 min). Orden manual: docker exec morvehtv-cuentas node admin.mjs carteles
import * as emby from './emby.js';
import * as tm from './tmdb.js';

const AJUSTE = 'carteles';
const CADA = Number(process.env.CARTELES_CADA_MS ?? 20 * 60e3);
const PRIMERO = Number(process.env.CARTELES_PRIMERO_MS ?? 2 * 60e3);
const ESPERA = Number(process.env.CARTELES_ESPERA_MS ?? 10 * 60e3); // margen para que Emby lo encuentre solo
const REINTENTO = 24 * 3600e3;
const MAX_REFRESCOS = 40; // por repaso, para no llenar la cola de Emby

let p = null;
let ocupado = false;
export let estado = 'sin empezar';

export function iniciar({ perfiles }) {
  p = perfiles;
  if (!emby.configurado()) { estado = 'Emby sin configurar'; return; }
  // CARTELES=no en cuentas.env → no se repasa solo (la orden «admin.mjs carteles» sigue funcionando)
  if (/^(no|0|off|false)$/i.test(String(process.env.CARTELES ?? '').trim())) { estado = 'desactivado'; return; }
  setTimeout(() => repaso().catch(() => {}), PRIMERO).unref?.();
  setInterval(() => repaso().catch(() => {}), CADA).unref?.();
}

// Proveedores de internet de cada biblioteca: los que Emby trae activados por defecto
const TIPOS = { movies: ['Movie'], tvshows: ['Series'] };
async function activarProveedores() {
  const libs = (await emby.consultar('/Library/VirtualFolders')) ?? [];
  const arregladas = [];
  for (const b of libs) {
    const o = b.LibraryOptions; const tipos = TIPOS[b.CollectionType];
    if (!o || !b.ItemId || !tipos) continue;
    const tiene = (tipo) => (o.TypeOptions ?? []).some((t) => t.Type === tipo && t.MetadataFetchers?.length && t.ImageFetchers?.length);
    if (o.EnableInternetProviders !== false && tipos.every(tiene)) continue;
    const av = await emby.consultar(`/Libraries/AvailableOptions?LibraryContentType=${encodeURIComponent(b.CollectionType)}&IsNewLibrary=true`);
    if (!av?.TypeOptions?.length) continue;
    o.TypeOptions = av.TypeOptions.map((t) => ({
      Type: t.Type,
      MetadataFetchers: (t.MetadataFetchers ?? []).filter((f) => f.DefaultEnabled).map((f) => f.Name),
      MetadataFetcherOrder: (t.MetadataFetchers ?? []).map((f) => f.Name),
      ImageFetchers: (t.ImageFetchers ?? []).filter((f) => f.DefaultEnabled).map((f) => f.Name),
      ImageFetcherOrder: (t.ImageFetchers ?? []).map((f) => f.Name),
      ImageOptions: t.DefaultImageOptions ?? [],
    }));
    o.EnableInternetProviders = true;
    o.PreferredMetadataLanguage ||= 'es';
    o.MetadataCountryCode ||= 'ES';
    await emby.enviarA('/Library/VirtualFolders/LibraryOptions', { Id: b.ItemId, LibraryOptions: o });
    await emby.enviarA(`/Items/${encodeURIComponent(b.ItemId)}/Refresh?Recursive=true&MetadataRefreshMode=FullRefresh&ImageRefreshMode=FullRefresh&ReplaceAllMetadata=false&ReplaceAllImages=false`);
    arregladas.push(b.Name);
  }
  if (arregladas.length) console.log(`Carteles: activados los proveedores de internet de ${arregladas.map((n) => `«${n}»`).join(', ')} (Emby las está refrescando)`);
  return arregladas;
}

function codigos(x) {
  const ids = Object.fromEntries(Object.entries(x.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const ruta = String(x.Path ?? '');
  return {
    imdb: ids.imdb ?? /imdbid[=-](tt\d{6,10})/i.exec(ruta)?.[1] ?? null,
    tmdb: ids.tmdb ?? /tmdbid[=-](\d+)/i.exec(ruta)?.[1] ?? null,
  };
}

// Pone el cartel de TMDB en un elemento de Emby. true si lo ha puesto
export async function ponerDeTmdb(x) {
  const f = await tm.cartel({ tipo: x.Type === 'Series' ? 'tv' : 'movie', ...codigos(x), nombre: x.Name, ano: x.ProductionYear ?? null });
  if (!f) return false;
  await emby.ponerCartel(x.Id, f.datos, f.tipo);
  return true;
}

// ya = true (orden manual): sin esperar el margen ni el día de reintento
export async function repaso({ ya = false } = {}) {
  if (!emby.configurado()) return { error: 'Emby sin configurar' };
  if (ocupado) return { ocupado: true };
  ocupado = true;
  const ahora = Date.now();
  const r = { bibliotecas: [], sinCartel: 0, puestos: 0, refrescados: 0, noEncontrados: 0, esperando: 0, tmdb: tm.configurado() };
  try {
    r.bibliotecas = await activarProveedores();
    const d = (await p.leerAjuste(AJUSTE)) ?? {};
    const vistos = d.vistos ?? {};
    const lista = (await emby.consultar('/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,Path,ProductionYear&EnableUserData=false'))?.Items ?? [];
    const faltan = lista.filter((x) => !x.ImageTags?.Primary);
    r.sinCartel = faltan.length;
    const siguen = {};
    for (const x of faltan) {
      const st = vistos[x.Id] ?? { visto: ahora };
      siguen[x.Id] = st;
      if (!ya && ahora - st.visto < ESPERA) { r.esperando++; continue; }
      if (!ya && st.fallo && ahora - st.fallo < REINTENTO) { r.noEncontrados++; continue; }
      if (st.fallo) delete st.refrescado; // otro intento: también se le vuelve a pedir a Emby
      // Que Emby busque la ficha completa (sinopsis, reparto…) y, de paso, el cartel
      if (!st.refrescado && r.refrescados < MAX_REFRESCOS) {
        try { await emby.enviarA(`/Items/${encodeURIComponent(x.Id)}/Refresh?Recursive=false&MetadataRefreshMode=FullRefresh&ImageRefreshMode=FullRefresh&ReplaceAllMetadata=false&ReplaceAllImages=false`); st.refrescado = ahora; r.refrescados++; } catch {}
      }
      // Y el cartel de TMDB directamente, sin esperar a Emby
      let puesto = false;
      try { puesto = await ponerDeTmdb(x); } catch (e) { console.error(`Carteles: «${x.Name}»: ${e.message}`); }
      if (puesto) { r.puestos++; delete siguen[x.Id]; console.log(`Carteles: puesto el cartel de TMDB a «${x.Name}»`); }
      else { st.fallo = ahora; r.noEncontrados++; r.faltan ??= []; r.faltan.push(`${x.Name}${x.ProductionYear ? ` (${x.ProductionYear})` : ''}`); }
    }
    if (r.faltan?.length) console.log(`Carteles: no están en TMDB (revisa su nombre o ponles el código [imdbid=tt…] en la carpeta): ${r.faltan.slice(0, 30).join(' · ')}${r.faltan.length > 30 ? ` y ${r.faltan.length - 30} más` : ''}`);
    await p.guardarAjuste(AJUSTE, { vistos: siguen, ultimo: ahora, resumen: { ...r, faltan: undefined } });
    estado = `ok: ${lista.length - faltan.length + r.puestos} de ${lista.length} con cartel`;
    if (r.puestos || r.refrescados || r.bibliotecas.length || ya) {
      console.log(`Carteles: ${lista.length} películas y series · sin cartel ${faltan.length} · puestos de TMDB ${r.puestos} · pedidos a Emby ${r.refrescados} · no encontrados ${r.noEncontrados}${r.esperando ? ` · recién llegados ${r.esperando}` : ''}${r.tmdb ? '' : ' (sin clave de TMDB: solo se le pide a Emby)'}`);
    }
    return { ...r, total: lista.length };
  } catch (e) {
    estado = `error: ${e.message}`;
    console.error(`Carteles: ${e.message}`);
    return { ...r, error: e.message };
  } finally {
    ocupado = false;
  }
}
