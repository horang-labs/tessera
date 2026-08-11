import { createCodexLifecycleRoute } from '@/lib/cli/codex-lifecycle-route';
import { manageCodexLifecycleForUser } from '@/lib/cli/codex-lifecycle-policy';

const handlers = createCodexLifecycleRoute(manageCodexLifecycleForUser);
export const GET = handlers.GET;
export const POST = handlers.POST;
