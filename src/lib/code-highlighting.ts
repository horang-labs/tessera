import type { Highlighter, ThemedToken } from "shiki";

const SHIKI_THEMES = ["github-dark", "github-light"] as const;

const SHIKI_LANGS = [
  "bash",
  "c",
  "cpp",
  "css",
  "dockerfile",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "makefile",
  "markdown",
  "python",
  "rust",
  "shell",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;

export type ShikiTheme = (typeof SHIKI_THEMES)[number];
type ShikiLanguage = (typeof SHIKI_LANGS)[number] | "text";

const SHIKI_LANG_SET: ReadonlySet<string> = new Set([...SHIKI_LANGS, "text"]);

let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter | null> | null = null;

export async function getHighlighterInstance(): Promise<Highlighter | null> {
  if (highlighterInstance) {
    return highlighterInstance;
  }

  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const shiki = await import("shiki");
        const highlighter = await shiki.createHighlighter({
          themes: [...SHIKI_THEMES],
          langs: [...SHIKI_LANGS],
        });
        highlighterInstance = highlighter;
        return highlighter;
      } catch {
        // Shiki dynamic import can fail in custom server dev mode (webpack chunk issue).
        // Callers should fall back to plain text rendering.
        highlighterPromise = null;
        return null;
      }
    })();
  }

  return highlighterPromise;
}

export function normalizeShikiLanguage(language: string | null | undefined): ShikiLanguage {
  const normalizedLang = (language ?? "").trim().toLowerCase();

  if (normalizedLang === "c++") return "cpp";
  if (normalizedLang === "docker") return "dockerfile";
  if (normalizedLang === "dockerfile") return "dockerfile";
  if (normalizedLang === "h") return "c";
  if (normalizedLang === "hpp") return "cpp";
  if (normalizedLang === "js") return "javascript";
  if (normalizedLang === "md") return "markdown";
  if (normalizedLang === "py") return "python";
  if (normalizedLang === "sh") return "bash";
  if (normalizedLang === "ts") return "typescript";
  if (normalizedLang === "yml") return "yaml";

  if (!normalizedLang) return "text";
  return SHIKI_LANG_SET.has(normalizedLang) ? (normalizedLang as ShikiLanguage) : "text";
}

export function highlightCodeToHtml(
  highlighter: Highlighter,
  code: string,
  language: string | null | undefined,
  theme: ShikiTheme,
): string {
  try {
    return highlighter.codeToHtml(code, {
      lang: normalizeShikiLanguage(language),
      theme,
    });
  } catch {
    return highlighter.codeToHtml(code, {
      lang: "text",
      theme,
    });
  }
}

export function highlightCodeToTokens(
  highlighter: Highlighter,
  code: string,
  language: string | null | undefined,
  theme: ShikiTheme,
): ThemedToken[][] {
  try {
    return highlighter.codeToTokens(code, {
      lang: normalizeShikiLanguage(language),
      theme,
    }).tokens;
  } catch {
    return highlighter.codeToTokens(code, {
      lang: "text",
      theme,
    }).tokens;
  }
}
