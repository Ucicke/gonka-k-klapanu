import vesselBackgroundUrl from "./assets/vessel-background-v2.png";
import bloodSpriteAtlasUrl from "./assets/blood-sprite-atlas.png";

type PickupKind = "cell" | "platelet" | "plasmin";
type HazardKind = "fibrin" | "leukocyte";
type GameState = "ready" | "countdown" | "racing" | "finished";

export interface GameInput {
  isDown(code: string): boolean;
  wasPressed(code: string): boolean;
}

export interface GameSize {
  width: number;
  height: number;
}

interface Racer {
  id: string;
  name: string;
  color: string;
  progress: number;
  worldX: number;
  previousProgress: number;
  previousWorldX: number;
  recoilSpeed: number;
  lateralVelocity: number;
  angle: number;
  speed: number;
  mass: number;
  baseSpeed: number;
  boostSeconds: number;
  stickyCharges: number;
  collisionCooldown: number;
  abilityCooldown: number;
  offroad: boolean;
  isPlayer: boolean;
}

interface Pickup {
  id: number;
  progress: number;
  offset: number;
  kind: PickupKind;
  collected: boolean;
}

interface Hazard {
  id: number;
  progress: number;
  offset: number;
  kind: HazardKind;
  cleared: boolean;
  passedBy: Set<string>;
}

interface Plaque {
  id: number;
  progress: number;
  side: -1 | 1;
  radius: number;
  passedBy: Set<string>;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  color: string;
}

interface BolidProfile {
  name: string;
  color: string;
  speed: number;
  acceleration: number;
  handling: number;
  impact: number;
}

const RACE_LENGTH = 36_000;
const ROAD_WIDTH = 560;
const SPEED_FEEL_REFERENCE = 330;
const SPRITE_SIZE = 320;
const BOLID_PROFILES: readonly BolidProfile[] = [
  { name: "ТАРАН", color: "#ff6f78", speed: 1.12, acceleration: 1, handling: 0.88, impact: 1.12 },
  { name: "ИМПУЛЬС", color: "#68e5ff", speed: 1, acceleration: 1.12, handling: 1.12, impact: 0.88 },
  { name: "СГУСТОК", color: "#ffd16d", speed: 0.88, acceleration: 1.12, handling: 1, impact: 1.12 },
  { name: "БАЛАНС", color: "#c58cff", speed: 1, acceleration: 1, handling: 1, impact: 1 },
];

const STAT_TWEEN_DURATION = 0.52;
const PICKUP_FEEDBACK_DURATION = 0.68;

function makeRacer(
  id: string,
  name: string,
  color: string,
  baseSpeed: number,
  isPlayer = false,
): Racer {
  return {
    id,
    name,
    color,
    progress: 0,
    worldX: 0,
    previousProgress: 0,
    previousWorldX: 0,
    recoilSpeed: 0,
    lateralVelocity: 0,
    angle: 0,
    speed: 0,
    mass: 1,
    baseSpeed,
    boostSeconds: 0,
    stickyCharges: 0,
    collisionCooldown: 0,
    abilityCooldown: 0,
    offroad: false,
    isPlayer,
  };
}

export class Game {
  private size: GameSize;
  private state: GameState = "ready";
  private animationTime = 0;
  private raceSeconds = 0;
  private countdownSeconds = 3;
  private finishSeconds = 0;
  private drafting = false;
  private lastPlace = 7;
  private placePulse = 0;
  private statTweenSeconds = 0;
  private statTweenFrom: BolidProfile = BOLID_PROFILES[0];
  private statTweenTarget: BolidProfile = BOLID_PROFILES[0];
  private bonusPulseSeconds = 0;
  private bonusPulseColor = BOLID_PROFILES[0].color;
  private lastStenosisToast = -1;
  private readonly background = new Image();
  private readonly spriteAtlas = new Image();
  private readonly player = makeRacer("player", "ТЫ", "#ff6f78", 0, true);
  private rivals: Racer[] = [];
  private pickups: Pickup[] = [];
  private hazards: Hazard[] = [];
  private plaques: Plaque[] = [];
  private particles: Particle[] = [];
  private winner: Racer | null = null;
  private toast = "";
  private toastSeconds = 0;
  private tetheredRival: string | null = null;
  private tetherSeconds = 0;
  private shakeSeconds = 0;
  private shakeStrength = 0;
  private selectedProfileIndex = 0;
  private cellCount = 0;
  private plateletCount = 0;
  private plasminSeconds = 0;
  private wallCooldown = 0;

  constructor(
    private readonly context: CanvasRenderingContext2D,
    private readonly input: GameInput,
    size: GameSize,
  ) {
    this.size = size;
    this.background.src = vesselBackgroundUrl;
    this.spriteAtlas.src = bloodSpriteAtlasUrl;
    this.resetRace();
  }

  resize(size: GameSize): void {
    this.size = size;
  }

  update(deltaSeconds: number): void {
    const dt = Math.min(deltaSeconds, 0.05);
    this.animationTime += dt;
    this.toastSeconds = Math.max(0, this.toastSeconds - dt);
    this.tetherSeconds = Math.max(0, this.tetherSeconds - dt);
    this.placePulse = Math.max(0, this.placePulse - dt);
    this.statTweenSeconds = Math.max(0, this.statTweenSeconds - dt);
    this.bonusPulseSeconds = Math.max(0, this.bonusPulseSeconds - dt);
    this.shakeSeconds = Math.max(0, this.shakeSeconds - dt);
    if (this.shakeSeconds === 0) this.shakeStrength = 0;
    this.updateParticles(dt);

    if (this.state === "ready") {
      const profileStep = Number(this.input.wasPressed("KeyD") || this.input.wasPressed("ArrowRight"))
        - Number(this.input.wasPressed("KeyA") || this.input.wasPressed("ArrowLeft"));
      if (profileStep !== 0) {
        this.selectedProfileIndex = (this.selectedProfileIndex + profileStep + BOLID_PROFILES.length) % BOLID_PROFILES.length;
        this.syncPlayerStats();
      }
      if (this.input.wasPressed("Enter") || this.input.wasPressed("Space")) {
        this.countdownSeconds = 3;
        this.state = "countdown";
      }
      return;
    }

    if (this.state === "countdown") {
      this.countdownSeconds = Math.max(0, this.countdownSeconds - dt);
      if (this.countdownSeconds === 0) {
        this.state = "racing";
      }
      return;
    }

    if (this.state === "finished") {
      this.finishSeconds += dt;
      if (this.input.wasPressed("Enter") || this.input.wasPressed("KeyR")) {
        this.resetRace();
      }
      return;
    }

    this.raceSeconds += dt;
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    if (this.plasminSeconds > 0) {
      this.plasminSeconds = Math.max(0, this.plasminSeconds - dt);
      if (this.plasminSeconds === 0) this.showToast("ПЛАЗМИН ИСЧЁЗ: ПРОФИЛЬ И УСИЛЕНИЯ СОХРАНЕНЫ");
    }
    for (const racer of [this.player, ...this.rivals]) {
      racer.previousProgress = racer.progress;
      racer.previousWorldX = racer.worldX;
      racer.boostSeconds = Math.max(0, racer.boostSeconds - dt);
      racer.collisionCooldown = Math.max(0, racer.collisionCooldown - dt);
      racer.abilityCooldown = Math.max(0, racer.abilityCooldown - dt);
    }

    this.updatePlayer(dt);
    this.updateRivals(dt);
    this.collectPickups();
    this.updateHazards();
    this.updatePlaques();
    this.checkCollision();
    this.updatePlaceFeedback();
    this.checkFinish();
  }

  render(): void {
    const { context } = this;
    context.save();
    if (this.shakeSeconds > 0) {
      const intensity = this.shakeSeconds / 0.24;
      context.translate(
        (Math.random() - 0.5) * this.shakeStrength * intensity,
        (Math.random() - 0.5) * this.shakeStrength * intensity,
      );
    }
    this.drawBackground();
    const finishBlend = this.playerFinishBlend;
    context.save();
    context.globalAlpha = 1 - finishBlend;
    this.drawRoad();
    this.drawVesselDetails();
    this.drawHazards();
    this.drawTrackGates();
    this.drawPickups();
    this.drawRacers();
    this.drawParticles();
    context.restore();
    context.restore();
    this.drawRaceVignettes();
    this.drawHud();

    if (this.toastSeconds > 0 && this.state === "racing") this.drawToast();
    if (this.state === "ready") this.drawReadyScreen();
    if (this.state === "countdown") this.drawCountdown();
    if (this.state === "finished") this.drawFinishScreen();
  }

  private resetRace(): void {
    this.cellCount = 0;
    this.plateletCount = 0;
    this.plasminSeconds = 0;
    this.wallCooldown = 0;
    this.player.progress = 0;
    this.player.worldX = this.courseCenter(0);
    this.player.previousProgress = this.player.progress;
    this.player.previousWorldX = this.player.worldX;
    this.player.recoilSpeed = 0;
    this.player.lateralVelocity = 0;
    this.player.angle = this.courseAngle(0);
    this.player.speed = 0;
    this.player.mass = 1;
    this.player.boostSeconds = 0;
    this.player.stickyCharges = 0;
    this.player.collisionCooldown = 0;
    this.player.abilityCooldown = 0;
    this.player.offroad = false;
    this.drafting = false;
    this.lastPlace = this.rivals.length + 1;
    this.placePulse = 0;
    this.statTweenSeconds = 0;
    this.bonusPulseSeconds = 0;
    this.lastStenosisToast = -1;

    const rivals = [
      ["rival-a", "ИСКРА", "#ffd16d", 326],
      ["rival-b", "СГУСТОК", "#c58cff", 321],
      ["rival-c", "ПУЛЬС", "#68e5ff", 315],
      ["rival-d", "ФИБРА", "#f47cf3", 310],
      ["rival-e", "МИКРОБ", "#a6f274", 304],
      ["rival-f", "БЕЛЯК", "#fff0db", 299],
    ] as const;
    this.rivals = rivals.map(([id, name, color, speed]) => makeRacer(id, name, color, speed));
    const gridOffsets = [-225, -150, -75, 75, 150, 225];
    for (const [index, rival] of this.rivals.entries()) {
      rival.progress = 0;
      rival.worldX = this.courseCenter(rival.progress) + gridOffsets[index];
      rival.previousProgress = rival.progress;
      rival.previousWorldX = rival.worldX;
      rival.angle = this.courseAngle(rival.progress);
    }

    const kinds: PickupKind[] = ["cell", "platelet", "cell", "plasmin", "platelet", "cell", "plasmin"];
    const pickupCount = Math.floor((RACE_LENGTH - 500) / 710);
    this.pickups = Array.from({ length: pickupCount }, (_, index) => {
      const progress = 520 + index * 710 + this.hash01(index, 6) * 130;
      const kind = kinds[index % kinds.length];
      return {
        id: index,
        progress,
        offset: this.pickupOffset(kind, index, progress),
        kind,
        collected: false,
      };
    });

    const hazardSpacing = 1180;
    const hazardCount = Math.floor((RACE_LENGTH - 800) / hazardSpacing);
    this.hazards = Array.from({ length: hazardCount }, (_, index) => {
      const progress = 900 + index * hazardSpacing + this.hash01(index, 8) * 220;
      return {
        id: index,
        progress,
        offset: (this.hash01(index, 9) * 2 - 1) * this.roadHalfWidth(progress) * 0.62,
        kind: index % 3 === 2 ? "leukocyte" : "fibrin",
        cleared: false,
        passedBy: new Set<string>(),
      };
    });

    const plaqueCount = Math.floor(RACE_LENGTH / 875);
    this.plaques = Array.from({ length: plaqueCount }, (_, index) => {
      const id = (index + 1) * 7;
      const progress = id * 125 + this.hash01(id, 1) * 70;
      return {
        id,
        progress,
        side: this.hash01(id, 2) < 0.5 ? -1 : 1,
        radius: 68 + this.hash01(id, 3) * 42,
        passedBy: new Set<string>(),
      };
    });

    this.winner = null;
    this.toast = "";
    this.toastSeconds = 0;
    this.tetheredRival = null;
    this.tetherSeconds = 0;
    this.raceSeconds = 0;
    this.finishSeconds = 0;
    this.particles = [];
    this.shakeSeconds = 0;
    this.shakeStrength = 0;
    this.syncPlayerStats();
    this.state = "ready";
  }

  private updatePlayer(dt: number): void {
    this.syncPlayerStats();
    const stats = this.effectivePlayerStats;
    const accelerate = this.input.isDown("ArrowUp") || this.input.isDown("KeyW");
    const brake = this.input.isDown("ArrowDown") || this.input.isDown("KeyS");
    const steer = Number(this.input.isDown("ArrowRight") || this.input.isDown("KeyD"))
      - Number(this.input.isDown("ArrowLeft") || this.input.isDown("KeyA"));

    if (steer !== 0) {
      const speedRatio = Math.min(1, this.player.speed / SPEED_FEEL_REFERENCE);
      const steeringRate = (0.28 + speedRatio) * 1.35 * stats.handling / Math.sqrt(this.player.mass);
      this.player.angle += steer * steeringRate * dt;
      this.player.angle = Math.max(-1.05, Math.min(1.05, this.player.angle));
    }

    if (accelerate) {
      this.player.speed += (42 * stats.acceleration / Math.sqrt(this.player.mass)) * dt;
    } else {
      this.player.speed = Math.max(0, this.player.speed - 24 * dt);
    }
    if (brake) this.player.speed = Math.max(0, this.player.speed - 540 * dt);
    if (this.player.boostSeconds > 0) this.player.speed += 150 * dt;

    this.drafting = accelerate && this.rivals.some((rival) =>
      rival.progress > this.player.progress
      && rival.progress - this.player.progress < 290
      && Math.abs(rival.worldX - this.player.worldX) < 132,
    );
    if (this.drafting) this.player.speed += 58 * dt;

    // Speed has no ceiling; mass reduces how quickly the clot accelerates.
    const forwardSpeed = this.player.speed * stats.speed * dt;
    const drift = Math.exp(-4.5 * dt);
    this.player.worldX += Math.sin(this.player.angle) * forwardSpeed + this.player.lateralVelocity * dt;
    this.player.progress += Math.cos(this.player.angle) * forwardSpeed + this.player.recoilSpeed * dt;
    this.player.lateralVelocity *= drift;
    this.player.recoilSpeed *= drift;
    this.player.progress = Math.max(0, Math.min(RACE_LENGTH, this.player.progress));

    const roadHalfWidth = this.roadHalfWidth(this.player.progress);
    const nearestStenosis = Math.round((this.player.progress - 2_600) / 6_200);
    if (nearestStenosis !== this.lastStenosisToast
      && Math.abs(this.player.progress - this.stenosisCenter(nearestStenosis)) < 850) {
      this.lastStenosisToast = nearestStenosis;
      this.showToast("СТЕНОЗ");
    }
    const courseCenter = this.courseCenter(this.player.progress);
    const wallLimit = Math.max(0, roadHalfWidth - 30);
    const lateralOffset = this.player.worldX - courseCenter;
    const hitWall = Math.abs(lateralOffset) > wallLimit;
    if (hitWall) {
      const side = Math.sign(lateralOffset) || 1;
      this.player.worldX = courseCenter + side * wallLimit;
      if (this.player.lateralVelocity * side > 0) this.player.lateralVelocity = 0;
      this.player.recoilSpeed = Math.max(0, this.player.recoilSpeed);
      const outwardHeading = this.player.angle * side;
      if (outwardHeading > 0) {
        this.player.angle = -side * Math.min(0.48, 0.2 + outwardHeading * 0.35);
      }
      if (this.wallCooldown === 0) {
        this.player.speed *= 0.82;
        this.wallCooldown = 0.35;
        this.triggerImpact(2);
        this.showToast("СТЕНКА: СКОРОСТЬ −18%");
      }
    }
    const roadOffset = Math.abs(this.player.worldX - courseCenter);
    this.player.offroad = roadOffset > roadHalfWidth - 32 && !hitWall;
    if (this.player.offroad) {
      const friction = roadOffset > roadHalfWidth + 65 ? 2.8 : 1.15;
      this.player.speed *= Math.exp(-friction * dt);
    }

    if (this.input.wasPressed("Space") && this.player.stickyCharges > 0) {
      this.activateSticky(this.player, this.rivals);
    }
  }

  private updateRivals(dt: number): void {
    for (const [index, rival] of this.rivals.entries()) {
      const massFactor = 1 / Math.sqrt(rival.mass);
      const boost = rival.boostSeconds > 0 ? 90 : 0;
      rival.speed = rival.baseSpeed * massFactor + boost;
      const drift = Math.exp(-4.5 * dt);
      rival.progress = Math.max(0, Math.min(RACE_LENGTH, rival.progress + (rival.speed + rival.recoilSpeed) * dt));
      const laneLimit = this.roadHalfWidth(rival.progress) * 0.72;
      const lanePreference = ((index % 3) - 1) * Math.min(150, laneLimit);
      const offset = Math.max(-laneLimit, Math.min(laneLimit, lanePreference + Math.sin(rival.progress / 1300 + index) * 40));
      const targetX = this.courseCenter(rival.progress) + offset;
      rival.worldX += (targetX - rival.worldX) * Math.min(1, dt * 6) + rival.lateralVelocity * dt;
      rival.lateralVelocity *= drift;
      rival.recoilSpeed *= drift;
      rival.angle = this.courseAngle(rival.progress);

      if (rival.stickyCharges > 0 && rival.abilityCooldown === 0) {
        this.activateSticky(rival, [this.player, ...this.rivals.filter((other) => other !== rival)]);
        rival.abilityCooldown = 2;
      }
    }
  }

  private activateSticky(racer: Racer, targets: Racer[]): void {
    racer.stickyCharges -= 1;
    const target = targets
      .filter((other) =>
        other.progress > racer.progress
        && other.progress - racer.progress < 600
        && Math.abs(other.worldX - racer.worldX) < 210,
      )
      .sort((a, b) => a.progress - b.progress)[0];

    if (target) {
      target.speed *= 0.72;
      target.recoilSpeed -= 92;
      target.lateralVelocity += Math.sign(target.worldX - racer.worldX || 1) * 90;
      this.tetheredRival = target.id;
      this.tetherSeconds = 0.85;
      if (racer.isPlayer) this.showToast("ТРОМБОВЫЙ БРОСОК");
    } else {
      racer.boostSeconds = Math.max(racer.boostSeconds, 2.1);
      if (racer.isPlayer) this.showToast("РЫВОК");
    }
  }

  private collectPickups(): void {
    for (const pickup of this.pickups) {
      if (pickup.collected) continue;
      const pickupX = this.courseCenter(pickup.progress) + pickup.offset;
      const collector = [this.player, ...this.rivals]
        .find((racer) => this.pathIntersectsPoint(racer, pickup.progress, pickupX, 48, 76));
      if (!collector) continue;

      pickup.collected = true;
      if (collector.isPlayer) {
        const color = pickup.kind === "cell" ? "#ff6a82" : pickup.kind === "platelet" ? "#ffd36a" : "#8cfff4";
        this.spawnBurst(this.screenX(pickupX, pickup.progress), this.screenY(pickup.progress), color, 14);
      }
      this.applyPickup(collector, pickup.kind);
    }
  }

  private updateHazards(): void {
    const racers = [this.player, ...this.rivals];
    for (const hazard of this.hazards) {
      if (hazard.cleared) continue;
      const hazardX = this.courseCenter(hazard.progress) + hazard.offset;
      for (const racer of racers) {
        if (hazard.passedBy.has(racer.id)) continue;
        if (!this.pathIntersectsPoint(racer, hazard.progress, hazardX, 52, 66)) continue;
        hazard.passedBy.add(racer.id);
        racer.speed *= hazard.kind === "leukocyte" ? 0.54 : 0.68;
        racer.recoilSpeed -= hazard.kind === "leukocyte" ? 110 : 70;
        const awayFromObstacle = Math.sign(racer.worldX - hazardX) || (racer.isPlayer ? 1 : -1);
        racer.lateralVelocity += awayFromObstacle * 135;
        if (racer.isPlayer) {
          this.triggerImpact(4);
          this.spawnBurst(this.screenX(racer.worldX, racer.progress), this.screenY(racer.progress), "#cf82ff", 10);
          this.showToast(hazard.kind === "leukocyte" ? "ЛЕЙКОЦИТ" : "ФИБРИНОВАЯ СЕТЬ");
        }
      }
    }
  }

  private updatePlaques(): void {
    for (const plaque of this.plaques) {
      const plaqueX = this.courseCenter(plaque.progress)
        + plaque.side * (this.roadHalfWidth(plaque.progress) - 18);
      for (const racer of [this.player, ...this.rivals]) {
        if (plaque.passedBy.has(racer.id)) continue;
        if (!this.pathIntersectsPoint(racer, plaque.progress, plaqueX, plaque.radius * 0.85, plaque.radius * 0.78 + 24)) continue;
        plaque.passedBy.add(racer.id);
        racer.speed *= 0.62;
        racer.recoilSpeed -= 75;
        racer.lateralVelocity += (Math.sign(racer.worldX - plaqueX) || -plaque.side) * 210;
        if (racer.isPlayer) {
          this.triggerImpact(6);
          this.spawnBurst(this.screenX(plaqueX, plaque.progress), this.screenY(plaque.progress), "#ffd36a", 16);
          this.showToast("БЛЯШКА");
        }
      }
    }
  }

  private applyPickup(racer: Racer, kind: PickupKind): void {
    if (racer.isPlayer) {
      this.bonusPulseSeconds = PICKUP_FEEDBACK_DURATION;
      this.bonusPulseColor = kind === "cell" ? "#ff6a82" : kind === "platelet" ? "#ffd36a" : "#8cfff4";
      if (kind === "cell") {
        this.cellCount = Math.min(6, this.cellCount + 1);
        this.syncPlayerStats();
        this.showToast("КЛЕТКА: УДАР +0.20 НА ГОНКУ");
        return;
      }

      if (kind === "platelet") {
        this.plateletCount = Math.min(5, this.plateletCount + 1);
        racer.stickyCharges = Math.min(3, racer.stickyCharges + 1);
        this.syncPlayerStats();
        this.showToast("ТРОМБОЦИТ: УПРАВЛЕНИЕ +0.08, ЗАРЯД +1");
        return;
      }

      this.plasminSeconds = 3.2;
      this.syncPlayerStats();
      const nextFibrin = this.clearNearbyFibrin(racer);
      this.showToast(nextFibrin ? "ПЛАЗМИН: +14% СКОРОСТЬ, +22% РАЗГОН — 3.2 С; ФИБРИН ОЧИЩЕН" : "ПЛАЗМИН: +14% СКОРОСТЬ, +22% РАЗГОН — 3.2 С");
      return;
    }

    if (kind === "cell") {
      racer.mass = Math.min(3.2, racer.mass + 0.4);
      return;
    }

    if (kind === "platelet") {
      racer.stickyCharges = Math.min(3, racer.stickyCharges + 1);
      return;
    }

    racer.mass = Math.max(0.65, racer.mass - 0.55);
    racer.boostSeconds = Math.max(racer.boostSeconds, 3.2);
    this.clearNearbyFibrin(racer);
  }

  private clearNearbyFibrin(racer: Racer): boolean {
    const nextFibrin = this.hazards
      .filter((hazard) => !hazard.cleared && hazard.kind === "fibrin" && hazard.progress > racer.progress && hazard.progress - racer.progress < 1_800)
      .sort((a, b) => a.progress - b.progress)[0];
    if (nextFibrin) nextFibrin.cleared = true;
    return Boolean(nextFibrin);
  }

  private checkCollision(): void {
    if (this.player.collisionCooldown > 0) return;
    const rival = this.rivals.find((other) =>
      this.pathsIntersect(this.player, other, 52, 58),
    );
    if (!rival) return;

    this.player.collisionCooldown = 1;
    rival.collisionCooldown = 1;
    if (this.player.mass >= rival.mass + 0.2) {
      rival.speed *= 0.68;
      rival.recoilSpeed -= 150;
      rival.lateralVelocity += (Math.sign(rival.worldX - this.player.worldX) || 1) * 150;
      this.player.speed += 35;
      this.triggerImpact(3);
      this.spawnBurst(this.screenX(this.player.worldX, this.player.progress), this.screenY(this.player.progress), "#ffb5c4", 12);
      this.showToast("ТАРАН");
    } else {
      this.player.speed *= 0.72;
      this.player.recoilSpeed -= 105;
      this.player.lateralVelocity += (Math.sign(this.player.worldX - rival.worldX) || 1) * 125;
      this.triggerImpact(5);
      this.spawnBurst(this.screenX(this.player.worldX, this.player.progress), this.screenY(this.player.progress), "#ff6a82", 12);
      this.showToast("СТОЛКНОВЕНИЕ");
    }
  }

  private checkFinish(): void {
    const crossed = [this.player, ...this.rivals]
      .filter((racer) => racer.progress >= RACE_LENGTH)
      .sort((a, b) => b.progress - a.progress)[0];
    if (!crossed) return;
    this.winner = crossed;
    this.state = "finished";
  }

  private currentPlace(): number {
    return [this.player, ...this.rivals]
      .slice()
      .sort((a, b) => b.progress - a.progress)
      .findIndex((racer) => racer.isPlayer) + 1;
  }

  private updatePlaceFeedback(): void {
    const place = this.currentPlace();
    if (place < this.lastPlace) this.placePulse = 0.75;
    this.lastPlace = place;
  }

  private pathIntersectsPoint(racer: Racer, progress: number, worldX: number, progressRadius: number, lateralRadius: number): boolean {
    const startProgress = (racer.previousProgress - progress) / progressRadius;
    const startLateral = (racer.previousWorldX - worldX) / lateralRadius;
    const deltaProgress = (racer.progress - racer.previousProgress) / progressRadius;
    const deltaLateral = (racer.worldX - racer.previousWorldX) / lateralRadius;
    const lengthSquared = deltaProgress * deltaProgress + deltaLateral * deltaLateral;
    const alongPath = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, -(startProgress * deltaProgress + startLateral * deltaLateral) / lengthSquared));
    const closestProgress = startProgress + deltaProgress * alongPath;
    const closestLateral = startLateral + deltaLateral * alongPath;
    return closestProgress * closestProgress + closestLateral * closestLateral <= 1;
  }

  private pathsIntersect(first: Racer, second: Racer, progressRadius: number, lateralRadius: number): boolean {
    const startProgress = (first.previousProgress - second.previousProgress) / progressRadius;
    const startLateral = (first.previousWorldX - second.previousWorldX) / lateralRadius;
    const deltaProgress = (
      first.progress - first.previousProgress - second.progress + second.previousProgress
    ) / progressRadius;
    const deltaLateral = (
      first.worldX - first.previousWorldX - second.worldX + second.previousWorldX
    ) / lateralRadius;
    const lengthSquared = deltaProgress * deltaProgress + deltaLateral * deltaLateral;
    const alongPath = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, -(startProgress * deltaProgress + startLateral * deltaLateral) / lengthSquared));
    const closestProgress = startProgress + deltaProgress * alongPath;
    const closestLateral = startLateral + deltaLateral * alongPath;
    return closestProgress * closestProgress + closestLateral * closestLateral <= 1;
  }

  private updateParticles(dt: number): void {
    for (const particle of this.particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= Math.exp(-2.2 * dt);
      particle.vy *= Math.exp(-2.2 * dt);
      particle.life -= dt;
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
  }

  private spawnBurst(x: number, y: number, color: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const angle = (Math.PI * 2 * index) / count + (Math.random() - 0.5) * 0.5;
      const speed = 35 + Math.random() * 100;
      const life = 0.32 + Math.random() * 0.25;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 2 + Math.random() * 3,
        life,
        maxLife: life,
        color,
      });
    }
  }

  private drawParticles(): void {
    const { context } = this;
    for (const particle of this.particles) {
      context.globalAlpha = Math.max(0, particle.life / particle.maxLife);
      context.fillStyle = particle.color;
      context.shadowColor = particle.color;
      context.shadowBlur = 8;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    context.shadowBlur = 0;
  }

  private triggerImpact(strength: number): void {
    this.shakeSeconds = 0.24;
    this.shakeStrength = Math.max(this.shakeStrength, strength);
  }

  private showToast(message: string): void {
    if (!this.player || this.state !== "racing") return;
    this.toast = message;
    this.toastSeconds = 1.5;
  }

  private get playerFinishBlend(): number {
    if (this.state !== "finished" || !this.winner?.isPlayer) return 0;
    const progress = Math.min(1, this.finishSeconds / 2.8);
    return 1 - (1 - progress) ** 3;
  }

  private courseCenter(progress: number): number {
    const segmentLength = 1180;
    const segment = Math.floor(progress / segmentLength);
    const t = (progress - segment * segmentLength) / segmentLength;
    const p0 = this.courseWaypoint(segment - 1);
    const p1 = this.courseWaypoint(segment);
    const p2 = this.courseWaypoint(segment + 1);
    const p3 = this.courseWaypoint(segment + 2);
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      2 * p1
      + (-p0 + p2) * t
      + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
      + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  private courseAngle(progress: number): number {
    const slope = (this.courseCenter(progress + 8) - this.courseCenter(progress - 8)) / 16;
    return Math.atan(slope);
  }

  private courseWaypoint(index: number): number {
    if (index === 0) return 0;
    const raw = Math.sin(index * 127.1 + 311.7) * 43_758.5453;
    const random = raw - Math.floor(raw);
    return (random * 2 - 1) * 590;
  }

  private stenosisCenter(index: number): number {
    return 2_600 + index * 6_200 + this.hash01(index, 12) * 1_500;
  }

  private roadHalfWidth(progress: number): number {
    let halfWidth = ROAD_WIDTH * 0.5;
    const nearestSection = Math.floor((progress - 2_600) / 6_200);
    for (let section = nearestSection - 1; section <= nearestSection + 1; section += 1) {
      const distance = Math.abs(progress - this.stenosisCenter(section));
      const radius = 1_050;
      if (distance >= radius) continue;
      const severity = 0.34 + this.hash01(section, 13) * 0.16;
      const constriction = (1 + Math.cos((distance / radius) * Math.PI)) * 0.5;
      halfWidth = Math.min(halfWidth, ROAD_WIDTH * 0.5 * (1 - severity * constriction));
    }
    return Math.max(ROAD_WIDTH * 0.25, halfWidth);
  }

  private pickupOffset(kind: PickupKind, index: number, progress: number): number {
    const halfWidth = this.roadHalfWidth(progress);
    const random = this.hash01(index, 14) * 2 - 1;
    if (kind === "cell") return random * halfWidth * 0.22;
    if (kind === "platelet") {
      const side = index % 2 === 0 ? -1 : 1;
      return side * halfWidth * (0.62 + this.hash01(index, 15) * 0.12);
    }
    return random * halfWidth * 0.32;
  }

  private hash01(index: number, salt = 0): number {
    const raw = Math.sin(index * 91.73 + salt * 17.11 + 57.23) * 24_683.17;
    return raw - Math.floor(raw);
  }

  private get worldScale(): number {
    return Math.max(0.5, Math.min(1.35, (this.size.width * 0.88) / ROAD_WIDTH));
  }

  private get cameraDepth(): number {
    return Math.max(360, this.size.height * 1.45);
  }

  private get objectViewDistance(): number {
    // Keep pickups and hazards inside the useful playfield, not stacked at the vanishing point.
    return Math.max(700, this.cameraDepth * 1.2);
  }

  private get horizonY(): number {
    return this.size.height * 0.13;
  }

  private get playerScreenY(): number {
    return this.size.height * 0.7;
  }

  private perspective(progress: number): number {
    const distance = progress - this.player.progress;
    return this.cameraDepth / Math.max(this.cameraDepth * 0.18, this.cameraDepth + distance);
  }

  private screenX(worldX: number, progress: number): number {
    return this.size.width / 2 + (worldX - this.player.worldX) * this.worldScale * this.perspective(progress);
  }

  private screenY(progress: number): number {
    const perspective = this.perspective(progress);
    return this.horizonY + (this.playerScreenY - this.horizonY) * perspective;
  }

  private drawBackground(): void {
    const { context, size, background } = this;
    context.fillStyle = "#250b20";
    context.fillRect(0, 0, size.width, size.height);
    if (background.complete && background.naturalWidth > 0) {
      const scale = Math.max(size.width / background.naturalWidth, size.height / background.naturalHeight);
      const progress = Math.min(1, this.player.progress / RACE_LENGTH);
      const finishBlend = this.playerFinishBlend;
      const zoom = 1.08 + progress * 0.8 + finishBlend * 10.5;
      const width = background.naturalWidth * scale * zoom;
      const height = background.naturalHeight * scale * zoom;
      const focalX = size.width * (0.55 - finishBlend * 0.05);
      const focalY = size.height * (0.12 + finishBlend * 0.3);
      context.drawImage(background, focalX - width * 0.55, focalY - height * 0.16, width, height);
    }

    const shade = context.createLinearGradient(0, 0, 0, size.height);
    shade.addColorStop(0, "rgba(18, 4, 19, 0.32)");
    shade.addColorStop(0.55, "rgba(19, 4, 20, 0.48)");
    shade.addColorStop(1, "rgba(18, 4, 19, 0.65)");
    context.fillStyle = shade;
    context.fillRect(0, 0, size.width, size.height);

    for (let index = 0; index < 22; index += 1) {
      const flowSpeed = 8 + (index % 4) * 4 + this.player.speed * (0.12 + (index % 3) * 0.035);
      const drift = (this.animationTime * flowSpeed) % (size.height + 30);
      const y = (index * 101 + drift) % (size.height + 20) - 10;
      const x = (index * 157 + Math.sin(this.animationTime * 0.35 + index) * 20) % size.width;
      const streak = Math.min(48, this.player.speed * (0.02 + (index % 3) * 0.012));
      context.strokeStyle = index % 4 === 0 ? "rgba(133,255,241,0.22)" : "rgba(255,141,159,0.2)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, y - streak);
      context.lineTo(x, y);
      context.stroke();
      context.globalAlpha = 0.12 + (index % 3) * 0.035;
      context.fillStyle = index % 4 === 0 ? "#85fff1" : "#ff8d9f";
      context.beginPath();
      context.ellipse(x, y, 2 + (index % 3), 3 + (index % 4), 0, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  private drawRoad(): void {
    const { context, size } = this;
    const depth = this.cameraDepth;
    const from = this.player.progress - depth * 0.8;
    const to = Math.min(RACE_LENGTH, this.player.progress + depth * 180);
    const samples: number[] = [];
    for (let progress = from; progress < to;) {
      samples.push(progress);
      const distance = Math.max(0, progress - this.player.progress);
      progress += Math.max(24, Math.min(340, (distance + depth * 0.8) * 0.12));
    }
    samples.push(to);

    const boundary = (side: number): Path2D => {
      const path = new Path2D();
      samples.forEach((progress, index) => {
        const x = this.screenX(this.courseCenter(progress) + side * this.roadHalfWidth(progress), progress);
        const y = this.screenY(progress);
        if (index === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      return path;
    };
    const roadPolygon = (expansion: number): Path2D => {
      const path = new Path2D();
      samples.forEach((progress, index) => {
        const x = this.screenX(this.courseCenter(progress) - this.roadHalfWidth(progress) - expansion, progress);
        const y = this.screenY(progress);
        if (index === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      for (let index = samples.length - 1; index >= 0; index -= 1) {
        const progress = samples[index];
        path.lineTo(this.screenX(this.courseCenter(progress) + this.roadHalfWidth(progress) + expansion, progress), this.screenY(progress));
      }
      path.closePath();
      return path;
    };

    context.save();
    context.fillStyle = "rgba(255, 103, 143, 0.18)";
    context.shadowColor = "rgba(255, 93, 132, 0.55)";
    context.shadowBlur = 34;
    context.fill(roadPolygon(24));
    context.shadowBlur = 0;

    const roadShade = context.createLinearGradient(0, this.horizonY, 0, size.height);
    roadShade.addColorStop(0, "rgba(54, 11, 36, 0.86)");
    roadShade.addColorStop(0.52, "rgba(48, 7, 34, 0.91)");
    roadShade.addColorStop(1, "rgba(37, 5, 29, 0.95)");
    context.fillStyle = roadShade;
    context.fill(roadPolygon(0));

    context.strokeStyle = "rgba(255, 190, 205, 0.72)";
    context.lineWidth = 2.2;
    context.stroke(boundary(-1));
    context.stroke(boundary(1));

    // Uneven vessel rings reinforce the sense of depth without a center line that looks like a straight track.
    context.lineWidth = 1.5;
    for (let ring = Math.floor(from / 690); ring <= Math.floor(to / 690); ring += 1) {
      const progress = ring * 690;
      const y = this.screenY(progress);
      const scale = this.worldScale * this.perspective(progress);
      if (y < this.horizonY - 1 || y > size.height + 10 || scale < 0.035) continue;
      const center = this.courseCenter(progress);
      context.strokeStyle = `rgba(255, 190, 213, ${Math.min(0.18, scale * 0.11)})`;
      context.beginPath();
      const halfWidth = this.roadHalfWidth(progress) * 0.86;
      context.moveTo(this.screenX(center - halfWidth, progress), y);
      context.lineTo(this.screenX(center + halfWidth, progress), y);
      context.stroke();
    }
    context.restore();
  }

  private drawVesselDetails(): void {
    const spacing = 125;
    const nearest = this.player.progress - this.cameraDepth * 0.25;
    const farthest = Math.min(RACE_LENGTH, this.player.progress + this.objectViewDistance);
    const first = Math.floor(nearest / spacing);
    const last = Math.floor(farthest / spacing);
    for (let index = first; index <= last; index += 1) {
      const progress = index * spacing + this.hash01(index, 1) * 70;
      if (progress >= nearest && progress <= farthest && index % 7 !== 0) this.drawFlowingObject(progress, index);
    }
    for (const plaque of this.plaques) {
      if (plaque.progress >= nearest && plaque.progress <= farthest) this.drawCholesterol(plaque);
    }
  }

  private drawHazards(): void {
    const { context, size } = this;
    for (const hazard of this.hazards) {
      if (hazard.cleared || hazard.progress > RACE_LENGTH) continue;
      const distance = hazard.progress - this.player.progress;
      if (distance < -this.cameraDepth * 0.25 || distance > this.objectViewDistance) continue;
      const worldX = this.courseCenter(hazard.progress) + hazard.offset;
      const x = this.screenX(worldX, hazard.progress);
      const y = this.screenY(hazard.progress);
      const scale = this.worldScale * this.perspective(hazard.progress);
      if (y < Math.max(104, size.height * 0.28) || y > size.height + 30 || x < -100 || x > size.width + 100 || scale < 0.08) continue;

      const radius = (hazard.kind === "leukocyte" ? 31 : 27) * scale;
      context.save();
      context.translate(x, y);
      context.shadowColor = hazard.kind === "leukocyte" ? "#fff0db" : "#cf82ff";
      context.shadowBlur = 15 * scale;
      this.drawSprite(
        hazard.kind === "leukocyte" ? 2 : 3,
        2,
        0,
        0,
        radius * 2.8,
        radius * 2.8,
        this.animationTime * 0.25 + hazard.id,
      );
      context.restore();
    }
  }

  private drawCholesterol(plaque: Plaque): void {
    const lateral = plaque.side * (this.roadHalfWidth(plaque.progress) - 18);
    const x = this.screenX(this.courseCenter(plaque.progress) + lateral, plaque.progress);
    const y = this.screenY(plaque.progress);
    const scale = this.worldScale * this.perspective(plaque.progress);
    if (y < Math.max(104, this.size.height * 0.28) || y > this.size.height + 20 || scale < 0.045) return;
    const radius = plaque.radius * scale;
    const { context } = this;
    context.save();
    context.shadowColor = "rgba(255, 194, 94, 0.75)";
    context.shadowBlur = Math.max(2, radius * 0.45);
    this.drawSprite(0, 3, x, y, radius * 2.6, radius * 2.6, 0, plaque.side > 0);
    context.restore();
  }

  private drawFlowingObject(progress: number, index: number): void {
    const offset = (this.hash01(index, 4) * 2 - 1) * this.roadHalfWidth(progress) * 0.78;
    const worldX = this.courseCenter(progress) + offset;
    const x = this.screenX(worldX, progress);
    const y = this.screenY(progress);
    const scale = this.worldScale * this.perspective(progress);
    if (y < Math.max(104, this.size.height * 0.28) || y > this.size.height + 30 || scale < 0.055) return;

    const tailProgress = progress + (32 + this.player.speed * 0.15);
    const tailX = this.screenX(this.courseCenter(tailProgress) + offset, tailProgress);
    const tailY = this.screenY(tailProgress);
    const radius = Math.max(2.2, (6 + this.hash01(index, 5) * 7) * scale);
    const kind = index % 3;
    const color = kind === 0 ? "#ff8292" : kind === 1 ? "#ffd477" : "#79fff1";
    const speedAlpha = 0.18 + Math.min(0.62, this.player.speed / 1_200 * 0.62);
    const { context } = this;
    context.save();
    context.strokeStyle = color;
    context.globalAlpha = speedAlpha;
    context.lineWidth = Math.max(1, radius * 0.42);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(tailX, tailY);
    context.stroke();
    context.globalAlpha = 1;

    const [column, row] = kind === 0 ? [2, 3] : kind === 1 ? [1, 3] : [3, 3];
    context.globalAlpha = 0.4;
    this.drawSprite(column, row, x, y, radius * 3.6, radius * 3.6, this.animationTime * 0.12 + index);
    context.restore();
  }

  private drawTrackGates(): void {
    this.drawGate(0, "#ffb5c4");
    this.drawValveFinish();
  }

  private drawValveFinish(): void {
    const { context, size } = this;
    const distance = RACE_LENGTH - this.player.progress;
    if (distance < -this.cameraDepth * 0.25 || distance > this.objectViewDistance) return;
    const y = this.screenY(RACE_LENGTH);
    if (y < this.horizonY - 30 || y > size.height + 120) return;
    const center = this.screenX(this.courseCenter(RACE_LENGTH), RACE_LENGTH);
    const scale = this.worldScale * this.perspective(RACE_LENGTH);
    const halfWidth = this.roadHalfWidth(RACE_LENGTH) * scale;
    const wallHeight = Math.max(2, this.roadHalfWidth(RACE_LENGTH) * scale * 0.32);
    context.save();
    context.shadowColor = "rgba(255, 100, 147, 0.8)";
    context.shadowBlur = Math.max(3, 24 * scale);
    context.fillStyle = "rgba(119, 28, 61, 0.98)";
    context.beginPath();
    context.ellipse(center, y, halfWidth, wallHeight, 0, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = "rgba(255, 179, 199, 0.92)";
    context.lineWidth = Math.max(1.5, 3 * scale);
    context.beginPath();
    context.ellipse(center, y, halfWidth, wallHeight, 0, 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = "rgba(39, 5, 31, 0.94)";
    context.beginPath();
    context.ellipse(center, y, Math.max(1.5, halfWidth * 0.3), Math.max(1, wallHeight * 0.7), 0.1, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "rgba(255, 222, 229, 0.84)";
    context.lineWidth = Math.max(1, 2 * scale);
    context.beginPath();
    context.moveTo(center - halfWidth, y);
    context.lineTo(center + halfWidth, y);
    context.stroke();

    context.restore();
  }

  private drawGate(progress: number, color: string): void {
    const y = this.screenY(progress);
    if (y < -40 || y > this.size.height + 40) return;
    const center = this.screenX(this.courseCenter(progress), progress);
    const halfWidth = this.roadHalfWidth(progress) * this.worldScale * this.perspective(progress) * 0.98;
    this.context.save();
    this.context.shadowColor = color;
    this.context.shadowBlur = 18;
    this.context.strokeStyle = color;
    this.context.lineWidth = 3;
    this.context.beginPath();
    this.context.moveTo(center - halfWidth, y);
    this.context.lineTo(center + halfWidth, y);
    this.context.stroke();
    this.context.restore();
  }

  private drawPickups(): void {
    for (const pickup of this.pickups) {
      if (pickup.collected) continue;
      const distance = pickup.progress - this.player.progress;
      if (distance < -this.cameraDepth * 0.25 || distance > this.objectViewDistance) continue;
      const x = this.screenX(this.courseCenter(pickup.progress) + pickup.offset, pickup.progress);
      const y = this.screenY(pickup.progress);
      if (y < 104 || y > this.size.height - 58 || x < -40 || x > this.size.width + 40) continue;
      this.drawPickup(pickup, x, y, this.worldScale * this.perspective(pickup.progress));
    }
  }

  private drawPickup(pickup: Pickup, x: number, y: number, size: number): void {
    const { context } = this;
    const pulse = 1 + Math.sin(this.animationTime * 4 + pickup.id) * 0.08;
    const drawScale = Math.max(0.08, Math.min(1.15, size));
    const [column, row] = pickup.kind === "cell" ? [3, 1] : pickup.kind === "platelet" ? [0, 2] : [1, 2];
    context.save();
    const color = pickup.kind === "cell" ? "#ff6a82" : pickup.kind === "platelet" ? "#ffd36a" : "#8cfff4";
    context.shadowColor = color;
    context.shadowBlur = 34 * drawScale;
    context.fillStyle = `${color}66`;
    context.beginPath();
    context.arc(x, y, 22 * drawScale * pulse, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = "rgba(255,255,255,.95)";
    context.lineWidth = Math.max(0.75, 2.5 * drawScale);
    context.beginPath();
    context.arc(x, y, 29 * drawScale * pulse, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = color;
    context.lineWidth = Math.max(0.75, 3 * drawScale);
    context.setLineDash([4, 4]);
    context.beginPath();
    context.arc(x, y, 35 * drawScale * pulse, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
    this.drawSprite(column, row, x, y, 56 * drawScale * pulse, 56 * drawScale * pulse, this.animationTime * 0.2 + pickup.id);
    context.restore();
  }

  private drawRacers(): void {
    const racers = [this.player, ...this.rivals].slice().sort((a, b) => a.progress - b.progress);
    for (const racer of racers) {
      const x = this.screenX(racer.worldX, racer.progress);
      const y = this.screenY(racer.progress);
      if (y < -70 || y > this.size.height + 70 || x < -70 || x > this.size.width + 70) continue;

      const impact = racer.isPlayer ? this.displayedPlayerStats.impact : racer.mass;
      let pulseScale = 1;
      if (racer.isPlayer && this.bonusPulseSeconds > 0) {
        const progress = 1 - this.bonusPulseSeconds / PICKUP_FEEDBACK_DURATION;
        if (progress < 0.28) {
          pulseScale += 0.26 * (1 - Math.pow(1 - progress / 0.28, 3));
        } else {
          const settle = (progress - 0.28) / 0.72;
          pulseScale += 0.26 * (1 - settle * settle);
        }
      }
      const radius = (24 + (impact - 1) * 5) * this.worldScale * this.perspective(racer.progress) * pulseScale;

      if (this.tetherSeconds > 0 && racer.id === this.tetheredRival) {
        const playerX = this.screenX(this.player.worldX, this.player.progress);
        const playerY = this.screenY(this.player.progress);
        this.context.save();
        this.context.strokeStyle = "rgba(255, 216, 111, 0.9)";
        this.context.lineWidth = 3;
        this.context.setLineDash([7, 7]);
        this.context.beginPath();
        this.context.moveTo(playerX, playerY);
        this.context.lineTo(x, y);
        this.context.stroke();
        this.context.restore();
      }

      if (racer.isPlayer && racer.speed > 140) this.drawSpeedTrail(x, y, radius, racer.angle);
      const racerIndex = racer.isPlayer ? 0 : this.rivals.indexOf(racer) + 1;
      const column = racerIndex < 4 ? racerIndex : racerIndex - 4;
      const row = racerIndex < 4 ? 0 : 1;
      this.drawClot(x, y, radius, racer.angle, column, row);
      if (racer.isPlayer) {
        this.context.fillStyle = "rgba(255, 245, 248, 0.94)";
        this.context.font = "800 10px ui-sans-serif, system-ui, sans-serif";
        this.context.textAlign = "center";
        this.context.fillText("ТЫ", x, y - radius * 1.45 - 8);
      }
    }
  }

  private drawSpeedTrail(x: number, y: number, radius: number, angle: number): void {
    const { context } = this;
    const length = Math.min(140, (this.player.speed - 120) * 0.12);
    const color = this.player.boostSeconds > 0 ? "#ffd36a" : "#ff8a9b";
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.globalAlpha = Math.min(0.72, this.player.speed / 1_000);
    context.strokeStyle = color;
    context.lineCap = "round";
    context.shadowColor = color;
    context.shadowBlur = 12;
    context.lineWidth = Math.max(1.5, radius * 0.12);
    for (const offset of [-radius * 0.5, 0, radius * 0.5]) {
      context.beginPath();
      context.moveTo(offset, radius * 0.7);
      context.lineTo(offset * 1.35, radius * 0.7 + length * (offset === 0 ? 1 : 0.72));
      context.stroke();
    }
    context.restore();
  }

  private drawClot(x: number, y: number, radius: number, angle: number, column: number, row: number): void {
    const { context } = this;
    context.save();
    context.globalAlpha = 0.24;
    context.fillStyle = "#1a0617";
    context.beginPath();
    context.ellipse(x, y + radius * 0.82, radius * 1.08, radius * 0.32, 0, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
    context.shadowBlur = 0;
    this.drawSprite(column, row, x, y, radius * 2.8, radius * 2.8, angle);
    context.restore();
  }

  private drawSprite(column: number, row: number, x: number, y: number, width: number, height: number, angle = 0, flipX = false): boolean {
    if (!this.spriteAtlas.complete || this.spriteAtlas.naturalWidth === 0) return false;
    const { context } = this;
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    if (flipX) context.scale(-1, 1);
    context.drawImage(
      this.spriteAtlas,
      column * SPRITE_SIZE,
      row * SPRITE_SIZE,
      SPRITE_SIZE,
      SPRITE_SIZE,
      -width / 2,
      -height / 2,
      width,
      height,
    );
    context.restore();
    return true;
  }

  private drawHud(): void {
    const { context, size } = this;
    const profile = this.selectedProfile;
    const stats = this.displayedPlayerStats;
    const place = this.currentPlace();
    const panelWidth = Math.min(760, size.width - 20);
    const panelHeight = 82;
    const x = (size.width - panelWidth) / 2;
    const y = 12;
    this.drawPanel(x, y, panelWidth, panelHeight);
    const columnWidth = panelWidth / 4;
    const statColor = (value: number, base: number): string => {
      if (value > base + 0.005) return "#8dfff2";
      if (value < base - 0.005) return "#ff8a9b";
      return "#fff";
    };
    const metrics = [
      { label: "СКОРОСТЬ", value: stats.speed, base: profile.speed },
      { label: "РАЗГОН", value: stats.acceleration, base: profile.acceleration },
      { label: "УПРАВЛЕНИЕ", value: stats.handling, base: profile.handling },
      { label: "МАССА", value: stats.impact, base: profile.impact },
    ];

    context.textAlign = "center";
    metrics.forEach((metric, index) => {
      const centerX = x + columnWidth * (index + 0.5);
      if (index > 0) {
        context.strokeStyle = "rgba(255, 219, 228, 0.18)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x + columnWidth * index, y + 16);
        context.lineTo(x + columnWidth * index, y + panelHeight - 16);
        context.stroke();
      }
      context.fillStyle = "rgba(255, 247, 248, 0.82)";
      context.font = `800 ${Math.max(8, Math.min(11, columnWidth * 0.075))}px ui-sans-serif, system-ui, sans-serif`;
      context.fillText(metric.label, centerX, y + 26, columnWidth - 10);
      context.fillStyle = statColor(metric.value, metric.base);
      const valueSize = Math.max(23, Math.min(34, columnWidth * 0.22));
      context.font = `900 ${valueSize}px ui-sans-serif, system-ui, sans-serif`;
      context.fillText(`${Math.round(metric.value * 100)}`, centerX - 7, y + 63, columnWidth - 20);
      context.fillStyle = "rgba(255,255,255,.72)";
      context.font = "700 10px ui-sans-serif, system-ui, sans-serif";
      context.fillText("%", centerX + columnWidth * 0.25, y + 61);
    });

    const status = [
      `БОЛЛИД: ${profile.name}`,
      `МЕСТО: ${place}/${this.rivals.length + 1}`,
      this.plasminSeconds > 0 ? `ПЛАЗМИН: ${this.plasminSeconds.toFixed(1)} С` : "",
    ].filter(Boolean).join("  ·  ");
    context.fillStyle = "rgba(255, 247, 248, 0.92)";
    context.font = `700 ${Math.max(8, Math.min(11, panelWidth * 0.017))}px ui-sans-serif, system-ui, sans-serif`;
    context.textAlign = "center";
    context.fillText(status, size.width / 2, y + panelHeight + 17, size.width - 24);

    if (this.drafting && this.state === "racing") {
      context.fillStyle = "#ffd36a";
      context.font = "800 10px ui-sans-serif, system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText("ДРАФТ", size.width / 2, y + panelHeight + 34);
    }
  }

  private drawPanel(x: number, y: number, width: number, height: number): void {
    const { context } = this;
    context.fillStyle = "rgba(25, 6, 23, 0.78)";
    context.strokeStyle = "rgba(255, 219, 228, 0.24)";
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(x, y, width, height, 12);
    context.fill();
    context.stroke();
  }

  private drawToast(): void {
    const width = Math.min(430, this.size.width - 36);
    const x = (this.size.width - width) / 2;
    const y = this.size.height * 0.2;
    this.drawPanel(x, y, width, 38);
    this.context.fillStyle = "#fff5df";
    this.context.font = "700 11px ui-sans-serif, system-ui, sans-serif";
    this.context.textAlign = "center";
    this.context.fillText(this.toast, this.size.width / 2, y + 24, width - 22);
  }

  private drawReadyScreen(): void {
    const { context, size } = this;
    const width = Math.min(520, size.width - 36);
    const x = (size.width - width) / 2;
    const height = 286;
    const y = Math.max(12, Math.min(size.height - height - 12, size.height * 0.24));
    const profile = this.selectedProfile;
    this.drawPanel(x, y, width, height);
    context.textAlign = "center";
    context.fillStyle = "#fff7f8";
    context.font = `900 ${Math.max(14, Math.min(20, width / 25))}px ui-sans-serif, system-ui, sans-serif`;
    context.fillText("ВЫБЕРИ БОЛИД", size.width / 2, y + 34, width - 28);
    context.fillStyle = profile.color;
    context.font = `900 ${Math.max(18, Math.min(28, width / 18))}px ui-sans-serif, system-ui, sans-serif`;
    context.fillText(`◀  ${profile.name}  ▶`, size.width / 2, y + 67, width - 28);
    context.fillStyle = "rgba(255,255,255,.76)";
    context.font = "700 11px ui-sans-serif, system-ui, sans-serif";
    context.fillText(`ПРОФИЛЬ ${this.selectedProfileIndex + 1}/4  ·  A/D или ←/→`, size.width / 2, y + 87, width - 24);

    const stats = [
      ["СКОРОСТЬ", profile.speed],
      ["РАЗГОН", profile.acceleration],
      ["УПРАВЛЕНИЕ", profile.handling],
      ["УДАР", profile.impact],
    ] as const;
    stats.forEach(([label, multiplier], index) => {
      const level = multiplier <= 0.9 ? 0 : multiplier >= 1.1 ? 2 : 1;
      const rowY = y + 116 + index * 29;
      const barX = x + width * 0.45;
      const barWidth = width * 0.31;
      context.textAlign = "right";
      context.fillStyle = "#fff7f8";
      context.font = "800 10px ui-sans-serif, system-ui, sans-serif";
      context.fillText(label, barX - 12, rowY + 8);
      for (let bar = 0; bar < 3; bar += 1) {
        context.fillStyle = bar <= level ? profile.color : "rgba(255,255,255,.15)";
        context.fillRect(barX + bar * (barWidth / 3 + 4), rowY, barWidth / 3 - 4, 10);
      }
      context.textAlign = "left";
      context.fillStyle = "rgba(255,255,255,.72)";
      context.font = "700 9px ui-sans-serif, system-ui, sans-serif";
      context.fillText(level === 0 ? "НИЗКИЙ" : level === 1 ? "СРЕДНИЙ" : "ВЫСОКИЙ", barX + barWidth + 8, rowY + 8);
    });
    context.textAlign = "center";
    context.fillStyle = "#8dfff2";
    context.font = "900 14px ui-sans-serif, system-ui, sans-serif";
    context.fillText("ENTER — СТАРТ", size.width / 2, y + height - 24);
  }

  private get selectedProfile(): BolidProfile {
    return BOLID_PROFILES[this.selectedProfileIndex];
  }

  private get effectivePlayerStats(): BolidProfile {
    const profile = this.selectedProfile;
    const plasminActive = this.plasminSeconds > 0;
    return {
      ...profile,
      speed: profile.speed * (plasminActive ? 1.14 : 1),
      acceleration: profile.acceleration * (plasminActive ? 1.22 : 1),
      handling: profile.handling + this.plateletCount * 0.08,
      impact: Math.max(0.65, profile.impact + this.cellCount * 0.2 - (plasminActive ? 0.35 : 0)),
    };
  }

  private syncPlayerStats(): void {
    const profile = this.selectedProfile;
    const next = this.effectivePlayerStats;
    const changed = Math.abs(next.speed - this.statTweenTarget.speed) > 0.0001
      || Math.abs(next.acceleration - this.statTweenTarget.acceleration) > 0.0001
      || Math.abs(next.handling - this.statTweenTarget.handling) > 0.0001
      || Math.abs(next.impact - this.statTweenTarget.impact) > 0.0001;
    if (changed) {
      this.statTweenFrom = this.displayedPlayerStats;
      this.statTweenTarget = { ...next };
      this.statTweenSeconds = STAT_TWEEN_DURATION;
    }
    this.player.color = profile.color;
    this.player.mass = next.impact;
  }


  private get displayedPlayerStats(): BolidProfile {
    const progress = Math.max(0, Math.min(1, 1 - this.statTweenSeconds / STAT_TWEEN_DURATION));
    const eased = progress * progress * (3 - 2 * progress);
    const from = this.statTweenFrom;
    const target = this.statTweenTarget;
    return {
      ...target,
      speed: from.speed + (target.speed - from.speed) * eased,
      acceleration: from.acceleration + (target.acceleration - from.acceleration) * eased,
      handling: from.handling + (target.handling - from.handling) * eased,
      impact: from.impact + (target.impact - from.impact) * eased,
    };
  }

  private drawRaceVignettes(): void {
    const layers = [
      { color: this.selectedProfile.color, opacity: 0.24 },
      ...(this.cellCount > 0 ? [{ color: "#ff6a82", opacity: 0.12 }] : []),
      ...(this.plateletCount > 0 ? [{ color: "#ffd36a", opacity: 0.12 }] : []),
      ...(this.plasminSeconds > 0 ? [{ color: "#8cfff4", opacity: 0.14 }] : []),
      ...(this.bonusPulseSeconds > 0
        ? [{ color: this.bonusPulseColor, opacity: 0.25 * this.bonusPulseSeconds / PICKUP_FEEDBACK_DURATION }]
        : []),
    ];
    const totalOpacity = layers.reduce((sum, layer) => sum + layer.opacity, 0);
    const scale = totalOpacity > 0.36 ? 0.36 / totalOpacity : 1;
    const { context, size } = this;
    const edgeX = Math.max(1, size.width * 0.24);
    const edgeY = Math.max(1, size.height * 0.22);
    const transparent = "rgba(0,0,0,0)";

    context.save();
    const drawEdges = (color: string, opacity: number): void => {
      const tint = this.hexWithAlpha(color, opacity);

      const left = context.createLinearGradient(0, 0, edgeX, 0);
      left.addColorStop(0, tint);
      left.addColorStop(1, transparent);
      context.fillStyle = left;
      context.fillRect(0, 0, edgeX, size.height);

      const right = context.createLinearGradient(size.width - edgeX, 0, size.width, 0);
      right.addColorStop(0, transparent);
      right.addColorStop(1, tint);
      context.fillStyle = right;
      context.fillRect(size.width - edgeX, 0, edgeX, size.height);

      const top = context.createLinearGradient(0, 0, 0, edgeY);
      top.addColorStop(0, tint);
      top.addColorStop(1, transparent);
      context.fillStyle = top;
      context.fillRect(0, 0, size.width, edgeY);

      const bottom = context.createLinearGradient(0, size.height - edgeY, 0, size.height);
      bottom.addColorStop(0, transparent);
      bottom.addColorStop(1, tint);
      context.fillStyle = bottom;
      context.fillRect(0, size.height - edgeY, size.width, edgeY);
    };

    drawEdges("#09050d", 0.24);
    for (const layer of layers) drawEdges(layer.color, layer.opacity * scale);
    context.restore();
  }

  private hexWithAlpha(hex: string, alpha: number): string {
    const normalized = hex.slice(1);
    const red = Number.parseInt(normalized.slice(0, 2), 16);
    const green = Number.parseInt(normalized.slice(2, 4), 16);
    const blue = Number.parseInt(normalized.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  private drawCountdown(): void {
    const { context, size } = this;
    const label = this.countdownSeconds > 0 ? `${Math.ceil(this.countdownSeconds)}` : "ПУСК!";
    const color = this.countdownSeconds <= 1 ? "#8dfff2" : "#ffd36a";
    const width = Math.min(220, size.width - 40);
    const x = (size.width - width) / 2;
    const y = size.height * 0.38;
    this.drawPanel(x, y, width, 100);
    context.textAlign = "center";
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = 18;
    context.font = `900 ${label === "ПУСК!" ? 34 : 52}px ui-sans-serif, system-ui, sans-serif`;
    context.fillText(label, size.width / 2, y + 65);
    context.shadowBlur = 0;
  }

  private drawFinishScreen(): void {
    const { context, size } = this;
    const fade = Math.max(0, Math.min(1, (this.finishSeconds - 3.25) / 0.75));
    if (fade <= 0) return;
    context.save();
    context.fillStyle = `rgba(0, 0, 0, ${fade})`;
    context.fillRect(0, 0, size.width, size.height);
    const textAlpha = Math.max(0, Math.min(1, (fade - 0.35) / 0.65));
    if (textAlpha > 0) {
      context.globalAlpha = textAlpha;
      context.textAlign = "center";
      context.fillStyle = "#f32638";
      context.shadowColor = "#ff142e";
      context.shadowBlur = 22;
      context.font = `900 ${Math.min(28, size.width / 20)}px ui-sans-serif, system-ui, sans-serif`;
      context.fillText("ДЛЯ ПАЦИЕНТА ПОТРАЧЕНО", size.width / 2, size.height * 0.48, size.width - 24);
      context.shadowBlur = 0;
      context.fillStyle = "#ff6b73";
      context.font = "800 13px ui-sans-serif, system-ui, sans-serif";
      context.fillText("ENTER — РЕСТАРТ", size.width / 2, size.height * 0.58);
    }
    context.restore();
  }
}
