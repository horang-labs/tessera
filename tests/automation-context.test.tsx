import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAutomationContext } from '../src/components/automation/automation-context';
import { useSessionStore } from '../src/stores/session-store';
import { useTaskStore } from '../src/stores/task-store';
import type { ProjectGroup } from '../src/types/chat';
import type { TaskEntity } from '../src/types/task-entity';

const project:ProjectGroup={encodedDir:'origin',displayName:'Fixture Project',decodedPath:'/fixture',isCurrent:true,
  sessions:[],totalSessions:0,allLoaded:true,loadedCount:0,nextCursor:null,loadBatchIndex:0,
  projectWorktree:{path:'/fixture',id:'wt_root',currentBranch:'main',displayPath:'/fixture'}};
const task:TaskEntity={id:'task_fixture',worktreeId:'wt_managed',projectId:'origin',projectViewId:'origin',title:'Fixture Worktree',
  worktreeBranch:'feature/fixture',workflowStatus:'todo',sortOrder:0,sessions:[],createdAt:'fixture',updatedAt:'fixture'};

test('root and managed Schedule context names the actual Worktree and its origin Project',()=>{
  const oldProjects=useSessionStore.getState().projects,oldTasks=useTaskStore.getState().tasksByProject;
  useSessionStore.setState({projects:[project]});useTaskStore.setState({tasksByProject:{origin:[task]}});
  // SSR reads the hydration snapshot; give it the same loaded Task cache as the client.
  const initial=useTaskStore.getInitialState(),oldInitialTasks=initial.tasksByProject;
  initial.tasksByProject={origin:[task]};
  function Heading({id}:{id:string}){const label=useAutomationContext({worktreeId:id});return createElement('header',null,`${label.title} · ${label.subtitle}`);}
  try{
    assert.match(renderToStaticMarkup(createElement(Heading,{id:'wt_root'})),/main · Fixture Project/);
    assert.match(renderToStaticMarkup(createElement(Heading,{id:'wt_managed'})),/feature\/fixture · Fixture Project · feature\/fixture/);
    assert.match(renderToStaticMarkup(createElement(Heading,{id:'wt_unknown'})),/Target/);
  }finally{initial.tasksByProject=oldInitialTasks;useSessionStore.setState({projects:oldProjects});useTaskStore.setState({tasksByProject:oldTasks});}
});
