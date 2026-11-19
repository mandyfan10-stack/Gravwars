import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import './style.css';
import type { Object3D } from 'three';
import { activeTeams, playerTeam, sanitizeLocalLobby } from '../shared/lobby';
import { initRapier, type Rapier } from '../shared/physics';
import type { TeamId } from '../shared/teams';
import { GameAudio } from './audio';
import { GameChat } from './chat';
import type { DebugToggles } from './debugGui';
import { Input } from './input';
import { Lobby } from './lobby';
import { gameLog } from './logger';
import { MatchSession } from './matchSession';
import { setupMenu } from './menu';
import { MenuBackdrop } from './menuBackdrop';
import { GameMusic } from './music';
import { NetLobbyController } from './net/netLobby';
import { P2PTransport } from './net/p2p';
import { loadAssets, type GameAssets } from './render/assets';
import { Graphics } from './render/graphics';
import { CHAR_LOD } from './render/playerModel';
import { setPixelTextures } from './render/texFilter';
import { loadSettings, PALETTE_LEVELS, saveSettings } from './settings';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay')!;
  const start = document.getElementById('start-game') as HTMLButtonElement;
  const spectateBtn = document.getElementById('spectate-btn') as HTMLButtonElement;
  gameLog.install();
  gameLog.attachCanvas(canvas);
  gameLog.setStage('boot', { mode: 'menu' });

  // --- permanent singletons: renderer, audio, input, lobby, menu & scenic backdrop
  const settings = loadSettings();
  const loading = Promise.all([initRapier(), loadAssets(), document.fonts.load('800 64px Inter', 'МАГАЗИН КРАСНЫЕ')]);
  const gfx = new Graphics(canvas);
  const { scene, camera } = gfx;
  const baseSceneChildren = new Set<Object3D>(scene.children);
  window.addEventListener('resize', () => gfx.resize());

  const input = new Input(canvas, overlay);
  const audio = new GameAudio();
  audio.volume = settings.volume;
  const music = new GameMusic(audio);
  const startMenuMusicOnce = () => {
    if (!input.armed) {
      audio.unlock();
      music.playMenuMusic();
    }
  };
  overlay.addEventListener('pointerdown', startMenuMusicOnce, { once: true });
  window.addEventListener('keydown', startMenuMusicOnce, { once: true });

  const toggles: DebugToggles = {
    bloom: settings.bloom, sensitivity: settings.sensitivity, fov: settings.fov, pixel: settings.pixel,
  };
  let lastLook = { lines: -1, levels: -1 };
  let activeSession: MatchSession | null = null;
  let launching = false;
  let rapier: Rapier | null = null;
  let loadedAssets: GameAssets | null = null;
  let loaded = false;
  let resolveBootReady!: () => void;
  const bootReady = new Promise<void>((r) => { resolveBootReady = r; });

  const applyToggles = () => {
    gfx.bloom.enabled = toggles.bloom;
    input.sensitivity = toggles.sensitivity;
    camera.fov = toggles.fov;
    camera.updateProjectionMatrix();
    const vmScene = activeSession?.viewModel.scene;
    setPixelTextures(toggles.pixel, vmScene ? [scene, vmScene] : [scene]);
    gfx.setShadows(settings.shadows);
    const look = { lines: settings.pixels, levels: settings.palette ? PALETTE_LEVELS : 0 };
    if (look.lines !== lastLook.lines || look.levels !== lastLook.levels) gfx.setLook((lastLook = look));
    CHAR_LOD.far = Math.min(220, Math.max(90, settings.drawDistance * 0.3));
    CHAR_LOD.shadow = settings.shadows === 'off' ? 0 : settings.shadows === 'low' ? 30 : 45;
  };

  let netTransport: P2PTransport | null = null;
  let netLobby: NetLobbyController | null = null;
  let isNetworkMatch = false;
  let isHostPlayer = true;
  let myNetworkId = '';
  let myNetworkName = '';
  let matchSeed = 1337;
  let canonicalMapTeam: TeamId = 'red';
  let skipFortTeams: TeamId[] = [];
  let pendingNetStart = false;

  const lobby = new Lobby(settings.difficulty);
  const chat = new GameChat();
  chat.onTypingChange = (typing) => { input.typing = typing; };
  chat.onSendLobby = (text) => { netLobby?.sendChat(text); };
  const backdrop = new MenuBackdrop(gfx);
  (window as unknown as { __menu: MenuBackdrop }).__menu = backdrop;

  function syncStart(problem = lobby.problem) {
    if (input.armed) return;
    if (isNetworkMatch && !isHostPlayer) {
      start.disabled = true;
      start.textContent = loaded ? 'Ждём хоста…' : 'Загрузка…';
      start.title = 'Ожидание запуска от хоста';
      spectateBtn.disabled = true;
      return;
    }
    start.disabled = !loaded || !!problem;
    start.textContent = loaded ? 'В бой' : 'Загрузка…';
    start.title = problem ?? '';
    spectateBtn.disabled = !loaded;
  }

  async function launchMatch(spectate: boolean) {
    if (!loaded || !rapier || !loadedAssets || launching || activeSession) return;
    launching = true;
    try {
      lobby.save();
      lobby.hidden = true;
      audio.unlock();
      music.stopMenuMusic();
      menu.markMatchStarted(isNetworkMatch, spectate);
      input.armed = true;
      input.lock();

      const cfg = lobby.config;
      const mode = cfg.mode ?? 'standard';
      const myTeam = playerTeam(cfg, myNetworkId) || playerTeam(cfg) || 'red';
      const mapTeam = isNetworkMatch ? canonicalMapTeam : myTeam;
      const menuEye = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
      const built = backdrop.take(mapTeam, activeTeams(cfg), matchSeed, mode);
      if (!built) document.body.classList.add('building');
      await new Promise((r) => setTimeout(r, 30));

      activeSession = new MatchSession(
        {
          R: rapier,
          assets: loadedAssets,
          gfx,
          input,
          audio,
          music,
          chat,
          backdrop,
          baseSceneChildren,
          settings,
          toggles,
          cfg,
          startInSpectator: spectate,
          isNetworkMatch,
          isHostPlayer,
          myNetworkId,
          matchSeed,
          canonicalMapTeam,
          skipFortTeams,
          transport: netTransport,
          applyToggles,
          onShowResult: (title) => menu.showResult(title),
          onSpectateLabelChange: (on) => {
            const lbl = spectateBtn.querySelector('.btn-label');
            const text = on ? 'Вернуться в тело игрока' : 'Режим наблюдателя';
            if (lbl) lbl.textContent = text;
            else spectateBtn.textContent = text;
          },
        },
        built,
        menuEye,
      );
      applyToggles();
    } finally {
      launching = false;
    }
  }

  function exitMatchToMenu(disconnectMsg?: string) {
    const preserved = activeSession?.dispose(true) ?? null;
    activeSession = null;
    input.armed = false;
    input.typing = false;
    if (document.pointerLockElement) document.exitPointerLock();
    overlay.classList.remove('hidden');
    lobby.hidden = false;
    if (preserved) {
      // Empty key forces the next match to build a fresh, undamaged map while reusing the arena visually in menu
      backdrop.resumeExisting(preserved, '');
    } else if (loadedAssets) {
      backdrop.start(loadedAssets, playerTeam(lobby.config) ?? 'red', activeTeams(lobby.config), 1337, lobby.config.mode ?? 'standard');
    }
    if (isNetworkMatch || netTransport) {
      cleanupNetworkRoom(true, disconnectMsg ?? 'Вы отключились от сетевой игры');
    } else {
      chat.clearLobby();
      syncStart();
    }
    music.playMenuMusic();
  }

  function restartMatch() {
    if (launching) return;
    if (activeSession) {
      activeSession.dispose(false);
      activeSession = null;
    }
    if (isNetworkMatch || netTransport) {
      cleanupNetworkRoom(true, 'Сетевой матч завершён — запущен локальный матч');
    }
    input.armed = false;
    if (document.pointerLockElement) document.exitPointerLock();
    void launchMatch(false);
  }

  function cleanupNetworkRoom(resetUi = true, message?: string, isError = false) {
    const prevId = myNetworkId;
    netTransport?.close();
    netTransport = null;
    netLobby = null;
    isNetworkMatch = false;
    isHostPlayer = true;
    myNetworkId = '';
    matchSeed = 1337;
    canonicalMapTeam = 'red';
    skipFortTeams = [];
    pendingNetStart = false;
    const cleaned = sanitizeLocalLobby(lobby.config, prevId);
    lobby.config.seats = cleaned.seats;
    lobby.isNetworkClient = false;
    lobby.localPlayerId = '';
    lobby.onSeatRequest = undefined;
    lobby.render();
    chat.clearLobby();
    if (resetUi) menu.resetNetworkUi(message, isError);
    syncStart();
  }

  function attachNetLobby(transport: P2PTransport, name: string) {
    netLobby = new NetLobbyController(transport, lobby, {
      onStartMatch: (seed, _config, _activeTeams, myId, isHost, mapTeam, skipTeams) => {
        matchSeed = seed;
        myNetworkId = myId;
        isHostPlayer = isHost;
        canonicalMapTeam = mapTeam;
        skipFortTeams = skipTeams;
        if (loaded) void launchMatch(false);
        else pendingNetStart = true;
      },
      onPlayersChange: (players) => chat.setLobbyVisible(true, players),
      onChat: (sender, text, team) => chat.pushLobbyMessage(sender, text, team),
      onStatusMessage: (msg, isErr) => menu.setNetStatus(msg, isErr),
      onRejected: (reason) => cleanupNetworkRoom(true, reason, true),
      onHostLeave: (reason) => cleanupNetworkRoom(true, reason, true),
    });
    if (name || myNetworkName) netLobby.setMyName(name || myNetworkName);
    chat.setLobbyVisible(true, netLobby.players);
    lobby.onSeatRequest = (team, i) => netLobby?.requestSeat(team, i);
  }

  const menu = setupMenu(input, audio, camera, toggles, settings, {
    onToggles: applyToggles,
    statsHtml: () => activeSession?.statsHtml() ?? '',
    onStartMatch: (spectate) => {
      if (!loaded || launching || activeSession) return;
      if (!spectate && isNetworkMatch && isHostPlayer && netLobby) {
        netLobby.startMatch();
        return;
      }
      void launchMatch(spectate);
    },
    onRestartMatch: () => restartMatch(),
    onToggleSpectate: () => activeSession?.toggleSpectate() ?? false,
    onExitToMainMenu: () => exitMatchToMenu('Вы отключились от сетевой игры'),
    onDisconnectMatch: () => exitMatchToMenu('Отключено от сервера'),
    onHostGame: async (name: string) => {
      cleanupNetworkRoom(false);
      myNetworkName = name;
      const transport = new P2PTransport(true);
      try {
        const code = await transport.host();
        netTransport = transport;
        isNetworkMatch = true;
        isHostPlayer = true;
        myNetworkId = transport.myId;
        lobby.localPlayerId = myNetworkId;
        lobby.isNetworkClient = false;
        attachNetLobby(transport, name);
        syncStart();
        return code;
      } catch (err) {
        transport.close();
        throw err;
      }
    },
    onJoinGame: async (roomCode: string, name: string) => {
      cleanupNetworkRoom(false);
      myNetworkName = name;
      if (!loaded) await bootReady;
      const transport = new P2PTransport(false);
      try {
        await transport.join(roomCode);
        netTransport = transport;
        isNetworkMatch = true;
        isHostPlayer = false;
        myNetworkId = transport.myId;
        lobby.localPlayerId = myNetworkId;
        lobby.isNetworkClient = true;
        attachNetLobby(transport, name);
        syncStart();
      } catch (err) {
        transport.close();
        throw err;
      }
    },
    onLeaveRoom: () => cleanupNetworkRoom(false),
    onNameChange: (name: string) => {
      myNetworkName = name;
      netLobby?.setMyName(name);
    },
  });

  window.addEventListener('pagehide', () => { netTransport?.close(); });

  lobby.onChange = (problem) => {
    syncStart(problem);
    if (!input.armed) gfx.setSunVisible((lobby.config.mode ?? 'standard') !== 'skirmish');
    if (isNetworkMatch && isHostPlayer) netLobby?.broadcastLobbyUpdate();
  };
  lobby.onLevel = (d) => { settings.difficulty = d; saveSettings(settings); };

  const [R, assets] = await loading;
  rapier = R;
  loadedAssets = assets;
  backdrop.start(assets, playerTeam(lobby.config) ?? 'red', activeTeams(lobby.config), 1337, lobby.config.mode ?? 'standard');
  applyToggles();
  loaded = true;
  resolveBootReady();
  syncStart();

  if (pendingNetStart) {
    pendingNetStart = false;
    void launchMatch(false);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  gameLog.error('main', err);
  const start = document.getElementById('start-game') as HTMLButtonElement | null;
  if (start) start.textContent = 'Не удалось загрузить игру — обнови страницу';
});
