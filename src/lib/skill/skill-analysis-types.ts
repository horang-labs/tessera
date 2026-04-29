/** Individual skill detail within a plugin or standalone */
export interface SkillDetail {
  name: string;
  displayName: string;
  summary: string;
  whenToUse: string;
  role: 'entry' | 'core' | 'support';
  order: number;
}

/** A single step in a plugin's workflow */
export interface WorkflowStep {
  skillName: string;
  displayName: string;
  phase?: string;
}

/** Plugin-level analysis (a group of related skills under one namespace) */
export interface PluginAnalysis {
  namespace: string;
  displayName: string;
  summary: string;
  whenToUse: string;
  workflow: WorkflowStep[];
  skills: SkillDetail[];
}

/** Standalone skill analysis (no plugin namespace) */
export interface StandaloneSkillAnalysis {
  name: string;
  displayName: string;
  summary: string;
  whenToUse: string;
  relatedSkills?: string[];
}

/** Cross-plugin group — clusters similar plugins into categories */
export interface PluginGroup {
  category: string;
  displayName: string;
  summary: string;
  pluginOrder: string[]; // ordered namespace list
}

/** Top-level analysis result */
export interface SkillAnalysis {
  generatedAt: string;
  plugins: PluginAnalysis[];
  standaloneSkills: StandaloneSkillAnalysis[];
  groups?: PluginGroup[];
}
