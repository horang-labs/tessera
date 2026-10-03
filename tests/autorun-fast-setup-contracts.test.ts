import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunPreviewInputSchema, getAutorunSetupDefaults } from '../src/lib/automation/autorun-contracts';

test('shared setup defaults preserve existing limits and anchor expiry to the supplied draft time',()=>{
  assert.deepEqual(getAutorunSetupDefaults(1800000000000),{
    delayMs:120000,maxDispatches:10,maxAnalyses:20,analysisTimeoutMs:120000,expiresAt:1800028800000,
  });
});
test('preview discovery is optional and defaults on for existing callers; only booleans are accepted',()=>{
  assert.equal(autorunPreviewInputSchema.parse({}).includeSupervisorDiscovery,true);
  assert.equal(autorunPreviewInputSchema.parse({includeSupervisorDiscovery:false}).includeSupervisorDiscovery,false);
  assert.equal(autorunPreviewInputSchema.parse({includeSupervisorDiscovery:true}).includeSupervisorDiscovery,true);
  assert.equal(autorunPreviewInputSchema.safeParse({includeSupervisorDiscovery:'false'}).success,false);
});
