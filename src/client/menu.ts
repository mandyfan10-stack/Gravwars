import type { PerspectiveCamera } from 'three';
import type { GameAudio } from './audio';
import type { DebugToggles } from './debugGui';
import type { Input } from './input';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Main / pause menu: start button, help & settings panels, volume / sensitivity / FOV sliders. */
export function setupMenu(input: Input, audio: GameAudio, camera: PerspectiveCamera, toggles: DebugToggles) {
  $('start-game').addEventListener('click', () => audio.unlock());

  let started = false;
  document.addEventListener('game-lock', () => {
    if (input.locked) {
      started = true;
      $('start-game').textContent = 'Продолжить';
    } else if (started) $('menu-state').hidden = false;
  });

  const sections = ['help', 'settings'];
  for (const section of sections) $(`show-${section}`).addEventListener('click', () => {
    const target = $(`menu-${section}`);
    const open = target.hidden;
    for (const other of sections) $(`menu-${other}`).hidden = true;
    target.hidden = !open;
  });

  const volume = $<HTMLInputElement>('volume');
  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value);
    $('volume-value').textContent = `${Math.round(audio.volume * 100)}%`;
  });
  const sensitivity = $<HTMLInputElement>('sensitivity');
  sensitivity.addEventListener('input', () => {
    input.sensitivity = Number(sensitivity.value);
    toggles.sensitivity = input.sensitivity;
    $('sensitivity-value').textContent = `${Math.round(input.sensitivity / 0.0022 * 100)}%`;
  });
  const fov = $<HTMLInputElement>('fov');
  fov.addEventListener('input', () => {
    camera.fov = Number(fov.value);
    toggles.fov = camera.fov;
    camera.updateProjectionMatrix();
    $('fov-value').textContent = `${fov.value}°`;
  });
}
