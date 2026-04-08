import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  signal
} from '@angular/core';
import { Application, Container, Graphics, Text, TextStyle, Texture } from 'pixi.js';

type TileVisualState = 'normal' | 'selected' | 'matched' | 'hint' | 'error';

type MahjongTile = {
  id: number;
  pairId: number;
  label: string;
  container: Container;
  face: Graphics;
  shadow: Graphics;
  side: Graphics;
  text: Text;
  matched: boolean;
  state: TileVisualState;
  baseX: number;
  baseY: number;
  animating: boolean;
};

@Component({
  selector: 'mahjong-board',
  standalone: true,
  templateUrl: './mahjong-board.component.html',
  styleUrl: './mahjong-board.component.css'
})
export class MahjongBoardComponent implements AfterViewInit, OnDestroy {
  @ViewChild('pixiRoot', { static: true })
  private readonly pixiRoot?: ElementRef<HTMLDivElement>;

  private readonly tileConfig = {
    cols: 5,
    rows: 6,
    size: 72,
    heightRatio: 1.1,
    gap: 12,
    radius: 12
  };

  private readonly consentKey = 'docs-accepts-cookies';
  protected readonly hasConsent = signal(this.readConsent());
  private pixiApp?: Application;
  private tileContainer?: Container;
  private tiles: MahjongTile[] = [];
  private selectedTiles: MahjongTile[] = [];
  private interactionLocked = false;
  private mismatchTimeout?: number;
  private hintTimeout?: number;
  private activeAnimations = new Map<number, number>();
  private resizeTimeout?: number;
  private tileTextureCache?: {
    width: number;
    height: number;
    border: Texture;
    inner: Texture;
  };

  protected acceptCookies(): void {
    try {
      localStorage.setItem(this.consentKey, 'true');
    } catch {
      // Ignore storage errors (e.g. privacy mode).
    }
    this.hasConsent.set(true);
  }

  private readConsent(): boolean {
    try {
      return localStorage.getItem(this.consentKey) === 'true';
    } catch {
      return false;
    }
  }

  async ngAfterViewInit(): Promise<void> {
    await this.initPixi();
  }

  ngOnDestroy(): void {
    if (this.mismatchTimeout) {
      window.clearTimeout(this.mismatchTimeout);
    }
    if (this.hintTimeout) {
      window.clearTimeout(this.hintTimeout);
    }
    for (const frame of this.activeAnimations.values()) {
      cancelAnimationFrame(frame);
    }
    this.activeAnimations.clear();
    if (this.resizeTimeout) {
      window.clearTimeout(this.resizeTimeout);
    }
    window.removeEventListener('resize', this.handleWindowResize);
    this.resetTileTextures();
    if (this.pixiApp) {
      this.pixiApp.destroy(true, { children: true });
    }
  }

  private async initPixi(): Promise<void> {
    if (!this.pixiRoot) {
      return;
    }

    const host = this.pixiRoot.nativeElement;
    const width = Math.max(host.clientWidth, 320);
    const height = Math.max(host.clientHeight, 240);

    const app = new Application();
    await app.init({
      width,
      height,
      backgroundAlpha: 0,
      antialias: true
    });
    app.ticker.stop();
    app.ticker.autoStart = false;

    const canvas = (app as unknown as { canvas?: HTMLCanvasElement; view?: HTMLCanvasElement })
      .canvas ?? (app as unknown as { view?: HTMLCanvasElement }).view;

    if (canvas) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      host.appendChild(canvas);
    }

    this.pixiApp = app;

    this.newGame();
    if (this.tileContainer) {
      app.stage.addChild(this.tileContainer);
      this.layoutTiles(this.tileContainer, width, height);
    }
    this.renderFrame();
    window.addEventListener('resize', this.handleWindowResize);
  }

  protected newGame(): void {
    if (!this.pixiApp) {
      return;
    }
    if (this.tileContainer) {
      this.pixiApp.stage.removeChild(this.tileContainer);
      this.tileContainer.destroy({ children: true });
    }
    this.tiles = [];
    this.selectedTiles = [];
    this.interactionLocked = false;
    this.activeAnimations.clear();
    this.tileContainer = this.buildMahjongTiles();
    this.pixiApp.stage.addChild(this.tileContainer);
    const host = this.pixiRoot?.nativeElement;
    if (host) {
      const width = Math.max(host.clientWidth, 320);
      const height = Math.max(host.clientHeight, 240);
      this.layoutTiles(this.tileContainer, width, height);
    }
    this.renderFrame();
  }

  protected shuffleTiles(): void {
    if (this.interactionLocked || this.tiles.length === 0) {
      return;
    }
    this.clearSelection();
    this.shuffleArray(this.tiles);
    this.positionTiles();
    this.renderFrame();
  }

  protected suggestMove(): void {
    if (this.interactionLocked) {
      return;
    }
    this.clearTemporaryHighlights();
    const pairs = new Map<number, MahjongTile[]>();
    for (const tile of this.tiles) {
      if (tile.matched) {
        continue;
      }
      const list = pairs.get(tile.pairId) ?? [];
      list.push(tile);
      pairs.set(tile.pairId, list);
    }
    const hintPair = Array.from(pairs.values()).find((list) => list.length >= 2);
    if (!hintPair) {
      return;
    }
    const [first, second] = hintPair;
    this.applyTileState(first, 'hint');
    this.applyTileState(second, 'hint');
    this.renderFrame();
    this.hintTimeout = window.setTimeout(() => {
      this.applyTileState(first, 'normal');
      this.applyTileState(second, 'normal');
      this.renderFrame();
    }, 1200);
  }

  private buildMahjongTiles(): Container {
    const container = new Container();
    const tileLabelStyle = new TextStyle({
      fontFamily: 'Space Mono, monospace',
      fontSize: 18,
      fill: 0x1f2937
    });
    const labels = this.buildLabels();
    const pairIds: number[] = [];
    for (let i = 0; i < labels.length; i += 1) {
      pairIds.push(i, i);
    }
    this.shuffleArray(pairIds);

    const totalTiles = this.tileConfig.cols * this.tileConfig.rows;
    for (let index = 0; index < totalTiles; index += 1) {
      const pairId = pairIds[index];
      const label = labels[pairId];
      const tile = this.createTile(index, pairId, label, tileLabelStyle);
      container.addChild(tile.container);
      this.tiles.push(tile);
    }

    this.positionTiles(container);
    return container;
  }

  private createTile(
    id: number,
    pairId: number,
    label: string,
    style: TextStyle
  ): MahjongTile {
    const container = new Container();
    const shadow = new Graphics();
    const side = new Graphics();
    const face = new Graphics();
    const text = new Text({ text: label, style });
    text.anchor.set(0.5);
    text.position.set(this.tileConfig.size / 2, this.tileConfig.size * 0.55);
    container.addChild(shadow, side, face, text);
    container.eventMode = 'static';
    container.cursor = 'pointer';
    const tile: MahjongTile = {
      id,
      pairId,
      label,
      container,
      face,
      shadow,
      side,
      text,
      matched: false,
      state: 'normal',
      baseX: 0,
      baseY: 0,
      animating: false
    };
    this.applyTileState(tile, 'normal');
    container.on('pointerdown', () => this.handleTileClick(tile));
    return tile;
  }

  private handleTileClick(tile: MahjongTile): void {
    if (this.interactionLocked || tile.matched) {
      return;
    }
    if (tile.animating) {
      return;
    }
    if (this.selectedTiles.length === 1 && this.selectedTiles[0].id === tile.id) {
      this.applyTileState(tile, 'normal');
      this.selectedTiles = [];
      this.renderFrame();
      return;
    }
    if (this.selectedTiles.length === 0) {
      this.selectedTiles = [tile];
      this.applyTileState(tile, 'selected');
      this.renderFrame();
      return;
    }
    const [first] = this.selectedTiles;
    this.selectedTiles.push(tile);
    if (first.pairId === tile.pairId) {
      this.markMatched(first, tile);
      this.selectedTiles = [];
      this.renderFrame();
      return;
    }
    this.showMismatch(first, tile);
  }

  private markMatched(first: MahjongTile, second: MahjongTile): void {
    this.interactionLocked = true;
    first.animating = true;
    second.animating = true;
    this.animateBreakApart(first, second);
  }

  private showMismatch(first: MahjongTile, second: MahjongTile): void {
    this.interactionLocked = true;
    this.applyTileState(first, 'error');
    this.applyTileState(second, 'error');
    this.animateMismatch(first, second);
  }

  private clearSelection(): void {
    for (const tile of this.selectedTiles) {
      if (!tile.matched) {
        this.applyTileState(tile, 'normal');
      }
    }
    this.selectedTiles = [];
    this.renderFrame();
  }

  private clearTemporaryHighlights(): void {
    if (this.hintTimeout) {
      window.clearTimeout(this.hintTimeout);
    }
    for (const tile of this.tiles) {
      if (!tile.matched && !this.selectedTiles.includes(tile)) {
        this.applyTileState(tile, 'normal');
      }
    }
    this.renderFrame();
  }

  private applyTileState(tile: MahjongTile, state: TileVisualState): void {
    const { size, heightRatio, radius } = this.tileConfig;
    const face = tile.face;
    const shadow = tile.shadow;
    const side = tile.side;
    face.clear();
    shadow.clear();
    side.clear();
    const baseFill = 0xffffff;
    let stroke = 0x0f172a;
    let strokeAlpha = 0.25;
    let strokeWidth = 1;
    let alpha = 1;
    let lift = 0;
    let scale = 1;
    let shadowOffset = { x: 4, y: 5 };
    let overlayColor: number | null = null;
    let overlayAlpha = 0;
    const { border, inner } = this.getTileTextures(size, heightRatio);
    if (state === 'selected') {
      stroke = 0xc026d3;
      strokeAlpha = 0.6;
      strokeWidth = 2;
      lift = -4;
      scale = 1.04;
    } else if (state === 'matched') {
      stroke = 0x94a3b8;
      strokeAlpha = 0.4;
      alpha = 0.55;
    } else if (state === 'hint') {
      stroke = 0xfacc15;
      strokeAlpha = 1;
      strokeWidth = 3;
      lift = -3;
      scale = 1.04;
      overlayColor = 0xfef08a;
      overlayAlpha = 0.35;
    } else if (state === 'error') {
      stroke = 0xdc2626;
      strokeAlpha = 1;
      strokeWidth = 3;
      scale = 1.06;
      shadowOffset = { x: 2, y: 2 };
    }
    const depth = 6;
    shadow.roundRect(0, 0, size, size * heightRatio, radius);
    shadow.fill({ color: 0x0f172a, alpha: 0.18 });
    shadow.position.set(shadowOffset.x, shadowOffset.y);

    side.roundRect(2, depth, size, size * heightRatio, radius);
    side.fill({ color: 0xd8cdbf, alpha: 0.9 });

    const borderWidth = Math.max(2, Math.floor(size * 0.06));
    const innerWidth = Math.max(1, size - borderWidth * 2);
    const innerHeight = Math.max(1, size * heightRatio - borderWidth * 2);
    const innerRadius = Math.max(4, radius - borderWidth);
    face.roundRect(0, 0, size, size * heightRatio, radius);
    face.fill({ texture: border });
    face.roundRect(borderWidth, borderWidth, innerWidth, innerHeight, innerRadius);
    face.fill({ color: baseFill });
    face.roundRect(borderWidth, borderWidth, innerWidth, innerHeight, innerRadius);
    face.fill({ texture: inner });
    if (overlayColor !== null && overlayAlpha > 0) {
      face.roundRect(borderWidth, borderWidth, innerWidth, innerHeight, innerRadius);
      face.fill({ color: overlayColor, alpha: overlayAlpha });
    }
    face.roundRect(0.5, 0.5, size - 1, size * heightRatio - 1, radius);
    face.stroke({ color: stroke, width: strokeWidth, alpha: strokeAlpha });
    face.position.set(0, 0);

    tile.container.alpha = alpha;
    tile.state = state;
    tile.container.eventMode = tile.matched ? 'none' : 'static';
    tile.container.visible = !tile.matched;

    if (!tile.animating) {
      tile.container.scale.set(scale);
      tile.container.position.set(tile.baseX, tile.baseY + lift);
    }
  }

  private positionTiles(container: Container = this.tileContainer ?? new Container()): void {
    const host = this.pixiRoot?.nativeElement;
    if (host) {
      this.fitTilesToHost(host.clientWidth, host.clientHeight);
    }
    const { cols, rows, size, heightRatio, gap } = this.tileConfig;
    this.tiles.forEach((tile, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      tile.baseX = col * (size + gap);
      tile.baseY = row * (size * heightRatio + gap);
      if (!tile.animating) {
        tile.container.position.set(tile.baseX, tile.baseY);
      }
    });
    const totalWidth = cols * size + (cols - 1) * gap;
    const totalHeight = rows * size * heightRatio + (rows - 1) * gap;
    container.pivot.set(totalWidth / 2, totalHeight / 2);
  }

  private buildLabels(): string[] {
    const labels: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      labels.push(String.fromCharCode(65 + i));
    }
    return labels;
  }

  private shuffleArray<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }

  private layoutTiles(container: Container, width: number, height: number): void {
    container.position.set(width / 2, height / 2);
  }

  private renderFrame(): void {
    if (this.pixiApp) {
      this.pixiApp.renderer.render(this.pixiApp.stage);
    }
  }


  private handleWindowResize = (): void => {
    if (this.resizeTimeout) {
      window.clearTimeout(this.resizeTimeout);
    }
    this.resizeTimeout = window.setTimeout(() => {
      const host = this.pixiRoot?.nativeElement;
      if (!host || !this.tileContainer || !this.pixiApp) {
        return;
      }
      const width = Math.max(host.clientWidth, 320);
      const height = Math.max(host.clientHeight, 240);
      this.pixiApp.renderer.resize(width, height);
      this.layoutTiles(this.tileContainer, width, height);
      this.renderFrame();
    }, 120);
  };

  private fitTilesToHost(hostWidth: number, hostHeight: number): void {
    const minSize = 44;
    const maxSize = 90;
    const { cols, rows, heightRatio, gap } = this.tileConfig;
    const padding = Math.max(14, Math.floor(Math.min(hostWidth, hostHeight) * 0.05));
    const usableWidth = Math.max(hostWidth - padding * 2 - (cols - 1) * gap, minSize);
    const usableHeight = Math.max(hostHeight - padding * 2 - (rows - 1) * gap, minSize);
    const sizeByWidth = usableWidth / cols;
    const sizeByHeight = usableHeight / (rows * heightRatio);
    const fitScale = 0.94;
    const nextSize = Math.max(
      minSize,
      Math.min(maxSize, Math.floor(Math.min(sizeByWidth, sizeByHeight) * fitScale))
    );
    if (nextSize === this.tileConfig.size) {
      return;
    }
    this.tileConfig.size = nextSize;
    this.tileConfig.radius = Math.max(8, Math.floor(nextSize * 0.18));
    this.resetTileTextures();

    const fontSize = Math.max(14, Math.floor(nextSize * 0.26));
    for (const tile of this.tiles) {
      tile.text.style = new TextStyle({
        fontFamily: 'Space Mono, monospace',
        fontSize,
        fill: 0x1f2937
      });
      tile.text.position.set(nextSize / 2, nextSize * 0.55);
      this.applyTileState(tile, tile.state);
    }
  }

  private animateMismatch(first: MahjongTile, second: MahjongTile): void {
    first.animating = true;
    second.animating = true;
    this.animateTilePair(first, second, 160, (t) => {
      const ease = this.easeOutCubic(t);
      const scale = 1 + 0.12 * ease;
      first.container.scale.set(scale);
      second.container.scale.set(scale);
    }, () => {
      this.animateTilePair(first, second, 200, (t) => {
        const ease = this.easeOutCubic(t);
        const scale = 1.12 - 0.12 * ease;
        first.container.scale.set(scale);
        second.container.scale.set(scale);
      }, () => {
        first.animating = false;
        second.animating = false;
        this.applyTileState(first, 'normal');
        this.applyTileState(second, 'normal');
        this.selectedTiles = [];
        this.interactionLocked = false;
        this.renderFrame();
      });
    });
  }

  private animateBreakApart(first: MahjongTile, second: MahjongTile): void {
    const startA = { x: first.container.position.x, y: first.container.position.y };
    const startB = { x: second.container.position.x, y: second.container.position.y };

    const centerX = (startA.x + startB.x) / 2;
    const centerY = (startA.y + startB.y) / 2;
    const dirA = this.normalizeVec(startA.x - centerX, startA.y - centerY);
    const dirB = this.normalizeVec(startB.x - centerX, startB.y - centerY);
    const distance = this.tileConfig.size * 0.85;

    this.animateTilePair(first, second, 260, (t) => {
      const ease = this.easeOutCubic(t);
      first.container.position.set(
        startA.x + (centerX - startA.x) * ease,
        startA.y + (centerY - startA.y) * ease
      );
      second.container.position.set(
        startB.x + (centerX - startB.x) * ease,
        startB.y + (centerY - startB.y) * ease
      );
      const scale = 1 + 0.12 * ease;
      first.container.scale.set(scale);
      second.container.scale.set(scale);
      first.container.alpha = 1;
      second.container.alpha = 1;
    }, () => {
      this.animateTilePair(first, second, 520, (t) => {
        const ease = this.easeOutCubic(t);
        const moveA = distance * ease;
        const moveB = distance * ease;
        first.container.position.set(centerX + dirA.x * moveA, centerY + dirA.y * moveA);
        second.container.position.set(centerX + dirB.x * moveB, centerY + dirB.y * moveB);
        first.container.rotation = 0.25 * ease;
        second.container.rotation = -0.25 * ease;
        const scale = 1 - 0.35 * ease;
        first.container.scale.set(scale);
        second.container.scale.set(scale);
        first.container.alpha = 1 - ease;
        second.container.alpha = 1 - ease;
      }, () => {
        first.matched = true;
        second.matched = true;
        first.animating = false;
        second.animating = false;
        first.container.visible = false;
        second.container.visible = false;
        first.container.rotation = 0;
        second.container.rotation = 0;
        this.applyTileState(first, 'matched');
        this.applyTileState(second, 'matched');
        this.selectedTiles = [];
        this.interactionLocked = false;
        this.renderFrame();
      });
    });
  }

  private animateTilePair(
    first: MahjongTile,
    second: MahjongTile,
    duration: number,
    onFrame: (t: number) => void,
    onDone?: () => void
  ): void {
    this.cancelTileAnimation(first);
    this.cancelTileAnimation(second);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      onFrame(t);
      this.renderFrame();
      if (t < 1) {
        const frame = requestAnimationFrame(tick);
        this.activeAnimations.set(first.id, frame);
        this.activeAnimations.set(second.id, frame);
      } else {
        this.activeAnimations.delete(first.id);
        this.activeAnimations.delete(second.id);
        onDone?.();
      }
    };
    const frame = requestAnimationFrame(tick);
    this.activeAnimations.set(first.id, frame);
    this.activeAnimations.set(second.id, frame);
  }

  private cancelTileAnimation(tile: MahjongTile): void {
    const frame = this.activeAnimations.get(tile.id);
    if (frame) {
      cancelAnimationFrame(frame);
      this.activeAnimations.delete(tile.id);
    }
  }

  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  private normalizeVec(x: number, y: number): { x: number; y: number } {
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
  }

  private getTileTextures(size: number, heightRatio: number): { border: Texture; inner: Texture } {
    const width = Math.max(1, Math.round(size));
    const height = Math.max(1, Math.round(size * heightRatio));
    if (this.tileTextureCache && this.tileTextureCache.width === width && this.tileTextureCache.height === height) {
      return { border: this.tileTextureCache.border, inner: this.tileTextureCache.inner };
    }
    if (this.tileTextureCache) {
      this.tileTextureCache.border.destroy(true);
      this.tileTextureCache.inner.destroy(true);
    }
    const border = this.createLinearGradientTexture(width, height, 120, [
      { offset: 0, color: '#8b5cf6' },
      { offset: 0.33, color: '#ec4899' },
      { offset: 0.66, color: '#7dd3fc' },
      { offset: 1, color: '#facc15' }
    ]);
    const inner = this.createLinearGradientTexture(width, height, 180, [
      { offset: 0, color: 'rgba(255, 255, 255, 0.04)' },
      { offset: 1, color: 'rgba(255, 255, 255, 0.01)' }
    ]);
    this.tileTextureCache = { width, height, border, inner };
    return { border, inner };
  }

  private resetTileTextures(): void {
    if (!this.tileTextureCache) {
      return;
    }
    this.tileTextureCache.border.destroy(true);
    this.tileTextureCache.inner.destroy(true);
    this.tileTextureCache = undefined;
  }

  private createLinearGradientTexture(
    width: number,
    height: number,
    angle: number,
    stops: Array<{ offset: number; color: string }>
  ): Texture {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return Texture.from(canvas);
    }
    const rad = (angle - 90) * (Math.PI / 180);
    const cx = width / 2;
    const cy = height / 2;
    const dx = Math.cos(rad) * Math.max(width, height) / 2;
    const dy = Math.sin(rad) * Math.max(width, height) / 2;
    const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    for (const stop of stops) {
      gradient.addColorStop(stop.offset, stop.color);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    return Texture.from(canvas);
  }
}
