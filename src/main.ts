import "./style.css";
import { Game } from "./game";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error("Не найден canvas #game");
const gameCanvas: HTMLCanvasElement = canvas;

const context = gameCanvas.getContext("2d");
if (!context) throw new Error("Браузер не поддерживает Canvas 2D");
const gameContext: CanvasRenderingContext2D = context;

const pressedKeys = new Set<string>();
const justPressedKeys = new Set<string>();
const game = new Game(gameContext, {
  isDown: (code) => pressedKeys.has(code),
  wasPressed: (code) => justPressedKeys.has(code),
}, {
  width: window.innerWidth,
  height: window.innerHeight,
});

const gameKeys = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "KeyA", "KeyD", "KeyW", "KeyS", "Space", "Enter", "KeyR",
]);

window.addEventListener("keydown", (event) => {
  if (gameKeys.has(event.code)) event.preventDefault();
  if (!pressedKeys.has(event.code)) justPressedKeys.add(event.code);
  pressedKeys.add(event.code);
});

window.addEventListener("keyup", (event) => pressedKeys.delete(event.code));
window.addEventListener("blur", () => {
  pressedKeys.clear();
  justPressedKeys.clear();
});

function resizeCanvas(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  gameCanvas.width = Math.round(width * pixelRatio);
  gameCanvas.height = Math.round(height * pixelRatio);
  gameContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  game.resize({ width, height });
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

let previousTime = 0;

function frame(time: number): void {
  const deltaSeconds = previousTime === 0 ? 0 : Math.min((time - previousTime) / 1000, 0.05);
  previousTime = time;

  game.update(deltaSeconds);
  game.render();
  justPressedKeys.clear();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
