import { getAllProjects, getProject } from '@/lib/db/projects';
import type { ControlProjectRecord, ControlProjectSource } from './service';

export function createDatabaseControlProjectSource(): ControlProjectSource {
  return {
    list: () => getAllProjects().map(toControlProjectRecord),
    get: (projectId) => {
      const project = getProject(projectId);
      return project ? toControlProjectRecord(project) : undefined;
    },
  };
}

function toControlProjectRecord(project: {
  id: string;
  decoded_path: string;
  display_name: string;
  visible: number;
}): ControlProjectRecord {
  return {
    id: project.id,
    decodedPath: project.decoded_path,
    displayName: project.display_name,
    visible: project.visible === 1,
  };
}
