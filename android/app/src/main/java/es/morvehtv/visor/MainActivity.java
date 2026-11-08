package es.morvehtv.visor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.net.Uri;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.android.gms.ads.MobileAds;

/**
 * MorvehTV: el visor publicado en Render a pantalla completa, para móvil y Android TV.
 * La web hace casi todo (portada, fichas, reproductor HLS, mando); aquí solo se añade lo que
 * una web no puede: pantalla completa del vídeo, botón Atrás del sistema, pantalla encendida
 * mientras se ve algo y un aviso mientras el servidor de Render despierta.
 */
public class MainActivity extends Activity {

    private WebView web;
    private View carga;
    private TextView mensaje;
    private Button reintentar;
    private FrameLayout raiz;
    private View vistaCompleta;
    private boolean sinBarras = false; // viendo un vídeo a pantalla completa dentro de la web
    private volatile long toqueNuestro = -10000; // último toque en la página de MorvehTV (no en un iframe)
    private WebChromeClient.CustomViewCallback alSalirCompleta;
    private boolean cargada = false;
    private final Cromo cromo = new Cromo();
    private Actualizador actualizador;
    private boolean actualizacionMirada = false;
    private final Handler hilo = new Handler(Looper.getMainLooper());
    // Render dormido tarda hasta un minuto en despertar: pasado esto se da la carga por fallida
    private static final long TIEMPO_MAXIMO = 90_000;
    private final Runnable agotado = () -> { if (!cargada) error("MorvehTV no responde (tiempo agotado)."); };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        setContentView(R.layout.principal);
        raiz = findViewById(R.id.raiz);
        web = findViewById(R.id.web);
        carga = findViewById(R.id.carga);
        mensaje = findViewById(R.id.mensaje);
        reintentar = findViewById(R.id.reintentar);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);

        WebSettings ajustes = web.getSettings();
        ajustes.setJavaScriptEnabled(true);
        ajustes.setDomStorageEnabled(true);
        ajustes.setMediaPlaybackRequiresUserGesture(false);
        // Ninguna página (ni los reproductores de otros sitios metidos en la app) abre ventanas
        // por su cuenta: window.open y target="_blank" pasan por onCreateWindow, que las rechaza
        ajustes.setJavaScriptCanOpenWindowsAutomatically(false);
        ajustes.setSupportMultipleWindows(true);
        ajustes.setLoadWithOverviewMode(true);
        ajustes.setUseWideViewPort(true);
        // Respeta la letra grande del sistema, pero sin pasar de +15 %: más allá los textos de la
        // app ya no caben en la pantalla del móvil
        float escala = getResources().getConfiguration().fontScale;
        ajustes.setTextZoom(Math.round(Math.max(0.85f, Math.min(escala, 1.15f)) * 100));
        // La web reconoce la tele por «Android TV» en el nombre del navegador: letra grande y mando
        ajustes.setUserAgentString(ajustes.getUserAgentString() + (esTele() ? " Android TV" : "") + " MorvehTVApp");

        CookieManager.getInstance().setAcceptCookie(true);
        // Los reproductores de otros sitios suelen necesitar sus propias cookies dentro del iframe
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        // WebView API for Ads: se registra el WebView en el SDK de Google para que los anuncios de
        // AdSense de la web estén permitidos dentro de la app (y Google pueda medirlos bien). Si
        // funciona, la web lo sabe por «MorvehTVAds» en el nombre del navegador y solo entonces los
        // pone; en aparatos sin los servicios de Google (Fire TV…) no se registra y no salen.
        try {
            MobileAds.registerWebView(web);
            ajustes.setUserAgentString(ajustes.getUserAgentString() + " MorvehTVAds");
        } catch (Throwable e) {
            // sin el SDK o sin servicios de Google: la app sigue igual, sin anuncios
        }

        web.setBackgroundColor(Color.BLACK);
        web.addJavascriptInterface(new Puente(), "MorvehApp");
        web.setWebViewClient(new Cliente());
        web.setWebChromeClient(cromo);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        // Sin el resaltado que Android 8+ pinta sobre toda la vista web al enfocarla con el mando
        if (android.os.Build.VERSION.SDK_INT >= 26) web.setDefaultFocusHighlightEnabled(false);

        reintentar.setOnClickListener(v -> {
            // Si ya se estaba dentro de MorvehTV se recarga esa misma página; si no, la portada
            String url = web.getUrl();
            if (url != null && esNuestra(Uri.parse(url))) { prepararCarga(); web.reload(); }
            else abrir();
        });

        // Android 15 dibuja la app por debajo de la barra de estado y de la de navegación: se deja
        // ese hueco para que no tapen la cabecera ni los controles (en pantalla completa, nada)
        raiz.setOnApplyWindowInsetsListener((v, insets) -> {
            int arriba, abajo, izq, der;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                arriba = b.top; abajo = b.bottom; izq = b.left; der = b.right;
            } else {
                arriba = insets.getSystemWindowInsetTop(); abajo = insets.getSystemWindowInsetBottom();
                izq = insets.getSystemWindowInsetLeft(); der = insets.getSystemWindowInsetRight();
            }
            // (viendo un vídeo, sin hueco: ocupa la pantalla entera, también la zona de la cámara)
            if (vistaCompleta != null || sinBarras) v.setPadding(0, 0, 0, 0);
            else v.setPadding(izq, arriba, der, abajo);
            return insets;
        });
        actualizador = new Actualizador(this);

        if (guardado != null) web.restoreState(guardado);
        else abrir();
    }

    private boolean esTele() {
        UiModeManager modo = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        return modo != null && modo.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    private void abrir() {
        prepararCarga();
        web.loadUrl(BuildConfig.SERVIDOR);
    }

    private void prepararCarga() {
        cargada = false;
        hilo.removeCallbacksAndMessages(null);
        carga.setVisibility(View.VISIBLE);
        reintentar.setVisibility(View.GONE);
        mensaje.setText("Conectando…");
        // El plan gratis de Render se duerme: si tarda, se explica en vez de dejar la pantalla negra
        hilo.postDelayed(() -> {
            if (!cargada) mensaje.setText("Despertando el servidor…\nla primera vez puede tardar un minuto");
        }, 6000);
        hilo.postDelayed(agotado, TIEMPO_MAXIMO);
    }

    private void error(String motivo) {
        cargada = false;
        hilo.removeCallbacks(agotado);
        web.stopLoading();
        carga.setVisibility(View.VISIBLE);
        mensaje.setText(motivo + "\nComprueba la conexión a internet y vuelve a intentarlo.");
        reintentar.setVisibility(View.VISIBLE);
        reintentar.requestFocus();
    }

    // La web de MorvehTV (la dirección compilada en BuildConfig.SERVIDOR)
    private static boolean esNuestra(Uri u) {
        Uri casa = Uri.parse(BuildConfig.SERVIDOR);
        return u.getHost() != null && u.getHost().equalsIgnoreCase(casa.getHost());
    }

    // Patreon (Premium) y los inicios de sesión que ofrece: al conectar la cuenta hay varias
    // redirecciones automáticas entre sus páginas que tienen que poder seguir dentro de la app
    private static boolean esDePago(Uri u) {
        String h = u.getHost() == null ? "" : u.getHost().toLowerCase();
        return h.equals("patreon.com") || h.endsWith(".patreon.com")
            || h.equals("accounts.google.com") || h.equals("appleid.apple.com");
    }

    // Quita la pantalla de «Conectando…». Se hace en cuanto la página empieza a verse (o la
    // intro avisa de que arranca), no al terminar de cargar todo: si no, la intro empezaba
    // tapada y se veía a medias
    private void mostrarWeb() {
        if (reintentar.getVisibility() == View.VISIBLE) return;
        carga.setVisibility(View.GONE);
    }

    private class Cliente extends WebViewClient {
        @Override
        public void onPageCommitVisible(WebView vista, String url) {
            mostrarWeb();
        }

        @Override
        public void onPageFinished(WebView vista, String url) {
            if (reintentar.getVisibility() == View.VISIBLE) return;
            cargada = true;
            hilo.removeCallbacks(agotado);
            mostrarWeb();
            web.requestFocus();
            CookieManager.getInstance().flush();
            // Una vez por apertura, cuando ya se ve la app: ¿hay un APK más nuevo?
            if (!actualizacionMirada) {
                actualizacionMirada = true;
                actualizador.comprobar();
            }
        }

        @Override
        public void onReceivedError(WebView vista, WebResourceRequest pedido, WebResourceError fallo) {
            if (pedido.isForMainFrame()) error("No se pudo conectar con MorvehTV.");
        }

        // La página principal respondió, pero con un error (Render caído, 502 al desplegar…)
        @Override
        public void onReceivedHttpError(WebView vista, WebResourceRequest pedido, WebResourceResponse respuesta) {
            if (pedido.isForMainFrame()) error("MorvehTV respondió con un error (HTTP " + respuesta.getStatusCode() + ").");
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView vista, WebResourceRequest pedido) {
            // Solo la página principal: lo que pasa dentro de un iframe lo controla su sandbox
            if (!pedido.isForMainFrame()) return false;
            Uri u = pedido.getUrl();
            String esquema = u.getScheme();
            // «Abrir en mi cartera» (pago de Premium en USDC): un toque abre la app de cartera del
            // móvil (MetaMask, Coinbase Wallet…) con el pago ya preparado
            if ("ethereum".equals(esquema)) {
                if (pedido.hasGesture()) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) {
                        android.widget.Toast.makeText(MainActivity.this, "No hay ninguna cartera instalada: copia la dirección y el importe", android.widget.Toast.LENGTH_LONG).show();
                    }
                }
                return true;
            }
            if (!"http".equals(esquema) && !"https".equals(esquema)) return true; // intent:, market:…
            // MorvehTV y lo que abras tú con un toque (tráiler, TMDB) se quedan dentro de la app;
            // una redirección automática a otro sitio, no
            // (el toque tiene que ser en la propia página: uno dentro de un reproductor de otro sitio
            // también cuenta como «gesto», pero no avisa a la app con permitir())
            boolean toqueMio = pedido.hasGesture() && android.os.SystemClock.uptimeMillis() - toqueNuestro < 1500;
            return !(esNuestra(u) || esDePago(u) || toqueMio);
        }
    }

    // Vídeo a pantalla completa (botón ⛶ del reproductor)
    private class Cromo extends WebChromeClient {
        // Ventanas nuevas (window.open, target="_blank"): las que salen solas se cancelan; las de un
        // toque tuyo (Tráiler, TMDB ↗) se abren en la misma vista, como antes. Los reproductores
        // de otros sitios van en un iframe sin permiso de ventanas, así que nunca llegan aquí.
        @Override
        public boolean onCreateWindow(WebView vista, boolean dialogo, boolean gesto, Message resultado) {
            if (!gesto || dialogo) return false;
            // Una ventana que pide un reproductor de otro sitio (sus anuncios) se descarta: solo las
            // que siguen a un toque en la propia página de MorvehTV
            if (android.os.SystemClock.uptimeMillis() - toqueNuestro > 1500) return false;
            // Una vista provisional solo para saber qué dirección quería abrir
            WebView provisional = new WebView(MainActivity.this);
            provisional.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest pedido) {
                    String esquema = pedido.getUrl().getScheme();
                    if ("http".equals(esquema) || "https".equals(esquema)) web.loadUrl(pedido.getUrl().toString());
                    hilo.post(v::destroy); // no se destruye dentro de su propio aviso
                    return true;
                }
            });
            ((WebView.WebViewTransport) resultado.obj).setWebView(provisional);
            resultado.sendToTarget();
            return true;
        }

        @Override
        public void onShowCustomView(View vista, CustomViewCallback alSalir) {
            if (vistaCompleta != null) { alSalir.onCustomViewHidden(); return; }
            vistaCompleta = vista;
            alSalirCompleta = alSalir;
            raiz.addView(vista, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            ocultarBarras(true);
            raiz.setPadding(0, 0, 0, 0);
            // En el móvil, el vídeo a pantalla completa se ve en horizontal (gira según cómo lo cojas)
            if (!esTele()) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }

        @Override
        public void onHideCustomView() {
            if (vistaCompleta == null) return;
            raiz.removeView(vistaCompleta);
            vistaCompleta = null;
            web.setVisibility(View.VISIBLE);
            ocultarBarras(false);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            raiz.requestApplyInsets();
            if (alSalirCompleta != null) alSalirCompleta.onCustomViewHidden();
            alSalirCompleta = null;
            web.requestFocus();
        }
    }

    @SuppressWarnings("deprecation")
    private void ocultarBarras(boolean ocultar) {
        getWindow().getDecorView().setSystemUiVisibility(ocultar
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                : View.SYSTEM_UI_FLAG_VISIBLE);
    }

    // Lo que la web puede pedir a la app
    private class Puente {
        // Botón «Salir» de la web: pregunta y cierra la app del todo
        @JavascriptInterface
        public void salir() {
            runOnUiThread(() -> new android.app.AlertDialog.Builder(MainActivity.this, android.R.style.Theme_Material_Dialog_Alert)
                    .setTitle("Salir de MorvehTV")
                    .setMessage("¿Quieres cerrar la app?")
                    .setPositiveButton("Salir", (d, w) -> finishAndRemoveTask())
                    .setNegativeButton("Cancelar", null)
                    .show());
        }

        // La página avisa de cada toque suyo: así una ventana nueva que llega justo después es de
        // MorvehTV (Tráiler, TMDB…) y no un anuncio de un reproductor metido en un iframe
        @JavascriptInterface
        public void permitir() {
            toqueNuestro = android.os.SystemClock.uptimeMillis();
        }

        // Solo una marca para la web: esta app bloquea las navegaciones que no vienen de un toque en
        // MorvehTV, así que puede meter reproductores de otros sitios sin aislar (Byse lo exige)
        @JavascriptInterface
        public boolean sinAislar() {
            return true;
        }

        @JavascriptInterface
        public void introEmpieza() {
            runOnUiThread(MainActivity.this::mostrarWeb);
        }

        // El vídeo a pantalla completa dentro de la propia página (sin abrir una vista aparte):
        // la web solo pide esconder las barras del móvil y ponerlo en horizontal; al salir del
        // vídeo, todo vuelve a como estaba. En la tele no hay barras ni giro.
        @JavascriptInterface
        public void barras(boolean ocultar) {
            runOnUiThread(() -> {
                if (vistaCompleta != null) return;
                sinBarras = ocultar;
                // El vídeo también por la zona de la cámara (muesca o agujero), de borde a borde
                if (android.os.Build.VERSION.SDK_INT >= 28) {
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.layoutInDisplayCutoutMode = ocultar ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                            : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
                    getWindow().setAttributes(lp);
                }
                ocultarBarras(ocultar);
                if (!esTele()) setRequestedOrientation(ocultar ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                raiz.requestApplyInsets();
            });
        }

        @JavascriptInterface
        public void pantalla(boolean encendida) {
            runOnUiThread(() -> {
                if (encendida) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }

    // Atrás (móvil o mando): primero lo gestiona la web (cerrar vídeo, subir de carpeta…);
    // si ya está en la portada, se sale de la app
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (vistaCompleta != null) {
            cromo.onHideCustomView();
            return;
        }
        if (!cargada) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(window.morvehAtras ? window.morvehAtras() : false)", resultado -> {
            if ("true".equals(resultado)) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        // Algunas teles mandan «Atrás» como tecla y no llaman a onBackPressed
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) onBackPressed();
            return true;
        }
        // Teclas multimedia del mando (▶❚❚, ⏩, ⏪, ⏭, ⏮, canal ±): según la tele, Android se las
        // queda para el sistema y la web nunca las recibe. Se le pasan a la web tal cual, con el
        // mismo nombre que usaría un navegador, y la web hace lo de siempre (pausar, avanzar…)
        String nombre = teclaMultimedia(e.getKeyCode());
        if (nombre != null && cargada) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                web.evaluateJavascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'" + nombre + "',bubbles:true,cancelable:true,repeat:"
                        + (e.getRepeatCount() > 0) + "}))", null);
            }
            return true;
        }
        // El botón central de algunos mandos (y el «A» de los mandos de juegos) es OK
        if (e.getKeyCode() == KeyEvent.KEYCODE_BUTTON_A || e.getKeyCode() == KeyEvent.KEYCODE_NUMPAD_ENTER) {
            return super.dispatchKeyEvent(new KeyEvent(e.getDownTime(), e.getEventTime(), e.getAction(), KeyEvent.KEYCODE_ENTER,
                    e.getRepeatCount(), e.getMetaState(), e.getDeviceId(), e.getScanCode(), e.getFlags(), e.getSource()));
        }
        // «Atrás» de los mandos de juegos
        if (e.getKeyCode() == KeyEvent.KEYCODE_BUTTON_B) {
            if (e.getAction() == KeyEvent.ACTION_UP) onBackPressed();
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    private static String teclaMultimedia(int codigo) {
        switch (codigo) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK: return "MediaPlayPause";
            case KeyEvent.KEYCODE_MEDIA_PLAY: return "MediaPlay";
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "MediaPause";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return "MediaFastForward";
            case KeyEvent.KEYCODE_MEDIA_REWIND: return "MediaRewind";
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD: return "MediaTrackNext";
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD: return "MediaTrackPrevious";
            case KeyEvent.KEYCODE_CHANNEL_UP: return "ChannelUp";
            case KeyEvent.KEYCODE_CHANNEL_DOWN: return "ChannelDown";
            default: return null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle estado) {
        super.onSaveInstanceState(estado);
        web.saveState(estado);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // (vuelve a funcionar la página; el vídeo sigue en pausa hasta pulsar ▶)
        web.onResume();
        actualizador.alVolver();
    }

    // Respuesta del instalador de Android al actualizar
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (Actualizador.ACCION_RESULTADO.equals(intent.getAction())) actualizador.resultado(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Al salir de la app (inicio, otra app, apagar la pantalla) el vídeo se para: también el
        // de los reproductores de otras webs (enlaces), que la página no puede pausar
        web.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        hilo.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
