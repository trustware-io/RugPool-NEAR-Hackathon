// Lets Node (with --experimental-strip-types) run scripts that import the app's TypeScript
// modules, which use extensionless relative imports the way Vite expects.
//   node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/relayer.ts
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\\.\\.?\\//.test(specifier)) throw e
    return next(specifier + '.ts', context)
  }
}`),
  import.meta.url,
)
