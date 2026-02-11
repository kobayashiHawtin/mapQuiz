/// <reference types="vite/client" />

declare const __firebase_config: string
declare const __app_id: string | undefined
declare const __initial_auth_token: string | undefined

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
