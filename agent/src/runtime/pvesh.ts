/**
 * Backwards-compatible shim. The implementation moved to `pveApi.ts` in PR
 * "proxmox: PVE REST API transport mode" (2026-05-05) so the same call
 * site can target either local pvesh OR the REST API depending on agent
 * config. Imports of `pvesh` keep working through this shim for one
 * release; new code should import `pveApi` directly.
 */
export { pveApi as pvesh } from './pveApi';
