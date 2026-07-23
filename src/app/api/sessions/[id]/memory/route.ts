import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import { getAgentEnvironment } from "@/lib/cli/spawn-cli";
import * as dbSessions from "@/lib/db/sessions";
import { jsonError } from "@/lib/http/json-error";
import logger from "@/lib/logger";
import {
  listCodexGuidelines,
  listCodexMemoryFiles,
  resolveCodexMemoryContext,
} from "@/lib/memory/codex-memory";
import {
  listOpenCodeGuidelines,
  resolveOpenCodeRulesContext,
} from "@/lib/memory/opencode-memory";
import {
  listGuidelines,
  listMemoryFiles,
  MemoryApiError,
  resolveGuidelineTargets,
  resolveSessionMemoryDir,
} from "@/lib/memory/claude-memory";
import { getMemoryProviderKind } from "@/lib/memory/memory-provider";
import {
  toMemoryDisplayPath,
  toOptionalMemoryDisplayPath,
} from "@/lib/memory/memory-display-path";
import type { MemoryListData } from "@/types/memory";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: "unauthorized", message: "Unauthorized" },
    });
    if ("response" in auth) return auth.response;

    const agentEnvironment = await getAgentEnvironment(auth.userId);
    const session = dbSessions.getSession(id);
    const provider = getMemoryProviderKind(session?.provider);
    if (!provider) {
      return jsonError("unsupported_provider", "Memory is not available for this provider", 400);
    }

    if (provider === "codex") {
      const context = await resolveCodexMemoryContext(id, agentEnvironment);
      if (!context) {
        return jsonError("missing_work_dir", "Session has no working directory", 422);
      }

      const [files, guidelines] = await Promise.all([
        context.exists ? listCodexMemoryFiles(context.memoryDir) : Promise.resolve([]),
        listCodexGuidelines(id, agentEnvironment),
      ]);

      const payload: MemoryListData = {
        sessionId: id,
        provider,
        memoryDir: context.memoryDir,
        memoryDirDisplay: toMemoryDisplayPath(context.memoryDir, agentEnvironment),
        instructionRoots: {
          user: context.codexHome,
          project: context.projectRoot,
        },
        instructionRootsDisplay: {
          user: toMemoryDisplayPath(context.codexHome, agentEnvironment),
          project: toOptionalMemoryDisplayPath(context.projectRoot, agentEnvironment),
        },
        root: "project",
        exists: context.exists,
        files,
        memoryScopeLabel: "User Global Memory",
        memoryScopeDescription: "Codex memories are stored globally under CODEX_HOME, not per project.",
        guidelines,
      };
      return NextResponse.json(payload);
    }

    if (provider === "opencode") {
      const context = await resolveOpenCodeRulesContext(id, agentEnvironment);
      if (!context) {
        return jsonError("missing_work_dir", "Session has no working directory", 422);
      }

      const payload: MemoryListData = {
        sessionId: id,
        provider,
        memoryDir: context.opencodeConfigDir,
        memoryDirDisplay: toMemoryDisplayPath(context.opencodeConfigDir, agentEnvironment),
        instructionRoots: {
          user: context.opencodeConfigDir,
          project: context.projectRoot,
        },
        instructionRootsDisplay: {
          user: toMemoryDisplayPath(context.opencodeConfigDir, agentEnvironment),
          project: toOptionalMemoryDisplayPath(context.projectRoot, agentEnvironment),
        },
        root: "project",
        exists: false,
        files: [],
        memoryScopeLabel: "",
        memoryScopeDescription: "",
        guidelines: await listOpenCodeGuidelines(id, agentEnvironment),
      };
      return NextResponse.json(payload);
    }

    const context = await resolveSessionMemoryDir(id, agentEnvironment);
    if (!context) {
      return jsonError("missing_work_dir", "Session has no working directory", 422);
    }

    const [files, guidelines] = await Promise.all([
      context.exists ? listMemoryFiles(context.memoryDir) : Promise.resolve([]),
      listGuidelines(id, agentEnvironment),
    ]);
    const guidelineTargets = await resolveGuidelineTargets(id, agentEnvironment);
    const userInstructionRoot = guidelineTargets.find((target) => target.kind === "global-guideline")?.dir ?? "";
    const projectInstructionRoot = guidelineTargets.find((target) => target.kind === "project-guideline")?.dir ?? null;

    const payload: MemoryListData = {
      sessionId: id,
      provider,
      memoryDir: context.memoryDir,
      memoryDirDisplay: toMemoryDisplayPath(context.memoryDir, agentEnvironment),
      instructionRoots: {
        user: userInstructionRoot,
        project: projectInstructionRoot,
      },
      instructionRootsDisplay: {
        user: toMemoryDisplayPath(userInstructionRoot, agentEnvironment),
        project: toOptionalMemoryDisplayPath(projectInstructionRoot, agentEnvironment),
      },
      root: context.root,
      exists: context.exists,
      files,
      memoryScopeLabel: "Project Memory",
      memoryScopeDescription: "Applies only to this Claude Code workspace memory.",
      guidelines,
    };
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof MemoryApiError) {
      return jsonError(error.code, error.message, error.status);
    }

    logger.error({ error, sessionId: id }, "Failed to list memory files");
    return jsonError("internal_error", "Failed to list memory files", 500);
  }
}
