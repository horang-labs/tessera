"use client";

import { useState } from "react";
import { ImageGenerationTraceCard } from "@/components/image-generation/image-generations-panel";
import type { PublicImageGenerationTrace } from "@/lib/image-generation/traces";

const RUNNING_TRACE: PublicImageGenerationTrace = {
  id: "transition-fixture",
  invocationMessageId: "transition-fixture-message",
  prompt: "Original Codex prompt ".repeat(12),
  inputs: [],
  unresolvedInputCount: 0,
  status: "running",
  timestamp: "2026-08-28T00:00:00.000Z",
};

export default function ImageTransitionReproPage() {
  const [completed, setCompleted] = useState(false);
  const [broken, setBroken] = useState(false);
  const trace: PublicImageGenerationTrace = completed ? {
    ...RUNNING_TRACE,
    status: "completed",
    revisedPrompt: "Revised image prompt ".repeat(12),
    result: {
      source: "generated",
      label: "Generated image",
      url: broken ? "/dev-image-transition-image-missing" : "/dev-image-transition-image",
    },
  } : RUNNING_TRACE;

  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-white">
      <button data-testid="complete" type="button" onClick={() => setCompleted(true)}>Complete</button>
      <button data-testid="complete-with-missing-image" type="button" onClick={() => {
        setBroken(true);
        setCompleted(true);
      }}>Complete with missing image</button>
      <div className="mt-4 w-[420px]">
        <ImageGenerationTraceCard trace={trace} onOpenImage={() => {}} />
      </div>
    </main>
  );
}
