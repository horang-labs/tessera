"use client";

/* eslint-disable @next/next/no-img-element -- Authenticated, session-scoped image routes cannot use Next's unauthenticated optimizer. */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Copy, ImageIcon, LoaderCircle, RefreshCw } from "lucide-react";
import { ImageLightbox } from "@/components/chat/image-lightbox";
import { setPathInsertDragData } from "@/lib/dnd/panel-session-drag";
import type { PublicImageGenerationTrace } from "@/lib/image-generation/traces";
import { useI18n } from "@/lib/i18n";
import { telemetryClickAttributes } from "@/lib/telemetry/ui-click";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/notification-store";

const REFRESH_INTERVAL_MS = 2_000;

interface LightboxImage {
  src: string;
  alt: string;
}

export function ImageGenerationsPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [traces, setTraces] = useState<PublicImageGenerationTrace[]>([]);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [error, setError] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const requestInFlightRef = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!sessionId) {
      setTraces([]);
      setLoading(false);
      return;
    }
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/image-generations`, {
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { traces?: PublicImageGenerationTrace[] };
      const nextTraces = Array.isArray(body.traces) ? body.traces : [];
      setTraces((current) => (
        JSON.stringify(current) === JSON.stringify(nextTraces) ? current : nextTraces
      ));
      setError(false);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") setError(true);
    } finally {
      requestInFlightRef.current = false;
      if (!signal?.aborted) setLoading(false);
    }
  }, [sessionId]);

  useEffect(function loadImageGenerationTraces() {
    const controller = new AbortController();
    setLoading(Boolean(sessionId));
    void load(controller.signal);
    return () => controller.abort();
  }, [load, sessionId]);

  useEffect(function refreshImageGenerationTracesWhileOpen() {
    if (!sessionId) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [load, sessionId]);

  if (!sessionId) return <EmptyState text={t("imagePanel.selectSession")} />;
  if (loading) return <EmptyState loading text={t("imagePanel.loading")} />;
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center text-xs text-(--text-muted)">
        <AlertTriangle className="h-5 w-5" />
        <p>{t("imagePanel.loadFailed")}</p>
        <button {...telemetryClickAttributes("image_generation.retry", "right_panel")} type="button" onClick={() => void load()} className="flex items-center gap-1 rounded border px-2 py-1 text-(--text-primary)">
          <RefreshCw className="h-3 w-3" /> {t("imagePanel.retry")}
        </button>
      </div>
    );
  }
  if (traces.length === 0) return <EmptyState text={t("imagePanel.empty")} />;

  return (
    <>
      <div className="h-full overflow-y-auto p-2" data-testid="image-generations-panel">
        <div className="flex flex-col gap-2">
          {[...traces].reverse().map((trace) => (
            <ImageGenerationTraceCard key={trace.id} trace={trace} onOpenImage={setLightboxImage} />
          ))}
        </div>
      </div>
      {lightboxImage ? (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      ) : null}
    </>
  );
}

export function ImageGenerationTraceCard({
  trace,
  onOpenImage,
}: {
  trace: PublicImageGenerationTrace;
  onOpenImage: (image: LightboxImage) => void;
}) {
  const { t } = useI18n();
  const [readyResultUrl, setReadyResultUrl] = useState<string | null>(null);
  const resultReady = !trace.result || readyResultUrl === trace.result.url;
  const presentationStatus = trace.result && !resultReady ? "running" : trace.status;
  const revisedPrompt = resultReady ? trace.revisedPrompt : undefined;
  return (
    <article className="overflow-hidden rounded-xl border border-(--chat-header-border) bg-(--background) shadow-sm">
      <section className="relative bg-(--sidebar-hover)" data-testid="image-generation-hero">
        <ResultHeroMedia
          key={trace.result?.url ?? "pending"}
          result={trace.result}
          status={trace.status}
          onOpenImage={onOpenImage}
          onReady={() => setReadyResultUrl(trace.result?.url ?? null)}
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/65 to-transparent px-3 pb-6 pt-2.5 text-white">
          <span className="text-[10px] font-medium tracking-wide text-white/80">{t("imagePanel.generation")}</span>
          <span className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] backdrop-blur-sm",
            presentationStatus === "completed" && "border-emerald-300/25 bg-emerald-950/55 text-emerald-200",
            presentationStatus === "running" && "border-amber-300/25 bg-amber-950/55 text-amber-200",
            presentationStatus === "error" && "border-red-300/25 bg-red-950/55 text-red-200",
          )}>{t(`imagePanel.status.${presentationStatus}`)}</span>
        </div>
      </section>

      <div className="space-y-4 p-3">
        {trace.inputs.length > 0 || trace.unresolvedInputCount > 0 ? (
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-(--text-muted)">{t("imagePanel.inputs")}</p>
              <span className="text-[10px] tabular-nums text-(--text-muted)">{trace.inputs.length}</span>
            </div>
            {trace.inputs.length > 0 ? (
              <div className="grid grid-cols-3 gap-2">
                {trace.inputs.map((input, index) => (
                  <button
                    {...telemetryClickAttributes("image_generation.input.open", "right_panel")}
                    key={`${input.url}-${index}`}
                    type="button"
                    className="group relative block w-full overflow-hidden rounded-md border border-(--chat-header-border) bg-(--sidebar-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
                    onClick={() => onOpenImage({ src: input.url, alt: t("imagePanel.inputNumber", { number: index + 1 }) })}
                    aria-label={t("imagePanel.openInput", { number: index + 1 })}
                  >
                    <img src={input.url} alt="" loading="lazy" className="aspect-square w-full object-cover transition-transform duration-150 group-hover:scale-[1.04]" />
                    <span className="pointer-events-none absolute left-1.5 top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/65 px-1 text-[9px] font-semibold text-white shadow-sm backdrop-blur-sm">
                      {index + 1}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {trace.numLastImagesToInclude !== undefined ? (
              <p className="text-[10px] text-(--text-muted)">
                {t("imagePanel.recentImagesCount", {
                  requested: trace.numLastImagesToInclude,
                  actual: trace.inputs.length,
                })}
              </p>
            ) : null}
            {trace.unresolvedInputCount > 0 ? (
              <p className="flex items-center gap-1 text-[10px] text-amber-600"><AlertTriangle className="h-3 w-3" />{t("imagePanel.unresolved", { count: trace.unresolvedInputCount })}</p>
            ) : null}
          </section>
        ) : null}

        <section>
          <PromptDetails
            title={revisedPrompt ? t("imagePanel.revised") : t("imagePanel.prompt")}
            text={revisedPrompt ?? trace.prompt}
            codexText={revisedPrompt ? trace.prompt : undefined}
          />
        </section>
      </div>
      {trace.error ? <p className="border-t border-(--chat-header-border) px-3 py-2 text-[10px] text-red-600">{trace.error}</p> : null}
    </article>
  );
}

function ResultHeroMedia({
  result,
  status,
  onOpenImage,
  onReady,
}: {
  result: PublicImageGenerationTrace["result"];
  status: PublicImageGenerationTrace["status"];
  onOpenImage: (image: LightboxImage) => void;
  onReady: () => void;
}) {
  const { t } = useI18n();
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const ready = dimensions !== null;
  return (
    <div
      className="relative w-full overflow-hidden transition-[aspect-ratio] duration-300 ease-out"
      style={{ aspectRatio: dimensions ? `${dimensions.width} / ${dimensions.height}` : "4 / 3" }}
    >
      {result ? (
        <button
          {...telemetryClickAttributes("image_generation.result.open", "right_panel")}
          type="button"
          draggable={Boolean(result.path)}
          className="group absolute inset-0 block h-full w-full overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--accent)"
          onDragStart={(event) => {
            if (!result.path || !setPathInsertDragData(event.dataTransfer, [result.path])) {
              event.preventDefault();
            }
          }}
          onClick={() => onOpenImage({ src: result.url, alt: t("imagePanel.result") })}
          aria-label={t("imagePanel.openResult")}
        >
          <img
            src={result.url}
            alt=""
            loading="eager"
            onLoad={(event) => {
              const image = event.currentTarget;
              setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
              onReady();
            }}
            className={cn(
              "h-full w-full object-contain transition-[opacity,transform] duration-300",
              ready ? "opacity-100 group-hover:scale-[1.015]" : "opacity-0",
            )}
          />
        </button>
      ) : null}
      {!ready ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-(--text-muted)">
          {status === "running" || result ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <ImageIcon className="h-5 w-5" />}
        </div>
      ) : null}
    </div>
  );
}

function PromptDetails({ title, text, codexText }: { title: string; text: string; codexText?: string }) {
  const { t } = useI18n();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [codexExpanded, setCodexExpanded] = useState(false);

  const togglePrompt = () => setPromptExpanded((current) => !current);
  const handlePromptClick = () => {
    if (window.getSelection()?.isCollapsed === false) return;
    togglePrompt();
  };
  const handleCopyPrompt = async () => {
    try {
      await copyPromptText(text);
      toast.success(t("imagePanel.promptCopied"));
    } catch {
      toast.error(t("imagePanel.copyPromptFailed"));
    }
  };

  return (
    <div>
      <div
        {...telemetryClickAttributes("image_generation.prompt.toggle", "right_panel")}
        key={title}
        role="button"
        tabIndex={0}
        className="-m-1 block w-[calc(100%+0.5rem)] animate-fade-in cursor-text rounded-md p-1 text-left transition-colors hover:bg-(--sidebar-hover)"
        onClick={handlePromptClick}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          togglePrompt();
        }}
        aria-expanded={promptExpanded}
      >
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-(--text-muted)">{title}</span>
        <span className={cn(
          "mt-1.5 block select-text whitespace-pre-wrap text-xs leading-relaxed text-(--text-primary)",
          !promptExpanded && "line-clamp-5",
        )} data-testid="image-generation-prompt-text">{text}</span>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-x-3 gap-y-1">
        <button
          {...telemetryClickAttributes("image_generation.prompt.copy", "right_panel")}
          type="button"
          className="flex items-center gap-1 text-[10px] text-(--text-muted) hover:text-(--text-primary)"
          onClick={() => void handleCopyPrompt()}
          aria-label={t("imagePanel.copyPrompt")}
        >
          <Copy className="h-3 w-3" />
          {t("imagePanel.copyPrompt")}
        </button>
        <button
          {...telemetryClickAttributes("image_generation.prompt.toggle", "right_panel")}
          type="button"
          className="flex items-center gap-0.5 text-[10px] text-(--accent) hover:underline"
          onClick={togglePrompt}
          aria-expanded={promptExpanded}
        >
          {promptExpanded ? t("imagePanel.showLess") : t("imagePanel.showMore")}
          {promptExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        {codexText ? (
          <button
            {...telemetryClickAttributes("image_generation.codex_prompt.toggle", "right_panel")}
            type="button"
            className="flex items-center gap-0.5 text-[10px] text-(--text-muted) hover:text-(--text-primary)"
            onClick={() => setCodexExpanded((current) => !current)}
            aria-expanded={codexExpanded}
          >
            {codexExpanded ? t("imagePanel.hideCodexPrompt") : t("imagePanel.showCodexPrompt")}
            {codexExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        ) : null}
      </div>
      {codexExpanded && codexText ? (
        <div className="mt-2.5 rounded-md bg-(--sidebar-hover) px-2.5 py-2">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-(--text-muted)">{t("imagePanel.codexPrompt")}</p>
          <p className="select-text whitespace-pre-wrap text-[11px] leading-relaxed text-(--text-secondary)">{codexText}</p>
        </div>
      ) : null}
    </div>
  );
}

async function copyPromptText(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy failed");
}

function EmptyState({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-(--text-muted)">
      {loading ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <ImageIcon className="h-5 w-5" />}
      <p>{text}</p>
    </div>
  );
}
