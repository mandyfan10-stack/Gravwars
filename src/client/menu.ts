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
  /** User clicked disconnect from an active multiplayer match. */
  onDisconnectMatch?: () => void;
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
  const lobbyFocusBtn = document.getElementById('show-lobby-focus');
  const newMatch = $('new-match');
  const exitMenu = $('exit-menu');
  const disconnectMatch = document.getElementById('net-disconnect-match') as HTMLButtonElement | null;
  start.addEventListener('click', () => audio.unlock());

  // Boot splash animation -> smooth reveal of Main Menu (instant skip on click/key/webdriver)
  const splash = document.getElementById('splash');
  if (splash) {
    const closeSplash = () => {
      if (splash.classList.contains('done')) return;
      splash.classList.add('done');
      setTimeout(() => splash.remove(), 550);
    };
    if (navigator.webdriver || sessionStorage.getItem('gravwars-start-spectate') === '1') {
      splash.remove();
    } else {
      splash.addEventListener('pointerdown', closeSplash, { once: true });
      window.addEventListener('keydown', closeSplash, { once: true });
      setTimeout(closeSplash, 1250);
    }
  }

  // Interactive spring-physics GRAVWARS logo letters (all 8 letters styled symmetrically with rotating gravity)
  const logo = document.getElementById('logo-interactive');
  if (logo) {
    const letters = [...logo.querySelectorAll<HTMLElement>('.logo-top i')];
    const dirs = ['g-down', 'g-right', 'g-up', 'g-left'];
    const st = letters.map((el) => ({
      el, x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0, s: 1, vs: 0,
    }));
    let animId = 0;
    let lastT = performance.now();
    const stepLogo = (now: number) => {
      const dt = Math.min(0.033, Math.max(0.001, (now - lastT) / 1000));
      lastT = now;
      let moving = false;
      for (const l of st) {
        l.vx += (-l.x * 260 - l.vx * 14) * dt;
        l.vy += (-l.y * 260 - l.vy * 14) * dt;
        l.vr += (-l.r * 260 - l.vr * 14) * dt;
        l.vs += ((1 - l.s) * 280 - l.vs * 15) * dt;
        l.x += l.vx * dt;
        l.y += l.vy * dt;
        l.r += l.vr * dt;
        l.s += l.vs * dt;
        l.el.style.transform = `translate(${l.x.toFixed(2)}px, ${l.y.toFixed(2)}px) rotate(${l.r.toFixed(2)}deg) scale(${l.s.toFixed(3)})`;
        if (Math.abs(l.x) + Math.abs(l.y) + Math.abs(l.vx) + Math.abs(l.vy) + Math.abs(l.r) > 0.08) moving = true;
      }
      animId = moving ? requestAnimationFrame(stepLogo) : 0;
    };
    const poke = () => { if (!animId) { lastT = performance.now(); animId = requestAnimationFrame(stepLogo); } };
    logo.addEventListener('pointermove', (e) => {
      for (const l of st) {
        const rect = l.el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        const dx = cx - e.clientX, dy = cy - e.clientY;
        const d = Math.hypot(dx, dy);
        if (d < 90 && d > 1) {
          const f = (1 - d / 90) * 9;
          l.vx += (dx / d) * f * 18;
          l.vy += (dy / d) * f * 18;
          l.vr += ((dx > 0 ? 1 : -1) * f) * 1.4;
          l.vs += 0.28;
        }
      }
      poke();
    });
    letters.forEach((el, idx) => {
      el.addEventListener('click', () => {
        audio.unlock();
        audio.activeReloadClick();
        const cur = dirs.findIndex((c) => el.classList.contains(c));
        dirs.forEach((c) => el.classList.remove(c));
        el.classList.add(dirs[(cur + 1) % dirs.length]);
        const s = st[idx];
        s.vy -= 180;
        s.vr += (idx % 2 === 0 ? 1 : -1) * 140;
        s.vs += 2.2;
        poke();
      });
    });
  }

  type MenuPage = 'home' | 'lobby' | 'multiplayer' | 'help' | 'settings' | 'changelog' | 'match';
  const PAGE_TITLES: Record<Exclude<MenuPage, 'home'>, string> = {
    lobby: 'Команды и режим (Лобби)',
    multiplayer: 'Сетевая игра (P2P)',
    help: 'Управление',
    settings: 'Настройки',
    changelog: 'Что нового? · Версия 0.3',
    match: 'Статистика матча',
  };

  const overlay = $('overlay');
  const menuHome = $('menu-home');
  const subbar = $('menu-subbar');
  const pageTitle = $('menu-page-title');
  const backBtn = $('menu-back-btn');
  const launchDock = $('menu-launch-dock');
  const showMpBtn = document.getElementById('show-multiplayer');
  const showMatchBtn = document.getElementById('show-match');
  const netOpenLobbyBtn = document.getElementById('net-open-lobby');
  const resultActions = document.getElementById('menu-result-actions');
  const matchSpectateBtn = document.getElementById('match-spectate-btn');
  const matchNewBtn = document.getElementById('match-new-btn');
  const matchDisconnectBtn = document.getElementById('match-disconnect-btn');
  const matchExitBtn = document.getElementById('match-exit-btn');

  const setBtnLabel = (btn: HTMLElement | null, text: string) => {
    if (!btn) return;
    const lbl = btn.querySelector('.btn-label');
    if (lbl) lbl.textContent = text;
    else btn.textContent = text;
  };

  let curPage: MenuPage = 'home';
  let started = false;
  let over = false;
  let returnedToLobby = false;
  let inNetMatch = false;

  const syncNetDisconnectBtn = () => {
    const show = inNetMatch && started && !returnedToLobby;
    if (disconnectMatch) disconnectMatch.hidden = !show;
    if (matchDisconnectBtn) matchDisconnectBtn.hidden = !show;
  };

  const openPage = (page: MenuPage) => {
    curPage = page;
    overlay.dataset.page = page;
    menuHome.hidden = page !== 'home';
    subbar.hidden = page === 'home';
    if (page !== 'home') pageTitle.textContent = PAGE_TITLES[page];
    launchDock.hidden = !(page === 'home' || page === 'lobby' || page === 'multiplayer');
    for (const p of ['lobby', 'multiplayer', 'help', 'settings', 'changelog', 'match'] as const) {
      const el = document.getElementById(`menu-${p}`);
      if (el) el.hidden = page !== p;
    }
    if (page === 'match') $('menu-match-body').innerHTML = hooks.statsHtml();
  };

  const syncMenuMode = () => {
    const preMatch = !started || returnedToLobby;
    if (lobbyFocusBtn) lobbyFocusBtn.hidden = !preMatch;
    if (showMpBtn) showMpBtn.hidden = !preMatch;
    if (showMatchBtn) showMatchBtn.hidden = preMatch;
    newMatch.hidden = preMatch;
    exitMenu.hidden = preMatch;
    if (resultActions) resultActions.hidden = !over || preMatch;
    syncNetDisconnectBtn();
    if (!preMatch && curPage === 'match') $('menu-match-body').innerHTML = hooks.statsHtml();
  };

  const showMatch = () => {
    syncMenuMode();
    if (started && !returnedToLobby) {
      $('menu-match-body').innerHTML = hooks.statsHtml();
    }
  };

  backBtn.addEventListener('click', () => openPage('home'));
  netOpenLobbyBtn?.addEventListener('click', () => openPage('lobby'));
  showMatchBtn?.addEventListener('click', () => openPage('match'));
  matchSpectateBtn?.addEventListener('click', () => start.click());
  matchNewBtn?.addEventListener('click', () => newMatch.click());
  matchDisconnectBtn?.addEventListener('click', () => disconnectMatch?.click());
  matchExitBtn?.addEventListener('click', () => exitMenu.click());

  lobbyFocusBtn?.addEventListener('click', () => {
    openPage('lobby');
    const lb = $('menu-lobby');
    lb.classList.remove('pulse');
    void lb.offsetWidth;
    lb.classList.add('pulse');
    setTimeout(() => lb.classList.remove('pulse'), 900);
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && curPage !== 'home' && !input.locked && !input.typing && !overlay.classList.contains('hidden')) {
      if (!(document.body.classList.contains('spectating') && input.armed)) {
        e.stopImmediatePropagation();
        openPage('home');
      }
    }
  });

  document.addEventListener('game-lock', () => {
    if (input.locked) {
      started = true;
      returnedToLobby = false;
      start.textContent = over ? 'Осмотреться' : 'Продолжить';
      syncMenuMode();
    } else if (started && !returnedToLobby) {
      $('menu-state').hidden = false;
      openPage('home');
      syncMenuMode();
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
      setBtnLabel(spectateBtn, specOn ? 'Вернуться в тело игрока' : 'Режим наблюдателя');
      input.lock();
    }
  });

  // new match: a reload is the honest full reset; mid-match it asks twice
  let confirmT = 0;
  newMatch.addEventListener('click', () => {
    if (over || performance.now() < confirmT) { location.reload(); return; }
    confirmT = performance.now() + 3000;
    setBtnLabel(newMatch, 'Точно? Матч начнётся заново');
    setBtnLabel(matchNewBtn, 'Точно? Начать заново');
    setTimeout(() => {
      if (!over) {
        setBtnLabel(newMatch, 'Новый матч');
        setBtnLabel(matchNewBtn, 'Новый матч');
      }
    }, 3000);
  });

  const returnToMainMenuUi = () => {
    returnedToLobby = true;
    started = false;
    over = false;
    inNetMatch = false;
    $('menu-state').hidden = true;
    $('menu-state').classList.remove('over');
    start.textContent = 'В бой';
    start.classList.add('btn-play');
    newMatch.classList.remove('btn-play');
    setBtnLabel(spectateBtn, 'Режим наблюдателя');
    setBtnLabel(newMatch, 'Новый матч');
    openPage('home');
    syncMenuMode();
  };

  // Exit to main menu during a match or after its end: returns cleanly to the Main Menu & Lobby configurator
  exitMenu.addEventListener('click', () => {
    returnToMainMenuUi();
    hooks.onExitToMainMenu?.();
  });

  disconnectMatch?.addEventListener('click', () => {
    returnToMainMenuUi();
    hooks.onDisconnectMatch?.();
  });

  for (const section of ['help', 'settings', 'multiplayer', 'changelog'] as const) {
    $(`show-${section}`)?.addEventListener('click', () => openPage(section));
  }

  openPage('home');
  syncMenuMode();

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
    openPage('multiplayer');
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

  // X-Ray Outline settings
  const o = settings.outline;
  const oEn = $<HTMLSelectElement>('outline-enabled');
  oEn.value = o.enabled ? 'on' : 'off';
  oEn.addEventListener('change', () => { o.enabled = oEn.value === 'on'; hooks.onToggles(); save(); });

  const oStr = $<HTMLInputElement>('outline-strength');
  const showStr = () => { $('outline-strength-value').textContent = `${Math.round(o.strength * 100)}%`; };
  oStr.value = String(o.strength);
  showStr();
  oStr.addEventListener('input', () => { o.strength = Number(oStr.value); showStr(); save(); });

  const oAlly = $<HTMLInputElement>('outline-ally-dist');
  const showOAlly = () => { $('outline-ally-dist-value').textContent = `${o.playerDistance} м`; };
  oAlly.value = String(o.playerDistance);
  showOAlly();
  oAlly.addEventListener('input', () => { o.playerDistance = Number(oAlly.value); showOAlly(); save(); });

  const oSpec = $<HTMLInputElement>('outline-spec-dist');
  const showOSpec = () => { $('outline-spec-dist-value').textContent = `${o.specDistance} м`; };
  oSpec.value = String(o.specDistance);
  showOSpec();
  oSpec.addEventListener('input', () => { o.specDistance = Number(oSpec.value); showOSpec(); save(); });

  const bindChk = (id: string, key: 'showCrystal' | 'showAllies' | 'showEnemies' | 'showItems' | 'showNpcs' | 'showCars') => {
    const el = $<HTMLInputElement>(id);
    el.checked = o[key];
    el.addEventListener('change', () => { o[key] = el.checked; save(); });
  };
  bindChk('outline-show-crystal', 'showCrystal');
  bindChk('outline-show-allies', 'showAllies');
  bindChk('outline-show-enemies', 'showEnemies');
  bindChk('outline-show-items', 'showItems');
  bindChk('outline-show-npcs', 'showNpcs');
  bindChk('outline-show-cars', 'showCars');

  const bindCol = (id: string, key: 'colorCrystal' | 'colorAlly' | 'colorEnemy' | 'colorItem' | 'colorNpc') => {
    const el = $<HTMLInputElement>(id);
    el.value = o[key];
    el.addEventListener('input', () => { o[key] = el.value; save(); });
  };
  bindCol('outline-col-crystal', 'colorCrystal');
  bindCol('outline-col-ally', 'colorAlly');
  bindCol('outline-col-enemy', 'colorEnemy');
  bindCol('outline-col-item', 'colorItem');
  bindCol('outline-col-npc', 'colorNpc');

  return {
    /** Match over: summary in the menu, "New match" and "Exit to main menu" shown prominently. */
    showResult(title: string) {
      over = true;
      returnedToLobby = false;
      $('menu-state').hidden = false;
      $('menu-state').textContent = title;
      $('menu-state').classList.add('over');
      setBtnLabel(newMatch, 'Новый матч');
      setBtnLabel(matchNewBtn, 'Новый матч');
      newMatch.classList.add('btn-play');
      start.classList.remove('btn-play');
      start.textContent = 'Осмотреться';
      syncMenuMode();
      openPage('match');
    },
    /** Refresh the summary when settings sliders etc. are not the reason (e.g. the match ended while paused). */
    refresh: showMatch,
    /** Toggle whether the Disconnect-from-server button is shown in the pause/result menu. */
    setInMatchNet(active: boolean) {
      inNetMatch = active;
      syncNetDisconnectBtn();
    },
    setNetStatus,
    resetNetworkUi,
  };
}
