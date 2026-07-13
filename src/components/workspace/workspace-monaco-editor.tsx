"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIsDark } from "@/hooks/use-is-dark";
import { cn } from "@/lib/utils";

interface WorkspaceMonacoEditorProps {
  className?: string;
  content: string;
  language?: string | null;
  mode: "file" | "diff";
  path: string;
  readOnly?: boolean;
  /**
   * Fired with the full editor value on user edits. When provided, keep the
   * `content` prop in sync with the latest emitted value (or leave it at the
   * loaded original): passing a different string resets the editor content.
   */
  onChange?: (value: string) => void;
}

type MonacoApi = typeof import("monaco-editor");
type MonacoEditor = import("monaco-editor").editor.IStandaloneCodeEditor;
type MonacoModel = import("monaco-editor").editor.ITextModel;

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "shell",
  cjs: "javascript",
  h: "c",
  hpp: "cpp",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  sh: "shell",
  makefile: "plaintext",
  text: "plaintext",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  yml: "yaml",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "shell",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  css: "css",
  dockerfile: "dockerfile",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  makefile: "plaintext",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  sh: "shell",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  yaml: "yaml",
  yml: "yaml",
};

const SUPPORTED_MONACO_LANGUAGES = new Set([
  "c",
  "cpp",
  "css",
  "dockerfile",
  "git-diff",
  "go",
  "html",
  "javascript",
  "json",
  "markdown",
  "plaintext",
  "python",
  "rust",
  "shell",
  "sql",
  "typescript",
  "yaml",
]);

let monacoExtensionsRegistered = false;
let monacoEnvironmentConfigured = false;

function extensionFromPath(filePath: string): string {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex + 1) : "";
}

function normalizeMonacoLanguage(mode: "file" | "diff", language: string | null | undefined, filePath: string): string {
  if (mode === "diff") return "git-diff";

  const normalized = (language ?? "").trim().toLowerCase();
  const fromLanguage = LANGUAGE_ALIASES[normalized] ?? normalized;
  if (SUPPORTED_MONACO_LANGUAGES.has(fromLanguage)) return fromLanguage;

  const ext = extensionFromPath(filePath);
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

function buildModelUri(monaco: MonacoApi, mode: "file" | "diff", filePath: string) {
  const encodedPath = filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return monaco.Uri.parse(`inmemory://workspace/${mode}/${encodedPath || "untitled"}`);
}

function registerMonacoExtensions(monaco: MonacoApi): void {
  if (monacoExtensionsRegistered) return;
  monacoExtensionsRegistered = true;

  monaco.languages.register({ id: "git-diff" });
  monaco.languages.setMonarchTokensProvider("git-diff", {
    tokenizer: {
      root: [
        [/^diff --git.*$/, "diff.header"],
        [/^index .*$/, "diff.header"],
        [/^@@.*@@.*$/, "diff.hunk"],
        [/^\+\+\+.*$/, "diff.meta"],
        [/^---.*$/, "diff.meta"],
        [/^\+.*/, "diff.inserted"],
        [/^-.*/, "diff.deleted"],
      ],
    },
  });

  monaco.editor.defineTheme("tessera-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "diff.header", foreground: "1a1a1a", fontStyle: "bold" },
      { token: "diff.hunk", foreground: "4a8cd6" },
      { token: "diff.meta", foreground: "9b7f35" },
      { token: "diff.inserted", foreground: "2f8753" },
      { token: "diff.deleted", foreground: "c94c4c" },
    ],
    colors: {
      "editor.background": "#fafaf9",
    },
  });

  monaco.editor.defineTheme("tessera-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "diff.header", foreground: "d7dde3", fontStyle: "bold" },
      { token: "diff.hunk", foreground: "79aee8" },
      { token: "diff.meta", foreground: "c2a15a" },
      { token: "diff.inserted", foreground: "66c98b" },
      { token: "diff.deleted", foreground: "e27777" },
    ],
    colors: {
      "editor.background": "#17191c",
    },
  });
}

function configureMonacoEnvironment(): void {
  if (monacoEnvironmentConfigured || typeof window === "undefined") return;
  monacoEnvironmentConfigured = true;

  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === "json") {
        return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url));
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url));
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url));
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url));
      }
      return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url));
    },
  };
}

export function WorkspaceMonacoEditor({
  className,
  content,
  language,
  mode,
  path,
  readOnly = true,
  onChange,
}: WorkspaceMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const modelRef = useRef<MonacoModel | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const latestPropsRef = useRef({ content, language, mode, path, readOnly, onChange });
  const latestThemeRef = useRef("tessera-light");
  // Last value emitted through onChange. The sync effect below runs with a
  // possibly stale `content` prop while the user keeps typing; skipping
  // self-originated values prevents it from reverting those keystrokes.
  const lastEmittedValueRef = useRef<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isDark = useIsDark();
  const monacoLanguage = useMemo(
    () => normalizeMonacoLanguage(mode, language, path),
    [language, mode, path],
  );
  const theme = isDark ? "tessera-dark" : "tessera-light";

  useEffect(() => {
    latestPropsRef.current = { content, language, mode, path, readOnly, onChange };
  }, [content, language, mode, path, readOnly, onChange]);

  useEffect(() => {
    latestThemeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    configureMonacoEnvironment();
    import("monaco-editor")
      .then((monaco) => {
        if (cancelled || !containerRef.current) return;

        registerMonacoExtensions(monaco);
        const latest = latestPropsRef.current;
        const initialLanguage = normalizeMonacoLanguage(latest.mode, latest.language, latest.path);
        const model = monaco.editor.createModel(
          latest.content,
          initialLanguage,
          buildModelUri(monaco, latest.mode, latest.path),
        );
        const editor = monaco.editor.create(containerRef.current, {
          automaticLayout: true,
          contextmenu: true,
          cursorBlinking: "smooth",
          domReadOnly: latest.readOnly,
          fixedOverflowWidgets: true,
          fontFamily: "'JetBrains Mono', 'Fira Code', Monaco, Consolas, monospace",
          fontSize: 13,
          largeFileOptimizations: true,
          lineHeight: 20,
          lineNumbers: "on",
          minimap: { enabled: false },
          model,
          overviewRulerBorder: false,
          readOnly: latest.readOnly,
          renderFinalNewline: "off",
          renderLineHighlight: "line",
          renderWhitespace: "selection",
          scrollBeyondLastLine: false,
          smoothScrolling: false,
          stickyScroll: { enabled: false },
          theme: latestThemeRef.current,
          wordWrap: "off",
        });

        // Editor-level listener survives model swaps; it fires for
        // programmatic setValue too, so consumers must compare values.
        editor.onDidChangeModelContent(() => {
          const value = editor.getValue();
          lastEmittedValueRef.current = value;
          latestPropsRef.current.onChange?.(value);
        });

        monacoRef.current = monaco;
        modelRef.current = model;
        editorRef.current = editor;
        setIsReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Editor failed to load.");
      });

    return () => {
      cancelled = true;
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
      monacoRef.current = null;
    };
  }, []);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;

    const nextUri = buildModelUri(monaco, mode, path);
    const currentModel = modelRef.current;
    const shouldReplaceModel =
      !currentModel
      || currentModel.uri.toString() !== nextUri.toString()
      || currentModel.getLanguageId() !== monacoLanguage;

    if (shouldReplaceModel) {
      const nextModel = monaco.editor.createModel(content, monacoLanguage, nextUri);
      modelRef.current = nextModel;
      lastEmittedValueRef.current = content;
      editor.setModel(nextModel);
      currentModel?.dispose();
      return;
    }

    if (currentModel.getValue() !== content && content !== lastEmittedValueRef.current) {
      currentModel.setValue(content);
    }
  }, [content, mode, monacoLanguage, path]);

  useEffect(() => {
    monacoRef.current?.editor.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      domReadOnly: readOnly,
      readOnly,
    });
  }, [readOnly]);

  return (
    <div className={cn("relative h-full min-h-0 w-full", className)}>
      <div ref={containerRef} className="h-full min-h-0 w-full" />
      {!isReady && !loadError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-(--chat-bg)">
          <LoaderCircle className="h-5 w-5 animate-spin text-(--text-muted)" />
        </div>
      ) : null}
      {loadError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-(--chat-bg) p-6 text-center text-xs text-(--text-muted)">
          {loadError}
        </div>
      ) : null}
    </div>
  );
}
