'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder,
  FolderGit2,
  ChevronRight,
  ArrowUp,
  Loader2,
  FolderPlus,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
} from '@/components/ui/dialog';
import { DialogHero } from '@/components/ui/dialog-hero';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface DirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

interface BrowseResponse {
  currentPath: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
  isGitRepo: boolean;
}

interface FolderBrowserDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => Promise<void>;
}

export function FolderBrowserDialog({
  isOpen,
  onClose,
  onSelect,
}: FolderBrowserDialogProps) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchDirectory = useCallback(async (path?: string, hidden?: boolean) => {
    setIsLoading(true);
    setError(null);

    try {
      const query = new URLSearchParams();
      if (path) query.set('path', path);
      if (hidden) query.set('showHidden', 'true');
      const qs = query.toString();
      const response = await fetch(`/api/filesystem/browse${qs ? `?${qs}` : ''}`);

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to browse directory');
      }

      const data: BrowseResponse = await response.json();
      setCurrentPath(data.currentPath);
      setParentPath(data.parentPath);
      setEntries(data.entries);
      setIsGitRepo(data.isGitRepo);
      setPathInput(data.currentPath);
      // Scroll list to top when navigating
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load home directory on open (reset showHidden)
  useEffect(() => {
    if (isOpen) {
      setShowHidden(false);
      fetchDirectory();
    }
  }, [isOpen, fetchDirectory]);

  const handleNavigate = (path: string) => {
    fetchDirectory(path, showHidden);
  };

  const handleEntryClick = (entry: DirectoryEntry) => {
    handleNavigate(entry.path);
  };

  const handlePathInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && pathInput.trim()) {
      fetchDirectory(pathInput.trim(), showHidden);
    }
  };

  const handleSelect = async () => {
    if (!currentPath) return;

    setIsCreating(true);
    try {
      await onSelect(currentPath);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setIsCreating(false);
    }
  };

  // Parse current path into breadcrumb segments
  const breadcrumbs = currentPath
    ? currentPath.split('/').filter(Boolean).map((segment, index, arr) => ({
        name: segment,
        path: '/' + arr.slice(0, index + 1).join('/'),
      }))
    : [];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-w-none flex-col overflow-hidden"
        style={{
          width: '42rem',
          height: '46rem',
          maxWidth: 'calc(100vw - 2rem)',
          maxHeight: 'calc(100vh - 2rem)',
        }}
        data-testid="folder-browser-dialog"
      >
        <DialogHeader onClose={onClose}>
          <DialogHero
            title={t('dialog.folderBrowser.title')}
            subtitle={t('dialog.folderBrowser.subtitle')}
            icon={FolderPlus}
          />
        </DialogHeader>

        {/* Path input */}
        <div className="mt-2 shrink-0">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                ref={inputRef}
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={handlePathInputKeyDown}
                className="w-full px-3 py-2 pr-8 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) text-sm font-mono placeholder:text-(--input-placeholder) focus:outline-none focus:ring-1 focus:ring-(--accent)"
                placeholder={t('dialog.folderBrowser.pathPlaceholder')}
                data-testid="folder-browser-path-input"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 h-[38px]"
              onClick={() => fetchDirectory(pathInput.trim(), showHidden)}
              disabled={isLoading}
              title={t('dialog.folderBrowser.go')}
            >
              {t('dialog.folderBrowser.go')}
            </Button>
          </div>
        </div>

        {/* Breadcrumb navigation */}
        <div className="flex shrink-0 items-center gap-0.5 mt-3 text-xs overflow-x-auto pb-1 scrollbar-thin">
          <button
            onClick={() => handleNavigate('/')}
            className="p-1 rounded hover:bg-(--sidebar-hover) text-(--text-muted) hover:text-(--accent) transition-colors shrink-0"
            title={t('dialog.folderBrowser.root')}
          >
            /
          </button>
          {breadcrumbs.map((crumb, i) => (
            <div key={crumb.path} className="flex items-center shrink-0">
              <ChevronRight className="w-3 h-3 text-(--text-muted) mx-0.5" />
              <button
                onClick={() => handleNavigate(crumb.path)}
                className={cn(
                  'px-1.5 py-0.5 rounded transition-colors truncate max-w-[150px]',
                  i === breadcrumbs.length - 1
                    ? 'text-(--text-primary) font-medium'
                    : 'text-(--text-muted) hover:text-(--accent) hover:bg-(--sidebar-hover)'
                )}
                title={crumb.path}
              >
                {crumb.name}
              </button>
            </div>
          ))}
          {isGitRepo && (
            <span className="ml-2 px-1.5 py-0.5 text-[10px] font-medium rounded bg-(--accent)/15 text-(--accent) shrink-0">
              GIT
            </span>
          )}
          <button
            onClick={() => {
              const next = !showHidden;
              setShowHidden(next);
              fetchDirectory(currentPath, next);
            }}
            className={cn(
              'ml-auto p-1 rounded transition-colors shrink-0',
              showHidden
                ? 'text-(--accent) bg-(--accent)/10'
                : 'text-(--text-muted) hover:text-(--accent) hover:bg-(--sidebar-hover)'
            )}
            title={showHidden ? t('dialog.folderBrowser.hideHidden') : t('dialog.folderBrowser.showHidden')}
            data-testid="folder-browser-show-hidden"
          >
            {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Directory listing */}
        <div
          ref={listRef}
          className="mt-2 min-h-0 flex-1 border border-(--divider) rounded-lg overflow-y-auto bg-(--input-bg)"
          data-testid="folder-browser-list"
        >
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-(--text-muted)">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              {t('dialog.folderBrowser.loading')}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-(--text-muted) px-4">
              <p className="text-sm text-(--error)">{error}</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => fetchDirectory()}
              >
                {t('dialog.folderBrowser.goHome')}
              </Button>
            </div>
          ) : (
            <div className="py-1">
              {/* Parent directory */}
              {parentPath && (
                <button
                  onClick={() => handleNavigate(parentPath)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-(--sidebar-hover) transition-colors text-left"
                  data-testid="folder-browser-parent"
                >
                  <ArrowUp className="w-4 h-4 text-(--text-muted) shrink-0" />
                  <span className="text-(--text-muted)">..</span>
                </button>
              )}

              {/* Directory entries */}
              {entries.length === 0 && !parentPath ? (
                <div className="flex items-center justify-center h-full py-12 text-(--text-muted) text-sm">
                  {t('dialog.folderBrowser.emptyDirectory')}
                </div>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => handleEntryClick(entry)}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left group hover:bg-(--sidebar-hover) text-(--text-primary)"
                    title={entry.path}
                    data-testid="folder-browser-entry"
                  >
                    {entry.isGitRepo ? (
                      <FolderGit2 className="w-4 h-4 text-(--accent) shrink-0" />
                    ) : (
                      <Folder className="w-4 h-4 text-(--text-muted) group-hover:text-(--accent) shrink-0" />
                    )}
                    <span className="min-w-0 flex flex-1 items-center gap-2">
                      <span className="truncate">{entry.name}</span>
                      {entry.isGitRepo && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-(--accent)/10 text-(--accent) shrink-0 opacity-70">
                          git
                        </span>
                      )}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Current path indicator */}
        <div className="mt-2 shrink-0 px-3 py-2 rounded-md bg-(--sidebar-hover) border border-(--divider)">
          <div className="flex items-center gap-2">
            <span className="text-xs text-(--text-muted) shrink-0">{t('dialog.folderBrowser.currentFolder')}</span>
            <span className="text-xs text-(--text-primary) font-mono truncate">
              {currentPath || '...'}
            </span>
          </div>
        </div>

        {/* Footer buttons */}
        <div className="flex shrink-0 gap-3 justify-end mt-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isCreating}
            data-testid="folder-browser-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSelect}
            disabled={isCreating || isLoading || !currentPath}
            data-testid="folder-browser-confirm"
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('dialog.folderBrowser.creating')}
              </>
            ) : (
              t('dialog.folderBrowser.startSession')
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
