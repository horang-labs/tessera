"use client";

/* eslint-disable @next/next/no-img-element -- Authenticated, session-scoped image routes cannot use Next's unauthenticated optimizer. */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Copy, Download, ImageIcon, LayoutGrid, List, LoaderCircle, RefreshCw, Search, X, ArrowLeft } from "lucide-react";
import { ImageLightbox } from "@/components/chat/image-lightbox";
import { clearPathInsertDragData, setPathInsertDragData } from "@/lib/dnd/panel-session-drag";
import type { PublicImageGenerationTrace } from "@/lib/image-generation/traces";
import { useI18n } from "@/lib/i18n";
import { telemetryClickAttributes } from "@/lib/telemetry/ui-click";
import { captureTelemetryEvent } from "@/lib/telemetry/client";
import { createImageGenerationCardTracker } from "@/lib/image-generation/card-tracker";
import { cn } from "@/lib/utils";
import { readUiStorageItem, writeUiStorageItem } from "@/lib/persistence/ui-storage";
import { toast } from "@/stores/notification-store";

const REFRESH_INTERVAL_MS = 2_000;
// Small URL/metadata-only cache; persistence and authoritative state live on the server.
const panelCache = new Map<string, PublicImageGenerationTrace[]>();

interface LightboxImage {
  src: string;
  alt: string;
}

export function ImageGenerationsPanel({ sessionId, isActive = true }: { sessionId: string | null; isActive?: boolean }) {
  const { t } = useI18n();
  const [traces, setTraces] = useState<PublicImageGenerationTrace[]>(() => sessionId ? panelCache.get(sessionId) ?? [] : []);
  const [loading, setLoading] = useState(Boolean(sessionId && !panelCache.has(sessionId)));
  const [error, setError] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const [retry, setRetry] = useState(0);
  // Establish a fresh baseline for each session; initial transcript hydration
  // must not count historical cards as new image-generation activity.
  const cardTrackerRef = useRef<{
    sessionId: string;
    observe: ReturnType<typeof createImageGenerationCardTracker>;
  } | null>(null);

  const load = useCallback(async (signal: AbortSignal, sync: boolean) => {
    if (!sessionId) {
      setTraces([]);
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/image-generations${sync ? '?sync=1' : ''}`, {
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { traces?: PublicImageGenerationTrace[]; more?: boolean };
      if (signal.aborted) return;
      const nextTraces = Array.isArray(body.traces) ? body.traces : [];
      if (cardTrackerRef.current?.sessionId !== sessionId) {
        cardTrackerRef.current = { sessionId, observe: createImageGenerationCardTracker() };
      }
      const newCardCount = cardTrackerRef.current.observe(nextTraces, sync && !body.more);
      for (let index = 0; index < newCardCount; index += 1) {
        void captureTelemetryEvent('image_generation_card_created', {
          surface: 'right_panel',
          tab: 'images',
        });
      }
      panelCache.delete(sessionId);
      panelCache.set(sessionId, nextTraces);
      while (panelCache.size > 8) panelCache.delete(panelCache.keys().next().value!);
      setTraces((current) => (
        JSON.stringify(current) === JSON.stringify(nextTraces) ? current : nextTraces
      ));
      setError(false);
      if (nextTraces.length || (sync && !body.more)) setLoading(false);
      return Boolean(body.more);
    } catch (loadError) {
      if (!signal.aborted && (loadError as Error).name !== "AbortError") {
        setError(true);
        setLoading(false);
      }
    }
  }, [sessionId]);

  useEffect(function synchronizeActiveImageTab() {
    if (!isActive || !sessionId) return;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      controller?.abort();
      controller = undefined;
      clearTimeout(timer);
    };
    const resume = () => {
      if (document.visibilityState !== "visible") {
        stop();
        return;
      }
      if (controller) return;
      const activeController = new AbortController();
      controller = activeController;
      const refresh = async () => {
        if (activeController.signal.aborted) return;
        const more = await load(activeController.signal, true);
        if (!activeController.signal.aborted) {
          timer = setTimeout(() => void refresh(), more ? 0 : REFRESH_INTERVAL_MS);
        }
      };
      void (async () => {
        // Never wait for transcript I/O to show saved cards.
        await load(activeController.signal, false);
        await refresh();
      })();
    };
    resume();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      stop();
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [isActive, load, retry, sessionId]);

  if (!sessionId) return <EmptyState text={t("imagePanel.selectSession")} />;
  if (loading) return <EmptyState loading text={t("imagePanel.loading")} />;
  if (error && traces.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center text-xs text-(--text-muted)">
        <AlertTriangle className="h-5 w-5" />
        <p>{t("imagePanel.loadFailed")}</p>
        <button {...telemetryClickAttributes("image_generation.retry", "right_panel")} type="button" onClick={() => setRetry((value) => value + 1)} className="flex items-center gap-1 rounded border px-2 py-1 text-(--text-primary)">
          <RefreshCw className="h-3 w-3" /> {t("imagePanel.retry")}
        </button>
      </div>
    );
  }
  if (traces.length === 0) return <EmptyState text={t("imagePanel.empty")} />;

  return (
    <>
      <ImageGenerationGallery key={sessionId} traces={traces} onOpenImage={setLightboxImage} />
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

type GalleryView = "cards" | "list";
type ThumbnailSize = "small" | "medium" | "large";
const VIEW_STORAGE_KEY = "tessera.image-gallery.view.v1";
const SIZE_STORAGE_KEY = "tessera.image-gallery.size.v1";
const THUMBNAIL_WIDTHS: Record<ThumbnailSize, number> = { small: 104, medium: 132, large: 208 };

function ImageGenerationGallery({ traces, onOpenImage }: {
  traces: PublicImageGenerationTrace[];
  onOpenImage: (image: LightboxImage) => void;
}) {
  const { t, language } = useI18n();
  const [view, setView] = useState<GalleryView>(() => readUiStorageItem(VIEW_STORAGE_KEY) === "list" ? "list" : "cards");
  const [size, setSize] = useState<ThumbnailSize>(() => {
    const saved = readUiStorageItem(SIZE_STORAGE_KEY);
    return saved === "small" || saved === "large" ? saved : "medium";
  });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = traces.find((trace) => trace.id === selectedId);
  const search = query.trim().toLocaleLowerCase();
  const visible = [...traces].reverse().filter((trace) => !search ||
    [trace.prompt, trace.revisedPrompt, trace.result?.path, trace.result?.label].some((text) => text?.toLocaleLowerCase().includes(search)));
  const dateFormatter = new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const controlClass = "rounded-md p-1.5 text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-(--accent)";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="image-generations-panel">
      <div className="shrink-0 space-y-2 border-b border-(--chat-header-border) p-2">
        {selected ? (
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" className={controlClass} onClick={() => setSelectedId(null)} aria-label={t("imagePanel.backToGallery")} title={t("imagePanel.backToGallery")}>
              <ArrowLeft className="h-4 w-4" />
            </button>
            <span className="truncate text-xs text-(--text-primary)">{galleryImageTitle(selected)}</span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] tabular-nums text-(--text-muted)">{t("imagePanel.imageCount", { count: visible.length, total: traces.length })}</span>
              <div className="flex items-center gap-1">
                {view === "cards" ? (
                  <select aria-label={t("imagePanel.thumbnailSize")} className="max-w-28 rounded-md border border-(--chat-header-border) bg-(--background) px-1 py-1 text-[11px] text-(--text-primary)" value={size} onChange={(event) => {
                    const next = event.target.value as ThumbnailSize;
                    setSize(next);
                    writeUiStorageItem(SIZE_STORAGE_KEY, next);
                  }}>
                    <option value="small">{t("imagePanel.sizeSmall")}</option>
                    <option value="medium">{t("imagePanel.sizeMedium")}</option>
                    <option value="large">{t("imagePanel.sizeLarge")}</option>
                  </select>
                ) : null}
                <div role="group" aria-label={t("imagePanel.viewMode")} className="flex rounded-lg border border-(--chat-header-border) p-0.5">
                  {(["cards", "list"] as const).map((mode) => (
                    <button key={mode} type="button" aria-label={t(`imagePanel.${mode}View`)} title={t(`imagePanel.${mode}View`)} aria-pressed={view === mode} className={cn(controlClass, view === mode && "bg-(--sidebar-hover) text-(--accent)")} onClick={() => {
                      setView(mode);
                      writeUiStorageItem(VIEW_STORAGE_KEY, mode);
                    }}>
                      {mode === "cards" ? <LayoutGrid className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 rounded-md border border-(--chat-header-border) bg-(--background) px-2 focus-within:border-(--accent)">
              <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("imagePanel.search")} aria-label={t("imagePanel.search")} className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-(--text-primary) outline-none" />
              {query ? <button type="button" className={controlClass} aria-label={t("imagePanel.clearSearch")} onClick={() => setQuery("")}><X className="h-3 w-3" /></button> : null}
            </div>
          </>
        )}
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto p-2", selected && "hidden")} data-testid="image-gallery" data-view={view}>
        {visible.length === 0 ? <EmptyState text={t("imagePanel.noMatches")} /> : (
          <div className={cn(view === "cards" ? "grid gap-2" : "flex flex-col gap-1")} style={view === "cards" ? { gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${THUMBNAIL_WIDTHS[size]}px), 1fr))` } : undefined}>
            {visible.map((trace) => {
              const date = new Date(trace.timestamp);
              const title = galleryImageTitle(trace);
              return (
                <article key={trace.id} data-testid="image-gallery-item" className={cn("min-w-0 overflow-hidden rounded-lg border border-(--chat-header-border) bg-(--background)", view === "list" && "flex items-center gap-2 p-1.5")}>
                  <div className={cn("relative bg-(--sidebar-hover)", view === "list" && "w-14 shrink-0 overflow-hidden rounded-md")}>
                    <ResultHeroMedia key={trace.result?.url ?? "pending"} result={trace.result} status={trace.status} onOpenImage={onOpenImage} layout="thumbnail" />
                    {view === "cards" && trace.status !== "completed" ? <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{t(`imagePanel.status.${trace.status}`)}</span> : null}
                  </div>
                  <div className={cn("min-w-0", view === "list" && "flex-1")}>
                  <button type="button" onClick={() => setSelectedId(trace.id)} aria-label={t("imagePanel.openDetails", { name: title })} className={cn("min-w-0 text-left hover:bg-(--sidebar-hover) focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--accent)", view === "cards" ? "block w-full p-2" : "block w-full rounded p-1")}>
                    <span className="block truncate text-[11px] font-medium text-(--text-primary)" title={title}>{title}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-(--text-muted)" title={trace.revisedPrompt ?? trace.prompt}>{trace.revisedPrompt ?? trace.prompt}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-[9px] text-(--text-muted)">
                      <span className={cn(trace.status === "running" && "text-amber-600", trace.status === "error" && "text-red-600")}>{t(`imagePanel.status.${trace.status}`)}</span>
                      {!Number.isNaN(date.getTime()) ? <time dateTime={trace.timestamp} className="truncate">{dateFormatter.format(date)}</time> : null}
                    </span>
                  </button>
                  {trace.inputs.length > 0 ? <GalleryInputStrip inputs={trace.inputs} className={view === "cards" ? "px-2 pb-2" : "px-1 pb-0.5"} onOpenImage={onOpenImage} /> : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      {selected ? <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="image-gallery-details"><ImageGenerationTraceCard key={selected.id} trace={selected} onOpenImage={onOpenImage} /></div> : null}
    </div>
  );
}

function GalleryInputStrip({ inputs, className, onOpenImage }: {
  inputs: PublicImageGenerationTrace["inputs"];
  className?: string;
  onOpenImage: (image: LightboxImage) => void;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("flex min-w-0 items-center gap-1 overflow-x-auto", className)} data-testid="image-gallery-inputs" aria-label={t("imagePanel.inputs")}>
      {inputs.map((input, index) => (
        <button
          {...telemetryClickAttributes("image_generation.input.open", "right_panel")}
          key={`${input.url}-${index}`}
          type="button"
          draggable={Boolean(input.path)}
          className="relative h-7 w-7 shrink-0 overflow-hidden rounded border border-(--chat-header-border) bg-(--sidebar-hover) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent)"
          onDragStart={(event) => {
            if (!input.path || !setPathInsertDragData(event.dataTransfer, [input.path])) {
              event.preventDefault();
            }
          }}
          onDragEnd={clearPathInsertDragData}
          onClick={() => onOpenImage({ src: input.url, alt: t("imagePanel.inputNumber", { number: index + 1 }) })}
          aria-label={t("imagePanel.openInput", { number: index + 1 })}
          title={t("imagePanel.inputNumber", { number: index + 1 })}
        >
          <img src={input.url} draggable={false} alt="" loading="lazy" className="h-full w-full object-cover" />
        </button>
      ))}
    </div>
  );
}

function galleryImageTitle(trace: PublicImageGenerationTrace): string {
  return trace.result?.path?.split(/[\\/]/).at(-1)?.trim() || trace.result?.label || trace.prompt.trim().split(/\r?\n/)[0] || trace.id;
}

export function ImageGenerationTraceCard({
  trace,
  onOpenImage,
}: {
  trace: PublicImageGenerationTrace;
  onOpenImage: (image: LightboxImage) => void;
}) {
  const { t } = useI18n();
  // Loading the thumbnail is independent from the generation lifecycle. A
  // missing overlay file used to turn a completed generation back into a
  // permanent "Running" card because the image's onLoad never fired.
  const presentationStatus = trace.status;
  const revisedPrompt = trace.revisedPrompt;
  return (
    <article className="overflow-hidden rounded-xl border border-(--chat-header-border) bg-(--background) shadow-sm">
      <section className="relative bg-(--sidebar-hover)" data-testid="image-generation-hero">
        <ResultHeroMedia
          key={trace.result?.url ?? "pending"}
          result={trace.result}
          status={trace.status}
          onOpenImage={onOpenImage}
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
        {trace.inputs.length > 0 || trace.unresolvedInputCount > 0 || trace.inputResolutionError ? (
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-(--text-muted)">{t("imagePanel.inputs")}</p>
              <span className="text-[10px] tabular-nums text-(--text-muted)">{trace.inputs.length}</span>
            </div>
            {trace.inputs.length > 0 ? (
              <div className="grid grid-cols-3 gap-2">
                {trace.inputs.map((input, index) => (
                  <div key={`${input.url}-${index}`} className="group relative">
                    <button
                      {...telemetryClickAttributes("image_generation.input.open", "right_panel")}
                      type="button"
                      draggable={Boolean(input.path)}
                      className="relative block w-full overflow-hidden rounded-md border border-(--chat-header-border) bg-(--sidebar-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
                      onDragStart={(event) => {
                        if (!input.path || !setPathInsertDragData(event.dataTransfer, [input.path])) {
                          event.preventDefault();
                        }
                      }}
                      onDragEnd={clearPathInsertDragData}
                      onClick={() => onOpenImage({ src: input.url, alt: t("imagePanel.inputNumber", { number: index + 1 }) })}
                      aria-label={t("imagePanel.openInput", { number: index + 1 })}
                    >
                      <img src={input.url} draggable={false} alt="" loading="lazy" className="aspect-square w-full object-cover transition-transform duration-150 group-hover:scale-[1.04]" />
                      <span className="pointer-events-none absolute left-1.5 top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/65 px-1 text-[9px] font-semibold text-white shadow-sm backdrop-blur-sm">
                        {index + 1}
                      </span>
                    </button>
                    <ImageDownloadButton
                      url={input.url}
                      path={input.path}
                      fallbackName={`input-image-${index + 1}.png`}
                      label={t("imagePanel.downloadInput", { number: index + 1 })}
                      action="image_generation.input.download"
                    />
                  </div>
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
            {trace.inputResolutionError ? (
              <p className="flex items-start gap-1 text-[10px] text-amber-600">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{trace.inputResolutionError === "Input references could not be reconstructed from this recording."
                  ? t("imagePanel.inputResolutionFailed") : trace.inputResolutionError}</span>
              </p>
            ) : trace.unresolvedInputCount > 0 ? (
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
  layout = "detail",
}: {
  layout?: "detail" | "thumbnail";
  result: PublicImageGenerationTrace["result"];
  status: PublicImageGenerationTrace["status"];
  onOpenImage: (image: LightboxImage) => void;
}) {
  const { t } = useI18n();
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const ready = dimensions !== null;
  return (
    <div
      className="group relative w-full overflow-hidden transition-[aspect-ratio] duration-300 ease-out"
      style={{ aspectRatio: layout === "thumbnail" ? "1" : dimensions ? `${dimensions.width} / ${dimensions.height}` : "4 / 3" }}
    >
      {result ? (
        <button
          {...telemetryClickAttributes("image_generation.result.open", "right_panel")}
          type="button"
          draggable={Boolean(result.path)}
          className="absolute inset-0 block h-full w-full overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--accent)"
          onDragStart={(event) => {
            if (!result.path || !setPathInsertDragData(event.dataTransfer, [result.path])) {
              event.preventDefault();
            }
          }}
          onDragEnd={clearPathInsertDragData}
          onClick={() => onOpenImage({ src: result.url, alt: t("imagePanel.result") })}
          aria-label={t("imagePanel.openResult")}
        >
          <img
            src={result.url}
            draggable={false}
            alt=""
            loading="lazy"
            onLoad={(event) => {
              const image = event.currentTarget;
              setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
            }}
            onError={() => setFailed(true)}
            className={cn(
              "h-full w-full object-contain transition-[opacity,transform] duration-300",
              ready ? "opacity-100 group-hover:scale-[1.015]" : "opacity-0",
            )}
          />
        </button>
      ) : null}
      {result ? (
        <ImageDownloadButton
          url={result.url}
          path={result.path}
          fallbackName="generated-image.png"
          label={t("imagePanel.downloadResult")}
          action="image_generation.result.download"
        />
      ) : null}
      {!ready && !failed ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-(--text-muted)">
          {status === "running" || result ? <LoaderCircle data-testid="image-generation-loading" className="h-5 w-5 animate-spin" /> : <ImageIcon className="h-5 w-5" />}
        </div>
      ) : null}
      {failed ? (
        <div data-testid="image-generation-result-unavailable" className="pointer-events-none absolute inset-0 flex items-center justify-center text-(--text-muted)">
          <ImageIcon className="h-5 w-5" />
        </div>
      ) : null}
    </div>
  );
}

function ImageDownloadButton({
  url,
  path,
  fallbackName,
  label,
  action,
}: {
  url: string;
  path?: string;
  fallbackName: string;
  label: string;
  action: "image_generation.input.download" | "image_generation.result.download";
}) {
  return (
    <a
      {...telemetryClickAttributes(action, "right_panel")}
      href={url}
      download={imageDownloadFileName(path, fallbackName)}
      draggable={false}
      className="pointer-events-none absolute bottom-2 right-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border border-white/20 bg-black/65 text-white opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-black/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      aria-label={label}
      title={label}
      onClick={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Download aria-hidden="true" className="h-3.5 w-3.5" />
    </a>
  );
}

function imageDownloadFileName(path: string | undefined, fallbackName: string): string {
  const fileName = path?.split(/[\\/]/).at(-1)?.trim();
  return fileName || fallbackName;
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
