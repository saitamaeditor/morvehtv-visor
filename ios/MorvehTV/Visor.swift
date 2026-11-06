import SafariServices
import UIKit
import WebKit

/// MorvehTV en iPhone y iPad: la web de morvehtv.com a pantalla completa. La web lo hace casi
/// todo (portada, fichas, reproductor, cuenta); aquí se añade lo que una web no puede: abrir
/// sin Safari, sesión que no caduca al cerrar, pantalla encendida mientras ves algo, sonido con
/// el iPhone en silencio, AirPlay e imagen dentro de imagen.
final class Visor: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var web: WKWebView!
    private let carga = UIView()
    private let mensaje = UILabel()
    private let reintentar = UIButton(type: .system)
    private let rueda = UIActivityIndicatorView(style: .large)
    private var cargada = false
    private var agotado: DispatchWorkItem?

    private let servidor: URL = {
        let texto = Bundle.main.object(forInfoDictionaryKey: "MorvehServidor") as? String ?? ""
        return URL(string: texto.isEmpty ? "https://morvehtv.com" : texto)!
    }()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let ajustes = WKWebViewConfiguration()
        // Los vídeos se ven dentro de la página (con el reproductor de MorvehTV), no saltan solos
        // al reproductor de iOS; y pueden ir a la tele por AirPlay o a imagen dentro de imagen
        ajustes.allowsInlineMediaPlayback = true
        ajustes.mediaTypesRequiringUserActionForPlayback = []
        ajustes.allowsAirPlayForMediaPlayback = true
        ajustes.allowsPictureInPictureMediaPlayback = true
        // La sesión (cookie) se guarda en el iPhone: no hay que volver a entrar cada vez
        ajustes.websiteDataStore = .default()
        // La web reconoce la app por este nombre (igual que la de Android)
        ajustes.applicationNameForUserAgent = "Mobile/15E148 MorvehTVApp"
        // Lo que la web puede pedir a la app: el mismo «MorvehApp» que en Android
        let puente = WKUserContentController()
        puente.add(PuenteDebil(self), name: "morveh")
        puente.addUserScript(WKUserScript(source: """
            window.MorvehApp = {
              introEmpieza: function () { window.webkit.messageHandlers.morveh.postMessage({ que: 'intro' }); },
              pantalla: function (si) { window.webkit.messageHandlers.morveh.postMessage({ que: 'pantalla', si: !!si }); }
            };
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ajustes.userContentController = puente

        web = WKWebView(frame: .zero, configuration: ajustes)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        // La web ya deja sitio a la muesca y a la barra de abajo (viewport-fit=cover)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.allowsLinkPreview = false
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        prepararPantallaDeCarga()
        abrir()
    }

    // ---------- Pantalla de «Conectando…» y de error ----------
    private func prepararPantallaDeCarga() {
        carga.backgroundColor = .black
        carga.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(carga)
        NSLayoutConstraint.activate([
            carga.topAnchor.constraint(equalTo: view.topAnchor),
            carga.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            carga.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            carga.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        rueda.color = .white
        mensaje.textColor = UIColor(white: 1, alpha: 0.8)
        mensaje.font = .preferredFont(forTextStyle: .body)
        mensaje.numberOfLines = 0
        mensaje.textAlignment = .center
        reintentar.setTitle("Reintentar", for: .normal)
        reintentar.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        reintentar.tintColor = UIColor(red: 0.878, green: 0.271, blue: 0.608, alpha: 1) // el rosa de MorvehTV
        reintentar.addTarget(self, action: #selector(alReintentar), for: .touchUpInside)
        let pila = UIStackView(arrangedSubviews: [rueda, mensaje, reintentar])
        pila.axis = .vertical
        pila.spacing = 16
        pila.alignment = .center
        pila.translatesAutoresizingMaskIntoConstraints = false
        carga.addSubview(pila)
        NSLayoutConstraint.activate([
            pila.centerXAnchor.constraint(equalTo: carga.centerXAnchor),
            pila.centerYAnchor.constraint(equalTo: carga.centerYAnchor),
            pila.leadingAnchor.constraint(greaterThanOrEqualTo: carga.leadingAnchor, constant: 24),
            pila.trailingAnchor.constraint(lessThanOrEqualTo: carga.trailingAnchor, constant: -24),
        ])
    }

    private func abrir() {
        prepararCarga()
        web.load(URLRequest(url: servidor))
    }

    private func prepararCarga() {
        cargada = false
        carga.isHidden = false
        carga.alpha = 1
        rueda.startAnimating()
        mensaje.text = "Conectando…"
        reintentar.isHidden = true
        agotado?.cancel()
        let tarea = DispatchWorkItem { [weak self] in
            guard let self, !self.cargada else { return }
            self.error("MorvehTV no responde (tiempo agotado).")
        }
        agotado = tarea
        DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: tarea)
    }

    private func error(_ motivo: String) {
        cargada = false
        agotado?.cancel()
        web.stopLoading()
        carga.isHidden = false
        carga.alpha = 1
        rueda.stopAnimating()
        mensaje.text = motivo + "\nComprueba la conexión a internet y vuelve a intentarlo."
        reintentar.isHidden = false
    }

    private func mostrarWeb() {
        guard reintentar.isHidden, !carga.isHidden else { return }
        UIView.animate(withDuration: 0.25, animations: { self.carga.alpha = 0 }) { _ in
            if self.reintentar.isHidden { self.carga.isHidden = true }
        }
    }

    @objc private func alReintentar() {
        // Si ya se estaba dentro de MorvehTV se recarga esa misma página; si no, la portada
        if let url = web.url, esNuestra(url) { prepararCarga(); web.reload() } else { abrir() }
    }

    private func esNuestra(_ url: URL) -> Bool {
        url.host?.lowercased() == servidor.host?.lowercased()
    }

    // ---------- Navegación ----------
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        mostrarWeb()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard reintentar.isHidden else { return }
        cargada = true
        agotado?.cancel()
        mostrarWeb()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError fallo: Error) {
        if (fallo as NSError).code == NSURLErrorCancelled { return }
        error("No se pudo conectar con MorvehTV.")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError fallo: Error) {
        if (fallo as NSError).code == NSURLErrorCancelled { return }
        if !cargada { error("No se pudo conectar con MorvehTV.") }
    }

    // La página principal respondió con un error (servidor reiniciándose al publicar…)
    func webView(_ webView: WKWebView, decidePolicyFor respuesta: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if respuesta.isForMainFrame, let http = respuesta.response as? HTTPURLResponse, http.statusCode >= 500 {
            decisionHandler(.cancel)
            error("MorvehTV respondió con un error (HTTP \(http.statusCode)).")
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor accion: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = accion.request.url
        // Lo que pasa dentro de un iframe (anuncios, reproductores de otros sitios) lo controla su sandbox
        guard accion.targetFrame?.isMainFrame ?? false, let url else { return decisionHandler(.allow) }
        let esquema = url.scheme?.lowercased() ?? ""
        if esquema == "about" || esquema == "blob" || esquema == "data" { return decisionHandler(.allow) }
        if esNuestra(url) { return decisionHandler(.allow) }
        // Otro sitio en la página principal: si lo has tocado tú (tráiler, TMDB, pagar el VIP…) se
        // abre aparte, en Safari dentro de la app; las redirecciones automáticas, no
        decisionHandler(.cancel)
        // (el pago del VIP en Ko-fi se abre desde un botón de la web, no desde un enlace)
        let esPago = url.host?.lowercased().hasSuffix("ko-fi.com") ?? false
        if esTocado(accion) || esPago { abrirFuera(url) }
    }

    // window.open / target="_blank" (iOS solo los deja pasar con un toque tuyo): MorvehTV en la
    // misma vista; otros sitios, aparte
    func webView(_ webView: WKWebView, createWebViewWith ajustes: WKWebViewConfiguration, for accion: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = accion.request.url {
            if esNuestra(url) { webView.load(accion.request) } else { abrirFuera(url) }
        }
        return nil
    }

    private func esTocado(_ accion: WKNavigationAction) -> Bool {
        accion.navigationType == .linkActivated
    }

    private func abrirFuera(_ url: URL) {
        let esquema = url.scheme?.lowercased() ?? ""
        if esquema == "http" || esquema == "https" {
            let safari = SFSafariViewController(url: url)
            safari.preferredControlTintColor = reintentar.tintColor
            safari.preferredBarTintColor = .black
            present(safari, animated: true)
        } else if UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        }
    }

    // iOS cerró la parte web por falta de memoria: se vuelve a cargar en vez de quedarse en blanco
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let url = webView.url, esNuestra(url) { prepararCarga(); webView.reload() } else { abrir() }
    }

    // Avisos de la web (alert / confirm) con el aspecto de iOS
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage texto: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let aviso = UIAlertController(title: nil, message: texto, preferredStyle: .alert)
        aviso.addAction(UIAlertAction(title: "Vale", style: .default) { _ in completionHandler() })
        present(aviso, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage texto: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let aviso = UIAlertController(title: nil, message: texto, preferredStyle: .alert)
        aviso.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(false) })
        aviso.addAction(UIAlertAction(title: "Aceptar", style: .default) { _ in completionHandler(true) })
        present(aviso, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt texto: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let aviso = UIAlertController(title: nil, message: texto, preferredStyle: .alert)
        aviso.addTextField { $0.text = defaultText }
        aviso.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(nil) })
        aviso.addAction(UIAlertAction(title: "Aceptar", style: .default) { _ in completionHandler(aviso.textFields?.first?.text) })
        present(aviso, animated: true)
    }

    // ---------- Puente con la web ----------
    func userContentController(_ controlador: WKUserContentController, didReceive mensaje: WKScriptMessage) {
        guard let datos = mensaje.body as? [String: Any], let que = datos["que"] as? String else { return }
        switch que {
        case "intro": mostrarWeb()
        // Mientras se ve un vídeo la pantalla no se apaga sola
        case "pantalla": UIApplication.shared.isIdleTimerDisabled = (datos["si"] as? Bool) ?? false
        default: break
        }
    }
}

// WKUserContentController retiene a quien escucha: así el visor se puede liberar
private final class PuenteDebil: NSObject, WKScriptMessageHandler {
    weak var destino: WKScriptMessageHandler?
    init(_ destino: WKScriptMessageHandler) { self.destino = destino }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        destino?.userContentController(c, didReceive: m)
    }
}
