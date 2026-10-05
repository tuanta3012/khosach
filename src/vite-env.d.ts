/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_AAB?: string | boolean;
  readonly [key: string]: any;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
