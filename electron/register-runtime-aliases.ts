import Module from 'module';
import path from 'path';

const aliasPrefix = '@/';
const compiledSrcRoot = path.resolve(__dirname, '..', 'src');
const moduleAny = Module as typeof Module & {
  _resolveFilename?: (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
    options?: unknown,
  ) => string;
};

const originalResolveFilename = moduleAny._resolveFilename;

if (originalResolveFilename && !(globalThis as { __tesseraAliasRegistered?: boolean }).__tesseraAliasRegistered) {
  (globalThis as { __tesseraAliasRegistered?: boolean }).__tesseraAliasRegistered = true;

  moduleAny._resolveFilename = function patchedResolveFilename(
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
    options?: unknown,
  ) {
    if (request.startsWith(aliasPrefix)) {
      const mappedRequest = path.join(compiledSrcRoot, request.slice(aliasPrefix.length));
      return originalResolveFilename.call(this, mappedRequest, parent, isMain, options);
    }

    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
}
