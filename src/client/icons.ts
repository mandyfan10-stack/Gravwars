/**
 * HUD icons from game-icons.net (CC BY 3.0: Lorc, Delapouite, Zeromancer, John Colburn — see README), inlined as SVG.
 * They are painted with currentColor.
 */
const files = import.meta.glob('./icons/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const icons: Record<string, string> = {};
for (const [path, svg] of Object.entries(files)) icons[path.slice(8, -4)] = svg.replace('<svg ', '<svg class="ic" aria-hidden="true" ');

export type IconName =
  | 'heart' | 'coins' | 'crystal' | 'rifle' | 'grenade' | 'shovel' | 'wind' | 'shop' | 'trophy' | 'skull' | 'wall'
  | 'stairs' | 'wood' | 'stone' | 'metal' | 'swords' | 'fist' | 'pistol' | 'rod' | 'apple' | 'bottle' | 'fish' | 'ammo'
  | 'shotgun' | 'rocket' | 'hook' | 'kick';

export function icon(name: IconName, cls = ''): string {
  const svg = icons[name] ?? '';
  return cls ? svg.replace('class="ic"', `class="ic ${cls}"`) : svg;
}
