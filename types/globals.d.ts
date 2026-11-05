// Lo que comparten los scripts de la extensión (background, content, offscreen) y la PWA.

/** Un DM tal como lo reenvía el messenger PWA. */
interface CcDM {
  fromNickname?: string
  text?: string
  [field: string]: unknown
}

interface Window {
  /** Marca de que content.js ya se inyectó en esta página. */
  __cc_messenger_injected?: boolean
  /** Marca de que identity-bridge-host.js ya se inyectó en esta página. */
  __cc_identity_bridge_host?: boolean
}
