import { LoaderCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function GitConflictResolveWithAiButton({
  description,
  label,
  onPrepare,
  pending,
  pendingLabel,
}: {
  description: string;
  label: string;
  onPrepare: () => void;
  pending: boolean;
  pendingLabel: string;
}) {
  return (
    <div className="border-b border-(--status-warning-border) px-3 py-2.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={onPrepare}
        data-testid="git-conflict-resolve-with-ai"
        className="w-full justify-center gap-2"
      >
        {pending ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {pending ? pendingLabel : label}
      </Button>
      <p className="mt-1.5 text-[10px] leading-4 text-(--text-muted)">
        {description}
      </p>
    </div>
  );
}
