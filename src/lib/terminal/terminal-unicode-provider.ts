import type { IUnicodeHandling, IUnicodeVersionProvider } from '@xterm/xterm';

interface XtermTerminalWithUnicodeCore {
  unicode: IUnicodeHandling;
  _core?: {
    unicodeService?: {
      _providers?: Record<string, IUnicodeVersionProvider>;
    };
  };
}

const TESSERA_UNICODE_VERSION = 'tessera-11-zwj';
const UNICODE11_VERSION = '11';
const ZERO_WIDTH_JOINER = 0x200d;

function extractWidth(properties: number): 0 | 1 | 2 {
  return ((properties >> 1) & 3) as 0 | 1 | 2;
}

function extractCharKind(properties: number): number {
  return properties >> 3;
}

function createProperties(charKind: number, width: 0 | 1 | 2, shouldJoin: boolean): number {
  return ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0);
}

class TesseraUnicodeProvider implements IUnicodeVersionProvider {
  readonly version = TESSERA_UNICODE_VERSION;

  constructor(private readonly baseProvider: IUnicodeVersionProvider) {}

  wcwidth(codepoint: number): 0 | 1 | 2 {
    return this.baseProvider.wcwidth(codepoint);
  }

  charProperties(codepoint: number, preceding: number): number {
    const precedingWidth = extractWidth(preceding);
    const precedingKind = extractCharKind(preceding);

    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return createProperties(ZERO_WIDTH_JOINER, precedingWidth, true);
    }

    if (
      precedingKind === ZERO_WIDTH_JOINER
      && precedingWidth > 0
      && this.wcwidth(codepoint) > 0
    ) {
      return createProperties(codepoint, precedingWidth, true);
    }

    return this.baseProvider.charProperties(codepoint, preceding);
  }
}

export function activateTesseraTerminalUnicodeProvider(
  terminal: XtermTerminalWithUnicodeCore,
): void {
  const { unicode } = terminal;
  if (unicode.activeVersion === TESSERA_UNICODE_VERSION) return;

  const baseProvider = terminal._core?.unicodeService?._providers?.[UNICODE11_VERSION];
  if (!baseProvider) {
    unicode.activeVersion = UNICODE11_VERSION;
    return;
  }

  if (!unicode.versions.includes(TESSERA_UNICODE_VERSION)) {
    unicode.register(new TesseraUnicodeProvider(baseProvider));
  }
  unicode.activeVersion = TESSERA_UNICODE_VERSION;
}
