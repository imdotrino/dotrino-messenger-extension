# Dotrino Messenger — extensión de Chrome

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué comparte, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

Extensión MV3 que enseña el [messenger](https://messenger.dotrino.com) **encima de la
página en la que estás**, para leer y contestar sin salir de ella, y que recibe los
mensajes con la pestaña del messenger cerrada.

Salió de [`dotrino-messenger`](https://github.com/imdotrino/dotrino-messenger) el
2026-09-19: es **otro producto** —se instala aparte, se revisa aparte en la Web Store y
tiene su propia promesa—, y ahí dentro obligaba a la PWA a cargar con tres modos de
arranque (`?embed=overlay|popup|offscreen`) que nada más servían para esto.

## Estado: NO FUNCIONA TAL CUAL. Falta la mitad que vivía en la PWA

Esto no es una advertencia de estilo. La extensión **no tiene UI propia**: las tres
superficies (el panel sobre la página, el popup de la barra y el documento offscreen que
mantiene la conexión) son iframes a `messenger.dotrino.com`, y lo que las hacía útiles
era código **dentro de la PWA**, que se quitó al separarlas:

| Qué hacía | Dónde vivía | Por qué hace falta |
|---|---|---|
| leer `?embed=` y compactar la UI (`cc-embed`) | `src/main.js`, `src/style.css` | el panel mide 360×540, no una pantalla |
| avisar al padre que arrancó (`postMessage` `ready`) | `src/main.js` | sin eso el content script no distingue «cargó» de «lo bloqueó el CSP del sitio» |
| puente de identidad por `chrome.storage.local` | `src/services/identityBridge.js` | el iframe sobre otro sitio tiene **storage particionado**: sin el puente se inventa una cuenta nueva en cada web |
| espejo de conversaciones | `src/services/threadsBridge.js` | mismo motivo: el histórico no se ve desde el panel |
| cola de salida (`cc-outbound-v1`) | `src/services/proxyRelay.js` | una conexión al proxio por pestaña abierta = ban; el offscreen manda por todas |
| avisar del DM al padre (`dm-arrived`) | `src/stores/threadsStore.js` | es lo que dispara el toast y la notificación nativa |
| CTA «entra en messenger.dotrino.com» sin identidad | `src/App.vue`, `src/i18n.js` | en un iframe particionado no se puede crear cuenta |

Todo eso está guardado en **`pwa-support/`**:

- `identityBridge.js`, `threadsBridge.js`, `proxyRelay.js` — los tres servicios tal como
  estaban, para leerlos sin aplicar nada.
- `messenger-embed.patch` — el parche que **reintroduce** el soporte entero en el
  messenger (`git apply` contra `dotrino-messenger@2b31a3e`; más abajo de esa base habrá
  que resolver a mano).

## Qué hay que decidir antes de revivirlo

La forma en que esto funcionaba mete su soporte dentro de otra app, y eso es lo que se
acaba de deshacer. Antes de volver a enchufarlo, el camino tiene que ser uno de estos:

1. **La extensión se hace autónoma**: su propia UI (Vue + los pilares `@dotrino/*`), sin
   iframes a la PWA. La PWA no sabe que existe.
2. **El soporte vuelve a la PWA**, pero como algo del ecosistema y no como un parche: un
   modo embed documentado, o un paquete `@dotrino/*` que cualquier app pueda usar para
   ser embebida (§«Si falta una característica» de `CLAUDE.md`).

Lo que **no** vale es volver a esparcir `if (embed === 'overlay')` por los stores de una
app: es de donde venía el problema.

## Piezas

- `manifest.json` — permisos: `offscreen`, `notifications`, `alarms`. Hosts: messenger /
  id / store / proxy.
- `background.js` — service worker; dispara las notificaciones nativas y reparte a las
  pestañas lo que llega del offscreen.
- `offscreen.html` / `offscreen.js` — `<iframe src="…/?embed=offscreen">`: mantiene la
  conexión al proxio con el messenger cerrado.
- `content.js` + `overlay.css` — Shadow DOM en `<all_urls>`: el aviso que aparece y se va,
  y el panel deslizable (otro iframe a la PWA).
- `popup/popup.html` — el popup de la barra, también iframe.
- `identity-bridge-host.js` — el otro extremo del puente: habla `chrome.storage.local` por
  `postMessage` con el iframe.

## Cargarla en el navegador

```
chrome://extensions/ → Modo desarrollador → Cargar descomprimida → esta carpeta
```

## Empaquetar para la Web Store

```bash
./package-extension.sh        # Linux/macOS
.\package-extension.ps1       # Windows
# → ../dotrino-messenger-extension-<versión>.zip   (la versión va en el nombre, §11.5)
```

Un tag `v*` dispara `.github/workflows/build-extension.yml`, que deja el zip como
artefacto.

Documentación de revisión de la Web Store, en este mismo repo: `PRIVACY.md` (política de
privacidad), `PERMISSIONS.md` (justificación de cada permiso), `STORE_LISTING.md` (copy
del listado) y `SUBMISSION.md` (checklist de envío).
