// Bridge de identidad: cuando el messenger corre como iframe dentro de la
// extensión (popup, overlay, offscreen), usa `chrome.storage.local` (vía
// postMessage al host script de la extensión) como fuente compartida del
// blob de identidad. Esto puentea el storage partitioning: el offscreen
// (unpartitioned) escribe el blob real, los overlays (particionados por
// el site visitado) lo leen al arrancar e importan la identidad antes de
// crear una nueva en su bucket aislado.
//
// El protocolo es muy simple: postMessage al parent con
//   { source:'cc-id-bridge', type:'request', id, op:'get'|'set'|'clear', blob? }
// y el host responde con
//   { source:'cc-id-bridge', type:'response', id, result?, error? }
// (definido en extension/identity-bridge-host.js).

// @ts-check

let _nextId = 1
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
const _pending = new Map()
let _wired = false

// Disponibilidad del bridge: solo existe un host (`identity-bridge-host.js`)
// cuando el messenger corre DENTRO de la extensión (overlay/popup/offscreen) o
// cuando el content script de la extensión lo inyecta en messenger.dotrino.com.
// Como PWA standalone sin la extensión NO hay host: sin esta sonda cada `call`
// esperaba 3s a un timeout (y spameaba la consola) en cada arranque. Sondeamos
// una vez con un timeout corto y cacheamos el resultado; si no hay host, todas
// las ops se cortan de inmediato devolviendo su default.
/** @type {Promise<boolean> | null} */
let _available = null  // Promise<boolean> | null
const PROBE_TIMEOUT_MS = 800

/** @returns {Promise<boolean>} */
function probeBridge () {
  ensureWired()
  const target = window.parent !== window ? window.parent : window
  return new Promise((resolve) => {
    const id = _nextId++
    const timer = setTimeout(() => { _pending.delete(id); resolve(false) }, PROBE_TIMEOUT_MS)
    // Cualquier respuesta del host (resultado o error) prueba que existe.
    const seen = () => { clearTimeout(timer); resolve(true) }
    _pending.set(id, { resolve: seen, reject: seen, timer })
    try {
      target.postMessage({ source: 'cc-id-bridge', type: 'request', id, op: 'get' }, '*')
    } catch { _pending.delete(id); clearTimeout(timer); resolve(false) }
  })
}

/**
 * True si hay un host del bridge respondiendo (extensión presente). Cacheado.
 * @returns {Promise<boolean>}
 */
export function bridgeAvailable () {
  if (!_available) _available = probeBridge()
  return _available
}

// chrome.storage serializa con JSON, así que pasamos un clon JSON-safe: elimina
// Proxies reactivos de Vue, funciones y demás valores no estructurables-clonables
// que rompían `postMessage` con "could not be cloned".
/**
 * @template T
 * @param {T} v
 * @returns {T}
 */
function jsonSafe (v) {
  if (v == null || typeof v !== 'object') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return v }
}

function ensureWired () {
  if (_wired) return
  _wired = true
  window.addEventListener('message', (ev) => {
    const m = ev.data
    if (!m || m.source !== 'cc-id-bridge') return
    if (m.type === 'response' && _pending.has(m.id)) {
      const { resolve, reject, timer } = /** @type {NonNullable<ReturnType<typeof _pending.get>>} */ (_pending.get(m.id))
      _pending.delete(m.id)
      clearTimeout(timer)
      if (m.error) reject(new Error(m.error))
      else resolve(m.result)
    }
  })
}

/**
 * @param {string} op
 * @param {{ blob?: unknown, key?: string, value?: unknown, item?: unknown }} [payload]
 * @returns {Promise<any>} el `result` del host
 */
function call (op, payload = {}) {
  ensureWired()
  // Si estamos en pestaña directa (window === window.top) no hay parent, pero
  // el content script de la extensión inyecta `identity-bridge-host.js`
  // también en messenger.dotrino.com. Esa lista en el mismo `window` (en
  // su isolated world), así que basta con `window.postMessage` a sí mismo.
  const target = window.parent !== window ? window.parent : window
  return new Promise((resolve, reject) => {
    const id = _nextId++
    const timer = setTimeout(() => {
      _pending.delete(id)
      console.warn('[cc-id-bridge:client] timeout', { id, op })
      reject(new Error('cc-id-bridge timeout'))
    }, 3000)
    _pending.set(id, { resolve, reject, timer })
    try {
      console.log('[cc-id-bridge:client] →', { id, op, hasBlob: !!payload.blob })
      target.postMessage({ source: 'cc-id-bridge', type: 'request', id, op, ...payload }, '*')
    } catch (e) {
      _pending.delete(id)
      clearTimeout(timer)
      reject(e)
    }
  })
}

/**
 * Lee el blob de identidad del bridge. Devuelve null si no hay o no hay parent.
 * @returns {Promise<unknown>}
 */
export async function getIdentityBlob () {
  if (!(await bridgeAvailable())) return null
  try { return await call('get') }
  catch (e) { console.warn('[cc-id-bridge] get failed:', /** @type {Error} */ (e).message); return null }
}

/**
 * Guarda el blob de identidad (snapshot completo) al bridge.
 * @param {unknown} blob
 * @returns {Promise<boolean>}
 */
export async function setIdentityBlob (blob) {
  if (!(await bridgeAvailable())) return false
  try { await call('set', { blob: jsonSafe(blob) }); return true }
  catch (e) { console.warn('[cc-id-bridge] set failed:', /** @type {Error} */ (e).message); return false }
}

/**
 * Suscribe a cambios remotos del blob (otros contextos lo escribieron).
 * @param {(blob: unknown) => void} handler
 * @returns {() => void} para desuscribirse
 */
export function onIdentityBlobChanged (handler) {
  ensureWired()
  /** @param {MessageEvent} ev */
  const listener = (ev) => {
    const m = ev.data
    if (m?.source === 'cc-id-bridge' && m.type === 'changed') handler(m.blob)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

// ---- KV genérico (chrome.storage.local) -----------------------------------
// Las claves deben prefijarse con `cc-` (validado en el host).

/**
 * @param {string} key empieza por `cc-`
 * @returns {Promise<any>} el valor guardado, o null
 */
export async function kvGet (key) {
  if (!(await bridgeAvailable())) return null
  try { return await call('kv-get', { key }) }
  catch (e) { console.warn('[cc-id-bridge] kv-get failed:', /** @type {Error} */ (e).message); return null }
}

/**
 * @param {string} key empieza por `cc-`
 * @param {unknown} value
 * @returns {Promise<true | null>}
 */
export async function kvSet (key, value) {
  if (!(await bridgeAvailable())) return null
  try { return await call('kv-set', { key, value: jsonSafe(value) }) }
  catch (e) { console.warn('[cc-id-bridge] kv-set failed:', /** @type {Error} */ (e).message); return null }
}

/**
 * @param {string} key empieza por `cc-`
 * @param {unknown} item
 * @returns {Promise<number | null>} el largo del array tras añadir
 */
export async function kvAppendArray (key, item) {
  if (!(await bridgeAvailable())) return null
  try { return await call('kv-append-array', { key, item: jsonSafe(item) }) }
  catch (e) { console.warn('[cc-id-bridge] kv-append failed:', /** @type {Error} */ (e).message); return null }
}

/**
 * @param {(key: string, value: any) => void} handler
 * @returns {() => void} para desuscribirse
 */
export function onKvChanged (handler) {
  ensureWired()
  /** @param {MessageEvent} ev */
  const listener = (ev) => {
    const m = ev.data
    if (m?.source === 'cc-id-bridge' && m.type === 'kv-changed') handler(m.key, m.value)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
