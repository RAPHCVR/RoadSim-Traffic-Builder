import './style.css';
import Phaser from 'phaser';
import PF from 'pathfinding';
type GridPoint = {
    x: number;
    y: number;
};
type Tool = 'road' | 'erase' | 'spawn' | 'destination';
const TOOL: Record<'Road' | 'Erase' | 'Spawn' | 'Destination', Tool> = {
    Road: 'road',
    Erase: 'erase',
    Spawn: 'spawn',
    Destination: 'destination'
};
type Car = {
    id: number;
    sprite: Phaser.GameObjects.Container;
    path: Phaser.Math.Vector2[];
    gridPath: GridPoint[];
    destination: GridPoint;
    targetIndex: number;
    position: Phaser.Math.Vector2;
    heading: Phaser.Math.Vector2;
    currentSpeed: number;
    targetSpeed: number;
    maxSpeed: number;
    width: number;
    length: number;
    color: number;
};
class PathCache {
    private readonly store = new Map<string, GridPoint[]>();
    private readonly limit: number;

    constructor(limit = 1024) {
        this.limit = limit;
    }

    get(key: string): GridPoint[] | undefined {
        const cached = this.store.get(key);
        return cached ? cached.map((cell) => ({ ...cell })) : undefined;
    }

    set(key: string, path: GridPoint[]) {
        const snapshot = path.map((cell) => ({ ...cell }));
        if (this.store.has(key)) {
            this.store.delete(key);
        }
        this.store.set(key, snapshot);
        if (this.store.size > this.limit) {
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) {
                this.store.delete(oldest);
            }
        }
    }

    clear() {
        this.store.clear();
    }
}

class GameScene extends Phaser.Scene {
    private readonly tileSize = 32;
    private readonly gridWidth = 48;
    private readonly gridHeight = 32;
    private grid: number[][] = [];
    private walkMatrix: number[][] = [];
    private roadCount = 0;
    private graphics!: Phaser.GameObjects.Graphics;
    private overlay!: Phaser.GameObjects.Graphics;
    private infoText!: Phaser.GameObjects.Text;
    private hudText!: Phaser.GameObjects.Text;
    private statusTimer = 0;
    private flashMessage = '';
    private flashTimer = 0;
    private cars: Car[] = [];
    private carId = 0;
    private carPathsDirty = false;
    private carPathRefreshDelay = 0;
    private finder = new PF.AStarFinder({ allowDiagonal: false });
    private pathCache = new PathCache(2048);
    private spawnPoints = new Map<string, GridPoint>();
    private destinationPoints = new Map<string, GridPoint>();
    private spawnOrder: GridPoint[] = [];
    private spawnCursor = 0;
    private lastSpawnError: string | null = null;
    private activeTool = TOOL.Road;
    private brushSize = 1;
    private hoverCell: GridPoint | null = null;
    private activePaintValue: 0 | 1 | null = null;
    private needsRedraw = false;
    private autoSpawn = true;
    private spawnInterval = 3;
    private spawnTimer = 0;
    private readonly speedSmoothingTime = 0.25;
    private cameraKeys!: Phaser.Types.Input.Keyboard.CursorKeys;
    private keyW!: Phaser.Input.Keyboard.Key;
    private keyA!: Phaser.Input.Keyboard.Key;
    private keyS!: Phaser.Input.Keyboard.Key;
    private keyD!: Phaser.Input.Keyboard.Key;
    private keyLeftAzerty!: Phaser.Input.Keyboard.Key;
    private keyIncreaseRate!: Phaser.Input.Keyboard.Key;
    private keyIncreaseRateNumpad!: Phaser.Input.Keyboard.Key;
    private keyDecreaseRate!: Phaser.Input.Keyboard.Key;
    private keyDecreaseRateNumpad!: Phaser.Input.Keyboard.Key;
    private keyToggleAuto!: Phaser.Input.Keyboard.Key;
    private keyClearCars!: Phaser.Input.Keyboard.Key;
    private keyResetMap!: Phaser.Input.Keyboard.Key;
    private keyToolRoad!: Phaser.Input.Keyboard.Key;
    private keyToolErase!: Phaser.Input.Keyboard.Key;
    private keyToolSpawn!: Phaser.Input.Keyboard.Key;
    private keyToolDestination!: Phaser.Input.Keyboard.Key;
    private keyUpAzerty!: Phaser.Input.Keyboard.Key;
    private readonly spatialCellSize = this.tileSize * 2;
    private readonly carSpatialIndex = new Map<string, Car[]>();
    private readonly neighborScratch: Car[] = [];
    private readonly tempCameraCenter = new Phaser.Math.Vector2();
    private cameraPaddingX = 0;
    private cameraPaddingY = 0;
    constructor() {
        super('GameScene');
    }
    preload() {
        this.cameras.main.setBackgroundColor(0x101216);
    }
    create() {
        this.initializeGrid();
        this.graphics = this.add.graphics();
        this.graphics.setDepth(1);
        this.overlay = this.add.graphics();
        this.overlay.setDepth(2);
        this.setupInput();
        this.setupUi();
        this.seedSimpleRoads();
        this.forceRedraw();
        this.scale.on('resize', this.onResize, this);
        this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off('resize', this.onResize, this);
            this.input.keyboard?.off('keydown', this.handleKeyDown, this);
        });
    }
    update(_time: number, deltaMs: number) {
        const dt = deltaMs / 1000;
        this.handleShortcuts();
        this.handleCamera(dt);
        this.updateCars(dt);
        this.handleAutoSpawn(dt);
        this.updateCarPathRefresh(dt);
        if (this.needsRedraw) {
            this.redrawGrid();
            this.needsRedraw = false;
        }
        this.statusTimer += dt;
        if (this.statusTimer >= 0.25) {
            this.statusTimer = 0;
            this.refreshHud();
        }
        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
            if (this.flashTimer <= 0) {
                this.flashMessage = '';
                this.refreshHud(true);
            }
        }
    }
    private get worldWidth() {
        return this.gridWidth * this.tileSize;
    }
    private get worldHeight() {
        return this.gridHeight * this.tileSize;
    }
    private initializeGrid() {
        this.grid = Array.from({ length: this.gridHeight }, () => Array(this.gridWidth).fill(0));
        this.walkMatrix = Array.from({ length: this.gridHeight }, () => Array(this.gridWidth).fill(1));
        this.roadCount = 0;
        this.cameraPaddingX = 0;
        this.cameraPaddingY = 0;
        this.fitCameraToWorld({ preserveCenter: false });
    }
    private setupInput() {
        this.input.mouse?.disableContextMenu();
        this.input.on('pointerdown', this.onPointerDown, this);
        this.input.on('pointermove', this.onPointerMove, this);
        this.input.on('pointerup', this.onPointerUp, this);
        this.input.on('pointerout', () => {
            this.hoverCell = null;
            this.activePaintValue = null;
            this.renderPointerHighlight();
        });
        this.input.keyboard?.on('keydown-SPACE', () => {
            if (this.spawnCarRandom()) {
                this.spawnTimer = 0;
            }
        });
        this.cameraKeys = this.input.keyboard!.createCursorKeys();
        const keyboard = this.input.keyboard!;
        this.keyW = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W, true);
        this.keyA = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A, true);
        this.keyS = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S, true);
        this.keyD = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D, true);
        this.keyUpAzerty = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Z, true);
        this.keyLeftAzerty = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Q, true);
        this.input.keyboard?.on('keydown', this.handleKeyDown, this);
        this.keyIncreaseRate = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.G);
        this.keyIncreaseRateNumpad = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_ADD);
        this.keyDecreaseRate = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F);
        this.keyDecreaseRateNumpad = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_SUBTRACT);
        this.keyToggleAuto = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.T);
        this.keyClearCars = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.C);
        this.keyResetMap = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
        this.keyToolRoad = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
        this.keyToolErase = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
        this.keyToolSpawn = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
        this.keyToolDestination = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.FOUR);
    }
    private setupUi() {
        const instructions = [
            'Mouse: left click = paint | right click = remove',
            'Tools: [1] Road  [2] Erase  [3] Spawn  [4] Destination',
            'Controls: Space = spawn car | T = auto on/off | F/G = spawn rate',
            'Brush: , or ; smaller | . or : larger | C = clear cars | R = reset map',
            'Camera: Arrow keys or WASD to pan'
        ].join('\n');
        const deviceRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const textResolution = Phaser.Math.Clamp(deviceRatio * 2, 2, 4);
        const fontFamily = 'Consolas, "Fira Code", "Source Code Pro", "Courier New", monospace';
        this.infoText = this.add.text(0, 0, instructions, {
            fontFamily,
            fontSize: '16px',
            color: '#f3f6ff',
            lineSpacing: 4,
            wordWrap: { width: 460 }
        });
        this.infoText.setOrigin(0);
        this.infoText.setPadding(18, 14, 22, 16);
        this.infoText.setStyle({ backgroundColor: '#0b111d90' });
        this.infoText.setScrollFactor(0);
        this.infoText.setDepth(20);
        this.infoText.setAlpha(0.96);
        this.infoText.setResolution(textResolution);
        this.infoText.setShadow(2, 2, '#05070b', 2, false, true);
        this.hudText = this.add.text(0, 0, '', {
            fontFamily,
            fontSize: '15px',
            color: '#f9fbff',
            lineSpacing: 4
        });
        this.hudText.setOrigin(0);
        this.hudText.setPadding(14, 10, 18, 12);
        this.hudText.setStyle({ backgroundColor: '#0b111c85' });
        this.hudText.setScrollFactor(0);
        this.hudText.setDepth(20);
        this.hudText.setAlpha(0.94);
        this.hudText.setResolution(textResolution);
        this.hudText.setShadow(2, 2, '#05070b', 2, false, true);
        this.refreshHud(true);
    }

    private handleShortcuts() {
        if (Phaser.Input.Keyboard.JustDown(this.keyToolRoad)) {
            this.setActiveTool(TOOL.Road);
        }
        if (Phaser.Input.Keyboard.JustDown(this.keyToolErase)) {
            this.setActiveTool(TOOL.Erase);
        }
        if (Phaser.Input.Keyboard.JustDown(this.keyToolSpawn)) {
            this.setActiveTool(TOOL.Spawn);
        }
        if (Phaser.Input.Keyboard.JustDown(this.keyToolDestination)) {
            this.setActiveTool(TOOL.Destination);
        }
        if (this.justDownAny(this.keyIncreaseRate, this.keyIncreaseRateNumpad)) {
            this.adjustSpawnInterval(-0.5);
        }
        if (this.justDownAny(this.keyDecreaseRate, this.keyDecreaseRateNumpad)) {
            this.adjustSpawnInterval(0.5);
        }
        if (Phaser.Input.Keyboard.JustDown(this.keyToggleAuto)) {
            this.autoSpawn = !this.autoSpawn;
            this.spawnTimer = 0;
            this.showFlash(this.autoSpawn ? 'Auto spawn: enabled' : 'Auto spawn: disabled', 1.5);
        }
        if (Phaser.Input.Keyboard.JustDown(this.keyClearCars)) {
            this.clearCars();
            this.showFlash('All cars have been removed', 1.5);
        }
        if (Phaser.Input.Keyboard.JustDown(this.keyResetMap)) {
            this.resetMap();
        }
    }

    private handleKeyDown(event: KeyboardEvent) {
        if (this.processBrushHotkey(event)) {
            event.preventDefault();
        }
    }

    private processBrushHotkey(event: KeyboardEvent) {
        const code = event.code;
        const key = event.key;
        const decrease = code === 'Comma' || code === 'BracketLeft' || code === 'NumpadSubtract' || key === ',' || key === ';';
        if (decrease) {
            this.adjustBrush(-1);
            return true;
        }
        const increase = code === 'Period' || code === 'Semicolon' || code === 'BracketRight' || code === 'NumpadAdd' || code === 'Equal' || key === '.' || key === ':' || key === '+';
        if (increase) {
            this.adjustBrush(1);
            return true;
        }
        return false;
    }
    private justDownAny(...keys: (Phaser.Input.Keyboard.Key | undefined)[]) {
        for (const key of keys) {
            if (key && Phaser.Input.Keyboard.JustDown(key)) {
                return true;
            }
        }
        return false;
    }
    private handleCamera(dt: number) {
        const cam = this.cameras.main;
        let vx = 0;
        let vy = 0;
        if (this.cameraKeys.left?.isDown || this.keyA.isDown || this.keyLeftAzerty.isDown)
            vx -= 1;
        if (this.cameraKeys.right?.isDown || this.keyD.isDown)
            vx += 1;
        if (this.cameraKeys.up?.isDown || this.keyW.isDown || this.keyUpAzerty.isDown)
            vy -= 1;
        if (this.cameraKeys.down?.isDown || this.keyS.isDown)
            vy += 1;
        if (vx !== 0 || vy !== 0) {
            const length = Math.hypot(vx, vy) || 1;
            vx /= length;
            vy /= length;
            const speed = 320;
            cam.scrollX += (vx * speed * dt) / cam.zoom;
            cam.scrollY += (vy * speed * dt) / cam.zoom;
        }
        this.clampCameraScroll();
    }
    private getViewDimensions() {
        const cam = this.cameras.main;
        const invZoom = 1 / cam.zoom;
        return {
            width: cam.width * invZoom,
            height: cam.height * invZoom
        };
    }
    private clampCameraCenter(target: Phaser.Math.Vector2, dims?: { width: number; height: number }) {
        const dimensions = dims ?? this.getViewDimensions();
        const halfWidth = dimensions.width * 0.5;
        const halfHeight = dimensions.height * 0.5;
        const boundsMinX = -this.cameraPaddingX;
        const boundsMaxX = this.worldWidth + this.cameraPaddingX;
        const boundsMinY = -this.cameraPaddingY;
        const boundsMaxY = this.worldHeight + this.cameraPaddingY;
        const minCenterX = boundsMinX + halfWidth;
        const maxCenterX = boundsMaxX - halfWidth;
        const minCenterY = boundsMinY + halfHeight;
        const maxCenterY = boundsMaxY - halfHeight;
        target.x = Phaser.Math.Clamp(target.x, minCenterX, maxCenterX);
        target.y = Phaser.Math.Clamp(target.y, minCenterY, maxCenterY);
        return target;
    }
    private clampCameraScroll() {
        const cam = this.cameras.main;
        const dims = this.getViewDimensions();
        this.tempCameraCenter.set(cam.scrollX + dims.width * 0.5, cam.scrollY + dims.height * 0.5);
        this.clampCameraCenter(this.tempCameraCenter, dims);
        cam.scrollX = this.tempCameraCenter.x - dims.width * 0.5;
        cam.scrollY = this.tempCameraCenter.y - dims.height * 0.5;
    }

    private fitCameraToWorld(options: { preserveCenter?: boolean } = {}) {
        const cam = this.cameras.main;
        const width = cam.width;
        const height = cam.height;
        if (width <= 0 || height <= 0) {
            return;
        }
        const worldWidth = this.worldWidth;
        const worldHeight = this.worldHeight;
        const viewRatio = width / height;
        const worldRatio = worldWidth / worldHeight;
        let paddedWidth = worldWidth;
        let paddedHeight = worldHeight;
        if (viewRatio > worldRatio) {
            paddedWidth = worldHeight * viewRatio;
        }
        else if (viewRatio < worldRatio) {
            paddedHeight = worldWidth / viewRatio;
        }
        this.cameraPaddingX = Math.max(0, (paddedWidth - worldWidth) * 0.5);
        this.cameraPaddingY = Math.max(0, (paddedHeight - worldHeight) * 0.5);
        const targetZoom = width / paddedWidth;
        const preserveCenter = options.preserveCenter ?? true;
        let centerX: number;
        let centerY: number;
        if (preserveCenter) {
            centerX = cam.scrollX + (width * 0.5) / cam.zoom;
            centerY = cam.scrollY + (height * 0.5) / cam.zoom;
        }
        else {
            centerX = worldWidth * 0.5;
            centerY = worldHeight * 0.5;
        }
        cam.setBounds(-this.cameraPaddingX, -this.cameraPaddingY, paddedWidth, paddedHeight);
        cam.setZoom(targetZoom);
        cam.centerOn(centerX, centerY);
        this.clampCameraScroll();
    }
    private onResize() {
        this.fitCameraToWorld();
        this.renderPointerHighlight();
        this.updateUiLayout();
    }
    private adjustBrush(delta: number) {
        const next = Phaser.Math.Clamp(this.brushSize + delta, 1, 4);
        if (next === this.brushSize)
            return;
        this.brushSize = next;
        this.renderPointerHighlight();
        this.showFlash(`Brush: ${this.brushSize}x${this.brushSize}`, 1.2);
    }
    private adjustSpawnInterval(delta: number) {
        const next = Phaser.Math.Clamp(parseFloat((this.spawnInterval + delta).toFixed(1)), 0.5, 10);
        this.spawnInterval = next;
        this.spawnTimer = 0;
        this.showFlash(`Auto interval: ${next.toFixed(1)}s`, 1.5);
    }
    private onPointerDown(pointer: Phaser.Input.Pointer) {
        const cell = this.pointerToCell(pointer.worldX, pointer.worldY);
        if (!cell)
            return;
        if (this.activeTool === TOOL.Road) {
            this.activePaintValue = pointer.button === 2 ? 0 : 1;
            this.applyBrush(cell, this.activePaintValue);
        }
        else if (this.activeTool === TOOL.Erase) {
            this.activePaintValue = 0;
            this.applyBrush(cell, 0);
        }
        else if (this.activeTool === TOOL.Spawn && pointer.button === 0) {
            this.toggleSpawn(cell);
        }
        else if (this.activeTool === TOOL.Spawn && pointer.button === 2) {
            this.removeSpawn(cell);
        }
        else if (this.activeTool === TOOL.Destination && pointer.button === 0) {
            this.toggleDestination(cell);
        }
        else if (this.activeTool === TOOL.Destination && pointer.button === 2) {
            this.removeDestination(cell);
        }
        this.hoverCell = cell;
        this.renderPointerHighlight();
    }
    private onPointerMove(pointer: Phaser.Input.Pointer) {
        const cell = this.pointerToCell(pointer.worldX, pointer.worldY);
        this.hoverCell = cell;
        if (pointer.isDown && this.activePaintValue !== null && cell) {
            this.applyBrush(cell, this.activePaintValue);
        }
        this.renderPointerHighlight();
    }
    private onPointerUp() {
        this.activePaintValue = null;
    }
    private applyBrush(cell: GridPoint, value: 0 | 1) {
        const cells = this.getBrushCells(cell);
        let modified = false;
        for (const target of cells) {
            modified = this.setRoadValue(target.x, target.y, value) || modified;
        }
        if (modified) {
            this.spawnTimer = Math.min(this.spawnTimer, this.spawnInterval * 0.5);
        }
    }
    private getBrushCells(cell: GridPoint, tool: Tool = this.activeTool): GridPoint[] {
        if (!cell)
            return [];
        if (tool === TOOL.Spawn || tool === TOOL.Destination) {
            return this.isInside(cell.x, cell.y) ? [cell] : [];
        }
        const radius = this.brushSize - 1;
        const cells: GridPoint[] = [];
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = cell.x + dx;
                const y = cell.y + dy;
                if (!this.isInside(x, y))
                    continue;
                cells.push({ x, y });
            }
        }
        return cells;
    }
    private setRoadValue(x: number, y: number, value: 0 | 1): boolean {
        if (!this.isInside(x, y))
            return false;
        const prev = this.grid[y][x];
        if (prev === value)
            return false;
        this.grid[y][x] = value;
        this.walkMatrix[y][x] = value === 1 ? 0 : 1;
        this.invalidatePaths();
        if (value === 1) {
            this.roadCount += 1;
        }
        else {
            this.roadCount = Math.max(0, this.roadCount - 1);
            const key = this.cellKey(x, y);
            const removedSpawn = this.spawnPoints.delete(key);
            this.destinationPoints.delete(key);
            if (removedSpawn) {
                this.rebuildSpawnOrder();
            }
        }
        return true;
    }
    private scheduleCarPathRefresh(delay = 0.25) {
        this.carPathsDirty = true;
        this.carPathRefreshDelay = delay;
    }
    private invalidatePaths(delay = 0.25) {
        this.pathCache.clear();
        this.scheduleCarPathRefresh(delay);
        this.needsRedraw = true;
    }
    private updateCarPathRefresh(dt: number) {
        if (!this.carPathsDirty)
            return;
        this.carPathRefreshDelay -= dt;
        if (this.carPathRefreshDelay > 0)
            return;
        this.refreshCarPaths();
        this.carPathsDirty = false;
    }
    private refreshCarPaths() {
        if (this.cars.length === 0)
            return;
        for (let i = this.cars.length - 1; i >= 0; i--) {
            const car = this.cars[i];
            const startCell = this.findNearestRoadCell(car.position);
            if (!startCell) {
                this.removeCarAt(i);
                continue;
            }
            const best = this.selectBestDestinationPath(startCell, car.destination);
            if (!best) {
                this.removeCarAt(i);
                continue;
            }
            const gridPath = best.path.map((cell) => ({ ...cell }));
            const worldPath = gridPath.map((cell) => this.cellToWorldVector(cell));
            car.gridPath = gridPath;
            car.path = [car.position.clone(), ...worldPath.slice(1)];
            car.destination = { ...best.destination };
            car.targetIndex = 1;
            const nextTarget = car.path[car.targetIndex];
            if (nextTarget) {
                const heading = nextTarget.clone().subtract(car.position);
                if (heading.lengthSq() > 0) {
                    car.heading = heading.normalize();
                }
            }
        }
    }
    private selectBestDestinationPath(start: GridPoint, fallback: GridPoint): {
        destination: GridPoint;
        path: GridPoint[];
    } | null {
        const candidates = this.destinationPoints.size > 0 ? Array.from(this.destinationPoints.values()) : [fallback];
        let bestDestination: GridPoint | null = null;
        let bestPath: GridPoint[] | null = null;
        let bestCost = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
            const snapped = this.ensureRoadCell(candidate);
            if (!snapped)
                continue;
            const path = this.findPath(start, snapped);
            if (path.length < 2)
                continue;
            const cost = this.estimatePathCost(path);
            if (cost < bestCost) {
                bestCost = cost;
                bestDestination = snapped;
                bestPath = path;
            }
        }
        if (bestDestination && bestPath) {
            return { destination: bestDestination, path: bestPath };
        }
        const fallbackCell = this.ensureRoadCell(fallback);
        if (!fallbackCell)
            return null;
        const fallbackPath = this.findPath(start, fallbackCell);
        if (fallbackPath.length < 2)
            return null;
        return { destination: fallbackCell, path: fallbackPath };
    }
    private ensureRoadCell(cell: GridPoint): GridPoint | null {
        if (this.isRoad(cell.x, cell.y))
            return { x: cell.x, y: cell.y };
        const snapped = this.findNearestRoadCell(this.cellToWorldVector(cell));
        return snapped ? { ...snapped } : null;
    }
    private estimatePathCost(path: GridPoint[]): number {
        return path.length;
    }
    private findNearestRoadCell(worldPosition: Phaser.Math.Vector2, maxRadius = Math.max(this.gridWidth, this.gridHeight)): GridPoint | null {
        let baseX = Math.floor(worldPosition.x / this.tileSize);
        let baseY = Math.floor(worldPosition.y / this.tileSize);
        if (!this.isInside(baseX, baseY)) {
            baseX = Phaser.Math.Clamp(baseX, 0, this.gridWidth - 1);
            baseY = Phaser.Math.Clamp(baseY, 0, this.gridHeight - 1);
        }
        if (this.isRoad(baseX, baseY)) {
            return { x: baseX, y: baseY };
        }
        const maxSearch = Math.max(1, maxRadius);
        for (let radius = 1; radius <= maxSearch; radius++) {
            let candidate: GridPoint | null = null;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius)
                        continue;
                    const x = baseX + dx;
                    const y = baseY + dy;
                    if (!this.isInside(x, y))
                        continue;
                    if (!this.isRoad(x, y))
                        continue;
                    const centerX = x * this.tileSize + this.tileSize / 2;
                    const centerY = y * this.tileSize + this.tileSize / 2;
                    const diffX = worldPosition.x - centerX;
                    const diffY = worldPosition.y - centerY;
                    const distance = diffX * diffX + diffY * diffY;
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        candidate = { x, y };
                    }
                }
            }
            if (candidate) {
                return candidate;
            }
        }
        return null;
    }
    private redrawGrid() {
        const g = this.graphics;
        g.clear();
        const padX = this.cameraPaddingX;
        const padY = this.cameraPaddingY;
        g.fillStyle(0x1a1e26, 1);
        g.fillRect(-padX, -padY, this.worldWidth + padX * 2, this.worldHeight + padY * 2);
        for (let y = 0; y < this.gridHeight; y++) {
            for (let x = 0; x < this.gridWidth; x++) {
                if (this.grid[y][x] === 1) {
                    this.drawRoadTile(x, y);
                }
            }
        }
        this.drawMarkers();
        this.drawGridLines();
    }
    private drawRoadTile(x: number, y: number) {
        const g = this.graphics;
        const px = x * this.tileSize;
        const py = y * this.tileSize;
        const half = this.tileSize / 2;
        g.fillStyle(0x3f4754, 1);
        g.fillRect(px, py, this.tileSize, this.tileSize);
        g.fillStyle(0x323844, 1);
        g.fillRect(px + 2, py + 2, this.tileSize - 4, this.tileSize - 4);
        const neighbors = this.neighborInfo(x, y);
        g.lineStyle(2, 0xbfcad8, 0.35);
        if (neighbors.north || neighbors.south) {
            g.lineBetween(px + half, py + 4, px + half, py + this.tileSize - 4);
        }
        if (neighbors.east || neighbors.west) {
            g.lineBetween(px + 4, py + half, px + this.tileSize - 4, py + half);
        }
        const count = neighbors.count;
        if (count >= 3) {
            g.fillStyle(0xf1f3f5, 0.2);
            g.fillCircle(px + half, py + half, this.tileSize * 0.2);
        }
        else if (count === 1) {
            g.fillStyle(0x343b45, 1);
            const endRadius = this.tileSize * 0.18;
            const cx = px + half + neighbors.direction.x * (half - 6);
            const cy = py + half + neighbors.direction.y * (half - 6);
            g.fillCircle(cx, cy, endRadius);
        }
    }
    private drawMarkers() {
        const g = this.graphics;
        const spawnColor = 0x4dabf7;
        const destinationColor = 0xff922b;
        g.lineStyle(2, spawnColor, 0.9);
        g.fillStyle(spawnColor, 0.3);
        for (const point of this.spawnPoints.values()) {
            const center = this.cellCenterToWorld(point.x, point.y);
            g.fillCircle(center.x, center.y, this.tileSize * 0.28);
            g.strokeCircle(center.x, center.y, this.tileSize * 0.28);
        }
        g.lineStyle(2, destinationColor, 0.9);
        g.fillStyle(destinationColor, 0.3);
        for (const point of this.destinationPoints.values()) {
            const center = this.cellCenterToWorld(point.x, point.y);
            g.fillCircle(center.x, center.y, this.tileSize * 0.28);
            g.strokeCircle(center.x, center.y, this.tileSize * 0.28);
        }
    }
    private drawGridLines() {
        const g = this.graphics;
        g.lineStyle(1, 0x1f242c, 0.35);
        for (let x = 0; x <= this.gridWidth; x++) {
            const px = x * this.tileSize;
            g.lineBetween(px, 0, px, this.worldHeight);
        }
        for (let y = 0; y <= this.gridHeight; y++) {
            const py = y * this.tileSize;
            g.lineBetween(0, py, this.worldWidth, py);
        }
    }
    private neighborInfo(x: number, y: number) {
        const north = this.isRoad(x, y - 1);
        const east = this.isRoad(x + 1, y);
        const south = this.isRoad(x, y + 1);
        const west = this.isRoad(x - 1, y);
        const count = Number(north) + Number(east) + Number(south) + Number(west);
        let direction = new Phaser.Math.Vector2(0, 0);
        if (count === 1) {
            if (north)
                direction = new Phaser.Math.Vector2(0, -1);
            else if (south)
                direction = new Phaser.Math.Vector2(0, 1);
            else if (east)
                direction = new Phaser.Math.Vector2(1, 0);
            else if (west)
                direction = new Phaser.Math.Vector2(-1, 0);
        }
        return { north, east, south, west, count, direction };
    }
    private renderPointerHighlight() {
        const overlay = this.overlay;
        overlay.clear();
        if (!this.hoverCell)
            return;
        const color = this.getHighlightColor();
        const cells = this.getBrushCells(this.hoverCell);
        if (cells.length === 0)
            return;
        if (this.activeTool === TOOL.Spawn || this.activeTool === TOOL.Destination) {
            const cell = cells[0];
            const center = this.cellCenterToWorld(cell.x, cell.y);
            overlay.fillStyle(color, 0.2);
            overlay.fillCircle(center.x, center.y, this.tileSize * 0.32);
            overlay.lineStyle(2, color, 0.85);
            overlay.strokeCircle(center.x, center.y, this.tileSize * 0.32);
        }
        else {
            overlay.fillStyle(color, 0.15);
            overlay.lineStyle(2, color, 0.75);
            for (const cell of cells) {
                const px = cell.x * this.tileSize;
                const py = cell.y * this.tileSize;
                overlay.fillRect(px + 1, py + 1, this.tileSize - 2, this.tileSize - 2);
                overlay.strokeRect(px + 1, py + 1, this.tileSize - 2, this.tileSize - 2);
            }
        }
    }
    private getHighlightColor() {
        switch (this.activeTool) {
            case TOOL.Road:
                return 0x38d9a9;
            case TOOL.Erase:
                return 0xff6b6b;
            case TOOL.Spawn:
                return 0x4dabf7;
            case TOOL.Destination:
                return 0xff922b;
            default:
                return 0xffffff;
        }
    }
    private isInside(x: number, y: number) {
        return x >= 0 && y >= 0 && x < this.gridWidth && y < this.gridHeight;
    }
    private isRoad(x: number, y: number) {
        return this.isInside(x, y) && this.grid[y][x] === 1;
    }
    private pointerToCell(worldX: number, worldY: number): GridPoint | null {
        const x = Math.floor(worldX / this.tileSize);
        const y = Math.floor(worldY / this.tileSize);
        if (!this.isInside(x, y))
            return null;
        return { x, y };
    }
    private cellCenterToWorld(x: number, y: number) {
        return {
            x: x * this.tileSize + this.tileSize / 2,
            y: y * this.tileSize + this.tileSize / 2
        };
    }
    private cellToWorldVector(cell: GridPoint) {
        return new Phaser.Math.Vector2(cell.x * this.tileSize + this.tileSize / 2, cell.y * this.tileSize + this.tileSize / 2);
    }
    private cellKey(x: number, y: number) {
        return `${x},${y}`;
    }
    private rebuildSpawnOrder() {
        this.spawnOrder = Array.from(this.spawnPoints.values(), (cell) => ({ ...cell }));
        if (this.spawnOrder.length === 0) {
            this.spawnCursor = 0;
        }
        else {
            this.spawnCursor %= this.spawnOrder.length;
        }
    }
    private toggleSpawn(cell: GridPoint) {
        if (!this.isRoad(cell.x, cell.y)) {
            this.showFlash('Place a spawn on a road tile', 1.2);
            return;
        }
        const key = this.cellKey(cell.x, cell.y);
        if (this.spawnPoints.has(key)) {
            this.spawnPoints.delete(key);
            this.showFlash('Spawn removed', 1.2);
        }
        else {
            this.spawnPoints.set(key, { x: cell.x, y: cell.y });
            this.showFlash('Spawn added', 1.2);
        }
        this.rebuildSpawnOrder();
        this.invalidatePaths(0.1);
    }
    private removeSpawn(cell: GridPoint) {
        const key = this.cellKey(cell.x, cell.y);
        if (this.spawnPoints.delete(key)) {
            this.rebuildSpawnOrder();
            this.invalidatePaths(0.1);
            this.showFlash('Spawn removed', 1.0);
        }
    }
    private toggleDestination(cell: GridPoint) {
        if (!this.isRoad(cell.x, cell.y)) {
            this.showFlash('Place a destination on a road tile', 1.2);
            return;
        }
        const key = this.cellKey(cell.x, cell.y);
        if (this.destinationPoints.has(key)) {
            this.destinationPoints.delete(key);
            this.showFlash('Destination removed', 1.2);
        }
        else {
            this.destinationPoints.set(key, { x: cell.x, y: cell.y });
            this.showFlash('Destination added', 1.2);
        }
        this.invalidatePaths(0.1);
    }
    private removeDestination(cell: GridPoint) {
        const key = this.cellKey(cell.x, cell.y);
        if (this.destinationPoints.delete(key)) {
            this.invalidatePaths(0.1);
            this.showFlash('Destination removed', 1.0);
        }
    }
    private handleAutoSpawn(dt: number) {
        if (!this.autoSpawn)
            return;
        if (this.spawnInterval <= 0)
            return;
        this.spawnTimer += dt;
        if (this.spawnTimer < this.spawnInterval)
            return;
        this.spawnTimer = 0;
        const attempts = Math.max(1, this.spawnPoints.size);
        let spawned = false;
        for (let i = 0; i < attempts; i++) {
            if (this.spawnCarRandom(true, { suppressFailure: true })) {
                spawned = true;
            }
        }
        if (!spawned) {
            const reason = this.lastSpawnError ?? 'No path found between the selected points';
            this.handleSpawnFailure(reason, true);
        }
    }
    private pickSpawnStart(roads: GridPoint[]) {
        if (this.spawnPoints.size === 0) {
            const fallback = Phaser.Utils.Array.GetRandom(roads);
            return { ...fallback };
        }
        if (this.spawnOrder.length === 0) {
            this.rebuildSpawnOrder();
        }
        const total = this.spawnOrder.length;
        if (total === 0) {
            const fallback = Phaser.Utils.Array.GetRandom(roads);
            return { ...fallback };
        }
        for (let attempt = 0; attempt < total; attempt++) {
            const candidate = this.spawnOrder[this.spawnCursor];
            this.spawnCursor = (this.spawnCursor + 1) % total;
            if (this.isRoad(candidate.x, candidate.y)) {
                return { x: candidate.x, y: candidate.y };
            }
        }
        this.rebuildSpawnOrder();
        if (this.spawnOrder.length === 0) {
            const fallback = Phaser.Utils.Array.GetRandom(roads);
            return { ...fallback };
        }
        const candidate = this.spawnOrder[this.spawnCursor % this.spawnOrder.length];
        this.spawnCursor = (this.spawnCursor + 1) % this.spawnOrder.length;
        return { x: candidate.x, y: candidate.y };
    }
    private spawnCarRandom(fromAuto = false, options: { suppressFailure?: boolean } = {}): boolean {
        const suppressFailure = options.suppressFailure === true;
        this.lastSpawnError = null;
        const roads = this.collectRoadCells();
        if (roads.length < 2) {
            const error = 'Draw at least two road tiles to create a journey';
            this.lastSpawnError = error;
            if (!suppressFailure) {
                this.handleSpawnFailure(error, fromAuto);
            }
            return false;
        }
        const start = this.pickSpawnStart(roads);
        const destinationCandidates = this.destinationPoints.size > 0 ? Array.from(this.destinationPoints.values()) : roads;
        const filteredDestinations = destinationCandidates.filter((cell) => cell.x !== start.x || cell.y !== start.y);
        const effectiveDestinations = filteredDestinations.length > 0 ? filteredDestinations : destinationCandidates;
        if (effectiveDestinations.length === 0) {
            const error = "No valid destination point is available";
            this.lastSpawnError = error;
            if (!suppressFailure) {
                this.handleSpawnFailure(error, fromAuto);
            }
            return false;
        }
        const pool = this.destinationPoints.size > 0
            ? effectiveDestinations
            : Phaser.Utils.Array.Shuffle([...effectiveDestinations]).slice(0, Math.min(64, effectiveDestinations.length));
        if (pool.length === 0) {
            const error = "No valid destination point is available";
            this.lastSpawnError = error;
            if (!suppressFailure) {
                this.handleSpawnFailure(error, fromAuto);
            }
            return false;
        }
        const bestJourney = this.selectBestJourney([start], pool);
        if (bestJourney) {
            this.lastSpawnError = null;
            this.createCar(bestJourney.path);
            return true;
        }
        for (let attempt = 0; attempt < Math.min(30, effectiveDestinations.length); attempt++) {
            const end = Phaser.Utils.Array.GetRandom(effectiveDestinations);
            const path = this.findPath(start, end);
            if (path.length >= 2) {
                this.lastSpawnError = null;
                this.createCar(path);
                return true;
            }
        }
        const error = 'No path found between the selected points';
        this.lastSpawnError = error;
        if (!suppressFailure) {
            this.handleSpawnFailure(error, fromAuto);
        }
        return false;
    }
    private selectBestJourney(starts: GridPoint[], destinations: GridPoint[]): {
        start: GridPoint;
        destination: GridPoint;
        path: GridPoint[];
    } | null {
        let best: {
            start: GridPoint;
            destination: GridPoint;
            path: GridPoint[];
        } | null = null;
        let bestCost = Number.POSITIVE_INFINITY;
        for (const start of starts) {
            for (const destination of destinations) {
                if (start.x === destination.x && start.y === destination.y)
                    continue;
                const path = this.findPath(start, destination);
                if (path.length < 2)
                    continue;
                const cost = this.estimatePathCost(path);
                if (cost < bestCost) {
                    bestCost = cost;
                    best = {
                        start: { ...start },
                        destination: { ...destination },
                        path
                    };
                }
            }
        }
        return best;
    }
    private handleSpawnFailure(message: string, fromAuto: boolean) {
        if (fromAuto && this.autoSpawn) {
            this.autoSpawn = false;
            this.spawnTimer = 0;
            this.showFlash(`${message} | Auto spawn disabled`, 2.5);
        }
        else {
            this.showFlash(message, 2);
        }
    }
    private collectRoadCells(): GridPoint[] {
        const cells: GridPoint[] = [];
        for (let y = 0; y < this.gridHeight; y++) {
            for (let x = 0; x < this.gridWidth; x++) {
                if (this.grid[y][x] === 1) {
                    cells.push({ x, y });
                }
            }
        }
        return cells;
    }
    private findPath(start: GridPoint, end: GridPoint): GridPoint[] {
        const key = `${start.x},${start.y}:${end.x},${end.y}`;
        const cached = this.pathCache.get(key);
        if (cached) {
            return cached;
        }
        const grid = new PF.Grid(this.walkMatrix);
        const rawPath = this.finder.findPath(start.x, start.y, end.x, end.y, grid);
        const path = rawPath.map(([px, py]) => ({ x: px, y: py }));
        if (path.length > 0) {
            this.pathCache.set(key, path);
        }
        return path;
    }
    private createCar(path: GridPoint[]) {
        if (path.length < 2)
            return;
        const gridPath = path.map((cell) => ({ ...cell }));
        const worldPath = gridPath.map((cell) => this.cellToWorldVector(cell));
        const start = worldPath[0];
        const next = worldPath[1] ?? worldPath[0];
        const initialHeading = new Phaser.Math.Vector2(next.x - start.x, next.y - start.y);
        if (initialHeading.lengthSq() === 0) {
            initialHeading.set(1, 0);
        }
        else {
            initialHeading.normalize();
        }
        const carWidth = this.tileSize * 0.7;
        const carHeight = this.tileSize * 0.4;
        const colorPalette = [0x4dc9a1, 0x69d2ff, 0xffb347, 0xff6b6b, 0xa78bfa, 0x98c379];
        const color = Phaser.Utils.Array.GetRandom(colorPalette);
        const body = this.add.rectangle(0, 0, carWidth, carHeight, color, 1);
        body.setStrokeStyle(1, 0x101216, 0.9);
        const windshield = this.add.rectangle(carWidth * 0.1, 0, carWidth * 0.35, carHeight * 0.6, 0xffffff, 0.35);
        const headlight = this.add.rectangle(-carWidth * 0.33, 0, carWidth * 0.08, carHeight * 0.6, 0xfff3bf, 0.6);
        const taillight = this.add.rectangle(carWidth * 0.33, 0, carWidth * 0.08, carHeight * 0.6, 0xff6b6b, 0.7);
        const container = this.add.container(start.x, start.y, [body, windshield, headlight, taillight]);
        container.setDepth(5);
        container.setSize(carWidth, carHeight);
        container.setRotation(Math.atan2(initialHeading.y, initialHeading.x));
        const car: Car = {
            id: ++this.carId,
            sprite: container,
            path: worldPath,
            gridPath,
            destination: gridPath[gridPath.length - 1],
            targetIndex: 1,
            position: start.clone(),
            heading: initialHeading,
            currentSpeed: 0,
            targetSpeed: 0,
            maxSpeed: Phaser.Math.Between(60, 110),
            width: carHeight,
            length: carWidth,
            color
        };
        this.cars.push(car);
        this.refreshHud(true);
    }

    private rebuildCarSpatialIndex() {
        this.carSpatialIndex.clear();
        if (this.cars.length === 0) {
            return;
        }
        const cellSize = this.spatialCellSize;
        for (const car of this.cars) {
            const cellX = Math.floor(car.position.x / cellSize);
            const cellY = Math.floor(car.position.y / cellSize);
            const key = this.cellKey(cellX, cellY);
            let bucket = this.carSpatialIndex.get(key);
            if (!bucket) {
                bucket = [];
                this.carSpatialIndex.set(key, bucket);
            }
            bucket.push(car);
        }
    }

    private gatherNearbyCars(car: Car) {
        const nearby = this.neighborScratch;
        nearby.length = 0;
        if (this.carSpatialIndex.size === 0) {
            return nearby;
        }
        const cellSize = this.spatialCellSize;
        const baseX = Math.floor(car.position.x / cellSize);
        const baseY = Math.floor(car.position.y / cellSize);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const key = this.cellKey(baseX + dx, baseY + dy);
                const bucket = this.carSpatialIndex.get(key);
                if (!bucket) {
                    continue;
                }
                for (const other of bucket) {
                    if (other !== car) {
                        nearby.push(other);
                    }
                }
            }
        }
        return nearby;
    }

    private removeCarFromBucket(car: Car, key: string) {
        const bucket = this.carSpatialIndex.get(key);
        if (!bucket) {
            return false;
        }
        const index = bucket.indexOf(car);
        if (index === -1) {
            return false;
        }
        bucket.splice(index, 1);
        if (bucket.length === 0) {
            this.carSpatialIndex.delete(key);
        }
        return true;
    }

    private moveCarInSpatialIndex(car: Car, fromKey: string, toKey: string) {
        if (fromKey === toKey) {
            return;
        }
        if (!this.removeCarFromBucket(car, fromKey)) {
            for (const bucketKey of Array.from(this.carSpatialIndex.keys())) {
                if (this.removeCarFromBucket(car, bucketKey)) {
                    break;
                }
            }
        }
        let toBucket = this.carSpatialIndex.get(toKey);
        if (!toBucket) {
            toBucket = [];
            this.carSpatialIndex.set(toKey, toBucket);
        }
        toBucket.push(car);
    }

    private removeCarFromSpatialIndex(car: Car, keyHint?: string) {
        if (this.carSpatialIndex.size === 0) {
            return;
        }
        if (keyHint && this.removeCarFromBucket(car, keyHint)) {
            return;
        }
        const cellSize = this.spatialCellSize;
        const key = this.cellKey(Math.floor(car.position.x / cellSize), Math.floor(car.position.y / cellSize));
        if (this.removeCarFromBucket(car, key)) {
            return;
        }
        for (const bucketKey of Array.from(this.carSpatialIndex.keys())) {
            if (this.removeCarFromBucket(car, bucketKey)) {
                break;
            }
        }
    }

    private updateCars(dt: number) {
        if (this.cars.length === 0) {
            return;
        }
        this.rebuildCarSpatialIndex();
        const cellSize = this.spatialCellSize;
        for (let i = this.cars.length - 1; i >= 0; i--) {
            const car = this.cars[i];
            const previousKey = this.cellKey(Math.floor(car.position.x / cellSize), Math.floor(car.position.y / cellSize));
            if (car.targetIndex >= car.path.length) {
                this.removeCarAt(i, previousKey);
                continue;
            }
            const target = car.path[car.targetIndex];
            const toTargetX = target.x - car.position.x;
            const toTargetY = target.y - car.position.y;
            const distance = Math.hypot(toTargetX, toTargetY);
            if (distance < 2) {
                car.position.copy(target);
                car.targetIndex += 1;
                if (car.targetIndex >= car.path.length) {
                    this.removeCarAt(i, previousKey);
                    continue;
                }
                const newKey = this.cellKey(Math.floor(car.position.x / cellSize), Math.floor(car.position.y / cellSize));
                this.moveCarInSpatialIndex(car, previousKey, newKey);
                continue;
            }
            const invDistance = 1 / distance;
            car.heading.set(toTargetX * invDistance, toTargetY * invDistance);
            const nearby = this.gatherNearbyCars(car);
            const desiredSpeed = this.computeDesiredSpeed(car, nearby);
            car.targetSpeed = desiredSpeed;
            const speedBlend = Phaser.Math.Clamp(1 - Math.exp(-dt / this.speedSmoothingTime), 0, 1);
            car.currentSpeed = Phaser.Math.Linear(car.currentSpeed, car.targetSpeed, speedBlend);
            const moveDistance = Math.min(car.currentSpeed * dt, distance);
            car.position.x += car.heading.x * moveDistance;
            car.position.y += car.heading.y * moveDistance;
            car.sprite.setPosition(car.position.x, car.position.y);
            car.sprite.setRotation(Math.atan2(car.heading.y, car.heading.x));
            const newKey = this.cellKey(Math.floor(car.position.x / cellSize), Math.floor(car.position.y / cellSize));
            this.moveCarInSpatialIndex(car, previousKey, newKey);
        }
    }

    private computeDesiredSpeed(car: Car, nearby: readonly Car[]) {
        let desired = car.maxSpeed;
        const headingX = car.heading.x;
        const headingY = car.heading.y;
        for (const other of nearby) {
            if (other === car)
                continue;
            const relX = other.position.x - car.position.x;
            const relY = other.position.y - car.position.y;
            const forwardness = relX * headingX + relY * headingY;
            if (forwardness <= 0)
                continue;
            const lateral = Math.abs(relX * headingY - relY * headingX);
            if (lateral > car.width * 0.9)
                continue;
            const safeDistance = Math.max(car.length * 1.5, car.currentSpeed * 0.6 + 20);
            if (forwardness < safeDistance) {
                desired = Math.min(desired, Math.max(20, other.currentSpeed - 10));
            }
        }
        return desired;
    }

    private removeCarAt(index: number, spatialKeyHint?: string) {
        const [car] = this.cars.splice(index, 1);
        this.removeCarFromSpatialIndex(car, spatialKeyHint);
        car.sprite.destroy();
        this.refreshHud(true);
    }
    private clearCars() {
        for (const car of this.cars) {
            car.sprite.destroy();
        }
        this.cars = [];
        this.carSpatialIndex.clear();
        this.carId = 0;
        this.refreshHud(true);
    }

    private resetMap() {
        for (let y = 0; y < this.gridHeight; y++) {
            for (let x = 0; x < this.gridWidth; x++) {
                this.grid[y][x] = 0;
                this.walkMatrix[y][x] = 1;
            }
        }
        this.spawnPoints.clear();
        this.rebuildSpawnOrder();
        this.destinationPoints.clear();
        this.pathCache.clear();
        this.roadCount = 0;
        this.clearCars();
        this.seedSimpleRoads();
        this.forceRedraw();
        this.showFlash('Map reset', 2);
    }
    private seedSimpleRoads() {
        const midY = Math.floor(this.gridHeight / 2);
        const midX = Math.floor(this.gridWidth / 2);
        for (let x = 3; x < this.gridWidth - 3; x++) {
            this.setRoadValue(x, midY, 1);
        }
        for (let y = 3; y < this.gridHeight - 3; y++) {
            this.setRoadValue(midX, y, 1);
        }
        const quarterX = Math.floor(this.gridWidth * 0.25);
        const threeQuarterX = Math.floor(this.gridWidth * 0.75);
        for (let y = midY - 6; y <= midY + 6; y++) {
            this.setRoadValue(quarterX, y, 1);
            this.setRoadValue(threeQuarterX, y, 1);
        }
        const keyPoints: GridPoint[] = [
            { x: midX, y: 4 },
            { x: midX, y: this.gridHeight - 5 },
            { x: 4, y: midY },
            { x: this.gridWidth - 5, y: midY }
        ];
        for (const point of keyPoints) {
            this.setRoadValue(point.x, point.y, 1);
        }
        this.spawnPoints.set(this.cellKey(midX, 4), { x: midX, y: 4 });
        this.spawnPoints.set(this.cellKey(4, midY), { x: 4, y: midY });
        this.destinationPoints.set(this.cellKey(midX, this.gridHeight - 5), { x: midX, y: this.gridHeight - 5 });
        this.destinationPoints.set(this.cellKey(this.gridWidth - 5, midY), { x: this.gridWidth - 5, y: midY });
        this.rebuildSpawnOrder();
    }
    private forceRedraw() {
        this.needsRedraw = false;
        this.redrawGrid();
        this.renderPointerHighlight();
        this.refreshHud(true);
    }
    private setActiveTool(tool: Tool) {
        if (this.activeTool === tool)
            return;
        this.activeTool = tool;
        this.activePaintValue = null;
        this.renderPointerHighlight();
        this.showFlash(`Tool: ${this.getToolLabel(tool)}`, 1.2);
    }
    private getToolLabel(tool: Tool = this.activeTool) {
        switch (tool) {
            case TOOL.Road:
                return 'Road';
            case TOOL.Erase:
                return 'Erase';
            case TOOL.Spawn:
                return 'Spawn';
            case TOOL.Destination:
                return 'Destination';
            default:
                return '';
        }
    }
    private refreshHud(force = false) {
        if (!this.hudText)
            return;
        if (force)
            this.statusTimer = 0;
        const brushLabel = `${this.brushSize}x${this.brushSize}`;
        const autoLabel = this.autoSpawn ? 'ON' : 'OFF';
        const intervalLabel = `${this.spawnInterval.toFixed(1)}s`;
        const fps = Math.round(this.game.loop.actualFps || 0);
        const lines = [
            `Tool: ${this.getToolLabel()} | Brush: ${brushLabel}`,
            `Road tiles: ${this.roadCount} | Spawns: ${this.spawnPoints.size} | Destinations: ${this.destinationPoints.size}`,
            `Cars: ${this.cars.length} | Auto spawn: ${autoLabel} (${intervalLabel})`,
            `FPS : ${fps}`
        ];
        if (this.flashMessage) {
            lines.push(this.flashMessage);
        }
        this.hudText.setText(lines.join('\n'));
        this.updateUiLayout();
    }
    private updateUiLayout() {
        if (!this.infoText || !this.hudText)
            return;
        const cam = this.cameras.main;
        const zoom = cam.zoom || 1;
        const invZoom = 1 / zoom;
        const marginX = 12 * invZoom;
        const marginY = 12 * invZoom;
        const spacing = 10 * invZoom;
        this.infoText.setScale(invZoom);
        this.hudText.setScale(invZoom);
        const baseX = marginX;
        const baseY = marginY;
        this.infoText.setPosition(baseX, baseY);
        const infoHeight = this.infoText.displayHeight;
        this.hudText.setPosition(baseX, baseY + infoHeight + spacing);
    }

    private showFlash(message: string, duration = 2) {
        this.flashMessage = message;
        this.flashTimer = duration;
        this.refreshHud(true);
    }
}
const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: 'app',
    backgroundColor: '#101216',
    scene: [GameScene],
    scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    render: {
        antialias: true,
        pixelArt: false
    }
};
new Phaser.Game(config);


