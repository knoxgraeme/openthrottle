export type KernelWorkerHealthCondition = "disk_full" | "worker_stalled";

export interface KernelWorkerHealthSnapshot {
  ok: boolean;
  condition?: KernelWorkerHealthCondition;
  message?: string;
  worker: {
    status: "starting" | "healthy" | "degraded" | "unhealthy";
    lastSuccessfulCycleAt: string | null;
    consecutiveFailures: number;
    staleAfterSeconds: number;
  };
}

export interface KernelWorkerHealthPort {
  snapshot(): KernelWorkerHealthSnapshot;
}
