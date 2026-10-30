// Rioplatense Spanish for the screens 8th Wall's xrextras draws in English
// (camera and motion permission errors, "open in Safari", video sharing).
// Their HTML has no language option, so each text node is swapped as it is
// added to the page. Keys are xrextras' fragments with whitespace collapsed; an
// icon or app name between fragments stays where it is.
(() => {
  const ES = {
    'Add to your home screen': 'Agregala a tu pantalla de inicio',
    'Advanced': 'Avanzado',
    'Blocked': 'Bloqueado',
    'Browser doesn\'t support WebAssembly. Please update your browser.': 'Tu navegador no puede mostrar la experiencia. Actualizalo y volvé a intentar.',
    'CLEAR & RESET': 'BORRAR Y RESTABLECER',
    'Camera': 'Cámara',
    'Copied!': '¡Copiado!',
    'Copy Link': 'Copiar enlace',
    'DELETE': 'BORRAR',
    'Do the same for Camera': 'Hacé lo mismo con la cámara',
    'Downloading is only available in Safari': 'Solo se puede descargar desde Safari',
    'Enable': 'Activá',
    'Ensure camera + microphone access is allowed in': 'Revisá que la cámara y el micrófono estén permitidos en la configuración de',
    'Ensure camera access is allowed in': 'Revisá que la cámara esté permitida en la configuración de',
    'Let\'s enable your camera': 'Activemos la cámara',
    'Let\'s enable your microphone': 'Activemos el micrófono',
    'Let\'s enable your motion sensors': 'Activemos los sensores de movimiento',
    'Manage website data': 'Administrar datos de sitios web',
    'Microphone': 'Micrófono',
    'Motion & Orientation Access': 'Acceso a movimiento y orientación',
    'Oops, something went wrong!': '¡Uy, algo salió mal!',
    'Open': 'Abrí',
    'Open in Browser': 'Abrir en el navegador',
    'Open in Safari': 'Abrilo en Safari',
    'Open your browser and paste.': 'Abrí tu navegador y pegalo.',
    'Permissions were denied.': 'No se dieron los permisos.',
    'Please close': 'Cerrá la app',
    'Press and hold': 'Mantené presionado',
    'Record': 'Grabar',
    'Refresh': 'Recargar',
    'Reload the page': 'Recargá la página',
    'Reload the page and enable camera + microphone access': 'Recargá la página y permití la cámara y el micrófono',
    'Reload the page and enable camera access': 'Recargá la página y permití la cámara',
    'Select': 'Elegí',
    'Settings': 'Configuración',
    'Site settings': 'Configuración de sitios',
    'Start AR': 'Empezar',
    'Tap + Hold to Share': 'Mantené presionado para compartir',
    'Tap Settings': 'Tocá Configuración',
    'Tap \'Allow\' to access AR': 'Tocá «Permitir» para ver la experiencia',
    'Tap the': 'Tocá el',
    'Then, reload the page for AR!': 'Después, recargá la página para ver la experiencia.',
    'To view this experience on your Android device, please open in Google Chrome or your native browser.':
      'Para ver la experiencia en Android, abrila en Google Chrome o en el navegador de tu celular.',
    'To view this experience on your Huawei device, please open in Google Chrome or UC Browser.':
      'Para ver la experiencia en un Huawei, abrila en Google Chrome o en UC Browser.',
    'To view this experience, please update to a newer version of iOS.':
      'Para ver la experiencia, actualizá tu iPhone a una versión más nueva de iOS.',
    'To view, open camera on smartphone and scan code': 'Para verla, abrí la cámara del celular y escaneá el código',
    'You need to accept motion permissions to continue.': 'Para seguir, tenés que permitir el acceso a los sensores de movimiento.',
    'You\'re almost there!': '¡Ya casi!',
    'You\'ve prevented the page from accessing your motion sensors.': 'Bloqueaste el acceso de la página a los sensores de movimiento.',
    // A placeholder in xrextras' site-settings steps: the site to look for is this one.
    'apps.8thwall.com': location.host,
    'app settings': '',
    'app to reenable your motion sensors.': 'y volvé a abrirla para activar los sensores de movimiento.',
    'for easy access.': 'para tenerla a mano.',
    'in the top right': 'arriba a la derecha',
    'on a smartphone or tablet.': 'en un celular o una tablet.',
    'or visit': 'o entrá a',
    'to view AR': 'para ver la experiencia',
  }

  const translate = (node) => {
    const key = node.nodeValue.replace(/\s+/g, ' ').trim()
    if (!(key in ES)) return
    const [, lead, , trail] = node.nodeValue.match(/^(\s*)([\s\S]*?)(\s*)$/)
    node.nodeValue = lead + ES[key] + trail
  }
  const walk = (root) => {
    if (root.nodeType === Node.TEXT_NODE) return translate(root)
    if (root.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE|CANVAS|A-SCENE)$/.test(root.nodeName)) return
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = it.nextNode(); n; n = it.nextNode()) translate(n)
  }
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translate(r.target)
      else r.addedNodes.forEach(walk)
    }
  }).observe(document.documentElement, {childList: true, subtree: true, characterData: true})
  document.addEventListener('DOMContentLoaded', () => walk(document.body))
})()
