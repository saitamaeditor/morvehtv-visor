package es.morvehtv.visor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

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
    private WebChromeClient.CustomViewCallback alSalirCompleta;
    private boolean cargada = false;
    private final Cromo cromo = new Cromo();
    private Actualizador actualizador;
    private boolean actualizacionMirada = false;
    private final Handler hilo = new Handler(Looper.getMainLooper());

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
        ajustes.setLoadWithOverviewMode(true);
        ajustes.setUseWideViewPort(true);
        // La web reconoce la tele por «Android TV» en el nombre del navegador: letra grande y mando
        ajustes.setUserAgentString(ajustes.getUserAgentString() + (esTele() ? " Android TV" : "") + " MorvehTVApp");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setBackgroundColor(Color.BLACK);
        web.addJavascriptInterface(new Puente(), "MorvehApp");
        web.setWebViewClient(new Cliente());
        web.setWebChromeClient(cromo);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        reintentar.setOnClickListener(v -> abrir());
        actualizador = new Actualizador(this);

        if (guardado != null) web.restoreState(guardado);
        else abrir();
    }

    private boolean esTele() {
        UiModeManager modo = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        return modo != null && modo.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    private void abrir() {
        cargada = false;
        carga.setVisibility(View.VISIBLE);
        reintentar.setVisibility(View.GONE);
        mensaje.setText("Conectando…");
        // El plan gratis de Render se duerme: si tarda, se explica en vez de dejar la pantalla negra
        hilo.postDelayed(() -> {
            if (!cargada) mensaje.setText("Despertando el servidor…\nla primera vez puede tardar un minuto");
        }, 6000);
        web.loadUrl(BuildConfig.SERVIDOR);
    }

    private void error() {
        cargada = false;
        carga.setVisibility(View.VISIBLE);
        mensaje.setText("No se pudo conectar con MorvehTV.\nComprueba la conexión a internet.");
        reintentar.setVisibility(View.VISIBLE);
        reintentar.requestFocus();
    }

    private class Cliente extends WebViewClient {
        @Override
        public void onPageFinished(WebView vista, String url) {
            if (reintentar.getVisibility() == View.VISIBLE) return;
            cargada = true;
            carga.setVisibility(View.GONE);
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
            if (pedido.isForMainFrame()) error();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView vista, WebResourceRequest pedido) {
            // Todo se queda dentro de la app (tráiler y TMDB incluidos)
            return false;
        }
    }

    // Vídeo a pantalla completa (botón ⛶ del reproductor)
    private class Cromo extends WebChromeClient {
        @Override
        public void onShowCustomView(View vista, CustomViewCallback alSalir) {
            if (vistaCompleta != null) { alSalir.onCustomViewHidden(); return; }
            vistaCompleta = vista;
            alSalirCompleta = alSalir;
            raiz.addView(vista, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            ocultarBarras(true);
        }

        @Override
        public void onHideCustomView() {
            if (vistaCompleta == null) return;
            raiz.removeView(vistaCompleta);
            vistaCompleta = null;
            web.setVisibility(View.VISIBLE);
            ocultarBarras(false);
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
        return super.dispatchKeyEvent(e);
    }

    @Override
    protected void onSaveInstanceState(Bundle estado) {
        super.onSaveInstanceState(estado);
        web.saveState(estado);
    }

    @Override
    protected void onResume() {
        super.onResume();
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
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        hilo.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
