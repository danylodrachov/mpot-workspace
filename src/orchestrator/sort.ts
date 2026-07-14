import type { Board, Lane, Action } from './executor/types.ts';

export interface SortableCard {
  taskId: string;
  board: Board;
  currentLane: Lane;
  truthfulSignal: string;
  actions: Action[];
}

// Higher = shown first in daily-plan
function actionPriority(actions: Action[]): number {
  if (actions.length === 0) return 0;
  const kinds = new Set(actions.map((a) => a.kind));
  if (kinds.has('lane_move')) return 4;
  if (kinds.has('replyio')) return 3;
  if (kinds.has('comment')) return 2;
  if (kinds.has('flag_operator')) return 1;
  return 0;
}

// OKB = revenue → before CKB
function boardPriority(board: Board): number {
  return board === 'okb' ? 1 : 0;
}

/** Focus-sort: group by ROI (board), then output-state (action priority). */
export function focusSort(cards: SortableCard[]): SortableCard[] {
  return [...cards].sort((a, b) => {
    const byAction = actionPriority(b.actions) - actionPriority(a.actions);
    if (byAction !== 0) return byAction;
    return boardPriority(b.board) - boardPriority(a.board);
  });
}
