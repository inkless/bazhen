/// <reference types="vite/client" />

/** The protocol id of the schema this page was built against; `vite.config.ts` serves it. */
declare module "virtual:bazhen/protocol-id" {
  const id: string;
  export default id;
}
