/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin for production (Vercel). Example: https://api.example.com */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
