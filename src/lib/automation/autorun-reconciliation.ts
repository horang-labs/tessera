import { AUTORUN_BOUNDS, supervisorSettlementObservationSchema } from './autorun-contracts';
import type { AutomationService } from './service';

/** Observation releases analysis capacity only; it cannot authorize a writer or revive an outcome. */
export class AutorunReconciliation {
  private pending=new Map<string,Promise<unknown>>();
  constructor(private service:AutomationService) {}
  async reconcile(userId?:string,sessionId?:string):Promise<void> {
    const candidates=this.service.repo.decisions().filter(d=>d.active && !['reserved','analysing'].includes(d.detail.phase) &&
      (!userId||d.identity.userId===userId)&&(!sessionId||d.identity.expectedBoundary.sessionId===sessionId));
    for(const d of candidates) {
      try {
        const owner=await this.service.authorize(d.identity.userId);
        if(owner.agentEnvironment!==d.identity.agentEnvironment)continue;
        const port=this.service.deps.provider?.(d.packetSelection.provider);
        if(!port?.observeSupervisorSettlement)continue;
        for(const attempt of d.detail.attempts.filter(a=>a.quiescent!==true)) {
          const id=attempt.invocationId;
          if(this.pending.has(id)||this.pending.size>=2)continue;
          const request={version:1 as const,userId:owner.userId,agentEnvironment:owner.agentEnvironment,invocationId:id};
          const task=Promise.resolve().then(()=>port.observeSupervisorSettlement!(request));this.pending.set(id,task);
          void task.then(()=>this.pending.delete(id),()=>this.pending.delete(id));
          let timer:ReturnType<typeof setTimeout>|undefined;
          let result:unknown;
          try{result=await Promise.race([task,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),AUTORUN_BOUNDS.flushWaitMs);timer.unref?.();})]);}
          finally{clearTimeout(timer);}
          const parsed=supervisorSettlementObservationSchema.safeParse(result);
          if(!parsed.success||parsed.data.kind!=='quiescent'||parsed.data.userId!==request.userId||
            parsed.data.agentEnvironment!==request.agentEnvironment||parsed.data.invocationId!==id||parsed.data.proof.closedAt<attempt.startedAt)continue;
          const proof=parsed.data;
          this.service.repo.transaction(()=>{
            const current=this.service.repo.decision(d.detail.id);
            if(!current?.active||['reserved','analysing'].includes(current.detail.phase))return;
            const retained=current.detail.attempts.find(a=>a.invocationId===id);
            if(!retained||retained.quiescent===true)return;
            retained.quiescent=true;retained.finishedAt??=this.service.deps.now();
            current.settlementObservations={...current.settlementObservations,[id]:proof};
            current.active=current.detail.attempts.some(a=>a.quiescent!==true);
            this.service.repo.saveDecision(current);
          });
        }
      }catch{/* Missing or failed observation keeps quarantine and never changes worker ownership. */}
    }
    for (const value of this.service.repo.all()) for (const decision of value.activation?.approvals ?? []) {
      const a = value.automation;
      if (decision.quiescent === true || decision.phase === 'analysing' || a.target.kind !== 'wake-session' ||
        (userId && a.ownerUserId !== userId) || (sessionId && a.target.sessionId !== sessionId)) continue;
      try {
        const owner = await this.service.authorize(a.ownerUserId), id = decision.invocationId;
        if (owner.agentEnvironment !== a.agentEnvironment || this.pending.has(id) || this.pending.size >= 2) continue;
        const port = this.service.deps.provider?.(decision.selection.provider);
        if (!port?.observeSupervisorSettlement) continue;
        const request = {version:1 as const,userId:owner.userId,agentEnvironment:owner.agentEnvironment,invocationId:id};
        const task = Promise.resolve().then(() => port.observeSupervisorSettlement!(request));
        this.pending.set(id,task); void task.then(()=>this.pending.delete(id),()=>this.pending.delete(id));
        let timer:ReturnType<typeof setTimeout>|undefined;
        let result:unknown;
        try { result = await Promise.race([task,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),AUTORUN_BOUNDS.flushWaitMs);timer.unref?.();})]); }
        finally { clearTimeout(timer); }
        const parsed = supervisorSettlementObservationSchema.safeParse(result);
        if (!parsed.success || parsed.data.kind !== 'quiescent' || parsed.data.userId !== request.userId ||
          parsed.data.agentEnvironment !== request.agentEnvironment || parsed.data.invocationId !== id || parsed.data.proof.closedAt < decision.startedAt) continue;
        const current = this.service.repo.get(a.id), retained = current?.activation?.approvals.find(d=>d.id===decision.id);
        if (retained && retained.phase !== 'analysing' && retained.quiescent !== true) {
          retained.quiescent=true; retained.finishedAt ??= this.service.deps.now();
          retained.settlementObservation=parsed.data; this.service.repo.save(current!);
        }
      } catch { /* Exact owned settlement only releases capacity, never replays an approval. */ }
    }

  }
}
