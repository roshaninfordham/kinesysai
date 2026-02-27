/**
 * KINESYS — Score Calculator
 *
 * Scoring formula:
 *   time_score     = max(0, par_time - actual_time) × 10
 *   efficiency_score = (par_actions / actual_actions) × 100
 *   accuracy_score   = success ? 500 : 0
 *   total_score      = time_score + efficiency_score + accuracy_score
 *
 * Star rating based on configurable thresholds per puzzle.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  timeScore: number;
  efficiencyScore: number;
  accuracyScore: number;
  totalScore: number;
  stars: 0 | 1 | 2 | 3;
  timeBonusMs: number;
  actualTimeMs: number;
  actualActions: number;
  parTime: number;
  parActions: number;
  success: boolean;
}

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

export function calculateScore(params: {
  success: boolean;
  actualTimeMs: number;
  actualActions: number;
  parTime: number;       // seconds
  parActions: number;
  starThresholds: [number, number, number]; // [1-star, 2-star, 3-star]
}): ScoreBreakdown {
  const { success, actualTimeMs, actualActions, parTime, parActions, starThresholds } = params;

  const actualTimeSec = actualTimeMs / 1000;

  // Time score: bonus for finishing under par
  const timeScore = Math.max(0, Math.round((parTime - actualTimeSec) * 10));

  // Efficiency score: ratio of optimal to actual actions
  const efficiencyScore =
    actualActions > 0
      ? Math.round((parActions / actualActions) * 100)
      : 0;

  // Accuracy: flat bonus for completing the puzzle
  const accuracyScore = success ? 500 : 0;

  const totalScore = timeScore + efficiencyScore + accuracyScore;

  // Star rating
  let stars: 0 | 1 | 2 | 3 = 0;
  if (totalScore >= starThresholds[2]) stars = 3;
  else if (totalScore >= starThresholds[1]) stars = 2;
  else if (totalScore >= starThresholds[0]) stars = 1;

  return {
    timeScore,
    efficiencyScore,
    accuracyScore,
    totalScore,
    stars,
    timeBonusMs: Math.max(0, (parTime - actualTimeSec) * 1000),
    actualTimeMs,
    actualActions,
    parTime,
    parActions,
    success,
  };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  id: string;
  playerName: string;
  puzzleId: number;
  puzzleName: string;
  score: number;
  stars: 0 | 1 | 2 | 3;
  timeMs: number;
  actions: number;
  timestamp: number;
}

// In-memory leaderboard (persists across component mounts within session)
let leaderboard: LeaderboardEntry[] = [];

export function addToLeaderboard(entry: Omit<LeaderboardEntry, "id" | "timestamp">): LeaderboardEntry {
  const full: LeaderboardEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };

  leaderboard.push(full);
  // Sort descending by score
  leaderboard.sort((a, b) => b.score - a.score);
  // Keep top 10
  leaderboard = leaderboard.slice(0, 10);

  return full;
}

export function getLeaderboard(): LeaderboardEntry[] {
  return [...leaderboard];
}

export function clearLeaderboard(): void {
  leaderboard = [];
}
