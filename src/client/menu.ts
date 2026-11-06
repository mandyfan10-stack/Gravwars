import type { PerspectiveCamera } from 'three';
import { DIFFICULTY_LABEL, type Difficulty } from '../shared/bots';
import type { GameAudio } from './audio';
import type { DebugToggles } from './debugGui';
import type { Input } from './input';
import { saveSettings, type Settings } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface MenuHooks {
  /** Graphics toggles changed (texture filter). */
  onToggles: () => void;
  /** Difficulty picked before the match started: retune the bots. */
  onDifficulty: (d: Difficulty) => void;
  /** The match summary (teams table + personal numbers) for the side panel. */
  statsHtml: () => string;
}

/**
 * Main / pause / end-of-match menu: play / resume, new match, help & settings panels.
 * Settings are applied from `settings` on start and saved whenever they change.
 */
export function setupMenu(input: Input, audio: GameAudio, camera: PerspectiveCamera, toggles: DebugToggles, settings: Settings, hooks: MenuHooks) {
  const start = $('start-game');
  const newMatch = $('new-match');
  start.addEventListener('click', () => audio.unlock());

  let started = false;
  let over = false;
  const showMatch = () => {
    $('menu-roster').hidden = started;
    $('menu-match').hidden = !started;
    if (started) $('menu-match-body').innerHTML = hooks.statsHtml();
  };
  document.addEventListener('game-lock', () => {
    if (input.locked) {
      started = true;
      start.textContent = over ? 'Осмотреться' : 'Продолжить';
      newMatch.hidden = false;
      $('difficulty-note').textContent = 'со следующего матча';
    } else if (started) {
      $('menu-state').hidden = false;
      showMatch();
    }
  });

  // new match: a reload is the honest full reset; mid-match it asks twice
  let confirmT = 0;
  newMatch.addEventListener('click', () => {
    if (over || performance.now() < confirmT) { location.reload(); return; }
    confirmT = performance.now() + 3000;
    newMatch.textContent = 'Точно? Матч начнётся заново';
    setTimeout(() => { if (!over) newMatch.textContent = 'Новый матч'; }, 3000);
  });

  const sections = ['help', 'settings'];
  for (const section of sections) $(`show-${section}`).addEventListener('click', () => {
    const target = $(`menu-${section}`);
    const open = target.hidden;
    for (const other of sections) $(`menu-${other}`).hidden = true;
    target.hidden = !open;
  });

  const save = () => saveSettings(settings);

  const volume = $<HTMLInputElement>('volume');
  const showVolume = () => { $('volume-value').textContent = `${Math.round(audio.volume * 100)}%`; };
  volume.value = String(settings.volume);
  showVolume();
  volume.addEventListener('input', () => {
    audio.volume = settings.volume = Number(volume.value);
    showVolume();
    save();
  });

  const sensitivity = $<HTMLInputElement>('sensitivity');
  const showSens = () => { $('sensitivity-value').textContent = `${Math.round(input.sensitivity / 0.0022 * 100)}%`; };
  sensitivity.value = String(settings.sensitivity);
  showSens();
  sensitivity.addEventListener('input', () => {
    input.sensitivity = toggles.sensitivity = settings.sensitivity = Number(sensitivity.value);
    showSens();
    save();
  });

  const fov = $<HTMLInputElement>('fov');
  fov.value = String(settings.fov);
  $('fov-value').textContent = `${settings.fov}°`;
  fov.addEventListener('input', () => {
    camera.fov = toggles.fov = settings.fov = Number(fov.value);
    camera.updateProjectionMatrix();
    $('fov-value').textContent = `${fov.value}°`;
    save();
  });

  const filter = $<HTMLSelectElement>('tex-filter');
  filter.value = settings.pixel ? 'pixel' : 'smooth';
  filter.addEventListener('change', () => {
    toggles.pixel = settings.pixel = filter.value === 'pixel';
    hooks.onToggles();
    save();
  });

  const difficulty = $<HTMLSelectElement>('difficulty');
  difficulty.innerHTML = (Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => `<option value="${d}">${DIFFICULTY_LABEL[d]}</option>`).join('');
  difficulty.value = settings.difficulty;
  difficulty.addEventListener('change', () => {
    settings.difficulty = difficulty.value as Difficulty;
    if (!started) hooks.onDifficulty(settings.difficulty);
    save();
  });

  return {
    /** Match over: summary in the menu, "New match" becomes the main button. */
    showResult(title: string) {
      over = true;
      $('menu-state').hidden = false;
      $('menu-state').textContent = title;
      $('menu-state').classList.add('over');
      newMatch.hidden = false;
      newMatch.textContent = 'Новый матч';
      newMatch.classList.add('btn-play');
      start.classList.remove('btn-play');
      start.textContent = 'Осмотреться';
      showMatch();
    },
    /** Refresh the summary when settings sliders etc. are not the reason (e.g. the match ended while paused). */
    refresh: showMatch,
  };
}
