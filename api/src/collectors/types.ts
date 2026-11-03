export type CollectSummary = {
  collector: string;
  ok: number;
  unknown: number;
  error: number;
  details: Array<Record<string, unknown>>;
};
