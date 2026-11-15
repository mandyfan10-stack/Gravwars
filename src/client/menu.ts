import type { PerspectiveCamera } from 'three';
import type { GameAudio } from './audio';
import type { DebugToggles } from './debugGui';
import type { Input } from './input';
import { saveSettings, type Settings } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface MenuHooks {
  /** Graphics toggles changed (texture filter). */
  onToggles: () => void;
  /** The match summary (teams table + personal numbers) for the side panel. */
  statsHtml: () => string;
  /** Toggle or enter spectator mode during a match. */
  onToggleSpectate?: () => boolean;
  /** User exited back to the main menu lobby from a match. */
  onExitToMainMenu?: () => void;
  onHostGame?: (name: string) => Promise<string>;
  onJoinGame?: (roomCode: string, name: string) => Promise<void>;
  onLeaveRoom?: () => void;
  onNameChange?: (name: string) => void;
}

/**
 * Main / pause / end-of-match menu: play / resume, spectator mode, new match, exit to main menu, help & settings panels.
 * Settings are applied from `settings` on start and saved whenever they change.
 */
export function setupMenu(input: Input, audio: GameAudio, camera: PerspectiveCamera, toggles: DebugToggles, settings: Settings, hooks: MenuHooks) {
  const start = $('start-game');
  const spectateBtn = $('spectate-btn');
  const newMatch = $('new-match');
  const exitMenu = $('exit-menu');
  start.addEventListener('click', () => audio.unlock());

  let started = false;
  let over = false;
  let returnedToLobby = false;

  const showMatch = () => {
    $('menu-lobby').hidden = started && !returnedToLobby;
    $('menu-match').hidden = !started || returnedToLobby;
    if (started && !returnedToLobby) $('menu-match-body').innerHTML = hooks.statsHtml();
  };

  document.addEventListener('game-lock', () => {
    if (input.locked) {
      started = true;
      returnedToLobby = false;
      start.textContent = over ? 'Осмотреться' : 'Продолжить';
      newMatch.hidden = false;
      exitMenu.hidden = false;
    } else if (started && !returnedToLobby) {
      $('menu-state').hidden = false;
      exitMenu.hidden = false;
      showMatch();
    }
  });

  // If the user returned to the main menu lobby during/after a match and clicks "В бой", start a fresh match
  start.addEventListener('click', (e) => {
    if (returnedToLobby) {
      e.stopImmediatePropagation();
      location.reload();
    }
  }, true);

  spectateBtn.addEventListener('click', () => {
    audio.unlock();
    if (returnedToLobby) {
      sessionStorage.setItem('gravwars-start-spectate', '1');
      location.reload();
      return;
    }
    if (started && hooks.onToggleSpectate) {
      const specOn = hooks.onToggleSpectate();
      spectateBtn.textContent = specOn ? 'Вернуться в тело игрока' : 'Режим наблюдателя';
      input.lock();
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

  // Exit to main menu during a match or after its end: returns immediately to the Main Menu & Lobby configurator
  exitMenu.addEventListener('click', () => {
    returnedToLobby = true;
    $('menu-state').hidden = true;
    $('menu-state').classList.remove('over');
    $('menu-lobby').hidden = false;
    $('menu-match').hidden = true;
    newMatch.hidden = true;
    exitMenu.hidden = true;
    start.textContent = 'В бой';
    start.classList.add('btn-play');
    newMatch.classList.remove('btn-play');
    spectateBtn.textContent = 'Режим наблюдателя';
    hooks.onExitToMainMenu?.();
  });

  const sections = ['help', 'settings', 'multiplayer'];
  for (const section of sections) $(`show-${section}`)?.addEventListener('click', () => {
    const target = $(`menu-${section}`);
    if (!target) return;
    const open = target.hidden;
    for (const other of sections) {
      const el = $(`menu-${other}`);
      if (el) el.hidden = true;
    }
    target.hidden = !open;
  });

  // Multiplayer panel actions
  const NAME_KEY = 'gravwars-net-name';
  const netStatus = $('net-status');
  const netNameInput = document.getElementById('net-name-input') as HTMLInputElement | null;
  const netCreate = $('net-create-btn') as HTMLButtonElement;
  const netRoomInfo = $('net-room-info');
  const netRoomCode = $('net-room-code');
  const netCopy = $('net-copy-btn');
  const netCopyLink = document.getElementById('net-copy-link-btn');
  const netJoinBtn = $('net-join-btn') as HTMLButtonElement;
  const netJoinInput = $<HTMLInputElement>('net-join-input');
  const netLeaveBtn = document.getElementById('net-leave-btn') as HTMLButtonElement | null;

  const getPlayerName = () => {
    const raw = netNameInput?.value.replace(/\s+/g, ' ').trim().slice(0, 16) ?? '';
    return raw || 'Игрок';
  };

  if (netNameInput) {
    netNameInput.value = localStorage.getItem(NAME_KEY) ?? '';
    netNameInput.addEventListener('input', () => {
      const val = netNameInput.value.slice(0, 16);
      localStorage.setItem(NAME_KEY, val);
      hooks.onNameChange?.(getPlayerName());
    });
  }

  const setNetStatus = (text: string, isError = false) => {
    netStatus.textContent = text;
    netStatus.classList.toggle('error', isError);
  };

  const setConnectedState = (connected: boolean, busy = false) => {
    netCreate.disabled = connected || busy;
    netJoinBtn.disabled = connected || busy;
    netJoinInput.disabled = connected || busy;
    if (netLeaveBtn) netLeaveBtn.hidden = !connected;
    if (!connected) netRoomInfo.hidden = true;
  };

  const resetNetworkUi = (statusText = '', isError = false) => {
    setConnectedState(false, false);
    netRoomCode.textContent = '';
    setNetStatus(statusText, isError);
  };

  netCreate?.addEventListener('click', async () => {
    if (!hooks.onHostGame || netCreate.disabled) return;
    setConnectedState(false, true);
    setNetStatus('Создание комнаты...');
    try {
      const code = await hooks.onHostGame(getPlayerName());
      netRoomCode.textContent = code;
      netRoomInfo.hidden = false;
      setConnectedState(true, false);
      setNetStatus('Комната открыта! Поделитесь кодом или ссылкой.');
    } catch (e) {
      setConnectedState(false, false);
      setNetStatus(`Ошибка создания: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  });

  netCopy?.addEventListener('click', () => {
    const code = netRoomCode.textContent?.trim();
    if (code) {
      navigator.clipboard.writeText(code).then(() => {
        netCopy.textContent = 'Скопировано!';
        setTimeout(() => { netCopy.textContent = 'Скопировать код'; }, 2000);
      });
    }
  });

  netCopyLink?.addEventListener('click', () => {
    const code = netRoomCode.textContent?.trim();
    if (!code) return;
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.set('room', code);
    navigator.clipboard.writeText(url.toString()).then(() => {
      netCopyLink.textContent = 'Ссылка скопирована!';
      setTimeout(() => { netCopyLink.textContent = 'Скопировать ссылку'; }, 2000);
    });
  });

  const doJoin = async () => {
    const code = netJoinInput.value.trim();
    if (!code) {
      setNetStatus('Введите код комнаты', true);
      return;
    }
    if (!hooks.onJoinGame || netJoinBtn.disabled) return;
    setConnectedState(false, true);
    setNetStatus('Подключение к хосту...');
    try {
      await hooks.onJoinGame(code, getPlayerName());
      setConnectedState(true, false);
      setNetStatus('Подключено к лобби! Ожидание старта от хоста…');
    } catch (e) {
      setConnectedState(false, false);
      setNetStatus(`Ошибка подключения: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  };

  netJoinBtn?.addEventListener('click', () => { void doJoin(); });
  netJoinInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void doJoin();
    }
  });

  netLeaveBtn?.addEventListener('click', () => {
    hooks.onLeaveRoom?.();
    resetNetworkUi('Отключились от комнаты');
  });

  const urlRoom = new URLSearchParams(window.location.search).get('room')?.trim();
  if (urlRoom) {
    for (const other of ['help', 'settings']) {
      const el = $(`menu-${other}`);
      if (el) el.hidden = true;
    }
    const mp = $('menu-multiplayer');
    if (mp) mp.hidden = false;
    netJoinInput.value = urlRoom.toUpperCase();
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('room');
    window.history.replaceState({}, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    setTimeout(() => { void doJoin(); }, 150);
  }

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

  const dist = $<HTMLInputElement>('draw-distance');
  const showDist = () => { $('draw-distance-value').textContent = `${settings.drawDistance} м`; };
  dist.value = String(settings.drawDistance);
  showDist();
  dist.addEventListener('input', () => {
    settings.drawDistance = Number(dist.value);
    showDist();
    hooks.onToggles();
    save();
  });

  const shadows = $<HTMLSelectElement>('shadows');
  shadows.value = settings.shadows;
  shadows.addEventListener('change', () => {
    settings.shadows = shadows.value as Settings['shadows'];
    hooks.onToggles();
    save();
  });

  const bloom = $<HTMLSelectElement>('bloom');
  bloom.value = settings.bloom ? 'on' : 'off';
  bloom.addEventListener('change', () => {
    toggles.bloom = settings.bloom = bloom.value === 'on';
    hooks.onToggles();
    save();
  });

  const pixels = $<HTMLSelectElement>('pixels');
  pixels.value = String(settings.pixels);
  pixels.addEventListener('change', () => {
    settings.pixels = Number(pixels.value);
    hooks.onToggles();
    save();
  });

  const palette = $<HTMLSelectElement>('palette');
  palette.value = settings.palette ? 'on' : 'off';
  palette.addEventListener('change', () => {
    settings.palette = palette.value === 'on';
    hooks.onToggles();
    save();
  });

  return {
    /** Match over: summary in the menu, "New match" and "Exit to main menu" shown prominently. */
    showResult(title: string) {
      over = true;
      returnedToLobby = false;
      $('menu-state').hidden = false;
      $('menu-state').textContent = title;
      $('menu-state').classList.add('over');
      newMatch.hidden = false;
      exitMenu.hidden = false;
      newMatch.textContent = 'Новый матч';
      newMatch.classList.add('btn-play');
      start.classList.remove('btn-play');
      start.textContent = 'Осмотреться';
      showMatch();
    },
    /** Refresh the summary when settings sliders etc. are not the reason (e.g. the match ended while paused). */
    refresh: showMatch,
    setNetStatus,
    resetNetworkUi,
  };
}
