import { createProviderSkillRoute } from '@/lib/cli/provider-skill-route';
import { manageProviderSkillsForUser } from '@/lib/cli/provider-skill-policy';

const handlers = createProviderSkillRoute(manageProviderSkillsForUser);
export const GET = handlers.GET;
export const POST = handlers.POST;
