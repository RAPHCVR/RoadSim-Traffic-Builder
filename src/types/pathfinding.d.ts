declare module 'pathfinding' {
  export type Matrix = number[][]

  export interface FinderOptions {
    allowDiagonal?: boolean
    dontCrossCorners?: boolean
    heuristic?: (dx: number, dy: number) => number
    weight?: number
    diagonalMovement?: number
  }

  export class Grid {
    constructor(width: number, height: number, matrix?: Matrix)
    constructor(matrix: Matrix)
    clone(): Grid
    isWalkableAt(x: number, y: number): boolean
    setWalkableAt(x: number, y: number, walkable: boolean): void
  }

  export class AStarFinder {
    constructor(options?: FinderOptions)
    findPath(startX: number, startY: number, endX: number, endY: number, grid: Grid): number[][]
  }

  export const DiagonalMovement: Record<string, number>
  export const Heuristic: Record<string, (dx: number, dy: number) => number>

  const Pathfinding: {
    Grid: typeof Grid
    AStarFinder: typeof AStarFinder
    DiagonalMovement: typeof DiagonalMovement
    Heuristic: typeof Heuristic
  }

  export default Pathfinding
}
