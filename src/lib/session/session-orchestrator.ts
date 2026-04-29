/**
 * Session Orchestrator
 *
 * High-level server-side session lifecycle coordinator.
 */

import path from 'path';
import { ProcessManager } from '../cli/process-manager';
import * as dbProjects from '../db/projects';
import * as dbSessions from '../db/sessions';
import {
  SessionCreateResult,
  SessionResumeResult,
  SessionCreateOptions,
  SessionResumeOptions,
} from './types';
import {
  createSessionWithLifecycle,
  resumeSessionWithLifecycle,
} from './session-orchestrator-lifecycle';
import logger from '../logger';
import { sessionHistory } from '../session-history';
import { isManagedWorktreePath, removeManagedWorktree } from '../worktrees/managed';
import { syncSingleSessionTaskTitleFromSession } from '../task-title-sync';

const MAX_SESSIONS = 20;

/**
 * Session Orchestrator
 *
 * Manages session lifecycle: create, close, resume, rename, delete
 */
export class SessionOrchestrator {
  constructor(private processManager: ProcessManager) {}

  /**
   * Create a new session
   *
   * @param userId - User ID from auth
   * @param options - Session creation options
   * @returns Session creation result
   * @throws Error if session limit reached or CLI spawn fails
   */
  async createSession(
    userId: string,
    options: SessionCreateOptions
  ): Promise<SessionCreateResult> {
    const canCreate = await this.enforceSessionLimit(userId);
    if (!canCreate) {
      throw new Error('Maximum session limit reached (20 sessions)');
    }

    return createSessionWithLifecycle({
      options,
      processManager: this.processManager,
      userId,
    });
  }

  /**
   * Close a session
   *
   * @param userId - User ID from auth
   * @param sessionId - Session ID to close
   */
  async closeSession(userId: string, sessionId: string): Promise<void> {
    try {
      // Kill CLI process
      await this.processManager.closeSession(sessionId);

      logger.info({ userId, sessionId }, 'Session closed');
    } catch (err) {
      logger.error({
        userId,
        sessionId,
        error: err,
        }, 'Failed to close session');

      throw err;
    }
  }

  /**
   * Resume a session from saved history
   *
   * @param userId - User ID from auth
   * @param sessionId - Session ID to resume
   * @param options - Resume options
   * @returns Session resume result
   */
  async resumeSession(
    userId: string,
    sessionId: string,
    options: SessionResumeOptions = {}
  ): Promise<SessionResumeResult> {
    return resumeSessionWithLifecycle({
      options,
      processManager: this.processManager,
      sessionId,
      userId,
    });
  }

  /**
   * Rename a session
   *
   * @param userId - User ID from auth
   * @param sessionId - Session ID to rename
   * @param newTitle - New session title
   */
  async renameSession(userId: string, sessionId: string, newTitle: string): Promise<void> {
    // Validate title
    if (newTitle.length > 100) {
      throw new Error('Title too long (max 100 characters)');
    }

    // Persist to DB
    dbSessions.updateSession(sessionId, { title: newTitle, has_custom_title: 1 });
    syncSingleSessionTaskTitleFromSession(sessionId, newTitle);

    logger.info({ userId, sessionId, newTitle }, 'Session renamed');
  }

  /**
   * Delete a session
   *
   * @param userId - User ID from auth
   * @param sessionId - Session ID to delete
   * @throws Error if session not found or permission denied
   */
  async deleteSession(userId: string, sessionId: string): Promise<void> {
    try {
      const session = dbSessions.getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Kill process if running
      const activeProcesses = this.processManager.getUserProcesses(userId);
      const isRunning = activeProcesses.some((p) => p.sessionId === sessionId);

      if (isRunning) {
        logger.info({ userId, sessionId }, 'Terminating CLI process before deletion');
        await this.processManager.closeSession(sessionId);
      }

      const sourceProjectDir =
        (session.project_id ? dbProjects.getProject(session.project_id)?.decoded_path : undefined)
        ?? (path.isAbsolute(session.project_id) ? session.project_id : null);

      if (
        session.worktree_branch &&
        session.work_dir &&
        !session.worktree_deleted_at &&
        sourceProjectDir &&
        isManagedWorktreePath(session.work_dir)
      ) {
        // Only remove the physical worktree if no other sessions share the same work_dir
        const otherCount = dbSessions.countOtherSessionsByWorkDir(session.work_dir, sessionId);
        if (otherCount === 0) {
          await removeManagedWorktree(sourceProjectDir, session.work_dir);
          logger.info({ userId, sessionId, worktreePath: session.work_dir }, 'Managed worktree removed');
        } else {
          logger.info(
            { userId, sessionId, worktreePath: session.work_dir, otherSessionCount: otherCount },
            'Skipped worktree removal — other sessions still reference it'
          );
        }
      }
      await sessionHistory.deleteSession(sessionId);

      dbSessions.deleteSession(sessionId);

      logger.info({ userId, sessionId }, 'Session deleted successfully');
    } catch (err) {
      logger.error({
        userId,
        sessionId,
        error: err,
        }, 'Failed to delete session');

      throw err;
    }
  }

  /**
   * Enforce session limit (max 20)
   *
   * @param userId - User ID from auth
   * @returns True if user can create more sessions, false if at limit
   */
  async enforceSessionLimit(userId: string): Promise<boolean> {
    const activeProcesses = this.processManager.getUserProcesses(userId);
    return activeProcesses.length < MAX_SESSIONS;
  }
}

// Singleton instance
import { processManager } from '../cli/process-manager';

// globalThis to survive Next.js hot reload and webpack/tsx module boundary
const SO_KEY = Symbol.for('tessera.sessionOrchestrator');
const _g = globalThis as unknown as Record<symbol, SessionOrchestrator>;
export const sessionOrchestrator: SessionOrchestrator =
  _g[SO_KEY] || (_g[SO_KEY] = new SessionOrchestrator(processManager));
