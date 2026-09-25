// Classic script (allowed by `script-src P`). Reports CSP violations and boot status to the parent.
(function () {
  const post = (o) => { try { parent.postMessage(Object.assign({ probe: true, page: location.search }, o), "*"); } catch (e) {} };
  document.addEventListener("securitypolicyviolation", (e) => {
    post({ kind: "csp", directive: e.violatedDirective, blocked: e.blockedURI, sample: (e.sample || "").slice(0, 60) });
  });
  addEventListener("error", (e) => post({ kind: "error", message: String(e.message), file: e.filename, line: e.lineno }));
  post({ kind: "loaded", origin: self.origin, href: location.href, supportsImportMap: HTMLScriptElement.supports ? HTMLScriptElement.supports("importmap") : "n/a" });
  setTimeout(() => post({ kind: "status", moduleRan: !!self.__moduleRan, dep: self.__dep || null, depError: self.__depError || null }), 2500);
})();
