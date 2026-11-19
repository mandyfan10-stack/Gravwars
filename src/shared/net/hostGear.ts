import { Combat, MAX_HP, Target } from '../combat';
import type { Economy, Pickups } from '../economy';
import type { GameMode } from '../lobby';
import {
  type Bed, CRYSTAL_AMMO_FRAC, CRYSTAL_AMMO_INTERVAL, CRYSTAL_ZONE_RADIUS, killRewardFor, type Match, scaleReward,
} from '../match';
import { upOf } from '../math';
import { JETPACK, PlayerSim } from '../sim';
import type { TeamId } from '../teams';
import { consumeJetpackFuel, refillAmmo, totalFuelAmmo, type WeaponState } from '../weapons';

/** Wallet balance enforced when the lobby has `infiniteMoney` enabled. */
export const INFINITE_MONEY_BALANCE = 99999;

export interface RemoteClientGearState {
  sim: PlayerSim;
  eco: Economy;
  target: Target;
  weapons: WeaponState;
  wallet: { cash: number; crystal: number };
  team: TeamId;
  crystalAmmoT: number;
  dirtySync: boolean;
  pendingNotice?: { text: string; color: string };
  pendingSound?: 'pickup' | 'coins' | 'reject' | 'eat' | 'patch';
}

/** Wire armor vest purchase & lethal-save breakage onto a remote client's authoritative target. */
export function wireRemoteClientArmor(rc: Pick<RemoteClientGearState, 'eco' | 'target' | 'dirtySync' | 'pendingNotice'>) {
  rc.target.armor = rc.eco.has('armor');
  rc.eco.onArmorChange = (has) => {
    rc.target.armor = has;
    rc.dirtySync = true;
  };
  rc.target.onArmorBreak = () => {
    rc.eco.breakArmor();
    rc.pendingNotice = { text: 'Бронежилет спас от смерти!', color: '#7cf5ff' };
    rc.dirtySync = true;
  };
}

/** Sync jetpack ownership/fuel flags before stepping a remote client's authoritative `PlayerSim`. */
export function syncRemoteClientJetpack(rc: Pick<RemoteClientGearState, 'sim' | 'eco' | 'weapons'>) {
  rc.sim.hasJetpack = rc.eco.has('jetpack');
  rc.sim.hasJetpackFuel = totalFuelAmmo(rc.weapons) > 0;
}

/** Keep a remote client's wallet topped up when `infiniteMoney` is enabled in the lobby. */
export function applyRemoteClientInfiniteMoney(
  rc: Pick<RemoteClientGearState, 'wallet' | 'dirtySync'>,
  infiniteMoney: boolean,
): boolean {
  if (!infiniteMoney) return false;
  if (rc.wallet.cash >= INFINITE_MONEY_BALANCE && rc.wallet.crystal >= INFINITE_MONEY_BALANCE) return false;
  rc.wallet.cash = INFINITE_MONEY_BALANCE;
  rc.wallet.crystal = INFINITE_MONEY_BALANCE;
  rc.dirtySync = true;
  return true;
}

/** Award kill cash to a remote client using the exact same `MATCH_RULES.reward` scaling as host and bots. */
export function awardRemoteClientKill(
  rc: Pick<RemoteClientGearState, 'wallet' | 'dirtySync' | 'pendingNotice' | 'pendingSound'>,
  mode?: GameMode,
): number {
  const reward = scaleReward(killRewardFor(mode));
  rc.wallet.cash += reward;
  if (mode === 'skirmish') {
    rc.pendingNotice = { text: `+${reward}$`, color: '#ffd966' };
    rc.pendingSound = 'coins';
  }
  rc.dirtySync = true;
  return reward;
}

/** Collect neutral generator crystals for a remote client with `MATCH_RULES.reward` scaling. */
export function collectRemoteClientCrystals(
  rc: Pick<RemoteClientGearState, 'sim' | 'wallet' | 'dirtySync' | 'pendingNotice' | 'pendingSound'>,
  match: Pick<Match, 'collect'>,
): number {
  const raw = match.collect(rc.sim.state.pos);
  if (raw <= 0) return 0;
  const reward = scaleReward(raw);
  rc.wallet.crystal += reward;
  rc.pendingNotice = { text: `+${reward} крист.`, color: '#7ce8ff' };
  rc.pendingSound = 'pickup';
  rc.dirtySync = true;
  return reward;
}

/** Refill a remote client's ammo inside their own live crystal zone at the same radius & cadence as the host. */
export function tickRemoteClientCrystalZone(
  rc: Pick<RemoteClientGearState, 'sim' | 'weapons' | 'crystalAmmoT' | 'dirtySync' | 'pendingNotice' | 'pendingSound'>,
  ownBed: Pick<Bed, 'alive' | 'pos'> | undefined,
  dt: number,
): boolean {
  rc.crystalAmmoT -= dt;
  if (rc.crystalAmmoT > 0) return false;
  if (ownBed?.alive && rc.sim.state.pos.distanceTo(ownBed.pos) < CRYSTAL_ZONE_RADIUS) {
    rc.crystalAmmoT = CRYSTAL_AMMO_INTERVAL;
    if (refillAmmo(rc.weapons, CRYSTAL_AMMO_FRAC)) {
      rc.pendingNotice ??= { text: 'Патроны пополнены у кристалла', color: '#ffe082' };
      rc.pendingSound ??= 'pickup';
      rc.dirtySync = true;
      return true;
    }
    return false;
  }
  rc.crystalAmmoT = 0.25;
  return false;
}

/** Spill a remote client's pockets on death; void deaths lose items instead of dropping them on base spawn. */
export function spillRemoteClientLoot(
  rc: Pick<RemoteClientGearState, 'sim' | 'eco'>,
  pickups: Pick<Pickups, 'drop'>,
  lostInVoid: boolean,
): number {
  const lost = rc.eco.spill();
  if (lostInVoid) return 0;
  const dropPos = rc.sim.state.pos.clone();
  const dropUp = upOf(rc.sim.state.frame).clone();
  let dropped = 0;
  for (const p of lost) {
    if (pickups.drop(p.kind, dropPos, dropUp, p.amount)) dropped++;
  }
  return dropped;
}

/** Handle authoritative jetpack fuel consumption and overheat explosion events for a remote client. */
export function applyRemoteClientJetpackEvents(
  rc: Pick<RemoteClientGearState, 'target' | 'weapons' | 'team' | 'dirtySync' | 'pendingNotice'>,
  ev: PlayerSim['events'][number],
  combat: Combat,
): boolean {
  if (ev.type === 'jetpackFuel') {
    consumeJetpackFuel(rc.weapons, 1);
    rc.dirtySync = true;
    return true;
  }
  if (ev.type === 'jetpackExplode') {
    const selfDmg = (rc.target.maxHp ?? MAX_HP) * JETPACK.explodeSelfFrac;
    combat.damage(rc.target, selfDmg, rc.target.id, false, ev.pos, {
      raw: true, noPush: true, cause: 'jetpack', weapon: 'jetpack',
    });
    combat.triggerExplosion(
      ev.pos, rc.target.id, rc.team, JETPACK.explodeRadius, JETPACK.explodeDamageOther,
      12, 60, 0, true, 'jetpack', ev.pos,
    );
    rc.pendingNotice = { text: 'Перегрев ранца! Взрыв!', color: '#ff7050' };
    rc.dirtySync = true;
    return true;
  }
  return false;
}
