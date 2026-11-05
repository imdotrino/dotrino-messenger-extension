// Outbound relay: cuando el messenger corre como overlay (FAB en cualquier
// site HTTPS), no abre WebSocket propio — encolaría una conexión más al proxy
// por cada pestaña HTTPS abierta. En su lugar, encola operaciones del proxy
// (`send`, `sendByPubkey`) en `chrome.storage.local` bajo `cc-outbound-v1`.
// El offscreen, que sí mantiene la conexión, escucha onChanged sobre esa
// clave y procesa cada item con su `wsProxyClient`.
//
// El popup pineado y la pestaña directa de messenger.dotrino.com NO usan
// este relay: son interacciones intencionales del usuario, una conexión a
// la vez es aceptable y mantiene latencia mínima.

// @ts-check

import { kvGet, kvSet, kvAppendArray, onKvChanged } from './identityBridge'

const QUEUE_KEY = 'cc-outbound-v1'

let _seq = 0
const newId = () => `${Date.now()}-${++_seq}`

/** @typedef {{ id: string, method: string, args: unknown[], ts: number }} OutboundItem */

/**
 * Encola una llamada al proxy. Resuelve cuando se persiste en storage.
 * @param {string} method
 * @param {unknown[]} args
 * @returns {Promise<string>} el id del item encolado
 */
export async function relayProxyCall (method, args) {
  const id = newId()
  await kvAppendArray(QUEUE_KEY, { id, method, args, ts: Date.now() })
  return id
}

/**
 * Solo para offscreen: procesa la cola.
 * `processor(item)` debe ser async y devolver `true` si se procesó (se quita
 * de la cola) o `false` para reintentar más tarde.
 *
 * Devuelve `{ drain, dispose }`: `drain()` fuerza un re-procesamiento (útil
 * cuando `isConnected` cambia a true y hay items deferidos), `dispose()` se
 * desuscribe de onKvChanged.
 * @param {(item: OutboundItem) => Promise<boolean>} processor
 * @returns {{ drain: () => Promise<void>, dispose: () => void }}
 */
export function watchOutboundQueue (processor) {
  let inFlight = false
  const drain = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const arr = await kvGet(QUEUE_KEY)
      if (!Array.isArray(arr) || arr.length === 0) return
      /** @type {OutboundItem[]} */
      const remaining = []
      for (const item of arr) {
        try {
          const ok = await processor(item)
          if (!ok) remaining.push(item)
        } catch (_) {
          remaining.push(item)
        }
      }
      if (remaining.length !== arr.length) await kvSet(QUEUE_KEY, remaining)
    } finally { inFlight = false }
  }
  drain().catch(() => {})
  const dispose = onKvChanged((key) => {
    if (key === QUEUE_KEY) drain().catch(() => {})
  })
  return { drain, dispose }
}
