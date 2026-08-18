// Personal blocks get a color identity from a small palette (reusing token
// hues). Assigned by stable index so the mapping is consistent.
// Order matches the design reference: Sleep=purple, Gym=green, Deep work=blue,
// Grocery=orange.
export const BLOCK_PALETTE = [
  "--acct-2", // purple
  "--state-free", // green
  "--acct-1", // blue
  "--state-warning", // orange
  "--acct-5", // magenta-purple
  "--acct-6", // teal
] as const;

export function blockColorVar(index: number): string {
  return BLOCK_PALETTE[index % BLOCK_PALETTE.length];
}
