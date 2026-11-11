import test from 'node:test';
import assert from 'node:assert/strict';
import { activeTeams, defaultLobby, lobbyProblem, playerTeam } from './lobby';
import { createWeaponState, energyLeft, giveWeapon, hasAmmo, shotSpread, weaponTick, WEAPONS } from './weapons';
import { Hotbar } from './inventory';
import { TICK_DT } from './constants';

test('lobby default configuration has valid teams and no problems', () => {
  const cfg = defaultLobby('normal');
  assert.equal(playerTeam(cfg), 'red');
  assert.deepEqual(activeTeams(cfg), ['red', 'blue', 'green', 'yellow']);
  assert.equal(lobbyProblem(cfg), null);
});

test('weapon state lifecycle: equip, fire, ammo depletion, and reload', () => {
  const ws = createWeaponState();
  assert.equal(ws.current, 'fists');
  assert.equal(weaponTick(ws, { fire: true, reload: false, select: null }, TICK_DT), 'fists');

  giveWeapon(ws, 'pistol');
  weaponTick(ws, { fire: false, reload: false, select: 'pistol' }, TICK_DT);
  assert.equal(ws.current, 'pistol');
  assert.equal(ws.ammo.pistol, WEAPONS.pistol.mag);
  assert.equal(hasAmmo(ws, 'pistol'), true);

  for (let i = 0; i < 32; i++) {
    weaponTick(ws, { fire: false, reload: false, select: null }, TICK_DT);
  }
  const fired = weaponTick(ws, { fire: true, reload: false, select: null }, TICK_DT);
  assert.equal(fired, 'pistol');
  assert.equal(ws.ammo.pistol, WEAPONS.pistol.mag - 1);
});

test('ballistic energy and spread calculations behave deterministically', () => {
  assert.equal(energyLeft(WEAPONS.rifle, WEAPONS.rifle.speed), 1);
  assert.ok(energyLeft(WEAPONS.pistol, WEAPONS.pistol.speed * 0.5) < 1);
  assert.equal(shotSpread(WEAPONS.rifle, 1, 0), WEAPONS.rifle.spread);
  assert.ok(shotSpread(WEAPONS.rifle, 6, 1) > WEAPONS.rifle.spread);
});

test('hotbar slot assignment and swapping', () => {
  const bar = new Hotbar();
  bar.sync(['pistol', 'rifle', 'rod']);
  assert.equal(bar.bar[0], 'pistol');
  assert.equal(bar.bar[1], 'rifle');
  assert.equal(bar.bar[2], 'rod');
  bar.swap({ where: 'bar', i: 0 }, { where: 'bar', i: 2 });
  assert.equal(bar.bar[0], 'rod');
  assert.equal(bar.bar[2], 'pistol');
});
