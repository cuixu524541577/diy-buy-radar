/** Phase-1 initial weights — configurable */
export type WeightKey =
  | 'priceAttractiveness'
  | 'perfPerPrice'
  | 'supply'
  | 'productCycle'
  | 'aiComputeEnv'
  | 'personalNeed';

export const DEFAULT_WEIGHTS: Record<WeightKey, number> = {
  priceAttractiveness: 0.3,
  perfPerPrice: 0.2,
  supply: 0.15,
  productCycle: 0.1,
  aiComputeEnv: 0.1,
  personalNeed: 0.15,
};

export const SCORE_BANDS = [
  { min: 80, max: 100, label: '非常值得考虑入手', recommendation: 'buy' as const },
  { min: 65, max: 79, label: '价格较好，可结合预算购买', recommendation: 'consider' as const },
  { min: 45, max: 64, label: '继续观察', recommendation: 'watch' as const },
  { min: 0, max: 44, label: '暂时不建议购买', recommendation: 'avoid' as const },
];

export function recommendationFromScore(score: number | null): string {
  if (score == null || Number.isNaN(score)) return 'unknown';
  for (const b of SCORE_BANDS) {
    if (score >= b.min && score <= b.max) return b.recommendation;
  }
  return 'unknown';
}
