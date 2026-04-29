import { spawn, ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getSkillList, getSkillContent } from './skill-loader';
import { SettingsManager } from '../settings/manager';
import type {
  SkillAnalysis,
  PluginAnalysis,
  StandaloneSkillAnalysis,
  PluginGroup,
} from './skill-analysis-types';
import type { Language } from '../settings/types';
import logger from '../logger';

const CACHE_PATH = join(homedir(), '.claude', 'tessera-skill-analysis.json');
const MAX_CONTENT_PER_SKILL = 3000;
const CLI_TIMEOUT_MS = 3 * 60 * 1000; // 3 min per CLI call
const CONCURRENCY = 10;
const STANDALONE_BATCH_SIZE = 20;

// ---------- State types ----------

export type AnalysisStatus = 'idle' | 'scanning' | 'analyzing' | 'completed' | 'failed';

export interface AnalysisState {
  status: AnalysisStatus;
  skillCount?: number;
  result?: SkillAnalysis;
  error?: string;
  startedAt?: string;
  requestedBy?: string;
  model?: string;
  completedCount?: number;
  totalCount?: number;
  currentJobs?: string[]; // namespaces currently being analyzed in parallel
}

// ---------- Internal types ----------

interface SkillEntry {
  name: string;
  shortName: string;
  description: string;
  content: string | null;
}

// ---------- Language map ----------

const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
};

// ---------- Service ----------

type Subscriber = (state: AnalysisState) => void;

class SkillAnalysisService {
  private state: AnalysisState = { status: 'idle' };
  private subscribers = new Set<Subscriber>();
  private activeProcesses = new Set<ChildProcess>();
  private cancelled = false;
  private currentRunId = 0;

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getState(): AnalysisState {
    return { ...this.state };
  }

  loadCache(): SkillAnalysis | null {
    try {
      if (existsSync(CACHE_PATH)) {
        return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as SkillAnalysis;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async startAnalysis(userId: string, model?: string): Promise<boolean> {
    if (this.state.status === 'scanning' || this.state.status === 'analyzing') {
      return false;
    }

    this.cancelled = false;

    this.setState({
      status: 'scanning',
      requestedBy: userId,
      startedAt: new Date().toISOString(),
      result: undefined,
      error: undefined,
      skillCount: undefined,
      model: undefined,
      completedCount: undefined,
      totalCount: undefined,
    });

    let language: Language = 'en';
    try {
      const settings = await SettingsManager.load(userId);
      language = settings.language;
    } catch {
      /* proceed with default language */
    }

    if (!model) {
      this.setState({ status: 'failed', error: 'Model is required' });
      return false;
    }
    this.setState({ model });

    const runId = ++this.currentRunId;

    this.runAnalysis(language, model, runId).catch((err) => {
      logger.error({ error: err }, 'Skill analysis uncaught error');
      this.setState({ status: 'failed', error: (err as Error).message });
    });

    return true;
  }

  cancelAnalysis(): boolean {
    if (this.state.status !== 'scanning' && this.state.status !== 'analyzing') {
      return false;
    }
    this.cancelled = true;
    for (const proc of this.activeProcesses) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.activeProcesses.clear();
    this.setState({ status: 'failed', error: 'Cancelled by user' });
    return true;
  }

  // ---------- Private ----------

  private setState(patch: Partial<AnalysisState>): void {
    this.state = { ...this.state, ...patch };
    this.notifySubscribers();
  }

  private notifySubscribers(): void {
    const snapshot = { ...this.state };
    for (const cb of this.subscribers) {
      try {
        cb(snapshot);
      } catch {
        /* subscriber error should not break the service */
      }
    }
  }

  private async runAnalysis(language: Language, cliModel: string, runId: number): Promise<void> {
    const isStale = () => this.cancelled || this.currentRunId !== runId;
    // 1. Scan skills
    const skills = getSkillList(process.cwd());
    this.setState({ skillCount: skills.length });

    logger.info({ skillCount: skills.length, language }, 'Skill analysis: scanning');

    // 2. Build namespace map
    const namespaces = this.buildNamespaceMap(skills);

    // 3. Prepare work items
    const pluginJobs: Array<{ namespace: string; skills: SkillEntry[] }> = [];
    const standaloneSkills: SkillEntry[] = [];

    for (const [ns, entries] of namespaces) {
      if (ns === '_standalone') {
        standaloneSkills.push(...entries);
      } else {
        pluginJobs.push({ namespace: ns, skills: entries });
      }
    }

    // Batch standalone skills
    const standaloneBatches: SkillEntry[][] = [];
    for (let i = 0; i < standaloneSkills.length; i += STANDALONE_BATCH_SIZE) {
      standaloneBatches.push(standaloneSkills.slice(i, i + STANDALONE_BATCH_SIZE));
    }

    // +1 for Phase C grouping job
    let totalJobs = pluginJobs.length + standaloneBatches.length + 1;
    this.setState({ status: 'analyzing', completedCount: 0, totalCount: totalJobs });

    logger.info({ pluginCount: pluginJobs.length, standaloneBatches: standaloneBatches.length }, 'Skill analysis: starting phase A+B');

    // 4. Phase A+B: run plugin + standalone jobs in parallel (with concurrency limit)
    const pluginResults: PluginAnalysis[] = [];
    const standaloneResults: StandaloneSkillAnalysis[] = [];
    let completed = 0;

    const lang = LANGUAGE_NAMES[language] ?? 'English';

    type Job =
      | { type: 'plugin'; namespace: string; skills: SkillEntry[] }
      | { type: 'standalone'; skills: SkillEntry[] };

    const allJobs: Job[] = [
      ...pluginJobs.map((j) => ({ type: 'plugin' as const, ...j })),
      ...standaloneBatches.map((batch) => ({ type: 'standalone' as const, skills: batch })),
    ];

    // Process with concurrency limit
    const queue = [...allJobs];
    const inFlight = new Set<Promise<void>>();

    const activeJobs = new Set<string>();
    const updateActiveJobs = () => {
      if (!isStale()) this.setState({ currentJobs: [...activeJobs] });
    };

    const processJob = async (job: Job) => {
      if (isStale()) return;

      const jobLabel = job.type === 'plugin'
        ? job.namespace
        : `standalone (${job.skills.length})`;
      activeJobs.add(jobLabel);
      updateActiveJobs();

      let prompt: string;
      if (job.type === 'plugin') {
        prompt = this.buildPluginPrompt(job.namespace, job.skills, lang);
      } else {
        prompt = this.buildStandalonePrompt(job.skills, lang);
      }

      const result = await this.spawnCli(prompt, cliModel);

      if (isStale()) return;

      if (result.success) {
        const parsed = this.parseJson(result.output);
        if (parsed) {
          if (job.type === 'plugin') {
            // Use parsed.namespace if present, otherwise fallback to job's namespace
            const pluginData = parsed as PluginAnalysis;
            if (!pluginData.namespace) pluginData.namespace = job.namespace;
            pluginResults.push(pluginData);
          } else if (Array.isArray(parsed)) {
            standaloneResults.push(...(parsed as StandaloneSkillAnalysis[]));
          }
        } else {
          logger.warn({ jobType: job.type, namespace: job.type === 'plugin' ? job.namespace : undefined },
            'Failed to parse job result');
        }
        completed++;
        activeJobs.delete(jobLabel);
        if (!isStale()) this.setState({ completedCount: completed });
        updateActiveJobs();
      } else {
        activeJobs.delete(jobLabel);
        updateActiveJobs();
        // CLI failed — split and retry if possible
        if (job.skills.length > 1) {
          const mid = Math.ceil(job.skills.length / 2);
          const firstHalf = job.skills.slice(0, mid);
          const secondHalf = job.skills.slice(mid);

          logger.info({
            jobType: job.type,
            namespace: job.type === 'plugin' ? job.namespace : undefined,
            originalCount: job.skills.length,
            splitInto: [firstHalf.length, secondHalf.length],
          }, 'CLI job failed, splitting and retrying');

          // Increase total count for progress tracking
          totalJobs++;
          if (!isStale()) this.setState({ totalCount: totalJobs });

          if (job.type === 'plugin') {
            queue.push(
              { type: 'plugin', namespace: job.namespace, skills: firstHalf },
              { type: 'plugin', namespace: job.namespace, skills: secondHalf },
            );
          } else {
            queue.push(
              { type: 'standalone', skills: firstHalf },
              { type: 'standalone', skills: secondHalf },
            );
          }
        } else {
          // Single skill failed — skip it
          logger.warn({ jobType: job.type, skillName: job.skills[0]?.name, error: result.error },
            'Single skill CLI job failed, skipping');
          completed++;
          if (!isStale()) this.setState({ completedCount: completed });
          updateActiveJobs();
        }
      }
    };

    while (queue.length > 0 || inFlight.size > 0) {
      if (isStale()) return;

      while (queue.length > 0 && inFlight.size < CONCURRENCY) {
        const job = queue.shift()!;
        const promise = processJob(job).then(() => {
          inFlight.delete(promise);
        });
        inFlight.add(promise);
      }

      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    }

    if (this.cancelled) return;

    // 4.5. Merge split plugin results (same namespace from retried halves)
    const mergedPlugins = new Map<string, PluginAnalysis>();
    for (const pr of pluginResults) {
      const existing = mergedPlugins.get(pr.namespace);
      if (existing) {
        // Merge skills and workflow arrays
        existing.skills = [...(existing.skills || []), ...(pr.skills || [])];
        existing.workflow = [...(existing.workflow || []), ...(pr.workflow || [])];
        // Keep first non-empty summary/displayName/whenToUse
        if (!existing.displayName && pr.displayName) existing.displayName = pr.displayName;
        if (!existing.summary && pr.summary) existing.summary = pr.summary;
        if (!existing.whenToUse && pr.whenToUse) existing.whenToUse = pr.whenToUse;
      } else {
        mergedPlugins.set(pr.namespace, { ...pr });
      }
    }
    const finalPluginResults = [...mergedPlugins.values()];

    // 5. Phase C: cross-plugin grouping
    this.setState({ currentJobs: ['cross-plugin grouping'] });
    logger.info({ pluginCount: finalPluginResults.length }, 'Skill analysis: starting phase C (grouping)');

    let groups: PluginGroup[] = [];
    if (finalPluginResults.length > 1) {
      const groupPrompt = this.buildGroupingPrompt(finalPluginResults, lang);
      const groupResult = await this.spawnCli(groupPrompt, cliModel);

      if (groupResult.success) {
        const parsed = this.parseJson(groupResult.output);
        if (Array.isArray(parsed)) {
          groups = parsed as PluginGroup[];
        }
      }
    }

    completed++;
    if (!isStale()) this.setState({ completedCount: completed });

    if (this.cancelled) return;

    // 6. Assemble final result
    const analysis: SkillAnalysis = {
      generatedAt: new Date().toISOString(),
      plugins: finalPluginResults.sort((a, b) => a.namespace.localeCompare(b.namespace)),
      standaloneSkills: standaloneResults.sort((a, b) => a.name.localeCompare(b.name)),
      groups: groups.length > 0 ? groups : undefined,
    };

    this.persistCache(analysis);
    this.setState({ status: 'completed', result: analysis });

    logger.info({
      path: CACHE_PATH,
      plugins: finalPluginResults.length,
      standalone: standaloneResults.length,
      groups: groups.length,
    }, 'Skill analysis completed');
  }

  // ---------- Namespace map ----------

  private buildNamespaceMap(
    skills: Array<{ name: string; description: string }>
  ): Map<string, SkillEntry[]> {
    const namespaces = new Map<string, SkillEntry[]>();

    for (const skill of skills) {
      const colonIdx = skill.name.indexOf(':');
      const namespace = colonIdx !== -1 ? skill.name.slice(0, colonIdx) : '_standalone';
      const shortName = colonIdx !== -1 ? skill.name.slice(colonIdx + 1) : skill.name;

      if (!namespaces.has(namespace)) namespaces.set(namespace, []);

      const rawContent = getSkillContent(skill.name);
      const content =
        rawContent && rawContent.length > MAX_CONTENT_PER_SKILL
          ? rawContent.slice(0, MAX_CONTENT_PER_SKILL) + '\n... (truncated)'
          : rawContent;

      namespaces.get(namespace)!.push({
        name: skill.name,
        shortName,
        description: skill.description,
        content,
      });
    }

    return namespaces;
  }

  // ---------- Prompt builders ----------

  private buildPluginPrompt(namespace: string, skills: SkillEntry[], lang: string): string {
    const skillContext = skills.map((s) => {
      const header = `### ${s.name}\nDescription: ${s.description || '(no description)'}`;
      const body = s.content ? `\n<skill-content>\n${s.content}\n</skill-content>` : '';
      return header + body;
    }).join('\n\n');

    return `Analyze this single Claude Code plugin and return a JSON object.

Plugin namespace: "${namespace}"
Skills count: ${skills.length}

${skillContext}

Return ONLY a JSON object (no markdown fences) with this structure:
{
  "namespace": "${namespace}",
  "displayName": "<human-friendly name in ${lang}>",
  "summary": "<2-3 sentence detailed summary in ${lang}>",
  "whenToUse": "<when to use in ${lang}>",
  "workflow": [
    { "skillName": "<EXACT skill name as shown above, e.g. ${skills[0]?.name || 'namespace:skill'}>", "displayName": "<${lang} name>", "phase": "<optional phase or null>" }
  ],
  "skills": [
    {
      "name": "<EXACT skill name as shown above — do NOT strip the namespace prefix>",
      "displayName": "<short ${lang} name>",
      "summary": "<1 sentence ${lang}>",
      "whenToUse": "<${lang}>",
      "role": "<entry | core | support>",
      "order": <number>
    }
  ]
}

CRITICAL: The "name" field in each skill MUST be the EXACT full name as listed above (e.g. "${skills[0]?.name || 'namespace:skill'}"). Do NOT remove the namespace prefix.

Rules:
- "workflow" ordered by execution sequence found in content
- "entry": main entry point (usually 1 per plugin), "core": essential workflow, "support": helpers
- Entry skills have order=1
- All text in ${lang}
- Output ONLY valid JSON`;
  }

  private buildStandalonePrompt(skills: SkillEntry[], lang: string): string {
    const list = skills.map((s) =>
      `- ${s.name}: ${s.description || '(no description)'}`
    ).join('\n');

    return `Analyze these standalone Claude Code skills (no plugin namespace) and return a JSON array.

${list}

Return ONLY a JSON array (no markdown fences) with this structure:
[
  {
    "name": "<skill name>",
    "displayName": "<${lang} name>",
    "summary": "<1 sentence ${lang}>",
    "whenToUse": "<${lang}>",
    "relatedSkills": ["<related skill names>"]
  }
]

Rules:
- All text in ${lang}
- Output ONLY valid JSON array`;
  }

  private buildGroupingPrompt(plugins: PluginAnalysis[], lang: string): string {
    const list = plugins.map((p) =>
      `- ${p.namespace}: ${p.displayName} — ${p.summary}`
    ).join('\n');

    return `Group these Claude Code plugins into logical categories.

Plugins:
${list}

Return ONLY a JSON array (no markdown fences):
[
  {
    "category": "<category ID, e.g. 'pm-tools', 'django', 'testing'>",
    "displayName": "<${lang} category name>",
    "summary": "<1 sentence ${lang} category description>",
    "pluginOrder": ["<namespace1>", "<namespace2>"]
  }
]

Rules:
- Group by functional similarity (e.g. all PM tools together, all Django tools together)
- pluginOrder: recommended usage order within the group
- Plugins that don't fit any group can be in a catch-all category
- All text in ${lang}
- Output ONLY valid JSON array`;
  }

  // ---------- CLI ----------

  private spawnCli(prompt: string, model: string): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      const spawnEnv = { ...process.env };
      delete spawnEnv.CLAUDECODE;

      const cliProcess = spawn(
        'claude',
        ['--print', '--output-format', 'text', '--max-turns', '1', '--model', model],
        {
          shell: false,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      this.activeProcesses.add(cliProcess);
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { cliProcess.kill('SIGTERM'); } catch { /* ignore */ }
          this.activeProcesses.delete(cliProcess);
          resolve({ success: false, output: '', error: 'CLI call timed out' });
        }
      }, CLI_TIMEOUT_MS);

      cliProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      cliProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      cliProcess.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.activeProcesses.delete(cliProcess);

        if (code === 0) {
          resolve({ success: true, output: stdout.trim() });
        } else {
          resolve({
            success: false,
            output: '',
            error: `CLI exited with code ${code}: ${stderr.slice(0, 300)}`,
          });
        }
      });

      cliProcess.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.activeProcesses.delete(cliProcess);
        resolve({ success: false, output: '', error: err.message });
      });

      cliProcess.stdin?.write(prompt);
      cliProcess.stdin?.end();
    });
  }

  // ---------- JSON parsing ----------

  private parseJson(output: string): any {
    const tryParse = (str: string): any => {
      try { return JSON.parse(str); } catch { return null; }
    };

    const direct = tryParse(output);
    if (direct !== null) return direct;

    const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      const fenced = tryParse(fenceMatch[1]);
      if (fenced !== null) return fenced;
    }

    const firstOpen = Math.min(
      output.indexOf('{') === -1 ? Infinity : output.indexOf('{'),
      output.indexOf('[') === -1 ? Infinity : output.indexOf('['),
    );
    if (firstOpen !== Infinity) {
      const opener = output[firstOpen];
      const closer = opener === '{' ? '}' : ']';
      const lastClose = output.lastIndexOf(closer);
      if (lastClose > firstOpen) {
        const braced = tryParse(output.slice(firstOpen, lastClose + 1));
        if (braced !== null) return braced;
      }
    }

    return null;
  }

  // ---------- Persistence ----------

  private persistCache(analysis: SkillAnalysis): void {
    try {
      writeFileSync(CACHE_PATH, JSON.stringify(analysis, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ error: err }, 'Failed to write analysis cache');
    }
  }
}

// Singleton via globalThis
const SINGLETON_KEY = Symbol.for('tessera.skillAnalysisService');
const _g = globalThis as unknown as Record<symbol, SkillAnalysisService>;
export const skillAnalysisService = (_g[SINGLETON_KEY] ??= new SkillAnalysisService());

export { CACHE_PATH };
