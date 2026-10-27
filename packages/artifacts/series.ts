import { z } from "zod";

export const ArtifactSeries = z.string().trim().min(1).max(60);
export const ArtifactChangeSummary = z.string().trim().max(200);
export const ReadArtifactInput = z.object({
  series: ArtifactSeries.nullish(),
  artifact_id: z.uuid().nullish(),
}).strict().refine(input => Boolean(input.series) !== Boolean(input.artifact_id), "Pass either series or artifact_id");
export const ARTIFACT_READ_BYTES = 200 * 1024;
