# RoadSim Traffic Builder

A playable top-down road construction and traffic simulation prototype built with Phaser 3, TypeScript, and Vite.

## Getting Started

```bash
npm install
npm run dev
```

The dev server runs on [http://localhost:5173](http://localhost:5173).

Live preview: [https://roadsim.raphcvr.me](https://roadsim.raphcvr.me)

For an optimized build:

```bash
npm run build
npm run preview
```

## Controls

- **Mouse**
  - Left click paints with the active tool
  - Right click removes road tiles or unsets points
- **Tools**: `1` Road · `2` Erase · `3` Spawn · `4` Destination
- **Cars**: `Space` spawns one car · `T` toggles auto spawn
- **Spawn Rate**: `F` slows down · `G` speeds up (`-` / `+` on the numpad work too)
- **Brush Size**: `,` or `;` decreases · `.` or `:` increases (brackets still work)
- **Management**: `C` clears all cars · `R` resets the map
- **Camera**: Arrow keys or WASD to pan (view auto-adjusts to the grid)

## Key Features

- Editable grid with multi-cell brush and live highlighting
- Procedural road visuals with center lines and intersection markers
- Configurable spawn and destination points to steer the traffic flow
- A* pathfinding (PathFinding.js) with caching and auto-refresh on map edits
- Vehicles with smoothed acceleration and basic traffic avoidance
- HUD with live statistics (tool, brush, road count, spawn interval, FPS)
- Responsive camera framing that adapts to the playable area

## TypeScript Types

- `src/main.ts` – Phaser scene with game logic (grid, input, vehicles, pathfinding)
- `src/style.css` – Minimal styles for a full-screen canvas
- `src/types/pathfinding.d.ts` – Types for PathFinding.js

## Next Ideas

- Offload pathfinding to a Web Worker for bigger fleets
- Replace procedural roads with tile assets or integrate a Tiled map
- Add signals or priority rules for complex intersections
- Support multi-lane roads and advanced overtaking behaviour

Happy building!