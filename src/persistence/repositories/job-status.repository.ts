import { db } from "../db.js";
import { jobStatus } from "../schema/index.js";

export type JobRunResult = { success: true; summary: string } | { success: false; errorMessage: string };

export type JobStatusRow = {
  jobName: string;
  lastRunAt: Date;
  lastSuccess: boolean;
  lastSummary: string | null;
  lastErrorMessage: string | null;
};

export async function recordJobRun(jobName: string, result: JobRunResult): Promise<void> {
  const values = {
    jobName,
    lastRunAt: new Date(),
    lastSuccess: result.success,
    lastSummary: result.success ? result.summary : null,
    lastErrorMessage: result.success ? null : result.errorMessage,
  };

  await db.insert(jobStatus).values(values).onConflictDoUpdate({ target: jobStatus.jobName, set: values });
}

export async function listJobStatuses(): Promise<JobStatusRow[]> {
  return db.select().from(jobStatus);
}
