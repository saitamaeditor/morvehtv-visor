// Lo que les falta a los navegadores de las smart TV de 2017-2019 (≈ Chrome 56) y a iOS 12.
// Solo se añade si el navegador no lo trae.
(function () {
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (n, r) {
      var s = String(this);
      r = r === undefined ? ' ' : String(r);
      while (s.length < n) s = r + s;
      return s.slice(s.length - Math.max(n, String(this).length));
    };
  }
  if (!Array.prototype.at) {
    Array.prototype.at = function (i) {
      i = Math.trunc(i) || 0;
      if (i < 0) i += this.length;
      return this[i];
    };
  }
  if (window.Promise && !Promise.prototype.finally) {
    Promise.prototype.finally = function (f) {
      return this.then(
        function (v) { return Promise.resolve(f()).then(function () { return v; }); },
        function (e) { return Promise.resolve(f()).then(function () { throw e; }); }
      );
    };
  }
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.append.apply(this, arguments);
    };
  }
  if (!Object.fromEntries) {
    Object.fromEntries = function (pares) {
      var o = {};
      Array.from(pares).forEach(function (p) { o[p[0]] = p[1]; });
      return o;
    };
  }
})();
