import { escapeHtml } from '../shared/escape';
import type { NetworkPlayerInfo } from '../shared/net/protocol';
import { getTeam, type TeamId } from '../shared/teams';

const teamColor = (team?: TeamId) => (team ? `#${getTeam(team).color.toString(16).padStart(6, '0')}` : '#93c5fd');

/**
 * Unified chat controller for both the P2P Lobby room panel (`#net-chat`) and the in-match HUD chat (`#chat-box`).
 */
export class GameChat {
  private readonly boxEl = document.getElementById('chat-box');
  private readonly logEl = document.getElementById('chat-log');
  private readonly inputRowEl = document.getElementById('chat-input-row');
  private readonly inputEl = document.getElementById('chat-input') as HTMLInputElement | null;

  private readonly netPlayersEl = document.getElementById('net-players');
  private readonly netChatEl = document.getElementById('net-chat');
  private readonly netLogEl = document.getElementById('net-chat-log');
  private readonly netInputEl = document.getElementById('net-chat-input') as HTMLInputElement | null;
  private readonly netSendEl = document.getElementById('net-chat-send') as HTMLButtonElement | null;

  open = false;
  onSendLobby?: (text: string) => void;
  onSendMatch?: (text: string) => void;
  onTypingChange?: (typing: boolean) => void;

  constructor() {
    this.netSendEl?.addEventListener('click', () => this.submitLobby());
    this.netInputEl?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submitLobby();
      }
    });

    this.inputEl?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submitMatch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeMatchInput();
      }
    });
    this.inputEl?.addEventListener('blur', () => {
      if (this.open) this.closeMatchInput();
    });
  }

  setLobbyVisible(connected: boolean, players: readonly NetworkPlayerInfo[] = []) {
    if (this.netChatEl) this.netChatEl.hidden = !connected;
    if (this.netPlayersEl) {
      this.netPlayersEl.hidden = !connected || players.length === 0;
      if (connected && players.length) {
        this.netPlayersEl.innerHTML = players.map((p) => {
          const c = teamColor(p.team);
          const ping = p.isHost ? 'Хост' : `${Math.max(1, Math.round(p.pingMs))} мс`;
          return `<div class="net-pl"><span class="dot" style="background:${c}"></span><b>${escapeHtml(p.name)}</b><small>${ping}</small></div>`;
        }).join('');
      }
    }
  }

  clearLobby() {
    this.setLobbyVisible(false, []);
    if (this.netLogEl) this.netLogEl.innerHTML = '';
  }

  pushLobbyMessage(sender: string, text: string, team?: TeamId) {
    if (!this.netLogEl) return;
    const row = document.createElement('div');
    row.className = 'chat-line';
    row.innerHTML = `<b style="color:${teamColor(team)}">${escapeHtml(sender)}:</b> <span>${escapeHtml(text)}</span>`;
    this.netLogEl.append(row);
    while (this.netLogEl.children.length > 40) this.netLogEl.firstChild!.remove();
    this.netLogEl.scrollTop = this.netLogEl.scrollHeight;
  }

  private submitLobby() {
    const raw = this.netInputEl?.value.trim().slice(0, 140) ?? '';
    if (!raw) return;
    if (this.netInputEl) this.netInputEl.value = '';
    this.onSendLobby?.(raw);
  }

  setMatchEnabled(on: boolean) {
    if (this.boxEl) this.boxEl.hidden = !on;
    if (!on) this.closeMatchInput();
  }

  clearMatch() {
    this.setMatchEnabled(false);
    if (this.logEl) this.logEl.innerHTML = '';
  }

  openMatchInput() {
    if (!this.boxEl || !this.inputRowEl || !this.inputEl) return;
    this.boxEl.hidden = false;
    this.open = true;
    this.inputRowEl.hidden = false;
    this.inputEl.value = '';
    this.onTypingChange?.(true);
    setTimeout(() => this.inputEl?.focus(), 0);
  }

  closeMatchInput() {
    if (!this.open) return;
    this.open = false;
    if (this.inputRowEl) this.inputRowEl.hidden = true;
    this.inputEl?.blur();
    this.onTypingChange?.(false);
  }

  private submitMatch() {
    const raw = this.inputEl?.value.trim().slice(0, 140) ?? '';
    this.closeMatchInput();
    if (raw) this.onSendMatch?.(raw);
  }

  pushMatchMessage(sender: string, text: string, team?: TeamId) {
    if (!this.boxEl || !this.logEl) return;
    this.boxEl.hidden = false;
    const row = document.createElement('div');
    row.className = 'chat-line';
    row.innerHTML = `<b style="color:${teamColor(team)}">${escapeHtml(sender)}:</b> <span>${escapeHtml(text)}</span>`;
    this.logEl.append(row);
    while (this.logEl.children.length > 8) this.logEl.firstChild!.remove();
    setTimeout(() => row.classList.add('fade'), 8500);
    setTimeout(() => { if (!this.open) row.remove(); }, 9500);
  }
}
